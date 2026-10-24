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
  const ports = [...node.outputs.values()];
  const first = ports[0]?.name ?? 'done';
  const lines = [
    '---',
    '## Reporting to Vuyro',
    `You are working on node "${node.label}" (\`${node.id}\`, lane ${lane}, run ${run}) of the ticket "${ticketTitle}".`,
    'Report through the `vuyro` CLI. It identifies you with VUYRO_RUN_TOKEN from your environment; never print that value.',
    'If you have the `vuyro_node_done` and `vuyro_artifact_add` tools (the vuyro MCP server), use them instead of the shell commands below: same arguments, same rules.',
    // Measured (M7a): a small model read "port" as a network port and left `--port` out. Say what it is, with a command to copy.
    `A "port" here is not a network port: it is the name of one of this node's outputs, listed below (${ports.map((port) => `\`${port.name}\``).join(', ')}). \`--port\` is always required.`,
    '- Register each artifact first: `vuyro artifact add <slot> --kind <kind> --uri <uri> [--version <version>]`',
    `- Then finish exactly once, for example: \`vuyro node done --port ${first} --data '<json>' --summary "<what you did and what is left>"\` (\`--data @file.json\` reads a file; keep such files out of the project folder)`,
    `  For several items: \`vuyro node done --port ${first} --items '<json array>'\` (each {data, summary, artifacts, pairedInput}).`,
    '- Run each `vuyro` command on its own (not chained with `;`, `&&` or pipes), so it is not held for approval.',
    '- If the result is rejected, the error explains why; fix it and run `vuyro node done` again.',
    '',
    'Output ports (the values `--port` takes):',
  ];
  for (const port of ports) {
    const parts = [`- \`--port ${port.name}\` (${port.label})`];
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
