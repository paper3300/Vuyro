// Development engine for trying the app without real agent CLIs (and without spending tokens):
// the same daemon as `@vuyro/engine`'s entry point, but Claude and Codex nodes are played by a scripted agent that
// reports through the same command API (`artifact.add`, `node.done`) with its run token, after a short delay.
//
//   VUYRO_ENGINE_ENTRY=<this file> pnpm --filter @vuyro/desktop start
//
// The app starts it like the real engine (`--data-dir`, `--pipe`, `--ui-credential-stdin`, `--vuyro-cli`).
// Not part of the build; never shipped.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { type EngineDaemon, type EngineDaemonOptions, ScriptedAgentAdapter, type ScriptedBehavior, defaultDataDir, enginePaths, startEngineDaemon, systemClock } from '@vuyro/engine';

type Adapter = NonNullable<NonNullable<EngineDaemonOptions['adapters']>['claude']>;

function argValue(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

async function readFirstLine(): Promise<string> {
  let text = '';
  for await (const chunk of process.stdin) {
    text += String(chunk);
    const newline = text.indexOf('\n');
    if (newline >= 0) return text.slice(0, newline).trim();
    if (text.length > 4096) break;
  }
  return text.trim();
}

/** The ticket title, from the prompt's "## Ticket" section. */
function ticketTitle(prompt: string): string {
  const lines = prompt.split('\n');
  return lines[lines.indexOf('## Ticket') + 1]?.trim() ?? '';
}

/**
 * A Dev run that really edits its working folder (the project folder, or its worktree), checking the file out first
 * like the hook would. Returns the changed path, or undefined when the ledger made it wait (the engine pauses the
 * lane and starts it again once the file is free).
 *
 * - A fan-out lane (Plan's items) edits the shared `src/app.js`: odd lanes add a line at the top, even lanes at the
 *   end, so two lanes conflict in the ledger (shared mode) but merge cleanly (worktree mode). It holds the file a few
 *   seconds so the overlap shows.
 * - A single lane (`main`, e.g. a build flow) writes its own `src/note-<ticket>.js`. A ticket whose title has
 *   `[broken]` writes a syntax error on its first run, so a shared build can fail and blame it.
 */
async function devWork(session: Parameters<ScriptedBehavior>[0]): Promise<string | undefined> {
  const { ticketId, nodeId, lane, run, cwd, prompt } = session.request;
  if (cwd === undefined) return `src/${lane}.ts`;
  const fanOut = lane !== 'main';
  const relative = fanOut ? 'src/app.js' : `src/note-${ticketId.slice(-6)}.js`;
  const file = join(cwd, relative);
  const checkout = await session.vuyro('checkout.acquire', { ticketId, nodeId, paths: [file], source: 'agent' });
  if (!checkout.ok || !(checkout.result as { granted: boolean }).granted) return undefined;
  const title = ticketTitle(prompt);
  // A project without a folder works in an empty folder of its ticket.
  mkdirSync(dirname(file), { recursive: true });
  if (fanOut) {
    const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
    const line = `// lane ${lane} (${title}) run ${String(run)}`;
    writeFileSync(file, Number(lane) % 2 === 1 ? `${line}\n${text}` : `${text}${line}\n`);
    await session.sleep(4000);
  } else {
    const broken = title.includes('[broken]') && run === 1;
    writeFileSync(file, broken ? `// ${title}\nexport const note = ;\n` : `// ${title}\nexport const note = ${JSON.stringify(title)};\n`);
  }
  return session.cancelled ? undefined : relative;
}

/** What a well-behaved agent would report for each node of the default template; `done` for anything else. */
const demoAgent: ScriptedBehavior = async (session) => {
  const { ticketId, nodeId, lane } = session.request;
  const report = (type: string, payload: Record<string, unknown>) => session.vuyro(type, { ticketId, nodeId, ...payload });
  session.observe({ kind: 'message', role: 'assistant', text: `${nodeId} 작업을 시작합니다. <script>alert(1)</script> 같은 출력도 글자로만 보여야 합니다.` });
  // What a real CLI would get: whether the engine asked for the automatic checkout hook on this run.
  session.observe({ kind: 'message', role: 'assistant', text: `자동 체크아웃 훅: ${session.request.checkoutHook === true ? '켬' : '끔'}` });
  session.observe({ kind: 'toolCallStarted', toolCallId: `${nodeId}-read`, name: 'Read', input: { file_path: 'README.md' } });
  await session.sleep(1500);
  session.observe({ kind: 'toolCallFinished', toolCallId: `${nodeId}-read`, output: 'ok' });
  session.observe({ kind: 'usage', scope: 'run', tokens: { input: 1800, cacheRead: 5200, cacheWrite: 900, output: 650 }, cost: { usd: 0.0123, basis: 'list' } });
  if (session.cancelled) return { outcome: 'cancelled' };
  switch (nodeId) {
    case 'spec':
      await report('artifact.add', { slot: 'specDoc', ref: { kind: 'file', uri: 'docs/spec.md', version: 'v1', title: 'Spec' } });
      await report('node.done', { port: 'done', summary: '메모장 저장 기능 스펙을 썼습니다.', data: { title: '메모장 저장', acceptanceCriteria: ['Ctrl+S로 저장한다', '저장하지 않고 닫으면 묻는다'] } });
      break;
    case 'plan':
      await report('node.done', {
        port: 'done',
        items: [
          { summary: '저장 명령', data: { taskId: 'save', scope: 'Ctrl+S 저장', files: ['src/save.ts'] } },
          { summary: '닫기 확인', data: { taskId: 'close', scope: '저장 안 한 변경 확인', files: ['src/close.ts'] } },
        ],
      });
      break;
    case 'dev': {
      const changed = await devWork(session);
      if (changed === undefined) return { outcome: 'cancelled' };
      await report('artifact.add', { slot: 'change', ref: { kind: 'file', uri: changed, version: `run-${String(session.request.run)}` } });
      await report('node.done', { port: 'done', summary: `레인 ${lane}: ${changed} 수정`, data: { taskId: `task-${lane}`, changed } });
      break;
    }
    case 'qa':
      await report('node.done', { port: 'approve', summary: '모든 작업이 기준을 만족합니다.', data: { verdict: 'pass' } });
      break;
    default:
      await report('node.done', { port: 'done', summary: `${nodeId} 완료` });
  }
  return undefined;
};

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const uiCredential = args.includes('--ui-credential-stdin') ? await readFirstLine() : undefined;
  const dataDir = argValue(args, '--data-dir');
  const pipePath = argValue(args, '--pipe');
  const cli = argValue(args, '--vuyro-cli');
  const holder: { daemon?: EngineDaemon } = {};
  const late = (provider: 'claude' | 'codex'): Adapter => {
    let inner: ScriptedAgentAdapter | undefined;
    return {
      provider,
      start: (request) => {
        const { daemon } = holder;
        if (daemon === undefined) throw new Error('the engine is not ready');
        inner ??= new ScriptedAgentAdapter({ provider, clock: systemClock, bus: daemon.bus, activity: daemon.activity, behavior: demoAgent });
        return inner.start(request);
      },
    };
  };
  let stopping = false;
  const stop = (code: number): void => {
    if (stopping) return;
    stopping = true;
    void (holder.daemon?.close() ?? Promise.resolve())
      .catch(() => undefined)
      .finally(() => process.exit(code));
  };
  holder.daemon = await startEngineDaemon({
    ...(dataDir === undefined ? {} : { dataDir }),
    ...(pipePath === undefined ? {} : { pipePath }),
    ...(uiCredential === undefined || uiCredential === '' ? {} : { uiCredential }),
    ...(cli === undefined ? {} : { vuyroCli: { command: process.execPath, args: [cli] } }),
    adapters: { claude: late('claude'), codex: late('codex') },
    watcher: null,
    onShutdownRequest: () => {
      stop(0);
    },
  });
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK'] as const) {
    process.on(signal, () => {
      stop(0);
    });
  }
}

main().catch((error: unknown) => {
  const line = `${new Date().toISOString()} dev engine could not start: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`;
  try {
    const log = enginePaths(argValue(process.argv.slice(2), '--data-dir') ?? defaultDataDir()).log;
    mkdirSync(dirname(log), { recursive: true });
    appendFileSync(log, line);
  } catch {
    // Nothing else to do.
  }
  process.stderr.write(line);
  process.exit(1);
});
