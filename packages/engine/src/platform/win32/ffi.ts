import { createRequire } from 'node:module';

/**
 * Minimal Win32 bindings through koffi (prebuilt FFI, no compiler needed).
 * Used to read the current user's SID and to put an explicit current-user-only
 * DACL on files (the engine token file); Node has no API for either. Loaded
 * lazily: importing the engine on another platform must not fail.
 */

/** Opaque native pointer (a koffi External). */
export type NativePointer = object;

/** Win32 HANDLE as an integer; -1 is INVALID_HANDLE_VALUE. */
export type Handle = number;

/** Single-slot array that koffi fills for `_Out_` pointer parameters. */
export type OutSlot<T> = [T | null];

export const INVALID_HANDLE_VALUE = -1;

export const READ_CONTROL = 0x00020000;
export const WRITE_DAC = 0x00040000;
export const OPEN_EXISTING = 3;
export const FILE_SHARE_ALL = 0x7;
/** CreateFileW needs it to open a directory. */
export const FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;

export const OWNER_SECURITY_INFORMATION = 0x1;
export const GROUP_SECURITY_INFORMATION = 0x2;
export const DACL_SECURITY_INFORMATION = 0x4;
export const PROTECTED_DACL_SECURITY_INFORMATION = 0x80000000;
export const SE_KERNEL_OBJECT = 6;
export const SDDL_REVISION_1 = 1;

export const TOKEN_QUERY = 0x0008;
export const TOKEN_USER_CLASS = 1;

export const ERROR_ACCESS_DENIED = 5;
export const ERROR_SHARING_VIOLATION = 32;
export const GENERIC_READ = 0x80000000;
export const GENERIC_WRITE = 0x40000000;
export const OPEN_ALWAYS = 4;
export const FILE_ATTRIBUTE_NORMAL = 0x80;
export const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS = 9;
export const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
export const ERROR_INSUFFICIENT_BUFFER = 122;

export interface Win32 {
  CreateFileW(
    name: string,
    access: number,
    share: number,
    securityAttributes: null,
    disposition: number,
    flags: number,
    template: null,
  ): Handle;
  CloseHandle(handle: Handle): number;
  GetLastError(): number;
  LocalFree(memory: NativePointer): unknown;
  GetCurrentProcess(): Handle;
  OpenProcessToken(process: Handle, access: number, token: OutSlot<Handle>): number;
  GetTokenInformation(token: Handle, cls: number, buffer: Buffer | null, length: number, returned: OutSlot<number>): number;
  ConvertSidToStringSidW(sid: NativePointer, out: OutSlot<NativePointer>): number;
  ConvertStringSecurityDescriptorToSecurityDescriptorW(
    sddl: string,
    revision: number,
    out: OutSlot<NativePointer>,
    size: null,
  ): number;
  ConvertSecurityDescriptorToStringSecurityDescriptorW(
    descriptor: NativePointer,
    revision: number,
    info: number,
    out: OutSlot<NativePointer>,
    length: null,
  ): number;
  GetSecurityDescriptorDacl(
    descriptor: NativePointer,
    present: OutSlot<number>,
    dacl: OutSlot<NativePointer>,
    defaulted: OutSlot<number>,
  ): number;
  GetSecurityInfo(
    handle: Handle,
    objectType: number,
    info: number,
    owner: OutSlot<NativePointer>,
    group: OutSlot<NativePointer>,
    dacl: OutSlot<NativePointer>,
    sacl: OutSlot<NativePointer>,
    descriptor: OutSlot<NativePointer>,
  ): number;
  SetSecurityInfo(
    handle: Handle,
    objectType: number,
    info: number,
    owner: null,
    group: null,
    dacl: NativePointer,
    sacl: null,
  ): number;
  CreateJobObjectW(securityAttributes: null, name: null): Handle;
  SetInformationJobObject(job: Handle, infoClass: number, info: Buffer, length: number): number;
  AssignProcessToJobObject(job: Handle, process: Handle): number;
  /** Reads a NUL-terminated UTF-16 string at a native pointer. */
  decodeString16(pointer: NativePointer): string;
  /** Reads a pointer stored at `offset` inside a buffer. */
  decodePointer(buffer: Buffer, offset: number): NativePointer;
}

interface KoffiLibrary {
  func(definition: string): unknown;
}

interface Koffi {
  load(path: string): KoffiLibrary;
  decode: ((value: unknown, offset: number, type: string) => unknown) & {
    string16(pointer: unknown): string;
  };
}

let cached: Win32 | undefined;

export function win32(): Win32 {
  if (process.platform !== 'win32') {
    throw new Error('Win32 bindings are only available on Windows');
  }
  cached ??= bind();
  return cached;
}

function bind(): Win32 {
  const require = createRequire(import.meta.url);
  const koffi = require('koffi') as Koffi;
  const kernel32 = koffi.load('kernel32.dll');
  const advapi32 = koffi.load('advapi32.dll');
  const k = (definition: string) => kernel32.func(definition);
  const a = (definition: string) => advapi32.func(definition);

  // BOOL is declared as int, HANDLE as intptr_t, out pointers as `_Out_ void **`.
  const fns = {
    CreateFileW: k(
      'intptr_t CreateFileW(const char16_t *name, uint32_t access, uint32_t share, void *sa, uint32_t disposition, uint32_t flags, void *tmpl)',
    ),
    CloseHandle: k('int CloseHandle(intptr_t handle)'),
    GetLastError: k('uint32_t GetLastError()'),
    LocalFree: k('void *LocalFree(void *memory)'),
    GetCurrentProcess: k('intptr_t GetCurrentProcess()'),
    OpenProcessToken: a('int OpenProcessToken(intptr_t process, uint32_t access, _Out_ intptr_t *token)'),
    GetTokenInformation: a(
      'int GetTokenInformation(intptr_t token, int cls, void *buffer, uint32_t length, _Out_ uint32_t *returned)',
    ),
    ConvertSidToStringSidW: a('int ConvertSidToStringSidW(void *sid, _Out_ void **out)'),
    ConvertStringSecurityDescriptorToSecurityDescriptorW: a(
      'int ConvertStringSecurityDescriptorToSecurityDescriptorW(const char16_t *sddl, uint32_t revision, _Out_ void **out, void *size)',
    ),
    ConvertSecurityDescriptorToStringSecurityDescriptorW: a(
      'int ConvertSecurityDescriptorToStringSecurityDescriptorW(void *descriptor, uint32_t revision, uint32_t info, _Out_ void **out, void *length)',
    ),
    GetSecurityDescriptorDacl: a(
      'int GetSecurityDescriptorDacl(void *descriptor, _Out_ int *present, _Out_ void **dacl, _Out_ int *defaulted)',
    ),
    GetSecurityInfo: a(
      'uint32_t GetSecurityInfo(intptr_t handle, int type, uint32_t info, _Out_ void **owner, _Out_ void **group, _Out_ void **dacl, _Out_ void **sacl, _Out_ void **descriptor)',
    ),
    SetSecurityInfo: a(
      'uint32_t SetSecurityInfo(intptr_t handle, int type, uint32_t info, void *owner, void *group, void *dacl, void *sacl)',
    ),
    CreateJobObjectW: k('intptr_t CreateJobObjectW(void *sa, void *name)'),
    SetInformationJobObject: k('int SetInformationJobObject(intptr_t job, int cls, void *info, uint32_t length)'),
    AssignProcessToJobObject: k('int AssignProcessToJobObject(intptr_t job, intptr_t process)'),
  };

  return {
    ...(fns as unknown as Omit<Win32, 'decodeString16' | 'decodePointer'>),
    decodeString16: (pointer) => koffi.decode.string16(pointer),
    decodePointer: (buffer, offset) => koffi.decode(buffer, offset, 'void *') as NativePointer,
  };
}
