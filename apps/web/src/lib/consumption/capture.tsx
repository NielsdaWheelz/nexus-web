"use client";

/**
 * The tab's activity capture: observers report eligibility, closed spans queue in memory and
 * upload in batches. Each (media, modality) group accrues at most one span at a time, from its
 * single eligible observer; two eligible observers of one group record nothing (ambiguous). A
 * span closes at every 10 s checkpoint, on ineligibility (at the idle deadline once passed), on a
 * change of observer or device class, and when the page goes. Listening counts in a hidden tab;
 * Reading and Viewing need sight. Network, 408, 429 and 5xx failures retry with backoff; other
 * refusals drop their batch. A tab closed offline loses what it held (accepted).
 */

import { remoteReady, subscribeAdmission } from "@/lib/native/admission";
import { useEffect } from "react";
import { apiFetch, isApiError } from "@/lib/api/client";
import type { Schema } from "@/lib/api/wire";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { useViewportState } from "@/lib/renderEnvironment/provider";

export type ActivityModality = "Reading" | "Listening" | "Viewing";
export interface ActivityMeasurement {
  progress?: number;
  wordPosition?: number;
  mediaPositionMs?: number;
}
export interface ActivityObservation {
  eligible: boolean;
  deviceClass: "Desktop" | "Mobile";
  /** Monotonic deadline set by the reader's last genuine input. */
  idleUntilMono?: number;
  measurement?: ActivityMeasurement;
}
export interface ActivityObserver {
  observe(observation: ActivityObservation): void;
  /** Closes its span with its last measurement. */
  close(): void;
}
type Request = Schema<"ActivityRecordIn">;
type Span = Request["batch"]["spans"][number];
interface Observer {
  group: string;
  mediaId: string;
  modality: ActivityModality;
  current: ActivityObservation;
}
interface Accrual {
  observer: Observer;
  deviceClass: ActivityObservation["deviceClass"];
  startMono: number;
  startWall: number;
  start: ActivityMeasurement | undefined;
}

const SPAN_MAX_MS = 30_000;
const CHECKPOINT_MS = 10_000;
const BATCH_SPANS = 120;
const BATCH_BYTES = 40_000;
const KEEPALIVE_BYTES = 60_000; // browsers cap keepalive bodies in flight at 64 KiB
const RETRY_MS = [2_000, 5_000, 15_000, 60_000];
const PATH = "/api/consumption/activity";

const observers = new Set<Observer>();
const accruals = new Map<string, Accrual>();
let ready = false;
let checkpoint: number | undefined;
let queue: {
  lane: string;
  request: Omit<Request, "batch"> & { modality: ActivityModality };
  span: Span;
}[] = [];
let sending = false;
let attempt = 0;
let upload: ReturnType<typeof setTimeout> | undefined;

const valid = (value: number | undefined, max: number) =>
  value !== undefined && Number.isFinite(value) && value >= 0 && value <= max
    ? value
    : null;
/** A measurement pair, kept only when both ends are valid. */
function pair(start: number | undefined, end: number | undefined, max: number) {
  const [a, b] = [valid(start, max), valid(end, max)];
  return a === null || b === null ? [null, null] : [a, b];
}

function emit(
  accrual: Accrual,
  durationMs: number,
  end: ActivityMeasurement | undefined,
): void {
  const { observer, start } = accrual;
  const span: Record<string, unknown> = {
    capture_key: crypto.randomUUID(),
    occurred_at: new Date(accrual.startWall).toISOString(),
    duration_ms: durationMs,
  };
  if (observer.modality !== "Viewing")
    [span.progress_start, span.progress_end] = pair(
      start?.progress,
      end?.progress,
      1,
    );
  if (observer.modality === "Reading")
    [span.word_start, span.word_end] = pair(
      start?.wordPosition,
      end?.wordPosition,
      Number.MAX_SAFE_INTEGER,
    );
  if (observer.modality === "Listening")
    [span.media_position_start_ms, span.media_position_end_ms] = pair(
      start?.mediaPositionMs,
      end?.mediaPositionMs,
      Number.MAX_SAFE_INTEGER,
    );
  const request = {
    media_id: observer.mediaId,
    device_class: accrual.deviceClass,
    modality: observer.modality,
  };
  queue.push({ lane: JSON.stringify(request), request, span: span as Span });
  if (attempt === 0) schedule(2_000);
}

/** Emit the accrual's span ended at `endMono` and restart (`reopen`) or drop it. A span longer
 * than the cap means suspended timers: not observed time, dropped. */
function close(
  group: string,
  accrual: Accrual,
  reopen: boolean,
  endMono: number,
): void {
  const closedAt = Math.max(
    accrual.startMono,
    Math.min(performance.now(), endMono),
  );
  const elapsed = Math.floor(closedAt - accrual.startMono);
  const measurement = accrual.observer.current.measurement;
  if (elapsed > 0 && elapsed <= SPAN_MAX_MS)
    emit(accrual, elapsed, measurement);
  if (reopen)
    accruals.set(group, {
      ...accrual,
      startMono: closedAt,
      startWall: Date.now(),
      start: measurement,
    });
  else accruals.delete(group);
}

/** Bring one group's accrual in line with its eligible observers. */
function sync(group: string): void {
  const now = performance.now();
  const eligible = [...observers].filter(
    ({ group: g, modality, current }) =>
      g === group &&
      ready &&
      current.eligible &&
      (modality === "Listening" || document.visibilityState === "visible") &&
      (current.idleUntilMono === undefined || current.idleUntilMono > now),
  );
  const active = accruals.get(group);
  const deadline = active?.observer.current.idleUntilMono;
  if (eligible.length !== 1) {
    if (active)
      close(
        group,
        active,
        false,
        deadline !== undefined && deadline <= now ? deadline : now,
      );
    return;
  }
  const [observer] = eligible;
  if (
    active &&
    (active.observer !== observer ||
      active.deviceClass !== observer.current.deviceClass)
  )
    close(group, active, false, now);
  if (!accruals.has(group))
    accruals.set(group, {
      observer,
      deviceClass: observer.current.deviceClass,
      startMono: now,
      startWall: Date.now(),
      start: observer.current.measurement,
    });
}

/** Re-sync every group and wake at the earliest checkpoint or idle deadline. */
function settle(): void {
  for (const group of new Set([
    ...[...observers].map((o) => o.group),
    ...accruals.keys(),
  ]))
    sync(group);
  window.clearTimeout(checkpoint);
  if (!ready && accruals.size === 0) return;
  const now = performance.now();
  let delay = CHECKPOINT_MS;
  for (const accrual of accruals.values())
    delay = Math.min(
      delay,
      accrual.startMono + CHECKPOINT_MS - now,
      (accrual.observer.current.idleUntilMono ?? Infinity) - now,
    );
  checkpoint = window.setTimeout(
    () => {
      for (const group of accruals.keys()) sync(group);
      for (const [group, accrual] of accruals)
        close(group, accrual, true, performance.now());
      settle();
    },
    Math.max(0, delay),
  );
}

/** Observe one media in one modality; the handle is the observer's identity. */
export function registerActivityObserver(
  mediaId: string,
  modality: ActivityModality,
  observation: ActivityObservation,
): ActivityObserver {
  const observer: Observer = {
    group: `${mediaId}\u0000${modality}`,
    mediaId,
    modality,
    current: observation,
  };
  observers.add(observer);
  settle();
  return {
    observe(next) {
      observer.current = next;
      settle();
    },
    close() {
      observer.current = { ...observer.current, eligible: false };
      sync(observer.group);
      observers.delete(observer);
      settle();
    },
  };
}

/** The oldest lane's next batch, off the queue. */
function take(): Request | null {
  const lane = queue[0]?.lane;
  if (lane === undefined) return null;
  const spans = queue
    .filter((entry) => entry.lane === lane)
    .sort(
      (a, b) => Date.parse(a.span.occurred_at) - Date.parse(b.span.occurred_at),
    )
    .slice(0, BATCH_SPANS);
  while (spans.length > 1 && JSON.stringify(spans).length > BATCH_BYTES)
    spans.pop();
  queue = queue.filter((entry) => !spans.includes(entry));
  const { modality, ...head } = spans[0].request;
  return {
    ...head,
    batch: { modality, spans: spans.map((entry) => entry.span) },
  } as Request;
}

async function send(): Promise<void> {
  if (sending || !remoteReady()) return;
  sending = true;
  try {
    for (let request = take(); request !== null; request = take()) {
      try {
        await apiFetch<void>(PATH, {
          method: "POST",
          body: JSON.stringify(request),
        });
        attempt = 0;
      } catch (error) {
        const signingIn = handleUnauthenticatedApiError(error);
        const status = isApiError(error) ? error.status : 0;
        if (signingIn || status === 0 || status === 408 || status === 429 || status >= 500) {
          const { modality } = request.batch;
          const head = {
            media_id: request.media_id,
            device_class: request.device_class,
            modality,
          };
          queue.push(
            ...request.batch.spans.map((span) => ({
              lane: JSON.stringify(head),
              request: head,
              span,
            })),
          );
          schedule(RETRY_MS[Math.min(attempt++, RETRY_MS.length - 1)]);
          return;
        }
        console.warn("activity_batch_refused", {
          status,
          spans: request.batch.spans.length,
        });
      }
    }
  } finally {
    sending = false;
  }
}

function schedule(delayMs: number): void {
  clearTimeout(upload);
  upload = setTimeout(() => void send(), delayMs);
}

/** Close every span and hand what fits in the keepalive budget to the browser. */
function leave(): void {
  ready = false;
  for (const [group, accrual] of accruals)
    close(group, accrual, false, performance.now());
  settle();
  if (!remoteReady()) return;
  let budget = KEEPALIVE_BYTES;
  for (let request = take(); request !== null; request = take()) {
    const body = JSON.stringify(request);
    if ((budget -= body.length) < 0) break;
    void apiFetch<void>(PATH, { method: "POST", keepalive: true, body }).catch(
      () => undefined,
    );
  }
}

/** Mounted once by the shell: capture runs once the viewport is hydrated. */
export function ActivityCapture(): null {
  const hydrated = useViewportState().hydrated;
  useEffect(() => {
    ready = hydrated && remoteReady();
    settle();
    if (!hydrated) return;
    const resume = () => {
      ready = remoteReady();
      settle();
    };
    const online = () => { if (remoteReady()) schedule(0); };
    const unsubscribe = subscribeAdmission(() => { resume(); if (remoteReady()) schedule(0); });
    document.addEventListener("visibilitychange", settle);
    window.addEventListener("pagehide", leave);
    window.addEventListener("pageshow", resume);
    window.addEventListener("online", online);
    return () => {
      unsubscribe();
      document.removeEventListener("visibilitychange", settle);
      window.removeEventListener("pagehide", leave);
      window.removeEventListener("pageshow", resume);
      window.removeEventListener("online", online);
      leave();
    };
  }, [hydrated]);
  return null;
}
