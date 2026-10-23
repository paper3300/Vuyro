export { SqliteWorker, SqliteWorkerError } from './db/sqlite-worker-client.ts';
export type {
  JournalMode,
  SqliteParams,
  SqliteRunResult,
  SqliteStatement,
  SqliteValue,
  SqliteWorkerConfig,
  SynchronousMode,
} from './db/sqlite-worker-protocol.ts';
export { defaultTokenPath, readEngineToken, TOKEN_BYTES, VerifiedEngineToken } from './ipc/engine-token.ts';
// The server starts only through startEnginePipe (the token file is created and verified first).
export { AUTH_PROTOCOL, connectAuthenticatedPipe, startEnginePipe } from './ipc/pipe-auth.ts';
export type {
  AuthenticatedPipeServer,
  AuthenticatedPipeServerOptions,
  AuthStats,
  ConnectOptions,
  EnginePipeOptions,
} from './ipc/pipe-auth.ts';
export {
  allowedTrustees,
  currentUserOnlySddl,
  getCurrentUserSid,
  readFileSecurity,
  restrictFileToCurrentUser,
  setFileDacl,
  Win32Error,
} from './platform/win32/security.ts';
export type { ObjectSecurity } from './platform/win32/security.ts';

// M1: runtime ports, event store, command bus.
export { systemClock, VirtualClock } from './runtime/clock.ts';
export type { Clock, TimerHandle } from './runtime/clock.ts';
export { createUuidV7Generator, cryptoRandom, seededRandom } from './runtime/ids.ts';
export type { IdGenerator, RandomSource } from './runtime/ids.ts';
export { FileSystemError, MemoryFileSystem, nodeFileSystem } from './runtime/fs.ts';
export type { FileSystem, FileSystemOperation } from './runtime/fs.ts';
export { FakeProcessRunner, nodeProcessRunner, readLines } from './runtime/process.ts';
export type { FakeScript, FakeSpawn, FakeStep, ManagedProcess, ProcessExit, ProcessRunner, SpawnSpec } from './runtime/process.ts';
export { DuplicateRequestError, EventStore, RevisionConflictError } from './store/event-store.ts';
export type { Commit, CommitResult, EventStoreOptions, NewEvent, StoredCommand, StreamAppend } from './store/event-store.ts';
export { BUILTIN_PROJECTORS, projectionVersion } from './store/projections.ts';
export type { Projector } from './store/projections.ts';
export { CommandBus } from './commands/command-bus.ts';
export type { CommandBusOptions } from './commands/command-bus.ts';
export { LOCAL_USER_ID } from './commands/caller.ts';
export type { CallerContext, RunBinding, TransportIdentity } from './commands/caller.ts';
export { hashRunToken } from './commands/run-token.ts';
export { HumanCredential } from './commands/human-credential.ts';
export type { HumanCredentialVerifier } from './commands/human-credential.ts';
export { ORPHANED_RUN_REASON, settleOrphanedRuns } from './commands/recovery.ts';

// M2: workflow engine.
export { ActivityTracker } from './runtime/activity.ts';
export { MAX_AUTOMATIC_ATTEMPTS } from './commands/workflow-handlers.ts';
export type { DefinitionState, RunState, TicketState } from './commands/aggregates.ts';
export { compileNodeType, compileWorkflow, DefinitionError } from './workflow/compile.ts';
export type { CompiledEdge, CompiledNode, CompiledNodeType, CompiledPort, CompiledWorkflow, DefinitionIssue } from './workflow/compile.ts';
export { DefinitionLoadError, DefinitionRegistry, definitionHash, definitionPath } from './workflow/definitions.ts';
export type { DefinitionResolver, DefinitionRow, LoadedTemplate } from './workflow/definitions.ts';
export { DefinitionWriter } from './workflow/definition-writer.ts';
export type { DefinitionWriterOptions, ScanReport } from './workflow/definition-writer.ts';
export { BUILTIN_DEFINITIONS_DIR, DEFAULT_TEMPLATE_ID, installBuiltins, loadBuiltinDefinitions } from './workflow/builtins.ts';
export { WorkflowEngine } from './workflow/engine.ts';
export type { WorkflowEngineOptions } from './workflow/engine.ts';
export { ScriptedAgentAdapter } from './workflow/scripted-agent.ts';
export type { ScriptedAgentOptions, ScriptedBehavior, ScriptedSession } from './workflow/scripted-agent.ts';
export { ancestorsOf, executionContext } from './workflow/context.ts';
export { currentExecution, EMPTY_TICKET, evolveTicket, laneStatus, nodeProgress } from './workflow/state.ts';
export type { Execution, Lane, NodeProgress, TicketWorkflow } from './workflow/state.ts';
export { parseDuration } from './workflow/duration.ts';
