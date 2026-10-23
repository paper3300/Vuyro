import { createRequire } from 'node:module';

/**
 * Minimal Win32 bindings through koffi (prebuilt FFI, no compiler needed).
 * Node's `net` module cannot set a security descriptor on a named pipe, so the
 * engine calls the security APIs directly. Loaded lazily: importing the engine
 * on another platform must not fail.
 */

/** Opaque native pointer (a koffi External). */
export type NativePointer = object;

/** Win32 HANDLE as an integer; -1 is INVALID_HANDLE_VALUE. */
export type Handle = number;

/** Single-slot array that koffi fills for `_Out_` pointer parameters. */
export type OutSlot<T> = [T | null];

export const INVALID_HANDLE_VALUE = -1;

export const GENERIC_READ = 0x80000000;
export const GENERIC_WRITE = 0x40000000;
export const READ_CONTROL = 0x00020000;
export const WRITE_DAC = 0x00040000;
export const OPEN_EXISTING = 3;
export const FILE_READ_ATTRIBUTES = 0x0080;
export const FILE_SHARE_ALL = 0x7;

export const OWNER_SECURITY_INFORMATION = 0x1;
export const GROUP_SECURITY_INFORMATION = 0x2;
export const DACL_SECURITY_INFORMATION = 0x4;
export const PROTECTED_DACL_SECURITY_INFORMATION = 0x80000000;
export const SE_KERNEL_OBJECT = 6;
export const SDDL_REVISION_1 = 1;

export const TOKEN_QUERY = 0x0008;
export const TOKEN_USER_CLASS = 1;
export const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;

export const PIPE_SERVER_END = 0x1;
/** FILE_PIPE_LOCAL_INFORMATION.NamedPipeType bit set by PIPE_REJECT_REMOTE_CLIENTS. */
export const FILE_PIPE_REJECT_REMOTE_CLIENTS = 0x2;
export const FILE_PIPE_CONNECTED_STATE = 3;
export const FILE_NAME_INFO_CLASS = 2;
export const FILE_PIPE_LOCAL_INFORMATION_CLASS = 24;
export const PROCESS_HANDLE_INFORMATION_CLASS = 51;
export const STATUS_INFO_LENGTH_MISMATCH = 0xc0000004;

export const ERROR_FILE_NOT_FOUND = 2;
export const ERROR_ACCESS_DENIED = 5;
export const ERROR_INSUFFICIENT_BUFFER = 122;
export const ERROR_PIPE_BUSY = 231;
export const ERROR_NO_DATA = 232;
export const ERROR_PIPE_NOT_CONNECTED = 233;

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
  WriteFile(handle: Handle, data: Buffer, length: number, written: OutSlot<number>, overlapped: null): number;
  GetCurrentProcess(): Handle;
  OpenProcess(access: number, inherit: number, pid: number): Handle;
  GetNamedPipeServerProcessId(pipe: Handle, pid: OutSlot<number>): number;
  GetNamedPipeClientProcessId(pipe: Handle, pid: OutSlot<number>): number;
  GetNamedPipeInfo(pipe: Handle, flags: OutSlot<number>, outSize: null, inSize: null, maxInstances: null): number;
  DisconnectNamedPipe(pipe: Handle): number;
  GetFileInformationByHandleEx(handle: Handle, cls: number, buffer: Buffer, length: number): number;
  /** Returns an NTSTATUS. */
  NtQueryInformationProcess(process: Handle, cls: number, buffer: Buffer, length: number, returned: OutSlot<number>): number;
  /** Returns an NTSTATUS. `ioStatus` is a 16-byte IO_STATUS_BLOCK. */
  NtQueryInformationFile(handle: Handle, ioStatus: Buffer, buffer: Buffer, length: number, cls: number): number;
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
  const ntdll = koffi.load('ntdll.dll');
  const n = (definition: string) => ntdll.func(definition);

  // BOOL is declared as int, HANDLE as intptr_t, out pointers as `_Out_ void **`.
  const fns = {
    CreateFileW: k(
      'intptr_t CreateFileW(const char16_t *name, uint32_t access, uint32_t share, void *sa, uint32_t disposition, uint32_t flags, void *tmpl)',
    ),
    CloseHandle: k('int CloseHandle(intptr_t handle)'),
    GetLastError: k('uint32_t GetLastError()'),
    LocalFree: k('void *LocalFree(void *memory)'),
    WriteFile: k('int WriteFile(intptr_t handle, const void *data, uint32_t length, _Out_ uint32_t *written, void *overlapped)'),
    GetCurrentProcess: k('intptr_t GetCurrentProcess()'),
    OpenProcess: k('intptr_t OpenProcess(uint32_t access, int inherit, uint32_t pid)'),
    GetNamedPipeServerProcessId: k('int GetNamedPipeServerProcessId(intptr_t pipe, _Out_ uint32_t *pid)'),
    GetNamedPipeClientProcessId: k('int GetNamedPipeClientProcessId(intptr_t pipe, _Out_ uint32_t *pid)'),
    GetNamedPipeInfo: k('int GetNamedPipeInfo(intptr_t pipe, _Out_ uint32_t *flags, void *outSize, void *inSize, void *maxInstances)'),
    DisconnectNamedPipe: k('int DisconnectNamedPipe(intptr_t pipe)'),
    GetFileInformationByHandleEx: k('int GetFileInformationByHandleEx(intptr_t handle, int cls, void *buffer, uint32_t length)'),
    NtQueryInformationProcess: n(
      'int32_t NtQueryInformationProcess(intptr_t process, int cls, void *buffer, uint32_t length, _Out_ uint32_t *returned)',
    ),
    NtQueryInformationFile: n(
      'int32_t NtQueryInformationFile(intptr_t handle, void *ioStatus, void *buffer, uint32_t length, int cls)',
    ),
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
  };

  return {
    ...(fns as unknown as Omit<Win32, 'decodeString16' | 'decodePointer'>),
    decodeString16: (pointer) => koffi.decode.string16(pointer),
    decodePointer: (buffer, offset) => koffi.decode(buffer, offset, 'void *') as NativePointer,
  };
}
