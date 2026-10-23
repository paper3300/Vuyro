import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AUTH_PROTOCOL,
  type AuthenticatedPipeServerOptions,
  connectAuthenticatedPipe,
  listenAuthenticatedPipe,
} from '../src/ipc/pipe-auth.ts';

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

describe.runIf(isWindows)('authenticated engine pipe', () => {
  const cleanup: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) await fn();
  });

  async function serve(options: AuthenticatedPipeServerOptions = {}) {
    const path = pipePath();
    const token = randomBytes(32);
    const { seen, handler } = recorder();
    const server = await listenAuthenticatedPipe(path, token, handler, options);
    cleanup.push(() => server.close());
    return { path, token, seen, server };
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
    const path = pipePath();
    const token = randomBytes(32);
    const server = await listenAuthenticatedPipe(path, token, async (socket) => {
      await sleep(50);
      socket.on('data', (chunk) => socket.write(chunk));
    });
    cleanup.push(() => server.close());
    const socket = await connectAuthenticatedPipe(path, token);
    cleanup.push(() => {
      socket.destroy();
    });
    expect(await roundTrip(socket, 'early\n')).toBe('early\n');
  });

  it('destroys the socket of a handler that throws', async () => {
    const path = pipePath();
    const token = randomBytes(32);
    const server = await listenAuthenticatedPipe(path, token, () => {
      throw new Error('handler failed');
    });
    cleanup.push(() => server.close());
    const socket = await connectAuthenticatedPipe(path, token);
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
    await expect(listenAuthenticatedPipe(served.path, randomBytes(32), () => undefined)).rejects.toMatchObject({
      code: 'EADDRINUSE',
    });
  });

  it('refuses tokens that are too short', async () => {
    await expect(listenAuthenticatedPipe(pipePath(), Buffer.alloc(8), () => undefined)).rejects.toThrow(/at least 16 bytes/);
    await expect(connectAuthenticatedPipe(pipePath(), Buffer.alloc(8))).rejects.toThrow(/at least 16 bytes/);
  });
});
