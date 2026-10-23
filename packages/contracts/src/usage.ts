import { type Static, Type } from '@sinclair/typebox';

const count = Type.Integer({ minimum: 0 });

/**
 * Normalized token counts ([[초기 검증 결과]] M0b "M1 이벤트 계약에 반영할 것" #2).
 * `input` excludes cached input. Codex: input = input_tokens − cached_input_tokens.
 */
export const TokenUsageSchema = Type.Object(
  {
    input: count,
    cacheRead: count,
    cacheWrite: count,
    output: count,
    reasoning: Type.Optional(count),
  },
  { additionalProperties: false },
);

/**
 * Money is optional and always carries where it came from.
 * 'list' = computed from list prices by the CLI (Claude), not what was billed. 'billed' = provider-reported charge.
 */
export const CostSchema = Type.Object(
  {
    usd: Type.Number({ minimum: 0 }),
    basis: Type.Union([Type.Literal('list'), Type.Literal('billed')]),
  },
  { additionalProperties: false },
);

export type TokenUsage = Static<typeof TokenUsageSchema>;
export type Cost = Static<typeof CostSchema>;
