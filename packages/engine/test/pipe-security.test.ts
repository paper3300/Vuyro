import { randomUUID } from 'node:crypto';
import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { listenSecurePipe, type SecurePipeServer } from '../src/ipc/secure-pipe-server.ts';
import {
  ERROR_ACCESS_DENIED,
  ERROR_NO_DATA,
  ERROR_PIPE_NOT_CONNECTED,
  GENERIC_READ,
  GENERIC_WRITE,
  INVALID_HANDLE_VALUE,
  OPEN_EXISTING,
  win32,
} from '../src/platform/win32/ffi.ts';
import {
  allowedTrustees,
  currentUserOnlySddl,
  getCurrentUserSid,
  getPipeServerUserSid,
  readPipeSecurity,
  setPipeDacl,
  Win32Error,
} from '../src/platform/win32/pipe-security.ts';

const isWindows = process.platform === 'win32';

function pipePath(): string {
  return String.raw`\\.\pipe\vuyro-test-` + randomUUID();
}

function connect(path: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(path);
    socket.once('connect', () => {
      resolve(socket);
    });
    socket.once('error', reject);
  });
}

function connectError(path: string): Promise<NodeJS.ErrnoException> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(path);
    socket.once('connect', () => {
      socket.destroy();
      reject(new Error('connection unexpectedly succeeded'));
    });
    socket.once('error', resolve);
  });
}

function echo(socket: net.Socket): void {
  socket.on('data', (chunk) => socket.write(chunk));
  socket.on('error', () => undefined);
}

async function roundTrip(path: string, text: string): Promise<string> {
  const socket = await connect(path);
  return new Promise((resolve, reject) => {
    socket.once('data', (chunk) => {
      socket.destroy();
      resolve(chunk.toString());
    });
    socket.once('error', reject);
    socket.write(text);
  });
}

function listenPlain(path: string): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const server = net.createServer(echo);
    server.once('error', reject);
    server.listen(path, () => {
      resolve(server);
    });
  });
}

describe('currentUserOnlySddl', () => {
  it('grants one SID and denies network logons by default', () => {
    expect(currentUserOnlySddl('S-1-5-21-1-2-3-1001')).toBe('D:P(D;;GA;;;NU)(A;;GA;;;S-1-5-21-1-2-3-1001)');
    expect(currentUserOnlySddl('S-1-5-21-1-2-3-1001', { rejectRemote: false })).toBe('D:P(A;;GA;;;S-1-5-21-1-2-3-1001)');
  });

  it('rejects anything that is not a SID', () => {
    expect(() => currentUserOnlySddl('WD')).toThrow(/Not a SID/);
    expect(() => currentUserOnlySddl('S-1-1-0)(A;;GA;;;WD')).toThrow(/Not a SID/);
  });

  it('lists allowed trustees from an SDDL DACL', () => {
    expect(allowedTrustees('O:S-1-5-18G:DUD:(A;;FA;;;SY)(A;;FR;;;WD)(D;;FA;;;NU)(A;;FR;;;AN)')).toEqual(['SY', 'WD', 'AN']);
  });
});

describe.runIf(isWindows)('named pipe security (Windows)', () => {
  const cleanup: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) await fn();
  });

  it('reads the current user SID from the process token', () => {
    expect(getCurrentUserSid()).toMatch(/^S-1-5-\d+(-\d+)+$/);
  });

  it('documents the problem: Node gives a pipe Everyone and Anonymous read access', async () => {
    const path = pipePath();
    const server = await listenPlain(path);
    cleanup.push(() => new Promise<void>((resolve) => server.close(() => { resolve(); })));

    const security = readPipeSecurity(path);
    expect(security.ownerSid).toBe(getCurrentUserSid());
    expect(allowedTrustees(security.sddl)).toEqual(expect.arrayContaining(['WD', 'AN']));
  });

  it('restricts the DACL to the current user and denies network logons', async () => {
    const path = pipePath();
    const secure = await listenSecurePipe(path, echo);
    cleanup.push(() => secure.close());

    const sid = getCurrentUserSid();
    expect(secure.security.ownerSid).toBe(sid);
    expect(allowedTrustees(secure.security.sddl)).toEqual([sid]);
    expect(secure.security.sddl).toContain('D:P(D;;FA;;;NU)');
    expect(secure.droppedBeforeGate).toBe(1); // our own DACL connection
    expect(await roundTrip(path, 'hello')).toBe('hello');
  });

  it('keeps the DACL on pipe instances created after securing', async () => {
    const path = pipePath();
    const secure = await listenSecurePipe(path, echo);
    cleanup.push(() => secure.close());

    // libuv pre-creates a few instances and adds one per accepted connection.
    const sockets = await Promise.all(Array.from({ length: 12 }, () => connect(path)));
    const replies = await Promise.all(Array.from({ length: 4 }, (_, i) => roundTrip(path, `m${i}`)));
    expect(replies).toEqual(['m0', 'm1', 'm2', 'm3']);
    expect(allowedTrustees(readPipeSecurity(path).sddl)).toEqual([getCurrentUserSid()]);
    for (const socket of sockets) socket.destroy();
  });

  it('enforces the DACL: a principal not in it cannot connect', async () => {
    // Stand-in for "another account": grant only SYSTEM, then connect as ourselves.
    const path = pipePath();
    const server = await listenPlain(path);
    cleanup.push(() => new Promise<void>((resolve) => server.close(() => { resolve(); })));

    setPipeDacl(path, 'D:P(A;;GA;;;SY)');
    const error = await connectError(path);
    expect(error.code).toBe('EPERM');

    const w = win32();
    const handle = w.CreateFileW(path, (GENERIC_READ | GENERIC_WRITE) >>> 0, 0, null, OPEN_EXISTING, 0, null);
    expect(handle).toBe(INVALID_HANDLE_VALUE);
    expect(w.GetLastError()).toBe(ERROR_ACCESS_DENIED);
    expect(() => readPipeSecurity(path)).toThrow(Win32Error);
  });

  it('drops connections accepted before the DACL was applied', async () => {
    const path = pipePath();
    const w = win32();
    let early = INVALID_HANDLE_VALUE;
    const secure: SecurePipeServer = await listenSecurePipe(path, echo, {
      afterListen: () => {
        // Connects while the pipe still has Node's default DACL.
        early = w.CreateFileW(path, (GENERIC_READ | GENERIC_WRITE) >>> 0, 0, null, OPEN_EXISTING, 0, null);
      },
    });
    cleanup.push(() => secure.close());
    cleanup.push(() => {
      w.CloseHandle(early);
    });

    expect(early).not.toBe(INVALID_HANDLE_VALUE);
    expect(secure.droppedBeforeGate).toBe(2); // the early client + our own DACL connection
    await new Promise((resolve) => setTimeout(resolve, 50));
    const written: [number | null] = [0];
    expect(w.WriteFile(early, Buffer.from('late'), 4, written, null)).toBe(0);
    expect([ERROR_NO_DATA, ERROR_PIPE_NOT_CONNECTED]).toContain(w.GetLastError());
  });

  it('refuses to listen on a name that already exists (squatting, second instance)', async () => {
    const path = pipePath();
    const secure = await listenSecurePipe(path, echo);
    cleanup.push(() => secure.close());

    await expect(listenSecurePipe(path, echo)).rejects.toMatchObject({ code: 'EADDRINUSE' });
  });

  it('lets a client check which user runs the pipe server', async () => {
    const path = pipePath();
    const secure = await listenSecurePipe(path, echo);
    cleanup.push(() => secure.close());

    expect(getPipeServerUserSid(path)).toBe(getCurrentUserSid());
  });
});
