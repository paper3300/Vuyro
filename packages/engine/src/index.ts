export { listenSecurePipe } from './ipc/secure-pipe-server.ts';
export type { SecurePipeServer, SecurePipeServerOptions } from './ipc/secure-pipe-server.ts';
export {
  allowedTrustees,
  currentUserOnlySddl,
  getCurrentUserSid,
  getPipeServerUserSid,
  readPipeSecurity,
  setPipeDacl,
  Win32Error,
} from './platform/win32/pipe-security.ts';
export type { CurrentUserOnlyOptions, PipeSecurity } from './platform/win32/pipe-security.ts';
