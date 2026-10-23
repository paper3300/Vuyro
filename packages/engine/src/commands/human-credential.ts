import { createHash, timingSafeEqual } from 'node:crypto';
import type { RandomSource } from '../runtime/ids.ts';

const SECRET_BYTES = 32;

export interface HumanCredentialVerifier {
  verify(proof: string): boolean;
}

/**
 * Proof that a connection is the human, not an agent. Never written to a file agents can read.
 * M3 decides how the app receives it (see 명령·이벤트 계약 §3); until then development tools and
 * tests create one in-process and pass the secret explicitly.
 */
export class HumanCredential implements HumanCredentialVerifier {
  private readonly digest: Buffer;

  private constructor(secret: string) {
    this.digest = sha256(secret);
  }

  /** Creates a credential and returns the secret once. Only the digest is kept. */
  static generate(random: RandomSource): { credential: HumanCredential; secret: string } {
    const secret = `vhc_${Buffer.from(random(SECRET_BYTES)).toString('base64url')}`;
    return { credential: new HumanCredential(secret), secret };
  }

  verify(proof: string): boolean {
    return timingSafeEqual(sha256(proof), this.digest);
  }
}

function sha256(text: string): Buffer {
  return createHash('sha256').update(text, 'utf8').digest();
}
