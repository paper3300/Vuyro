import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { listenSecurePipe, type PipeClient, type SecurePipeServerOptions } from '../src/ipc/secure-pipe-server.ts';
import {
  ERROR_ACCESS_DENIED,
  FILE_TYPE_UNKNOWN,
  GENERIC_READ,
  GENERIC_WRITE,
  INVALID_HANDLE_VALUE,
  OPEN_EXISTING,
  win32,
} from '../src/platform/win32/ffi.ts';
import {
  allowedTrustees,
  currentUserOnlySddl,
  findOwnPipeServerInstances,
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Echo handler that also records everything it receives and how often it was called. */
function recordInto(received: string[], seen: { connections: number } = { connections: 0 }) {
  return (socket: net.Socket): void => {
    seen.connections += 1;
    socket.on('data', (chunk) => {
      received.push(chunk.toString());
      socket.write(chunk);
    });
    socket.on('error', () => undefined);
  };
}

/**
 * Keeps writing `text` until the server closes the connection or `timeoutMs` passes.
 * (A Windows pipe client only notices a server-side disconnect on its next write.)
 */
function talkUntilClosed(path: string, text: string, timeoutMs = 3000): Promise<{ closed: boolean; received: string }> {
  return new Promise((resolve) => {
    let received = '';
    const socket = net.connect(path);
    const timer = setInterval(() => socket.write(text), 50);
    const done = (closed: boolean): void => {
      clearInterval(timer);
      clearTimeout(deadline);
      socket.destroy();
      resolve({ closed, received });
    };
    const deadline = setTimeout(() => {
      done(false);
    }, timeoutMs);
    socket.on('connect', () => socket.write(text));
    socket.on('data', (chunk) => (received += chunk.toString()));
    socket.on('error', () => undefined);
    socket.on('close', () => {
      done(true);
    });
  });
}

/** Blocks this thread (no event loop turns) until `path` exists. */
function waitForFileSync(path: string, timeoutMs: number): void {
  const cell = new Int32Array(new SharedArrayBuffer(4));
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${path}`);
    Atomics.wait(cell, 0, 0, 10);
  }
}

// A client in another process: connects, keeps writing "evil", reports what it received when closed.
const CLIENT_SCRIPT = `
const net = require('node:net');
const fs = require('node:fs');
const [path, marker] = process.argv.slice(1);
let received = '';
function attempt() {
  let connected = false;
  const socket = net.connect(path);
  socket.on('connect', () => {
    connected = true;
    socket.write('evil');
    fs.writeFileSync(marker, '');
    // A Windows pipe client only notices a server-side disconnect on its next write.
    setInterval(() => socket.write('evil'), 50);
  });
  socket.on('data', (chunk) => { received += chunk; });
  socket.on('error', () => undefined);
  socket.on('close', () => {
    if (!connected) { setTimeout(attempt, 10); return; } // the server is not listening yet
    process.stdout.write('closed:' + received);
    process.exit(0);
  });
}
attempt();
setTimeout(() => { process.stdout.write('timeout'); process.exit(1); }, 10000);
`;

interface ClientProcess {
  pid: number;
  output: Promise<string>;
  start(): void;
}

/**
 * Starts CLIENT_SCRIPT. With `spawnOnly` the process waits on stdin until `start()`,
 * so its pid is known before it connects.
 */
function startClientProcess(path: string, marker: string, options: { spawnOnly?: boolean } = {}): ClientProcess {
  const script = options.spawnOnly === true ? `process.stdin.once('data', () => { ${CLIENT_SCRIPT} });` : CLIENT_SCRIPT;
  const child = spawn(process.execPath, ['-e', script, path, marker], { stdio: ['pipe', 'pipe', 'inherit'] });
  const output = new Promise<string>((resolve) => {
    let text = '';
    child.stdout.on('data', (chunk: Buffer) => (text += chunk.toString()));
    child.on('exit', () => {
      resolve(text);
    });
  });
  if (child.pid === undefined) throw new Error('client process did not start');
  return {
    pid: child.pid,
    output,
    start: () => {
      child.stdin.write('go\n');
    },
  };
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
    expect(secure.droppedBeforeSecure).toBe(0);
    expect(secure.rejectedClients).toBe(0);
    expect(await roundTrip(path, 'hello')).toBe('hello');
  });

  it('applies the DACL without opening a connection of its own', async () => {
    const path = pipePath();
    let connections = 0;
    const secure = await listenSecurePipe(path, () => {
      connections += 1;
    });
    cleanup.push(() => secure.close());

    await sleep(100);
    expect(connections).toBe(0);
    expect(findOwnPipeServerInstances(path).length).toBeGreaterThan(0);
    expect(findOwnPipeServerInstances(path).every((instance) => !instance.rejectsRemoteClients)).toBe(true);
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

  it('disconnects a client of another process that connected before the DACL, without relying on accept order', async () => {
    const path = pipePath();
    const marker = join(mkdtempSync(join(tmpdir(), 'vuyro-pipe-')), 'connected');
    const child = startClientProcess(path, marker);
    const received: string[] = [];
    const seen = { connections: 0 };
    const secure = await listenSecurePipe(path, recordInto(received, seen), {
      // Keeps this thread blocked, so Node dispatches nothing before the pipe is secured.
      afterListen: () => {
        waitForFileSync(marker, 10_000);
      },
      acceptClient: (client) => client.pid !== child.pid,
    });
    cleanup.push(() => secure.close());

    expect(secure.rejectedClients).toBe(1);
    expect(secure.droppedBeforeSecure).toBe(0);
    expect(await child.output).toBe('closed:'); // never got a reply
    await sleep(50);
    expect(received).toEqual([]); // and its early write was discarded
    expect(seen.connections).toBe(0); // the rejected socket never reached the handler
    expect(await roundTrip(path, 'still serving')).toBe('still serving');
    expect(received).toEqual(['still serving']);
    expect(seen.connections).toBe(1);
  }, 20_000);

  it('checks the client on every connection after securing', async () => {
    const path = pipePath();
    const received: string[] = [];
    const seen = { connections: 0 };
    let rejectedPid = -1;
    const secure = await listenSecurePipe(path, recordInto(received, seen), {
      acceptClient: (client) => client.pid !== rejectedPid,
    });
    cleanup.push(() => secure.close());

    const marker = join(mkdtempSync(join(tmpdir(), 'vuyro-pipe-')), 'connected');
    const child = startClientProcess(path, marker, { spawnOnly: true });
    rejectedPid = child.pid;
    child.start();
    expect(await child.output).toBe('closed:');
    expect(secure.rejectedClients).toBe(1);
    await sleep(50);
    expect(received).toEqual([]);
    expect(seen.connections).toBe(0); // rejected sockets are not handed to the handler
  }, 20_000);

  it('rejects a client whose process cannot be identified (fail closed)', async () => {
    const path = pipePath();
    const received: string[] = [];
    const seen = { connections: 0 };
    const secure = await listenSecurePipe(path, recordInto(received, seen));
    cleanup.push(() => secure.close());

    const lookup = vi.spyOn(win32(), 'GetNamedPipeClientProcessId').mockReturnValue(0);
    const result = await talkUntilClosed(path, 'hello');
    lookup.mockRestore();

    expect(result).toEqual({ closed: true, received: '' });
    expect(secure.rejectedClients).toBe(1);
    expect(seen.connections).toBe(0);
    expect(received).toEqual([]);
    expect(await roundTrip(path, 'after')).toBe('after');
  });

  it('does not hand off a connection that closes before sending anything', async () => {
    const path = pipePath();
    const seen = { connections: 0 };
    const secure = await listenSecurePipe(path, recordInto([], seen));
    cleanup.push(() => secure.close());

    const socket = await connect(path);
    socket.destroy();
    await sleep(100);
    expect(seen.connections).toBe(0);
    expect(secure.closedBeforeData).toBe(1);
  });

  it('destroys connections that Node dispatches before the pipe is secured', async () => {
    const path = pipePath();
    let early: net.Socket | undefined;
    const earlyClosed = new Promise<void>((resolve) => {
      void listenSecurePipe(path, echo, {
        afterListen: async () => {
          early = net.connect(path);
          early.on('error', () => undefined);
          early.on('close', () => {
            resolve();
          });
          await sleep(100); // lets Node dispatch the connection
        },
      }).then((secure) => {
        cleanup.push(() => secure.close());
        expect(secure.droppedBeforeSecure).toBe(1);
      });
    });
    await earlyClosed;
    expect(early).toBeDefined();
  });

  it('does not lose the first request when the handler attaches its listeners late', async () => {
    const path = pipePath();
    const secure = await listenSecurePipe(path, async (socket) => {
      await sleep(50);
      echo(socket);
    });
    cleanup.push(() => secure.close());

    expect(await roundTrip(path, 'first')).toBe('first');
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

/**
 * Failure injection: every step that could not verify a client must reject.
 * Win32 calls are replaced on the shared binding object returned by win32().
 */
describe.runIf(isWindows)('named pipe security fails closed', () => {
  const cleanup: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const fn of cleanup.splice(0).reverse()) await fn();
  });

  async function serve(options: SecurePipeServerOptions = {}) {
    const path = pipePath();
    const received: string[] = [];
    const seen = { connections: 0 };
    const secure = await listenSecurePipe(path, recordInto(received, seen), options);
    cleanup.push(() => secure.close());
    return { path, secure, received, seen };
  }

  /** The client is cut off without a reply and the handler never runs. */
  async function expectRejected(served: Awaited<ReturnType<typeof serve>>): Promise<void> {
    expect(await talkUntilClosed(served.path, 'hello')).toEqual({ closed: true, received: '' });
    expect(served.seen.connections).toBe(0);
    expect(served.received).toEqual([]);
  }

  /** Once the injected failure is gone, the server serves again. */
  async function expectRecovers(served: Awaited<ReturnType<typeof serve>>): Promise<void> {
    vi.restoreAllMocks();
    expect(await roundTrip(served.path, 'after')).toBe('after');
  }

  const w = isWindows ? win32() : undefined;
  const real = w === undefined ? undefined : { ...w };
  function binding() {
    if (w === undefined || real === undefined) throw new Error('Windows only');
    return { w, real };
  }

  /** True for a server instance that has a client: the one we want a check to miss. */
  function hasClient(handle: number): boolean {
    return binding().real.GetNamedPipeClientProcessId(handle, [0]) !== 0;
  }

  // --- discovery of our own server instances -----------------------------------------

  it('handle snapshot fails (NtQueryInformationProcess)', async () => {
    const served = await serve();
    vi.spyOn(binding().w, 'NtQueryInformationProcess').mockReturnValue(0xc0000022 | 0); // STATUS_ACCESS_DENIED
    await expectRejected(served);
    expect(served.secure.failedChecks).toBe(1);
    await expectRecovers(served);
  });

  it('file type cannot be read (GetFileType)', async () => {
    const served = await serve();
    const { w } = binding();
    const { real } = binding();
    // Fails only for the instance with the client, so the other instances still look complete.
    vi.spyOn(w, 'GetFileType').mockImplementation((handle) => (hasClient(handle) ? FILE_TYPE_UNKNOWN : real.GetFileType(handle)));
    vi.spyOn(w, 'GetLastError').mockReturnValue(ERROR_ACCESS_DENIED);
    await expectRejected(served);
    expect(served.secure.failedChecks).toBe(1);
    await expectRecovers(served);
  });

  it('pipe name cannot be read (GetFileInformationByHandleEx)', async () => {
    const served = await serve();
    const { w } = binding();
    const { real } = binding();
    vi.spyOn(w, 'GetFileInformationByHandleEx').mockImplementation((handle, ...rest) =>
      hasClient(handle) ? 0 : real.GetFileInformationByHandleEx(handle, ...rest),
    );
    vi.spyOn(w, 'GetLastError').mockReturnValue(ERROR_ACCESS_DENIED);
    await expectRejected(served);
    expect(served.secure.failedChecks).toBe(1);
    await expectRecovers(served);
  });

  it('pipe end cannot be read (GetNamedPipeInfo)', async () => {
    const served = await serve();
    const { w, real } = binding();
    vi.spyOn(w, 'GetNamedPipeInfo').mockImplementation((handle, ...rest) => (hasClient(handle) ? 0 : real.GetNamedPipeInfo(handle, ...rest)));
    await expectRejected(served);
    expect(served.secure.failedChecks).toBe(1);
    await expectRecovers(served);
  });

  it('pipe state cannot be read (NtQueryInformationFile)', async () => {
    const served = await serve();
    const { w, real } = binding();
    vi.spyOn(w, 'NtQueryInformationFile').mockImplementation((handle, ...rest) =>
      hasClient(handle) ? 0xc0000001 | 0 : real.NtQueryInformationFile(handle, ...rest), // STATUS_UNSUCCESSFUL
    );
    await expectRejected(served);
    expect(served.secure.failedChecks).toBe(1);
    await expectRecovers(served);
  });

  it('our instances are not found at all (fewer instances than open sockets)', async () => {
    const served = await serve();
    const { w, real } = binding();
    // Every handle now reports another name, so discovery returns nothing.
    vi.spyOn(w, 'GetFileInformationByHandleEx').mockImplementation((handle, cls, buffer, length) => {
      const ok = real.GetFileInformationByHandleEx(handle, cls, buffer, length);
      const other = Buffer.from('\\someone-else', 'utf16le');
      buffer.writeUInt32LE(other.length, 0);
      other.copy(buffer, 4);
      return ok;
    });
    await expectRejected(served);
    expect(served.secure.failedChecks).toBe(1);
    await expectRecovers(served);
  });

  it.each([
    ['closing', 4],
    ['an unknown', 9],
  ])('an instance in %s state is not served', async (_label, state) => {
    const served = await serve();
    const { w, real } = binding();
    vi.spyOn(w, 'NtQueryInformationFile').mockImplementation((handle, io, buffer, length, cls) => {
      const status = real.NtQueryInformationFile(handle, io, buffer, length, cls);
      buffer.writeUInt32LE(state, 32); // NamedPipeState
      return status;
    });
    await expectRejected(served);
    vi.restoreAllMocks();
  });

  // --- identifying the client ------------------------------------------------------

  it('client process id cannot be read (GetNamedPipeClientProcessId)', async () => {
    const served = await serve({ acceptClient: () => true });
    vi.spyOn(binding().w, 'GetNamedPipeClientProcessId').mockReturnValue(0);
    await expectRejected(served);
    expect(served.secure.rejectedClients).toBe(1);
    await expectRecovers(served);
  });

  it('client process cannot be opened (OpenProcess), even if acceptClient accepts everything', async () => {
    const served = await serve({ acceptClient: () => true });
    vi.spyOn(binding().w, 'OpenProcess').mockReturnValue(0);
    await expectRejected(served);
    expect(served.secure.rejectedClients).toBe(1);
    await expectRecovers(served);
  });

  it('client token cannot be read (OpenProcessToken)', async () => {
    const served = await serve({ acceptClient: () => true });
    vi.spyOn(binding().w, 'OpenProcessToken').mockReturnValue(0);
    await expectRejected(served);
    expect(served.secure.rejectedClients).toBe(1);
    await expectRecovers(served);
  });

  it('acceptClient throws', async () => {
    const served = await serve({
      acceptClient: () => {
        throw new Error('policy unavailable');
      },
    });
    await expectRejected(served);
    expect(served.secure.rejectedClients).toBe(1);
  });

  it('acceptClient returns something other than true', async () => {
    const served = await serve({ acceptClient: (() => 1) as unknown as (client: PipeClient) => boolean });
    await expectRejected(served);
    expect(served.secure.rejectedClients).toBe(1);
  });

  // --- acting on a rejection -----------------------------------------------------

  it('disconnecting a rejected client fails (DisconnectNamedPipe)', async () => {
    const served = await serve({ acceptClient: () => false });
    vi.spyOn(binding().w, 'DisconnectNamedPipe').mockReturnValue(0);
    await expectRejected(served);
    expect(served.secure.failedChecks).toBe(1);
    vi.restoreAllMocks();
  });

  // --- after the check ---------------------------------------------------------

  it('a client that stays silent is dropped after firstDataTimeoutMs', async () => {
    const served = await serve({ firstDataTimeoutMs: 100 });
    const socket = await connect(served.path);
    const closed = new Promise<void>((resolve) => socket.once('close', () => { resolve(); }));
    await closed;
    expect(served.seen.connections).toBe(0);
    expect(served.secure.closedBeforeData).toBe(1);
  });

  it('a handler that throws gets its socket destroyed', async () => {
    const path = pipePath();
    const secure = await listenSecurePipe(path, () => {
      throw new Error('handler failed');
    });
    cleanup.push(() => secure.close());
    expect(await talkUntilClosed(path, 'hello')).toEqual({ closed: true, received: '' });
  });

  // --- startup --------------------------------------------------------------------

  async function expectStartupFails(options: SecurePipeServerOptions = {}): Promise<void> {
    const path = pipePath();
    await expect(listenSecurePipe(path, echo, options)).rejects.toThrow();
    vi.restoreAllMocks();
    expect((await connectError(path)).code).toBe('ENOENT'); // the server was closed
  }

  it('startup: no instance handle found', async () => {
    const { w } = binding();
    vi.spyOn(w, 'GetFileInformationByHandleEx').mockImplementation((_handle, _cls, buffer) => {
      const other = Buffer.from('\\someone-else', 'utf16le');
      buffer.writeUInt32LE(other.length, 0);
      other.copy(buffer, 4);
      return 1;
    });
    await expectStartupFails();
  });

  it('startup: the DACL cannot be applied (SetSecurityInfo)', async () => {
    vi.spyOn(binding().w, 'SetSecurityInfo').mockReturnValue(ERROR_ACCESS_DENIED);
    await expectStartupFails();
  });

  it('startup: the DACL silently stays the default (read-back check)', async () => {
    vi.spyOn(binding().w, 'SetSecurityInfo').mockReturnValue(0); // "success" without applying
    await expectStartupFails();
  });

  it('startup: the DACL cannot be read back (GetSecurityInfo)', async () => {
    vi.spyOn(binding().w, 'GetSecurityInfo').mockReturnValue(ERROR_ACCESS_DENIED);
    await expectStartupFails();
  });

  it('startup: the initial client check cannot be completed', async () => {
    const { w, real } = binding();
    let applied = false;
    vi.spyOn(w, 'SetSecurityInfo').mockImplementation((...args) => {
      applied = true;
      return real.SetSecurityInfo(...args);
    });
    // Snapshots work until the DACL is in place, then the initial check's snapshot fails.
    vi.spyOn(w, 'NtQueryInformationProcess').mockImplementation((...args) =>
      applied ? 0xc0000022 | 0 : real.NtQueryInformationProcess(...args),
    );
    await expectStartupFails();
  });
});
