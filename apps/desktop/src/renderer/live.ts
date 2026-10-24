import { type QueryClient, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type { EventsMessage } from '../shared/bridge.ts';
import { bridge, call } from './api.ts';
import { useUi } from './store.ts';

/**
 * Keeps the screens current from the engine's event stream (기술 스택 결정 §6): events never patch screen state
 * directly; they mark the queries they touch as stale, batched, so only what changed is fetched and redrawn.
 *
 * The subscription starts at the engine's current sequence once connected, and the main process keeps it going
 * across engine reconnects from the last event it delivered (no gaps, no repeats).
 */

const FLUSH_MS = 200;

export function queryKeysFor(events: EventsMessage['events']): string[][] {
  const keys = new Map<string, string[]>();
  const add = (key: string[]) => keys.set(key.join('\u0000'), key);
  for (const event of events) {
    const aggregateType = typeof event.aggregateType === 'string' ? event.aggregateType : '';
    if (aggregateType === 'ticket') {
      add(['ticket', event.aggregateId]);
      add(['ticketStats', event.aggregateId]);
      add(['artifacts', event.aggregateId]);
      add(['board']);
      // Request nodes join and leave shared node queues through ticket events.
      add(['sharedNodes']);
    } else if (aggregateType === 'run') {
      // Run events carry the run id; the stats and boards that count tokens and tool calls change.
      add(['ticketStats']);
      add(['ticket']);
      add(['board']);
    } else if (aggregateType === 'project') {
      add(['projects']);
      add(['board']);
    } else if (aggregateType === 'shared') {
      add(['sharedNodes']);
    } else if (aggregateType === 'definition') {
      add(['templates']);
      add(['board']);
    }
  }
  return [...keys.values()];
}

function invalidate(client: QueryClient, keys: readonly string[][]): void {
  for (const queryKey of keys) void client.invalidateQueries({ queryKey });
}

export function useLiveEvents(): void {
  const client = useQueryClient();
  const connected = useUi((state) => state.connection.phase === 'connected');
  const sawSequence = useUi((state) => state.sawSequence);
  // Subscribe once, on the first connection; later reconnects are the main process's (it resumes from `last`).
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (connected) setReady(true);
  }, [connected]);
  useEffect(() => {
    if (!ready) return;
    let unsubscribe: (() => void) | undefined;
    const life = { cancelled: false };
    let pending: EventsMessage['events'] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    const flush = () => {
      timer = undefined;
      const batch = pending;
      pending = [];
      invalidate(client, queryKeysFor(batch));
    };
    void (async () => {
      let start: number;
      try {
        start = (await call<{ lastSequence: number }>('engine.status', {})).lastSequence;
      } catch {
        start = useUi.getState().connection.lastSequence ?? 0;
      }
      if (life.cancelled) return;
      sawSequence(start);
      // Anything that happened while the screen was away (or before this point) shows up by fetching again.
      void client.invalidateQueries();
      unsubscribe = bridge().subscribe(start, (events) => {
        const last = events.at(-1);
        if (last !== undefined) sawSequence(last.sequence);
        pending = pending.concat(events);
        timer ??= setTimeout(flush, FLUSH_MS);
      });
    })();
    return () => {
      life.cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
      unsubscribe?.();
    };
  }, [client, ready, sawSequence]);
}

/** Mirrors the main process's connection state into the store. */
export function useConnectionState(): void {
  const setConnection = useUi((state) => state.setConnection);
  useEffect(() => {
    let alive = true;
    void bridge()
      .connection()
      .then((state) => {
        if (alive) setConnection(state);
      });
    const off = bridge().onConnection(setConnection);
    return () => {
      alive = false;
      off();
    };
  }, [setConnection]);
}
