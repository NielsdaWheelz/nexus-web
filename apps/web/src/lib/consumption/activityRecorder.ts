import {
  postActivityBatch,
  type ActivityBatch,
  type ActivityDeviceClass,
  type ActivityModality,
  type MediaRef,
  type ActivityRequest,
  type ActivityUploadOutcome,
  type ListeningActivitySpan,
  type ReadingActivitySpan,
  type ViewingActivitySpan,
} from "./activityContract";
import { absent, present, type Presence } from "@/lib/api/presence";
import { ApiError } from "@/lib/api/client";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";

export const ACTIVITY_SPAN_MAX_MS = 30_000;
export const ACTIVITY_CHECKPOINT_MS = 10_000;
export const ACTIVITY_FLUSH_MS = 30_000;
export const ACTIVITY_SUSPENSION_AFTER_MS = 35_000;
export const ACTIVITY_MAX_LANES = 8;
export const ACTIVITY_BATCH_MAX_SPANS = 120;
export const ACTIVITY_BATCH_MAX_BYTES = 48_000;
export const ACTIVITY_RETRY_DELAYS_MS = [2_000, 5_000, 15_000, 60_000] as const;

export interface ActivityMeasurement {
  progress?: number;
  wordPosition?: number;
  mediaPositionMs?: number;
}

export interface ActivityObservation {
  mediaRef: MediaRef;
  modality: ActivityModality;
  deviceClass: ActivityDeviceClass;
  eligible: boolean;
  /** Monotonic deadline set only by the reader's last genuine input. */
  idleUntilMono?: number;
  measurement?: ActivityMeasurement;
}

export type ActivityDiagnostic =
  | "capture-degraded"
  | "duplicate-observer"
  | "recorder-defect";

interface Observer extends ActivityObservation {
  key: string;
}

interface Lane {
  key: string;
  groupKey: string;
  observerKey: string;
  mediaRef: MediaRef;
  modality: ActivityModality;
  deviceClass: ActivityDeviceClass;
  startedMono: number;
  startedWall: number;
  startedMeasurement: ActivityMeasurement | undefined;
  accruing: boolean;
  pending: ActivitySpan[];
  pendingSinceMono: number | undefined;
  frozen: FrozenBatch | undefined;
  retryAtMono: number | undefined;
  retryAttempt: number;
  degraded: boolean;
}

type ActivitySpan = ReadingActivitySpan | ListeningActivitySpan | ViewingActivitySpan;

interface FrozenBatch {
  body: string;
  laneKey: string;
}

interface ActivityRecorderOptions {
  now?: () => number;
  wallNow?: () => number;
  upload?: (input: { body: string; keepalive: boolean }) => Promise<ActivityUploadOutcome>;
  diagnostic?: (kind: ActivityDiagnostic) => void;
}

function groupKey(observation: Pick<ActivityObservation, "mediaRef" | "modality">): string {
  return `${observation.mediaRef}\u0000${observation.modality}`;
}

function laneKey(observation: Pick<ActivityObservation, "mediaRef" | "modality" | "deviceClass">): string {
  return `${groupKey(observation)}\u0000${observation.deviceClass}`;
}

function validProgress(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : null;
}

function validPosition(value: number | undefined): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function matchingMeasurement(
  start: number | null,
  end: number | null,
): [Presence<number>, Presence<number>] {
  return start === null || end === null
    ? [absent(), absent()]
    : [present(start), present(end)];
}

function asActivitySpan(input: {
  lane: Lane;
  occurredAt: string;
  durationMs: number;
  endMeasurement: ActivityMeasurement | undefined;
}): ActivitySpan {
  const { lane } = input;
  if (lane.modality === "Viewing") {
    return { occurredAt: input.occurredAt, durationMs: input.durationMs };
  }
  const [progressStart, progressEnd] = matchingMeasurement(
    validProgress(lane.startedMeasurement?.progress),
    validProgress(input.endMeasurement?.progress),
  );
  if (lane.modality === "Reading") {
    const [wordStart, wordEnd] = matchingMeasurement(
      validPosition(lane.startedMeasurement?.wordPosition),
      validPosition(input.endMeasurement?.wordPosition),
    );
    return {
      occurredAt: input.occurredAt,
      durationMs: input.durationMs,
      progressStart,
      progressEnd,
      wordStart,
      wordEnd,
    };
  }
  const [mediaPositionStartMs, mediaPositionEndMs] = matchingMeasurement(
    validPosition(lane.startedMeasurement?.mediaPositionMs),
    validPosition(input.endMeasurement?.mediaPositionMs),
  );
  return {
    occurredAt: input.occurredAt,
    durationMs: input.durationMs,
    progressStart,
    progressEnd,
    mediaPositionStartMs,
    mediaPositionEndMs,
  };
}

/**
 * The one tab-local owner of bounded consumption capture. Adapters only publish
 * observations; this recorder owns eligibility arbitration, timing, batching,
 * replay identity, and upload behavior.
 */
export class ActivityRecorder {
  private readonly now: () => number;
  private readonly wallNow: () => number;
  private readonly upload: NonNullable<ActivityRecorderOptions["upload"]>;
  private readonly diagnostic: NonNullable<ActivityRecorderOptions["diagnostic"]>;
  private readonly observers = new Map<string, Observer>();
  private readonly lanes = new Map<string, Lane>();
  private readonly ambiguousGroups = new Set<string>();
  private captureReady = false;
  private requestInFlight = false;
  private inFlightFrozen: FrozenBatch | undefined;
  private wakeTimer: number | undefined;

  constructor(options: ActivityRecorderOptions = {}) {
    this.now = options.now ?? (() => performance.now());
    this.wallNow = options.wallNow ?? Date.now;
    this.upload = options.upload ?? postActivityBatch;
    this.diagnostic = options.diagnostic ?? ((kind) => {
      console.warn({ event: "consumption_capture_diagnostic", kind });
    });
  }

  setCaptureReady(ready: boolean): void {
    if (this.captureReady === ready) return;
    this.captureReady = ready;
    this.reconcileAll();
  }

  registerObserver(key: string, observation: ActivityObservation): () => void {
    if (this.observers.has(key)) {
      throw new Error(`Duplicate activity observer registration: ${key}`);
    }
    this.observers.set(key, { key, ...observation });
    this.reconcileGroup(groupKey(observation));
    return () => {
      const current = this.observers.get(key);
      if (!current) return;
      const keyGroup = groupKey(current);
      this.observers.set(key, { ...current, eligible: false });
      this.reconcileGroup(keyGroup);
      this.observers.delete(key);
      this.reconcileGroup(keyGroup);
    };
  }

  observe(key: string, observation: ActivityObservation): void {
    const previous = this.observers.get(key);
    if (!previous) {
      throw new Error(`Unknown activity observer: ${key}`);
    }
    if (
      previous.mediaRef !== observation.mediaRef ||
      previous.modality !== observation.modality
    ) {
      throw new Error("Activity observer media and modality are immutable");
    }
    this.observers.set(key, { key, ...observation });
    this.reconcileGroup(groupKey(observation));
  }

  flushForPageHide(): void {
    this.reconcileAll();
    if (this.inFlightFrozen) {
      void this.upload({ body: this.inFlightFrozen.body, keepalive: true });
    }
    for (const lane of this.lanes.values()) {
      this.closeLane(lane, false);
      this.freeze(lane);
    }
    this.dispatchReady(true);
  }

  dispose(): void {
    if (this.wakeTimer !== undefined) {
      window.clearTimeout(this.wakeTimer);
      this.wakeTimer = undefined;
    }
    this.observers.clear();
    this.lanes.clear();
  }

  private eligibleObservers(key: string): Observer[] {
    const now = this.now();
    return [...this.observers.values()].filter(
      (observer) =>
        groupKey(observer) === key &&
        this.captureReady &&
        observer.eligible &&
        (observer.idleUntilMono === undefined || observer.idleUntilMono > now),
    );
  }

  private reconcileAll(): void {
    const groups = new Set([...this.observers.values()].map(groupKey));
    for (const lane of this.lanes.values()) groups.add(lane.groupKey);
    for (const key of groups) this.reconcileGroup(key);
    this.scheduleWake();
  }

  private reconcileGroup(key: string): void {
    const observers = this.eligibleObservers(key);
    const active = [...this.lanes.values()].find(
      (lane) => lane.groupKey === key && lane.accruing,
    );
    if (observers.length > 1) {
      if (active) this.closeLane(active, false);
      if (!this.ambiguousGroups.has(key)) {
        this.ambiguousGroups.add(key);
        this.diagnostic("duplicate-observer");
      }
      return;
    }
    this.ambiguousGroups.delete(key);
    const observer = observers[0];
    if (!observer) {
      if (active) {
        const closingObserver = this.observers.get(active.observerKey);
        const deadline = closingObserver?.idleUntilMono;
        this.closeLane(
          active,
          false,
          deadline !== undefined && deadline <= this.now() ? deadline : this.now(),
        );
      }
      return;
    }
    const nextLaneKey = laneKey(observer);
    if (active && (active.observerKey !== observer.key || active.key !== nextLaneKey)) {
      this.closeLane(active, false);
    }
    const existing = this.lanes.get(nextLaneKey);
    if (existing?.degraded) return;
    if (!existing && this.lanes.size >= ACTIVITY_MAX_LANES) {
      this.diagnostic("capture-degraded");
      return;
    }
    if (!existing) {
      this.lanes.set(nextLaneKey, {
        key: nextLaneKey,
        groupKey: key,
        observerKey: observer.key,
        mediaRef: observer.mediaRef,
        modality: observer.modality,
        deviceClass: observer.deviceClass,
        startedMono: this.now(),
        startedWall: this.wallNow(),
        startedMeasurement: observer.measurement,
        accruing: true,
        pending: [],
        pendingSinceMono: undefined,
        frozen: undefined,
        retryAtMono: undefined,
        retryAttempt: 0,
        degraded: false,
      });
    } else if (!existing.accruing) {
      existing.observerKey = observer.key;
      existing.startedMono = this.now();
      existing.startedWall = this.wallNow();
      existing.startedMeasurement = observer.measurement;
      existing.accruing = true;
    }
  }

  private closeLane(lane: Lane, reopen: boolean, endMono = this.now()): void {
    if (!lane.accruing) return;
    const now = this.now();
    const closedAtMono = Math.max(lane.startedMono, Math.min(now, endMono));
    const elapsed = closedAtMono - lane.startedMono;
    const observer = this.observers.get(lane.observerKey);
    if (elapsed > ACTIVITY_SPAN_MAX_MS) {
      // A delayed callback is a suspension gap, not evidence for a clipped span.
      const suspensionGap = elapsed > ACTIVITY_SUSPENSION_AFTER_MS;
      lane.startedMono = closedAtMono;
      lane.startedWall = this.wallNow();
      lane.startedMeasurement = observer?.measurement;
      lane.accruing = reopen;
      if (suspensionGap) this.freeze(lane);
      return;
    }
    const durationMs = Math.floor(elapsed);
    if (durationMs > 0) {
      if (lane.frozen && lane.pending.length >= ACTIVITY_BATCH_MAX_SPANS) {
        lane.degraded = true;
        lane.pending = [];
        this.diagnostic("capture-degraded");
        return;
      }
      lane.pending.push(
        asActivitySpan({
          lane,
          occurredAt: new Date(lane.startedWall).toISOString(),
          durationMs,
          endMeasurement: observer?.measurement,
        }),
      );
      if (
        lane.frozen &&
        new TextEncoder().encode(JSON.stringify(lane.pending)).byteLength >
          ACTIVITY_BATCH_MAX_BYTES
      ) {
        lane.degraded = true;
        lane.pending = [];
        this.diagnostic("capture-degraded");
        return;
      }
      lane.pendingSinceMono ??= now;
    }
    lane.startedMono = closedAtMono;
    lane.startedWall = this.wallNow();
    lane.startedMeasurement = observer?.measurement;
    lane.accruing = reopen;
    if (lane.pending.length >= ACTIVITY_BATCH_MAX_SPANS || !reopen) this.freeze(lane);
    if (!reopen) this.removeIfDormant(lane);
    this.scheduleWake();
  }

  private freeze(lane: Lane): void {
    if (lane.degraded || lane.pending.length === 0) return;
    if (lane.frozen) return;
    const clientMutationId = globalThis.crypto?.randomUUID?.();
    if (!clientMutationId) {
      lane.degraded = true;
      lane.pending = [];
      this.diagnostic("capture-degraded");
      return;
    }
    const batch: ActivityBatch = { modality: lane.modality, spans: lane.pending } as ActivityBatch;
    const request: ActivityRequest = {
      clientMutationId,
      mediaRef: lane.mediaRef,
      deviceClass: lane.deviceClass,
      batch,
    };
    const body = JSON.stringify(request);
    if (new TextEncoder().encode(body).byteLength > ACTIVITY_BATCH_MAX_BYTES) {
      lane.degraded = true;
      lane.pending = [];
      this.diagnostic("capture-degraded");
      return;
    }
    lane.frozen = { body, laneKey: lane.key };
    lane.pending = [];
    lane.pendingSinceMono = undefined;
    lane.retryAtMono = this.now();
    this.dispatchReady(false);
  }

  private checkpoint(): void {
    this.reconcileAll();
    const now = this.now();
    for (const lane of this.lanes.values()) {
      if (!lane.accruing) continue;
      const observer = this.observers.get(lane.observerKey);
      const currentEligible =
        observer !== undefined &&
        this.captureReady &&
        observer.eligible &&
        (observer.idleUntilMono === undefined || observer.idleUntilMono > now);
      if (currentEligible) this.closeLane(lane, true);
      else this.closeLane(lane, false);
      if (
        lane.pendingSinceMono !== undefined &&
        now - lane.pendingSinceMono >= ACTIVITY_FLUSH_MS
      ) {
        this.freeze(lane);
      }
      if (lane.pending.length >= ACTIVITY_BATCH_MAX_SPANS) this.freeze(lane);
    }
    this.dispatchReady(false);
  }

  private dispatchReady(keepalive: boolean): void {
    if (this.requestInFlight) return;
    const now = this.now();
    const lane = [...this.lanes.values()].find(
      (candidate) =>
        !candidate.degraded &&
        candidate.frozen !== undefined &&
        (candidate.retryAtMono === undefined || candidate.retryAtMono <= now),
    );
    if (!lane?.frozen) return;
    const frozen = lane.frozen;
    this.requestInFlight = true;
    this.inFlightFrozen = frozen;
    void this.upload({ body: frozen.body, keepalive })
      .then((outcome) => {
        if (lane.frozen !== frozen) return;
        switch (outcome.kind) {
          case "Accepted":
            lane.frozen = undefined;
            lane.retryAtMono = undefined;
            lane.retryAttempt = 0;
            this.removeIfDormant(lane);
            break;
          case "Retryable": {
            const delay = ACTIVITY_RETRY_DELAYS_MS[lane.retryAttempt];
            if (delay === undefined) {
              lane.degraded = true;
              lane.frozen = undefined;
              this.diagnostic("capture-degraded");
              break;
            }
            lane.retryAttempt += 1;
            lane.retryAtMono = this.now() + delay;
            break;
          }
          case "VisibilityLost":
            lane.frozen = undefined;
            lane.pending = [];
            lane.degraded = true;
            break;
          case "AuthenticationLost":
            handleUnauthenticatedApiError(
              new ApiError(401, "E_UNAUTHENTICATED", "Activity capture authentication failed"),
            );
            lane.frozen = undefined;
            lane.pending = [];
            lane.degraded = true;
            break;
          case "Defect":
            lane.frozen = undefined;
            lane.degraded = true;
            this.diagnostic("recorder-defect");
            break;
        }
      })
      .catch(() => {
        lane.degraded = true;
        lane.frozen = undefined;
        this.diagnostic("recorder-defect");
      })
      .finally(() => {
        this.requestInFlight = false;
        this.inFlightFrozen = undefined;
        this.dispatchReady(false);
        this.scheduleWake();
      });
  }

  private removeIfDormant(lane: Lane): void {
    if (!lane.accruing && lane.pending.length === 0 && lane.frozen === undefined) {
      this.lanes.delete(lane.key);
    }
  }

  private scheduleWake(): void {
    if (typeof window === "undefined") return;
    if (this.wakeTimer !== undefined) {
      window.clearTimeout(this.wakeTimer);
      this.wakeTimer = undefined;
    }
    const now = this.now();
    let delay = ACTIVITY_CHECKPOINT_MS;
    for (const lane of this.lanes.values()) {
      if (lane.retryAtMono !== undefined) {
        delay = Math.min(delay, Math.max(0, lane.retryAtMono - now));
      }
      const observer = this.observers.get(lane.observerKey);
      if (observer?.idleUntilMono !== undefined) {
        delay = Math.min(delay, Math.max(0, observer.idleUntilMono - now));
      }
    }
    this.wakeTimer = window.setTimeout(() => {
      this.wakeTimer = undefined;
      this.checkpoint();
    }, delay);
  }
}

let recorder: ActivityRecorder | undefined;

export function activityRecorder(): ActivityRecorder {
  recorder ??= new ActivityRecorder();
  return recorder;
}
