/**
 * Copies a recorded agent CLI output into a fixture with machine-specific values replaced.
 *
 * Run: node packages/agent-adapters/scripts/sanitize-fixture.ts --root <recording dir> <input> <output>
 *
 * - `--root`: the temporary directory the recording ran in → `C:\Users\sample\AppData\Local\Temp\vuyro-fixture`
 * - the current user name (also inside paths, slugs and the host name) → `sample`
 * - every prefix of the user name with 4+ characters → `sample`, because tools
 *   truncate paths in messages (PowerShell prints `C:\Users\<first chars>...`)
 *
 * JSONL and JSON inputs are rewritten value by value (so escaping stays valid);
 * anything else is treated as plain text.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { extname } from 'node:path';
import { parseArgs } from 'node:util';

const FIXTURE_ROOT = String.raw`C:\Users\sample\AppData\Local\Temp\vuyro-fixture`;

const { values, positionals } = parseArgs({
  options: { root: { type: 'string' } },
  allowPositionals: true,
});
const [input, output] = positionals;
if (values.root === undefined || input === undefined || output === undefined) {
  console.error('usage: sanitize-fixture.ts --root <recording dir> <input> <output>');
  process.exit(2);
}

const root = values.root.replace(/[\\/]+$/, '');
const user = userInfo().username;
const backslashed = root.replaceAll('/', '\\');
const slashed = root.replaceAll('\\', '/');
// Claude Code names per-project folders after the cwd with separators turned into '-'.
const slug = (path: string) => path.replace(/[:\\/]/g, '-');

const replacements: Array<[RegExp, string]> = [
  [new RegExp(escape(backslashed), 'gi'), FIXTURE_ROOT],
  [new RegExp(escape(slashed), 'gi'), FIXTURE_ROOT.replaceAll('\\', '/')],
  [new RegExp(escape(slug(backslashed)), 'gi'), slug(FIXTURE_ROOT)],
  // Longest first, so the full name is replaced before any of its prefixes.
  ...userNamePrefixes(user).map((prefix): [RegExp, string] => [new RegExp(escape(prefix), 'gi'), 'sample']),
];

/** The user name and all of its prefixes with at least 4 characters, longest first. */
function userNamePrefixes(name: string): string[] {
  const prefixes: string[] = [];
  for (let length = name.length; length >= Math.min(4, name.length); length--) prefixes.push(name.slice(0, length));
  return prefixes;
}

function scrub(text: string): string {
  return replacements.reduce((value, [pattern, replacement]) => value.replace(pattern, replacement), text);
}

function scrubValue(value: unknown): unknown {
  if (typeof value === 'string') return scrub(value);
  if (Array.isArray(value)) return value.map(scrubValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [scrub(key), scrubValue(inner)]));
  }
  return value;
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const source = readFileSync(input, 'utf8');
let result: string;
switch (extname(input)) {
  case '.jsonl':
  case '.log':
    result = source
      .split(/\r?\n/)
      .filter((line) => line.trim() !== '')
      .map((line) => `${JSON.stringify(scrubValue(JSON.parse(line)))}\n`)
      .join(''); // an empty hook log stays empty
    break;
  case '.json':
    result = `${JSON.stringify(scrubValue(JSON.parse(source)), null, 2)}\n`;
    break;
  default:
    result = scrub(source).replace(/\r\n/g, '\n');
}

const leftover = userNamePrefixes(user).find((prefix) => result.toLowerCase().includes(prefix.toLowerCase()));
if (leftover !== undefined) {
  console.error(`${output}: still contains (part of) the user name`);
  process.exit(1);
}
writeFileSync(output, result);
