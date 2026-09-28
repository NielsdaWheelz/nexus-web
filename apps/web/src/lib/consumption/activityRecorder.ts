import { absent, present, type Presence } from "@/lib/api/presence";
import type {
  ActivityDeviceClass,
  ActivityModality,
  ClosedActivitySpan,
  MediaRef,
} from "./activityContract";
import { activityRuntime } from "./activityRuntime";

// The tab's capture state machine. Observers report eligibility; each (work, modality) group
// accrues at most one span at a time, from its single eligible observer. A span closes at every
// 10 s checkpoint, on ineligibility (at the idle deadline when that has passed), on a change of
// observer or device class, and on lifecycle close. Closed spans go straight to the outbox.

const SPAN_MAX_MS = 30_000;
const CHECKPOINT_MS = 10_000;
const SUSPENDED_AFTER_MS = 35_000;

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

interface Accrual {
  observerKey: string;
  lane: Pick<ActivityObservation, "mediaRef" | "modality" | "deviceClass">;
  startMono: number;
  startWall: number;
  startMeasurement: ActivityMeasurement | undefined;
}

const observers = new Map<string, ActivityObservation>();
const accruals = new Map<string, Accrual>();
const ambiguous = new Set<string>();
let captureReady = false;
let recording = false;
let timer: number | undefined;

const groupOf = ({ mediaRef, modality }: ActivityObservation) => `${mediaRef}\u0000${modality}`;
const isProgress = (value: number) => Number.isFinite(value) && value >= 0 && value <= 1;
const isPosition = (value: number) => Number.isSafeInteger(value) && value >= 0;

/** A measurement pair, Present only when both of its ends are valid. */
function pair(
  start: number | undefined,
  end: number | undefined,
  valid: (value: number) => boolean,
): [Presence<number>, Presence<number>] {
  return start !== undefined && end !== undefined && valid(start) && valid(end)
    ? [present(start), present(end)]
    : [absent(), absent()];
}

function closedSpan(
  { lane, startWall, startMeasurement: start }: Accrual,
  durationMs: number,
  end: ActivityMeasurement | undefined,
): ClosedActivitySpan {
  const { mediaRef, deviceClass } = lane;
  const head = { captureKey: crypto.randomUUID(), mediaRef, deviceClass };
  const base = { occurredAt: new Date(startWall).toISOString(), durationMs };
  const [progressStart, progressEnd] = pair(start?.progress, end?.progress, isProgress);
  if (lane.modality === "Viewing") return { ...head, modality: "Viewing", span: base };
  if (lane.modality === "Reading") {
    const [wordStart, wordEnd] = pair(start?.wordPosition, end?.wordPosition, isPosition);
    const span = { ...base, progressStart, progressEnd, wordStart, wordEnd };
    return { ...head, modality: "Reading", span };
  }
  const [mediaPositionStartMs, mediaPositionEndMs] = pair(
    start?.mediaPositionMs,
    end?.mediaPositionMs,
    isPosition,
  );
  const span = { ...base, progressStart, progressEnd, mediaPositionStartMs, mediaPositionEndMs };
  return { ...head, modality: "Listening", span };
}

/** Emit the accrual's span, ended at `endMono` (never before it began), and restart or drop it. */
function close(key: string, accrual: Accrual, reopen: boolean, endMono: number): void {
  const closedAt = Math.max(accrual.startMono, Math.min(performance.now(), endMono));
  const elapsed = closedAt - accrual.startMono;
  const measurement = observers.get(accrual.observerKey)?.measurement;
  // Longer than a span may be means timers were suspended: that interval is not observed time.
  if (elapsed > SUSPENDED_AFTER_MS) {
    console.warn("consumption_capture_diagnostic", { kind: "suspended" });
  }
  if (elapsed <= SPAN_MAX_MS && Math.floor(elapsed) > 0) {
    void activityRuntime().enqueue(closedSpan(accrual, Math.floor(elapsed), measurement));
  }
  const restarted = { startMono: closedAt, startWall: Date.now(), startMeasurement: measurement };
  if (reopen) accruals.set(key, { ...accrual, ...restarted });
  else accruals.delete(key);
}

/** Bring one group's accrual in line with its eligible observers. */
function sync(key: string): void {
  const now = performance.now();
  const eligible = [...observers].filter(
    ([, observer]) =>
      groupOf(observer) === key &&
      captureReady &&
      observer.eligible &&
      (observer.idleUntilMono === undefined || observer.idleUntilMono > now),
  );
  const active = accruals.get(key);
  if (eligible.length > 1) {
    if (active) close(key, active, false, now);
    if (!ambiguous.has(key)) {
      console.warn("consumption_capture_diagnostic", { kind: "duplicate-observer" });
    }
    ambiguous.add(key);
    return;
  }
  ambiguous.delete(key);
  if (eligible.length === 0) {
    const deadline = active && observers.get(active.observerKey)?.idleUntilMono;
    if (active) {
      close(key, active, false, deadline !== undefined && deadline <= now ? deadline : now);
    }
    return;
  }
  const [[observerKey, lane]] = eligible;
  if (active?.observerKey !== observerKey || active?.lane.deviceClass !== lane.deviceClass) {
    if (active) close(key, active, false, now);
  }
  if (!accruals.has(key)) {
    const start = { startMono: now, startWall: Date.now(), startMeasurement: lane.measurement };
    accruals.set(key, { observerKey, lane, ...start });
  }
}

function syncAll(): void {
  const keys = new Set([...[...observers.values()].map(groupOf), ...accruals.keys()]);
  for (const key of keys) sync(key);
}

/** Wake at the earliest checkpoint (10 s after an accrual began, however often observers
 * report) or idle deadline, and report whether anything accrues. */
function settle(): void {
  window.clearTimeout(timer);
  if (captureReady || accruals.size > 0) {
    const now = performance.now();
    let delay = CHECKPOINT_MS;
    for (const accrual of accruals.values()) {
      const idle = observers.get(accrual.observerKey)?.idleUntilMono ?? Infinity;
      delay = Math.min(delay, accrual.startMono + CHECKPOINT_MS - now, idle - now);
    }
    timer = window.setTimeout(() => {
      syncAll();
      const now = performance.now();
      for (const [key, accrual] of accruals) close(key, accrual, true, now);
      settle();
    }, Math.max(0, delay));
  }
  if (recording !== accruals.size > 0) {
    recording = accruals.size > 0;
    activityRuntime().setRecording(recording);
  }
}

const recorder = {
  /** Add an observer; removing it closes its span with its last measurement. */
  registerObserver(key: string, observation: ActivityObservation): () => void {
    if (observers.has(key)) throw new Error(`Duplicate activity observer registration: ${key}`);
    observers.set(key, observation);
    sync(groupOf(observation));
    settle();
    return () => {
      const last = observers.get(key);
      if (last === undefined) return;
      observers.set(key, { ...last, eligible: false });
      sync(groupOf(last));
      observers.delete(key);
      settle();
    };
  },
  observe(key: string, observation: ActivityObservation): void {
    const previous = observers.get(key);
    if (previous === undefined) throw new Error(`Unknown activity observer: ${key}`);
    if (groupOf(previous) !== groupOf(observation)) {
      throw new Error("Activity observer media and modality are immutable");
    }
    observers.set(key, observation);
    sync(groupOf(observation));
    settle();
  },
  setCaptureReady(ready: boolean): void {
    if (ready === captureReady) return;
    captureReady = ready;
    syncAll();
    settle();
  },
  /** Close every span and stop capture until the shell reports readiness again. */
  closeForLifecycle(): void {
    captureReady = false;
    const now = performance.now();
    for (const [key, accrual] of accruals) close(key, accrual, false, now);
    settle();
  },
};

export function activityRecorder(): typeof recorder {
  return recorder;
}
