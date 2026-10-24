import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { bindDescendantsToProcess } from '../platform/win32/process-guard.ts';
import { startEngineDaemon } from './daemon.ts';
import { defaultDataDir, enginePaths } from './paths.ts';

/**
 * Entry point of the engine daemon (headless; no Electron). Started detached by the app or `vuyro engine start`:
 *
 *   node main.js [--data-dir <dir>] [--pipe <name>] [--ui-credential-stdin] [--vuyro-cli <bin.js>]
 *
 * `--ui-credential-stdin`: the first stdin line is the app's UI credential (never a file or an argument).
 */

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

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  // Agents and their tools end with the engine, whichever way it ends.
  if (process.platform === 'win32') bindDescendantsToProcess();
  const uiCredential = args.includes('--ui-credential-stdin') ? await readFirstLine() : undefined;
  const dataDir = argValue(args, '--data-dir');
  const pipePath = argValue(args, '--pipe');
  const cli = argValue(args, '--vuyro-cli');
  let stopping = false;
  const stop = (code: number): void => {
    if (stopping) return;
    stopping = true;
    void daemon
      .close()
      .catch(() => undefined)
      .finally(() => process.exit(code));
  };
  const daemon = await startEngineDaemon({
    ...(dataDir === undefined ? {} : { dataDir }),
    ...(pipePath === undefined ? {} : { pipePath }),
    ...(uiCredential === undefined || uiCredential === '' ? {} : { uiCredential }),
    ...(cli === undefined ? {} : { vuyroCli: { command: process.execPath, args: [cli] } }),
    onShutdownRequest: () => {
      stop(0);
    },
  });
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK'] as const) {
    process.on(signal, () => {
      stop(0);
    });
  }
  process.on('uncaughtException', (error) => {
    process.stderr.write(`[vuyro-engine] ${error.stack ?? error.message}\n`);
    stop(1);
  });
  process.stdout.write(`${JSON.stringify({ ready: true, pid: process.pid, pipe: daemon.pipePath, dataDir: daemon.paths.dataDir })}\n`);
}

main().catch((error: unknown) => {
  const line = `${new Date().toISOString()} could not start: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`;
  // A detached daemon has no console: the log file is where the launcher points people.
  try {
    const log = enginePaths(argValue(process.argv.slice(2), '--data-dir') ?? defaultDataDir()).log;
    mkdirSync(dirname(log), { recursive: true });
    appendFileSync(log, line);
  } catch {
    // Nothing else to do.
  }
  process.stderr.write(`[vuyro-engine] ${line}`);
  process.exit(1);
});
