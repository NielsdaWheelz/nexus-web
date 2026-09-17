"use client";

import { useSyncExternalStore } from "react";

import { ApiError } from "@/lib/api/client";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import type { AndroidActivitySyncSnapshot } from "@/lib/player/androidPlayerProtocol";
import { publishConsumptionProjectionChange } from "./projectionRevision";
import {
  ActivityOutbox,
  ACTIVITY_OUTBOX_MAX_SPANS,
  activityOutboxCapacity,
  type ActivityFailureReason,
  type ActivityOutboxBatch,
  type ActivityOutboxSummary,
  type StoredActivitySpan,
} from "./activityOutbox";
import {
  postActivityBatch,
  type ActivityBatch,
  type ActivityRequest,
  type ActivityUploadOutcome,
  type ClosedActivitySpan,
} from "./activityContract";

const ACTIVITY_BATCH_MAX_SPANS = 120;
const ACTIVITY_BATCH_MAX_BYTES = 48_000;
const ACTIVITY_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000;
// justify-retry-schedule: durable client outbox delivery intentionally models
// exhaustion as retained Pending state until a later lifecycle/manual trigger.
const ACTIVITY_RETRY_DELAYS_MS = [2_000, 5_000, 15_000, 60_000] as const;

export type ActivityCaptureState =
  | { readonly kind: "Recording" }
  | { readonly kind: "Idle" }
  | { readonly kind: "Paused" }
  | {
      readonly kind: "Blocked";
      readonly reason: "StorageUnavailable" | "CapacityReached";
    };

export type ActivitySyncState =
  | { readonly kind: "Synced" }
  | {
      readonly kind: "Pending";
      readonly count: number;
      readonly oldestAt: string;
    }
  | { readonly kind: "Failed"; readonly count: number };

export interface ActivityRuntimeSnapshot {
  readonly capture: ActivityCaptureState;
  readonly sync: ActivitySyncState;
}

export type ActivityDrainTrigger =
  | "Enqueue"
  | "Startup"
  | "Foreground"
  | "Focus"
  | "PageShow"
  | "Online"
  | "Manual";

export interface ActivityRuntime {
  open(accountId: string): Promise<void>;
  enqueue(span: ClosedActivitySpan): Promise<void>;
  drain(trigger: ActivityDrainTrigger): Promise<void>;
  setPaused(paused: boolean): Promise<void>;
  retryFailed(): Promise<void>;
  discardFailed(): Promise<void>;
  snapshot(): ActivityRuntimeSnapshot;
  subscribe(listener: () => void): () => void;
}

export interface NativeActivityActions {
  readonly setPaused: (paused: boolean) => Promise<void>;
  readonly retryFailed: () => Promise<void>;
  readonly discardFailed: () => Promise<void>;
}

interface RuntimeOptions {
  readonly outbox?: ActivityOutbox;
  readonly capacityLimit?: number;
  readonly now?: () => number;
  readonly upload?: (
    body: string,
    signal?: AbortSignal,
  ) => Promise<ActivityUploadOutcome>;
  readonly wait?: (delayMs: number) => Promise<void>;
}

const INITIAL_SNAPSHOT: ActivityRuntimeSnapshot = {
  capture: { kind: "Idle" },
  sync: { kind: "Synced" },
};

const EMPTY_OUTBOX_SUMMARY: ActivityOutboxSummary = {
  total: 0,
  pending: 0,
  failed: 0,
  oldestPendingAt: undefined,
  paused: false,
};

function waitFor(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, delayMs);
  });
}

function captureState(input: {
  readonly storageAvailable: boolean;
  readonly summary: ActivityOutboxSummary;
  readonly recording: boolean;
  readonly capacityLimit: number;
}): ActivityCaptureState {
  if (!input.storageAvailable) {
    return { kind: "Blocked", reason: "StorageUnavailable" };
  }
  if (
    activityOutboxCapacity(input.summary.total, input.capacityLimit) ===
    "Reached"
  ) {
    return { kind: "Blocked", reason: "CapacityReached" };
  }
  if (input.summary.paused) return { kind: "Paused" };
  return input.recording ? { kind: "Recording" } : { kind: "Idle" };
}

function syncState(summary: ActivityOutboxSummary): ActivitySyncState {
  if (summary.failed > 0) return { kind: "Failed", count: summary.failed };
  if (summary.pending > 0) {
    if (summary.oldestPendingAt === undefined) {
      // justify-defect: the IndexedDB summary counts and oldest cursor are read
      // in one transaction, so a positive Pending count has an oldest row.
      throw new Error("Activity outbox Pending summary has no oldest row");
    }
    return {
      kind: "Pending",
      count: summary.pending,
      oldestAt: new Date(summary.oldestPendingAt).toISOString(),
    };
  }
  return { kind: "Synced" };
}

const INITIAL_NATIVE_SNAPSHOT: AndroidActivitySyncSnapshot = {
  capture: { kind: "Idle" },
  sync: { kind: "Synced" },
  acceptedRevision: 0,
};

function combinedCaptureState(
  browser: ActivityCaptureState,
  native: AndroidActivitySyncSnapshot["capture"],
): ActivityCaptureState {
  const blocked = [browser, native].filter(
    (state): state is Extract<typeof state, { kind: "Blocked" }> =>
      state.kind === "Blocked",
  );
  if (blocked.some((state) => state.reason === "StorageUnavailable")) {
    return { kind: "Blocked", reason: "StorageUnavailable" };
  }
  if (blocked.length > 0) {
    return { kind: "Blocked", reason: "CapacityReached" };
  }
  if (browser.kind === "Recording" || native.kind === "Recording") {
    return { kind: "Recording" };
  }
  if (browser.kind === "Paused" || native.kind === "Paused") {
    return { kind: "Paused" };
  }
  return { kind: "Idle" };
}

function combinedSyncState(
  browser: ActivitySyncState,
  native: AndroidActivitySyncSnapshot["sync"],
): ActivitySyncState {
  const failed =
    (browser.kind === "Failed" ? browser.count : 0) +
    (native.kind === "Failed" ? native.count : 0);
  if (failed > 0) return { kind: "Failed", count: failed };
  const pending =
    (browser.kind === "Pending" ? browser.count : 0) +
    (native.kind === "Pending" ? native.count : 0);
  if (pending === 0) return { kind: "Synced" };
  const oldest = [browser, native]
    .filter(
      (state): state is Extract<typeof state, { kind: "Pending" }> =>
        state.kind === "Pending",
    )
    .map((state) => state.oldestAt)
    .sort()[0];
  if (oldest === undefined) {
    // justify-defect: a positive combined Pending count must originate from at
    // least one Pending branch carrying its oldest instant.
    throw new Error("Combined Activity Pending state has no oldest instant");
  }
  return { kind: "Pending", count: pending, oldestAt: oldest };
}

function captureKeys(batch: ActivityOutboxBatch): string[] {
  return batch.rows.map((row) => row.captureKey);
}

function requireModality<M extends StoredActivitySpan["modality"]>(
  row: StoredActivitySpan,
  modality: M,
): Extract<StoredActivitySpan, { modality: M }> {
  if (row.modality !== modality) {
    // justify-defect: ActivityOutbox groups every returned batch by the first
    // row's exact media, modality, and viewport class.
    throw new Error("Activity outbox returned a mixed-modality batch");
  }
  // justify-type-assertion: the runtime check above narrows the correlated
  // discriminated-union branch, which TypeScript cannot express generically.
  return row as Extract<StoredActivitySpan, { modality: M }>;
}

function wireBatch(batch: ActivityOutboxBatch): ActivityBatch {
  switch (batch.modality) {
    case "Reading":
      return {
        modality: "Reading",
        spans: batch.rows.map((candidate) => {
          const row = requireModality(candidate, "Reading");
          return { captureKey: row.captureKey, ...row.span };
        }),
      };
    case "Listening":
      return {
        modality: "Listening",
        spans: batch.rows.map((candidate) => {
          const row = requireModality(candidate, "Listening");
          return { captureKey: row.captureKey, ...row.span };
        }),
      };
    case "Viewing":
      return {
        modality: "Viewing",
        spans: batch.rows.map((candidate) => {
          const row = requireModality(candidate, "Viewing");
          return { captureKey: row.captureKey, ...row.span };
        }),
      };
  }
}

function activityRequest(batch: ActivityOutboxBatch): ActivityRequest {
  const clientMutationId = globalThis.crypto?.randomUUID?.();
  if (clientMutationId === undefined) {
    // justify-defect: canonical browser replay identity requires the Web Crypto
    // UUID primitive; a weaker fallback would violate the wire contract.
    throw new Error("Web Crypto randomUUID is unavailable");
  }
  return {
    clientMutationId,
    mediaRef: batch.mediaRef,
    deviceClass: batch.deviceClass,
    batch: wireBatch(batch),
  };
}

class BrowserActivityRuntime implements ActivityRuntime {
  private readonly outbox: ActivityOutbox;
  private readonly capacityLimit: number;
  private readonly now: () => number;
  private readonly upload: (
    body: string,
    signal?: AbortSignal,
  ) => Promise<ActivityUploadOutcome>;
  private readonly wait: (delayMs: number) => Promise<void>;
  private readonly listeners = new Set<() => void>();
  private current = INITIAL_SNAPSHOT;
  private accountId: string | undefined;
  private storageAvailable = true;
  private recording = false;
  private nativeSnapshot = INITIAL_NATIVE_SNAPSHOT;
  private readonly nativeSnapshots = new Map<
    string,
    AndroidActivitySyncSnapshot
  >();
  private readonly nativeAcceptedRevisions = new Map<string, number>();
  private readonly nativePublishedRevisions = new Map<string, number>();
  private readonly nativeActions = new Map<string, NativeActivityActions>();
  private summaryState: ActivityOutboxSummary = EMPTY_OUTBOX_SUMMARY;
  private writeTail: Promise<void> = Promise.resolve();
  private drainTask: Promise<void> | undefined;
  private drainRequested = false;
  private accountGeneration = 0;
  private accountAbort = new AbortController();
  private accountTransition = false;

  constructor(options: RuntimeOptions = {}) {
    this.capacityLimit =
      options.capacityLimit ?? ACTIVITY_OUTBOX_MAX_SPANS;
    this.outbox = options.outbox ?? new ActivityOutbox(this.capacityLimit);
    this.now = options.now ?? Date.now;
    this.upload = options.upload ?? postActivityBatch;
    this.wait = options.wait ?? waitFor;
  }

  async open(accountId: string): Promise<void> {
    const accountChanged = this.accountId !== accountId;
    if (this.accountId !== undefined && accountChanged) {
      const previousAccountId = this.accountId;
      this.accountTransition = true;
      this.accountGeneration += 1;
      this.accountAbort.abort();
      this.drainRequested = false;
      this.summaryState = EMPTY_OUTBOX_SUMMARY;
      this.nativeSnapshot = INITIAL_NATIVE_SNAPSHOT;
      this.nativeSnapshots.delete(previousAccountId);
      this.nativeActions.delete(previousAccountId);
      this.recording = false;
      this.publishSnapshot();
      await this.drainTask;
      this.accountAbort = new AbortController();
    } else if (this.accountId === undefined) {
      this.accountGeneration += 1;
      this.accountAbort = new AbortController();
    }
    this.accountId = accountId;
    this.accountTransition = false;
    if (accountChanged) {
      this.nativeSnapshot =
        this.nativeSnapshots.get(accountId) ?? INITIAL_NATIVE_SNAPSHOT;
      this.publishNativeAcceptance(accountId, this.nativeSnapshot);
    }
    try {
      await this.write(() => this.outbox.open());
      this.storageAvailable = true;
      await this.refresh(accountId);
    } catch {
      this.blockStorage();
      return;
    }
    void this.drain("Startup");
  }

  async enqueue(span: ClosedActivitySpan): Promise<void> {
    const accountId = this.accountId;
    if (accountId === undefined || !this.storageAvailable) return;
    try {
      const outcome = await this.write(() =>
        this.outbox.enqueue(accountId, span, this.now()),
      );
      await this.refresh(accountId);
      if (outcome === "Enqueued") {
        void this.drain("Enqueue");
      }
    } catch {
      this.blockStorage();
    }
  }

  async drain(trigger: ActivityDrainTrigger): Promise<void> {
    this.drainRequested = true;
    const active = this.drainTask;
    if (active !== undefined) {
      await active;
      if (this.drainRequested) await this.drain(trigger);
      return;
    }
    const task = this.runDrainLoop();
    this.drainTask = task;
    try {
      await task;
    } finally {
      if (this.drainTask === task) {
        this.drainTask = undefined;
      }
    }
    if (this.drainRequested) await this.drain(trigger);
  }

  async setPaused(paused: boolean): Promise<void> {
    const accountId = this.accountId;
    if (accountId === undefined) return;
    const generation = this.accountGeneration;
    const native = this.nativeActions.get(accountId)?.setPaused;
    if (this.storageAvailable) {
      try {
        await this.write(() => this.outbox.setPaused(accountId, paused));
        await this.refresh(accountId);
      } catch {
        this.blockStorage();
      }
    }
    if (this.isCurrent(accountId, generation)) await native?.(paused);
  }

  async retryFailed(): Promise<void> {
    const accountId = this.accountId;
    if (accountId === undefined) return;
    const generation = this.accountGeneration;
    const native = this.nativeActions.get(accountId)?.retryFailed;
    if (this.storageAvailable) {
      try {
        await this.write(() => this.outbox.retryFailed(accountId));
        await this.refresh(accountId);
        void this.drain("Manual");
      } catch {
        this.blockStorage();
      }
    }
    if (this.isCurrent(accountId, generation)) await native?.();
  }

  async discardFailed(): Promise<void> {
    const accountId = this.accountId;
    if (accountId === undefined) return;
    const generation = this.accountGeneration;
    const native = this.nativeActions.get(accountId)?.discardFailed;
    if (this.storageAvailable) {
      try {
        await this.write(() => this.outbox.discardFailed(accountId));
        await this.refresh(accountId);
      } catch {
        this.blockStorage();
      }
    }
    if (this.isCurrent(accountId, generation)) await native?.();
  }

  snapshot(): ActivityRuntimeSnapshot {
    return this.current;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  installRecording(recording: boolean): void {
    if (this.recording === recording) return;
    this.recording = recording;
    this.publishSnapshot();
  }

  installNativeSnapshot(
    accountId: string,
    snapshot: AndroidActivitySyncSnapshot | null,
  ): void {
    if (snapshot === null) {
      this.nativeSnapshots.delete(accountId);
      if (this.accountId === accountId && !this.accountTransition) {
        this.nativeSnapshot = INITIAL_NATIVE_SNAPSHOT;
        this.publishSnapshot();
      }
      return;
    }
    if (
      !Number.isSafeInteger(snapshot.acceptedRevision) ||
      snapshot.acceptedRevision < 0
    ) {
      throw new Error("Native Activity accepted revision is invalid");
    }
    const previousRevision =
      this.nativeAcceptedRevisions.get(accountId) ?? 0;
    if (snapshot.acceptedRevision < previousRevision) {
      // justify-defect: the native outbox revision is monotonic for one
      // authenticated account and advances only after accepted durable ack.
      throw new Error("Native Activity accepted revision regressed");
    }
    this.nativeAcceptedRevisions.set(accountId, snapshot.acceptedRevision);
    this.nativeSnapshots.set(accountId, snapshot);
    if (this.accountId !== accountId || this.accountTransition) return;
    this.nativeSnapshot = snapshot;
    this.publishSnapshot();
    this.publishNativeAcceptance(accountId, snapshot);
  }

  installNativeActions(
    accountId: string,
    actions: NativeActivityActions | null,
  ): void {
    if (actions === null) this.nativeActions.delete(accountId);
    else this.nativeActions.set(accountId, actions);
  }

  private async drainAccount(
    accountId: string,
    generation: number,
    signal: AbortSignal,
  ): Promise<void> {
    if (!this.isCurrent(accountId, generation)) return;
    await this.write(() =>
      this.outbox.markExpired(accountId, this.now() - ACTIVITY_MAX_AGE_MS),
    );
    if (!this.isCurrent(accountId, generation)) return;
    await this.refresh(accountId);
    for (;;) {
      if (!this.isCurrent(accountId, generation)) return;
      const batch = await this.write(() =>
        this.outbox.nextPendingBatch(accountId, ACTIVITY_BATCH_MAX_SPANS),
      );
      if (batch === undefined) return;
      const expiryCutoff = this.now() - ACTIVITY_MAX_AGE_MS;
      const expiredKeys = batch.rows
        .filter(
          (row) =>
            Date.parse(row.span.occurredAt) + row.span.durationMs <
            expiryCutoff,
        )
        .map((row) => row.captureKey);
      if (expiredKeys.length > 0) {
        await this.failRows(
          accountId,
          expiredKeys,
          "Expired",
          generation,
        );
        continue;
      }
      let body: string;
      try {
        body = JSON.stringify(activityRequest(batch));
      } catch {
        await this.failBatch(accountId, batch, "Defect", generation);
        continue;
      }
      if (new TextEncoder().encode(body).byteLength > ACTIVITY_BATCH_MAX_BYTES) {
        await this.failBatch(accountId, batch, "Defect", generation);
        continue;
      }
      if (!this.isCurrent(accountId, generation)) return;
      const outcome = await this.uploadWithRetry(
        body,
        batch,
        accountId,
        generation,
        signal,
      );
      if (outcome === undefined || !this.isCurrent(accountId, generation)) {
        return;
      }
      switch (outcome.kind) {
        case "Accepted":
          await this.write(() =>
            this.outbox.deleteRows(accountId, captureKeys(batch)),
          );
          await this.refresh(accountId);
          publishConsumptionProjectionChange();
          break;
        case "MediaUnavailable":
          await this.failBatch(
            accountId,
            batch,
            "MediaUnavailable",
            generation,
          );
          break;
        case "Expired":
          await this.failBatch(accountId, batch, "Expired", generation);
          break;
        case "Defect":
          await this.failBatch(accountId, batch, "Defect", generation);
          break;
        case "AuthenticationLost":
          await this.refresh(accountId);
          handleUnauthenticatedApiError(
            new ApiError(
              401,
              "E_UNAUTHENTICATED",
              "Activity upload authentication failed",
            ),
          );
          return;
        case "Retryable":
          await this.refresh(accountId);
          return;
      }
    }
  }

  private async runDrainLoop(): Promise<void> {
    while (this.drainRequested) {
      this.drainRequested = false;
      const accountId = this.accountId;
      if (
        accountId !== undefined &&
        this.storageAvailable &&
        !this.accountTransition
      ) {
        try {
          await this.drainAccount(
            accountId,
            this.accountGeneration,
            this.accountAbort.signal,
          );
        } catch {
          this.blockStorage();
        }
      }
    }
  }

  private async uploadWithRetry(
    body: string,
    batch: ActivityOutboxBatch,
    accountId: string,
    generation: number,
    signal: AbortSignal,
  ): Promise<ActivityUploadOutcome | undefined> {
    let outcome = await this.uploadAttempt(body, batch, signal);
    for (const delay of ACTIVITY_RETRY_DELAYS_MS) {
      if (outcome.kind !== "Retryable") return outcome;
      if (
        !this.isCurrent(accountId, generation) ||
        !(await this.waitForRetry(delay, signal))
      ) {
        return undefined;
      }
      outcome = await this.uploadAttempt(body, batch, signal);
    }
    return outcome;
  }

  private async uploadAttempt(
    body: string,
    batch: ActivityOutboxBatch,
    signal: AbortSignal,
  ): Promise<ActivityUploadOutcome> {
    const outcome = await this.upload(body, signal);
    if (outcome.kind !== "Accepted") {
      console.warn("consumption_activity_upload_rejected", {
        modality: batch.modality,
        count: batch.rows.length,
        reason: outcome.kind,
      });
    }
    return outcome;
  }

  private async failBatch(
    accountId: string,
    batch: ActivityOutboxBatch,
    reason: ActivityFailureReason,
    generation: number,
  ): Promise<void> {
    await this.failRows(
      accountId,
      captureKeys(batch),
      reason,
      generation,
    );
  }

  private async failRows(
    accountId: string,
    keys: readonly string[],
    reason: ActivityFailureReason,
    generation: number,
  ): Promise<void> {
    if (!this.isCurrent(accountId, generation)) return;
    await this.write(() =>
      this.outbox.markFailed(accountId, keys, reason),
    );
    await this.refresh(accountId);
  }

  private async refresh(accountId: string): Promise<void> {
    const summary = await this.write(() => this.outbox.summary(accountId));
    if (this.accountId !== accountId || this.accountTransition) return;
    this.summaryState = summary;
    this.publishSnapshot();
  }

  private publishSnapshot(): void {
    const browserCapture = captureState({
      storageAvailable: this.storageAvailable,
      summary: this.summaryState,
      recording: this.recording,
      capacityLimit: this.capacityLimit,
    });
    const browserSync = syncState(this.summaryState);
    const next: ActivityRuntimeSnapshot = {
      capture: combinedCaptureState(browserCapture, this.nativeSnapshot.capture),
      sync: combinedSyncState(browserSync, this.nativeSnapshot.sync),
    };
    if (
      JSON.stringify(next) === JSON.stringify(this.current)
    ) {
      return;
    }
    this.current = next;
    for (const listener of this.listeners) listener();
  }

  private publishNativeAcceptance(
    accountId: string,
    snapshot: AndroidActivitySyncSnapshot,
  ): void {
    const publishedRevision =
      this.nativePublishedRevisions.get(accountId) ?? 0;
    if (snapshot.acceptedRevision <= publishedRevision) return;
    this.nativePublishedRevisions.set(accountId, snapshot.acceptedRevision);
    publishConsumptionProjectionChange();
  }

  private blockStorage(): void {
    this.storageAvailable = false;
    this.recording = false;
    this.publishSnapshot();
  }

  private write<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writeTail.then(operation, operation);
    this.writeTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private isCurrent(accountId: string, generation: number): boolean {
    return (
      this.accountId === accountId && this.accountGeneration === generation
    );
  }

  private waitForRetry(delayMs: number, signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return Promise.resolve(false);
    return new Promise((resolve) => {
      let settled = false;
      const finish = (completed: boolean) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve(completed);
      };
      const onAbort = () => finish(false);
      signal.addEventListener("abort", onAbort, { once: true });
      void this.wait(delayMs).then(
        () => finish(true),
        () => finish(false),
      );
    });
  }
}

export function createActivityRuntime(options: RuntimeOptions = {}): ActivityRuntime {
  return new BrowserActivityRuntime(options);
}

let singleton: BrowserActivityRuntime | undefined;

export function activityRuntime(): ActivityRuntime {
  singleton ??= new BrowserActivityRuntime();
  return singleton;
}

export function activityRuntimeSnapshot(): ActivityRuntimeSnapshot {
  return activityRuntime().snapshot();
}

export function subscribeActivityRuntime(listener: () => void): () => void {
  return activityRuntime().subscribe(listener);
}

export function useActivityRuntimeSnapshot(): ActivityRuntimeSnapshot {
  return useSyncExternalStore(
    subscribeActivityRuntime,
    activityRuntimeSnapshot,
    () => INITIAL_SNAPSHOT,
  );
}

export function installActivityRecorderState(recording: boolean): void {
  const runtime = activityRuntime();
  if (runtime instanceof BrowserActivityRuntime) {
    runtime.installRecording(recording);
  }
}

export function installNativeActivitySync(
  accountId: string,
  snapshot: AndroidActivitySyncSnapshot | null,
): void {
  const runtime = activityRuntime();
  if (runtime instanceof BrowserActivityRuntime) {
    runtime.installNativeSnapshot(accountId, snapshot);
  }
}

export function installNativeActivityActions(
  accountId: string,
  actions: NativeActivityActions | null,
): void {
  const runtime = activityRuntime();
  if (runtime instanceof BrowserActivityRuntime) {
    runtime.installNativeActions(accountId, actions);
  }
}
