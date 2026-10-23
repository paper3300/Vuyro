import {
  ERROR_SHARING_VIOLATION,
  FILE_ATTRIBUTE_NORMAL,
  GENERIC_READ,
  GENERIC_WRITE,
  type Handle,
  INVALID_HANDLE_VALUE,
  JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS,
  JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
  OPEN_ALWAYS,
  win32,
} from './ffi.ts';
import { Win32Error } from './security.ts';

/**
 * Process lifetime guards of the engine daemon.
 *
 * - `bindDescendantsToProcess`: puts the engine process in a job object that kills every process in it when
 *   its last handle closes. Only the engine holds the handle, so when the engine ends (even killed) every agent
 *   CLI and every tool those agents started ends with it. Children join the job by inheritance, so there is no
 *   window between a spawn and an assignment. Node's own kill-on-exit job covers only direct children (it lets
 *   their children break away), which leaves the shells and tools of an agent running ([[초기 검증 결과]] M3).
 * - `lockDataDirectory`: opens a lock file with no sharing, so a second engine on the same data directory fails
 *   before it reads anything (in particular before it settles the first engine's runs as orphans). The OS
 *   releases it when the process ends, so a crash never leaves a stale lock.
 */

/** JOBOBJECT_EXTENDED_LIMIT_INFORMATION on x64: 144 bytes, LimitFlags at offset 16. */
const EXTENDED_LIMIT_INFORMATION_BYTES = 144;
const LIMIT_FLAGS_OFFSET = 16;

let job: Handle | undefined;

export function bindDescendantsToProcess(): void {
  if (job !== undefined) return;
  const api = win32();
  const handle = api.CreateJobObjectW(null, null);
  if (handle === 0) throw new Win32Error('CreateJobObjectW', api.GetLastError());
  const info = Buffer.alloc(EXTENDED_LIMIT_INFORMATION_BYTES);
  info.writeUInt32LE(JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, LIMIT_FLAGS_OFFSET);
  if (api.SetInformationJobObject(handle, JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS, info, info.length) === 0) {
    const code = api.GetLastError();
    api.CloseHandle(handle);
    throw new Win32Error('SetInformationJobObject', code);
  }
  if (api.AssignProcessToJobObject(handle, api.GetCurrentProcess()) === 0) {
    const code = api.GetLastError();
    api.CloseHandle(handle);
    throw new Win32Error('AssignProcessToJobObject', code);
  }
  // Never closed: the handle must live exactly as long as the process.
  job = handle;
}

export class DataDirectoryLockedError extends Error {
  constructor(path: string) {
    super(`another engine is using this data directory (lock: ${path})`);
    this.name = 'DataDirectoryLockedError';
  }
}

export interface DirectoryLock {
  readonly path: string;
  release(): void;
}

export function lockDataDirectory(path: string): DirectoryLock {
  const api = win32();
  const handle = api.CreateFileW(path, GENERIC_READ | GENERIC_WRITE, 0, null, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, null);
  if (handle === INVALID_HANDLE_VALUE) {
    const code = api.GetLastError();
    if (code === ERROR_SHARING_VIOLATION) throw new DataDirectoryLockedError(path);
    throw new Win32Error('CreateFileW', code);
  }
  let held = true;
  return {
    path,
    release: () => {
      if (!held) return;
      held = false;
      api.CloseHandle(handle);
    },
  };
}
