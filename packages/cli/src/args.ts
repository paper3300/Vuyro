/** Minimal argument parser: positionals, `--name value`, `--name=value` and boolean flags. */

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

export interface ParsedArgs {
  readonly positionals: readonly string[];
  readonly flags: ReadonlyMap<string, string | true>;
}

const BOOLEAN_FLAGS = new Set(['json', 'follow', 'help', 'all', 'shared', 'clear-root', 'clear-base-ref']);

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Map<string, string | true>();
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index] ?? '';
    if (arg === '--') {
      positionals.push(...argv.slice(index + 1));
      break;
    }
    if (!arg.startsWith('--') || arg === '--') {
      positionals.push(arg);
      continue;
    }
    const body = arg.slice(2);
    const equals = body.indexOf('=');
    if (equals >= 0) {
      flags.set(body.slice(0, equals), body.slice(equals + 1));
      continue;
    }
    if (BOOLEAN_FLAGS.has(body)) {
      flags.set(body, true);
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined) throw new UsageError(`--${body} needs a value`);
    flags.set(body, value);
    index += 1;
  }
  return { positionals, flags };
}

export function flag(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags.get(name);
  if (value === true) throw new UsageError(`--${name} needs a value`);
  return value;
}

export function has(args: ParsedArgs, name: string): boolean {
  return args.flags.has(name);
}

export function requireFlag(args: ParsedArgs, name: string, hint = ''): string {
  const value = flag(args, name);
  if (value === undefined || value === '') throw new UsageError(`--${name} is required${hint}`);
  return value;
}

/** Rejects flags the command does not know (typos must not pass silently). */
export function onlyFlags(args: ParsedArgs, allowed: readonly string[]): void {
  const known = new Set([...allowed, 'json', 'data-dir', 'pipe', 'request-id', 'help']);
  for (const name of args.flags.keys()) if (!known.has(name)) throw new UsageError(`unknown option --${name}`);
}
