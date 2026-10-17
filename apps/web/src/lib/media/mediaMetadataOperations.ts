"use client";

// Metadata research on the client: review and one live view per account/media. The
// server's metadata stream ends once nothing is unfinished, so a view is followed while
// research can change it: from a mount (one short read when idle), an admission (answered
// or lost), a review, a reconnect or a settled import, to its run's end even after its
// pane closes. A new stamp whose run changed a summary field publishes "Metadata".

import { useCallback, useSyncExternalStore } from "react";
import { useAuthenticatedAccount } from "@/lib/account/authenticatedAccount";
import { apiFetch } from "@/lib/api/client";
import { publishChange } from "@/lib/api/changes";
import { openStream } from "@/lib/api/stream";
import type { Schema } from "@/lib/api/wire";
import { publishImportsInvalidation } from "@/lib/imports/api";

export type MetadataEnrichmentView = Schema<"MetadataEnrichmentView">;
export type MetadataOperation = Schema<"MetadataOperationOut">;

interface Observation {
  readonly view: MetadataEnrichmentView | null;
  readonly disconnected: boolean;
}
interface Entry {
  snapshot: Observation;
  /** The last enrichment stamp this tab knew; undefined before the first. */
  stamp: string | null | undefined;
  stop: (() => void) | null;
  readonly listeners: Set<() => void>;
}
const EMPTY: Observation = { view: null, disconnected: false };
const entries = new Map<string, Entry>();
interface AccountScope {
  accountId: string;
  controller: AbortController;
}
let account: AccountScope | null = null;
const SUMMARY_FIELDS = new Set<string>([
  "title",
  "contributors",
  "original_published_date",
]);

function entryFor(accountId: string, mediaId: string): Entry {
  const key = `${accountId}:${mediaId}`;
  let entry = entries.get(key);
  if (entry === undefined) {
    entry = {
      snapshot: EMPTY,
      stamp: undefined,
      stop: null,
      listeners: new Set(),
    };
    entries.set(key, entry);
  }
  return entry;
}

function show(entry: Entry, snapshot: Observation): void {
  entry.snapshot = snapshot;
  for (const listener of entry.listeners) listener();
}

function receive(entry: Entry, view: MetadataEnrichmentView): void {
  const known = entry.stamp;
  entry.stamp = view.last_enriched_at;
  show(entry, { view, disconnected: false });
  if (known === undefined || view.last_enriched_at === known) return;
  // An older job can land while a newer one is latest: without its fields, assume a change.
  const latest = view.operation;
  const fields =
    latest?.status === "completed" &&
    latest.outcome.completed_at === view.last_enriched_at
      ? latest.outcome.changed_fields
      : null;
  if (fields === null || fields.some((field) => SUMMARY_FIELDS.has(field)))
    publishChange("Metadata");
}

/** Open the media's stream unless one runs; `restart` replaces a running one. */
function follow(scope: AccountScope, mediaId: string, restart = false): void {
  if (account !== scope || scope.controller.signal.aborted) return;
  const entry = entryFor(scope.accountId, mediaId);
  if (entry.stop !== null && !restart) return;
  entry.stop?.();
  entry.stop = openStream<MetadataEnrichmentView, MetadataEnrichmentView>({
    path: `/api/stream/media/${encodeURIComponent(mediaId)}/metadata/events`,
    signal: scope.controller.signal,
    decode: (_type, view) => view,
    isTerminal: (view) => view.unfinished_count === 0,
    onEvent: (view) => receive(entry, view),
    onComplete: () => {
      entry.stop = null;
    },
    onReconnect: () => show(entry, { ...entry.snapshot, disconnected: true }),
    onError: () => {
      entry.stop = null;
      show(entry, { ...entry.snapshot, disconnected: true });
    },
  });
}

/** Read the media's view again and follow any unfinished research. */
export function reconnectMetadataOperations(mediaId: string): void {
  if (account !== null) follow(account, mediaId, true);
}

/** The authenticated host owns streams that intentionally outlive a pane. */
export function startMetadataAccount(accountId: string): () => void {
  const scope = { accountId, controller: new AbortController() };
  account = scope;
  return () => {
    scope.controller.abort();
    if (account !== scope) return;
    for (const [key, entry] of entries) {
      if (!key.startsWith(`${accountId}:`)) continue;
      entry.stop?.();
      entries.delete(key);
    }
    account = null;
  };
}

/** Preserve the observed stamp before the admitted run can publish its first frame. */
export function observeMetadataAdmission(mediaId: string, stamp: string | null): void {
  if (account === null) return;
  const entry = entryFor(account.accountId, mediaId);
  if (entry.stamp === undefined) entry.stamp = stamp;
}

/** The media's live view; mounting reads it once more. */
export function useMediaMetadataOperations(
  mediaId: string | null,
): Observation {
  const { accountId } = useAuthenticatedAccount();
  const subscribe = useCallback(
    (listener: () => void) => {
      if (mediaId === null) return () => {};
      const entry = entryFor(accountId, mediaId);
      entry.listeners.add(listener);
      if (account?.accountId === accountId) follow(account, mediaId);
      return () => entry.listeners.delete(listener);
    },
    [accountId, mediaId],
  );
  const snapshot = useCallback(
    () => (mediaId === null ? EMPTY : entryFor(accountId, mediaId).snapshot),
    [accountId, mediaId],
  );
  return useSyncExternalStore(subscribe, snapshot, () => EMPTY);
}

/** Mark one no-findings result reviewed for this viewer; a repeat is a no-op. */
export async function submitMetadataResultReview(
  mediaId: string,
  jobId: string,
): Promise<void> {
  const scope = account;
  if (scope === null) return;
  try {
    await apiFetch(
      `/api/media/${encodeURIComponent(mediaId)}/metadata-enrichment/${encodeURIComponent(jobId)}/review`,
      { method: "POST" },
    );
  } catch (error) {
    if (account !== scope) return;
    throw error;
  }
  if (account !== scope) return;
  publishImportsInvalidation();
  follow(scope, mediaId, true);
}
