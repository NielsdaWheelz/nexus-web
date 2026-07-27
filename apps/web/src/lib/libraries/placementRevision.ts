"use client";

import { useSyncExternalStore } from "react";

// Process-local, monotonic Library placement revision. Every definitive browser
// placement writer publishes here after authoritative success; consumers (panes)
// coalesce reconciliation. See
// docs/cutovers/library-all-and-smart-views-hard-cutover.md ("Mutation
// Composition"). No `targets` field: no consumer reads it (simplicity.md).

export interface LibraryPlacementChange {
  revision: number;
  affectedLibraryIds: string[] | "Unknown";
}

const INITIAL: LibraryPlacementChange = { revision: 0, affectedLibraryIds: [] };

let current: LibraryPlacementChange = INITIAL;
const listeners = new Set<() => void>();

export function publishLibraryPlacementChange(
  affectedLibraryIds: string[] | "Unknown",
): void {
  current = { revision: current.revision + 1, affectedLibraryIds };
  for (const listener of listeners) listener();
}

export function subscribeLibraryPlacement(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function libraryPlacementSnapshot(): LibraryPlacementChange {
  return current;
}

export function useLibraryPlacementRevision(): LibraryPlacementChange {
  return useSyncExternalStore(
    subscribeLibraryPlacement,
    libraryPlacementSnapshot,
    () => INITIAL,
  );
}
