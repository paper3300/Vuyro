import type { AgentProvider, RunObservation } from '@vuyro/contracts';
import { ClaudeStreamNormalizer, claudeArgs } from './claude.ts';
import type { Clock, TimerHandle } from './clock.ts';
import { CodexStreamNormalizer, codexArgs } from './codex.ts';
import { agentEnvironment, resolveExecutable } from './environment.ts';
import type { AgentAdapter, AgentRunHandle, AgentStartRequest } from './index.ts';
import { clip, LIMITS } from './limits.ts';
import { AsyncQueue, type ProcessRunner, readLines } from './process.ts';
import { settleRun, type StreamNormalizer } from './settle.ts';

export interface CliAgentAdapterOptions {
  readonly runner: ProcessRunner;
  readonly clock: Clock;
  /** Executable: a name looked up on PATH, or a path. Default `claude` / `codex`. */
  readonly command?: string;
  /** Arguments before the provider's own (e.g. the script when `command` is an interpreter). */
  readonly prefixArgs?: readonly string[];
  /** Arguments after the output-format ones (permission mode, sandbox, allowed tools…). Default per provider. */
  readonly extraArgs?: readonly string[];
  /** Environment the agent inherits (minus `VUYRO_*`). Default `process.env`. */
  readonly baseEnv?: Readonly<Record<string, string | undefined>>;
  /** Time limit of a run unless the request sets one. Default none. */
  readonly timeoutMs?: number;
  /** How long a run may keep running after its final line before it is stopped. Default 30 s. */
  readonly lingerMs?: number;
  /** stderr lines kept raw per run; the rest are counted. Default 200. */
  readonly maxStderrLines?: number;
  /** Finds the executable. Default: PATH lookup of real executables (`resolveExecutable`). Tests skip it. */
  readonly resolve?: (command: string, env: Readonly<Record<string, string>>) => string;
}

/**
 * Defaults for unattended runs. Claude: edits without asking, and the `vuyro` CLI allowed (the agent reports
 * through it). Codex: writes inside the workspace only. Hook injection and per-node tool lists arrive with M4.
 */
export const DEFAULT_CLAUDE_ARGS: readonly string[] = ['--permission-mode', 'acceptEdits', '--allowedTools', 'Bash(vuyro:*)'];
export const DEFAULT_CODEX_ARGS: readonly string[] = ['-s', 'workspace-write'];

const STDERR_TAIL_LINES = 20;

interface ProviderSpec {
  readonly provider: AgentProvider;
  readonly command: string;
  readonly extraArgs: readonly string[];
  args(request: AgentStartRequest, extraArgs: readonly string[]): string[];
  normalizer(request: AgentStartRequest): StreamNormalizer;
}

const CLAUDE: ProviderSpec = {
  provider: 'claude',
  command: 'claude',
  extraArgs: DEFAULT_CLAUDE_ARGS,
  args: (request, extraArgs) =>
    claudeArgs({
      ...(request.model === undefined ? {} : { model: request.model }),
      ...(request.resume === undefined ? {} : { resumeSessionId: request.resume.providerSessionId }),
      extraArgs,
    }),
  normalizer: () => new ClaudeStreamNormalizer(),
};

const CODEX: ProviderSpec = {
  provider: 'codex',
  command: 'codex',
  extraArgs: DEFAULT_CODEX_ARGS,
  args: (request, extraArgs) =>
    codexArgs({
      ...(request.model === undefined ? {} : { model: request.model }),
      ...(request.resume === undefined ? {} : { resumeSessionId: request.resume.providerSessionId }),
      extraArgs,
    }),
  normalizer: (request) => new CodexStreamNormalizer(request.model === undefined ? {} : { model: request.model }),
};

/**
 * Runs an agent CLI as a child process (no shell) and normalizes its output.
 *
 * - The prompt goes to stdin, which is then closed. The run token travels only in the environment.
 * - `cancel()` and the time limit stop the whole process tree.
 * - The run settles from the provider's final line and the process exit together (`settleRun`).
 */
export class CliAgentAdapter implements AgentAdapter {
  readonly provider: AgentProvider;
  private readonly spec: ProviderSpec;
  private readonly options: CliAgentAdapterOptions;

  private constructor(spec: ProviderSpec, options: CliAgentAdapterOptions) {
    this.spec = spec;
    this.provider = spec.provider;
    this.options = options;
  }

  static claude(options: CliAgentAdapterOptions): CliAgentAdapter {
    return new CliAgentAdapter(CLAUDE, options);
  }

  static codex(options: CliAgentAdapterOptions): CliAgentAdapter {
    return new CliAgentAdapter(CODEX, options);
  }

  start(request: AgentStartRequest): AgentRunHandle {
    const { clock, runner } = this.options;
    const env = agentEnvironment(this.options.baseEnv ?? process.env, request.env);
    const command = (this.options.resolve ?? resolveExecutable)(this.options.command ?? this.spec.command, env);
    const args = [...(this.options.prefixArgs ?? []), ...this.spec.args(request, this.options.extraArgs ?? this.spec.extraArgs)];
    const normalizer = this.spec.normalizer(request);
    const child = runner.spawn({ command, args, env, killTree: true, ...(request.cwd === undefined ? {} : { cwd: request.cwd }) });
    child.write(request.prompt);
    child.endInput();

    const observations = new AsyncQueue<RunObservation>();
    const flags = { cancelled: false, timedOut: false, lingered: false };
    const timers: TimerHandle[] = [];
    const timeoutMs = request.timeoutMs ?? this.options.timeoutMs;
    if (timeoutMs !== undefined) {
      timers.push(
        clock.setTimeout(() => {
          flags.timedOut = true;
          child.kill('SIGKILL');
        }, timeoutMs),
      );
    }
    let lingering = false;
    let ended = false;
    const exited = child.exited.then((exit) => {
      ended = true;
      for (const timer of timers) clock.clearTimeout(timer);
      return exit;
    });

    const pumpStdout = async (): Promise<void> => {
      for await (const line of readLines(child.stdout)) {
        for (const observation of normalizer.stdout(line, clock.now())) observations.push(observation);
        if (normalizer.terminal !== undefined && !lingering) {
          lingering = true;
          timers.push(
            clock.setTimeout(() => {
              flags.lingered = true;
              child.kill('SIGTERM');
            }, this.options.lingerMs ?? 30_000),
          );
        }
      }
    };
    const maxStderr = this.options.maxStderrLines ?? 200;
    const tail: string[] = [];
    let stderrLines = 0;
    const pumpStderr = async (): Promise<void> => {
      for await (const line of readLines(child.stderr)) {
        if (line.trim() === '') continue;
        stderrLines += 1;
        tail.push(clip(line, 1024));
        if (tail.length > STDERR_TAIL_LINES) tail.shift();
        if (stderrLines <= maxStderr) for (const observation of normalizer.stderr(line, clock.now())) observations.push(observation);
      }
    };

    const settled = Promise.all([pumpStdout(), pumpStderr()])
      .catch(() => undefined)
      .then(async () => {
        if (stderrLines > maxStderr) {
          observations.push({ kind: 'warning', message: `${stderrLines - maxStderr} more stderr lines were not kept`, source: 'vuyro.adapter', observedAt: clock.now() });
        }
        observations.end();
        const exit = await exited;
        return settleRun({
          terminal: normalizer.terminal,
          exit,
          ...flags,
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
          stderrTail: clip(tail.join('\n'), LIMITS.warning),
        });
      });

    return {
      observations,
      settled,
      cancel: () => {
        // A run that already ended keeps its own outcome.
        if (flags.cancelled || ended) return;
        flags.cancelled = true;
        child.kill('SIGTERM');
      },
    };
  }
}
