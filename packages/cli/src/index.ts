import { createRequire } from 'node:module';
import { PROTOCOL_VERSION } from '@vuyro/contracts';

export interface CliIo {
  out(line: string): void;
  err(line: string): void;
}

const USAGE = `Usage: vuyro <command>

Commands:
  help         Show this help
  --version    Print the CLI and protocol versions

Ticket, node and artifact commands arrive with the engine daemon (M3).`;

export function cliVersion(): string {
  const require = createRequire(import.meta.url);
  const manifest = require('../package.json') as { version: string };
  return manifest.version;
}

/** Runs one CLI invocation and returns the process exit code. */
export function runCli(argv: readonly string[], io: CliIo): number {
  const [command] = argv;
  switch (command) {
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      io.out(USAGE);
      return 0;
    case '--version':
    case '-v':
      io.out(`vuyro ${cliVersion()} (protocol ${PROTOCOL_VERSION})`);
      return 0;
    default:
      io.err(`vuyro: unknown command '${command}'\n\n${USAGE}`);
      return 2;
  }
}
