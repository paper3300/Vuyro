import { randomBytes } from 'node:crypto';
import net from 'node:net';
import {
  allowedTrustees,
  currentUserOnlySddl,
  getCurrentUserSid,
  type PipeSecurity,
  setPipeDacl,
  writeToPipe,
} from '../platform/win32/pipe-security.ts';

/**
 * Named pipe server that only accepts connections from the current Windows user.
 *
 * Node creates the pipe with the default descriptor, which also grants read
 * access to Everyone and Anonymous. We replace the DACL right after `listen`,
 * which leaves a short window in which someone else could already connect.
 * To close it, every connection accepted before the DACL was in place is dropped:
 *
 * 1. listen (libuv uses FILE_FLAG_FIRST_PIPE_INSTANCE, so a squatted name fails here)
 * 2. replace the DACL and verify it through the same client handle
 * 3. connect once more and send a random nonce (this connection is subject to the new DACL)
 * 4. connections accepted up to and including the nonce connection are destroyed;
 *    only later ones reach `onConnection`
 *
 * Accept order equals connect order because libuv takes pipe connections off a
 * single I/O completion port in FIFO order.
 */

export interface SecurePipeServerOptions {
  /** DACL to apply. Defaults to the current user only, remote logons denied. */
  readonly sddl?: string;
  /** How long to wait for our own gate connection. Default 5000 ms. */
  readonly gateTimeoutMs?: number;
  /** Test seam: runs after `listen` and before the DACL is replaced. */
  readonly afterListen?: () => void;
}

export interface SecurePipeServer {
  readonly path: string;
  readonly server: net.Server;
  /** Descriptor read back after the DACL was applied. */
  readonly security: PipeSecurity;
  /** Connections dropped because they were accepted before the gate (includes our own DACL connection). */
  readonly droppedBeforeGate: number;
  close(): Promise<void>;
}

interface EarlyConnection {
  readonly socket: net.Socket;
  readonly chunks: Buffer[];
  length: number;
  stopInspecting: () => void;
  release: () => void;
}

const NONCE_BYTES = 32;

export async function listenSecurePipe(
  pipePath: string,
  onConnection: (socket: net.Socket) => void,
  options: SecurePipeServerOptions = {},
): Promise<SecurePipeServer> {
  if (process.platform !== 'win32') {
    throw new Error('listenSecurePipe is only implemented for Windows named pipes');
  }
  const userSid = getCurrentUserSid();
  const sddl = options.sddl ?? currentUserOnlySddl(userSid);
  const nonce = randomBytes(NONCE_BYTES);
  const server = net.createServer({ pauseOnConnect: true });

  const early: EarlyConnection[] = [];
  let gateOpen = false;
  let droppedBeforeGate = 0;
  let gateResolved: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    gateResolved = resolve;
  });

  const handOff = (socket: net.Socket): void => {
    onConnection(socket);
    if (socket.listenerCount('readable') === 0) socket.resume();
  };

  const openGate = (nonceIndex: number): void => {
    gateOpen = true;
    early.forEach((connection, index) => {
      connection.stopInspecting();
      if (index <= nonceIndex) {
        connection.socket.destroy();
        if (index < nonceIndex) droppedBeforeGate += 1;
        return;
      }
      connection.release();
      if (connection.length > 0) connection.socket.unshift(Buffer.concat(connection.chunks));
      handOff(connection.socket);
    });
    early.length = 0;
    gateResolved();
  };

  const inspect = (socket: net.Socket): void => {
    const connection: EarlyConnection = {
      socket,
      chunks: [],
      length: 0,
      stopInspecting: () => undefined,
      release: () => undefined,
    };
    const index = early.push(connection) - 1;
    const onReadable = (): void => {
      let chunk: unknown;
      while (connection.length < NONCE_BYTES && (chunk = socket.read()) !== null) {
        const buffer = chunk as Buffer;
        connection.chunks.push(buffer);
        connection.length += buffer.length;
      }
      if (connection.length < NONCE_BYTES) return;
      connection.stopInspecting();
      if (Buffer.concat(connection.chunks).subarray(0, NONCE_BYTES).equals(nonce)) openGate(index);
    };
    const onError = (): void => undefined;
    socket.on('readable', onReadable);
    socket.on('error', onError);
    connection.stopInspecting = () => {
      socket.off('readable', onReadable);
    };
    // Untrusted sockets keep a no-op error handler until they are destroyed.
    connection.release = () => {
      socket.off('error', onError);
    };
  };

  server.on('connection', (socket) => {
    if (gateOpen) handOff(socket);
    else inspect(socket);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(pipePath, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const close = (): Promise<void> =>
    new Promise((resolve) => {
      for (const connection of early) connection.socket.destroy();
      server.close(() => {
        resolve();
      });
    });

  let security: PipeSecurity;
  try {
    options.afterListen?.();
    security = setPipeDacl(pipePath, sddl);
    const trustees = allowedTrustees(security.sddl);
    if (options.sddl === undefined && (trustees.length !== 1 || trustees[0] !== userSid)) {
      throw new Error(`Pipe DACL was not restricted to the current user: ${security.sddl}`);
    }
    writeToPipe(pipePath, nonce);
    await withTimeout(gate, options.gateTimeoutMs ?? 5000, 'Timed out waiting for the pipe gate connection');
  } catch (error) {
    await close();
    throw error;
  }

  return {
    path: pipePath,
    server,
    security,
    get droppedBeforeGate() {
      return droppedBeforeGate;
    },
    close,
  };
}

async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(message));
    }, ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
