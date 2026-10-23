import { type Static, Type } from '@sinclair/typebox';
import { IdSchema, NodeIdSchema } from './ids.ts';
import { AGENT_PROVIDERS } from './providers.ts';

/**
 * Who issued a command. The engine derives it from the connection and the run token;
 * a client cannot claim a principal by putting it in the request.
 */
export const AGENT_ROLES = ['node.agent', 'panel.app', 'panel.ticket', 'mcp.external'] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];

export const HumanPrincipalSchema = Type.Object(
  {
    kind: Type.Literal('human'),
    /** MVP is single-user; the local user is always 'local'. */
    userId: Type.String({ minLength: 1, maxLength: 64 }),
    /**
     * How the human was verified. 'ui' = app connection with the UI credential;
     * 'cli' = a CLI connection that presented the human credential (development and tests until M3).
     */
    via: Type.Union([Type.Literal('ui'), Type.Literal('cli')]),
  },
  { additionalProperties: false },
);

export const AgentPrincipalSchema = Type.Object(
  {
    kind: Type.Literal('agent'),
    role: Type.Union(AGENT_ROLES.map((role) => Type.Literal(role))),
    provider: Type.Optional(Type.Union(AGENT_PROVIDERS.map((provider) => Type.Literal(provider)))),
    /** Set for `node.agent`: the run whose token was presented. */
    runId: Type.Optional(IdSchema),
    ticketId: Type.Optional(IdSchema),
    nodeId: Type.Optional(NodeIdSchema),
  },
  { additionalProperties: false },
);

export const SystemPrincipalSchema = Type.Object(
  {
    kind: Type.Literal('system'),
    /** Engine component acting on its own, e.g. 'workflow', 'adapter', 'recovery'. */
    component: Type.String({ minLength: 1, maxLength: 64 }),
  },
  { additionalProperties: false },
);

/**
 * A local client that proved only the engine token (any process of the same OS user can read it).
 * It may be the human at a terminal or an agent that dropped its run token, so it is treated like an AI
 * and is read-only.
 */
export const UnverifiedPrincipalSchema = Type.Object(
  {
    kind: Type.Literal('unverified'),
    client: Type.Union([Type.Literal('cli'), Type.Literal('unknown')]),
  },
  { additionalProperties: false },
);

export const PrincipalSchema = Type.Union([
  HumanPrincipalSchema,
  AgentPrincipalSchema,
  SystemPrincipalSchema,
  UnverifiedPrincipalSchema,
]);

export type HumanPrincipal = Static<typeof HumanPrincipalSchema>;
export type AgentPrincipal = Static<typeof AgentPrincipalSchema>;
export type SystemPrincipal = Static<typeof SystemPrincipalSchema>;
export type UnverifiedPrincipal = Static<typeof UnverifiedPrincipalSchema>;
export type Principal = Static<typeof PrincipalSchema>;

/**
 * Everything that is not a verified human or the engine itself counts as AI.
 * The fixed rule "AI cannot change permission rules" applies to all of them.
 */
export function isAiPrincipal(principal: Principal): boolean {
  return principal.kind === 'agent' || principal.kind === 'unverified';
}

/** Stable key for comparing principals (idempotency, audit). */
export function principalKey(principal: Principal): string {
  switch (principal.kind) {
    case 'human':
      return `human:${principal.userId}`;
    case 'system':
      return `system:${principal.component}`;
    case 'unverified':
      return `unverified:${principal.client}`;
    case 'agent':
      return `agent:${principal.role}:${principal.runId ?? '-'}`;
  }
}

/** How a command was allowed. Recorded on every event the command produced. */
export const AuthorizationSchema = Type.Object(
  {
    decision: Type.Literal('allow'),
    /** 'builtin:<name>' for engine rules; user rule ids once the permission policy lands. */
    rule: Type.String({ minLength: 1, maxLength: 128 }),
  },
  { additionalProperties: false },
);
export type Authorization = Static<typeof AuthorizationSchema>;
