import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect } from 'vitest';
import { type SharedNodeSpec, sharedNodeAggregateId } from '@vuyro/contracts';
import type { FakeProcessContext, FakeStep } from '../../src/runtime/process.ts';
import { EMPTY_SHARED_NODE, evolveSharedNode, type SharedNodeState } from '../../src/shared/state.ts';
import type { ScriptedBehavior, ScriptedSession } from '../../src/workflow/scripted-agent.ts';
import { edge, expectOk, MINUTE, save, template } from './workspace-fixtures.ts';
import type { WorkflowHarness } from './workflow-harness.ts';

/** Shared pieces of the M5 shared node tests: the build flow template, the build shared node, fake builds. */

export { MINUTE };

/**
 * task (person) → dev (agent) → build (request for the shared node 'build') → end. A failed build goes back to dev:
 * the blamed ticket's developer fixes it and the request queues again.
 */
export async function saveBuildFlow(h: WorkflowHarness, sharedNode = 'build'): Promise<void> {
  await save(
    h,
    template(
      'myteam/build-flow',
      [
        { id: 'task', type: 'vuyro.human-task', version: 1 },
        { id: 'dev', type: 'vuyro.agent', version: 1, params: { instructions: 'Change the code.' } },
        { id: 'build', type: 'vuyro.shared-request', version: 1, params: { sharedNode } },
        { id: 'end', type: 'vuyro.end', version: 1 },
      ],
      [edge('task', 'done', 'dev'), edge('dev', 'done', 'build'), edge('build', 'done', 'end'), edge('build', 'error', 'dev')],
    ),
  );
}

export function buildSpec(overrides: Partial<SharedNodeSpec> = {}): SharedNodeSpec {
  return {
    name: 'build',
    label: 'Build station',
    node: { type: 'vuyro.script', version: 1, params: { program: 'build-tool', args: ['all'] } },
    batchTrigger: { count: 3 },
    maxConcurrent: 1,
    protect: [{ path: 'src/**', mode: 'shared' }],
    onBatchFailure: 'blame',
    ...overrides,
  };
}

export async function defineShared(h: WorkflowHarness, projectId: string, spec: SharedNodeSpec = buildSpec()): Promise<{ version: number; warnings: string[] }> {
  const response = await h.exec('sharedNode.define', { projectId, spec });
  expectOk(response);
  return (response as { result: { version: number; warnings: string[] } }).result;
}

export async function sharedState(h: WorkflowHarness, projectId: string, name = 'build'): Promise<SharedNodeState> {
  let state = EMPTY_SHARED_NODE;
  for (const event of await h.store.readAggregate(sharedNodeAggregateId(projectId, name))) state = evolveSharedNode(state, event);
  return state;
}

/** A project folder with one source file per ticket. */
export function sourceFolder(dir: string, files: readonly string[]): string {
  mkdirSync(join(dir, 'src'), { recursive: true });
  for (const file of files) writeFileSync(join(dir, file), `// ${file}\n`);
  return dir;
}

/** The fake build: steps of one batch (matched by program name, in order). */
export function enqueueBuild(h: WorkflowHarness, steps: FakeStep[], program = 'build-tool'): void {
  h.processes.enqueue({ match: (spec) => spec.command === program, steps });
}

/** A build that takes five minutes and fails with these error lines (on stderr). */
export const buildFails = (...lines: string[]): FakeStep[] => [{ delayMs: 5 * MINUTE, stdout: 'Building...' }, ...lines.map((line) => ({ stderr: line })), { exit: 1 }];
/** A build that takes five minutes and passes. */
export const buildPasses = (...steps: FakeStep[]): FakeStep[] => [{ delayMs: 5 * MINUTE, stdout: 'Building...' }, ...steps, { stdout: 'Build succeeded.' }, { exit: 0 }];

/** Runs code inside the fake build while it runs (e.g. look at the ledger mid-batch). */
export const during = (run: (process: FakeProcessContext) => Promise<void> | void): FakeStep => ({ run });

export type DevStep = (s: ScriptedSession, title: string) => Promise<void>;

/**
 * Dev agents keyed by ticket title, one step per run of the dev node (the last one repeats). Each step usually checks
 * a file out (the hook) and writes it, then reports done.
 */
export function devAgents(h: WorkflowHarness, steps: Record<string, DevStep[]>): ScriptedBehavior {
  const runs = new Map<string, number>();
  return async (s) => {
    const title = (await h.ticket(s.request.ticketId)).title;
    const key = `${title}/${s.request.nodeId}`;
    const index = runs.get(key) ?? 0;
    runs.set(key, index + 1);
    const step = steps[title]?.[index] ?? steps[title]?.at(-1);
    if (step === undefined) throw new Error(`no dev step for '${title}' run ${index + 1}`);
    await step(s, title);
    return s.cancelled ? { outcome: 'cancelled' } : undefined;
  };
}

/** The usual dev run: check the file out through the hook, change it, report done. */
export function edits(file: string, text = 'changed'): DevStep {
  return async (s) => {
    const checkout = await s.vuyro('checkout.acquire', { ticketId: s.request.ticketId, nodeId: s.request.nodeId, paths: [join(s.request.cwd ?? '', file)], source: 'hook' });
    expectOk(checkout);
    expect((checkout as { result: { granted: boolean } }).result.granted).toBe(true);
    writeFileSync(join(s.request.cwd ?? '', file), `// ${text}\n`);
    await s.sleep(MINUTE);
    expectOk(await s.vuyro('node.done', { ticketId: s.request.ticketId, nodeId: s.request.nodeId, port: 'done', data: { changed: file } }));
  };
}

/** Creates a ticket of the build flow and finishes its person task, so its dev starts. */
export async function startTicket(h: WorkflowHarness, projectId: string, title: string, extra: Record<string, unknown> = {}): Promise<string> {
  const { ticketId } = (await h.ok('ticket.create', { projectId, title, template: { id: 'myteam/build-flow' }, ...extra })).result as { ticketId: string };
  await h.ok('node.done', { ticketId, nodeId: 'task', port: 'done', data: { what: title } });
  return ticketId;
}
