import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEngineToken, type VerifiedEngineToken } from '../src/ipc/engine-token.ts';
import {
  AUTH_PROTOCOL,
  type AuthenticatedPipeServerOptions,
  connectAuthenticatedPipe,
  type EnginePipeOptions,
  listenAuthenticatedPipe,
  startEnginePipe,
} from '../src/ipc/pipe-auth.ts';
import { ERROR_ACCESS_DENIED, win32 } from '../src/platform/win32/ffi.ts';
import { getCurrentUserSid, setFileDacl } from '../src/platform/win32/security.ts';

const isWindows = process.platform === 'win32';

function pipePath(): string {
  return String.raw`\\.\pipe\vuyro-test-` + randomUUID();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function proof(token: Buffer, role: 'server' | 'client', clientNonce: Buffer, serverNonce: Buffer): string {
  return createHmac('sha256', token).update(`${AUTH_PROTOCOL}\0${role}\0`).update(clientNonce).update(serverNonce).digest('hex');
}

/** Echo handler that records what it receives and how often it was called. */
function recorder() {
  const seen = { connections: 0, received: [] as string[] };
  const handler = (socket: net.Socket): void => {
    seen.connections += 1;
    socket.on('data', (chunk) => {
      seen.received.push(chunk.toString());
      socket.write(chunk);
    });
    socket.on('error', () => undefined);
  };
  return { seen, handler };
}

/** A hand-driven client for protocol-level tests. */
async function rawClient(path: string) {
  const socket = net.connect(path);
  socket.on('error', () => undefined);
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => {
      resolve();
    });
    socket.once('error', reject);
  });
  let text = '';
  let closed = false;
  socket.on('data', (chunk) => (text += chunk.toString()));
  const closedPromise = new Promise<void>((resolve) =>
    socket.once('close', () => {
      closed = true;
      resolve();
    }),
  );
  return {
    socket,
    send: (data: string) => socket.write(data),
    /** Waits for the next line, or undefined if the server closes first. */
    async line(timeoutMs = 2000): Promise<string | undefined> {
      const deadline = Date.now() + timeoutMs;
      while (!text.includes('\n')) {
        if (closed || Date.now() > deadline) return undefined;
        await sleep(5);
      }
      const index = text.indexOf('\n');
      const line = text.slice(0, index);
      text = text.slice(index + 1);
      return line;
    },
    get text() {
      return text;
    },
    closed: closedPromise,
    get isClosed() {
      return closed;
    },
  };
}

async function writeUntilClosed(client: Awaited<ReturnType<typeof rawClient>>, data: string, timeoutMs = 2000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!client.isClosed && Date.now() < deadline) {
    client.send(data);
    await sleep(20);
  }
  return client.isClosed;
}

/** Fails if anything listens on `path`. */
async function expectNotListening(path: string): Promise<void> {
  const code = await new Promise<string | undefined>((resolve) => {
    const socket = net.connect(path);
    socket.once('connect', () => {
      socket.destroy();
      resolve('connected');
    });
    socket.once('error', (error: NodeJS.ErrnoException) => {
      resolve(error.code);
    });
  });
  expect(code).toBe('ENOENT');
}

describe.runIf(isWindows)('authenticated engine pipe', () => {
  const cleanup: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const fn of cleanup.splice(0).reverse()) await fn();
  });

  function tokenPath(): string {
    const dir = mkdtempSync(join(tmpdir(), 'vuyro-pipe-token-'));
    cleanup.push(() => {
      rmSync(dir, { recursive: true, force: true });
    });
    return join(dir, 'engine.token');
  }

  async function start(
    handler: (socket: net.Socket) => Promise<void> | void,
    options: EnginePipeOptions = {},
    path = pipePath(),
  ) {
    const server = await startEnginePipe(path, handler, { tokenPath: tokenPath(), ...options });
    cleanup.push(() => server.close());
    return server;
  }

  async function serve(options: AuthenticatedPipeServerOptions = {}) {
    const path = pipePath();
    const { seen, handler } = recorder();
    const server = await start(handler, options, path);
    return { path, token: server.token.secret, seen, server };
  }

  async function roundTrip(socket: net.Socket, text: string): Promise<string> {
    return new Promise((resolve, reject) => {
      socket.once('data', (chunk) => {
        resolve(chunk.toString());
      });
      socket.once('error', reject);
      socket.resume();
      socket.write(text);
    });
  }

  it('serves a client that knows the token', async () => {
    const served = await serve();
    const socket = await connectAuthenticatedPipe(served.path, served.token);
    cleanup.push(() => {
      socket.destroy();
    });
    expect(await roundTrip(socket, 'hello\n')).toBe('hello\n');
    expect(served.seen.connections).toBe(1);
    expect(served.server.stats.authenticated).toBe(1);
  });

  it('writes nothing before a valid hello (read-only openers learn nothing)', async () => {
    const served = await serve();
    const client = await rawClient(served.path);
    await sleep(150);
    expect(client.text).toBe('');
    client.socket.destroy();
  });

  it('rejects a wrong client proof without calling the handler', async () => {
    const served = await serve();
    const client = await rawClient(served.path);
    const clientNonce = randomBytes(32);
    client.send(`${JSON.stringify({ type: 'auth.hello', protocol: AUTH_PROTOCOL, nonce: clientNonce.toString('hex') })}\n`);
    const challenge = JSON.parse((await client.line()) ?? 'null') as { type: string; nonce: string; proof: string };
    expect(challenge.type).toBe('auth.challenge');
    // The server proved itself with the real token.
    expect(challenge.proof).toBe(proof(served.token, 'server', clientNonce, Buffer.from(challenge.nonce, 'hex')));

    const wrong = proof(randomBytes(32), 'client', clientNonce, Buffer.from(challenge.nonce, 'hex'));
    client.send(`${JSON.stringify({ type: 'auth.response', proof: wrong })}\nrequest\n`);
    await client.closed;
    expect(await client.line(10)).toBeUndefined();
    expect(served.seen.connections).toBe(0);
    expect(served.seen.received).toEqual([]);
    expect(served.server.stats.rejected).toBe(1);
  });

  it('rejects a client with the wrong token', async () => {
    const served = await serve();
    // The client cannot verify the server's proof and gives up before sending its own.
    await expect(connectAuthenticatedPipe(served.path, randomBytes(32))).rejects.toThrow(/failed to prove/);
    expect(served.seen.connections).toBe(0);
  });

  it.each([
    ['not JSON', 'hello there\n'],
    ['a JSON array', '[1,2]\n'],
    ['the wrong protocol', `${JSON.stringify({ type: 'auth.hello', protocol: 'other', nonce: '00'.repeat(32) })}\n`],
    ['a short nonce', `${JSON.stringify({ type: 'auth.hello', protocol: AUTH_PROTOCOL, nonce: 'ab' })}\n`],
    ['an uppercase nonce', `${JSON.stringify({ type: 'auth.hello', protocol: AUTH_PROTOCOL, nonce: 'AB'.repeat(32) })}\n`],
    ['a response before hello', `${JSON.stringify({ type: 'auth.response', proof: '00'.repeat(32) })}\n`],
  ])('closes the connection on %s', async (_label, data) => {
    const served = await serve();
    const client = await rawClient(served.path);
    client.send(data);
    await client.closed;
    expect(client.text).toBe('');
    expect(served.seen.connections).toBe(0);
    expect(served.server.stats.rejected).toBe(1);
  });

  it('closes a client that sends a malformed proof (wrong length) without throwing', async () => {
    const served = await serve();
    const client = await rawClient(served.path);
    client.send(`${JSON.stringify({ type: 'auth.hello', protocol: AUTH_PROTOCOL, nonce: '11'.repeat(32) })}\n`);
    await client.line();
    client.send(`${JSON.stringify({ type: 'auth.response', proof: 'ab'.repeat(16) })}\n`);
    await client.closed;
    expect(served.server.stats.rejected).toBe(1);
  });

  it('closes a client that sends too much before authenticating', async () => {
    const served = await serve({ maxPreAuthBytes: 512 });
    const client = await rawClient(served.path);
    expect(await writeUntilClosed(client, 'x'.repeat(256))).toBe(true);
    expect(served.server.stats.oversized).toBe(1);
    expect(served.seen.connections).toBe(0);
  });

  it('closes a client that does not finish in time', async () => {
    const served = await serve({ authTimeoutMs: 100 });
    const client = await rawClient(served.path);
    await client.closed;
    expect(served.server.stats.timedOut).toBe(1);
    expect(served.seen.connections).toBe(0);
  });

  it('limits connections that are still authenticating', async () => {
    const served = await serve({ maxPendingAuth: 2 });
    const idle = [await rawClient(served.path), await rawClient(served.path)];
    const third = await rawClient(served.path);
    expect(await writeUntilClosed(third, 'x')).toBe(true);
    expect(served.server.stats.overPendingLimit).toBe(1);

    for (const client of idle) client.socket.destroy();
    await sleep(50);
    const socket = await connectAuthenticatedPipe(served.path, served.token);
    socket.destroy();
    expect(served.server.stats.authenticated).toBe(1);
  });

  it('passes bytes sent right after the handshake to the handler', async () => {
    const served = await serve();
    const client = await rawClient(served.path);
    const clientNonce = randomBytes(32);
    client.send(`${JSON.stringify({ type: 'auth.hello', protocol: AUTH_PROTOCOL, nonce: clientNonce.toString('hex') })}\n`);
    const challenge = JSON.parse((await client.line()) ?? 'null') as { nonce: string };
    const response = proof(served.token, 'client', clientNonce, Buffer.from(challenge.nonce, 'hex'));
    client.send(`${JSON.stringify({ type: 'auth.response', proof: response })}\nfirst request\n`);
    expect(await client.line()).toBe(JSON.stringify({ type: 'auth.ok' }));
    expect(await client.line()).toBe('first request');
    client.socket.destroy();
  });

  it('does not lose the first request when the handler attaches its listeners late', async () => {
    const server = await start(async (socket) => {
      await sleep(50);
      socket.on('data', (chunk) => socket.write(chunk));
    });
    const socket = await connectAuthenticatedPipe(server.path, server.token.secret);
    cleanup.push(() => {
      socket.destroy();
    });
    expect(await roundTrip(socket, 'early\n')).toBe('early\n');
  });

  it('destroys the socket of a handler that throws', async () => {
    const server = await start(() => {
      throw new Error('handler failed');
    });
    const socket = await connectAuthenticatedPipe(server.path, server.token.secret);
    socket.on('error', () => undefined);
    socket.resume();
    await new Promise<void>((resolve) => socket.once('close', () => { resolve(); }));
  });

  it('client refuses a squatting server and never sends it a proof', async () => {
    const path = pipePath();
    const lines: string[] = [];
    const fake = net.createServer((socket) => {
      socket.on('error', () => undefined);
      socket.on('data', (chunk) => {
        lines.push(...chunk.toString().split('\n').filter(Boolean));
        socket.write(`${JSON.stringify({ type: 'auth.challenge', nonce: '22'.repeat(32), proof: '33'.repeat(32) })}\n`);
      });
    });
    await new Promise<void>((resolve) => fake.listen(path, resolve));
    cleanup.push(() => new Promise<void>((resolve) => fake.close(() => { resolve(); })));

    await expect(connectAuthenticatedPipe(path, randomBytes(32))).rejects.toThrow(/failed to prove/);
    await sleep(50);
    expect(lines.map((line) => (JSON.parse(line) as { type: string }).type)).toEqual(['auth.hello']);
  });

  it('client gives up on a server that never answers', async () => {
    const path = pipePath();
    const accepted: net.Socket[] = [];
    const silent = net.createServer((socket) => {
      socket.on('error', () => undefined);
      accepted.push(socket);
    });
    await new Promise<void>((resolve) => silent.listen(path, resolve));
    cleanup.push(() => new Promise<void>((resolve) => silent.close(() => { resolve(); })));
    cleanup.push(() => {
      for (const socket of accepted) socket.destroy(); // a non-reading server never notices the client left
    });
    await expect(connectAuthenticatedPipe(path, randomBytes(32), { timeoutMs: 100 })).rejects.toThrow(/timed out/);
  });

  it('refuses to listen on a name that already exists (squatting, second instance)', async () => {
    const served = await serve();
    await expect(startEnginePipe(served.path, () => undefined, { tokenPath: tokenPath() })).rejects.toMatchObject({
      code: 'EADDRINUSE',
    });
  });

  it('client refuses tokens that are too short', async () => {
    await expect(connectAuthenticatedPipe(pipePath(), Buffer.alloc(8))).rejects.toThrow(/at least 16 bytes/);
  });

  // --- [1] no listening without a verified token file ---------------------------------

  it('does not listen when the token file ACL cannot be applied', async () => {
    const path = pipePath();
    const file = tokenPath();
    vi.spyOn(win32(), 'SetSecurityInfo').mockReturnValue(ERROR_ACCESS_DENIED);
    await expect(startEnginePipe(path, () => undefined, { tokenPath: file })).rejects.toThrow(/SetSecurityInfo/);
    vi.restoreAllMocks();
    await expectNotListening(path);
    expect(existsSync(file)).toBe(false);
  });

  it('does not listen when the token file ACL silently stays inherited', async () => {
    const path = pipePath();
    vi.spyOn(win32(), 'SetSecurityInfo').mockReturnValue(0); // "success" without applying
    await expect(startEnginePipe(path, () => undefined, { tokenPath: tokenPath() })).rejects.toThrow(/not restricted/);
    vi.restoreAllMocks();
    await expectNotListening(path);
  });

  it.each([
    ['a raw Buffer', () => randomBytes(32)],
    ['a look-alike object', () => ({ path: 'x', secret: randomBytes(32) })],
  ])('refuses to listen with %s instead of an issued token', async (_label, forge) => {
    const path = pipePath();
    const forged = forge() as unknown as VerifiedEngineToken;
    await expect(listenAuthenticatedPipe(path, forged, () => undefined)).rejects.toThrow(/Not an engine token/);
    await expectNotListening(path);
  });

  it('refuses to listen when the issued token file was opened up afterwards', async () => {
    const path = pipePath();
    const token = createEngineToken(tokenPath());
    setFileDacl(token.path, `D:P(A;;FA;;;${getCurrentUserSid()})(A;;FR;;;WD)`); // Everyone may read
    await expect(listenAuthenticatedPipe(path, token, () => undefined)).rejects.toThrow(/not current-user-only/);
    await expectNotListening(path);
  });

  it('refuses to listen when the issued token file now holds another secret', async () => {
    const path = pipePath();
    const token = createEngineToken(tokenPath());
    writeFileSync(token.path, randomBytes(32).toString('hex'));
    await expect(listenAuthenticatedPipe(path, token, () => undefined)).rejects.toThrow(/no longer holds this token/);
    await expectNotListening(path);
  });

  it('refuses to listen when the issued token file is gone', async () => {
    const path = pipePath();
    const token = createEngineToken(tokenPath());
    rmSync(token.path);
    await expect(listenAuthenticatedPipe(path, token, () => undefined)).rejects.toThrow();
    await expectNotListening(path);
  });

  // --- [2] limits must be positive integers -----------------------------------------

  const badValues: unknown[] = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0, -1, 1.5, '16', null];
  const limitCases = (['maxPendingAuth', 'maxPreAuthBytes', 'authTimeoutMs'] as const).flatMap((name) =>
    badValues.map((value) => [name, value] as const),
  );

  it.each(limitCases)('refuses to start with %s = %s (before writing a token)', async (name, value) => {
    const path = pipePath();
    const file = tokenPath();
    const options = { tokenPath: file, [name]: value } as unknown as EnginePipeOptions;
    await expect(startEnginePipe(path, () => undefined, options)).rejects.toThrow(RangeError);
    await expectNotListening(path);
    expect(existsSync(file)).toBe(false);
  });

  it.each(limitCases)('listenAuthenticatedPipe also refuses %s = %s', async (name, value) => {
    const path = pipePath();
    const token = createEngineToken(tokenPath());
    const options = { [name]: value } as unknown as AuthenticatedPipeServerOptions;
    await expect(listenAuthenticatedPipe(path, token, () => undefined, options)).rejects.toThrow(RangeError);
    await expectNotListening(path);
  });

  it('refuses an auth timeout longer than setTimeout supports', async () => {
    await expect(startEnginePipe(pipePath(), () => undefined, { tokenPath: tokenPath(), authTimeoutMs: 2 ** 31 })).rejects.toThrow(RangeError);
  });

  it.each(badValues)('client refuses timeoutMs = %s', async (value) => {
    const options = { timeoutMs: value } as unknown as { timeoutMs: number };
    await expect(connectAuthenticatedPipe(pipePath(), randomBytes(32), options)).rejects.toThrow(RangeError);
  });

  // --- [recommended] only handshake bytes count toward the pre-auth limit ------------

  it('accepts a 3 KiB first request sent right after the response', async () => {
    const served = await serve({ maxPreAuthBytes: 2048 });
    const client = await rawClient(served.path);
    const clientNonce = randomBytes(32);
    client.send(`${JSON.stringify({ type: 'auth.hello', protocol: AUTH_PROTOCOL, nonce: clientNonce.toString('hex') })}\n`);
    const challenge = JSON.parse((await client.line()) ?? 'null') as { nonce: string };
    const response = proof(served.token, 'client', clientNonce, Buffer.from(challenge.nonce, 'hex'));
    const request = 'r'.repeat(3 * 1024);
    client.send(`${JSON.stringify({ type: 'auth.response', proof: response })}\n${request}\n`);
    expect(await client.line()).toBe(JSON.stringify({ type: 'auth.ok' }));
    expect(await client.line()).toBe(request);
    expect(served.server.stats.oversized).toBe(0);
    client.socket.destroy();
  });

  it('still counts a long handshake line that ends with a newline', async () => {
    const served = await serve({ maxPreAuthBytes: 512 });
    const client = await rawClient(served.path);
    client.send(`${JSON.stringify({ type: 'auth.hello', protocol: AUTH_PROTOCOL, nonce: '11'.repeat(32), pad: 'x'.repeat(600) })}\n`);
    await client.closed;
    expect(client.text).toBe('');
    expect(served.server.stats.oversized).toBe(1);
  });
});
