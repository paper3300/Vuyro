/**
 * Child processes live in @vuyro/agent-adapters (the adapters spawn agent CLIs through them);
 * the engine re-exports them so scripts and tests keep one import path.
 */
export { FakeProcessRunner, nodeProcessRunner, readLines } from '@vuyro/agent-adapters';
export type { FakeProcessContext, FakeScript, FakeSpawn, FakeStep, ManagedProcess, ProcessExit, ProcessRunner, SpawnSpec } from '@vuyro/agent-adapters';
