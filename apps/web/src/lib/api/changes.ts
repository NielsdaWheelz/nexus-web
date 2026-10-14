"use client";

import { useSyncExternalStore } from "react";

// In-tab change signals (docs/architecture.md §8.12). A writer publishes the
// topics its committed write changed; a mounted view puts their stamp in its
// `stale` token and refetches when it moves. Process-local: nothing crosses
// tabs, and a remount compares the stamp its snapshot was taken at.
//
//   Libraries    the viewer's libraries: created, renamed, deleted, joined
//   Entries      what some library holds or its order
//   Consumption  reading or listening state
//   Metadata     a media's title, authors or first publication
//   Podcasts     a followed show, its settings or its backfill
//   Chats        the chats index
//   Notes        the viewer's pages: created, renamed, deleted
export type ChangeTopic =
  | "Libraries"
  | "Entries"
  | "Consumption"
  | "Metadata"
  | "Podcasts"
  | "Chats"
  | "Notes";

const counts: Record<ChangeTopic, number> = {
  Libraries: 0,
  Entries: 0,
  Consumption: 0,
  Metadata: 0,
  Podcasts: 0,
  Chats: 0,
  Notes: 0,
};
const listeners = new Set<() => void>();

/** Call only after the write committed. */
export function publishChange(...topics: readonly ChangeTopic[]): void {
  for (const topic of topics) counts[topic] += 1;
  for (const listener of listeners) listener();
}

/** The topics' counters as one comparable token, e.g. "3:0". */
export function changeStamp(...topics: readonly ChangeTopic[]): string {
  return topics.map((topic) => counts[topic]).join(":");
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Re-renders only when one of these topics moves. */
export function useChangeStamp(...topics: readonly ChangeTopic[]): string {
  return useSyncExternalStore(
    subscribe,
    () => changeStamp(...topics),
    () => topics.map(() => 0).join(":"),
  );
}
