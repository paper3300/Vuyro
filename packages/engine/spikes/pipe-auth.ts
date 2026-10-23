/**
 * Spike for the engine pipe access decision (기술 스택 결정 §3, decision C):
 * token file creation and handshake cost.
 * Run: node packages/engine/spikes/pipe-auth.ts
 * Results are recorded in Docs/Design/초기 검증 결과.md (SIDs redacted).
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEngineToken } from '../src/ipc/engine-token.ts';
import { connectAuthenticatedPipe, startEnginePipe } from '../src/ipc/pipe-auth.ts';
import { getCurrentUserSid, readFileSecurity } from '../src/platform/win32/security.ts';

const sid = getCurrentUserSid();
const redact = (text: string) => text.replaceAll(sid, '<user>');
const median = (values: number[]) => [...values].sort((a, b) => a - b)[values.length >> 1] ?? NaN;

console.log(`Node ${process.version} (${process.platform} ${process.arch})\n`);

const dir = mkdtempSync(join(tmpdir(), 'vuyro-spike-'));
try {
  const path = join(dir, 'engine', 'engine.token');
  const timings: number[] = [];
  let token = createEngineToken(path);
  for (let i = 0; i < 20; i++) {
    const started = performance.now();
    token = createEngineToken(path);
    timings.push(performance.now() - started);
  }
  console.log('## Token file\n');
  console.log(`SDDL: ${redact(readFileSecurity(path).sddl)}`);
  console.log(`create + restrict + verify + move: median ${median(timings).toFixed(2)} ms (20 runs)\n`);

  const pipePath = String.raw`\\.\pipe\vuyro-spike-` + randomUUID();
  const server = await startEnginePipe(
    pipePath,
    (socket) => {
      socket.on('data', (chunk) => socket.write(chunk));
    },
    { tokenPath: path },
  );
  token = server.token;
  const handshakes: number[] = [];
  for (let i = 0; i < 50; i++) {
    const started = performance.now();
    const socket = await connectAuthenticatedPipe(pipePath, token.secret);
    handshakes.push(performance.now() - started);
    socket.destroy();
  }
  console.log('## Handshake\n');
  console.log(`connect + hello/challenge/response/ok: median ${median(handshakes).toFixed(2)} ms, max ${Math.max(...handshakes).toFixed(2)} ms (50 runs)`);
  await server.close();
} finally {
  rmSync(dir, { recursive: true, force: true });
}
