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

// Bounded log of recent changes so a named/system pane can judge staleness by
// EVERY change since its captured revision, not just the latest one. Add-Content
// publishes per unit synchronously, so a change affecting library B can be
// immediately followed by one affecting C; a B pane must still reconcile even
// though C is the latest scope.
const PLACEMENT_LOG_LIMIT = 64;

interface LoggedPlacementChange {
  readonly revision: number;
  readonly affectedLibraryIds: string[] | "Unknown";
}

let current: LibraryPlacementChange = INITIAL;
const log: LoggedPlacementChange[] = [];
const listeners = new Set<() => void>();

export function publishLibraryPlacementChange(
  affectedLibraryIds: string[] | "Unknown",
): void {
  current = { revision: current.revision + 1, affectedLibraryIds };
  log.push({ revision: current.revision, affectedLibraryIds });
  if (log.length > PLACEMENT_LOG_LIMIT) log.shift();
  for (const listener of listeners) listener();
}

export function subscribeLibraryPlacement(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function libraryPlacementSnapshot(): LibraryPlacementChange {
  return current;
}

// True iff some placement change with revision > sinceRevision lists `libraryId`
// or is Unknown-scoped. If the bounded log no longer reaches back to
// sinceRevision (an intermediate change was evicted), assume affected: a named
// pane must not silently miss a reconciliation it cannot rule out.
export function libraryPlacementAffectedSince(
  sinceRevision: number,
  libraryId: string,
): boolean {
  if (current.revision <= sinceRevision) return false;
  const oldestLogged =
    log.length > 0 ? log[0]!.revision : current.revision + 1;
  if (oldestLogged > sinceRevision + 1) return true;
  for (const change of log) {
    if (change.revision <= sinceRevision) continue;
    if (change.affectedLibraryIds === "Unknown") return true;
    if (change.affectedLibraryIds.includes(libraryId)) return true;
  }
  return false;
}

export function useLibraryPlacementRevision(): LibraryPlacementChange {
  return useSyncExternalStore(
    subscribeLibraryPlacement,
    libraryPlacementSnapshot,
    () => INITIAL,
  );
}
