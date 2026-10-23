import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CommandResponse, DefinitionEnvelope } from '@vuyro/contracts';
import type { TransportIdentity } from '../commands/caller.ts';
import type { DefinitionWriter } from './definition-writer.ts';
import { definitionHash } from './definitions.ts';

/**
 * Built-in node types and the default template. They are ordinary definition files shipped with the
 * engine (`packages/engine/definitions/`), installed through the same save path as anything a person
 * or an agent writes, so they can be copied and changed like any other definition.
 */

/** `definitions/` next to `src/` (and next to `dist/` once built). */
export const BUILTIN_DEFINITIONS_DIR = fileURLToPath(new URL('../../definitions/', import.meta.url));

export const DEFAULT_TEMPLATE_ID = 'vuyro/ai-sdlc';

export async function loadBuiltinDefinitions(dir = BUILTIN_DEFINITIONS_DIR): Promise<DefinitionEnvelope[]> {
  const definitions: DefinitionEnvelope[] = [];
  for (const sub of ['node-types', 'templates']) {
    const folder = join(dir, sub);
    for (const name of (await readdir(folder)).filter((file) => file.endsWith('.json')).sort()) {
      definitions.push(JSON.parse(await readFile(join(folder, name), 'utf8')) as DefinitionEnvelope);
    }
  }
  // Node types first: templates are checked against them.
  return definitions.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'nodeType' ? -1 : 1));
}

const BUILTIN: TransportIdentity = { kind: 'internal', component: 'builtin' };

/**
 * Saves every built-in definition that is not active yet. A version that already exists with other
 * content is reported in the result and left alone (never overwritten).
 */
export async function installBuiltins(writer: DefinitionWriter, definitions?: readonly DefinitionEnvelope[]): Promise<CommandResponse[]> {
  const responses: CommandResponse[] = [];
  for (const definition of definitions ?? (await loadBuiltinDefinitions())) {
    const hash = definitionHash(definition);
    const requestId = `builtin-${definition.kind}-${definition.id.replace('/', ':')}-${definition.version}-${hash.slice(7, 23)}`;
    responses.push(await writer.save(definition, BUILTIN, requestId));
  }
  return responses;
}
