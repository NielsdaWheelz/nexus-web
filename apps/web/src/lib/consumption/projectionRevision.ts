"use client";

import { useSyncExternalStore } from "react";

// Process-local, monotonic consumption-projection revision. Every authoritative
// consumption-state, durable reader-state, and accepted-heartbeat write publishes
// here after install; the pane decides whether to refetch from its own committed
// projection. See docs/cutovers/library-all-and-smart-views-hard-cutover.md
// ("Mutation Composition"). No `mediaIds` field: no consumer reads it
// (simplicity.md).

export interface ConsumptionProjectionChange {
  revision: number;
}

const INITIAL: ConsumptionProjectionChange = { revision: 0 };

let current: ConsumptionProjectionChange = INITIAL;
const listeners = new Set<() => void>();

export function publishConsumptionProjectionChange(): void {
  current = { revision: current.revision + 1 };
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
