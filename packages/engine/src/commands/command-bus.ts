import {
  COMMAND_CATALOG,
  type CommandError,
  commandError,
  type CommandFailure,
  type CommandRequestEnvelope,
  CommandRequestSchema,
  type CommandResponse,
  type CommandSuccess,
  type CommandType,
  type DomainEvent,
  isCommandType,
  principalKey,
  SchemaValidator,
} from '@vuyro/contracts';
import { cryptoRandom, type IdGenerator, type RandomSource } from '../runtime/ids.ts';
import { DuplicateRequestError, type EventStore, RevisionConflictError } from '../store/event-store.ts';
import type { AggregateDefinition } from './aggregates.ts';
import { authorize } from './authorize.ts';
import { type CallerContext, resolveCaller, type RunTokenRecord, type TransportIdentity } from './caller.ts';
import { canonicalJson, sha256Hex } from './fingerprint.ts';
import { type HandlerContext, handlerFor, type Loaded } from './handlers.ts';
import type { HumanCredentialVerifier } from './human-credential.ts';
import type { DefinitionResolver } from '../workflow/definitions.ts';

export interface CommandBusOptions {
  readonly store: EventStore;
  readonly ids: IdGenerator;
  /** Source of run-token secrets. Default: crypto random. */
  readonly random?: RandomSource;
  readonly validator?: SchemaValidator;
  /** Folded aggregate states kept in memory. Default 1000. */
  readonly aggregateCacheSize?: number;
  /**
   * Verifies `humanProof` on engine-token connections. M3 wires the app's credential here;
   * until then development tools and tests inject one. Absent = no caller can prove to be the human that way.
   */
  readonly humanCredential?: HumanCredentialVerifier;
  /** Called for failures the bus survives but must not hide (e.g. a denial that could not be audited). */
  readonly reportError?: (error: Error, context: string) => void;
  /** Definition files for workflow commands (templates, node types). */
  readonly definitions?: DefinitionResolver;
}

interface CachedAggregate {
  readonly type: string;
  readonly revision: number;
  readonly state: unknown;
}

const failure = (error: CommandError, requestId?: string): CommandFailure =>
  requestId === undefined ? { ok: false, error } : { ok: false, requestId, error };

/**
 * The single entry point for every state change. UI, CLI, agent panel, MCP and engine internals
 * all call `execute`; the transport says who is on the other end.
 *
 * Order of checks: envelope → command type → schema version → caller (run token, human proof) →
 * idempotency → payload → authorization (from the payload; after loading the target only when the
 * scope needs it) → target load → expected revision → decide → append.
 * Commands run one at a time, so a decision always sees every earlier commit.
 */
export class CommandBus {
  private readonly store: EventStore;
  private readonly ids: IdGenerator;
  private readonly random: RandomSource;
  private readonly validator: SchemaValidator;
  private readonly cacheSize: number;
  private readonly humanCredential: HumanCredentialVerifier | undefined;
  private readonly reportError: (error: Error, context: string) => void;
  private readonly definitions: DefinitionResolver | undefined;
  private readonly cache = new Map<string, CachedAggregate>();
  private tail: Promise<unknown> = Promise.resolve();

  constructor(options: CommandBusOptions) {
    this.store = options.store;
    this.ids = options.ids;
    this.random = options.random ?? cryptoRandom;
    this.validator = options.validator ?? new SchemaValidator();
    this.cacheSize = options.aggregateCacheSize ?? 1000;
    this.humanCredential = options.humanCredential;
    this.definitions = options.definitions;
    this.reportError =
      options.reportError ??
      ((error, context) => {
        process.stderr.write(`[vuyro] ${context}: ${error.message}
`);
      });
  }

  execute(request: unknown, transport: TransportIdentity): Promise<CommandResponse> {
    const response = this.tail.then(() => this.run(request, transport));
    const settled = response.catch((error: unknown) =>
      failure(commandError('internal', error instanceof Error ? error.message : String(error)), requestIdOf(request)),
    );
    this.tail = settled;
    return settled;
  }

  private async run(raw: unknown, transport: TransportIdentity): Promise<CommandResponse> {
    const issues = this.validator.validate(CommandRequestSchema, raw);
    if (issues.length > 0) {
      return failure(commandError('validation_failed', 'invalid command envelope', { issues }), requestIdOf(raw));
    }
    const request = raw as CommandRequestEnvelope;
    const { requestId } = request;
    if (!isCommandType(request.type)) {
      return failure(commandError('unknown_command', `unknown command '${request.type}'`), requestId);
    }
    const type: CommandType = request.type;
    const definition = COMMAND_CATALOG[type];
    const version = request.schemaVersion ?? 1;
    if (version !== definition.version) {
      return failure(
        commandError('unsupported_schema_version', `'${type}' v${version} is not supported (current v${definition.version})`),
        requestId,
      );
    }

    const fingerprint = sha256Hex(
      canonicalJson({
        type,
        schemaVersion: version,
        expectedRevision: request.expectedRevision ?? null,
        context: request.context ?? null,
        payload: request.payload,
      }),
    );

    const resolved = await resolveCaller(transport, request, {
      lookupRunToken: (hash) => this.lookupRunToken(hash),
      ...(this.humanCredential === undefined ? {} : { humanCredential: this.humanCredential }),
    });
    if (!resolved.ok) {
      // A settled run may still get the stored answer to an exact retry of its own earlier request.
      // Anything else (new request, different payload) gets the authentication error, revealing nothing.
      if (resolved.settledAs !== undefined) {
        const previous = await this.store.getCommand(requestId);
        if (previous?.principalKey === principalKey(resolved.settledAs) && previous.fingerprint === fingerprint) {
          return { ...previous.response, replayed: true };
        }
      }
      return failure(resolved.error, requestId);
    }
    const { caller } = resolved;
    const callerKey = principalKey(caller.principal);

    const stored = await this.store.getCommand(requestId);
    if (stored !== undefined) return this.replay(stored, callerKey, fingerprint, requestId);

    const payloadIssues = this.validator.validate(definition.payload, request.payload);
    if (payloadIssues.length > 0) {
      return failure(commandError('validation_failed', `invalid '${type}' payload`, { issues: payloadIssues }), requestId);
    }

    const handler = handlerFor(type);
    const { payload } = request;
    const targetRef = handler.target?.(payload);
    const loadTarget = () => (targetRef === undefined ? Promise.resolve(undefined) : this.load(targetRef.definition, targetRef.aggregateId));

    // Authorize from the payload before reading anything. When the scope depends on the target, a caller
    // that passes this first check is authorized again once the target is loaded.
    const needsTarget = typeof handler.scopeNeedsTarget === 'function' ? handler.scopeNeedsTarget(payload) : handler.scopeNeedsTarget === true;
    let target: Loaded<unknown> | undefined;
    let scope = handler.scope(payload, undefined);
    let decision = authorize(type, definition, caller, scope);
    if (decision.ok && needsTarget) {
      target = await loadTarget();
      scope = handler.scope(payload, target);
      decision = authorize(type, definition, caller, scope);
    }
    if (!decision.ok) {
      const auditError = await this.recordDenial(caller, request, decision.code, decision.reason, scope);
      const details = auditError === undefined ? undefined : { audit: 'failed', auditError: auditError.message };
      return failure(commandError(decision.code, decision.reason, details), requestId);
    }
    if (!needsTarget) target = await loadTarget();

    if (request.expectedRevision !== undefined) {
      const actual = target?.revision ?? 0;
      if (actual !== request.expectedRevision) {
        return failure(
          commandError('revision_conflict', `expected revision ${request.expectedRevision}, found ${actual}`, {
            ...(target === undefined ? {} : { aggregateId: target.aggregateId }),
            expectedRevision: request.expectedRevision,
            actualRevision: actual,
          }),
          requestId,
        );
      }
    }

    const context: HandlerContext = {
      caller,
      ids: this.ids,
      random: this.random,
      ...(this.definitions === undefined ? {} : { definitions: this.definitions }),
      load: (aggregate, aggregateId) => this.load(aggregate, aggregateId),
    };
    const outcome = await handler.decide(context, payload, target);
    if (!outcome.ok) return failure(outcome.error, requestId);

    const resultIssues = this.validator.validate(definition.result, outcome.result);
    if (resultIssues.length > 0) throw new Error(`'${type}' handler returned an invalid result`);

    const primary = outcome.created ?? target?.aggregateId;
    const storedResult = outcome.storedResult ?? outcome.result;
    try {
      const committed = await this.store.append({
        streams: outcome.appends,
        actor: caller.principal,
        authorization: decision.authorization,
        requestId,
        ...(request.correlationId === undefined ? {} : { correlationId: request.correlationId }),
        command: {
          requestId,
          type,
          principalKey: callerKey,
          fingerprint,
          response: (events) => successResponse(requestId, type, storedResult, events, primary, target?.revision),
        },
      });
      const response = committed.response ?? successResponse(requestId, type, storedResult, committed.events, primary, target?.revision);
      return { ...response, result: outcome.result };
    } catch (error) {
      if (error instanceof RevisionConflictError) {
        for (const id of error.aggregateIds) this.cache.delete(id);
        return failure(commandError('revision_conflict', error.message, { aggregateIds: [...error.aggregateIds] }), requestId);
      }
      if (error instanceof DuplicateRequestError) {
        const again = await this.store.getCommand(requestId);
        if (again !== undefined) return this.replay(again, callerKey, fingerprint, requestId);
      }
      throw error;
    }
  }

  private replay(
    stored: { principalKey: string; fingerprint: string; response: CommandSuccess },
    callerKey: string,
    fingerprint: string,
    requestId: string,
  ): CommandResponse {
    if (stored.principalKey !== callerKey || stored.fingerprint !== fingerprint) {
      return failure(
        commandError('idempotency_conflict', `request id ${requestId} was already used for a different command or caller`),
        requestId,
      );
    }
    return { ...stored.response, replayed: true };
  }

  private async recordDenial(
    caller: CallerContext,
    request: CommandRequestEnvelope,
    code: 'forbidden' | 'out_of_scope',
    reason: string,
    scope: { ticketId?: string; nodeId?: string },
  ): Promise<Error | undefined> {
    try {
      await this.store.append({
        streams: [
          {
            aggregateType: 'audit',
            aggregateId: this.ids.next(),
            expectedRevision: 0,
            events: [
              {
                type: 'command.denied',
                data: {
                  requestId: request.requestId,
                  commandType: request.type,
                  code,
                  reason,
                  ...(scope.ticketId === undefined ? {} : { ticketId: scope.ticketId }),
                  ...(scope.nodeId === undefined ? {} : { nodeId: scope.nodeId }),
                },
              },
            ],
          },
        ],
        actor: caller.principal,
        requestId: request.requestId,
      });
      return undefined;
    } catch (error) {
      // The refusal stands (fail closed), but the missing audit record is reported, not hidden.
      const failed = error instanceof Error ? error : new Error(String(error));
      this.reportError(failed, `could not record denial of ${request.type} (${request.requestId})`);
      return failed;
    }
  }

  private async lookupRunToken(tokenHash: string): Promise<RunTokenRecord | undefined> {
    const row = await this.store.queryOne<{ run_id: string; ticket_id: string; node_id: string; provider: string; status: string }>(
      'SELECT run_id, ticket_id, node_id, provider, status FROM p_runs WHERE token_hash = ?',
      [tokenHash],
    );
    if (row === undefined) return undefined;
    return { runId: row.run_id, ticketId: row.ticket_id, nodeId: row.node_id, provider: row.provider, status: row.status };
  }

  /** Folds an aggregate from its events, continuing from the cached state when there is one. */
  private async load<S>(definition: AggregateDefinition<S>, aggregateId: string): Promise<Loaded<S>> {
    const cached = this.cache.get(aggregateId);
    const usable = cached?.type === definition.type ? cached : undefined;
    let revision = usable?.revision ?? 0;
    let state = (usable?.state as S | undefined) ?? definition.initial;
    const events = await this.store.readAggregate(aggregateId, revision);
    for (const event of events) {
      revision = event.revision;
      if (event.aggregateType !== definition.type) {
        // The id belongs to another kind of aggregate: report it as not existing for this type.
        this.cache.delete(aggregateId);
        return { aggregateId, revision: events.at(-1)?.revision ?? revision, state: definition.initial };
      }
      state = definition.evolve(state, event);
    }
    if (revision > 0) {
      this.cache.delete(aggregateId);
      this.cache.set(aggregateId, { type: definition.type, revision, state });
      if (this.cache.size > this.cacheSize) {
        const oldest = this.cache.keys().next();
        if (oldest.done !== true) this.cache.delete(oldest.value);
      }
    }
    return { aggregateId, revision, state };
  }
}

function successResponse(
  requestId: string,
  type: string,
  result: unknown,
  events: readonly DomainEvent[],
  primary: string | undefined,
  baseRevision: number | undefined,
): CommandSuccess {
  const first = events[0];
  const last = events.at(-1);
  const primaryRevision = primary === undefined ? undefined : events.filter((event) => event.aggregateId === primary).at(-1)?.revision;
  const revision = primaryRevision ?? baseRevision;
  return {
    ok: true,
    requestId,
    type,
    result,
    ...(revision === undefined ? {} : { revision }),
    events:
      first === undefined || last === undefined
        ? null
        : { firstSequence: first.sequence, lastSequence: last.sequence, count: events.length },
    replayed: false,
  };
}

function requestIdOf(raw: unknown): string | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const value = (raw as { requestId?: unknown }).requestId;
  return typeof value === 'string' ? value : undefined;
}
