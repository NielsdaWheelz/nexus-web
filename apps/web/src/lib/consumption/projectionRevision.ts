"use client";

import { useSyncExternalStore } from "react";

// Process-local, monotonic consumption revisions. Every authoritative state, cursor and
// accepted-heartbeat write advances `revision`; only accepted row-changing writes advance
// `rowRevision`, so listings can refresh facts without resetting pagination on heartbeats.

export interface ConsumptionProjectionChange {
  readonly revision: number;
  readonly rowRevision: number;
}

const INITIAL: ConsumptionProjectionChange = { revision: 0, rowRevision: 0 };
let current = INITIAL;
const listeners = new Set<() => void>();

export function publishConsumptionProjectionChange(options?: { readonly rowChanged: boolean }) {
  const rowRevision = current.rowRevision + (options?.rowChanged ? 1 : 0);
  current = { revision: current.revision + 1, rowRevision };
  for (const listener of listeners) listener();
}

export const consumptionProjectionSnapshot = (): ConsumptionProjectionChange => current;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useConsumptionProjectionRevision(): ConsumptionProjectionChange {
  return useSyncExternalStore(subscribe, consumptionProjectionSnapshot, () => INITIAL);
}
