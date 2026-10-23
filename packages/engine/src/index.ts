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
