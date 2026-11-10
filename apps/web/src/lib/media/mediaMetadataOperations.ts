"use client";

/** One document's media observation owner. Presented consumers share due-subset
 * batches on the same 10/30-second grid. Attention joins the current cohort and
 * wakes omitted interests; deliberate exact jobs survive panes until one receipt. */
import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { useAuthenticatedAccount } from "@/lib/account/authenticatedAccount";
import { apiFetch, isApiError, isSameSystemApiDefect, type ApiError } from "@/lib/api/client";
import { readSharedValue } from "@/lib/api/serverState";
import { PASSIVE_OBSERVATION_MS, WORK_OBSERVATION_MS } from "@/lib/api/observationPolicy";
import { useObservationDemand } from "@/lib/api/useObservationDemand";
import type { Retract } from "@/components/feedback/stage";
import { publishChange } from "@/lib/api/changes";
import type { ApiJson, Schema } from "@/lib/api/wire";
import { installedApp, remoteReady, subscribeAdmission } from "@/lib/native/admission";
import { nativeIsForeground, subscribeNativeForeground } from "@/lib/native/foreground";
import { isAbortError } from "@/lib/errors";

export type MetadataEnrichmentView = Schema<"MetadataEnrichmentView">;
export type MetadataOperation = Schema<"MetadataOperationOut">;
export type MediaObservation = Schema<"MediaObservationOut">;
export type MediaObservationState = { readonly status: "loading" }
  | { readonly status: "ready"; readonly observation: MediaObservation | null };
interface Entry {
  snapshot: MediaObservationState;
  stamp: string | null | undefined;
  interests: number;
  generation: number;
  due: number;
  defect: unknown | null;
  readonly listeners: Set<() => void>;
}
const EMPTY: MediaObservationState = { status: "loading" };
const entries = new Map<string, Entry>();
let mediaVersion = 0;
interface AccountScope {
  accountId: string;
  foreground: boolean;
  generation: number;
  timer: ReturnType<typeof setTimeout> | null;
  reading: ReadonlySet<Entry | ExactEntry> | null;
  controller: AbortController | null;
  pendingWake: boolean;
}
let account: AccountScope | null = null;
function nextDue(at: number, interval: number): number {
  return at - at % interval + interval;
}
function entryFor(accountId: string, mediaId: string): Entry {
  const key = `${accountId}:${mediaId}`;
  let entry = entries.get(key);
  if (entry === undefined) {
    entry = { snapshot: EMPTY, stamp: undefined, interests: 0, generation: 0,
      due: 0, defect: null, listeners: new Set() };
    entries.set(key, entry);
  }
  return entry;
}
function pruneMedia(accountId: string, mediaId: string, entry: Entry): void {
  if (entry.interests === 0 && entry.listeners.size === 0) entries.delete(`${accountId}:${mediaId}`);
}
function receive(entry: Entry, observation: MediaObservation | null): void {
  const known = entry.stamp;
  const view = observation?.metadata_enrichment ?? null;
  entry.stamp = view?.last_enriched_at;
  entry.snapshot = { status: "ready", observation };
  entry.defect = null;
  mediaVersion += 1;
  for (const listener of entry.listeners) listener();
  if (view === null || known === undefined || view.last_enriched_at === known) return;
  const latest = view.operation;
  const fields = latest?.status === "completed" && latest.outcome.completed_at === view.last_enriched_at
    ? latest.outcome.changed_fields : null;
  if (fields === null || fields.length > 0) publishChange("Metadata");
}
function arm(scope: AccountScope): void {
  if (scope.timer !== null) clearTimeout(scope.timer);
  scope.timer = null;
  if (account !== scope || !scope.foreground || scope.reading !== null) return;
  const due = Math.min(
    ...[...entries].filter(([key, entry]) => key.startsWith(`${scope.accountId}:`) && entry.interests > 0).map(([, entry]) => entry.due),
    ...[...exactEntries.values()].filter(entry => entry.accountId === scope.accountId && (entry.interest !== null || entry.presented > 0) && entry.snapshot.status !== "settled").map(entry => entry.due),
  );
  if (Number.isFinite(due)) scope.timer = setTimeout(() => { scope.timer = null; run(scope); }, Math.max(0, due - Date.now()));
}
function wake(scope: AccountScope): void {
  if (account !== scope || !scope.foreground) return;
  if (scope.reading !== null && scope.controller?.signal.aborted) scope.pendingWake = true;
  else {
    for (const [key, entry] of entries) if (key.startsWith(`${scope.accountId}:`) && entry.interests > 0 && !scope.reading?.has(entry)) entry.due = 0;
    for (const entry of exactEntries.values()) if (entry.accountId === scope.accountId && entry.snapshot.status !== "settled" && !scope.reading?.has(entry)) entry.due = 0;
  }
  arm(scope);
}
function run(scope: AccountScope): void {
  if (account !== scope || !scope.foreground || scope.reading !== null) return;
  const now = Date.now();
  const media = [...entries].filter(([key, entry]) => key.startsWith(`${scope.accountId}:`) && entry.interests > 0 && entry.due <= now)
    .map(([key, entry]) => ({ id: key.slice(scope.accountId.length + 1), entry, generation: entry.generation })).sort((a, b) => a.id.localeCompare(b.id));
  const jobs = [...exactEntries.values()].filter(entry => entry.accountId === scope.accountId && (entry.interest !== null || entry.presented > 0) && entry.snapshot.status !== "settled" && entry.due <= now);
  if (media.length === 0 && jobs.length === 0) { arm(scope); return; }
  const generation = scope.generation;
  const controller = new AbortController(); scope.controller = controller;
  const current = () => account === scope && scope.foreground && scope.generation === generation && !controller.signal.aborted;
  for (const { entry } of media) entry.due = Infinity;
  for (const entry of jobs) entry.due = Infinity;
  scope.reading = new Set([...media.map(({ entry }) => entry), ...jobs]);
  void (async () => {
    const reads: Promise<void>[] = [];
    for (let offset = 0; offset < media.length; offset += 100) {
      const batch = media.slice(offset, offset + 100);
      const ids = batch.map(item => item.id);
      const body = JSON.stringify({ media_ids: ids });
      reads.push((async () => {
        try {
          const response = await readSharedValue({ accountId: scope.accountId, key: `media-observations:${ids.join(",")}`,
            readPolicy: "media-observations", timeoutMs: 30_000, signal: controller.signal,
            load: signal => apiFetch<ApiJson<"/media/observations/resolve", "post">>("/api/media/observations/resolve", { method: "POST", body, signal }) });
          if (!current()) return;
          if (response.data.items.length !== batch.length || response.data.items.some((item, index) => item.media_id !== ids[index])) throw new Error("media observations do not match their requested identities");
          const acceptedAt = Date.now();
          for (let index = 0; index < batch.length; index += 1) {
            const held = batch[index];
            if (held.entry.interests === 0 || held.entry.generation !== held.generation || entries.get(`${scope.accountId}:${held.id}`) !== held.entry) continue;
            const value = response.data.items[index].observation;
            receive(held.entry, value);
            if (held.entry.due !== 0) held.entry.due = nextDue(acceptedAt, value !== null && (value.processing.work_in_flight || value.metadata_enrichment.work_in_flight) ? WORK_OBSERVATION_MS : PASSIVE_OBSERVATION_MS);
          }
        } catch (error) {
          if (!current() || isAbortError(error)) return;
          if (!isApiError(error) || isSameSystemApiDefect(error)) for (const held of batch) {
            if (held.entry.interests === 0 || held.entry.generation !== held.generation) continue;
            held.entry.defect = error; mediaVersion += 1;
            for (const listener of held.entry.listeners) listener();
          }
        }
      })());
    }
    for (const entry of jobs) reads.push((async () => {
      const entryGeneration = entry.generation;
      try {
        const operation = await readSharedValue({ accountId: scope.accountId, key: `metadata-job:${entry.mediaId}:${entry.jobId}`,
          timeoutMs: 30_000, signal: controller.signal,
          load: async signal => (await apiFetch<ApiJson<"/media/{media_id}/metadata-enrichment/{job_id}", "get">>(`/api/media/${encodeURIComponent(entry.mediaId)}/metadata-enrichment/${encodeURIComponent(entry.jobId)}`, { signal })).data });
        if (!current() || exactEntries.get(`${entry.accountId}:${entry.mediaId}:${entry.jobId}`) !== entry || entry.interest === null && (entry.presented === 0 || entry.generation !== entryGeneration)) return;
        entry.defect = null;
        showExact(entry, isSettled(operation) ? { status: "settled", operation } : { status: "following", operation });
        if (entry.due !== 0) entry.due = nextDue(Date.now(), operation.status === "held" ? PASSIVE_OBSERVATION_MS : WORK_OBSERVATION_MS);
        pruneExact(entry);
      } catch (error) {
        if (!current() || isAbortError(error) || entry.interest === null && (entry.presented === 0 || entry.generation !== entryGeneration)) return;
        if (!isApiError(error) || isSameSystemApiDefect(error)) { entry.defect = error; showExact(entry, entry.snapshot); return; }
        const previous = entry.snapshot;
        if (previous.status !== "interrupted" || previous.error.code !== error.code || previous.error.status !== error.status)
          showExact(entry, { status: "interrupted", operation: [401, 403, 404].includes(error.status) ? null : observedOperation(entry), error });
      }
    })());
    await Promise.all(reads);
  })().finally(() => {
    const finishedAt = Date.now();
    for (const { entry } of media) if (entry.due === Infinity) {
      const value = entry.snapshot.status === "ready" ? entry.snapshot.observation : null;
      entry.due = nextDue(finishedAt, value !== null && (value.processing.work_in_flight || value.metadata_enrichment.work_in_flight) ? WORK_OBSERVATION_MS : PASSIVE_OBSERVATION_MS);
    }
    for (const entry of jobs) if (entry.due === Infinity && entry.snapshot.status !== "interrupted")
      entry.due = nextDue(finishedAt, observedOperation(entry)?.status === "held" ? PASSIVE_OBSERVATION_MS : WORK_OBSERVATION_MS);
    scope.reading = null; scope.controller = null;
    if (scope.pendingWake) { scope.pendingWake = false; wake(scope); }
    else arm(scope);
  });
}

/** Wake only already-presented consumers; command admission does not acquire observation. */
export function reconnectMetadataOperations(mediaId: string): void {
  const scope = account;
  const entry = scope === null ? undefined : entries.get(`${scope.accountId}:${mediaId}`);
  if (scope !== null && entry !== undefined && entry.interests > 0) { entry.due = 0; arm(scope); }
}

/** One account owns only current media consumers and unresolved deliberate job interests. */
export function startMetadataAccount(accountId: string): () => void {
  const scope: AccountScope = { accountId, foreground: false, generation: 0, timer: null, reading: null, controller: null, pendingWake: false };
  account = scope;
  let shown = document.visibilityState === "visible";
  const update = () => {
    const foreground = shown && document.visibilityState === "visible" && (!installedApp || nativeIsForeground() && remoteReady());
    if (foreground === scope.foreground) return;
    scope.foreground = foreground; scope.generation += 1;
    if (foreground) wake(scope);
    else { scope.controller?.abort(); arm(scope); }
  };
  const visible = () => { shown = true; update(); };
  const hidden = () => { shown = false; update(); };
  const attention = () => { update(); wake(scope); };
  const admission = () => { update(); if (remoteReady()) wake(scope); };
  const native = subscribeNativeForeground(update);
  const admitted = subscribeAdmission(admission);
  document.addEventListener("visibilitychange", update);
  window.addEventListener("pageshow", visible);
  window.addEventListener("pagehide", hidden);
  window.addEventListener("focus", attention);
  window.addEventListener("online", attention);
  update();
  return () => {
    if (account !== scope) return;
    scope.foreground = false; scope.controller?.abort();
    if (scope.timer !== null) clearTimeout(scope.timer);
    native(); admitted();
    document.removeEventListener("visibilitychange", update);
    window.removeEventListener("pageshow", visible);
    window.removeEventListener("pagehide", hidden);
    window.removeEventListener("focus", attention);
    window.removeEventListener("online", attention);
    for (const [key] of entries) if (key.startsWith(`${accountId}:`)) entries.delete(key);
    for (const [key, entry] of exactEntries) if (entry.accountId === accountId) { entry.interest?.retract(); exactEntries.delete(key); }
    account = null;
  };
}

/** Retained snapshots do not authorize a timer. Only current presentation owns interest. */
export function useMediaObservations(mediaIds: readonly string[], presented: boolean): ReadonlyMap<string, MediaObservationState> {
  const { accountId } = useAuthenticatedAccount();
  const demand = useObservationDemand(presented);
  const key = [...new Set(mediaIds)].sort().join(",");
  const ids = useMemo(() => key ? key.split(",") : [], [key]);
  const subscribe = useCallback((listener: () => void) => {
    for (const id of ids) entryFor(accountId, id).listeners.add(listener);
    return () => { for (const id of ids) { const entry = entries.get(`${accountId}:${id}`); if (entry) { entry.listeners.delete(listener); pruneMedia(accountId, id, entry); } } };
  }, [accountId, ids]);
  useSyncExternalStore(subscribe, () => mediaVersion, () => 0);
  useEffect(() => {
    if (!demand) return;
    for (const id of ids) { const entry = entryFor(accountId, id); if (entry.interests++ === 0) { entry.generation += 1; entry.due = 0; } }
    if (account?.accountId === accountId) arm(account);
    return () => {
      for (const id of ids) {
        const entry = entries.get(`${accountId}:${id}`);
        if (entry) { entry.interests -= 1; if (entry.interests === 0) entry.generation += 1; pruneMedia(accountId, id, entry); }
      }
      if (account?.accountId === accountId) arm(account);
    };
  }, [accountId, demand, ids]);
  return new Map(ids.map(id => {
    const entry = entryFor(accountId, id);
    if (entry.defect !== null) throw entry.defect;
    return [id, entry.snapshot];
  }));
}
export function useMediaObservation(mediaId: string | null, presented: boolean): MediaObservationState {
  const observations = useMediaObservations(mediaId === null ? [] : [mediaId], presented);
  return mediaId === null ? EMPTY : observations.get(mediaId) ?? EMPTY;
}

export interface MetadataPresentation {
  readonly title: string;
  readonly purpose: Schema<"MetadataRetryAllowed">["purpose"];
  readonly originPaneId: string | null;
}
export type SettledMetadataOperation = Extract<MetadataOperation, { status: "completed" | "failed" }>;
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
  presented: number;
  generation: number;
  readonly listeners: Set<() => void>;
  snapshot: MetadataOperationObservation;
  due: number;
  interest: MetadataInterest | null;
  defect: unknown | null;
}
export type MetadataFeedback = MetadataPresentation & {
  readonly accountId: string;
  readonly mediaId: string;
  readonly jobId: string;
  readonly retract: Retract;
} & (
  | { readonly kind: "Terminal"; readonly operation: SettledMetadataOperation }
  | { readonly kind: "Held"; readonly operation: Extract<MetadataOperation, { status: "held" }> }
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
    entry = { accountId, mediaId, jobId, presented: 0, generation: 0, listeners: new Set(), snapshot: EMPTY_EXACT,
      due: 0, interest: null, defect: null };
    exactEntries.set(key, entry);
  }
  return entry;
}

function pruneExact(entry: ExactEntry): void {
  if (entry.interest !== null || entry.presented > 0 || entry.listeners.size > 0) return;
  exactEntries.delete(`${entry.accountId}:${entry.mediaId}:${entry.jobId}`);
  if (account !== null) arm(account);
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
  return operation.status === "completed" || operation.status === "failed";
}

/** Explicit status repair reads the same job; it never admits work. */
export function reconnectMetadataOperation(mediaId: string, jobId: string): void {
  if (account === null) return;
  const entry = exactEntryFor(account.accountId, mediaId, jobId);
  const previous = observedOperation(entry);
  if (previous !== null) showExact(entry, { status: "reconnecting", operation: previous });
  entry.due = 0;
  arm(account);
}

/** Ordinary inspection subscribes without acquiring notification interest. */
export function useMetadataOperation(mediaId: string | null, jobId: string | null): MetadataOperationObservation {
  const demand = useObservationDemand(mediaId !== null && jobId !== null);
  const { accountId } = useAuthenticatedAccount();
  const subscribe = useCallback((listener: () => void) => {
    if (mediaId === null || jobId === null) return () => {};
    const entry = exactEntryFor(accountId, mediaId, jobId);
    entry.listeners.add(listener);
    return () => { entry.listeners.delete(listener); pruneExact(entry); };
  }, [accountId, mediaId, jobId]);
  useEffect(() => {
    if (!demand || mediaId === null || jobId === null) return;
    const entry = exactEntryFor(accountId, mediaId, jobId);
    entry.presented += 1; entry.generation += 1; entry.due = 0;
    if (account?.accountId === accountId) arm(account);
    return () => { entry.presented -= 1; entry.generation += 1; pruneExact(entry); if (account?.accountId === accountId) arm(account); };
  }, [accountId, demand, mediaId, jobId]);
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
  const summary = entries.get(`${scope.accountId}:${receipt.media_id}`);
  if (summary !== undefined && summary.stamp === undefined) summary.stamp = receipt.last_enriched_at;
  const entry = exactEntryFor(scope.accountId, receipt.media_id, receipt.job_id);
  if (entry.interest !== null) { retract(); return; }
  entry.interest = { ...presentation, retract, reported: null };
  entry.due = 0;
  arm(scope);
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
      if (snapshot.operation.status === "failed" && snapshot.operation.code === "superseded")
        interest.retract();
      else present({ ...identity, kind: "Terminal", operation: snapshot.operation });
      pruneExact(entry);
    } else if (snapshot.status === "following" && snapshot.operation.status === "held") {
      entry.interest = null;
      present({ ...identity, kind: "Held", operation: snapshot.operation });
      pruneExact(entry);
    } else if (snapshot.status === "interrupted") {
      interest.reported = snapshot;
      present({ ...identity, kind: "Interrupted", error: snapshot.error });
    }
  }
}
