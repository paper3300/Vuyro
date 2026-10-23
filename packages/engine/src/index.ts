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
export { createEngineToken, defaultTokenPath, readEngineToken, TOKEN_BYTES } from './ipc/engine-token.ts';
export type { EngineToken } from './ipc/engine-token.ts';
export { AUTH_PROTOCOL, connectAuthenticatedPipe, listenAuthenticatedPipe } from './ipc/pipe-auth.ts';
export type { AuthenticatedPipeServer, AuthenticatedPipeServerOptions, AuthStats, ConnectOptions } from './ipc/pipe-auth.ts';
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
