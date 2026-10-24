import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { AGENT_ENV } from '@vuyro/agent-adapters';
import { type CommandError, type DomainEvent, PROTOCOL_VERSION, RPC_METHODS, RPC_NOTIFICATIONS, type TicketStats } from '@vuyro/contracts';
import {
  EngineClient,
  type EngineClientOptions,
  EngineRequestError,
  EngineUnavailableError,
  launchEngineDaemon,
  type LaunchOptions,
  type LaunchResult,
  resolveEngineLocation,
} from '@vuyro/engine';
import { fileURLToPath } from 'node:url';
import { flag, has, onlyFlags, type ParsedArgs, parseArgs, requireFlag, UsageError } from './args.ts';
import { serveMcp } from './mcp.ts';
import { denyOutput, type HookCheckout, runPreToolUseHook } from './hook.ts';

export interface CliIo {
  out(line: string): void;
  err(line: string): void;
}

/** What the CLI talks to; tests replace the pieces. */
export interface CliOptions {
  /** Default `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Base for relative `@file` arguments. Default `process.cwd()`. */
  readonly cwd?: string;
  readonly connect?: (options: EngineClientOptions) => Promise<EngineClient>;
  readonly launch?: (options: LaunchOptions) => Promise<LaunchResult>;
  /** Standard input, for `vuyro mcp`. */
  readonly stdin?: AsyncIterable<string>;
}

/** Exit codes: 0 ok, 1 the engine refused, 2 usage, 3 no engine to talk to. */
export const EXIT = { ok: 0, refused: 1, usage: 2, unavailable: 3 } as const;

const HUMAN_CREDENTIAL_ENV = 'VUYRO_HUMAN_CREDENTIAL';

const USAGE = `Usage: vuyro <command> [options]

Engine
  engine start                 Start the engine in the background (if it is not running)
  engine status                Show the running engine
  engine stop                  Stop the engine (human only)
  auth login                   Ask for a human credential (approve the dialog on this PC)
  auth status                  Show who this terminal is to the engine

Work
  project create <name>        project list
  project configure <projectId> [--root <dir> | --clear-root] [--base-ref <ref> | --clear-base-ref]
                    [--settings <json|@file>] [--watch <json|@file>]   Workspace folder and settings layer
  app configure --settings <json|@file>                               App layer of the workspace settings
  ticket create --project <id> --title <text> [--description <text>] [--template <id>[@<version>]] [--priority <n>]
  ticket list [--project <id>]     ticket show <ticketId>     ticket stats <ticketId>
  node done --port <port> [--data <json|@file>] [--summary <text>] [--artifacts <json|@file>] [--items <json|@file>]
  node approve|reject [--comment <text>]   node reject [--items <json|@file>]   node retry|pause|resume
  artifact add <slot> --kind <kind> --uri <uri> [--version <v>] [--title <t>] [--mime <type>] [--hash <hash>]
  artifact list --ticket <id> [--node <id>]
  definition save <json|@file> Save a node type or template version (export envelope)

Workspace (Vuyro's own checkout ledger; nothing is locked in git or Perforce)
  checkout <path>... [--shared]   Check files out for this node before editing them
  checkout release [<path>...]    Release this node's checkouts (all, or the given files)
  checkout force-release --project <id> <entryId>...   Release ledger entries (a person)
  workspace show --project <id> [--ticket <id>] [--all]   Held entries, refusals, flagged changes, worktrees
  workspace cleanup --project <id> [--ticket <id>]        Worktrees left for you, with everything they still hold
  workspace cleanup --project <id> --remove <key> --fingerprint <fp> [--no-wait]   Remove one exactly as it was shown
  shared define --project <id> <json|@file>   Define a shared node (its spec, or a 'sharedNode' export envelope)
  shared show --project <id> [<name>]         Shared nodes: status, queue, running and recent batches
  shared run <name> --project <id>            Start a batch now with what is queued (a person)
  shared unblock <name> --project <id>        Let a blocked shared node start batches again (a person)
  hook pretooluse [--provider claude|codex]   The automatic checkout hook (run by the agent CLI)
  mcp                          Serve the node agent's report tools over stdio MCP (started by the agent CLI)
  events [--after <sequence>] [--follow]

Node and ticket default to VUYRO_TICKET / VUYRO_NODE; --ticket, --node, --lane override them.
A node agent is identified by VUYRO_RUN_TOKEN. A person who ran 'vuyro auth login' sets VUYRO_HUMAN_CREDENTIAL.
Without either, the engine treats the caller as unverified (read-only).

Options: --json (machine output), --data-dir <dir>, --pipe <name>, --request-id <id>
Exit codes: 0 ok, 1 refused by the engine, 2 usage, 3 engine not reachable`;

export function cliVersion(): string {
  const require = createRequire(import.meta.url);
  const manifest = require('../package.json') as { version: string };
  return manifest.version;
}

interface Context {
  readonly io: CliIo;
  readonly args: ParsedArgs;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cwd: string;
  readonly json: boolean;
  readonly options: CliOptions;
}

/** Runs one CLI invocation and resolves with the process exit code. */
export async function runCli(argv: readonly string[], io: CliIo, options: CliOptions = {}): Promise<number> {
  if (argv[0] === '--version' || argv[0] === '-v' || argv[0] === 'version') {
    io.out(`vuyro ${cliVersion()} (protocol ${PROTOCOL_VERSION})`);
    return EXIT.ok;
  }
  if (argv[0] === '--help') {
    io.out(USAGE);
    return EXIT.ok;
  }
  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
  } catch (error) {
    io.err(`vuyro: ${(error as Error).message}`);
    return EXIT.usage;
  }
  const [command, sub] = args.positionals;
  // `--help` anywhere (e.g. `vuyro node done --help`) shows the usage instead of running the command.
  if (command === undefined || command === 'help' || command === '-h' || has(args, 'help')) {
    io.out(USAGE);
    return EXIT.ok;
  }
  const ctx: Context = { io, args, env: options.env ?? process.env, cwd: options.cwd ?? process.cwd(), json: has(args, 'json'), options };
  try {
    switch (command) {
      case 'engine':
        return await engineCommand(ctx, sub);
      case 'auth':
        return await authCommand(ctx, sub);
      case 'project':
        return await projectCommand(ctx, sub);
      case 'ticket':
        return await ticketCommand(ctx, sub);
      case 'node':
        return await nodeCommand(ctx, sub);
      case 'artifact':
        return await artifactCommand(ctx, sub);
      case 'definition':
        return await definitionCommand(ctx, sub);
      case 'app':
        return await appCommand(ctx, sub);
      case 'checkout':
        return await checkoutCommand(ctx, sub);
      case 'workspace':
        return await workspaceCommand(ctx, sub);
      case 'shared':
        return await sharedCommand(ctx, sub);
      case 'hook':
        return await hookCommand(ctx, sub);
      case 'mcp':
        onlyFlags(ctx.args, []);
        await serveMcp(options.stdin ?? (process.stdin.setEncoding('utf8') as AsyncIterable<string>), (line) => {
          io.out(line);
        }, { env: ctx.env, ...(options.connect === undefined ? {} : { connect: options.connect }) });
        return EXIT.ok;
      case 'events':
        return await eventsCommand(ctx);
      default:
        throw new UsageError(`unknown command '${command}'\n\n${USAGE}`);
    }
  } catch (error) {
    return report(ctx, error);
  }
}

function report(ctx: Context, error: unknown): number {
  if (error instanceof UsageError) {
    ctx.io.err(`vuyro: ${error.message}`);
    return EXIT.usage;
  }
  if (error instanceof EngineUnavailableError) {
    if (ctx.json) ctx.io.err(JSON.stringify({ error: { code: 'engine_unavailable', message: error.message } }));
    else ctx.io.err(`vuyro: the engine is not reachable: ${error.message}\nStart it with 'vuyro engine start' (or open the Vuyro app).`);
    return EXIT.unavailable;
  }
  if (error instanceof EngineRequestError) {
    printError(ctx, error.data);
    return EXIT.refused;
  }
  ctx.io.err(`vuyro: ${error instanceof Error ? error.message : String(error)}`);
  return EXIT.refused;
}

function printError(ctx: Context, error: CommandError): void {
  if (ctx.json) {
    ctx.io.err(JSON.stringify({ error }));
    return;
  }
  ctx.io.err(`vuyro: ${error.code}: ${error.message}`);
  const issues = error.details?.issues;
  if (Array.isArray(issues)) {
    for (const issue of issues as { path?: string; message?: string }[]) ctx.io.err(`  ${issue.path === undefined || issue.path === '' ? '(root)' : issue.path}: ${issue.message ?? ''}`);
  }
}

function print(ctx: Context, value: unknown, text?: () => string[]): void {
  if (ctx.json || text === undefined) ctx.io.out(JSON.stringify(value, null, ctx.json ? undefined : 2));
  else for (const line of text()) ctx.io.out(line);
}

function location(ctx: Context): { dataDir?: string; pipePath?: string; env: Readonly<Record<string, string | undefined>> } {
  const dataDir = flag(ctx.args, 'data-dir');
  const pipePath = flag(ctx.args, 'pipe');
  return { ...(dataDir === undefined ? {} : { dataDir }), ...(pipePath === undefined ? {} : { pipePath }), env: ctx.env };
}

/**
 * `asHuman: false` connects without the terminal's human credential: `auth login` must work exactly when the old
 * credential has expired (the engine refuses a stale one at hello).
 */
async function connect(ctx: Context, asHuman = true): Promise<EngineClient> {
  const humanCredential = asHuman ? ctx.env[HUMAN_CREDENTIAL_ENV] : undefined;
  const options: EngineClientOptions = {
    client: 'cli',
    ...location(ctx),
    ...(humanCredential === undefined || humanCredential === '' ? {} : { humanCredential }),
  };
  return (ctx.options.connect ?? ((o) => EngineClient.connect(o)))(options);
}

async function withClient<T>(ctx: Context, work: (client: EngineClient) => Promise<T>, asHuman = true): Promise<T> {
  const client = await connect(ctx, asHuman);
  try {
    return await work(client);
  } finally {
    client.close();
  }
}

/** Sends one command, with the run token when this process is a node agent. */
async function execute(ctx: Context, type: string, payload: Record<string, unknown>): Promise<unknown> {
  const token = ctx.env[AGENT_ENV.runToken];
  const requestId = flag(ctx.args, 'request-id') ?? `cli-${randomUUID()}`;
  const response = await withClient(ctx, (client) =>
    client.execute({ requestId, type, payload, ...(token === undefined || token === '' ? {} : { auth: { runToken: token } }) }),
  );
  return response.result;
}

/**
 * The text of an `@file` argument, relative to the current folder. A byte order mark (PowerShell 5's `utf8`, some
 * editors) is dropped, as the app's import does.
 */
function readArgumentFile(ctx: Context, path: string): string {
  return readFileSync(resolve(ctx.cwd, path), 'utf8').replace(/^\uFEFF/, '');
}

/** A JSON value from the argument itself or `@file`. */
function jsonArgument(ctx: Context, name: string): unknown {
  const raw = flag(ctx.args, name);
  if (raw === undefined) return undefined;
  const text = raw.startsWith('@') ? readArgumentFile(ctx, raw.slice(1)) : raw;
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new UsageError(`--${name}: not valid JSON (${(error as Error).message})`);
  }
}

function target(ctx: Context): { ticketId: string; nodeId: string; lane?: string } {
  const ticketId = flag(ctx.args, 'ticket') ?? ctx.env[AGENT_ENV.ticket];
  const nodeId = flag(ctx.args, 'node') ?? ctx.env[AGENT_ENV.node];
  if (ticketId === undefined || ticketId === '') throw new UsageError('--ticket is required (or VUYRO_TICKET)');
  if (nodeId === undefined || nodeId === '') throw new UsageError('--node is required (or VUYRO_NODE)');
  // A node agent's lane comes from its run token; only an explicit --lane names one.
  const lane = flag(ctx.args, 'lane');
  return { ticketId, nodeId, ...(lane === undefined ? {} : { lane }) };
}

// ---------------------------------------------------------------------------

async function engineCommand(ctx: Context, sub: string | undefined): Promise<number> {
  onlyFlags(ctx.args, []);
  switch (sub) {
    case 'start': {
      try {
        const status = await withClient(ctx, (client) => client.request<{ pid: number }>(RPC_METHODS.status));
        print(ctx, { running: true, started: false, pid: status.pid }, () => [`The engine is already running (pid ${status.pid}).`]);
        return EXIT.ok;
      } catch (error) {
        if (!(error instanceof EngineUnavailableError)) throw error;
      }
      // The engine tells Codex agents to start this same CLI as their MCP bridge (`vuyro mcp`).
      const launched = await (ctx.options.launch ?? launchEngineDaemon)({ ...location(ctx), client: 'cli', cliEntry: fileURLToPath(new URL('./bin.js', import.meta.url)) });
      print(ctx, { running: true, ...launched }, () => [
        launched.started ? `Started the engine (pid ${launched.pid}).` : `The engine is already running (pid ${launched.pid}).`,
        `  data: ${launched.dataDir}`,
      ]);
      return EXIT.ok;
    }
    case 'status': {
      const status = await withClient(ctx, (client) => client.request<Record<string, unknown>>(RPC_METHODS.status));
      print(ctx, status);
      return EXIT.ok;
    }
    case 'stop': {
      await withClient(ctx, (client) => client.request(RPC_METHODS.shutdown, {}));
      print(ctx, { stopping: true }, () => ['The engine is stopping.']);
      return EXIT.ok;
    }
    default:
      throw new UsageError("engine: expected 'start', 'status' or 'stop'");
  }
}

async function authCommand(ctx: Context, sub: string | undefined): Promise<number> {
  onlyFlags(ctx.args, []);
  switch (sub) {
    case 'login': {
      const result = await withClient(ctx, async (client) => {
        const off = client.on(RPC_NOTIFICATIONS.pairingCode, (params) => {
          const { code } = params as { code: string };
          ctx.io.err(`A dialog asks to approve this request on this PC. Code: ${code}`);
        });
        try {
          return await client.request<{ credential: string; expiresAt?: number }>(RPC_METHODS.pair, { kind: 'cli' });
        } finally {
          off();
        }
      }, false);
      const until = result.expiresAt === undefined ? '' : ` until ${new Date(result.expiresAt).toISOString()}`;
      print(ctx, result, () => [
        `Approved. This credential makes the terminal that holds it act as you${until}:`,
        '',
        `  PowerShell:  $env:${HUMAN_CREDENTIAL_ENV} = "${result.credential}"`,
        `  bash:        export ${HUMAN_CREDENTIAL_ENV}="${result.credential}"`,
        '',
        'Keep it out of files and out of reach of AI tools you run in that terminal: whoever has it acts as you.',
        'Agents the engine starts never receive it.',
      ]);
      return EXIT.ok;
    }
    case 'status': {
      const hello = await withClient(ctx, (client) => Promise.resolve(client.hello));
      const token = ctx.env[AGENT_ENV.runToken];
      const who = token !== undefined && token !== '' ? 'node agent (run token)' : hello.identity;
      print(ctx, { identity: who, engineVersion: hello.engineVersion }, () => [`You are: ${who}`]);
      return EXIT.ok;
    }
    default:
      throw new UsageError("auth: expected 'login' or 'status'");
  }
}

async function projectCommand(ctx: Context, sub: string | undefined): Promise<number> {
  if (sub === 'configure') {
    onlyFlags(ctx.args, ['root', 'clear-root', 'base-ref', 'clear-base-ref', 'settings', 'watch']);
    const projectId = ctx.args.positionals[2];
    if (projectId === undefined || projectId === '') throw new UsageError('project configure: give the project id');
    const root = flag(ctx.args, 'root');
    const baseRef = flag(ctx.args, 'base-ref');
    const settings = jsonArgument(ctx, 'settings');
    const watch = jsonArgument(ctx, 'watch');
    const payload = {
      projectId,
      ...(root === undefined ? {} : { root: resolve(ctx.cwd, root) }),
      ...(has(ctx.args, 'clear-root') ? { root: null } : {}),
      ...(baseRef === undefined ? {} : { baseRef }),
      ...(has(ctx.args, 'clear-base-ref') ? { baseRef: null } : {}),
      ...(settings === undefined ? {} : { settings }),
      ...(watch === undefined ? {} : { watch }),
    };
    if (Object.keys(payload).length === 1) throw new UsageError('project configure: give at least one of --root, --base-ref, --settings, --watch');
    await execute(ctx, 'project.configure', payload);
    print(ctx, { ok: true }, () => ['Project configured. New tickets use it.']);
    return EXIT.ok;
  }
  onlyFlags(ctx.args, []);
  switch (sub) {
    case 'create': {
      const name = ctx.args.positionals[2];
      if (name === undefined || name === '') throw new UsageError('project create: give a name');
      const result = (await execute(ctx, 'project.create', { name })) as { projectId: string };
      print(ctx, result, () => [result.projectId]);
      return EXIT.ok;
    }
    case 'list': {
      const { projects } = await withClient(ctx, (client) => client.request<{ projects: { projectId: string; name: string }[] }>(RPC_METHODS.projects, {}));
      print(ctx, { projects }, () => projects.map((project) => `${project.projectId}  ${project.name}`));
      return EXIT.ok;
    }
    default:
      throw new UsageError("project: expected 'create', 'list' or 'configure'");
  }
}

async function ticketCommand(ctx: Context, sub: string | undefined): Promise<number> {
  switch (sub) {
    case 'create': {
      onlyFlags(ctx.args, ['project', 'title', 'description', 'template', 'priority']);
      const template = flag(ctx.args, 'template');
      let templateRef: { id: string; version?: number } | undefined;
      if (template !== undefined) {
        const [id = '', version] = template.split('@');
        templateRef = { id, ...(version === undefined ? {} : { version: Number(version) }) };
      }
      const description = flag(ctx.args, 'description');
      const priority = flag(ctx.args, 'priority');
      if (priority !== undefined && !/^-?\d+$/.test(priority)) throw new UsageError('--priority must be a whole number');
      const result = (await execute(ctx, 'ticket.create', {
        projectId: requireFlag(ctx.args, 'project'),
        title: requireFlag(ctx.args, 'title'),
        ...(description === undefined ? {} : { description }),
        ...(templateRef === undefined ? {} : { template: templateRef }),
        ...(priority === undefined ? {} : { priority: Number(priority) }),
      })) as { ticketId: string };
      print(ctx, result, () => [result.ticketId]);
      return EXIT.ok;
    }
    case 'list': {
      onlyFlags(ctx.args, ['project']);
      const projectId = flag(ctx.args, 'project');
      const { tickets } = await withClient(ctx, (client) =>
        client.request<{ tickets: { ticketId: string; status: string; title: string }[] }>(RPC_METHODS.tickets, projectId === undefined ? {} : { projectId }),
      );
      print(ctx, { tickets }, () => tickets.map((ticket) => `${ticket.ticketId}  ${ticket.status.padEnd(5)}  ${ticket.title}`));
      return EXIT.ok;
    }
    case 'show': {
      onlyFlags(ctx.args, []);
      const ticketId = ticketArgument(ctx);
      const detail = await withClient(ctx, (client) => client.request<Record<string, unknown>>(RPC_METHODS.ticket, { ticketId }));
      print(ctx, detail);
      return EXIT.ok;
    }
    case 'stats': {
      onlyFlags(ctx.args, []);
      const ticketId = ticketArgument(ctx);
      const stats = await withClient(ctx, (client) => client.request<TicketStats>(RPC_METHODS.ticketStats, { ticketId }));
      print(ctx, stats, () => statsLines(stats));
      return EXIT.ok;
    }
    default:
      throw new UsageError("ticket: expected 'create', 'list', 'show' or 'stats'");
  }
}

/** The output port: an agent that left it out learns what it is (measured: a small model took it for a network port). */
function portFlag(ctx: Context): string {
  const port = flag(ctx.args, 'port');
  if (port === undefined || port === '') throw new UsageError("--port is required: the name of the node's output to finish on (for example done), listed under 'Output ports' in the instructions");
  return port;
}

function ticketArgument(ctx: Context): string {
  const ticketId = ctx.args.positionals[2] ?? ctx.env[AGENT_ENV.ticket];
  if (ticketId === undefined || ticketId === '') throw new UsageError('give a ticket id');
  return ticketId;
}

const minutes = (ms: number): string => `${(ms / 60_000).toFixed(1)} min`;

function statsLines(stats: TicketStats): string[] {
  const tokens = (t: TicketStats['tokens']) => `in ${t.input} / cache ${t.cacheRead}+${t.cacheWrite} / out ${t.output}`;
  return [
    `ticket ${stats.ticketId} (${stats.status})`,
    `  total ${minutes(stats.totalMs)}, waiting for people ${minutes(stats.humanWaitMs)}, agents/scripts active ${minutes(stats.activeMs)}`,
    `  tokens ${tokens(stats.tokens)}, ${stats.toolCalls} tool calls (${stats.toolErrors} failed)${stats.costUsd === undefined ? '' : `, ~$${stats.costUsd.toFixed(4)} list price`}`,
    ...(stats.bottleneck === undefined ? [] : [`  bottleneck: ${stats.bottleneck}`]),
    ...stats.nodes.map(
      (node) =>
        `  ${node.nodeId.padEnd(16)} run ${minutes(node.runningMs)}, queued ${minutes(node.queuedMs)}, people ${minutes(node.humanWaitMs)}, ` +
        `${node.executions} exec, ${node.toolCalls} tools, out ${node.tokens.output} tokens`,
    ),
  ];
}

async function nodeCommand(ctx: Context, sub: string | undefined): Promise<number> {
  switch (sub) {
    case 'done': {
      onlyFlags(ctx.args, ['ticket', 'node', 'lane', 'port', 'data', 'summary', 'artifacts', 'items']);
      const data = jsonArgument(ctx, 'data');
      const artifacts = jsonArgument(ctx, 'artifacts');
      const items = jsonArgument(ctx, 'items');
      const summary = flag(ctx.args, 'summary');
      await execute(ctx, 'node.done', {
        ...target(ctx),
        port: portFlag(ctx),
        ...(data === undefined ? {} : { data }),
        ...(summary === undefined ? {} : { summary }),
        ...(artifacts === undefined ? {} : { artifacts }),
        ...(items === undefined ? {} : { items }),
      });
      print(ctx, { ok: true }, () => ['Result recorded.']);
      return EXIT.ok;
    }
    case 'approve':
    case 'reject':
    case 'retry':
    case 'pause':
    case 'resume': {
      const withComment = sub === 'approve' || sub === 'reject';
      onlyFlags(ctx.args, ['ticket', 'node', 'lane', ...(withComment ? ['comment'] : []), ...(sub === 'reject' ? ['items'] : [])]);
      const comment = withComment ? flag(ctx.args, 'comment') : undefined;
      const items = sub === 'reject' ? jsonArgument(ctx, 'items') : undefined;
      await execute(ctx, `node.${sub}`, { ...target(ctx), ...(comment === undefined ? {} : { comment }), ...(items === undefined ? {} : { items }) });
      print(ctx, { ok: true }, () => ['Done.']);
      return EXIT.ok;
    }
    default:
      throw new UsageError("node: expected 'done', 'approve', 'reject', 'retry', 'pause' or 'resume'");
  }
}

async function artifactCommand(ctx: Context, sub: string | undefined): Promise<number> {
  switch (sub) {
    case 'add': {
      onlyFlags(ctx.args, ['ticket', 'node', 'lane', 'kind', 'uri', 'version', 'title', 'mime', 'hash']);
      const slot = ctx.args.positionals[2];
      if (slot === undefined || slot === '') throw new UsageError('artifact add: give the slot name');
      const optional = (name: string, key: string) => {
        const value = flag(ctx.args, name);
        return value === undefined ? {} : { [key]: value };
      };
      await execute(ctx, 'artifact.add', {
        ...target(ctx),
        slot,
        ref: {
          kind: requireFlag(ctx.args, 'kind'),
          uri: requireFlag(ctx.args, 'uri'),
          ...optional('version', 'version'),
          ...optional('title', 'title'),
          ...optional('mime', 'mimeType'),
          ...optional('hash', 'contentHash'),
        },
      });
      print(ctx, { ok: true }, () => ['Artifact registered.']);
      return EXIT.ok;
    }
    case 'list': {
      onlyFlags(ctx.args, ['ticket', 'node']);
      const ticketId = flag(ctx.args, 'ticket') ?? ctx.env[AGENT_ENV.ticket];
      if (ticketId === undefined || ticketId === '') throw new UsageError('--ticket is required');
      const nodeId = flag(ctx.args, 'node');
      const { artifacts } = await withClient(ctx, (client) =>
        client.request<{ artifacts: { nodeId: string; slot: string; uri: string; version: string | null; current: boolean; source: string }[] }>(RPC_METHODS.artifacts, {
          ticketId,
          ...(nodeId === undefined ? {} : { nodeId }),
        }),
      );
      print(ctx, { artifacts }, () =>
        artifacts.map((artifact) => `${artifact.current ? '*' : ' '} ${artifact.nodeId}.${artifact.slot}  ${artifact.uri}${artifact.version === null ? '' : `@${artifact.version}`}  (${artifact.source})`),
      );
      return EXIT.ok;
    }
    default:
      throw new UsageError("artifact: expected 'add' or 'list'");
  }
}

async function definitionCommand(ctx: Context, sub: string | undefined): Promise<number> {
  onlyFlags(ctx.args, []);
  if (sub !== 'save') throw new UsageError("definition: expected 'save'");
  const source = ctx.args.positionals[2];
  if (source === undefined || source === '') throw new UsageError('definition save: give the envelope as JSON or @file');
  const text = source.startsWith('@') ? readArgumentFile(ctx, source.slice(1)) : source;
  let definition: { kind?: unknown };
  try {
    definition = JSON.parse(text) as { kind?: unknown };
  } catch (error) {
    throw new UsageError(`definition save: not valid JSON (${(error as Error).message})`);
  }
  const type = definition.kind === 'nodeType' ? 'nodeType.save' : definition.kind === 'template' ? 'template.save' : undefined;
  if (type === undefined) throw new UsageError("definition save: 'kind' must be 'nodeType' or 'template'");
  const result = (await execute(ctx, type, { definition })) as { id: string; version: number; status: string };
  print(ctx, result, () => [`${result.id}@${result.version}: ${result.status}`]);
  return EXIT.ok;
}

interface SharedView {
  name: string;
  label: string;
  status: string;
  blocked?: { reason: string; batch: number; by: { ticketId: string }[] };
  queue: { ticketId: string; nodeId: string; position: number; retry: boolean }[];
  running: { batchId: string; members: { ticketId: string }[] }[];
  recent: { batchId: string; outcome?: string; policy?: string; failed?: string[]; errorFiles?: string[] }[];
}

/** `vuyro shared`: shared nodes of a project (M5), their queue and batches. */
async function sharedCommand(ctx: Context, sub: string | undefined): Promise<number> {
  const name = ctx.args.positionals[2];
  switch (sub) {
    case 'define': {
      onlyFlags(ctx.args, ['project']);
      const projectId = requireFlag(ctx.args, 'project');
      if (name === undefined || name === '') throw new UsageError('shared define: give the spec as JSON or @file');
      const text = name.startsWith('@') ? readArgumentFile(ctx, name.slice(1)) : name;
      let parsed: { kind?: unknown; content?: unknown };
      try {
        parsed = JSON.parse(text) as { kind?: unknown; content?: unknown };
      } catch (error) {
        throw new UsageError(`shared define: not valid JSON (${(error as Error).message})`);
      }
      // The export envelope of a shared node carries the spec as its content.
      const spec = parsed.kind === 'sharedNode' ? parsed.content : parsed;
      const result = (await execute(ctx, 'sharedNode.define', { projectId, spec })) as { name: string; version: number; warnings: string[] };
      print(ctx, result, () => [`${result.name}: version ${result.version}`, ...result.warnings.map((warning) => `  warning: ${warning}`)]);
      return EXIT.ok;
    }
    case 'show': {
      onlyFlags(ctx.args, ['project']);
      const projectId = requireFlag(ctx.args, 'project');
      const { sharedNodes } = await withClient(ctx, (client) =>
        client.request<{ sharedNodes: SharedView[] }>(RPC_METHODS.sharedNodes, { projectId, ...(name === undefined ? {} : { name }) }),
      );
      print(ctx, { sharedNodes }, () =>
        sharedNodes.length === 0
          ? ['No shared nodes.']
          : sharedNodes.flatMap((node) => [
              `${node.name} (${node.label}): ${node.status}${node.blocked === undefined ? '' : ` — ${node.blocked.reason} by ${node.blocked.by.map((entry) => entry.ticketId).join(', ') || 'an interrupted batch'} (batch ${node.blocked.batch})`}`,
              ...node.running.map((batch) => `  running ${batch.batchId}: ${batch.members.map((member) => member.ticketId).join(', ')}`),
              ...node.queue.map((entry) => `  ${entry.position}. ${entry.ticketId} ${entry.nodeId}${entry.retry ? ' (again)' : ''}`),
              ...node.recent.slice(0, 5).map((batch) => `  ${batch.batchId}: ${batch.outcome ?? '?'}${batch.policy === undefined ? '' : ` (${batch.policy}${(batch.failed ?? []).length === 0 ? '' : `: ${(batch.failed ?? []).join(', ')}`})`}`),
            ]),
      );
      return EXIT.ok;
    }
    case 'run':
    case 'unblock': {
      onlyFlags(ctx.args, ['project']);
      const projectId = requireFlag(ctx.args, 'project');
      if (name === undefined || name === '') throw new UsageError(`shared ${sub}: give the shared node's name`);
      if (sub === 'run') {
        const result = (await execute(ctx, 'sharedNode.run', { projectId, name })) as { started: boolean; batch?: number; reason?: string };
        print(ctx, result, () => [result.started ? `Started batch ${String(result.batch)}.` : `Not started: ${result.reason ?? 'nothing to run'}`]);
        return result.started ? EXIT.ok : EXIT.refused;
      }
      const result = (await execute(ctx, 'sharedNode.unblock', { projectId, name })) as { unblocked: boolean };
      print(ctx, result, () => [result.unblocked ? 'Unblocked.' : 'It was not blocked.']);
      return EXIT.ok;
    }
    default:
      throw new UsageError("shared: expected 'define', 'show', 'run' or 'unblock'");
  }
}

async function appCommand(ctx: Context, sub: string | undefined): Promise<number> {
  onlyFlags(ctx.args, ['settings']);
  if (sub !== 'configure') throw new UsageError("app: expected 'configure'");
  const settings = jsonArgument(ctx, 'settings');
  if (settings === undefined) throw new UsageError('app configure: --settings is required');
  await execute(ctx, 'app.configure', { settings });
  print(ctx, { ok: true }, () => ['App settings replaced.']);
  return EXIT.ok;
}

interface CheckoutResult {
  granted: boolean;
  decision: string;
  reason?: string;
  paths?: string[];
}

async function checkoutCommand(ctx: Context, sub: string | undefined): Promise<number> {
  switch (sub) {
    case 'release': {
      onlyFlags(ctx.args, ['ticket', 'node', 'lane']);
      const paths = ctx.args.positionals.slice(2).map((path) => resolve(ctx.cwd, path));
      const result = (await execute(ctx, 'checkout.release', { ...target(ctx), ...(paths.length === 0 ? {} : { paths }) })) as { released: number };
      print(ctx, result, () => [`Released ${result.released} checkout(s).`]);
      return EXIT.ok;
    }
    case 'force-release': {
      onlyFlags(ctx.args, ['project']);
      const ids = ctx.args.positionals.slice(2);
      if (ids.length === 0) throw new UsageError('checkout force-release: give the entry ids');
      const result = (await execute(ctx, 'checkout.forceRelease', { projectId: requireFlag(ctx.args, 'project'), ids })) as { released: number };
      print(ctx, result, () => [`Released ${result.released} entr${result.released === 1 ? 'y' : 'ies'}.`]);
      return EXIT.ok;
    }
    default: {
      onlyFlags(ctx.args, ['ticket', 'node', 'lane', 'shared']);
      const paths = ctx.args.positionals.slice(1).map((path) => resolve(ctx.cwd, path));
      if (paths.length === 0) throw new UsageError('checkout: give the files to check out');
      const result = (await execute(ctx, 'checkout.acquire', {
        ...target(ctx),
        paths,
        source: 'agent',
        ...(has(ctx.args, 'shared') ? { mode: 'shared' } : {}),
      })) as CheckoutResult;
      print(ctx, result, () => [result.granted ? `Checked out: ${(result.paths ?? []).join(', ') || '(outside the workspace)'}` : `Refused: ${result.reason ?? result.decision}`]);
      return result.granted ? EXIT.ok : EXIT.refused;
    }
  }
}

interface CleanupRow {
  key: string;
  ticketId: string;
  path: string;
  branch: string;
  merged: boolean;
  files: string[];
  count: number;
  ignored: string[];
  ignoredCount: number;
  fingerprint: string;
}

/**
 * `vuyro workspace cleanup`: worktrees the engine left for a person, with everything they still hold (ignored files
 * included). Removing one takes its key and the fingerprint that was shown, so only what the person saw is removed;
 * the engine refuses when anything changed since (D-042).
 */
async function cleanupCommand(ctx: Context): Promise<number> {
  onlyFlags(ctx.args, ['project', 'ticket', 'remove', 'fingerprint', 'no-wait']);
  const projectId = requireFlag(ctx.args, 'project');
  const key = flag(ctx.args, 'remove');
  if (key === undefined) {
    const ticketId = flag(ctx.args, 'ticket');
    const view = await withClient(ctx, (client) => client.request<{ worktrees: CleanupRow[] }>(RPC_METHODS.worktreeCleanup, { projectId, ...(ticketId === undefined ? {} : { ticketId }) }));
    print(ctx, view, () => [
      `Worktrees to clean up (${view.worktrees.length}):`,
      ...view.worktrees.flatMap((row) => [
        `  ${row.key}  ${row.path}`,
        `    branch ${row.branch}${row.merged ? ' (merged: deleted with it)' : ' (kept)'}; ${row.count} changed or untracked, ${row.ignoredCount} ignored`,
        ...row.files.map((file) => `    changed  ${file}`),
        ...row.ignored.map((file) => `    ignored  ${file}`),
        ...(row.count > row.files.length || row.ignoredCount > row.ignored.length ? ['    …'] : []),
        `    remove (deletes all of the above): vuyro workspace cleanup --project ${projectId} --remove ${row.key} --fingerprint ${row.fingerprint}`,
      ]),
    ]);
    return EXIT.ok;
  }
  const fingerprint = requireFlag(ctx.args, 'fingerprint');
  await execute(ctx, 'worktree.cleanup', { projectId, key, fingerprint });
  if (has(ctx.args, 'no-wait')) {
    print(ctx, { key, requested: true }, () => [`Clean-up of ${key} requested.`]);
    return EXIT.ok;
  }
  // The engine carries it out; wait for the outcome.
  for (let attempt = 0; attempt < 120; attempt++) {
    const view = await withClient(ctx, (client) => client.request<{ worktrees: Record<string, unknown>[] }>(RPC_METHODS.workspace, { projectId, changes: 'flagged', limit: 1 }));
    const row = view.worktrees.find((worktree) => worktree.key === key);
    if (row !== undefined && row.removedAt !== null) {
      print(ctx, { key, removed: true }, () => [`Removed ${key}.`]);
      return EXIT.ok;
    }
    if (row !== undefined && typeof row.cleanupSkippedAt === 'number' && typeof row.cleanupApprovedAt === 'number' && row.cleanupSkippedAt >= row.cleanupApprovedAt) {
      const reason = typeof row.cleanupSkippedReason === 'string' ? row.cleanupSkippedReason : 'unknown';
      print(ctx, { key, removed: false, reason }, () => [`Not removed (${reason}): look at it again with 'vuyro workspace cleanup --project ${projectId}'.`]);
      return EXIT.refused;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  print(ctx, { key, requested: true }, () => [`Clean-up of ${key} requested; the engine has not finished it yet.`]);
  return EXIT.ok;
}

async function workspaceCommand(ctx: Context, sub: string | undefined): Promise<number> {
  if (sub === 'cleanup') return cleanupCommand(ctx);
  onlyFlags(ctx.args, ['project', 'ticket', 'all']);
  if (sub !== 'show') throw new UsageError("workspace: expected 'show' or 'cleanup'");
  const ticketId = flag(ctx.args, 'ticket');
  const view = await withClient(ctx, (client) =>
    client.request<{ checkouts: Record<string, unknown>[]; blocks: Record<string, unknown>[]; changes: Record<string, unknown>[]; overlaps: Record<string, unknown>[]; worktrees: Record<string, unknown>[] }>(
      RPC_METHODS.workspace,
      { projectId: requireFlag(ctx.args, 'project'), ...(ticketId === undefined ? {} : { ticketId }), changes: has(ctx.args, 'all') ? 'all' : 'flagged' },
    ),
  );
  const text = (value: unknown): string => (typeof value === 'string' ? value : typeof value === 'number' || typeof value === 'boolean' ? String(value) : JSON.stringify(value));
  print(ctx, view, () => [
    `Held (${view.checkouts.length}):`,
    ...view.checkouts.map((entry) => `  ${text(entry.mode).padEnd(9)} ${text(entry.space)}:${text(entry.path)}  ${text(entry.nodeId)}/${text(entry.lane)} of ${text(entry.ticketId)}${entry.paused === true ? '  (paused)' : ''}`),
    `Refused (${view.blocks.length}):`,
    ...view.blocks.map((block) => `  ${text(block.outcome).padEnd(5)} ${text(block.nodeId)}/${text(block.lane)} of ${text(block.ticketId)}: ${text(block.paths)}`),
    `Changes (${view.changes.length}):`,
    ...view.changes.map((change) => `  ${text(change.attribution).padEnd(12)} ${text(change.space)}:${text(change.path)}`),
    `Overlap warnings (${view.overlaps.length}):`,
    ...view.overlaps.map((overlap) => `  ${text(overlap.path)}  ${text(overlap.spaces)}`),
    `Worktrees (${view.worktrees.length}):`,
    ...view.worktrees.map((worktree) => `  ${text(worktree.branch)}  ${text(worktree.path)}${worktree.removedAt === null ? '' : `  (removed: ${text(worktree.removedReason)})`}`),
  ]);
  return EXIT.ok;
}

async function readAll(input: AsyncIterable<string | Buffer>, limit: number): Promise<string> {
  let text = '';
  for await (const chunk of input) {
    text += String(chunk);
    if (text.length > limit) throw new Error('the hook input is too large');
  }
  return text;
}

/**
 * `vuyro hook pretooluse`: always exits 0. Its stdout is either empty (the edit may go ahead) or a JSON deny; any
 * failure (no run token, the engine unreachable, a refusal) is a deny, never an unchecked edit.
 */
async function hookCommand(ctx: Context, sub: string | undefined): Promise<number> {
  try {
    onlyFlags(ctx.args, ['provider']);
    if (sub !== 'pretooluse') throw new UsageError("hook: expected 'pretooluse'");
    const stdin = await readAll(ctx.options.stdin ?? process.stdin, 4 * 1024 * 1024).catch(() => '');
    const token = ctx.env[AGENT_ENV.runToken];
    const ticketId = ctx.env[AGENT_ENV.ticket];
    const nodeId = ctx.env[AGENT_ENV.node];
    const identified = token !== undefined && token !== '' && ticketId !== undefined && ticketId !== '' && nodeId !== undefined && nodeId !== '';
    const checkout: HookCheckout | undefined = identified
      ? async (paths) => {
          try {
            const result = (await execute(ctx, 'checkout.acquire', { ticketId, nodeId, paths: [...paths], source: 'hook' })) as CheckoutResult;
            return { granted: result.granted, ...(result.reason === undefined ? {} : { reason: result.reason }) };
          } catch (error) {
            if (error instanceof EngineRequestError) throw new Error(`${error.data.code}: ${error.data.message}`, { cause: error });
            throw error;
          }
        }
      : undefined;
    const output = await runPreToolUseHook(stdin, ctx.cwd, checkout);
    if (output !== undefined) ctx.io.out(output);
  } catch (error) {
    // Even a broken invocation answers with a deny: a hook that errors out would let the edit through.
    ctx.io.out(denyOutput(`the checkout hook failed (${error instanceof Error ? error.message : String(error)}), so the edit is blocked`));
  }
  return EXIT.ok;
}

async function eventsCommand(ctx: Context): Promise<number> {
  onlyFlags(ctx.args, ['after', 'follow']);
  const after = Number(flag(ctx.args, 'after') ?? '0');
  if (!Number.isSafeInteger(after) || after < 0) throw new UsageError('--after must be a sequence number');
  const line = (event: DomainEvent) =>
    ctx.json ? JSON.stringify(event) : `${event.sequence}  ${new Date(event.timestamp).toISOString()}  ${event.type}  ${event.aggregateId}  ${event.actor.kind}`;
  const client = await connect(ctx);
  try {
    if (!has(ctx.args, 'follow')) {
      const { events } = await client.request<{ events: DomainEvent[] }>(RPC_METHODS.readEvents, { afterSequence: after, limit: 1000 });
      for (const event of events) ctx.io.out(line(event));
      return EXIT.ok;
    }
    await client.subscribe(after, (events) => {
      for (const event of events) ctx.io.out(line(event));
    });
    await new Promise<void>((resolveClosed) => {
      const timer = setInterval(() => {
        if (client.closed) {
          clearInterval(timer);
          resolveClosed();
        }
      }, 500);
    });
    return EXIT.ok;
  } finally {
    client.close();
  }
}

export { resolveEngineLocation };
