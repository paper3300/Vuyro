import net from 'node:net';
import {
  allowedTrustees,
  currentUserOnlySddl,
  disconnectPipeInstance,
  findOwnPipeServerInstances,
  getCurrentUserSid,
  getProcessUserSid,
  type PipeSecurity,
  type PipeServerInstance,
  setPipeDaclOnHandle,
} from '../platform/win32/pipe-security.ts';

/**
 * Named pipe server that only serves the current Windows user.
 *
 * Node creates the pipe with the default descriptor, which also grants read
 * access to Everyone and Anonymous, and offers no way to pass another one.
 * Three measures close that gap without relying on accept order:
 *
 * 1. DACL: right after `listen`, the DACL is replaced through one of our own server
 *    instance handles (found in this process's handle table) and read back. The
 *    descriptor is shared by all instances, so from then on the OS refuses other
 *    users at open time.
 * 2. Client check: after the DACL is applied and again whenever a connection
 *    arrives, every occupied instance's client process is identified
 *    (GetNamedPipeClientProcessId → process token user SID). Instances that are not
 *    positively accepted are disconnected at the OS level, which discards unread
 *    data. Sockets start paused, so nothing is read before the check has run.
 * 3. Hand-off on first data: Node does not expose which OS instance a socket uses,
 *    so a socket is only passed to `onConnection` once it delivers data. A
 *    disconnected (rejected) instance can never deliver data, its read fails, and
 *    the socket is dropped without reaching the handler.
 *
 * Everything fails closed: a step that cannot be completed or verified rejects
 * instead of letting a connection through.
 * - Startup: any failure (no instance found, DACL not applied or not as expected,
 *   initial check incomplete) closes the server and rejects.
 * - Per connection: if the check is incomplete (discovery error, fewer instances
 *   found than open sockets, a disconnect that failed), the arriving socket is
 *   destroyed (`failedChecks`).
 * - Per instance: unknown pipe state, missing client pid, SID lookup failure,
 *   `acceptClient` returning anything but `true` or throwing → rejected.
 * - Sockets that close, error or stay silent past `firstDataTimeoutMs` before
 *   their first data are dropped; a handler that throws gets its socket destroyed.
 * - Connections that Node dispatches before the server is secured are destroyed.
 */

export interface PipeClient {
  readonly pid: number;
  readonly userSid: string;
}

export interface SecurePipeServerOptions {
  /** DACL to apply. Defaults to the current user only, remote logons denied. */
  readonly sddl?: string;
  /**
   * Which identified clients to serve. Defaults to processes running as the
   * current user. Only a returned `true` accepts; clients that cannot be
   * identified are rejected before this is called.
   */
  readonly acceptClient?: (client: PipeClient) => boolean;
  /** A socket that sends nothing for this long is dropped. Default 30000 ms. */
  readonly firstDataTimeoutMs?: number;
  /** Test seam: runs after `listen` and before the pipe is secured. */
  readonly afterListen?: () => Promise<void> | void;
}

export interface SecurePipeServer {
  readonly path: string;
  readonly server: net.Server;
  /** Descriptor read back after the DACL was applied. */
  readonly security: PipeSecurity;
  /** Connections destroyed because Node dispatched them before the pipe was secured. */
  readonly droppedBeforeSecure: number;
  /** Client instances disconnected by the client check (not accepted or not identifiable). */
  readonly rejectedClients: number;
  /** Arriving sockets destroyed because the client check could not be completed. */
  readonly failedChecks: number;
  /** Sockets dropped before delivering data (closed, errored or timed out). */
  readonly closedBeforeData: number;
  close(): Promise<void>;
}

/**
 * `onConnection` receives a paused socket whose first data is already buffered.
 * The socket is resumed once the handler returns, or once its returned promise
 * settles, so a handler may set up its listeners asynchronously without losing
 * the first request.
 */
export async function listenSecurePipe(
  pipePath: string,
  onConnection: (socket: net.Socket) => Promise<void> | void,
  options: SecurePipeServerOptions = {},
): Promise<SecurePipeServer> {
  if (process.platform !== 'win32') {
    throw new Error('listenSecurePipe is only implemented for Windows named pipes');
  }
  const userSid = getCurrentUserSid();
  const sddl = options.sddl ?? currentUserOnlySddl(userSid);
  const acceptClient = options.acceptClient ?? ((client: PipeClient) => client.userSid === userSid);
  const firstDataTimeoutMs = options.firstDataTimeoutMs ?? 30_000;
  const server = net.createServer({ pauseOnConnect: true });

  let secured = false;
  /** Sockets Node has dispatched and not yet closed; each one owns a server instance handle. */
  let openSockets = 0;
  let droppedBeforeSecure = 0;
  let rejectedClients = 0;
  let failedChecks = 0;
  let closedBeforeData = 0;

  /** True only if the instance's client is identified and explicitly accepted. */
  const isAccepted = (instance: PipeServerInstance): boolean => {
    if (instance.state !== 'connected' || instance.clientPid === undefined) return false;
    let clientSid: string;
    try {
      clientSid = getProcessUserSid(instance.clientPid);
    } catch {
      return false;
    }
    try {
      // Only a literal `true` accepts, whatever a JS caller's predicate returns.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-boolean-literal-compare
      return acceptClient({ pid: instance.clientPid, userSid: clientSid }) === true;
    } catch {
      return false;
    }
  };

  /**
   * Disconnects every occupied instance that is not accepted.
   * Returns false when the check could not be completed for all instances.
   */
  const checkClients = (): boolean => {
    let instances: PipeServerInstance[];
    try {
      instances = findOwnPipeServerInstances(pipePath);
    } catch {
      return false;
    }
    // Every open socket owns one instance that is no longer listening; seeing fewer means some were missed.
    let complete = instances.filter((instance) => instance.state !== 'listening').length >= openSockets;
    for (const instance of instances) {
      if (!instance.occupied || isAccepted(instance)) continue;
      try {
        disconnectPipeInstance(instance.handle);
        rejectedClients += 1;
      } catch {
        complete = false;
      }
    }
    return complete;
  };

  /** Waits for the first data before handing off; see measure 3 above. */
  const awaitFirstData = (socket: net.Socket): void => {
    const onReadable = (): void => {
      const chunk = socket.read() as Buffer | null;
      if (chunk === null) return;
      stop();
      socket.unshift(chunk);
      void handOff(socket, onConnection);
    };
    const drop = (): void => {
      stop();
      closedBeforeData += 1;
      socket.destroy();
    };
    const timer = setTimeout(drop, firstDataTimeoutMs);
    const stop = (): void => {
      clearTimeout(timer);
      socket.off('readable', onReadable);
      socket.off('end', drop);
      socket.off('close', drop);
      socket.off('error', drop);
    };
    socket.on('readable', onReadable);
    socket.once('end', drop);
    socket.once('close', drop);
    socket.once('error', drop);
  };

  server.on('connection', (socket) => {
    openSockets += 1;
    socket.once('close', () => {
      openSockets -= 1;
    });
    socket.on('error', () => undefined);
    if (!secured) {
      droppedBeforeSecure += 1;
      socket.destroy();
      return;
    }
    // This socket's own instance is among those checked.
    if (!checkClients()) {
      failedChecks += 1;
      socket.destroy();
      return;
    }
    awaitFirstData(socket);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(pipePath, () => {
      server.off('error', reject);
      resolve();
    });
  });

  let security: PipeSecurity;
  try {
    await options.afterListen?.();
    const instance = findOwnPipeServerInstances(pipePath)[0];
    if (instance === undefined) throw new Error(`No server instance handle found for ${pipePath}`);
    security = setPipeDaclOnHandle(instance.handle, sddl);
    const trustees = allowedTrustees(security.sddl);
    if (options.sddl === undefined && (trustees.length !== 1 || trustees[0] !== userSid)) {
      throw new Error(`Pipe DACL was not restricted to the current user: ${security.sddl}`);
    }
    if (!checkClients()) throw new Error('Initial client check could not be completed');
    secured = true;
  } catch (error) {
    await new Promise<void>((resolve) => server.close(() => { resolve(); }));
    throw error;
  }

  return {
    path: pipePath,
    server,
    security,
    get droppedBeforeSecure() {
      return droppedBeforeSecure;
    },
    get rejectedClients() {
      return rejectedClients;
    },
    get failedChecks() {
      return failedChecks;
    },
    get closedBeforeData() {
      return closedBeforeData;
    },
    close: () =>
      new Promise((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
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
