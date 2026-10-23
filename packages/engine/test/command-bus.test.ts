import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CommandFailure, CommandResponse } from '@vuyro/contracts';
import {
  CLI,
  type Harness,
  HUMAN,
  MCP,
  nextRequestId,
  openHarness,
  seedTicket,
  startRun,
  SYSTEM,
  tempDir,
} from './helpers/engine-harness.ts';

function expectFailure(response: CommandResponse, code: CommandFailure['error']['code']): CommandFailure {
  if (response.ok) throw new Error(`expected ${code}, got success`);
  expect(response.error.code).toBe(code);
  return response;
}

const REF = { kind: 'git', uri: 'repo:src/editor.ts', version: 'abc1234' };
const RULE = { subject: 'node.agent', scope: 'app', action: 'node.approve', target: '*', effect: 'allow' };

describe('CommandBus', () => {
  let temp: ReturnType<typeof tempDir>;
  let h: Harness;

  beforeEach(async () => {
    temp = tempDir('vuyro-bus-');
    h = await openHarness(join(temp.dir, 'engine.db'));
  });

  afterEach(async () => {
    await h.close();
    temp.dispose();
  });

  describe('command → event → projection', () => {
    it('creates a ticket, records who did it, and reports the event range and revision', async () => {
      const { projectId, ticketId } = await seedTicket(h);
      const rows = await h.store.query('SELECT ticket_id, project_id, title, revision FROM p_tickets');
      expect(rows).toEqual([{ ticket_id: ticketId, project_id: projectId, title: 'Add a notepad', revision: 1 }]);
      const [event] = await h.store.readAggregate(ticketId);
      expect(event).toMatchObject({
        type: 'ticket.created',
        actor: { kind: 'human', userId: 'local', via: 'ui' },
        authorization: { decision: 'allow', rule: 'builtin:human' },
      });

      const update = await h.ok('ticket.update', { ticketId, title: 'Notepad v1' }, HUMAN, { expectedRevision: 1 });
      expect(update).toMatchObject({ ok: true, revision: 2, events: { firstSequence: 3, lastSequence: 3, count: 1 }, replayed: false });
      expect(await h.store.query('SELECT title, revision FROM p_tickets')).toEqual([{ title: 'Notepad v1', revision: 2 }]);
    });

    it('records run observations and folds tokens per provider rule', async () => {
      const { ticketId } = await seedTicket(h);
      const claude = await startRun(h, ticketId, 'spec');
      await h.ok(
        'run.observe',
        {
          runId: claude.runId,
          observations: [
            { kind: 'session', providerSessionId: 'session-1', model: 'claude-haiku-5-5' },
            { kind: 'message', role: 'assistant', messageId: 'msg_1', text: 'Reading input.txt' },
            { kind: 'toolCallStarted', toolCallId: 'toolu_1', name: 'Read', input: { file_path: 'input.txt' } },
            { kind: 'toolCallFinished', toolCallId: 'toolu_1', isError: true, output: 'File does not exist.' },
            { kind: 'usage', scope: 'run', tokens: { input: 10, cacheRead: 200, cacheWrite: 50, output: 217 }, cost: { usd: 0.0012, basis: 'list' } },
            { kind: 'raw', stream: 'stdout', providerType: 'rate_limit_event', raw: { type: 'rate_limit_event' } },
          ],
        },
        SYSTEM,
      );
      await h.ok('run.settle', { runId: claude.runId, outcome: 'succeeded', exitCode: 0, terminalReason: 'completed' }, SYSTEM);

      const ticket = await h.ok('ticket.create', { projectId: (await h.store.query<{ project_id: string }>('SELECT project_id FROM p_tickets'))[0]?.project_id, title: 'second' });
      const codex = await h.ok('run.start', { ticketId: (ticket.result as { ticketId: string }).ticketId, nodeId: 'dev', provider: 'codex' }, SYSTEM);
      const codexRun = (codex.result as { runId: string }).runId;
      for (const turn of [100, 300]) {
        await h.ok(
          'run.observe',
          { runId: codexRun, observations: [{ kind: 'usage', scope: 'turn', tokens: { input: turn, cacheRead: 5, cacheWrite: 0, output: 7, reasoning: 3 } }] },
          SYSTEM,
        );
      }
      await h.ok('run.observe', { runId: codexRun, observations: [{ kind: 'warning', message: 'hook trust bypassed', source: 'item.error' }] }, SYSTEM);

      const runs = await h.store.query(
        `SELECT provider, status, provider_session_id, messages, tool_calls, tool_errors, warnings, tokens_input, tokens_cache_read,
                tokens_cache_write, tokens_output, tokens_reasoning, cost_usd, cost_basis, exit_code FROM p_runs ORDER BY started_at, provider`,
      );
      expect(runs).toEqual([
        {
          provider: 'claude', status: 'succeeded', provider_session_id: 'session-1', messages: 1, tool_calls: 1, tool_errors: 1, warnings: 0,
          tokens_input: 10, tokens_cache_read: 200, tokens_cache_write: 50, tokens_output: 217, tokens_reasoning: 0, cost_usd: 0.0012, cost_basis: 'list', exit_code: 0,
        },
        {
          provider: 'codex', status: 'running', provider_session_id: null, messages: 0, tool_calls: 0, tool_errors: 0, warnings: 1,
          tokens_input: 400, tokens_cache_read: 10, tokens_cache_write: 0, tokens_output: 14, tokens_reasoning: 6, cost_usd: null, cost_basis: null, exit_code: null,
        },
      ]);
    });

    it('refuses to observe or settle a settled run, and resumes only a settled run of the same node', async () => {
      const { ticketId } = await seedTicket(h);
      const run = await startRun(h, ticketId, 'spec');
      const running = await h.exec('run.start', { ticketId, nodeId: 'spec', provider: 'claude', resumedFromRunId: run.runId }, SYSTEM);
      expectFailure(running, 'invariant_violated');
      await h.ok('run.settle', { runId: run.runId, outcome: 'failed', exitCode: 1, terminalReason: 'api_error' }, SYSTEM);
      expectFailure(await h.exec('run.observe', { runId: run.runId, observations: [{ kind: 'message', role: 'assistant', text: 'late' }] }, SYSTEM), 'invariant_violated');
      expectFailure(await h.exec('run.settle', { runId: run.runId, outcome: 'succeeded' }, SYSTEM), 'invariant_violated');
      expectFailure(await h.exec('run.start', { ticketId, nodeId: 'dev', provider: 'claude', resumedFromRunId: run.runId }, SYSTEM), 'invariant_violated');
      const resumed = await h.ok('run.start', { ticketId, nodeId: 'spec', provider: 'claude', resumedFromRunId: run.runId }, SYSTEM);
      const rows = await h.store.query('SELECT resumed_from_run_id FROM p_runs WHERE run_id = ?', [(resumed.result as { runId: string }).runId]);
      expect(rows).toEqual([{ resumed_from_run_id: run.runId }]);
    });

    it('treats an id of another aggregate type as not found', async () => {
      const { ticketId } = await seedTicket(h);
      const run = await startRun(h, ticketId, 'spec');
      expectFailure(await h.exec('ticket.update', { ticketId: run.runId, title: 'x' }), 'not_found');
      expectFailure(await h.exec('ticket.create', { projectId: ticketId, title: 'x' }), 'not_found');
    });
  });

  describe('envelope and payload checks', () => {
    it('rejects bad envelopes, unknown commands, unknown versions and bad payloads', async () => {
      const bad = await h.bus.execute({ requestId: 'x', type: 'ticket.create', payload: {} }, HUMAN);
      expect(expectFailure(bad, 'validation_failed').error.details?.issues).toBeDefined();
      expectFailure(await h.bus.execute({ requestId: nextRequestId(), type: 'ticket.explode', payload: {} }, HUMAN), 'unknown_command');
      expectFailure(await h.exec('project.create', { name: 'x' }, HUMAN, { schemaVersion: 2 }), 'unsupported_schema_version');
      const payload = expectFailure(await h.exec('project.create', { name: '', color: 'red' }), 'validation_failed');
      expect(payload.error.details?.issues).toHaveLength(2);
      expect(await h.store.lastSequence()).toBe(0);
    });
  });

  describe('expected revision', () => {
    it('reports a conflict with the actual revision and writes nothing', async () => {
      const { ticketId } = await seedTicket(h);
      await h.ok('ticket.update', { ticketId, title: 'B' }, HUMAN, { expectedRevision: 1 });
      const before = await h.store.lastSequence();
      const stale = expectFailure(await h.exec('ticket.update', { ticketId, title: 'C' }, HUMAN, { expectedRevision: 1 }), 'revision_conflict');
      expect(stale.error).toMatchObject({ retryable: true, details: { aggregateId: ticketId, expectedRevision: 1, actualRevision: 2 } });
      expectFailure(await h.exec('project.create', { name: 'p' }, HUMAN, { expectedRevision: 3 }), 'revision_conflict');
      expect(await h.store.lastSequence()).toBe(before);
      await h.ok('project.create', { name: 'p' }, HUMAN, { expectedRevision: 0 });
    });
  });

  describe('idempotency', () => {
    it('returns the first result for a retried request without writing again', async () => {
      const request = { requestId: nextRequestId(), type: 'project.create', payload: { name: 'sample' } };
      const first = await h.bus.execute(request, HUMAN);
      const again = await h.bus.execute(request, HUMAN);
      expect(first.ok && again.ok).toBe(true);
      expect(again).toEqual({ ...first, replayed: true });
      expect(await h.store.lastSequence()).toBe(1);
    });

    it('rejects the same request id for a different command or caller', async () => {
      const requestId = nextRequestId();
      await h.bus.execute({ requestId, type: 'project.create', payload: { name: 'a' } }, HUMAN);
      expectFailure(await h.bus.execute({ requestId, type: 'project.create', payload: { name: 'b' } }, HUMAN), 'idempotency_conflict');
      expectFailure(await h.bus.execute({ requestId, type: 'project.create', payload: { name: 'a' } }, CLI), 'idempotency_conflict');
      expect(await h.store.lastSequence()).toBe(1);
    });

    it('survives a restart: a retry after reopening is still a replay', async () => {
      const request = { requestId: nextRequestId(), type: 'project.create', payload: { name: 'sample' } };
      const first = await h.bus.execute(request, HUMAN);
      await h.reopen();
      expect(await h.bus.execute(request, HUMAN)).toEqual({ ...first, replayed: true });
    });

    it('does not record failed commands, so a corrected retry can reuse the id', async () => {
      const { ticketId } = await seedTicket(h);
      const requestId = nextRequestId();
      expectFailure(await h.bus.execute({ requestId, type: 'ticket.update', expectedRevision: 5, payload: { ticketId, title: 'x' } }, HUMAN), 'revision_conflict');
      const retry = await h.bus.execute({ requestId, type: 'ticket.update', expectedRevision: 1, payload: { ticketId, title: 'x' } }, HUMAN);
      expect(retry.ok).toBe(true);
    });

    it('never stores the run token: a replayed run.start returns the run id only', async () => {
      const { ticketId } = await seedTicket(h);
      const request = { requestId: nextRequestId(), type: 'run.start', payload: { ticketId, nodeId: 'spec', provider: 'claude' } };
      const first = await h.bus.execute(request, SYSTEM);
      const again = await h.bus.execute(request, SYSTEM);
      if (!first.ok || !again.ok) throw new Error('run.start failed');
      const { runId, runToken } = first.result as { runId: string; runToken: string };
      expect(runToken).toMatch(/^vrt_/);
      expect(again.result).toEqual({ runId });
      const stored = await h.store.query<{ response: string }>('SELECT response FROM commands');
      const events = await h.store.query<{ data: string }>('SELECT data FROM events');
      for (const text of [...stored.map((row) => row.response), ...events.map((row) => row.data)]) expect(text).not.toContain(runToken);
    });
  });

  describe('run token scope', () => {
    let ticketId: string;
    let otherTicketId: string;
    let dev: { runId: string; runToken: string };

    beforeEach(async () => {
      ({ ticketId } = await seedTicket(h));
      ({ ticketId: otherTicketId } = await seedTicket(h));
      dev = await startRun(h, ticketId, 'dev');
    });

    const asAgent = (token: string, type: string, payload: unknown, extra: Record<string, unknown> = {}) =>
      h.exec(type, payload, CLI, { auth: { runToken: token }, ...extra });

    it('lets a node agent register an artifact on its own node, recorded as the agent', async () => {
      const response = await asAgent(dev.runToken, 'artifact.add', { ticketId, nodeId: 'dev', slot: 'change', ref: REF });
      expect(response.ok).toBe(true);
      const events = await h.store.readAggregate(ticketId);
      expect(events.at(-1)).toMatchObject({
        type: 'artifact.added',
        actor: { kind: 'agent', role: 'node.agent', runId: dev.runId, ticketId, nodeId: 'dev', provider: 'claude' },
        authorization: { rule: 'builtin:node-agent-own-node' },
        data: { runId: dev.runId, slot: 'change' },
      });
      expect(await h.store.query('SELECT node_id, slot, kind, uri, version, run_id FROM p_artifacts')).toEqual([
        { node_id: 'dev', slot: 'change', kind: 'git', uri: REF.uri, version: REF.version, run_id: dev.runId },
      ]);
    });

    it('refuses other nodes, other tickets and mismatched declared context', async () => {
      expectFailure(await asAgent(dev.runToken, 'artifact.add', { ticketId, nodeId: 'qa', slot: 'report', ref: REF }), 'out_of_scope');
      expectFailure(await asAgent(dev.runToken, 'artifact.add', { ticketId: otherTicketId, nodeId: 'dev', slot: 'change', ref: REF }), 'out_of_scope');
      expectFailure(
        await asAgent(dev.runToken, 'artifact.add', { ticketId, nodeId: 'dev', slot: 'change', ref: REF }, { context: { nodeId: 'qa' } }),
        'out_of_scope',
      );
      expectFailure(
        await asAgent(dev.runToken, 'artifact.add', { ticketId, nodeId: 'dev', slot: 'change', ref: REF }, { context: { ticketId: otherTicketId } }),
        'out_of_scope',
      );
      expect(await h.store.query('SELECT COUNT(*) AS n FROM p_artifacts')).toEqual([{ n: 0 }]);
    });

    it('refuses commands that are not open to node agents', async () => {
      expectFailure(await asAgent(dev.runToken, 'ticket.update', { ticketId, title: 'hijack' }), 'forbidden');
      expectFailure(await asAgent(dev.runToken, 'ticket.create', { projectId: ticketId, title: 'x' }), 'forbidden');
      expectFailure(await asAgent(dev.runToken, 'run.observe', { runId: dev.runId, observations: [{ kind: 'message', role: 'assistant', text: 'x' }] }), 'forbidden');
      expectFailure(await asAgent(dev.runToken, 'run.settle', { runId: dev.runId, outcome: 'succeeded' }), 'forbidden');
      expectFailure(await asAgent(dev.runToken, 'run.start', { ticketId, nodeId: 'dev', provider: 'claude' }), 'forbidden');
    });

    it('records every refusal as an audit event', async () => {
      await asAgent(dev.runToken, 'artifact.add', { ticketId, nodeId: 'qa', slot: 'report', ref: REF });
      await asAgent(dev.runToken, 'ticket.update', { ticketId, title: 'hijack' });
      const denials = await h.store.query('SELECT command_type, code, actor_kind, ticket_id, node_id FROM p_command_denials ORDER BY sequence');
      expect(denials).toEqual([
        { command_type: 'artifact.add', code: 'out_of_scope', actor_kind: 'agent', ticket_id: ticketId, node_id: 'qa' },
        { command_type: 'ticket.update', code: 'forbidden', actor_kind: 'agent', ticket_id: ticketId, node_id: null },
      ]);
    });

    it('rejects malformed, unknown and revoked tokens instead of falling back to a wider caller', async () => {
      const payload = { ticketId, nodeId: 'dev', slot: 'change', ref: REF };
      // Malformed tokens are refused before any lookup.
      expect(expectFailure(await asAgent('not-a-token', 'artifact.add', payload), 'unauthenticated').error.message).toBe('malformed run token');
      expectFailure(await asAgent(`vrt_${'A'.repeat(43)}`, 'artifact.add', payload), 'unauthenticated');
      await h.ok('run.settle', { runId: dev.runId, outcome: 'succeeded', exitCode: 0 }, SYSTEM);
      expectFailure(await asAgent(dev.runToken, 'artifact.add', payload), 'unauthenticated');
    });

    it('narrows even a UI connection that presents a run token, and ignores tokens from in-process callers', async () => {
      const viaUi = await h.exec('ticket.update', { ticketId, title: 'x' }, HUMAN, { auth: { runToken: dev.runToken } });
      expectFailure(viaUi, 'forbidden');
      const internal = await h.exec('ticket.update', { ticketId, title: 'x' }, SYSTEM, { auth: { runToken: dev.runToken } });
      expectFailure(internal, 'unauthenticated');
    });

    it('keeps a retried artifact.add idempotent for the same run', async () => {
      const request = {
        requestId: nextRequestId(),
        type: 'artifact.add',
        auth: { runToken: dev.runToken },
        payload: { ticketId, nodeId: 'dev', slot: 'change', ref: REF },
      };
      await h.bus.execute(request, CLI);
      const again = await h.bus.execute(request, CLI);
      expect(again).toMatchObject({ ok: true, replayed: true });
      expect(await h.store.query('SELECT COUNT(*) AS n FROM p_artifacts')).toEqual([{ n: 1 }]);
    });
  });

  describe('permission.edit fixed rule', () => {
    const edit = { scope: 'app', rules: [RULE] };

    it('allows the human', async () => {
      const response = await h.ok('permission.edit', edit, HUMAN);
      expect(response.revision).toBe(1);
      expect(await h.store.query('SELECT scope_key, position FROM p_permission_rules')).toEqual([{ scope_key: 'app', position: 0 }]);
    });

    it('always refuses AI principals and the engine itself', async () => {
      const { ticketId } = await seedTicket(h);
      const run = await startRun(h, ticketId, 'spec');
      const attempts: [string, CommandResponse][] = [
        ['node agent', await h.exec('permission.edit', edit, CLI, { auth: { runToken: run.runToken } })],
        ['node agent via UI transport', await h.exec('permission.edit', edit, HUMAN, { auth: { runToken: run.runToken } })],
        ['unverified CLI', await h.exec('permission.edit', edit, CLI)],
        ['external MCP', await h.exec('permission.edit', edit, MCP)],
        ['engine', await h.exec('permission.edit', edit, SYSTEM)],
      ];
      for (const [who, response] of attempts) {
        expect(response.ok, who).toBe(false);
        if (!response.ok) expect(response.error.code, who).toBe('forbidden');
      }
      expect(await h.store.query('SELECT COUNT(*) AS n FROM p_permission_rules')).toEqual([{ n: 0 }]);
      const denials = await h.store.query<{ actor_kind: string }>("SELECT actor_kind FROM p_command_denials WHERE command_type = 'permission.edit'");
      expect(denials.map((row) => row.actor_kind)).toEqual(['agent', 'agent', 'unverified', 'agent', 'system']);
    });

    it('requires an existing project for project rules', async () => {
      expectFailure(await h.exec('permission.edit', { scope: 'project', projectId: '0192f3a0-0000-7000-8000-000000000999', rules: [] }), 'not_found');
    });
  });

  describe('other principals', () => {
    it('lets an unverified local client do ordinary work but not engine-only work', async () => {
      const project = await h.ok('project.create', { name: 'from terminal' }, CLI);
      const [event] = await h.store.readAggregate((project.result as { projectId: string }).projectId);
      expect(event?.actor).toEqual({ kind: 'unverified', client: 'cli' });
      const { ticketId } = await seedTicket(h);
      expectFailure(await h.exec('run.start', { ticketId, nodeId: 'dev', provider: 'claude' }, CLI), 'forbidden');
      expectFailure(await h.exec('run.start', { ticketId, nodeId: 'dev', provider: 'claude' }, HUMAN), 'forbidden');
    });

    it('keeps external MCP clients read-only', async () => {
      expectFailure(await h.exec('project.create', { name: 'x' }, MCP), 'forbidden');
    });
  });
});
