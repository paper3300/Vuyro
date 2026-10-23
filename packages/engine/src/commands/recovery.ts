import type { EventStore } from '../store/event-store.ts';
import type { CommandBus } from './command-bus.ts';

export const ORPHANED_RUN_REASON = 'engine_restarted';

/**
 * Settles every run still marked running when the engine starts. Agent processes do not survive
 * the engine, and `run.start` never stores its token, so such a run can never finish on its own:
 * either its process died with the engine, or the engine died between `run.start` and spawning it.
 *
 * Each run is settled as `abnormal_exit` with terminal reason 'engine_restarted', which revokes its
 * token. The workflow (M2/M3) then starts a new run for the node, resuming the provider session
 * with `resumedFromRunId` when one was recorded. Request ids are derived from the run id, so running
 * the recovery again after a crash in the middle is a no-op for the runs already settled.
 */
export async function settleOrphanedRuns(bus: CommandBus, store: EventStore): Promise<string[]> {
  const rows = await store.query<{ run_id: string }>("SELECT run_id FROM p_runs WHERE status = 'running' ORDER BY started_at");
  const settled: string[] = [];
  for (const { run_id: runId } of rows) {
    const response = await bus.execute(
      {
        requestId: `recover-settle-${runId}`,
        type: 'run.settle',
        payload: {
          runId,
          outcome: 'abnormal_exit',
          terminalReason: ORPHANED_RUN_REASON,
          error: 'the engine restarted while this run was active',
        },
      },
      { kind: 'internal', component: 'recovery' },
    );
    if (!response.ok) throw new Error(`could not settle orphaned run ${runId}: ${response.error.message}`);
    settled.push(runId);
  }
  return settled;
}
