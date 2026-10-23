/**
 * Writes through the command bus until the writer worker kills the process at a fixed point.
 * Used by crash-recovery.test.ts: `node crash-writer.ts <db path> <event insert to crash after>`.
 *
 * Setup writes 3 events (project, ticket, run); then each `run.observe` command writes 5 message events
 * in one transaction, one command at a time. Prints the number of acknowledged observe commands.
 */
import { CommandBus } from '../../src/commands/command-bus.ts';
import type { TransportIdentity } from '../../src/commands/caller.ts';
import { systemClock } from '../../src/runtime/clock.ts';
import { createUuidV7Generator } from '../../src/runtime/ids.ts';
import { EventStore } from '../../src/store/event-store.ts';

const [path, crashAfter] = process.argv.slice(2);
if (path === undefined || crashAfter === undefined) throw new Error('usage: crash-writer.ts <db path> <event insert number>');

const ids = createUuidV7Generator({ clock: systemClock });
const store = await EventStore.open({
  path,
  clock: systemClock,
  ids,
  writerTestCrash: { afterStatement: 'INSERT INTO events', occurrence: Number(crashAfter) },
});
const bus = new CommandBus({ store, ids });
const engine: TransportIdentity = { kind: 'internal', component: 'crash-test' };
const human: TransportIdentity = { kind: 'ui-session' };

async function must(type: string, payload: unknown, transport: TransportIdentity): Promise<Record<string, string>> {
  const response = await bus.execute({ requestId: `setup-${type}-${ids.next()}`, type, payload }, transport);
  if (!response.ok) throw new Error(JSON.stringify(response.error));
  return response.result as Record<string, string>;
}

const { projectId } = await must('project.create', { name: 'crash' }, human);
const { ticketId } = await must('ticket.create', { projectId, title: 'crash test' }, human);
const { runId } = await must('run.start', { ticketId, nodeId: 'dev', provider: 'codex' }, engine);

const messages = Array.from({ length: 5 }, (_, n) => ({ kind: 'message', role: 'assistant', text: `line ${n}` }));
for (let acknowledged = 1; ; acknowledged++) {
  const result = await bus.execute({ requestId: `observe-${ids.next()}`, type: 'run.observe', payload: { runId, observations: messages } }, engine);
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  process.stdout.write(`${acknowledged}\n`);
}
