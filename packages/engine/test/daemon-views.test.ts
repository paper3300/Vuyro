import { afterEach, describe, expect, it } from 'vitest';
import type { AgentAdapter, AgentStartRequest } from '@vuyro/agent-adapters';
import { type BoardResult, RPC_METHODS, type TemplateSummary } from '@vuyro/contracts';
import type { TicketDetail } from '../src/daemon/queries.ts';
import { systemClock } from '../src/runtime/clock.ts';
import { type ScriptedBehavior, ScriptedAgentAdapter } from '../src/workflow/scripted-agent.ts';
import { type DaemonHarness, openDaemonHarness } from './helpers/daemon-harness.ts';

/**
 * What the desktop app reads (M6): the templates to pick from, a project's board in one request, and a ticket's
 * detail with its pinned workflow and what waits for a person.
 */

let h: DaemonHarness | undefined;

afterEach(async () => {
  await h?.close();
  h = undefined;
});

let requests = 0;
const rid = () => `views-req-${String(++requests).padStart(6, '0')}`;

/** The daemon builds its bus itself; this adapter plays the agent once the daemon (and its bus) exists. */
function lateAdapter(behavior: ScriptedBehavior): { adapter: AgentAdapter; bind(harness: DaemonHarness): void } {
  let inner: ScriptedAgentAdapter | undefined;
  return {
    adapter: {
      provider: 'claude',
      start: (request: AgentStartRequest) => {
        if (inner === undefined) throw new Error('adapter used before the daemon started');
        return inner.start(request);
      },
    },
    bind(harness) {
      inner = new ScriptedAgentAdapter({ provider: 'claude', clock: systemClock, bus: harness.daemon.bus, activity: harness.daemon.activity, behavior });
    },
  };
}

const specAgent: ScriptedBehavior = async (session) => {
  session.observe({ kind: 'usage', scope: 'run', tokens: { input: 1200, cacheRead: 300, cacheWrite: 0, output: 450 } });
  const { nodeId } = session.request;
  if (nodeId === 'spec') {
    await session.vuyro('artifact.add', { ticketId: session.request.ticketId, nodeId, slot: 'specDoc', ref: { kind: 'file', uri: 'docs/spec.md', version: 'v1' } });
    await session.vuyro('node.done', { ticketId: session.request.ticketId, nodeId, port: 'done', summary: '<b>Spec</b> written', data: { title: 'Notes', acceptanceCriteria: ['saves'] } });
  }
  return undefined;
};

async function until<T>(read: () => Promise<T>, ok: (value: T) => boolean): Promise<T> {
  for (let attempt = 0; attempt < 300; attempt++) {
    const value = await read();
    if (ok(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('condition never held');
}

describe.runIf(process.platform === 'win32')('daemon views for the app', () => {
  it('lists active templates with nodes in stage order and loops marked', async () => {
    h = await openDaemonHarness();
    const ui = await h.ui();
    const { templates } = await ui.request<{ templates: TemplateSummary[] }>(RPC_METHODS.templates, {});
    const sdlc = templates.find((template) => template.id === 'vuyro/ai-sdlc');
    expect(sdlc?.problem).toBeUndefined();
    expect(sdlc?.nodes.map((node) => node.id)).toEqual(['brainstorming', 'spec', 'specApproval', 'plan', 'dev', 'join', 'qa', 'done']);
    expect(sdlc?.nodes.find((node) => node.id === 'qa')).toMatchObject({ completion: 'agent', review: 'human' });
    expect(sdlc?.nodes.find((node) => node.id === 'dev')?.inputMode).toBe('each');
    expect(sdlc?.edges.filter((edge) => edge.back).map((edge) => `${edge.from.node}>${edge.to.node}`)).toEqual(['specApproval>spec', 'qa>dev']);
    // Unknown params are refused like every other query.
    await expect(ui.request(RPC_METHODS.templates, { all: true })).rejects.toMatchObject({ rpcCode: -32602 });
  });

  it('serves the board in one request: lanes, priority, tokens and the pinned workflows', async () => {
    const agent = lateAdapter(specAgent);
    h = await openDaemonHarness({ adapters: { claude: agent.adapter } });
    agent.bind(h);
    const ui = await h.ui();
    const { result: project } = await ui.execute({ requestId: rid(), type: 'project.create', payload: { name: 'sample' } });
    const projectId = (project as { projectId: string }).projectId;
    const created = await ui.execute({ requestId: rid(), type: 'ticket.create', payload: { projectId, title: 'Notepad', template: { id: 'vuyro/ai-sdlc' }, priority: 3 } });
    const ticketId = (created.result as { ticketId: string }).ticketId;
    await ui.execute({ requestId: rid(), type: 'ticket.create', payload: { projectId, title: 'Plain' } });

    let board = await ui.request<BoardResult>(RPC_METHODS.board, { projectId });
    expect(board.tickets.map((ticket) => [ticket.title, ticket.priority])).toEqual([
      ['Notepad', 3],
      ['Plain', 0],
    ]);
    expect(board.tickets[0]?.lanes).toMatchObject([{ nodeId: 'brainstorming', lane: 'main', status: 'review' }]);
    expect(Object.keys(board.workflows)).toEqual(['vuyro/ai-sdlc@1']);

    await ui.execute({ requestId: rid(), type: 'ticket.update', payload: { ticketId, priority: -2 } });
    await ui.execute({ requestId: rid(), type: 'node.done', payload: { ticketId, nodeId: 'brainstorming', port: 'done', summary: 'A notepad app' } });
    board = await until(
      () => ui.request<BoardResult>(RPC_METHODS.board, { projectId }),
      (value) => value.tickets[0]?.lanes.some((lane) => lane.nodeId === 'specApproval') === true,
    );
    expect(board.tickets[0]).toMatchObject({ priority: -2, tokens: { input: 1200, cacheRead: 300, output: 450 } });
    expect(board.tickets[1]?.tokens).toEqual({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 });
    // Another project's tickets never show.
    const { result: other } = await ui.execute({ requestId: rid(), type: 'project.create', payload: { name: 'other' } });
    expect((await ui.request<BoardResult>(RPC_METHODS.board, { projectId: (other as { projectId: string }).projectId })).tickets).toEqual([]);
  });

  it("shows a ticket's pinned workflow and what each review asks the person to decide", async () => {
    const agent = lateAdapter(specAgent);
    h = await openDaemonHarness({ adapters: { claude: agent.adapter } });
    agent.bind(h);
    const ui = await h.ui();
    const { result: project } = await ui.execute({ requestId: rid(), type: 'project.create', payload: { name: 'sample' } });
    const projectId = (project as { projectId: string }).projectId;
    const created = await ui.execute({ requestId: rid(), type: 'ticket.create', payload: { projectId, title: 'Notepad', template: { id: 'vuyro/ai-sdlc' } } });
    const ticketId = (created.result as { ticketId: string }).ticketId;

    let detail = await ui.request<TicketDetail>(RPC_METHODS.ticket, { ticketId });
    expect(detail.workflow?.id).toBe('vuyro/ai-sdlc');
    expect(detail.ticket.priority).toBe(0);
    expect(detail.reviews).toEqual([{ nodeId: 'brainstorming', lane: 'main', run: 1, kind: 'task', inputs: [] }]);

    await ui.execute({ requestId: rid(), type: 'node.done', payload: { ticketId, nodeId: 'brainstorming', port: 'done', summary: 'A notepad app' } });
    detail = await until(
      () => ui.request<TicketDetail>(RPC_METHODS.ticket, { ticketId }),
      (value) => value.reviews.some((review) => review.nodeId === 'specApproval'),
    );
    expect(detail.reviews).toEqual([
      {
        nodeId: 'specApproval',
        lane: 'main',
        run: 1,
        kind: 'approval',
        inputs: [{ summary: '<b>Spec</b> written', data: { title: 'Notes', acceptanceCriteria: ['saves'] }, artifacts: { specDoc: { kind: 'file', uri: 'docs/spec.md', version: 'v1' } } }],
      },
    ]);

    // Rejecting sends the spec back; the comment comes with the next spec execution, then the approval waits again.
    await ui.execute({ requestId: rid(), type: 'node.reject', payload: { ticketId, nodeId: 'specApproval', comment: 'Add undo' } });
    detail = await until(
      () => ui.request<TicketDetail>(RPC_METHODS.ticket, { ticketId }),
      (value) => value.reviews.some((review) => review.nodeId === 'specApproval' && review.run === 2),
    );
    expect(detail.reviews).toHaveLength(1);
    await ui.execute({ requestId: rid(), type: 'node.approve', payload: { ticketId, nodeId: 'specApproval' } });
    detail = await until(
      () => ui.request<TicketDetail>(RPC_METHODS.ticket, { ticketId }),
      (value) => value.executions.some((execution) => execution.nodeId === 'plan'),
    );
    expect(detail.executions.filter((execution) => execution.nodeId === 'specApproval').map((execution) => execution.port)).toEqual(['reject', 'approve']);
  });

  it('a review gate shows the held output, and an empty output says so', async () => {
    const agent = lateAdapter(async (session) => {
      await session.vuyro('node.done', { ticketId: session.request.ticketId, nodeId: session.request.nodeId, port: 'done', items: [] });
      return undefined;
    });
    h = await openDaemonHarness({ adapters: { claude: agent.adapter } });
    agent.bind(h);
    await h.saveDefinition({
      vuyro: 'export',
      formatVersion: 1,
      kind: 'template',
      id: 'test/gated',
      version: 1,
      name: 'Gated',
      content: {
        id: 'test/gated',
        version: 1,
        name: 'Gated',
        nodes: [
          { id: 'work', type: 'vuyro.agent', version: 1, review: 'human', params: { instructions: 'Work.' } },
          { id: 'end', type: 'vuyro.end', version: 1 },
        ],
        edges: [{ from: { node: 'work', port: 'done' }, to: { node: 'end', port: 'in' } }],
      },
    });
    const ui = await h.ui();
    const { result: project } = await ui.execute({ requestId: rid(), type: 'project.create', payload: { name: 'sample' } });
    const created = await ui.execute({ requestId: rid(), type: 'ticket.create', payload: { projectId: (project as { projectId: string }).projectId, title: 'Gate', template: { id: 'test/gated' } } });
    const ticketId = (created.result as { ticketId: string }).ticketId;
    const detail = await until(
      () => ui.request<TicketDetail>(RPC_METHODS.ticket, { ticketId }),
      (value) => value.reviews.length > 0,
    );
    expect(detail.reviews).toEqual([{ nodeId: 'work', lane: 'main', run: 1, kind: 'gate', output: { port: 'done', items: [] }, reason: 'empty' }]);
  });
});
