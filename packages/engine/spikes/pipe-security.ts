/**
 * Spike for 기술 스택 결정 §13 #1: a named pipe that only the current user can open.
 * Run: node packages/engine/spikes/pipe-security.ts
 * Results are recorded in Docs/Design/초기 검증 결과.md (SIDs redacted).
 */
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import net from 'node:net';
import { listenSecurePipe } from '../src/ipc/secure-pipe-server.ts';
import {
  allowedTrustees,
  currentUserOnlySddl,
  getCurrentUserSid,
  readPipeSecurity,
  setPipeDacl,
} from '../src/platform/win32/pipe-security.ts';

const sid = getCurrentUserSid();
const redact = (text: string) => text.replaceAll(sid, '<user>');
const local = (name: string) => `\\\\.\\pipe\\${name}`;
// Through the SMB redirector: a network logon even on the same machine.
const viaSmb = (server: string, name: string) => `\\\\${server}\\pipe\\${name}`;

function tryConnect(path: string): Promise<string> {
  return new Promise((resolve) => {
    const socket = net.connect(path);
    const timer = setTimeout(() => {
      socket.destroy();
      resolve('timeout');
    }, 5000);
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.destroy();
      resolve('connected');
    });
    socket.once('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      resolve(error.code ?? error.message);
    });
  });
}

function sink(socket: net.Socket): void {
  socket.on('error', () => undefined);
  socket.resume();
}

console.log(`Node ${process.version} (${process.platform} ${process.arch})\n`);

{
  const name = `vuyro-spike-${randomUUID()}`;
  const server = net.createServer(sink);
  await new Promise<void>((resolve) => server.listen(local(name), resolve));
  const security = readPipeSecurity(local(name));
  console.log('## Default descriptor from net.Server.listen()\n');
  console.log(`SDDL: ${redact(security.sddl)}`);
  console.log(`allowed: ${redact(allowedTrustees(security.sddl).join(', '))}\n`);
  await new Promise<void>((resolve) => server.close(() => { resolve(); }));
}

{
  const runs = 20;
  const timings: number[] = [];
  let last: Awaited<ReturnType<typeof listenSecurePipe>> | undefined;
  for (let i = 0; i < runs; i++) {
    const started = performance.now();
    const secure = await listenSecurePipe(local(`vuyro-spike-${randomUUID()}`), sink);
    timings.push(performance.now() - started);
    if (i < runs - 1) await secure.close();
    else last = secure;
  }
  if (last === undefined) throw new Error('unreachable');
  const sorted = timings.sort((a, b) => a - b);
  console.log('## listenSecurePipe()\n');
  console.log(`SDDL: ${redact(last.security.sddl)}`);
  console.log(`allowed: ${redact(allowedTrustees(last.security.sddl).join(', '))}`);
  console.log(`dropped before gate: ${last.droppedBeforeGate}`);
  console.log(`time to listen + secure + gate: median ${sorted[runs >> 1]?.toFixed(2)} ms, max ${sorted.at(-1)?.toFixed(2)} ms (${runs} runs)`);
  const pipeName = last.path.slice(local('').length);
  console.log(`connect locally: ${await tryConnect(last.path)}`);
  console.log(`connect via \\\\localhost: ${await tryConnect(viaSmb('localhost', pipeName))}`);
  console.log(`connect via \\\\<hostname>: ${await tryConnect(viaSmb(hostname(), pipeName))}`);
  console.log(`connect via \\\\127.0.0.1: ${await tryConnect(viaSmb('127.0.0.1', pipeName))}\n`);
  await last.close();
}

{
  const name = `vuyro-spike-${randomUUID()}`;
  const secure = await listenSecurePipe(local(name), sink, { sddl: currentUserOnlySddl(sid, { rejectRemote: false }) });
  console.log('## Same, without the network-logon deny ACE (control)\n');
  console.log(`SDDL: ${redact(secure.security.sddl)}`);
  console.log(`connect via \\\\localhost: ${await tryConnect(viaSmb('localhost', name))}`);
  console.log(`connect via \\\\127.0.0.1: ${await tryConnect(viaSmb('127.0.0.1', name))}\n`);
  await secure.close();
}

{
  const name = `vuyro-spike-${randomUUID()}`;
  const server = net.createServer(sink);
  await new Promise<void>((resolve) => server.listen(local(name), resolve));
  setPipeDacl(local(name), 'D:P(A;;GA;;;SY)');
  console.log('## Enforcement: DACL that grants only SYSTEM, connecting as the current user\n');
  console.log(`connect locally: ${await tryConnect(local(name))}\n`);
  await new Promise<void>((resolve) => server.close(() => { resolve(); }));
}
