import {
  DACL_SECURITY_INFORMATION,
  ERROR_INSUFFICIENT_BUFFER,
  GENERIC_WRITE,
  GROUP_SECURITY_INFORMATION,
  type Handle,
  INVALID_HANDLE_VALUE,
  type NativePointer,
  OPEN_EXISTING,
  type OutSlot,
  OWNER_SECURITY_INFORMATION,
  PROCESS_QUERY_LIMITED_INFORMATION,
  PROTECTED_DACL_SECURITY_INFORMATION,
  READ_CONTROL,
  SDDL_REVISION_1,
  SE_KERNEL_OBJECT,
  TOKEN_QUERY,
  TOKEN_USER_CLASS,
  WRITE_DAC,
  win32,
} from './ffi.ts';

/**
 * Named pipe security helpers.
 *
 * A pipe's security descriptor is shared by all of its instances, and any handle
 * opened with WRITE_DAC can replace it. Opening the pipe as a client is the only
 * way to get such a handle from JS (Node keeps the server handles private), so
 * every helper here opens a short-lived client connection.
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
 * Replaces the DACL of an existing pipe and returns the descriptor read back
 * through the same handle. Applies to every instance of the pipe.
 */
export function setPipeDacl(pipePath: string, sddl: string): PipeSecurity {
  return withPipeHandle(pipePath, (READ_CONTROL | WRITE_DAC) >>> 0, (handle) => {
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
  });
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
    const process = w.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid[0] ?? 0);
    if (process === 0) throw new Win32Error('OpenProcess', w.GetLastError());
    try {
      return processUserSid(process);
    } finally {
      w.CloseHandle(process);
    }
  });
}

/** Connects as a client, writes `data` and disconnects. */
export function writeToPipe(pipePath: string, data: Buffer): void {
  withPipeHandle(pipePath, GENERIC_WRITE, (handle) => {
    const w = win32();
    const written: OutSlot<number> = [0];
    if (!w.WriteFile(handle, data, data.length, written, null)) {
      throw new Win32Error('WriteFile', w.GetLastError());
    }
    if (written[0] !== data.length) throw new Error(`Short pipe write: ${written[0] ?? 0}/${data.length}`);
  });
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
