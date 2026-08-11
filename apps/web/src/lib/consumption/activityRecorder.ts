import { absent, present, type Presence } from "@/lib/api/presence";
import {
  type ActivityCaptureKey,
  type ActivityDeviceClass,
  type ActivityModality,
  type ClosedActivitySpan,
  type MediaRef,
  type ListeningActivitySpanBody,
  parseActivityCaptureKey,
  type ReadingActivitySpanBody,
  type ViewingActivitySpanBody,
} from "./activityContract";
import {
  activityRuntime,
  installActivityRecorderState,
} from "./activityRuntime";
import {
  emitActivityDiagnostic,
  type ActivityDiagnosticEmitter,
} from "./activityDiagnostics";

export const ACTIVITY_SPAN_MAX_MS = 30_000;
export const ACTIVITY_CHECKPOINT_MS = 10_000;
export const ACTIVITY_SUSPENSION_AFTER_MS = 35_000;
export const ACTIVITY_MAX_LANES = 8;

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

export type ActivityLifecycleReason =
  | "Hidden"
  | "PageHide"
  | "ShellUnmount";

export type ActivityDiagnostic = "duplicate-observer" | "recorder-defect";

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
}

interface ActivityRecorderOptions {
  now?: () => number;
  wallNow?: () => number;
  closedSpan?: (span: ClosedActivitySpan) => void;
  recordingChanged?: (recording: boolean) => void;
  activityDiagnostic?: ActivityDiagnosticEmitter;
  diagnostic?: (kind: ActivityDiagnostic) => void;
}

function groupKey(
  observation: Pick<ActivityObservation, "mediaRef" | "modality">,
): string {
  return `${observation.mediaRef}\u0000${observation.modality}`;
}

function laneKey(
  observation: Pick<
    ActivityObservation,
    "mediaRef" | "modality" | "deviceClass"
  >,
): string {
  return `${groupKey(observation)}\u0000${observation.deviceClass}`;
}

function validProgress(value: number | undefined): number | null {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 1
    ? value
    : null;
}

function validPosition(value: number | undefined): number | null {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
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

function spanBody(input: {
  lane: Lane;
  occurredAt: string;
  durationMs: number;
  endMeasurement: ActivityMeasurement | undefined;
}):
  | ReadingActivitySpanBody
  | ListeningActivitySpanBody
  | ViewingActivitySpanBody {
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

function closedSpan(
  lane: Lane,
  captureKey: ActivityCaptureKey,
  body:
    | ReadingActivitySpanBody
    | ListeningActivitySpanBody
    | ViewingActivitySpanBody,
): ClosedActivitySpan {
  switch (lane.modality) {
    case "Reading":
      return {
        captureKey,
        mediaRef: lane.mediaRef,
        modality: "Reading",
        deviceClass: lane.deviceClass,
        // justify-type-assertion: spanBody and the lane discriminator are
        // created together in this recorder and cannot disagree.
        span: body as ReadingActivitySpanBody,
      };
    case "Listening":
      return {
        captureKey,
        mediaRef: lane.mediaRef,
        modality: "Listening",
        deviceClass: lane.deviceClass,
        // justify-type-assertion: spanBody and the lane discriminator are
        // created together in this recorder and cannot disagree.
        span: body as ListeningActivitySpanBody,
      };
    case "Viewing":
      return {
        captureKey,
        mediaRef: lane.mediaRef,
        modality: "Viewing",
        deviceClass: lane.deviceClass,
        // justify-type-assertion: spanBody and the lane discriminator are
        // created together in this recorder and cannot disagree.
        span: body as ViewingActivitySpanBody,
      };
  }
}

/**
 * The tab-local pure state machine for bounded Consumption observations.
 * Closed spans leave immediately through the one injected durable sink.
 */
export class ActivityRecorder {
  private readonly now: () => number;
  private readonly wallNow: () => number;
  private readonly emitClosedSpan: (span: ClosedActivitySpan) => void;
  private readonly recordingChanged: (recording: boolean) => void;
  private readonly diagnostic: (kind: ActivityDiagnostic) => void;
  private readonly activityDiagnostic: ActivityDiagnosticEmitter;
  private readonly observers = new Map<string, Observer>();
  private readonly lanes = new Map<string, Lane>();
  private readonly ambiguousGroups = new Set<string>();
  private captureReady = false;
  private recording = false;
  private wakeTimer: number | undefined;

  constructor(options: ActivityRecorderOptions = {}) {
    this.now = options.now ?? (() => performance.now());
    this.wallNow = options.wallNow ?? Date.now;
    this.emitClosedSpan = options.closedSpan ?? (() => undefined);
    this.recordingChanged = options.recordingChanged ?? (() => undefined);
    this.activityDiagnostic =
      options.activityDiagnostic ?? emitActivityDiagnostic;
    this.diagnostic =
      options.diagnostic ??
      ((kind) => {
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
    this.scheduleWake();
    this.publishRecording();
    return () => {
      const current = this.observers.get(key);
      if (!current) return;
      const keyGroup = groupKey(current);
      this.observers.set(key, { ...current, eligible: false });
      this.reconcileGroup(keyGroup);
      this.observers.delete(key);
      this.reconcileGroup(keyGroup);
      this.scheduleWake();
      this.publishRecording();
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
    this.scheduleWake();
    this.publishRecording();
  }

  closeForLifecycle(_reason: ActivityLifecycleReason): void {
    this.captureReady = false;
    for (const lane of [...this.lanes.values()]) {
      this.closeLane(lane, false);
    }
    this.scheduleWake();
    this.publishRecording();
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
    this.publishRecording();
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
          deadline !== undefined && deadline <= this.now()
            ? deadline
            : this.now(),
        );
      }
      return;
    }
    const nextLaneKey = laneKey(observer);
    if (
      active &&
      (active.observerKey !== observer.key || active.key !== nextLaneKey)
    ) {
      this.closeLane(active, false);
    }
    const existing = this.lanes.get(nextLaneKey);
    if (!existing && this.lanes.size >= ACTIVITY_MAX_LANES) {
      this.diagnostic("recorder-defect");
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
      const suspensionGap = elapsed > ACTIVITY_SUSPENSION_AFTER_MS;
      lane.startedMono = closedAtMono;
      lane.startedWall = this.wallNow();
      lane.startedMeasurement = observer?.measurement;
      lane.accruing = reopen;
      if (suspensionGap) this.diagnostic("recorder-defect");
      if (!reopen) this.removeDormant(lane);
      return;
    }
    const durationMs = Math.floor(elapsed);
    if (durationMs > 0) {
      const rawCaptureKey = globalThis.crypto?.randomUUID?.();
      if (rawCaptureKey === undefined) {
        this.diagnostic("recorder-defect");
      } else {
        const body = spanBody({
          lane,
          occurredAt: new Date(lane.startedWall).toISOString(),
          durationMs,
          endMeasurement: observer?.measurement,
        });
        const captured = closedSpan(
          lane,
          parseActivityCaptureKey(rawCaptureKey),
          body,
        );
        this.emitClosedSpan(captured);
        this.activityDiagnostic({
          event: "activity_span_closed",
          platform: "Web",
          modality: captured.modality,
          count: 1,
        });
      }
    }
    lane.startedMono = closedAtMono;
    lane.startedWall = this.wallNow();
    lane.startedMeasurement = observer?.measurement;
    lane.accruing = reopen;
    if (!reopen) this.removeDormant(lane);
  }

  private removeDormant(lane: Lane): void {
    if (!lane.accruing) this.lanes.delete(lane.key);
  }

  private checkpoint(): void {
    this.reconcileAll();
    const now = this.now();
    for (const lane of [...this.lanes.values()]) {
      if (!lane.accruing) continue;
      const observer = this.observers.get(lane.observerKey);
      const eligible =
        observer !== undefined &&
        this.captureReady &&
        observer.eligible &&
        (observer.idleUntilMono === undefined || observer.idleUntilMono > now);
      this.closeLane(lane, eligible);
    }
    this.scheduleWake();
    this.publishRecording();
  }

  private scheduleWake(): void {
    if (typeof window === "undefined") return;
    if (this.wakeTimer !== undefined) {
      window.clearTimeout(this.wakeTimer);
      this.wakeTimer = undefined;
    }
    if (!this.captureReady && this.lanes.size === 0) return;
    const now = this.now();
    let delay = ACTIVITY_CHECKPOINT_MS;
    for (const lane of this.lanes.values()) {
      const observer = this.observers.get(lane.observerKey);
      if (observer?.idleUntilMono !== undefined) {
        delay = Math.min(
          delay,
          Math.max(0, observer.idleUntilMono - now),
        );
      }
    }
    this.wakeTimer = window.setTimeout(() => {
      this.wakeTimer = undefined;
      this.checkpoint();
    }, delay);
  }

  private publishRecording(): void {
    const recording = [...this.lanes.values()].some((lane) => lane.accruing);
    if (recording === this.recording) return;
    this.recording = recording;
    this.recordingChanged(recording);
  }
}

let recorder: ActivityRecorder | undefined;

export function activityRecorder(): ActivityRecorder {
  recorder ??= new ActivityRecorder({
    closedSpan: (span) => {
      void activityRuntime().enqueue(span);
    },
    recordingChanged: installActivityRecorderState,
  });
  return recorder;
}
