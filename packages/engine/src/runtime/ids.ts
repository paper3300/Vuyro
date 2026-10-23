import { randomBytes } from 'node:crypto';
import type { Clock } from './clock.ts';

export type RandomSource = (size: number) => Uint8Array;

export const cryptoRandom: RandomSource = (size) => randomBytes(size);

/** Deterministic random bytes for tests (mulberry32). Never use for secrets. */
export function seededRandom(seed: number): RandomSource {
  let state = seed >>> 0;
  const nextByte = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) & 0xff;
  };
  return (size) => Uint8Array.from({ length: size }, nextByte);
}

export interface IdGenerator {
  /** A new lowercase UUIDv7. */
  next(): string;
}

const MAX_COUNTER = 0xfff;

/**
 * UUIDv7 (RFC 9562) with a 12-bit counter in `rand_a` (method 1), so ids made in the same
 * millisecond still sort in creation order. If the clock goes backwards the last timestamp is reused.
 */
export function createUuidV7Generator(options: { clock: Clock; random?: RandomSource }): IdGenerator {
  const random = options.random ?? cryptoRandom;
  let lastMs = -1;
  let counter = 0;
  return {
    next(): string {
      const now = Math.floor(options.clock.now());
      const bytes = random(16);
      if (now > lastMs) {
        lastMs = now;
        // Start low in the counter space so the same millisecond has room for many ids.
        counter = (((bytes[6] ?? 0) << 8) | (bytes[7] ?? 0)) & 0x7ff;
      } else {
        counter += 1;
        if (counter > MAX_COUNTER) {
          lastMs += 1;
          counter = 0;
        }
      }
      const high = Math.floor(lastMs / 0x1_0000_0000);
      const low = lastMs >>> 0;
      bytes[0] = (high >>> 8) & 0xff;
      bytes[1] = high & 0xff;
      bytes[2] = (low >>> 24) & 0xff;
      bytes[3] = (low >>> 16) & 0xff;
      bytes[4] = (low >>> 8) & 0xff;
      bytes[5] = low & 0xff;
      bytes[6] = 0x70 | (counter >>> 8);
      bytes[7] = counter & 0xff;
      bytes[8] = 0x80 | ((bytes[8] ?? 0) & 0x3f);
      const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    },
  };
}
