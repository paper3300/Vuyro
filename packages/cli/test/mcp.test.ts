import { describe, expect, it } from 'vitest';
import type { EngineClient, EngineClientOptions } from '@vuyro/engine';
import { EngineRequestError } from '@vuyro/engine';
import { serveMcp } from '../src/mcp.ts';

/** `vuyro mcp`: the node agent's report tools over stdio MCP, sent with the run token from the environment. */

const TOKEN = `vrt_${'b'.repeat(43)}`;
const AGENT = { VUYRO_RUN_TOKEN: TOKEN, VUYRO_TICKET: 'T', VUYRO_NODE: 'dev', VUYRO_PIPE: 'pipe', VUYRO_HUMAN_CREDENTIAL: 'vhc_never' };

async function session(env: Record<string, string | undefined>, messages: unknown[], refuse = false) {
  const sent: { envelope: Record<string, unknown>; options: EngineClientOptions }[] = [];
  const connect = (options: EngineClientOptions): Promise<EngineClient> =>
    Promise.resolve({
      execute: (envelope: Record<string, unknown>) => {
        sent.push({ envelope, options });
        if (refuse) return Promise.reject(new EngineRequestError(-32602, 'bad port', { code: 'validation_failed', message: "no output port 'nope'", retryable: false }));
        return Promise.resolve({ ok: true });
      },
      close: () => undefined,
    } as unknown as EngineClient);
  const out: Record<string, unknown>[] = [];
  const input = [messages.map((message) => JSON.stringify(message)).join('\n') + '\n'];
  await serveMcp(input, (line) => out.push(JSON.parse(line) as Record<string, unknown>), { env, connect });
  return { out, sent };
}

describe('vuyro mcp', () => {
  it('lists the report tools and sends node.done with the run token, ticket and node from the environment', async () => {
    const { out, sent } = await session(AGENT, [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'vuyro_artifact_add', arguments: { slot: 'report', kind: 'file', uri: 'r.md', version: '1' } } },
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'vuyro_node_done', arguments: { port: 'done', summary: 'ok' } } },
    ]);
    expect(out[0]).toMatchObject({ id: 1, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} } } });
    expect((out[1]?.result as { tools: { name: string }[] }).tools.map((tool) => tool.name)).toEqual(['vuyro_artifact_add', 'vuyro_node_done', 'vuyro_checkout']);
    expect(sent.map((call) => call.envelope)).toMatchObject([
      { type: 'artifact.add', payload: { ticketId: 'T', nodeId: 'dev', slot: 'report', ref: { kind: 'file', uri: 'r.md', version: '1' } }, auth: { runToken: TOKEN } },
      { type: 'node.done', payload: { ticketId: 'T', nodeId: 'dev', port: 'done', summary: 'ok' }, auth: { runToken: TOKEN } },
    ]);
    // It reaches the engine the agent's environment names, and never as the person.
    expect(sent[0]?.options).toMatchObject({ client: 'cli' });
    expect(sent[0]?.options).not.toHaveProperty('humanCredential');
    expect(out.slice(2).map((reply) => reply.result)).toEqual([
      { content: [{ type: 'text', text: 'Artifact registered.' }] },
      { content: [{ type: 'text', text: 'Result recorded.' }] },
    ]);
  });

  it('returns a refusal as a tool error the agent can act on', async () => {
    const { out } = await session(AGENT, [{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'vuyro_node_done', arguments: { port: 'nope' } } }], true);
    expect(out[0]).toMatchObject({ id: 1, result: { isError: true } });
    expect(JSON.stringify(out[0])).toContain('validation_failed');
  });

  it('without a run token it offers nothing and sends nothing', async () => {
    const { out, sent } = await session({}, [
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'vuyro_node_done', arguments: { port: 'done' } } },
    ]);
    expect(out[0]).toMatchObject({ result: { tools: [] } });
    expect(out[1]).toMatchObject({ result: { isError: true } });
    expect(sent).toEqual([]);
  });
});
