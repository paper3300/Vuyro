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
import { flag, has, onlyFlags, type ParsedArgs, parseArgs, requireFlag, UsageError } from './args.ts';

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
  ticket create --project <id> --title <text> [--description <text>] [--template <id>[@<version>]]
  ticket list [--project <id>]     ticket show <ticketId>     ticket stats <ticketId>
  node done --port <port> [--data <json|@file>] [--summary <text>] [--artifacts <json|@file>] [--items <json|@file>]
  node approve|reject|retry|pause|resume [--comment <text>] [--items <json|@file>]
  artifact add <slot> --kind <kind> --uri <uri> [--version <v>] [--title <t>] [--mime <type>] [--hash <hash>]
  artifact list --ticket <id> [--node <id>]
  definition save <json|@file> Save a node type or template version (export envelope)
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
  if (command === undefined || command === 'help' || command === '-h') {
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

/** A JSON value from the argument itself or `@file`. */
function jsonArgument(ctx: Context, name: string): unknown {
  const raw = flag(ctx.args, name);
  if (raw === undefined) return undefined;
  const text = raw.startsWith('@') ? readFileSync(resolve(ctx.cwd, raw.slice(1)), 'utf8') : raw;
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
      const launched = await (ctx.options.launch ?? launchEngineDaemon)({ ...location(ctx), client: 'cli' });
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
      throw new UsageError("project: expected 'create' or 'list'");
  }
}

async function ticketCommand(ctx: Context, sub: string | undefined): Promise<number> {
  switch (sub) {
    case 'create': {
      onlyFlags(ctx.args, ['project', 'title', 'description', 'template']);
      const template = flag(ctx.args, 'template');
      let templateRef: { id: string; version?: number } | undefined;
      if (template !== undefined) {
        const [id = '', version] = template.split('@');
        templateRef = { id, ...(version === undefined ? {} : { version: Number(version) }) };
      }
      const description = flag(ctx.args, 'description');
      const result = (await execute(ctx, 'ticket.create', {
        projectId: requireFlag(ctx.args, 'project'),
        title: requireFlag(ctx.args, 'title'),
        ...(description === undefined ? {} : { description }),
        ...(templateRef === undefined ? {} : { template: templateRef }),
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
        port: requireFlag(ctx.args, 'port'),
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
  const text = source.startsWith('@') ? readFileSync(resolve(ctx.cwd, source.slice(1)), 'utf8') : source;
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
