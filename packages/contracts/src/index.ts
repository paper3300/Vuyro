/**
 * Shared contracts between the engine and its clients (UI, CLI, MCP, plugins):
 * commands, events, the handoff envelope, node declarations and their JSON Schemas.
 * Runtime-neutral: no Node built-ins (it is shared with the renderer).
 */

export { type Static, type TSchema } from '@sinclair/typebox';

/** Version of the engine wire protocol (JSON-RPC 2.0 over NDJSON). */
export const PROTOCOL_VERSION = 1;

export * from './commands.ts';
export * from './errors.ts';
export * from './events.ts';
export * from './expressions.ts';
export * from './handoff.ts';
export * from './ids.ts';
export * from './node-type.ts';
export * from './permission.ts';
export * from './principal.ts';
export * from './providers.ts';
export * from './rpc.ts';
export * from './schema.ts';
export * from './usage.ts';
export * from './workflow.ts';
