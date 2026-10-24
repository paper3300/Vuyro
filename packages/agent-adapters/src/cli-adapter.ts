import type { AgentProvider, RunObservation } from '@vuyro/contracts';
import { ClaudeStreamNormalizer, claudeArgs } from './claude.ts';
import type { Clock, TimerHandle } from './clock.ts';
import { CodexStreamNormalizer, codexArgs } from './codex.ts';
import { AGENT_ENV } from './agent-env.ts';
import { codexHome, codexUserHooks, codexWindowsSandbox } from './codex-home.ts';
import { claudeHookArgs, codexHookArgs, type HookCli, hookCommandLine } from './hooks.ts';
import { prependPath } from './cli-shims.ts';
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
  /**
   * How to start `vuyro mcp` (the node agent's MCP bridge to the engine). Codex runs shell commands in an OS
   * sandbox that cannot open the engine pipe, but it starts MCP servers outside it, so the agent reports
   * through this server's tools instead ([[초기 검증 결과]] M3). Only paths and variable names go on the
   * command line; the server gets the run token by Codex forwarding the named environment variables.
   */
  readonly vuyroMcp?: { readonly command: string; readonly args: readonly string[] };
  /** How to run the `vuyro` CLI for the automatic checkout hook (`vuyro hook pretooluse`). Absent = no hook can be installed. */
  readonly vuyroHook?: HookCli;
  /** The user's Codex folder, read for the hook's safety checks. Default `CODEX_HOME` of `baseEnv`, else `~/.codex`. */
  readonly codexHome?: string;
  /** Folders put first on the agent's PATH: the engine's `vuyro` shims (`vuyroShims`), so the agent's shell finds the CLI. */
  readonly pathDirs?: readonly string[];
}

/** `-c` overrides that register `vuyro mcp` with Codex and forward the run variables to it. */
export function codexMcpArgs(server: { readonly command: string; readonly args: readonly string[] }): string[] {
  // JSON strings are valid TOML basic strings.
  return [
    '-c',
    `mcp_servers.vuyro.command=${JSON.stringify(server.command)}`,
    '-c',
    `mcp_servers.vuyro.args=[${server.args.map((arg) => JSON.stringify(arg)).join(',')}]`,
    '-c',
    `mcp_servers.vuyro.env_vars=[${Object.values(AGENT_ENV).map((name) => JSON.stringify(name)).join(',')}]`,
  ];
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
    const env = prependPath(agentEnvironment(this.options.baseEnv ?? process.env, request.env), this.options.pathDirs ?? []);
    const command = (this.options.resolve ?? resolveExecutable)(this.options.command ?? this.spec.command, env);
    const home = this.provider === 'codex' ? (this.options.codexHome ?? codexHome(this.options.baseEnv ?? process.env)) : undefined;
    // Fail closed: the hook trust bypass would run the user's own Codex hooks unchecked (the engine checks this too).
    const userHooks = request.checkoutHook === true && home !== undefined && codexUserHooks(home);
    const hook = request.checkoutHook === true && this.options.vuyroHook !== undefined && !userHooks ? hookCommandLine(this.options.vuyroHook, this.provider) : undefined;
    const extraArgs = [
      ...(this.options.extraArgs ?? this.spec.extraArgs),
      ...(this.provider === 'codex' && this.options.vuyroMcp !== undefined ? codexMcpArgs(this.options.vuyroMcp) : []),
      ...(hook === undefined ? [] : this.provider === 'claude' ? claudeHookArgs(hook) : codexHookArgs(hook, { windowsSandbox: codexWindowsSandbox(home ?? '') })),
    ];
    const args = [...(this.options.prefixArgs ?? []), ...this.spec.args(request, extraArgs)];
    const normalizer = this.spec.normalizer(request);
    const child = runner.spawn({ command, args, env, killTree: true, ...(request.cwd === undefined ? {} : { cwd: request.cwd }) });
    child.write(request.prompt);
    child.endInput();

    const observations = new AsyncQueue<RunObservation>();
    if (request.checkoutHook === true && hook === undefined) {
      // Changes are still found afterwards; the run says why nothing blocked edits up front.
      const message = userHooks
        ? 'the automatic checkout hook is off for this Codex run: the user has Codex hooks of their own (hooks.json), which bypassing the hook trust check would run unchecked'
        : 'the automatic checkout hook was asked for, but the engine has no vuyro CLI to run it';
      observations.push({ kind: 'warning', message, source: 'vuyro.adapter', observedAt: clock.now() });
    }
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
