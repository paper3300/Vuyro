import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import net from 'node:net';

/**
 * Engine pipe authentication (decision C in 기술 스택 결정 §3/§14).
 *
 * The pipe itself is created by Node with the default descriptor, so other
 * users may be able to open it. Commands are only processed after the client
 * proved it knows the engine token, and the server proves the same to the
 * client, so a squatting server never learns the token:
 *
 *   C → S  {"type":"auth.hello","protocol":"vuyro-auth-1","nonce":<32 bytes hex>}
 *   S → C  {"type":"auth.challenge","nonce":<hex>,"proof":HMAC(token, "server", cN, sN)}
 *   C → S  {"type":"auth.response","proof":HMAC(token, "client", cN, sN)}
 *   S → C  {"type":"auth.ok"}            then application traffic (NDJSON)
 *
 * The server writes nothing before a well-formed hello, so a client that can
 * only read the pipe gets nothing. Proofs are compared in constant time. Any
 * malformed, oversized, late or wrong message closes the connection without a
 * reason; the handler is never called before `auth.ok`.
 */

export const AUTH_PROTOCOL = 'vuyro-auth-1';
const NONCE_BYTES = 32;

export interface AuthenticatedPipeServerOptions {
  /** Connections still authenticating at the same time; more are closed at once. Default 16. */
  readonly maxPendingAuth?: number;
  /** Time a client has to complete the handshake. Default 5000 ms. */
  readonly authTimeoutMs?: number;
  /** Bytes a client may send before it is authenticated. Default 2048. */
  readonly maxPreAuthBytes?: number;
}

export interface AuthStats {
  authenticated: number;
  /** Malformed messages, wrong protocol or a wrong proof. */
  rejected: number;
  timedOut: number;
  /** Closed because too many connections were authenticating. */
  overPendingLimit: number;
  /** Closed because the client sent too much before authenticating. */
  oversized: number;
}

export interface AuthenticatedPipeServer {
  readonly path: string;
  readonly server: net.Server;
  readonly stats: Readonly<AuthStats>;
  close(): Promise<void>;
}

/**
 * Listens on a named pipe and passes only authenticated sockets to `onConnection`.
 * The socket is paused with any bytes after the handshake buffered; it is resumed
 * once the handler returns or its promise settles. A handler that throws gets its
 * socket destroyed.
 */
export async function listenAuthenticatedPipe(
  pipePath: string,
  token: Buffer,
  onConnection: (socket: net.Socket) => Promise<void> | void,
  options: AuthenticatedPipeServerOptions = {},
): Promise<AuthenticatedPipeServer> {
  assertToken(token);
  const maxPending = options.maxPendingAuth ?? 16;
  const timeoutMs = options.authTimeoutMs ?? 5000;
  const maxBytes = options.maxPreAuthBytes ?? 2048;
  const stats: AuthStats = { authenticated: 0, rejected: 0, timedOut: 0, overPendingLimit: 0, oversized: 0 };
  let pending = 0;

  const server = net.createServer((socket) => {
    socket.on('error', () => undefined);
    if (pending >= maxPending) {
      stats.overPendingLimit += 1;
      socket.destroy();
      return;
    }
    pending += 1;
    let settled = false;
    let received = 0;
    let buffered = Buffer.alloc(0);
    let clientNonce: Buffer | undefined;
    let serverNonce: Buffer | undefined;

    const finish = (): void => {
      if (settled) return;
      settled = true;
      pending -= 1;
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('close', onClose);
    };
    const fail = (counter: keyof AuthStats): void => {
      if (settled) return;
      finish();
      stats[counter] += 1;
      socket.destroy();
    };
    const timer = setTimeout(() => {
      fail('timedOut');
    }, timeoutMs);
    const onClose = (): void => {
      finish();
    };

    const onLine = (line: string): 'continue' | 'rejected' | 'authenticated' => {
      const message = parseMessage(line);
      if (clientNonce === undefined) {
        if (message?.type !== 'auth.hello' || message.protocol !== AUTH_PROTOCOL) return reject();
        const nonce = hexBytes(message.nonce, NONCE_BYTES);
        if (nonce === undefined) return reject();
        clientNonce = nonce;
        serverNonce = randomBytes(NONCE_BYTES);
        send(socket, { type: 'auth.challenge', nonce: serverNonce.toString('hex'), proof: proof(token, 'server', clientNonce, serverNonce).toString('hex') });
        return 'continue';
      }
      if (message?.type !== 'auth.response' || serverNonce === undefined) return reject();
      const given = hexBytes(message.proof, 32);
      if (given === undefined || !timingSafeEqual(given, proof(token, 'client', clientNonce, serverNonce))) return reject();
      return 'authenticated';
    };
    const reject = (): 'rejected' => {
      fail('rejected');
      return 'rejected';
    };

    const onData = (chunk: Buffer): void => {
      if (settled) return;
      received += chunk.length;
      if (received > maxBytes) {
        fail('oversized');
        return;
      }
      buffered = Buffer.concat([buffered, chunk]);
      for (let newline = buffered.indexOf(0x0a); newline !== -1; newline = buffered.indexOf(0x0a)) {
        const line = buffered.subarray(0, newline).toString('utf8');
        buffered = buffered.subarray(newline + 1);
        const outcome = onLine(line);
        if (outcome === 'rejected') return;
        if (outcome === 'authenticated') {
          socket.pause();
          finish();
          stats.authenticated += 1;
          send(socket, { type: 'auth.ok' });
          if (buffered.length > 0) socket.unshift(buffered);
          void handOff(socket, onConnection);
          return;
        }
      }
    };

    socket.on('data', onData);
    socket.on('close', onClose);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(pipePath, () => {
      server.off('error', reject);
      resolve();
    });
  });

  return {
    path: pipePath,
    server,
    stats,
    close: () =>
      new Promise((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
}

export interface ConnectOptions {
  /** Time the server has to complete the handshake. Default 5000 ms. */
  readonly timeoutMs?: number;
}

/**
 * Connects to the engine pipe and runs the handshake. Resolves with a paused
 * socket ready for application traffic; rejects if the server cannot prove it
 * knows the token (a squatter) or does not answer in time.
 */
export async function connectAuthenticatedPipe(pipePath: string, token: Buffer, options: ConnectOptions = {}): Promise<net.Socket> {
  assertToken(token);
  return new Promise((resolve, reject) => {
    const socket = net.connect(pipePath);
    const clientNonce = randomBytes(NONCE_BYTES);
    let serverNonce: Buffer | undefined;
    let buffered = Buffer.alloc(0);
    let done = false;

    const fail = (error: Error): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      reject(error);
    };
    const timer = setTimeout(() => {
      fail(new Error('Engine pipe handshake timed out'));
    }, options.timeoutMs ?? 5000);

    const onLine = (line: string): boolean => {
      const message = parseMessage(line);
      if (serverNonce === undefined) {
        const nonce = message?.type === 'auth.challenge' ? hexBytes(message.nonce, NONCE_BYTES) : undefined;
        const given = message?.type === 'auth.challenge' ? hexBytes(message.proof, 32) : undefined;
        if (nonce === undefined || given === undefined || !timingSafeEqual(given, proof(token, 'server', clientNonce, nonce))) {
          fail(new Error('Engine pipe server failed to prove the token'));
          return false;
        }
        serverNonce = nonce;
        send(socket, { type: 'auth.response', proof: proof(token, 'client', clientNonce, serverNonce).toString('hex') });
        return false;
      }
      if (message?.type !== 'auth.ok') {
        fail(new Error('Engine pipe rejected the handshake'));
        return false;
      }
      return true;
    };

    const onData = (chunk: Buffer): void => {
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.length > 4096) {
        fail(new Error('Engine pipe handshake reply too large'));
        return;
      }
      for (let newline = buffered.indexOf(0x0a); newline !== -1 && !done; newline = buffered.indexOf(0x0a)) {
        const line = buffered.subarray(0, newline).toString('utf8');
        buffered = buffered.subarray(newline + 1);
        if (onLine(line)) {
          done = true;
          clearTimeout(timer);
          socket.pause();
          socket.off('data', onData);
          socket.off('close', onClose);
          socket.off('error', onError); // from here on errors belong to the caller
          if (buffered.length > 0) socket.unshift(buffered);
          resolve(socket);
        }
      }
    };
    const onClose = (): void => {
      fail(new Error('Engine pipe closed during the handshake'));
    };

    const onError = (error: Error): void => {
      fail(error);
    };
    socket.on('error', onError);
    socket.on('close', onClose);
    socket.on('data', onData);
    socket.once('connect', () => {
      send(socket, { type: 'auth.hello', protocol: AUTH_PROTOCOL, nonce: clientNonce.toString('hex') });
    });
  });
}

function proof(token: Buffer, role: 'server' | 'client', clientNonce: Buffer, serverNonce: Buffer): Buffer {
  return createHmac('sha256', token).update(`${AUTH_PROTOCOL}\0${role}\0`).update(clientNonce).update(serverNonce).digest();
}

interface AuthMessage {
  readonly type?: unknown;
  readonly protocol?: unknown;
  readonly nonce?: unknown;
  readonly proof?: unknown;
}

function parseMessage(line: string): AuthMessage | undefined {
  try {
    const value: unknown = JSON.parse(line);
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Exactly `bytes` bytes of lowercase hex, else undefined. */
function hexBytes(value: unknown, bytes: number): Buffer | undefined {
  if (typeof value !== 'string' || value.length !== bytes * 2 || !/^[0-9a-f]+$/.test(value)) return undefined;
  return Buffer.from(value, 'hex');
}

function send(socket: net.Socket, message: Record<string, string>): void {
  socket.write(`${JSON.stringify(message)}\n`);
}

function assertToken(token: Buffer): void {
  if (token.length < 16) throw new Error('Engine token must be at least 16 bytes');
}

async function handOff(socket: net.Socket, onConnection: (socket: net.Socket) => Promise<void> | void): Promise<void> {
  try {
    await onConnection(socket);
  } catch {
    socket.destroy();
    return;
  }
  // Respect handlers that consume the stream themselves ('readable', pipe(), resume()).
  if (!socket.destroyed && socket.readableFlowing !== true && socket.listenerCount('readable') === 0) socket.resume();
}
