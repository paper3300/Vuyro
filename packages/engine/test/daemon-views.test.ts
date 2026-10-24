import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentAdapter, AgentStartRequest } from '@vuyro/agent-adapters';
import { type BoardResult, type DefinitionListing, type ExportResult, type ImportPreview, RPC_METHODS, type RunEventsResult, type TemplateSummary } from '@vuyro/contracts';
import type { ProjectRow, TicketDetail } from '../src/daemon/queries.ts';
import { systemClock } from '../src/runtime/clock.ts';
import { type ScriptedBehavior, ScriptedAgentAdapter } from '../src/workflow/scripted-agent.ts';
import { type DaemonHarness, oneAgentTemplate, openDaemonHarness } from './helpers/daemon-harness.ts';
import { enginePaths } from '../src/daemon/paths.ts';
import { ticketKey } from '../src/workspace/layout.ts';

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
  it("an agent of a project without a folder works in its ticket's own empty folder, not where the engine started", async () => {
    const seen: (string | undefined)[] = [];
    const agent = lateAdapter(async (session) => {
      seen.push(session.request.cwd);
      await session.vuyro('node.done', { ticketId: session.request.ticketId, nodeId: session.request.nodeId, port: 'done', summary: 'ok' });
      return undefined;
    });
    h = await openDaemonHarness({ adapters: { claude: agent.adapter } });
    agent.bind(h);
    await h.saveDefinition(oneAgentTemplate());
    const ui = await h.ui();
    const { result: bare } = await ui.execute({ requestId: rid(), type: 'project.create', payload: { name: 'no folder' } });
    const { result: ticket } = await ui.execute({ requestId: rid(), type: 'ticket.create', payload: { projectId: (bare as { projectId: string }).projectId, title: 'Bare', template: { id: 'test/one-agent' } } });
    await until(() => Promise.resolve(seen.length), (count) => count === 1);
    const expected = join(enginePaths(h.dataDir).work, ticketKey((ticket as { ticketId: string }).ticketId));
    expect(seen).toEqual([expected]);
    expect(readdirSync(expected)).toEqual([]);
    // A project with a folder works there.
    const folder = join(h.dataDir, 'project-folder');
    mkdirSync(folder);
    const { result: rooted } = await ui.execute({ requestId: rid(), type: 'project.create', payload: { name: 'with folder' } });
    await ui.execute({ requestId: rid(), type: 'project.configure', payload: { projectId: (rooted as { projectId: string }).projectId, root: folder } });
    await ui.execute({ requestId: rid(), type: 'ticket.create', payload: { projectId: (rooted as { projectId: string }).projectId, title: 'Rooted', template: { id: 'test/one-agent' } } });
    await until(() => Promise.resolve(seen.length), (count) => count === 2);
    expect(seen[1]).toBe(folder);
  });

  it('lists where each project works, in which mode, and whether its folder is a git repository (the app offers worktree mode only then)', async () => {
    h = await openDaemonHarness();
    const ui = await h.ui();
    const create = async (name: string) => ((await ui.execute({ requestId: rid(), type: 'project.create', payload: { name } })).result as { projectId: string }).projectId;
    await create('no folder');
    const rooted = await create('with folder');
    const folder = join(h.dataDir, 'project-folder');
    mkdirSync(folder);
    await ui.execute({ requestId: rid(), type: 'project.configure', payload: { projectId: rooted, root: folder, settings: { workspaceMode: 'shared', onConflict: 'warn' } } });
    const listed = async () => (await ui.request<{ projects: ProjectRow[] }>(RPC_METHODS.projects, {})).projects;
    expect(await listed()).toEqual([
      expect.objectContaining({ name: 'no folder', root: null, baseRef: null, settings: null, rootIsGitRepo: false }),
      expect.objectContaining({ name: 'with folder', root: folder, settings: { workspaceMode: 'shared', onConflict: 'warn' }, rootIsGitRepo: false }),
    ]);
    // An empty .git is not a repository; git decides.
    mkdirSync(join(folder, '.git'));
    expect((await listed())[1]?.rootIsGitRepo).toBe(false);
    rmSync(join(folder, '.git'), { recursive: true });
    execFileSync('git', ['init', '--quiet'], { cwd: folder });
    expect((await listed())[1]?.rootIsGitRepo).toBe(true);
  });

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
    expect(Object.keys(board.workflows)).toEqual(['vuyro/ai-sdlc@2']);

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

  it('refuses a decision on an execution the screen did not see (stale screen), and takes the one it saw', async () => {
    const agent = lateAdapter(specAgent);
    h = await openDaemonHarness({ adapters: { claude: agent.adapter } });
    agent.bind(h);
    const ui = await h.ui();
    const { result: project } = await ui.execute({ requestId: rid(), type: 'project.create', payload: { name: 'sample' } });
    const created = await ui.execute({ requestId: rid(), type: 'ticket.create', payload: { projectId: (project as { projectId: string }).projectId, title: 'Notepad', template: { id: 'vuyro/ai-sdlc' } } });
    const ticketId = (created.result as { ticketId: string }).ticketId;
    // A human task: finishing an execution that is not the one waiting is refused.
    const wrongTask = await ui.execute({ requestId: rid(), type: 'node.done', payload: { ticketId, nodeId: 'brainstorming', run: 2, port: 'done' } }).catch((error: unknown) => error);
    expect(wrongTask).toMatchObject({ data: { code: 'revision_conflict', details: { nodeId: 'brainstorming', lane: 'main', expectedRun: 2, actualRun: 1 } } });
    await ui.execute({ requestId: rid(), type: 'node.done', payload: { ticketId, nodeId: 'brainstorming', run: 1, port: 'done', summary: 'idea' } });
    await until(
      () => ui.request<TicketDetail>(RPC_METHODS.ticket, { ticketId }),
      (value) => value.reviews.some((review) => review.nodeId === 'specApproval'),
    );
    // The screen saw approval run 1 and the person rejected it; the spec ran again and approval run 2 waits.
    await ui.execute({ requestId: rid(), type: 'node.reject', payload: { ticketId, nodeId: 'specApproval', run: 1, comment: 'Add undo' } });
    await until(
      () => ui.request<TicketDetail>(RPC_METHODS.ticket, { ticketId }),
      (value) => value.reviews.some((review) => review.nodeId === 'specApproval' && review.run === 2),
    );
    // A second screen still showing run 1 tries to approve (or reject) it: refused, nothing changes.
    const before = (await ui.request<TicketDetail>(RPC_METHODS.ticket, { ticketId })).ticket.revision;
    for (const type of ['node.approve', 'node.reject', 'node.pause']) {
      const stale = await ui.execute({ requestId: rid(), type, payload: { ticketId, nodeId: 'specApproval', run: 1 } }).catch((error: unknown) => error);
      expect(stale, type).toMatchObject({ data: { code: 'revision_conflict', details: { aggregateId: ticketId, expectedRun: 1, actualRun: 2 } } });
    }
    expect((await ui.request<TicketDetail>(RPC_METHODS.ticket, { ticketId })).ticket.revision).toBe(before);
    // The screen that shows run 2 decides.
    await ui.execute({ requestId: rid(), type: 'node.approve', payload: { ticketId, nodeId: 'specApproval', run: 2 } });
    const detail = await until(
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

  it("pages through an agent run's log: messages, tool calls with their results, usage and the end", async () => {
    const long = 'x'.repeat(5000);
    const agent = lateAdapter(async (session) => {
      session.observe({ kind: 'session', providerSessionId: 'sess-1', model: 'small' });
      session.observe({ kind: 'message', role: 'assistant', messageId: 'm1', text: 'Reading <the> spec' });
      session.observe({ kind: 'toolCallStarted', toolCallId: 't1', name: 'Read', input: { file_path: 'docs/spec.md' } });
      session.observe({ kind: 'toolCallFinished', toolCallId: 't1', output: long });
      session.observe({ kind: 'toolCallStarted', toolCallId: 't2', name: 'Bash', input: { command: 'build' } });
      session.observe({ kind: 'toolCallFinished', toolCallId: 't2', isError: true, output: 'failed' });
      session.observe({ kind: 'warning', message: 'slow down', source: 'rate' });
      return specAgent(session);
    });
    h = await openDaemonHarness({ adapters: { claude: agent.adapter } });
    agent.bind(h);
    const ui = await h.ui();
    const { result: project } = await ui.execute({ requestId: rid(), type: 'project.create', payload: { name: 'sample' } });
    const created = await ui.execute({ requestId: rid(), type: 'ticket.create', payload: { projectId: (project as { projectId: string }).projectId, title: 'Log', template: { id: 'vuyro/ai-sdlc' } } });
    const ticketId = (created.result as { ticketId: string }).ticketId;
    await ui.execute({ requestId: rid(), type: 'node.done', payload: { ticketId, nodeId: 'brainstorming', port: 'done', summary: 'idea' } });
    const detail = await until(
      () => ui.request<TicketDetail>(RPC_METHODS.ticket, { ticketId }),
      (value) => value.runs.some((run) => run.status !== 'running'),
    );
    const runId = String(detail.runs[0]?.runId);

    const all = await ui.request<RunEventsResult>(RPC_METHODS.runEvents, { runId });
    expect(all.run).toMatchObject({ runId, ticketId, nodeId: 'spec', provider: 'claude' });
    expect(all.more).toBe(false);
    expect(all.entries.map((entry) => entry.kind)).toEqual(['started', 'session', 'message', 'toolStarted', 'toolFinished', 'toolStarted', 'toolFinished', 'warning', 'usage', 'settled']);
    expect(all.entries[2]).toMatchObject({ kind: 'message', role: 'assistant', text: { text: 'Reading <the> spec', length: 18 } });
    expect(all.entries[3]).toMatchObject({ kind: 'toolStarted', name: 'Read' });
    expect(all.entries[4]).toMatchObject({ kind: 'toolFinished', isError: false, output: { length: 5000 } });
    expect((all.entries[4] as { output: { text: string } }).output.text).toHaveLength(4000);
    expect(all.entries[6]).toMatchObject({ kind: 'toolFinished', isError: true, output: { text: 'failed' } });

    // Pages continue from the cursor without gaps or repeats.
    const first = await ui.request<RunEventsResult>(RPC_METHODS.runEvents, { runId, limit: 4 });
    expect(first.more).toBe(true);
    const second = await ui.request<RunEventsResult>(RPC_METHODS.runEvents, { runId, after: first.cursor, limit: 100 });
    expect([...first.entries, ...second.entries].map((entry) => entry.revision)).toEqual(all.entries.map((entry) => entry.revision));
    // The last events of a long run, where a screen starts; revisions number the pages.
    const tail = await ui.request<RunEventsResult>(RPC_METHODS.runEvents, { runId, tail: 3 });
    expect(tail.entries.map((entry) => entry.revision)).toEqual(all.entries.slice(-3).map((entry) => entry.revision));
    expect(tail.lastRevision).toBe(all.entries.at(-1)?.revision);
    expect(all.entries.map((entry) => entry.revision)).toEqual(Array.from({ length: all.entries.length }, (_, index) => index + 1));
    // One entry in full.
    const full = await ui.request<RunEventsResult>(RPC_METHODS.runEvents, { runId, after: (all.entries[4]?.revision ?? 1) - 1, limit: 1, textLimit: 1_048_576 });
    expect((full.entries[0] as { output: { text: string } }).output.text).toBe(long);
    await expect(ui.request(RPC_METHODS.runEvents, { runId: '01900000-0000-7000-8000-000000000000' })).rejects.toMatchObject({ data: { code: 'not_found' } });
    await expect(ui.request(RPC_METHODS.runEvents, { runId, limit: 0 })).rejects.toMatchObject({ rpcCode: -32602 });
  });

  it('exports the default template, imports it under a new id, and a ticket of the copy passes the approval gate', async () => {
    const agent = lateAdapter(specAgent);
    h = await openDaemonHarness({ adapters: { claude: agent.adapter } });
    agent.bind(h);
    const ui = await h.ui();
    const listed = await ui.request<{ definitions: DefinitionListing[] }>(RPC_METHODS.definitions, { kind: 'template' });
    // v2 leaves the workspace mode to the project (D-073); v1 stays for the tickets that pinned it.
    expect(listed.definitions).toEqual([
      expect.objectContaining({ kind: 'template', id: 'vuyro/ai-sdlc', version: 1, status: 'active', latest: false }),
      expect.objectContaining({ kind: 'template', id: 'vuyro/ai-sdlc', version: 2, name: 'AI-Native SDLC', status: 'active', latest: true }),
    ]);

    const exported = await ui.request<ExportResult>(RPC_METHODS.exportDefinition, { kind: 'template', id: 'vuyro/ai-sdlc' });
    expect(exported).toMatchObject({ fileName: 'vuyro.ai-sdlc@2.json', redacted: [], document: { kind: 'bundle', id: 'vuyro/ai-sdlc' } });
    const text = JSON.stringify(exported.document, null, 2);
    const key = 'template:vuyro/ai-sdlc@2';
    const plan = await ui.request<ImportPreview>(RPC_METHODS.importPreview, { text, choices: { [key]: { action: 'newId', id: 'myteam/ai-sdlc', name: 'AI-Native SDLC (copy)' } } });
    expect(plan.canSave).toBe(true);
    const items = plan.saves.map((save) => ({ definition: save.definition, ...(save.expect === undefined ? {} : { expect: save.expect }) }));
    await ui.execute({ requestId: rid(), type: 'definition.import', payload: { items } });
    await until(
      () => ui.request<{ definitions: DefinitionListing[] }>(RPC_METHODS.definitions, { kind: 'template' }),
      (value) => value.definitions.some((each) => each.id === 'myteam/ai-sdlc' && each.status === 'active'),
    );

    const { result: project } = await ui.execute({ requestId: rid(), type: 'project.create', payload: { name: 'sample' } });
    const created = await ui.execute({ requestId: rid(), type: 'ticket.create', payload: { projectId: (project as { projectId: string }).projectId, title: 'Copied', template: { id: 'myteam/ai-sdlc' } } });
    const ticketId = (created.result as { ticketId: string }).ticketId;
    await ui.execute({ requestId: rid(), type: 'node.done', payload: { ticketId, nodeId: 'brainstorming', run: 1, port: 'done', summary: 'idea' } });
    await until(
      () => ui.request<TicketDetail>(RPC_METHODS.ticket, { ticketId }),
      (value) => value.reviews.some((review) => review.nodeId === 'specApproval'),
    );
    await ui.execute({ requestId: rid(), type: 'node.approve', payload: { ticketId, nodeId: 'specApproval', run: 1 } });
    const detail = await until(
      () => ui.request<TicketDetail>(RPC_METHODS.ticket, { ticketId }),
      (value) => value.executions.some((execution) => execution.nodeId === 'plan'),
    );
    expect(detail.workflow).toMatchObject({ id: 'myteam/ai-sdlc', name: 'AI-Native SDLC (copy)' });

    // Previews are reads: an unverified client may look, never save; and the text is checked as untrusted.
    const reader = await h.connect();
    expect((await reader.request<ImportPreview>(RPC_METHODS.importPreview, { text: '[]' })).readable).toBe(false);
    await expect(reader.execute({ requestId: rid(), type: 'definition.import', payload: { items } })).rejects.toMatchObject({ data: { code: 'forbidden' } });
    await expect(ui.request(RPC_METHODS.importPreview, { text: 'x'.repeat(4 * 1024 * 1024 + 1) })).rejects.toMatchObject({ rpcCode: -32602 });
    await expect(ui.request(RPC_METHODS.exportDefinition, { kind: 'template', id: 'myteam/none' })).rejects.toMatchObject({ data: { code: 'not_found' } });
  });
});
