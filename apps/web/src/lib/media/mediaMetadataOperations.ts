"use client";

// The account owns media summaries and exact-job observation. Inspection subscribes;
// explicit admission also owns a temporary notification interest after its pane closes.
// Only an actual metadata stamp publishes a change; terminal manual reads invalidate
// details independently, including receipts for already-completed work.

import { useCallback, useSyncExternalStore } from "react";
import { useAuthenticatedAccount } from "@/lib/account/authenticatedAccount";
import { apiFetch, isApiError, isSameSystemApiDefect, type ApiError } from "@/lib/api/client";
import type { Retract } from "@/components/feedback/stage";
import { publishChange } from "@/lib/api/changes";
import { openStream } from "@/lib/api/stream";
import type { ApiJson, Schema } from "@/lib/api/wire";
import { publishImportsInvalidation } from "@/lib/imports/api";

export type MetadataEnrichmentView = Schema<"MetadataEnrichmentView">;
export type MetadataOperation = Schema<"MetadataOperationOut">;

/** A lost or paused stream over a shown view says nothing; a later mount or admission reads again. */
interface Observation {
  readonly view: MetadataEnrichmentView | null;
}
interface Entry {
  snapshot: Observation;
  /** The last enrichment stamp this tab knew; undefined before the first. */
  stamp: string | null | undefined;
  stop: (() => void) | null;
  readonly listeners: Set<() => void>;
}
const EMPTY: Observation = { view: null };
const entries = new Map<string, Entry>();
interface AccountScope {
  accountId: string;
  controller: AbortController;
}
let account: AccountScope | null = null;
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
  show(entry, { view });
  if (known === undefined || view.last_enriched_at === known) return;
  // An older job can land while a newer one is latest: without its fields, assume a change.
  const latest = view.operation;
  const fields =
    latest?.status === "completed" &&
    latest.outcome.completed_at === view.last_enriched_at
      ? latest.outcome.changed_fields
      : null;
  if (fields === null || fields.length > 0)
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
    onSuspended: () => {},
    onError: () => {
      entry.stop = null;
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
    for (const entry of exactEntries.values()) {
      if (entry.accountId !== accountId) continue;
      entry.interest?.retract();
      entry.stop?.();
      exactEntries.delete(`${entry.accountId}:${entry.mediaId}:${entry.jobId}`);
    }
    account = null;
  };
}

export interface MetadataPresentation {
  readonly title: string;
  readonly purpose: Schema<"MetadataRetryAllowed">["purpose"];
  readonly originPaneId: string | null;
}
export type SettledMetadataOperation = Extract<MetadataOperation, { status: "completed" | "no_findings" | "failed" }>;
export type MetadataOperationObservation =
  | { readonly status: "loading" }
  | { readonly status: "following"; readonly operation: Exclude<MetadataOperation, SettledMetadataOperation> }
  | { readonly status: "settled"; readonly operation: SettledMetadataOperation }
  | { readonly status: "reconnecting"; readonly operation: MetadataOperation | null }
  | { readonly status: "suspended" | "interrupted"; readonly operation: MetadataOperation | null; readonly error: ApiError };
interface MetadataInterest extends MetadataPresentation {
  readonly retract: Retract;
  reported: MetadataOperationObservation | null;
}
interface ExactEntry {
  readonly accountId: string;
  readonly mediaId: string;
  readonly jobId: string;
  readonly listeners: Set<() => void>;
  snapshot: MetadataOperationObservation;
  stop: (() => void) | null;
  interest: MetadataInterest | null;
  defect: Error | null;
}
export type MetadataFeedback = MetadataPresentation & {
  readonly accountId: string;
  readonly mediaId: string;
  readonly jobId: string;
  readonly retract: Retract;
} & (
  | { readonly kind: "Terminal"; readonly operation: SettledMetadataOperation }
  | { readonly kind: "Interrupted"; readonly error: ApiError }
);
const EMPTY_EXACT: MetadataOperationObservation = { status: "loading" };
const exactEntries = new Map<string, ExactEntry>();
const feedbackListeners = new Set<() => void>();
let feedbackVersion = 0;

function exactEntryFor(accountId: string, mediaId: string, jobId: string): ExactEntry {
  const key = `${accountId}:${mediaId}:${jobId}`;
  let entry = exactEntries.get(key);
  if (entry === undefined) {
    entry = { accountId, mediaId, jobId, listeners: new Set(), snapshot: EMPTY_EXACT,
      stop: null, interest: null, defect: null };
    exactEntries.set(key, entry);
  }
  return entry;
}

function pruneExact(entry: ExactEntry): void {
  if (entry.interest !== null || entry.listeners.size > 0) return;
  entry.stop?.();
  exactEntries.delete(`${entry.accountId}:${entry.mediaId}:${entry.jobId}`);
}

function changedFeedback(): void {
  feedbackVersion += 1;
  for (const listener of feedbackListeners) listener();
}

function showExact(entry: ExactEntry, snapshot: MetadataOperationObservation): void {
  entry.snapshot = snapshot;
  for (const listener of entry.listeners) listener();
  if (entry.interest !== null) changedFeedback();
}

function observedOperation(entry: ExactEntry): MetadataOperation | null {
  return entry.snapshot.status === "loading" ? null : entry.snapshot.operation;
}

function isSettled(operation: MetadataOperation): operation is SettledMetadataOperation {
  return operation.status === "completed" || operation.status === "no_findings" || operation.status === "failed";
}

function followExact(scope: AccountScope, entry: ExactEntry, restart = false): void {
  if (account !== scope || scope.controller.signal.aborted) return;
  if (entry.stop !== null && !restart) return;
  entry.stop?.();
  entry.defect = null;
  const previous = observedOperation(entry);
  showExact(entry, previous === null ? EMPTY_EXACT : { status: "reconnecting", operation: previous });
  entry.stop = openStream<MetadataOperation, MetadataOperation>({
    path: `/api/stream/media/${encodeURIComponent(entry.mediaId)}/metadata-enrichment/${encodeURIComponent(entry.jobId)}/events`,
    signal: scope.controller.signal,
    decode: (_type, operation) => operation,
    isTerminal: isSettled,
    onEvent: operation => showExact(entry, isSettled(operation)
      ? { status: "settled", operation } : { status: "following", operation }),
    onComplete: () => { entry.stop = null; pruneExact(entry); },
    onReconnect: () => showExact(entry, { status: "reconnecting", operation: observedOperation(entry) }),
    onSuspended: error => showExact(entry, { status: "suspended",
      operation: error.status === 401 || error.status === 403 || error.status === 404 ? null : observedOperation(entry), error }),
    onError: error => {
      entry.stop = null;
      if (!isApiError(error) || isSameSystemApiDefect(error)) {
        entry.defect = error;
        showExact(entry, entry.snapshot);
        return;
      }
      showExact(entry, { status: "interrupted",
        operation: error.status === 401 || error.status === 403 || error.status === 404 ? null : observedOperation(entry), error });
    },
  });
}

/** Inspection and explicit status repair read the same job; neither admits work. */
export function reconnectMetadataOperation(mediaId: string, jobId: string): void {
  if (account !== null) followExact(account, exactEntryFor(account.accountId, mediaId, jobId), true);
}

/** Ordinary inspection subscribes without acquiring notification interest. */
export function useMetadataOperation(mediaId: string | null, jobId: string | null): MetadataOperationObservation {
  const { accountId } = useAuthenticatedAccount();
  const subscribe = useCallback((listener: () => void) => {
    if (mediaId === null || jobId === null) return () => {};
    const entry = exactEntryFor(accountId, mediaId, jobId);
    entry.listeners.add(listener);
    if (account?.accountId === accountId) followExact(account, entry);
    return () => { entry.listeners.delete(listener); pruneExact(entry); };
  }, [accountId, mediaId, jobId]);
  const read = useCallback(() => {
    if (mediaId === null || jobId === null) return EMPTY_EXACT;
    const entry = exactEntryFor(accountId, mediaId, jobId);
    if (entry.defect !== null) throw entry.defect;
    return entry.snapshot;
  }, [accountId, mediaId, jobId]);
  return useSyncExternalStore(subscribe, read, () => EMPTY_EXACT);
}

/** Acknowledgment transfers to exact observation before the admission owner retires. */
export function observeMetadataAdmission(
  receipt: ApiJson<"/media/{media_id}/metadata-enrichment", "post">["data"],
  presentation: MetadataPresentation,
  retract: Retract,
): void {
  const scope = account;
  if (scope === null) { retract(); return; }
  const summary = entryFor(scope.accountId, receipt.media_id);
  if (summary.stamp === undefined) summary.stamp = receipt.last_enriched_at;
  const entry = exactEntryFor(scope.accountId, receipt.media_id, receipt.job_id);
  if (entry.interest !== null) { retract(); return; }
  entry.interest = { ...presentation, retract, reported: null };
  followExact(scope, entry);
  changedFeedback();
}

/** One host receives only unresolved deliberate interests; there is no history queue. */
export function useMetadataFeedback(): number {
  const subscribe = useCallback((listener: () => void) => {
    feedbackListeners.add(listener);
    return () => { feedbackListeners.delete(listener); };
  }, []);
  return useSyncExternalStore(subscribe, () => feedbackVersion, () => 0);
}

/** Consume before presentation, then release the observer after its immutable receipt is delivered. */
export function presentMetadataFeedback(present: (feedback: MetadataFeedback) => void): void {
  const scope = account;
  if (scope === null) return;
  for (const entry of exactEntries.values()) {
    const interest = entry.interest;
    if (entry.accountId !== scope.accountId || interest === null) continue;
    if (entry.defect !== null) throw entry.defect;
    const snapshot = entry.snapshot;
    if (snapshot === interest.reported) continue;
    const identity = { accountId: entry.accountId, title: interest.title, purpose: interest.purpose, originPaneId: interest.originPaneId,
      mediaId: entry.mediaId, jobId: entry.jobId, retract: interest.retract };
    if (snapshot.status === "settled") {
      entry.interest = null;
      present({ ...identity, kind: "Terminal", operation: snapshot.operation });
      pruneExact(entry);
    } else if (snapshot.status === "interrupted") {
      interest.reported = snapshot;
      present({ ...identity, kind: "Interrupted", error: snapshot.error });
    }
  }
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
  onAccepted?: () => void,
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
  onAccepted?.();
  publishImportsInvalidation();
  follow(scope, mediaId, true);
  const exact = exactEntries.get(`${scope.accountId}:${mediaId}:${jobId}`);
  if (exact !== undefined) followExact(scope, exact, true);
}
