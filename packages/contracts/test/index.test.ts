import { describe, expect, it } from 'vitest';
import { isAgentProvider, PROTOCOL_VERSION } from '../src/index.ts';

describe('contracts', () => {
  it('exposes a positive protocol version', () => {
    expect(PROTOCOL_VERSION).toBeGreaterThan(0);
  });

  it('recognizes supported agent providers only', () => {
    expect(isAgentProvider('claude')).toBe(true);
    expect(isAgentProvider('codex')).toBe(true);
    expect(isAgentProvider('gpt')).toBe(false);
    expect(isAgentProvider(1)).toBe(false);
  });
});
