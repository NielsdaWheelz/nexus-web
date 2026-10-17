"use client";

// Only these two admissions survive a browser restart. The stored expectation
// is the command; Imports owns the work after acceptance. A native operation
// lock and a fresh persisted dispatch id fence sends and later local cleanup.
import type { FeedbackContent } from "@/components/feedback/Feedback";
import {
  apiFetch,
  isApiError,
  isStaleBuild,
  isUnauthenticatedApiError,
  type ApiError,
} from "@/lib/api/client";
import type { ApiJson, Schema } from "@/lib/api/wire";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { isAbortError } from "@/lib/errors";
import { publishImportsInvalidation } from "@/lib/imports/api";
import {
  observeMetadataAdmission,
  reconnectMetadataOperations,
} from "@/lib/media/mediaMetadataOperations";
import { expectExactRecord, expectCanonicalRfcUuid } from "@/lib/validation";

export type AdmissionIntent =
  | { kind: "SourceRefresh"; mediaId: string; request: Schema<"RefreshSourceRequest"> }
  | { kind: "MetadataResearch"; mediaId: string; request: Schema<"MetadataEnrichmentRequest"> };

interface StoredAdmission {
  version: 1;
  dispatchId: string;
  intent: AdmissionIntent;
}

export type AdmissionResult =
  | { kind: "Accepted" }
  | { kind: "Pending"; key: string }
  | { kind: "LocalFailure"; content: FeedbackContent }
  | { kind: "OwnerGone" };

export type AdmissionEntry = StoredAdmission & { key: string } & (
  | { kind: "Sending" }
  | { kind: "Unconfirmed"; requestId?: string }
  | { kind: "Blocked"; reason: "Access" | "StateChanged" | "Authentication" | "Build" | "Storage" | "Locks" | "Defect";
      content: FeedbackContent; canConfirm: boolean }
  | { kind: "Cleanup"; settlement: "Accepted" | "Refused" }
);

interface StorageProblem {
  kind: "Storage" | "UnreadableRecord";
  content: FeedbackContent;
}

export interface AdmissionSnapshot {
  entries: readonly AdmissionEntry[];
  problem: StorageProblem | null;
}

export const EMPTY_ADMISSIONS: AdmissionSnapshot = { entries: [], problem: null };
const PREFIX = "nx_media_admission.v1:";
const SEND_DEADLINE_MS = 30_000;

class BrowserRecoveryError extends Error {
  constructor(readonly kind: "Storage" | "Locks", cause?: unknown) {
    super(`Admission recovery ${kind.toLowerCase()} unavailable`, { cause });
  }
}

class UnreadableAdmission extends Error {
  constructor(readonly key: string, cause: unknown) {
    // justify-defect: this owner cannot interpret its own persisted request;
    // retain it for repair and prohibit admission instead of guessing a replay.
    super("Saved admission requires repair", { cause });
  }
}

function browserFailure(error: unknown): boolean {
  return error instanceof DOMException &&
    (error.name === "SecurityError" || error.name === "QuotaExceededError" ||
      error.name === "NotSupportedError");
}

function storage<T>(work: (store: Storage) => T): T {
  try {
    return work(window.localStorage);
  } catch (error) {
    if (browserFailure(error)) throw new BrowserRecoveryError("Storage", error);
    throw error;
  }
}

function browserFailureContent(kind: "Storage" | "Locks"): FeedbackContent {
  return {
    tone: "Warning",
    title: "request not sent",
    message: kind === "Storage"
      ? "this browser couldn't save the recovery request. allow site storage or free some space, then try again."
      : "this browser can't coordinate a recoverable request. use a browser with web locks on a secure connection.",
  };
}

function expectation(intent: AdmissionIntent): string | null {
  return intent.kind === "SourceRefresh"
    ? intent.request.expected_attempt_id
    : intent.request.expected_job_id;
}

function decode(key: string, raw: string): StoredAdmission {
  try {
    const value = expectExactRecord(JSON.parse(raw), ["version", "dispatchId", "intent"], "admission");
    if (value.version !== 1) throw new TypeError("Unknown admission record version");
    const dispatchId = expectCanonicalRfcUuid(value.dispatchId, "admission dispatch id");
    const intent = expectExactRecord(value.intent, ["kind", "mediaId", "request"], "admission intent");
    const mediaId = expectCanonicalRfcUuid(intent.mediaId, "admission media id");
    if (intent.kind === "SourceRefresh") {
      const request = expectExactRecord(intent.request, ["expected_attempt_id"], "source refresh request");
      return { version: 1, dispatchId, intent: {
        kind: "SourceRefresh", mediaId,
        request: { expected_attempt_id: expectCanonicalRfcUuid(request.expected_attempt_id, "expected source attempt") },
      } };
    }
    if (intent.kind === "MetadataResearch") {
      const request = expectExactRecord(intent.request, ["expected_job_id"], "metadata request");
      return { version: 1, dispatchId, intent: {
        kind: "MetadataResearch", mediaId,
        request: { expected_job_id: request.expected_job_id === null ? null : expectCanonicalRfcUuid(request.expected_job_id, "expected metadata job") },
      } };
    }
    throw new TypeError("Unknown admission intent");
  } catch (cause) {
    throw new UnreadableAdmission(key, cause);
  }
}

function definiteRefusal(intent: AdmissionIntent, error: ApiError): boolean {
  if (error.status === 404 && error.code === "E_MEDIA_NOT_FOUND") return true;
  if (error.status === 403)
    return error.code === (intent.kind === "SourceRefresh" ? "E_OWNER_REQUIRED" : "E_FORBIDDEN");
  return error.status === 409 &&
    (error.code === "E_RESOURCE_CONFLICT" || error.code === "E_RETRY_NOT_ALLOWED" ||
      (intent.kind === "SourceRefresh" && error.code === "E_REPAIR_NOT_ALLOWED"));
}

function refusalContent(intent: AdmissionIntent, error: ApiError): FeedbackContent {
  const subject = intent.kind === "SourceRefresh" ? "source refresh" : "metadata request";
  const message = error.code === "E_MEDIA_NOT_FOUND"
    ? "this item is no longer available to this account."
    : error.code === "E_OWNER_REQUIRED" || error.code === "E_FORBIDDEN"
      ? "only the item's owner can start this work."
      : error.code === "E_RESOURCE_CONFLICT"
        ? "this item changed. review its current state before starting another request."
        : error.code === "E_REPAIR_NOT_ALLOWED"
          ? "the published document can't be replaced by this request."
          : "this work can't start in the item's current state. review its current status.";
  return { tone: "Warning", title: `${subject} not started`, message, requestId: error.requestId };
}

/** One account's owner; mounting restores records but never sends a request. */
export function createAdmissionRecovery(accountId: string) {
  const prefix = `${PREFIX}${encodeURIComponent(accountId)}:`;
  const listeners = new Set<() => void>();
  let snapshot = EMPTY_ADMISSIONS;
  let lifetime: AbortController | null = null;
  const running = new Map<string, { key: string; promise: Promise<AdmissionResult> }>();
  const keyFor = (intent: AdmissionIntent) =>
    `${prefix}${JSON.stringify([intent.kind, intent.mediaId, expectation(intent)])}`;
  const groupFor = (intent: AdmissionIntent) =>
    `${prefix}${JSON.stringify([intent.kind, intent.mediaId])}`;
  const live = (scope: AbortController) => lifetime === scope && !scope.signal.aborted;

  const publish = (next: AdmissionSnapshot) => {
    snapshot = next;
    for (const listener of listeners) listener();
  };
  const put = (entry: AdmissionEntry, scope: AbortController) => {
    if (!live(scope)) return;
    const found = snapshot.entries.some(item => item.key === entry.key);
    publish({ ...snapshot, entries: found
      ? snapshot.entries.map(item => item.key === entry.key ? entry : item)
      : [...snapshot.entries, entry] });
  };

  function readAll(): Map<string, StoredAdmission> {
    return storage(store => {
      const records = new Map<string, StoredAdmission>();
      // Snapshot keys first: another operation's deletion must not shift an
      // indexed enumeration past this locked operation's pending record.
      for (const key of Object.keys(store)) {
        if (!key.startsWith(prefix)) continue;
        const raw = store.getItem(key);
        if (raw === null) continue;
        const record = decode(key, raw);
        if (keyFor(record.intent) !== key)
          throw new UnreadableAdmission(key, new TypeError("Admission identity does not match its key"));
        records.set(key, record);
      }
      return records;
    });
  }

  function refresh(scope: AbortController): Map<string, StoredAdmission> | null {
    if (!live(scope)) return null;
    try {
      const records = readAll();
      const entries = [...records].map(([key, record]): AdmissionEntry => {
        const known = snapshot.entries.find(entry => entry.key === key);
        return known?.dispatchId === record.dispatchId ? known : { ...record, key, kind: "Unconfirmed" };
      });
      publish({ entries, problem: null });
      return records;
    } catch (error) {
      if (error instanceof BrowserRecoveryError) {
        publish({ ...snapshot, problem: { kind: "Storage", content: {
          tone: "Warning", title: "request recovery unavailable",
          message: "this browser couldn't read saved requests. allow site storage before starting or confirming this work.",
        } } });
        return null;
      }
      if (error instanceof UnreadableAdmission) {
        console.error(error);
        publish({ ...snapshot, problem: { kind: "UnreadableRecord", content: {
          tone: "Danger", title: "saved request needs repair",
          message: "a saved recovery request couldn't be read. it has been kept unchanged; repair the record before starting this work.",
        } } });
        return null;
      }
      throw error;
    }
  }

  async function locked<T>(scope: AbortController, intent: AdmissionIntent, work: () => Promise<T>): Promise<T> {
    if (!navigator.locks) throw new BrowserRecoveryError("Locks");
    try {
      return await navigator.locks.request(groupFor(intent), { signal: scope.signal }, async () => {
        scope.signal.throwIfAborted();
        return work();
      });
    } catch (error) {
      if (browserFailure(error)) throw new BrowserRecoveryError("Locks", error);
      throw error;
    }
  }

  /** Called only while holding the operation lock; never removes another dispatch. */
  function settle(entry: AdmissionEntry, settlement: "Accepted" | "Refused", scope: AbortController) {
    try {
      const removed = storage(store => {
        const raw = store.getItem(entry.key);
        if (raw === null) return true;
        if (decode(entry.key, raw).dispatchId !== entry.dispatchId) return false;
        store.removeItem(entry.key);
        return true;
      });
      // An unrelated unreadable record must not resurrect this proven cleanup.
      if (removed && live(scope)) publish({ ...snapshot,
        entries: snapshot.entries.filter(item => item.key !== entry.key || item.dispatchId !== entry.dispatchId),
      });
      refresh(scope);
    } catch (error) {
      if (!(error instanceof BrowserRecoveryError) && !(error instanceof UnreadableAdmission)) throw error;
      if (error instanceof UnreadableAdmission) {
        refresh(scope);
        return;
      }
      put({ ...entry, kind: "Cleanup", settlement }, scope);
    }
  }

  async function send(intent: AdmissionIntent, fresh: boolean, scope: AbortController): Promise<AdmissionResult> {
    if (!live(scope)) return { kind: "OwnerGone" };
    const key = keyFor(intent);
    const stored: StoredAdmission = { version: 1, dispatchId: crypto.randomUUID(), intent };
    storage(store => store.setItem(key, JSON.stringify(stored)));
    // Nothing asynchronous intervenes between the last account check, durable
    // dispatch identity and invocation of fetch.
    const entry: AdmissionEntry = { ...stored, key, kind: "Sending" };
    put(entry, scope);
    const timeout = new AbortController();
    const signal = AbortSignal.any([scope.signal, timeout.signal]);
    const timer = window.setTimeout(() => timeout.abort(), SEND_DEADLINE_MS);
    let metadataAccepted: Schema<"MetadataEnrichmentAccepted"> | null = null;
    try {
      if (intent.kind === "SourceRefresh") {
        await apiFetch<ApiJson<"/media/{media_id}/refresh", "post">>(
          `/api/media/${encodeURIComponent(intent.mediaId)}/refresh`,
          { method: "POST", body: JSON.stringify(intent.request), signal },
        );
      } else {
        const { data } = await apiFetch<ApiJson<"/media/{media_id}/metadata-enrichment", "post">>(
          `/api/media/${encodeURIComponent(intent.mediaId)}/metadata-enrichment`,
          { method: "POST", body: JSON.stringify(intent.request), signal },
        );
        metadataAccepted = data;
      }
    } catch (error) {
      if (!live(scope)) return { kind: "OwnerGone" };
      if (isAbortError(error) || (isApiError(error) &&
        ["E_NETWORK", "E_UPSTREAM", "E_UPSTREAM_TIMEOUT"].includes(error.code))) {
        put({ ...entry, kind: "Unconfirmed", requestId: isApiError(error) ? error.requestId : undefined }, scope);
        return { kind: "Pending", key };
      }
      if (isUnauthenticatedApiError(error)) {
        put({ ...entry, kind: "Blocked", reason: "Authentication", canConfirm: false, content: {
          tone: "Warning", title: "request still unconfirmed", message: "sign in to this account again to confirm the saved request.",
        } }, scope);
        handleUnauthenticatedApiError(error);
        return { kind: "Pending", key };
      }
      if (isStaleBuild(error)) {
        put({ ...entry, kind: "Blocked", reason: "Build", canConfirm: false, content: {
          tone: "Warning", title: "request still unconfirmed", message: "reload the updated app to confirm the saved request.",
          requestId: error.requestId,
        } }, scope);
        return { kind: "Pending", key };
      }
      if (isApiError(error) && definiteRefusal(intent, error)) {
        const content = refusalContent(intent, error);
        if (fresh) {
          settle(entry, "Refused", scope);
          return { kind: "LocalFailure", content };
        }
        put({ ...entry, kind: "Blocked", reason: error.status === 403 || error.status === 404 ? "Access" : "StateChanged",
          canConfirm: false, content: { ...content, title: "request still unconfirmed",
            message: `${content.message} this reply does not settle the earlier request.` } }, scope);
        return { kind: "Pending", key };
      }
      // Keep evidence even when the response or caller is defective. The
      // existing defect boundary owns the exception, never a generic retry.
      put({ ...entry, kind: "Blocked", reason: "Defect", canConfirm: false, content: {
        tone: "Danger", title: "request needs repair",
        message: "the response couldn't be interpreted. the saved request has been retained for repair.",
        requestId: isApiError(error) ? error.requestId : undefined,
      } }, scope);
      throw error;
    } finally {
      window.clearTimeout(timer);
      if (live(scope)) {
        if (intent.kind === "MetadataResearch") reconnectMetadataOperations(intent.mediaId);
        publishImportsInvalidation();
      }
    }
    settle(entry, "Accepted", scope);
    if (live(scope) && metadataAccepted !== null)
      observeMetadataAdmission(intent.mediaId, metadataAccepted.last_enriched_at);
    return live(scope) ? { kind: "Accepted" } : { kind: "OwnerGone" };
  }

  const pending = (kind: AdmissionIntent["kind"], mediaId: string) =>
    snapshot.entries.find(entry => entry.intent.kind === kind && entry.intent.mediaId === mediaId) ?? null;

  function track(intent: AdmissionIntent, work: (scope: AbortController) => Promise<AdmissionResult>): Promise<AdmissionResult> {
    const scope = lifetime;
    if (scope === null || !live(scope)) return Promise.resolve({ kind: "OwnerGone" });
    const group = groupFor(intent);
    const current = running.get(group);
    if (current !== undefined) return current.key === keyFor(intent)
      ? current.promise : Promise.resolve({ kind: "Pending", key: current.key });
    const promise = work(scope).then((result): AdmissionResult =>
      live(scope) ? result : { kind: "OwnerGone" },
    ).catch((error: unknown): AdmissionResult => {
      if (!live(scope)) return { kind: "OwnerGone" };
      if (error instanceof BrowserRecoveryError)
        return { kind: "LocalFailure", content: browserFailureContent(error.kind) };
      throw error;
    }).finally(() => {
      if (running.get(group)?.promise === promise) running.delete(group);
    });
    running.set(group, { key: keyFor(intent), promise });
    return promise;
  }

  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    getSnapshot: () => snapshot,
    pending,
    start() {
      const scope = new AbortController();
      lifetime = scope;
      snapshot = { entries: snapshot.entries.map(({ version, dispatchId, intent, key }) =>
        ({ version, dispatchId, intent, key, kind: "Unconfirmed" })), problem: null };
      refresh(scope);
      const changed = (event: StorageEvent) => {
        if (event.key === null || event.key.startsWith(prefix)) refresh(scope);
      };
      window.addEventListener("storage", changed);
      return () => {
        scope.abort();
        window.removeEventListener("storage", changed);
        if (lifetime === scope) {
          lifetime = null;
          running.clear();
        }
      };
    },
    admit(original: AdmissionIntent): Promise<AdmissionResult> {
      // Freeze the viewed expectation; callers may later replace their view.
      const intent: AdmissionIntent = original.kind === "SourceRefresh"
        ? { ...original, request: { expected_attempt_id: original.request.expected_attempt_id } }
        : { ...original, request: { expected_job_id: original.request.expected_job_id } };
      return track(intent, scope => locked(scope, intent, async (): Promise<AdmissionResult> => {
        const records = refresh(scope);
        if (records === null) return live(scope)
          ? { kind: "LocalFailure", content: snapshot.problem!.content }
          : { kind: "OwnerGone" };
        const existing = pending(intent.kind, intent.mediaId);
        if (existing !== null) return { kind: "Pending", key: existing.key };
        return send(intent, true, scope);
      }));
    },
    async confirm(key: string): Promise<void> {
      const caller = lifetime;
      const entry = snapshot.entries.find(item => item.key === key);
      if (entry === undefined || entry.kind === "Cleanup" ||
        (entry.kind === "Blocked" && !entry.canConfirm)) return;
      const result = await track(entry.intent, scope => locked(scope, entry.intent, async (): Promise<AdmissionResult> => {
        const records = refresh(scope);
        if (records === null) return { kind: "Pending", key };
        const stored = records.get(key);
        if (stored === undefined) {
          if (live(scope)) {
            if (entry.intent.kind === "MetadataResearch") reconnectMetadataOperations(entry.intent.mediaId);
            publishImportsInvalidation();
          }
          return { kind: "Accepted" };
        }
        return send(stored.intent, false, scope);
      }));
      const scope = lifetime;
      const current = snapshot.entries.find(item => item.key === key);
      if (result.kind === "LocalFailure" && current !== undefined && scope !== null && scope === caller)
        put({ ...current, kind: "Blocked", reason: navigator.locks ? "Storage" : "Locks", canConfirm: true,
          content: { ...result.content, title: "request still unconfirmed" } }, scope);
    },
    async retryCleanup(key: string): Promise<void> {
      const entry = snapshot.entries.find(item => item.key === key);
      const scope = lifetime;
      if (entry?.kind !== "Cleanup" || scope === null || !live(scope)) return;
      try {
        await locked(scope, entry.intent, async () => { settle(entry, entry.settlement, scope); });
      } catch (error) {
        if (!live(scope)) return;
        if (error instanceof BrowserRecoveryError) return;
        throw error;
      }
    },
  };
}

export type AdmissionRecovery = ReturnType<typeof createAdmissionRecovery>;
