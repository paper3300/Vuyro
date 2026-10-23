import type { DefinitionEnvelope } from '@vuyro/contracts';

/** A test node type: an agent with two whole input ports, `left` and `right`. */
export const MERGE_NODE_TYPE: DefinitionEnvelope = {
  vuyro: 'export',
  formatVersion: 1,
  kind: 'nodeType',
  id: 'myteam.merge',
  version: 1,
  name: 'Merge',
  content: {
    type: 'myteam.merge',
    version: 1,
    label: 'Merge',
    completion: 'agent',
    inputs: [
      { name: 'left', label: 'Left' },
      { name: 'right', label: 'Right' },
    ],
    outputs: [
      { name: 'done', label: 'Done' },
      { name: 'error', label: 'Could not finish' },
    ],
    params: [{ name: 'instructions', label: 'Instructions', required: true, schema: { type: 'string', minLength: 1 } }],
    prompt: '{{ params.instructions }}',
  },
};
