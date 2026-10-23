import { describe, expect, it } from 'vitest';
import { describeAdapter } from '../src/index.ts';

describe('agent-adapters', () => {
  it('describes an adapter by provider', () => {
    expect(describeAdapter({ provider: 'codex' })).toBe('agent-adapter:codex');
  });
});
