"use client";

import { useSyncExternalStore } from "react";

// Process-local, monotonic consumption revisions. Every authoritative state,
// cursor, and accepted-heartbeat write advances revision. Only durable reader
// cursor writes/resets advance durationRevision: ordinary library views can
// refresh their minute labels without replacing pagination on audio heartbeats.
// Each consumer decides which facts affect its committed projection.

export interface ConsumptionProjectionChange {
  readonly revision: number;
  readonly durationRevision: number;
}

const INITIAL: ConsumptionProjectionChange = { revision: 0, durationRevision: 0 };

let current: ConsumptionProjectionChange = INITIAL;
const listeners = new Set<() => void>();

export function publishConsumptionProjectionChange(options?: {
  readonly durationChanged: boolean;
}): void {
  current = {
    revision: current.revision + 1,
    durationRevision:
      current.durationRevision + (options?.durationChanged ? 1 : 0),
  };
  for (const listener of listeners) listener();
}

export function subscribeConsumptionProjection(
  listener: () => void,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function consumptionProjectionSnapshot(): ConsumptionProjectionChange {
  return current;
}

export function useConsumptionProjectionRevision(): ConsumptionProjectionChange {
  return useSyncExternalStore(
    subscribeConsumptionProjection,
    consumptionProjectionSnapshot,
    () => INITIAL,
  );
}
