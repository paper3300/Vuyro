import { type Static, Type } from '@sinclair/typebox';

/**
 * A permission rule ([[공유·권한·BlackBoard 설계]] §2.4). M1 stores rules but enforces only
 * the built-in boundary (run token scope, AI never edits permissions). The policy evaluator lands after MVP.
 */
export const PermissionRuleSchema = Type.Object(
  {
    /** 'node.agent', 'panel.ticket', … or '*'. */
    subject: Type.String({ minLength: 1, maxLength: 64 }),
    /** 'app' | 'project:<id>' | 'template:<id>' | 'ticket:<id>' | 'node:<id>'. */
    scope: Type.String({ minLength: 1, maxLength: 256 }),
    /** Command type, wildcards allowed ('template.*'). */
    action: Type.String({ minLength: 1, maxLength: 128 }),
    target: Type.String({ minLength: 1, maxLength: 512 }),
    effect: Type.Union([Type.Literal('allow'), Type.Literal('ask'), Type.Literal('deny')]),
    when: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  },
  { additionalProperties: false },
);

export type PermissionRule = Static<typeof PermissionRuleSchema>;
