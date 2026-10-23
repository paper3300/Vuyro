import net from 'node:net';
import {
  allowedTrustees,
  currentUserOnlySddl,
  disconnectPipeInstance,
  findOwnPipeServerInstances,
  getCurrentUserSid,
  getProcessUserSid,
  type PipeSecurity,
  setPipeDaclOnHandle,
} from '../platform/win32/pipe-security.ts';

/**
 * Named pipe server that only serves the current Windows user.
 *
 * Node creates the pipe with the default descriptor, which also grants read
 * access to Everyone and Anonymous, and offers no way to pass another one.
 * Two independent measures close that gap without relying on accept order:
 *
 * 1. Right after `listen`, the DACL is replaced through one of our own server
 *    instance handles (found in this process's handle table). The descriptor is
 *    shared by all instances, so from then on the OS refuses other users at open time.
 * 2. Client check: after the DACL is applied and again whenever a connection
 *    arrives, every connected instance's client process is looked up
 *    (GetNamedPipeClientProcessId → process token user SID). Instances whose client
 *    is not accepted are disconnected at the OS level, which discards unread data.
 *    Sockets start paused, so nothing is read before the check has run.
 *
 * Connections that Node dispatches before the server is secured are destroyed.
 */

export interface PipeClient {
  readonly pid: number;
  /** undefined when the client process could not be opened. */
  readonly userSid: string | undefined;
}

export interface SecurePipeServerOptions {
  /** DACL to apply. Defaults to the current user only, remote logons denied. */
  readonly sddl?: string;
  /** Which clients to serve. Defaults to processes running as the current user. */
  readonly acceptClient?: (client: PipeClient) => boolean;
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
  /** Client connections disconnected by the client check. */
  readonly rejectedClients: number;
  close(): Promise<void>;
}

/**
 * `onConnection` receives a paused socket. The socket is resumed once the
 * handler returns, or once its returned promise settles, so a handler may set
 * up its listeners asynchronously without losing the first request.
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
  const server = net.createServer({ pauseOnConnect: true });

  let secured = false;
  let droppedBeforeSecure = 0;
  let rejectedClients = 0;

  const checkClients = (): void => {
    for (const instance of findOwnPipeServerInstances(pipePath)) {
      if (instance.clientPid === undefined) continue;
      if (acceptClient({ pid: instance.clientPid, userSid: tryProcessUserSid(instance.clientPid) })) continue;
      disconnectPipeInstance(instance.handle);
      rejectedClients += 1;
    }
  };

  server.on('connection', (socket) => {
    socket.on('error', () => undefined);
    if (!secured) {
      droppedBeforeSecure += 1;
      socket.destroy();
      return;
    }
    try {
      // This socket's own instance is among those checked; a rejected one ends right after resume.
      checkClients();
    } catch {
      // Fail closed: without a completed check the connection is not served.
      socket.destroy();
      return;
    }
    void handOff(socket, onConnection);
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
    checkClients();
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

function tryProcessUserSid(pid: number): string | undefined {
  try {
    return getProcessUserSid(pid);
  } catch {
    return undefined;
  }
}
