import { apiFetch, decodeApiPayload, isApiError, isSameSystemApiDefect } from "@/lib/api/client";
import { ApiRetryExhausted, requestWithRetry } from "@/lib/api/retryPolicy";
import { expectExactRecord, expectNonemptyString } from "@/lib/validation";
import { parseReaderCursorSnapshot, readerCursorSourcesEqual, readerStateConflictCurrent, type ReaderCursorSnapshot } from "./readerProgress";
import { ReaderIntentStore, type PendingReaderIntent, type SelectedReaderSource } from "./readerIntentStore";
import type { ReaderProgressSaveResult, ReaderProgressView } from "./ReaderProgressPort";
import { readerResumeStatesEqual, type ReaderResumeState } from "./types";

export interface ReaderAuthority {
  readonly source: SelectedReaderSource;
  readonly cursor: ReaderCursorSnapshot;
}

/**
 * A delivery whose row vanished before this runtime acknowledged it carries the
 * canonical state instead of a save outcome: only the holder of the submitted
 * intent can say whether that state acknowledges, supersedes or conflicts.
 */
export type ReaderDeliveryOutcome =
  | ReaderProgressSaveResult
  | { readonly kind: "Absent"; readonly authority: ReaderAuthority };

export type ReaderRecoveryNotice =
  | { readonly kind: "Review"; readonly row: PendingReaderIntent; readonly view: ReaderProgressView }
  | { readonly kind: "Pending"; readonly row: PendingReaderIntent }
  | { readonly kind: "Defect"; readonly error: unknown }
  | null;

interface Delivery {
  readonly observers: Set<(snapshot: ReaderCursorSnapshot) => void>;
  acknowledged: ReaderCursorSnapshot | null;
}

function pendingView(row: PendingReaderIntent): Extract<ReaderProgressView, { kind: "Pending" }> {
  return { kind: "Pending", baseline: row.baseline, source: row.desired.source, device: row.desired.locator };
}

/** Equality acknowledgment compares source plus locator, never locator alone. */
function acknowledges(snapshot: ReaderCursorSnapshot, source: SelectedReaderSource, locator: ReaderResumeState): boolean {
  return snapshot.state === "Positioned"
    && readerCursorSourcesEqual(snapshot.source, source)
    && readerResumeStatesEqual(snapshot.locator, locator);
}

/** Account lifetime owns delivery; IndexedDB owns every unacknowledged intent. */
export class HostedReaderProgressRuntime {
  readonly store = new ReaderIntentStore();
  private readonly deliveries = new Map<string, { state: Delivery; promise: Promise<ReaderDeliveryOutcome> }>();
  private readonly attached = new Map<string, (snapshot: ReaderCursorSnapshot) => void>();
  private readonly abort = new AbortController();
  private recovery: Promise<void> | undefined;
  private closed = false;

  constructor(readonly accountId: string, private readonly report: (notice: ReaderRecoveryNotice) => void) {}

  createPort(mediaId: string): HostedReaderProgressPort {
    return new HostedReaderProgressPort(this, mediaId);
  }

  attach(writerId: string, acknowledged: (snapshot: ReaderCursorSnapshot) => void): () => void {
    this.assertOpen();
    this.attached.set(writerId, acknowledged);
    return () => { this.attached.delete(writerId); };
  }

  reportDefect(error: unknown): void {
    if (!this.closed) this.report({ kind: "Defect", error });
  }

  async authority(mediaId: string, signal = this.abort.signal): Promise<ReaderAuthority> {
    this.assertOpen();
    const response = await requestWithRetry((attemptSignal) => apiFetch<unknown>(
      `/api/media/${mediaId}/offline-reader-state`, {
        signal: attemptSignal, headers: { "X-Nexus-Expected-Account-Id": this.accountId },
      },
    ), AbortSignal.any([signal, this.abort.signal]));
    return this.decode(response);
  }

  private decode(response: unknown): ReaderAuthority {
    return decodeApiPayload(response, (raw) => {
      const root = expectExactRecord(raw, ["data"], "Reader progress response");
      const data = expectExactRecord(root.data, ["accountId", "readerGeneration", "cursor"], "Reader progress authority");
      if (expectNonemptyString(data.accountId, "Reader account") !== this.accountId) {
        throw new Error("Reader progress account mismatch");
      }
      const generation = data.readerGeneration;
      if (generation !== null && (typeof generation !== "number" || !Number.isSafeInteger(generation) || generation < 1)) {
        throw new Error("Invalid reader publication generation");
      }
      return {
        source: generation === null ? { kind: "Timeline" } : { kind: "Publication", reader_generation: generation },
        cursor: parseReaderCursorSnapshot(data.cursor),
      };
    }, "Reader progress authority");
  }

  deliver(mediaId: string, writerId: string, acknowledged?: (snapshot: ReaderCursorSnapshot) => void, keepalive = false): Promise<ReaderDeliveryOutcome> {
    const existing = this.deliveries.get(writerId);
    if (existing !== undefined) {
      if (acknowledged !== undefined) {
        existing.state.observers.add(acknowledged);
        if (existing.state.acknowledged !== null) acknowledged(existing.state.acknowledged);
      }
      return existing.promise.then(async (result) => {
        // A new capture can arrive while the old drain is settling. A settled
        // drain acknowledges only its own work, never a row captured after it.
        if ((result.kind === "Canonical" || result.kind === "Absent")
          && await this.store.get(this.accountId, writerId) !== null) {
          return this.deliver(mediaId, writerId, acknowledged, keepalive);
        }
        return result;
      });
    }
    const delivery: Delivery = {
      observers: new Set(acknowledged === undefined ? [] : [acknowledged]),
      acknowledged: null,
    };
    const promise = this.drain(mediaId, writerId, delivery, keepalive).finally(() => {
      this.deliveries.delete(writerId);
    });
    this.deliveries.set(writerId, { state: delivery, promise });
    return promise;
  }

  private async drain(mediaId: string, writerId: string, delivery: Delivery, keepalive: boolean): Promise<ReaderDeliveryOutcome> {
    while (true) {
      this.assertOpen();
      const frozen = await this.store.freeze(this.accountId, writerId);
      if (frozen === null) {
        // Nothing acknowledged here and no row left: another browser context
        // delivered it, or storage was evicted. Current canonical state is not
        // an acknowledgment of an intent this drain never saw.
        if (delivery.acknowledged === null) {
          return { kind: "Absent", authority: await this.authority(mediaId) };
        }
        return { kind: "Canonical", snapshot: delivery.acknowledged };
      }
      const { row, retained } = frozen;
      const attempt = row.attempt;
      if (attempt === null) throw new Error("Reader attempt was not frozen");
      let snapshot: ReaderCursorSnapshot;
      try {
        // This small authority read also reconciles a previous response lost
        // after commit. It never treats a current pointer as cursor provenance.
        const current = await this.authority(row.mediaId);
        if (!readerCursorSourcesEqual(attempt.source, current.source)) {
          return { kind: "ContentChanged", view: { kind: "ContentChanged", baseline: row.baseline, source: row.desired.source, device: row.desired.locator } };
        }
        snapshot = current.cursor;
        // A retained attempt may already have committed, so equality settles it
        // without a duplicate mutation. A first dispatch always writes: the
        // server treats an equal locator as engagement at the same revision.
        if (!acknowledges(snapshot, attempt.source, attempt.locator)
          || (!retained && snapshot.revision === attempt.baseRevision)) {
          if (snapshot.revision !== attempt.baseRevision) {
            return { kind: "Conflict", canonical: snapshot, source: row.desired.source, device: row.desired.locator };
          }
          this.assertOpen();
          const response = await apiFetch<unknown>(`/api/media/${row.mediaId}/offline-reader-state`, {
            method: "PUT", signal: this.abort.signal,
            headers: { "X-Nexus-Expected-Account-Id": this.accountId },
            body: JSON.stringify({
              expectedReaderGeneration: attempt.source.kind === "Publication" ? attempt.source.reader_generation : null,
              baseRevision: attempt.baseRevision, locator: attempt.locator,
            }),
            ...(keepalive ? { keepalive: true } : {}),
          });
          const written = this.decode(response);
          snapshot = written.cursor;
          if (!readerCursorSourcesEqual(written.source, attempt.source)
            || !acknowledges(snapshot, attempt.source, attempt.locator)) {
            throw new Error("Reader write acknowledged a different intent");
          }
        }
      } catch (error) {
        // This read is reconciliation inside a durable mutation owner. Failed
        // delivery retains the persisted intent; it is not a missing page read.
        if (error instanceof ApiRetryExhausted) return { kind: "DurablyPending", view: pendingView(row) };
        const canonical = readerStateConflictCurrent(error);
        if (canonical === null) {
          if (!isApiError(error) || isSameSystemApiDefect(error)) throw error;
          if (error.code === "E_READER_CONTENT_CHANGED") {
            return { kind: "ContentChanged", view: { kind: "ContentChanged", baseline: row.baseline, source: row.desired.source, device: row.desired.locator } };
          }
          if (error.status === 404) {
            return { kind: "SourceUnavailable", view: { kind: "SourceUnavailable", baseline: row.baseline, source: row.desired.source, device: row.desired.locator } };
          }
          if (error.code === "E_NETWORK" || error.status >= 500) {
            return { kind: "DurablyPending", view: pendingView(row) };
          }
          throw error;
        }
        // Another context delivered this same frozen attempt and won the
        // revision cas. A duplicate delivery is acknowledged, not escalated.
        if (!acknowledges(canonical, attempt.source, attempt.locator)) {
          return { kind: "Conflict", canonical, source: row.desired.source, device: row.desired.locator };
        }
        snapshot = canonical;
      }
      // Install the baseline before deleting the row. A simultaneous new
      // capture must not resurrect the pre-acknowledgment baseline.
      delivery.acknowledged = snapshot;
      this.attached.get(writerId)?.(snapshot);
      for (const observe of delivery.observers) observe(snapshot);
      await this.store.acknowledge(row, snapshot);
    }
  }

  /** Bounded scan: a blocked writer never prevents another writer syncing. */
  recover(): void {
    if (this.closed || this.recovery !== undefined) return;
    this.recovery = this.recoverRows().catch((error: unknown) => {
      if (!this.closed) this.report({ kind: "Defect", error });
    }).finally(() => { this.recovery = undefined; });
  }

  private async recoverRows(): Promise<void> {
    let after: string | undefined;
    let notice: ReaderRecoveryNotice = null;
    while (!this.closed) {
      const row = await this.store.next(this.accountId, after);
      if (row === null) break;
      after = row.writerId;
      if (this.attached.has(row.writerId)) continue;
      try {
        const result = await this.deliver(row.mediaId, row.writerId);
        if (result.kind === "Canonical" || result.kind === "Absent" || notice !== null) continue;
        const pending = await this.store.get(this.accountId, row.writerId);
        if (pending === null) continue;
        notice = result.kind === "DurablyPending"
          ? { kind: "Pending", row: pending }
          : { kind: "Review", row: pending, view: result.kind === "Conflict" ? result : result.view };
      } catch (error) {
        if (!this.closed && notice === null) notice = { kind: "Defect", error };
      }
    }
    if (!this.closed) this.report(notice);
  }

  async resolve(row: PendingReaderIntent, observed: ReaderCursorSnapshot, choice: "Canonical" | "Device"): Promise<boolean> {
    this.assertOpen();
    const current = await this.authority(row.mediaId);
    if (current.cursor.revision !== observed.revision
      || (choice === "Device" && !readerCursorSourcesEqual(row.desired.source, current.source))) {
      this.recover();
      return false;
    }
    const applied = await this.store.resolve(row, current.cursor, choice);
    if (applied && choice === "Device") await this.deliver(row.mediaId, row.writerId);
    this.recover();
    return applied;
  }

  async discardUnavailable(row: PendingReaderIntent): Promise<boolean> {
    this.assertOpen();
    const applied = await this.store.resolve(row, row.baseline, "Canonical");
    this.recover();
    return applied;
  }

  assertOpen(): void {
    if (this.closed) throw new Error("Reader progress account lifetime ended");
  }

  close(): void {
    this.closed = true;
    this.abort.abort();
    this.attached.clear();
  }
}

export class HostedReaderProgressPort {
  private readonly writerId = crypto.randomUUID();
  private sequence = 0;
  private source: SelectedReaderSource | undefined;
  private baseline: ReaderCursorSnapshot | undefined;
  private awaitingAck: ReaderResumeState | null = null;
  private captured: Promise<unknown> = Promise.resolve();
  private review: { row: PendingReaderIntent; canonical: ReaderCursorSnapshot } | null = null;

  constructor(private readonly runtime: HostedReaderProgressRuntime, private readonly mediaId: string) {}

  attach(): () => void {
    const release = this.runtime.attach(this.writerId, (snapshot) => this.observe(snapshot));
    return () => {
      release();
      if (this.sequence === 0) return;
      void this.flush(this.mediaId, { keepalive: true }).catch((error: unknown) => {
        this.runtime.reportDefect(error);
      }).finally(() => this.runtime.recover());
    };
  }

  bindSource(mediaId: string, source: SelectedReaderSource): void {
    this.assertMedia(mediaId);
    if (this.source !== undefined && !readerCursorSourcesEqual(this.source, source)) {
      throw new Error("A new publication requires a new reader progress writer");
    }
    this.source = source;
  }

  async load(mediaId: string, signal?: AbortSignal): Promise<ReaderProgressView> {
    this.assertMedia(mediaId);
    const selected = this.selectedSource();
    const current = await this.runtime.authority(mediaId, signal);
    this.observe(current.cursor);
    const row = await this.runtime.store.get(this.runtime.accountId, this.writerId);
    this.review = row === null ? null : { row, canonical: current.cursor };
    if (row !== null) {
      if (!readerCursorSourcesEqual(row.desired.source, selected) || !readerCursorSourcesEqual(selected, current.source)) {
        return { kind: "ContentChanged", baseline: row.baseline, source: row.desired.source, device: row.desired.locator };
      }
      const submitted = row.attempt ?? row.desired;
      if (current.cursor.state === "Positioned"
        && readerCursorSourcesEqual(current.cursor.source, submitted.source)
        && readerResumeStatesEqual(current.cursor.locator, submitted.locator)) {
        const result = await this.flush(mediaId);
        return result.kind === "Canonical" || result.kind === "Conflict" ? result : result.view;
      }
      if (current.cursor.revision !== row.baseline.revision) {
        return { kind: "Conflict", canonical: current.cursor, source: row.desired.source, device: row.desired.locator };
      }
      return pendingView(row);
    }
    if (current.cursor.state === "Positioned" && !readerCursorSourcesEqual(current.cursor.source, selected)) {
      return { kind: "ContentChanged", baseline: current.cursor, source: current.cursor.source, device: current.cursor.locator };
    }
    return { kind: "Canonical", snapshot: current.cursor };
  }

  capture(mediaId: string, locator: ReaderResumeState): Promise<ReaderProgressSaveResult> {
    // Every failure, including a failed precondition, reaches the caller's
    // rejection handler: capture is invoked from movement handlers.
    const captured = this.persistIntent(mediaId, locator);
    this.captured = captured;
    return captured;
  }

  private async persistIntent(mediaId: string, locator: ReaderResumeState): Promise<ReaderProgressSaveResult> {
    this.assertMedia(mediaId);
    this.runtime.assertOpen();
    const source = this.selectedSource();
    if (this.baseline === undefined) throw new Error("Reader intent has no loaded baseline");
    const sequence = ++this.sequence;
    this.awaitingAck = locator;
    // Invoke the transaction now. Renderer cleanup cannot cancel this promise.
    const row = await this.runtime.store.capture({
      accountId: this.runtime.accountId, writerId: this.writerId, mediaId,
      sequence, source, locator, baseline: this.baseline,
    });
    return { kind: "DurablyPending", view: pendingView(row) };
  }

  async flush(mediaId: string, options: { keepalive?: boolean } = {}): Promise<ReaderProgressSaveResult> {
    this.assertMedia(mediaId);
    this.runtime.assertOpen();
    await this.captured;
    const row = await this.runtime.store.get(this.runtime.accountId, this.writerId);
    if (row === null && this.awaitingAck === null) {
      if (this.baseline === undefined) throw new Error("Reader progress has no loaded baseline");
      return { kind: "Canonical", snapshot: this.baseline };
    }
    const outcome = await this.runtime.deliver(mediaId, this.writerId, (snapshot) => this.observe(snapshot), options.keepalive);
    const result = outcome.kind === "Absent"
      ? await this.reconcileAbsent(outcome.authority, options.keepalive, true)
      : outcome;
    const pending = result.kind === "Canonical" ? null
      : await this.runtime.store.get(this.runtime.accountId, this.writerId);
    this.review = pending === null ? null : {
      row: pending,
      canonical: result.kind === "Conflict" ? result.canonical : pending.baseline,
    };
    return result;
  }

  /**
   * This writer's row is gone without an acknowledgment of its submitted
   * intent. Classify canonical state exactly as a frozen attempt is classified:
   * a changed generation preserves the intent as content-changed, an equal
   * source and locator acknowledges it, an unchanged base replays it, and any
   * other canonical state is a competing writer's explicit conflict.
   */
  private async reconcileAbsent(
    authority: ReaderAuthority, keepalive: boolean | undefined, replay: boolean,
  ): Promise<ReaderProgressSaveResult> {
    const baseline = this.baseline;
    if (baseline === undefined) throw new Error("Reader progress has no loaded baseline");
    const intent = this.awaitingAck;
    if (intent === null) {
      this.observe(authority.cursor);
      return { kind: "Canonical", snapshot: authority.cursor };
    }
    const source = this.selectedSource();
    if (!readerCursorSourcesEqual(source, authority.source)) {
      return { kind: "ContentChanged", view: { kind: "ContentChanged", baseline, source, device: intent } };
    }
    if (acknowledges(authority.cursor, source, intent)) {
      this.observe(authority.cursor);
      return { kind: "Canonical", snapshot: authority.cursor };
    }
    if (replay && authority.cursor.revision === baseline.revision) {
      // The base is unchanged, so this intent is still dispatchable: persist it
      // again and deliver once. A second absence cannot replay again.
      await this.capture(this.mediaId, intent);
      const outcome = await this.runtime.deliver(this.mediaId, this.writerId, (snapshot) => this.observe(snapshot), keepalive);
      return outcome.kind === "Absent" ? this.reconcileAbsent(outcome.authority, keepalive, false) : outcome;
    }
    return { kind: "Conflict", canonical: authority.cursor, source, device: intent };
  }

  async resolve(mediaId: string, choice: "Canonical" | "Device"): Promise<ReaderProgressView> {
    this.assertMedia(mediaId);
    if (this.review !== null) await this.runtime.resolve(this.review.row, this.review.canonical, choice);
    return this.load(mediaId);
  }

  private selectedSource(): SelectedReaderSource {
    if (this.source === undefined) throw new Error("Reader progress source was not selected");
    return this.source;
  }

  private observe(snapshot: ReaderCursorSnapshot): void {
    if (this.baseline !== undefined && snapshot.revision < this.baseline.revision) return;
    this.baseline = snapshot;
    if (this.source !== undefined && snapshot.state === "Positioned"
      && readerCursorSourcesEqual(snapshot.source, this.source)
      && readerResumeStatesEqual(snapshot.locator, this.awaitingAck)) {
      this.awaitingAck = null;
    }
  }

  private assertMedia(mediaId: string): void {
    if (mediaId !== this.mediaId) throw new Error("Reader progress media identity mismatch");
  }
}
