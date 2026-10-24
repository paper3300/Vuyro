import {
  DACL_SECURITY_INFORMATION,
  ERROR_INSUFFICIENT_BUFFER,
  FILE_FLAG_BACKUP_SEMANTICS,
  FILE_SHARE_ALL,
  GROUP_SECURITY_INFORMATION,
  type Handle,
  INVALID_HANDLE_VALUE,
  type NativePointer,
  OPEN_EXISTING,
  type OutSlot,
  OWNER_SECURITY_INFORMATION,
  PROTECTED_DACL_SECURITY_INFORMATION,
  READ_CONTROL,
  SDDL_REVISION_1,
  SE_KERNEL_OBJECT,
  TOKEN_QUERY,
  TOKEN_USER_CLASS,
  WRITE_DAC,
  win32,
} from './ffi.ts';

/** Current user SID and explicit DACLs on files. */

export class Win32Error extends Error {
  readonly code: number;

  constructor(operation: string, code: number) {
    super(`${operation} failed with Win32 error ${code}`);
    this.name = 'Win32Error';
    this.code = code;
  }
}

export interface ObjectSecurity {
  /** Owner, group and DACL in SDDL form. */
  readonly sddl: string;
  readonly ownerSid: string;
}

/**
 * DACL that grants full access to one user SID and nobody else.
 * `P` blocks inheritance; no ACE for Everyone, SYSTEM or Administrators.
 */
export function currentUserOnlySddl(userSid: string): string {
  if (!/^S-1-\d+(-\d+)+$/.test(userSid)) {
    throw new Error(`Not a SID: ${userSid}`);
  }
  return `D:P(A;;FA;;;${userSid})`;
}

let currentUserSid: string | undefined;

/** SID of the user that runs this process (from the process token). */
export function getCurrentUserSid(): string {
  currentUserSid ??= processUserSid(win32().GetCurrentProcess());
  return currentUserSid;
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

/** Reads owner, group and DACL of an existing file. */
export function readFileSecurity(path: string): ObjectSecurity {
  return withFileHandle(path, READ_CONTROL, readSecurity);
}

/**
 * Replaces the DACL of an existing file and returns the descriptor read back
 * through the same handle.
 */
export function setFileDacl(path: string, sddl: string): ObjectSecurity {
  return withFileHandle(path, (READ_CONTROL | WRITE_DAC) >>> 0, (handle) => setDaclOnHandle(handle, sddl));
}

/**
 * Restricts an existing file to the current user (explicit, protected DACL) and
 * verifies the result. Throws unless the read-back DACL allows exactly the
 * current user, so callers fail closed.
 */
export function restrictFileToCurrentUser(path: string): ObjectSecurity {
  const userSid = getCurrentUserSid();
  const security = setFileDacl(path, currentUserOnlySddl(userSid));
  const trustees = allowedTrustees(security.sddl);
  if (trustees.length !== 1 || trustees[0] !== userSid || !security.sddl.includes('D:P')) {
    throw new Error(`File DACL was not restricted to the current user: ${path}`);
  }
  return security;
}

/**
 * Restricts an existing directory to the current user, inherited by the files and folders made in it later
 * (`OICI`), and verifies the read-back DACL like `restrictFileToCurrentUser`.
 */
export function restrictDirectoryToCurrentUser(path: string): ObjectSecurity {
  const userSid = getCurrentUserSid();
  if (!/^S-1-\d+(-\d+)+$/.test(userSid)) throw new Error(`Not a SID: ${userSid}`);
  const security = withFileHandle(path, (READ_CONTROL | WRITE_DAC) >>> 0, (handle) => setDaclOnHandle(handle, `D:P(A;OICI;FA;;;${userSid})`), FILE_FLAG_BACKUP_SEMANTICS);
  if (!isCurrentUserOnly(security.sddl)) throw new Error(`Directory DACL was not restricted to the current user: ${path}`);
  return security;
}

/** Reads owner, group and DACL of an existing directory. */
export function readDirectorySecurity(path: string): ObjectSecurity {
  return withFileHandle(path, READ_CONTROL, readSecurity, FILE_FLAG_BACKUP_SEMANTICS);
}

/** Whether a descriptor's DACL is protected and allows exactly the current user. */
export function isCurrentUserOnly(sddl: string): boolean {
  const trustees = allowedTrustees(sddl);
  return trustees.length === 1 && trustees[0] === getCurrentUserSid() && sddl.includes('D:P');
}

/** Replaces the DACL through a handle that has WRITE_DAC and reads it back through the same handle. */
export function setDaclOnHandle(handle: Handle, sddl: string): ObjectSecurity {
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

function withFileHandle<T>(path: string, access: number, fn: (handle: Handle) => T, flags = 0): T {
  const w = win32();
  const handle = w.CreateFileW(path, access, FILE_SHARE_ALL, null, OPEN_EXISTING, flags, null);
  if (handle === INVALID_HANDLE_VALUE) throw new Win32Error(`CreateFileW(${path})`, w.GetLastError());
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

function readSecurity(handle: Handle): ObjectSecurity {
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
