import { DURATION_PATTERN } from '@vuyro/contracts';

const pattern = new RegExp(DURATION_PATTERN);
const UNIT_MS = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

/** '500ms', '30s', '20m', '2h', '1d' → milliseconds. */
export function parseDuration(text: string): number {
  if (!pattern.test(text)) throw new RangeError(`not a duration: '${text}'`);
  const match = /^([0-9]+)(ms|s|m|h|d)$/.exec(text);
  if (match === null) throw new RangeError(`not a duration: '${text}'`);
  const [, amount = '0', unit = 'ms'] = match;
  return Number.parseInt(amount, 10) * UNIT_MS[unit as keyof typeof UNIT_MS];
}
