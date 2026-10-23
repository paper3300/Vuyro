import {
  DACL_SECURITY_INFORMATION,
  ERROR_INSUFFICIENT_BUFFER,
  ERROR_MORE_DATA,
  FILE_NAME_INFO_CLASS,
  FILE_PIPE_CLOSING_STATE,
  FILE_PIPE_CONNECTED_STATE,
  FILE_PIPE_DISCONNECTED_STATE,
  FILE_PIPE_LISTENING_STATE,
  FILE_PIPE_LOCAL_INFORMATION_CLASS,
  FILE_PIPE_REJECT_REMOTE_CLIENTS,
  FILE_READ_ATTRIBUTES,
  FILE_SHARE_ALL,
  FILE_TYPE_PIPE,
  FILE_TYPE_UNKNOWN,
  GROUP_SECURITY_INFORMATION,
  type Handle,
  INVALID_HANDLE_VALUE,
  type NativePointer,
  NO_ERROR,
  OPEN_EXISTING,
  type OutSlot,
  OWNER_SECURITY_INFORMATION,
  PIPE_SERVER_END,
  PROCESS_HANDLE_INFORMATION_CLASS,
  PROCESS_QUERY_LIMITED_INFORMATION,
  PROTECTED_DACL_SECURITY_INFORMATION,
  READ_CONTROL,
  SDDL_REVISION_1,
  SE_KERNEL_OBJECT,
  STATUS_INFO_LENGTH_MISMATCH,
  TOKEN_QUERY,
  TOKEN_USER_CLASS,
  WRITE_DAC,
  win32,
} from './ffi.ts';

/**
 * Named pipe security helpers.
 *
 * A pipe's security descriptor is shared by all of its instances, and any handle
 * opened with WRITE_DAC can replace it. Node keeps its server handles private, so:
 * - the server side finds its own instance handles in this process's handle table
 *   (`findOwnPipeServerInstances`); libuv opens them with WRITE_DAC;
 * - the other helpers open a short-lived client connection.
 */

export class Win32Error extends Error {
  readonly code: number;

  constructor(operation: string, code: number) {
    super(`${operation} failed with Win32 error ${code}`);
    this.name = 'Win32Error';
    this.code = code;
  }
}

export interface PipeSecurity {
  /** Owner, group and DACL in SDDL form. */
  readonly sddl: string;
  readonly ownerSid: string;
}

export interface CurrentUserOnlyOptions {
  /**
   * Deny network logons (SMB `\\host\pipe\...`), even for the same account.
   * Default true. Note that OpenSSH sessions are network logons too.
   *
   * This ACE is the only remote-access control available: libuv creates the
   * instances without PIPE_REJECT_REMOTE_CLIENTS (checked through
   * `PipeServerInstance.rejectsRemoteClients`), and that flag cannot be added
   * afterwards. Its effect from another PC is still to be measured before release.
   */
  readonly rejectRemote?: boolean;
}

/**
 * DACL that grants full access to one user SID and nobody else.
 * `P` blocks inheritance; no ACE for Everyone, Anonymous, SYSTEM or Administrators.
 */
export function currentUserOnlySddl(userSid: string, options: CurrentUserOnlyOptions = {}): string {
  if (!/^S-1-\d+(-\d+)+$/.test(userSid)) {
    throw new Error(`Not a SID: ${userSid}`);
  }
  const denyRemote = (options.rejectRemote ?? true) ? '(D;;GA;;;NU)' : '';
  return `D:P${denyRemote}(A;;GA;;;${userSid})`;
}

let currentUserSid: string | undefined;

/** SID of the user that runs this process (from the process token). */
export function getCurrentUserSid(): string {
  currentUserSid ??= processUserSid(win32().GetCurrentProcess());
  return currentUserSid;
}

/** Reads the security descriptor of an existing pipe. */
export function readPipeSecurity(pipePath: string): PipeSecurity {
  return withPipeHandle(pipePath, READ_CONTROL, readSecurity);
}

/**
 * Replaces the DACL of an existing pipe through a client connection and returns
 * the descriptor read back through the same handle. Applies to every instance.
 */
export function setPipeDacl(pipePath: string, sddl: string): PipeSecurity {
  return withPipeHandle(pipePath, (READ_CONTROL | WRITE_DAC) >>> 0, (handle) => setPipeDaclOnHandle(handle, sddl));
}

/**
 * Replaces the DACL through any handle of the pipe that has WRITE_DAC
 * (a server instance or a client end) and reads it back through the same handle.
 */
export function setPipeDaclOnHandle(handle: Handle, sddl: string): PipeSecurity {
  const w = win32();
  const out: OutSlot<NativePointer> = [null];
  if (!w.ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, SDDL_REVISION_1, out, null)) {
    throw new Win32Error('ConvertStringSecurityDescriptorToSecurityDescriptorW', w.GetLastError());
  }
  const sd = required(out, 'ConvertStringSecurityDescriptorToSecurityDescriptorW');
  try {
    const present: OutSlot<number> = [0];
    const dacl: OutSlot<NativePointer> = [null];
    if (!w.GetSecurityDescriptorDacl(sd, present, dacl, [0])) {
      throw new Win32Error('GetSecurityDescriptorDacl', w.GetLastError());
    }
    if (!present[0]) throw new Error(`SDDL has no DACL: ${sddl}`);
    const info = (DACL_SECURITY_INFORMATION | (sddl.includes('D:P') ? PROTECTED_DACL_SECURITY_INFORMATION : 0)) >>> 0;
    const rc = w.SetSecurityInfo(handle, SE_KERNEL_OBJECT, info, null, null, required(dacl, 'GetSecurityDescriptorDacl'), null);
    if (rc !== 0) throw new Win32Error('SetSecurityInfo', rc);
  } finally {
    w.LocalFree(sd);
  }
  return readSecurity(handle);
}

/**
 * Trustee SIDs (or SDDL aliases such as WD, AN) of the access-allowed ACEs in
 * an SDDL string's DACL.
 */
export function allowedTrustees(sddl: string): string[] {
  const dacl = /D:[A-Z]*((?:\([^)]*\))*)/.exec(sddl)?.[1] ?? '';
  const trustees: string[] = [];
  for (const [, ace] of dacl.matchAll(/\(([^)]*)\)/g)) {
    const fields = (ace ?? '').split(';');
    if (fields[0] === 'A') trustees.push(fields[5] ?? '');
  }
  return trustees;
}

/** User SID of the process that owns the server end of a pipe. */
export function getPipeServerUserSid(pipePath: string): string {
  return withPipeHandle(pipePath, READ_CONTROL, (handle) => {
    const w = win32();
    const pid: OutSlot<number> = [0];
    if (!w.GetNamedPipeServerProcessId(handle, pid)) {
      throw new Win32Error('GetNamedPipeServerProcessId', w.GetLastError());
    }
    return getProcessUserSid(pid[0] ?? 0);
  });
}

/** User SID of a running process. Throws if the process cannot be opened. */
export function getProcessUserSid(pid: number): string {
  const w = win32();
  const process = w.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
  if (process === 0) throw new Win32Error(`OpenProcess(${pid})`, w.GetLastError());
  try {
    return processUserSid(process);
  } finally {
    w.CloseHandle(process);
  }
}

export type PipeInstanceState = 'listening' | 'disconnected' | 'connected' | 'closing' | 'unknown';

export interface PipeServerInstance {
  readonly handle: Handle;
  readonly state: PipeInstanceState;
  /**
   * The instance has or had a client whose data may still be readable
   * (every state except listening and disconnected, including unknown ones).
   */
  readonly occupied: boolean;
  /** Process id of the client; undefined when not occupied or the lookup failed. */
  readonly clientPid: number | undefined;
  /** Whether the instance was created with PIPE_REJECT_REMOTE_CLIENTS. */
  readonly rejectsRemoteClients: boolean;
}

const LOCAL_PIPE_PREFIX = String.raw`\\.\pipe` + '\\';

const PIPE_STATES: Record<number, PipeInstanceState> = {
  [FILE_PIPE_LISTENING_STATE]: 'listening',
  [FILE_PIPE_DISCONNECTED_STATE]: 'disconnected',
  [FILE_PIPE_CONNECTED_STATE]: 'connected',
  [FILE_PIPE_CLOSING_STATE]: 'closing',
};

/**
 * Server-end instances of `pipePath` held by this process: the listening
 * instances and the accepted connections that libuv created.
 *
 * Candidates are this process's File handles that were granted WRITE_DAC
 * (libuv requests it for every server instance). A candidate is skipped only
 * when it is positively not one of ours: not a pipe, a different name, or a
 * client end. Anything that cannot be determined throws, so callers fail closed.
 */
export function findOwnPipeServerInstances(pipePath: string): PipeServerInstance[] {
  if (!pipePath.toLowerCase().startsWith(LOCAL_PIPE_PREFIX)) throw new Error(`Not a local pipe path: ${pipePath}`);
  const expectedName = `\\${pipePath.slice(LOCAL_PIPE_PREFIX.length)}`.toLowerCase();
  const w = win32();
  const fileType = fileObjectTypeIndex();
  const instances: PipeServerInstance[] = [];
  for (const entry of ownHandles()) {
    if (entry.objectType !== fileType || (entry.grantedAccess & WRITE_DAC) === 0) continue;
    const type = w.GetFileType(entry.handle);
    if (type === FILE_TYPE_UNKNOWN) {
      const error = w.GetLastError();
      if (error !== NO_ERROR) throw new Win32Error('GetFileType', error);
    }
    if (type !== FILE_TYPE_PIPE) continue;
    if (fileName(entry.handle).toLowerCase() !== expectedName) continue;
    const flags: OutSlot<number> = [0];
    if (!w.GetNamedPipeInfo(entry.handle, flags, null, null, null)) throw new Win32Error('GetNamedPipeInfo', w.GetLastError());
    if (((flags[0] ?? 0) & PIPE_SERVER_END) === 0) continue; // a client end held by this process
    const local = pipeLocalInformation(entry.handle);
    const state = PIPE_STATES[local.state] ?? 'unknown';
    const occupied = state !== 'listening' && state !== 'disconnected';
    let clientPid: number | undefined;
    if (occupied) {
      const pid: OutSlot<number> = [0];
      if (w.GetNamedPipeClientProcessId(entry.handle, pid) && (pid[0] ?? 0) !== 0) clientPid = pid[0] ?? undefined;
    }
    instances.push({
      handle: entry.handle,
      state,
      occupied,
      clientPid,
      rejectsRemoteClients: (local.type & FILE_PIPE_REJECT_REMOTE_CLIENTS) !== 0,
    });
  }
  return instances;
}

/** Forcibly disconnects the client of a server instance; unread data is discarded. */
export function disconnectPipeInstance(handle: Handle): void {
  const w = win32();
  if (!w.DisconnectNamedPipe(handle)) throw new Win32Error('DisconnectNamedPipe', w.GetLastError());
}

interface HandleEntry {
  readonly handle: Handle;
  readonly grantedAccess: number;
  readonly objectType: number;
}

/** PROCESS_HANDLE_SNAPSHOT_INFORMATION of the current process (Windows 8+). */
function ownHandles(): HandleEntry[] {
  const w = win32();
  let size = 64 * 1024;
  for (;;) {
    const buffer = Buffer.alloc(size);
    const returned: OutSlot<number> = [0];
    const status = w.NtQueryInformationProcess(w.GetCurrentProcess(), PROCESS_HANDLE_INFORMATION_CLASS, buffer, size, returned);
    if (status >>> 0 === STATUS_INFO_LENGTH_MISMATCH) {
      size = Math.max(size * 2, (returned[0] ?? 0) + 4096);
      continue;
    }
    if (status !== 0) throw new Error(`NtQueryInformationProcess failed with NTSTATUS 0x${(status >>> 0).toString(16)}`);
    // { ULONG_PTR NumberOfHandles; ULONG_PTR Reserved; PROCESS_HANDLE_TABLE_ENTRY_INFO Handles[]; }
    // entry (40 bytes): HANDLE HandleValue; ULONG_PTR HandleCount, PointerCount;
    //                   ULONG GrantedAccess, ObjectTypeIndex, HandleAttributes, Reserved
    const count = Number(buffer.readBigUInt64LE(0));
    const entries: HandleEntry[] = [];
    for (let i = 0; i < count; i++) {
      const offset = 16 + i * 40;
      entries.push({
        handle: Number(buffer.readBigUInt64LE(offset)),
        grantedAccess: buffer.readUInt32LE(offset + 24),
        objectType: buffer.readUInt32LE(offset + 28),
      });
    }
    return entries;
  }
}

let fileTypeIndex: number | undefined;

/** Object type index of "File", taken from a handle we open to our own executable. */
function fileObjectTypeIndex(): number {
  if (fileTypeIndex !== undefined) return fileTypeIndex;
  const w = win32();
  const handle = w.CreateFileW(process.execPath, FILE_READ_ATTRIBUTES, FILE_SHARE_ALL, null, OPEN_EXISTING, 0, null);
  if (handle === INVALID_HANDLE_VALUE) throw new Win32Error('CreateFileW(execPath)', w.GetLastError());
  try {
    const entry = ownHandles().find((candidate) => candidate.handle === handle);
    if (entry === undefined) throw new Error('Reference file handle not found in the handle snapshot');
    fileTypeIndex = entry.objectType;
    return fileTypeIndex;
  } finally {
    w.CloseHandle(handle);
  }
}

/** FILE_NAME_INFO { DWORD FileNameLength; WCHAR FileName[]; }; for a pipe this is `\<name>`. Throws on failure. */
function fileName(handle: Handle): string {
  const w = win32();
  for (let size = 1024; size <= 128 * 1024; size *= 4) {
    const buffer = Buffer.alloc(size);
    if (w.GetFileInformationByHandleEx(handle, FILE_NAME_INFO_CLASS, buffer, buffer.length)) {
      const length = buffer.readUInt32LE(0);
      if (4 + length > buffer.length) throw new Error('FILE_NAME_INFO length exceeds the buffer');
      return buffer.toString('utf16le', 4, 4 + length);
    }
    const error = w.GetLastError();
    if (error !== ERROR_MORE_DATA) throw new Win32Error('GetFileInformationByHandleEx(FileNameInfo)', error);
  }
  throw new Error('FILE_NAME_INFO does not fit in 128 KiB');
}

/** FILE_PIPE_LOCAL_INFORMATION: ten ULONGs; NamedPipeType at 0, NamedPipeState at 32. */
function pipeLocalInformation(handle: Handle): { type: number; state: number } {
  const ioStatus = Buffer.alloc(16);
  const info = Buffer.alloc(40);
  const status = win32().NtQueryInformationFile(handle, ioStatus, info, info.length, FILE_PIPE_LOCAL_INFORMATION_CLASS);
  if (status !== 0) throw new Error(`NtQueryInformationFile failed with NTSTATUS 0x${(status >>> 0).toString(16)}`);
  return { type: info.readUInt32LE(0), state: info.readUInt32LE(32) };
}

/** Opens a client handle to a pipe, runs `fn` and closes the handle. */
export function withPipeHandle<T>(pipePath: string, access: number, fn: (handle: Handle) => T): T {
  const w = win32();
  const handle = w.CreateFileW(pipePath, access, 0, null, OPEN_EXISTING, 0, null);
  if (handle === INVALID_HANDLE_VALUE) throw new Win32Error(`CreateFileW(${pipePath})`, w.GetLastError());
  try {
    return fn(handle);
  } finally {
    w.CloseHandle(handle);
  }
}

function processUserSid(process: Handle): string {
  const w = win32();
  const token: OutSlot<Handle> = [0];
  if (!w.OpenProcessToken(process, TOKEN_QUERY, token)) {
    throw new Win32Error('OpenProcessToken', w.GetLastError());
  }
  const tokenHandle = token[0] ?? 0;
  try {
    const needed: OutSlot<number> = [0];
    w.GetTokenInformation(tokenHandle, TOKEN_USER_CLASS, null, 0, needed);
    const sizeError = w.GetLastError();
    if (sizeError !== ERROR_INSUFFICIENT_BUFFER) throw new Win32Error('GetTokenInformation(size)', sizeError);
    const buffer = Buffer.alloc(needed[0] ?? 0);
    if (!w.GetTokenInformation(tokenHandle, TOKEN_USER_CLASS, buffer, buffer.length, needed)) {
      throw new Win32Error('GetTokenInformation', w.GetLastError());
    }
    // TOKEN_USER starts with SID_AND_ATTRIBUTES { PSID Sid; DWORD Attributes; }.
    const sid = w.decodePointer(buffer, 0);
    const out: OutSlot<NativePointer> = [null];
    if (!w.ConvertSidToStringSidW(sid, out)) throw new Win32Error('ConvertSidToStringSidW', w.GetLastError());
    const text = required(out, 'ConvertSidToStringSidW');
    try {
      return w.decodeString16(text);
    } finally {
      w.LocalFree(text);
    }
  } finally {
    w.CloseHandle(tokenHandle);
  }
}

function readSecurity(handle: Handle): PipeSecurity {
  const w = win32();
  const descriptor: OutSlot<NativePointer> = [null];
  const rc = w.GetSecurityInfo(
    handle,
    SE_KERNEL_OBJECT,
    OWNER_SECURITY_INFORMATION | GROUP_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
    [null],
    [null],
    [null],
    [null],
    descriptor,
  );
  if (rc !== 0) throw new Win32Error('GetSecurityInfo', rc);
  const sd = required(descriptor, 'GetSecurityInfo');
  try {
    const sddl = descriptorToSddl(sd);
    const owner = /^O:([^:]+?)G:/.exec(sddl)?.[1];
    if (owner === undefined) throw new Error(`Unexpected SDDL: ${sddl}`);
    return { sddl, ownerSid: owner };
  } finally {
    w.LocalFree(sd);
  }
}

function descriptorToSddl(descriptor: NativePointer): string {
  const w = win32();
  const out: OutSlot<NativePointer> = [null];
  const info = OWNER_SECURITY_INFORMATION | GROUP_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION;
  if (!w.ConvertSecurityDescriptorToStringSecurityDescriptorW(descriptor, SDDL_REVISION_1, info, out, null)) {
    throw new Win32Error('ConvertSecurityDescriptorToStringSecurityDescriptorW', w.GetLastError());
  }
  const text = required(out, 'ConvertSecurityDescriptorToStringSecurityDescriptorW');
  try {
    return w.decodeString16(text);
  } finally {
    w.LocalFree(text);
  }
}

function required(slot: OutSlot<NativePointer>, operation: string): NativePointer {
  const value = slot[0];
  if (value === null) throw new Error(`${operation} returned a null pointer`);
  return value;
}
