"use client";

import { useSyncExternalStore } from "react";

import { ApiError } from "@/lib/api/client";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import type { AndroidActivitySyncSnapshot } from "@/lib/player/androidPlayerProtocol";
import type { ActivityRequest, ClosedActivitySpan } from "./activityContract";
import { ACTIVITY_OUTBOX_MAX_SPANS, outbox } from "./activityOutbox";
import type { OutboxRow, OutboxSummary } from "./activityOutbox";
import { publishConsumptionProjectionChange } from "./projectionRevision";

// Durable delivery: every closed span is stored before any upload, uploads are single-flight
// per tab, and a row leaves the outbox only on 204 or discard. `session`'s identity is the
// account generation: work begun for one session stops at its next await once another opens.
// IndexedDB failure blocks capture; there is no memory fallback.

export type ActivityRuntimeSnapshot = Pick<AndroidActivitySyncSnapshot, "capture" | "sync">;
type Capture = ActivityRuntimeSnapshot["capture"];
type Session = { accountId: string; abort: AbortController };

export interface NativeActivityActions {
  setPaused(paused: boolean): Promise<void>;
  retryFailed(): Promise<void>;
  discardFailed(): Promise<void>;
}

const IDLE: ActivityRuntimeSnapshot = { capture: { kind: "Idle" }, sync: { kind: "Synced" } };
const EMPTY: OutboxSummary = { total: 0, pending: 0, failed: 0, paused: false };
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000;
const RETRY_DELAYS_MS = [2_000, 5_000, 15_000, 60_000];
/** Merged capture is the higher-ranked of browser and Android. */
const CAPTURE_RANK = ["Idle", "Paused", "Recording", "CapacityReached", "StorageUnavailable"];

let session: Session | undefined;
let storageAvailable = true;
let summary = EMPTY;
let recording = false;
let native: { accountId: string; snapshot: AndroidActivitySyncSnapshot } | undefined;
let nativeActions: { accountId: string; actions: NativeActivityActions } | undefined;
let accepted = { accountId: "", revision: 0 };
let current = IDLE;
let draining: Promise<void> | undefined;
let rerun = false;
const listeners = new Set<() => void>();

/** Merge the browser outbox's health with this account's Android outbox and notify on change. */
function publish(): void {
  const browser: Capture = !storageAvailable
    ? { kind: "Blocked", reason: "StorageUnavailable" }
    : summary.total >= ACTIVITY_OUTBOX_MAX_SPANS
      ? { kind: "Blocked", reason: "CapacityReached" }
      : { kind: summary.paused ? "Paused" : recording ? "Recording" : "Idle" };
  const android = native && native.accountId === session?.accountId ? native.snapshot : IDLE;
  const rank = (capture: Capture) =>
    CAPTURE_RANK.indexOf(capture.kind === "Blocked" ? capture.reason : capture.kind);
  const { sync } = android;
  const failed = summary.failed + (sync.kind === "Failed" ? sync.count : 0);
  const pending = summary.pending + (sync.kind === "Pending" ? sync.count : 0);
  const oldestAt = [
    ...(summary.pending > 0 ? [new Date(summary.oldestPendingAt!).toISOString()] : []),
    ...(sync.kind === "Pending" ? [sync.oldestAt] : []),
  ].sort()[0];
  const next: ActivityRuntimeSnapshot = {
    capture: rank(browser) >= rank(android.capture) ? browser : android.capture,
    sync:
      failed > 0
        ? { kind: "Failed", count: failed }
        : pending > 0
          ? { kind: "Pending", count: pending, oldestAt }
          : { kind: "Synced" },
  };
  if (JSON.stringify(next) === JSON.stringify(current)) return;
  current = next;
  for (const listener of listeners) listener();
}

async function refresh(mine: Session): Promise<void> {
  const next = await outbox.summary(mine.accountId);
  if (mine !== session) return;
  storageAvailable = true;
  summary = next;
  publish();
}

/** Run outbox work for `mine`; an IndexedDB failure blocks capture while `mine` is current. */
async function guard(mine: Session, work: () => Promise<void>): Promise<void> {
  try {
    await work();
  } catch {
    if (mine !== session) return;
    storageAvailable = false;
    recording = false;
    publish();
  }
}

const retryable = (status: number) =>
  status === 0 || status === 408 || status === 429 || status >= 500;

/** False when the session aborted first. */
function sleep(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => resolve(true), ms);
    const cancel = () => {
      window.clearTimeout(timer);
      resolve(false);
    };
    signal.addEventListener("abort", cancel, { once: true });
  });
}

/** Upload one batch, retrying transient failures: its status (0 when the network failed), or
 * undefined once the session aborted. */
async function upload(rows: OutboxRow[], signal: AbortSignal): Promise<number | undefined> {
  const [{ mediaRef, deviceClass, modality }] = rows;
  const spans = rows.map((row) => ({ captureKey: row.captureKey, ...row.span }));
  const request: ActivityRequest = {
    clientMutationId: crypto.randomUUID(),
    mediaRef,
    deviceClass,
    // A batch shares one modality, so its rows carry that modality's span bodies.
    batch: { modality, spans } as ActivityRequest["batch"],
  };
  const body = JSON.stringify(request);
  const headers = { "content-type": "application/json" };
  const post = () =>
    fetch("/api/consumption/activity", { method: "POST", body, headers, signal, cache: "no-store" })
      .then((response) => response.status, () => 0);
  let status = await post();
  for (const delay of RETRY_DELAYS_MS) {
    if (!retryable(status)) break;
    if (signal.aborted || !(await sleep(delay, signal))) return undefined;
    status = await post();
  }
  return status;
}

async function drainOnce(mine: Session): Promise<void> {
  const { accountId, abort } = mine;
  await outbox.expire(accountId, Date.now() - MAX_AGE_MS);
  await refresh(mine);
  for (;;) {
    const rows = await outbox.nextBatch(accountId, 120);
    if (mine !== session || rows.length === 0) return;
    const status = await upload(rows, abort.signal);
    if (status === undefined || mine !== session) return;
    const keys = rows.map((row) => row.captureKey);
    if (status === 204) {
      await outbox.remove(accountId, keys);
      await refresh(mine);
      publishConsumptionProjectionChange({ rowChanged: true });
    } else if (status === 401) {
      await refresh(mine);
      const error = new ApiError(401, "E_UNAUTHENTICATED", "Activity upload authentication failed");
      handleUnauthenticatedApiError(error);
      return;
    } else if (retryable(status)) {
      return refresh(mine);
    } else {
      const rejected = { status, modality: rows[0].modality, count: rows.length };
      console.warn("consumption_activity_upload_rejected", rejected);
      await outbox.fail(accountId, keys);
      await refresh(mine);
    }
  }
}

function drain(): Promise<void> {
  rerun = true;
  draining ??= (async () => {
    while (rerun) {
      rerun = false;
      const mine = session;
      if (mine !== undefined && storageAvailable) await guard(mine, () => drainOnce(mine));
    }
    draining = undefined;
  })();
  return draining;
}

/** Change the local outbox, then forward the same change to this account's native outbox. */
async function change(
  local: (accountId: string) => Promise<void>,
  forward: (actions: NativeActivityActions) => Promise<void>,
): Promise<void> {
  const mine = session;
  if (mine === undefined) return;
  const actions = nativeActions?.accountId === mine.accountId ? nativeActions.actions : undefined;
  if (storageAvailable) {
    await guard(mine, async () => {
      await local(mine.accountId);
      await refresh(mine);
    });
  }
  if (mine === session && actions !== undefined) await forward(actions);
}

const runtime = {
  async open(accountId: string): Promise<void> {
    if (session?.accountId !== accountId) {
      session?.abort.abort();
      session = { accountId, abort: new AbortController() };
      summary = EMPTY;
      recording = false;
      publish();
    }
    const mine = session;
    await guard(mine, async () => {
      await refresh(mine);
      void drain();
    });
  },
  async enqueue(span: ClosedActivitySpan): Promise<void> {
    const mine = session;
    if (mine === undefined || !storageAvailable) return;
    await guard(mine, async () => {
      const added = await outbox.add(mine.accountId, span, Date.now());
      await refresh(mine);
      if (added) void drain();
    });
  },
  drain,
  setPaused: (paused: boolean) =>
    change(
      (accountId) => outbox.setPaused(accountId, paused),
      (actions) => actions.setPaused(paused),
    ),
  retryFailed: () =>
    change(
      async (accountId) => {
        await outbox.retryFailed(accountId);
        void drain();
      },
      (actions) => actions.retryFailed(),
    ),
  discardFailed: () =>
    change(
      (accountId) => outbox.discardFailed(accountId),
      (actions) => actions.discardFailed(),
    ),
  setRecording(next: boolean): void {
    if (next === recording) return;
    recording = next;
    publish();
  },
  snapshot: (): ActivityRuntimeSnapshot => current,
};

export function activityRuntime(): typeof runtime {
  return runtime;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useActivityRuntimeSnapshot(): ActivityRuntimeSnapshot {
  return useSyncExternalStore(subscribe, runtime.snapshot, () => IDLE);
}

/** The Android outbox's health for an account; its rising accepted revision refreshes views. */
export function installNativeActivitySync(
  accountId: string,
  snapshot: AndroidActivitySyncSnapshot | null,
): void {
  if (snapshot === null) {
    if (native?.accountId === accountId) native = undefined;
  } else {
    native = { accountId, snapshot };
    const previous = accepted.accountId === accountId ? accepted.revision : 0;
    if (accountId === session?.accountId && snapshot.acceptedRevision > previous) {
      accepted = { accountId, revision: snapshot.acceptedRevision };
      publishConsumptionProjectionChange({ rowChanged: true });
    }
  }
  publish();
}

export function installNativeActivityActions(
  accountId: string,
  actions: NativeActivityActions | null,
): void {
  if (actions !== null) nativeActions = { accountId, actions };
  else if (nativeActions?.accountId === accountId) nativeActions = undefined;
}
