import { type ExpressionContext, renderTemplate } from '@vuyro/contracts';
import type { CompiledNode } from './compile.ts';

/**
 * The agent prompt: the node type's template rendered against the execution context, then the
 * reporting instructions the engine always adds (which ports exist, what each expects, how to report).
 */
export function agentPrompt(node: CompiledNode, context: ExpressionContext, ticketTitle: string, lane: string, run: number): string {
  const template = node.type.prompt;
  const body = template === undefined ? '' : renderTemplate(template, context).trim();
  return `${body}\n\n${reportingInstructions(node, ticketTitle, lane, run)}`;
}

function reportingInstructions(node: CompiledNode, ticketTitle: string, lane: string, run: number): string {
  const lines = [
    '---',
    '## Reporting to Vuyro',
    `You are working on node "${node.label}" (\`${node.id}\`, lane ${lane}, run ${run}) of the ticket "${ticketTitle}".`,
    'Report through the `vuyro` CLI. It identifies you with VUYRO_RUN_TOKEN from your environment; never print that value.',
    'If you have the `vuyro_node_done` and `vuyro_artifact_add` tools (the vuyro MCP server), use them instead of the shell commands below: same arguments, same rules.',
    '- Register each artifact first: `vuyro artifact add <slot> --kind <kind> --uri <uri> [--version <version>]`',
    '- Then finish exactly once: `vuyro node done --port <port> [--data @result.json] [--summary "<what you did and what is left>"]`',
    '  For several items: `vuyro node done --port <port> --items @items.json` (an array of {data, summary, artifacts, pairedInput}).',
    '- If the result is rejected, the error explains why; fix it and run `vuyro node done` again.',
    '',
    'Output ports:',
  ];
  for (const port of node.outputs.values()) {
    const parts = [`- \`${port.name}\` (${port.label})`];
    if (port.schema !== undefined) parts.push(`data schema: \`${JSON.stringify(port.schema)}\``);
    if (port.artifacts.length > 0) {
      parts.push(
        `artifact slots: ${port.artifacts.map((slot) => `${slot.slot} (${slot.kinds.join('|')}${slot.required === true ? ', required' : ''})`).join(', ')}`,
      );
    }
    lines.push(parts.join('; '));
  }
  return lines.join('\n');
}
