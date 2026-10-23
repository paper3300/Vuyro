/**
 * Observations must fit the `run.observe` schema, or the engine drops them. Adapters cut provider values
 * down to the field limits here instead of failing: a long tool output is still worth recording in part.
 */
export const LIMITS = {
  text: 1_048_576,
  toolOutput: 1_048_576,
  id: 256,
  name: 256,
  model: 128,
  cliVersion: 64,
  warning: 65_536,
  providerType: 128,
  settleError: 65_536,
  terminalReason: 128,
  /** Serialized size of free-form values (tool input, raw lines). */
  value: 262_144,
  /** Preview kept when a free-form value is too big. */
  preview: 65_536,
} as const;

/** Cuts `text` to at most `max` characters, saying how much was dropped. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const marker = `…[${text.length - max} more characters]`;
  return text.slice(0, Math.max(0, max - marker.length)) + marker;
}

/** Keeps a JSON value when it is small enough, else a preview of its text. */
export function fitValue(value: unknown): unknown {
  // Not a string for undefined, functions and symbols, whatever the declared type says.
  let text: unknown;
  try {
    text = JSON.stringify(value);
  } catch {
    return { truncated: true, reason: 'not serializable' };
  }
  if (typeof text !== 'string' || text.length <= LIMITS.value) return value;
  return { truncated: true, characters: text.length, preview: clip(text, LIMITS.preview) };
}
