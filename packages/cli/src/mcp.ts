import { randomUUID } from 'node:crypto';
import { AGENT_ENV } from '@vuyro/agent-adapters';
import { EngineClient, type EngineClientOptions, EngineRequestError } from '@vuyro/engine';

/**
 * `vuyro mcp`: a stdio MCP server for one node agent. It offers the two reporting commands as tools and sends
 * them to the engine with the run token from its environment, exactly like `vuyro node done` / `vuyro artifact
 * add` would. Codex needs it: its shell commands run in an OS sandbox that cannot open the engine pipe, while
 * MCP servers run outside it ([[초기 검증 결과]] M3). Without a run token it offers no tools.
 */

const PROTOCOL = '2025-06-18';

const TOOLS = [
  {
    name: 'vuyro_artifact_add',
    description: 'Register an artifact (location and version) of your node in a slot. Do this before vuyro_node_done.',
    inputSchema: {
      type: 'object',
      properties: {
        slot: { type: 'string' },
        kind: { type: 'string', description: 'file, git, url, …' },
        uri: { type: 'string' },
        version: { type: 'string' },
        title: { type: 'string' },
        mimeType: { type: 'string' },
        contentHash: { type: 'string' },
      },
      required: ['slot', 'kind', 'uri'],
      additionalProperties: false,
    },
  },
  {
    name: 'vuyro_node_done',
    description: 'Report the result of your node once: the output port and data/summary, or several items. If it is refused, the error says why; fix it and call again.',
    inputSchema: {
      type: 'object',
      properties: {
        port: { type: 'string' },
        data: { type: 'object' },
        summary: { type: 'string' },
        artifacts: { type: 'object' },
        items: { type: 'array', items: { type: 'object' } },
      },
      required: ['port'],
      additionalProperties: false,
    },
  },
] as const;

export interface McpServerOptions {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly connect?: (options: EngineClientOptions) => Promise<EngineClient>;
}

type Message = { jsonrpc?: string; id?: string | number; method?: string; params?: Record<string, unknown> };

/** Serves MCP over newline-delimited JSON until the input ends. */
export async function serveMcp(input: AsyncIterable<string> | Iterable<string>, write: (line: string) => void, options: McpServerOptions): Promise<void> {
  const token = options.env[AGENT_ENV.runToken];
  const agent = token !== undefined && token !== '';
  let buffer = '';
  const pending: Promise<void>[] = [];
  for await (const chunk of input) {
    buffer += chunk;
    for (let newline = buffer.indexOf('\n'); newline >= 0; newline = buffer.indexOf('\n')) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line === '') continue;
      let message: Message;
      try {
        message = JSON.parse(line) as Message;
      } catch {
        write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }));
        continue;
      }
      if (message.id === undefined) continue; // notifications (initialized, cancelled)
      const id = message.id;
      const reply = (result: unknown): void => {
        write(JSON.stringify({ jsonrpc: '2.0', id, result }));
      };
      switch (message.method) {
        case 'initialize': {
          const requested = message.params?.protocolVersion;
          reply({ protocolVersion: typeof requested === 'string' ? requested : PROTOCOL, capabilities: { tools: {} }, serverInfo: { name: 'vuyro', version: '0.0.0' } });
          break;
        }
        case 'ping':
          reply({});
          break;
        case 'tools/list':
          reply({ tools: agent ? TOOLS : [] });
          break;
        case 'tools/call':
          pending.push(call(message.params ?? {}, options, token ?? '').then(reply));
          break;
        default:
          write(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message: `unknown method '${String(message.method)}'` } }));
      }
    }
  }
  await Promise.all(pending);
}

async function call(params: Record<string, unknown>, options: McpServerOptions, token: string): Promise<unknown> {
  const text = (value: string, isError = false) => ({ content: [{ type: 'text', text: value }], ...(isError ? { isError: true } : {}) });
  if (token === '') return text('vuyro mcp: no VUYRO_RUN_TOKEN in the environment; this server only serves node agents', true);
  const ticketId = options.env[AGENT_ENV.ticket] ?? '';
  const nodeId = options.env[AGENT_ENV.node] ?? '';
  const args = typeof params.arguments === 'object' && params.arguments !== null ? (params.arguments as Record<string, unknown>) : {};
  let type: string;
  let payload: Record<string, unknown>;
  switch (params.name) {
    case 'vuyro_node_done':
      type = 'node.done';
      payload = { ticketId, nodeId, ...args };
      break;
    case 'vuyro_artifact_add': {
      const { slot, ...ref } = args;
      type = 'artifact.add';
      payload = { ticketId, nodeId, slot, ref };
      break;
    }
    default:
      return text(`unknown tool '${String(params.name)}'`, true);
  }
  try {
    const client = await (options.connect ?? ((o) => EngineClient.connect(o)))({ client: 'cli', env: options.env });
    try {
      await client.execute({ requestId: `mcp-${randomUUID()}`, type, payload, auth: { runToken: token } });
    } finally {
      client.close();
    }
    return text(type === 'node.done' ? 'Result recorded.' : 'Artifact registered.');
  } catch (error) {
    // The same error object the CLI prints, so the agent can fix the call and try again.
    if (error instanceof EngineRequestError) return text(JSON.stringify({ error: error.data }), true);
    return text(`vuyro mcp: ${error instanceof Error ? error.message : String(error)}`, true);
  }
}
