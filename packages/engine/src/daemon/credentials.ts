import { createHash, timingSafeEqual } from 'node:crypto';
import type { HumanCredentialVerifier } from '../commands/human-credential.ts';
import type { Clock } from '../runtime/clock.ts';
import type { RandomSource } from '../runtime/ids.ts';

/**
 * Human credentials held by a running engine ([[명령·이벤트 계약]] §3 "사람 자격").
 *
 * - `ui`: the app's credential. Handed over when the app launches the engine (stdin, never a file), or issued
 *   by an approved pairing when the app finds an engine already running. Valid until the engine stops.
 * - `cli`: issued by an approved `vuyro auth login`, with a time limit. The person keeps it in their terminal
 *   (`VUYRO_HUMAN_CREDENTIAL`); the engine strips every `VUYRO_*` variable from agent environments.
 *
 * Only SHA-256 digests are kept, in memory: an engine restart forgets every credential. The two kinds never
 * stand in for each other.
 */
export type CredentialKind = 'ui' | 'cli';

interface Entry {
  readonly kind: CredentialKind;
  readonly digest: Buffer;
  readonly expiresAt?: number;
}

const SECRET_BYTES = 32;
const PREFIX: Record<CredentialKind, string> = { ui: 'vuc_', cli: 'vhc_' };

export class HumanCredentials {
  private readonly entries = new Map<string, Entry>();
  private readonly clock: Clock;
  private readonly random: RandomSource;

  constructor(options: { clock: Clock; random: RandomSource }) {
    this.clock = options.clock;
    this.random = options.random;
  }

  /** Creates a credential and returns its secret once. */
  issue(kind: CredentialKind, ttlMs?: number): { secret: string; expiresAt?: number } {
    const secret = `${PREFIX[kind]}${Buffer.from(this.random(SECRET_BYTES)).toString('base64url')}`;
    const expiresAt = ttlMs === undefined ? undefined : this.clock.now() + ttlMs;
    this.add(kind, secret, expiresAt);
    return expiresAt === undefined ? { secret } : { secret, expiresAt };
  }

  /** Registers a secret chosen elsewhere (the app's launch credential). */
  register(kind: CredentialKind, secret: string): void {
    if (secret.length < 32) throw new Error('a credential must be at least 32 characters');
    this.add(kind, secret, undefined);
  }

  verify(kind: CredentialKind, proof: string): boolean {
    const digest = sha256(proof);
    const entry = this.entries.get(digest.toString('hex'));
    if (entry === undefined) return false;
    // The map lookup found it by digest; compare again in constant time before trusting it.
    if (!timingSafeEqual(entry.digest, digest) || entry.kind !== kind) return false;
    if (entry.expiresAt !== undefined && this.clock.now() >= entry.expiresAt) {
      this.entries.delete(digest.toString('hex'));
      return false;
    }
    return true;
  }

  /** The verifier the command bus uses for `humanProof` on CLI connections. */
  cliVerifier(): HumanCredentialVerifier {
    return { verify: (proof) => this.verify('cli', proof) };
  }

  private add(kind: CredentialKind, secret: string, expiresAt: number | undefined): void {
    const digest = sha256(secret);
    this.entries.set(digest.toString('hex'), { kind, digest, ...(expiresAt === undefined ? {} : { expiresAt }) });
  }
}

function sha256(text: string): Buffer {
  return createHash('sha256').update(text, 'utf8').digest();
}
