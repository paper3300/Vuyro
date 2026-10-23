/**
 * Writes through the command bus as fast as it can until it is killed.
 * Used by crash-recovery.test.ts: `node crash-writer.ts <db path>`.
 * Prints the number of acknowledged commands after each one.
 */
import { CommandBus } from '../../src/commands/command-bus.ts';
import type { TransportIdentity } from '../../src/commands/caller.ts';
import { systemClock } from '../../src/runtime/clock.ts';
import { createUuidV7Generator } from '../../src/runtime/ids.ts';
import { EventStore } from '../../src/store/event-store.ts';

const path = process.argv[2];
if (path === undefined) throw new Error('usage: crash-writer.ts <db path>');

const ids = createUuidV7Generator({ clock: systemClock });
const store = await EventStore.open({ path, clock: systemClock, ids });
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
let acknowledged = 0;
for (;;) {
  // Two commands in flight at once, so the bus queue and group commit are both exercised.
  const results = await Promise.all([
    bus.execute({ requestId: `observe-${ids.next()}`, type: 'run.observe', payload: { runId, observations: messages } }, engine),
    bus.execute({ requestId: `rename-${ids.next()}`, type: 'ticket.update', payload: { ticketId, title: `t${acknowledged}` } }, human),
  ]);
  for (const result of results) if (!result.ok) throw new Error(JSON.stringify(result.error));
  acknowledged += results.length;
  process.stdout.write(`${acknowledged}\n`);
}
