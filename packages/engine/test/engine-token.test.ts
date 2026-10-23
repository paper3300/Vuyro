import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEngineToken, readEngineToken, TOKEN_BYTES } from '../src/ipc/engine-token.ts';
import { ERROR_ACCESS_DENIED, win32 } from '../src/platform/win32/ffi.ts';
import { allowedTrustees, currentUserOnlySddl, getCurrentUserSid, readFileSecurity } from '../src/platform/win32/security.ts';

const isWindows = process.platform === 'win32';

describe('currentUserOnlySddl', () => {
  it('grants one SID and blocks inheritance', () => {
    expect(currentUserOnlySddl('S-1-5-21-1-2-3-1001')).toBe('D:P(A;;FA;;;S-1-5-21-1-2-3-1001)');
  });

  it('rejects anything that is not a SID', () => {
    expect(() => currentUserOnlySddl('WD')).toThrow(/Not a SID/);
    expect(() => currentUserOnlySddl('S-1-1-0)(A;;GA;;;WD')).toThrow(/Not a SID/);
  });

  it('lists allowed trustees from an SDDL DACL', () => {
    expect(allowedTrustees('O:S-1-5-18G:DUD:(A;;FA;;;SY)(A;;FR;;;WD)(D;;FA;;;NU)(A;;FR;;;AN)')).toEqual(['SY', 'WD', 'AN']);
  });
});

describe.runIf(isWindows)('engine token file', () => {
  const dirs: string[] = [];
  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function tokenPath(): string {
    const dir = mkdtempSync(join(tmpdir(), 'vuyro-token-'));
    dirs.push(dir);
    return join(dir, 'engine', 'engine.token');
  }

  function leftovers(path: string): string[] {
    const dir = join(path, '..');
    return existsSync(dir) ? readdirSync(dir) : [];
  }

  it('reads the current user SID from the process token', () => {
    expect(getCurrentUserSid()).toMatch(/^S-1-5-\d+(-\d+)+$/);
  });

  it('writes a random secret readable only by the current user', () => {
    const path = tokenPath();
    const token = createEngineToken(path);

    expect(token.secret).toHaveLength(TOKEN_BYTES);
    expect(readEngineToken(path).equals(token.secret)).toBe(true);
    const { sddl } = readFileSecurity(path);
    expect(sddl).toContain('D:P');
    expect(allowedTrustees(sddl)).toEqual([getCurrentUserSid()]);
    expect(leftovers(path)).toEqual(['engine.token']);
  });

  it('replaces the token on every start', () => {
    const path = tokenPath();
    const first = createEngineToken(path);
    const second = createEngineToken(path);
    expect(second.secret.equals(first.secret)).toBe(false);
    expect(readEngineToken(path).equals(second.secret)).toBe(true);
    expect(allowedTrustees(readFileSecurity(path).sddl)).toEqual([getCurrentUserSid()]);
  });

  it('rejects a malformed token file', () => {
    const path = tokenPath();
    createEngineToken(path);
    writeFileSync(path, 'not-a-token');
    expect(() => readEngineToken(path)).toThrow(/Malformed/);
  });

  // Fail closed: the engine must not start with a token others could read.

  it('fails when the DACL cannot be applied, leaving no secret behind', () => {
    const path = tokenPath();
    vi.spyOn(win32(), 'SetSecurityInfo').mockReturnValue(ERROR_ACCESS_DENIED);
    expect(() => createEngineToken(path)).toThrow(/SetSecurityInfo/);
    expect(leftovers(path)).toEqual([]);
  });

  it('fails when the DACL silently stays inherited (read-back check)', () => {
    const path = tokenPath();
    vi.spyOn(win32(), 'SetSecurityInfo').mockReturnValue(0); // "success" without applying
    expect(() => createEngineToken(path)).toThrow(/not restricted to the current user/);
    expect(leftovers(path)).toEqual([]);
  });

  it('fails when the DACL cannot be read back', () => {
    const path = tokenPath();
    vi.spyOn(win32(), 'GetSecurityInfo').mockReturnValue(ERROR_ACCESS_DENIED);
    expect(() => createEngineToken(path)).toThrow(/GetSecurityInfo/);
    expect(leftovers(path)).toEqual([]);
  });

  it('fails when the final file is not current-user-only after the move', () => {
    const path = tokenPath();
    const w = win32();
    const real = w.GetSecurityInfo.bind(w);
    let reads = 0;
    // The two read-backs of the temporary file are real; the check after the move fails.
    vi.spyOn(w, 'GetSecurityInfo').mockImplementation((...args) => {
      reads += 1;
      return reads <= 2 ? real(...args) : ERROR_ACCESS_DENIED;
    });
    expect(() => createEngineToken(path)).toThrow();
    expect(existsSync(path)).toBe(false);
  });
});
