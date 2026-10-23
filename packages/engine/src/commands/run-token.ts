import { createHash } from 'node:crypto';
import { RUN_TOKEN_PATTERN } from '@vuyro/contracts';
import type { RandomSource } from '../runtime/ids.ts';

const TOKEN_BYTES = 32;
const tokenPattern = new RegExp(RUN_TOKEN_PATTERN);

/**
 * A node run token: 32 random bytes, handed to the agent process in VUYRO_RUN_TOKEN.
 * Only its SHA-256 is stored (in the `run.started` event and the runs projection).
 */
export function issueRunToken(random: RandomSource): { token: string; hash: string } {
  const token = `vrt_${Buffer.from(random(TOKEN_BYTES)).toString('base64url')}`;
  return { token, hash: hashRunToken(token) };
}

export function hashRunToken(token: string): string {
  return `sha256:${createHash('sha256').update(token, 'utf8').digest('hex')}`;
}

export function isWellFormedRunToken(token: string): boolean {
  return tokenPattern.test(token);
}
