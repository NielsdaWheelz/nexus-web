/**
 * Listening heartbeat engine (spec
 * `docs/cutovers/lectern-player-lifecycle-hard-cutover.md` §5.4 + §6).
 *
 * A framework-free position/dwell heartbeat for ONE media. It runs at most one
 * in-flight PUT, coalesces later samples to the newest, keys installs by an
 * injected generation + a per-send sequence, and fences every write on the
 * server's `writeRevision`/`resetEpoch`. Timeout, network failure, and a stale
 * `E_STALE_LISTENING_REVISION` (409) never block playback: the engine retires
 * the generation, discards the ambiguous dwell (at-most-once), and re-syncs via
 * GET. A failed GET suspends persistence (playback continues) until a GET-only
 * retry succeeds.
 *
 * Cadence is caller-driven: the provider calls {@link ListeningHeartbeat.tick}
 * on the {@link SYNC_INTERVAL_MS} interval (and on pause / before a track
 * switch), so tests and the provider fully control timing. The engine owns only
 * the per-request {@link HEARTBEAT_DEADLINE_MS} deadline.
 */

import { ApiError, apiFetch, apiKeepaliveJson, isApiError, type ApiPath } from "@/lib/api/client";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import type { Presence } from "@/lib/api/presence";
import { decodeListeningState, type ListeningStateOut, type MediaId } from "@/lib/lectern/client";
import type { OverlayEntry } from "@/lib/player/playerSession";
import { isRecord } from "@/lib/validation";

/** Per-request browser deadline; a slow PUT/GET is aborted and treated as an
 * ambiguous outcome (spec §5.4 "named 20-second browser deadline"). */
export const HEARTBEAT_DEADLINE_MS = 20_000;

/** Caller-driven cadence: the provider ticks the engine at this interval while
 * playing (spec §5.4). The engine does NOT own a timer for it. */
export const SYNC_INTERVAL_MS = 15_000;

/** Dwell delta is capped so a single heartbeat can never over-report listening
 * time (wire bound `dwellMsDelta: int[0..17000]`). */
const MAX_DWELL_MS = 17_000;

/** The live playback reading the provider exposes to the engine at send time. */
export interface HeartbeatSample {
  positionMs: number;
  durationMs: Presence<number>;
  playbackSpeed: number;
}

export interface ListeningHeartbeatConfig {
  mediaId: MediaId;
  deviceId: string;
  initial: { writeRevision: number; resetEpoch: number; positionMs: number };
  /** Read the newest live sample. Must return integer millisecond positions. */
  readSample: () => HeartbeatSample;
  /** Wall clock in ms (injected for deterministic dwell in tests). */
  now: () => number;
  /** Mint a fresh generation UUID per engine start / recovery / adopt. */
  mintGeneration: () => string;
  /** Adopt a full canonical state; `seek` requests moving playback to it. */
  onStateAdopted: (state: ListeningStateOut, options: { seek: boolean }) => void;
  /** GET re-sync failed: persistence is suspended until `retryGet` succeeds. */
  onPersistenceSuspended: (error: ApiError, retryGet: () => void) => void;
  /** A suspended engine's GET-only retry succeeded. */
  onPersistenceResumed: () => void;
  /** Update the provider-lifetime resume overlay for this media. */
  onOverlayUpdate: (entry: OverlayEntry) => void;
}

export interface ListeningHeartbeat {
  /** Attempt a send now (cadence tick / pause / switch). Coalesces to the newest
   * sample when a PUT is already in flight or a recovery is running. */
  tick: () => void;
  /** Await the in-flight PUT up to `deadlineMs`, then stop (pre-Unread drain). */
  drainAndStop: (deadlineMs: number) => Promise<void>;
  /** Adopt the Unread command's returned state: replace the overlay, seek, and
   * start a fresh generation. Revives a drained engine. */
  adoptServerState: (state: ListeningStateOut) => void;
  /** Best-effort fire-and-forget keepalive PUT for `beforeunload` (no install). */
  flushKeepalive: () => void;
  /** Terminal teardown: abort any in-flight request and send no more. */
  stop: () => void;
}

// --- Wire shapes -------------------------------------------------------------

interface ListeningHeartbeatIn {
  positionMs: number;
  durationMs: Presence<number>;
  playbackSpeed: number;
  dwellMsDelta: number;
  deviceId: string;
  expectedWriteRevision: number;
  expectedResetEpoch: number;
  heartbeatGeneration: string;
  heartbeatSequence: number;
}

interface HeartbeatResult {
  listeningState: ListeningStateOut;
  heartbeatGeneration: string;
  heartbeatSequence: number;
}

// --- Strict decoders (same-system: any shape violation is a defect) ---------

function asRecord(raw: unknown, ctx: string): Record<string, unknown> {
  if (!isRecord(raw)) {
    throw new Error(`Invalid ${ctx}: expected an object, got ${raw === null ? "null" : typeof raw}`);
  }
  return raw;
}

function exactKeys(rec: Record<string, unknown>, expected: readonly string[], ctx: string): void {
  const keys = Object.keys(rec);
  if (keys.length !== expected.length || !expected.every((key) => key in rec)) {
    throw new Error(`Invalid ${ctx}: expected keys [${expected.join(", ")}], got [${keys.join(", ")}]`);
  }
}

function asString(raw: unknown, ctx: string): string {
  if (typeof raw !== "string") throw new Error(`Invalid ${ctx}: expected a string, got ${typeof raw}`);
  return raw;
}

function asInt(raw: unknown, ctx: string): number {
  if (typeof raw !== "number" || !Number.isInteger(raw)) {
    throw new Error(`Invalid ${ctx}: expected an integer, got ${JSON.stringify(raw)}`);
  }
  return raw;
}

function unwrapDataEnvelope(raw: unknown, ctx: string): unknown {
  const rec = asRecord(raw, ctx);
  exactKeys(rec, ["data"], ctx);
  return rec.data;
}

function decodeListeningStateEnvelope(raw: unknown): ListeningStateOut {
  return decodeListeningState(unwrapDataEnvelope(raw, "GET /api/media/{mediaId}/listening-state"));
}

function decodeHeartbeatResult(raw: unknown): HeartbeatResult {
  const data = asRecord(
    unwrapDataEnvelope(raw, "PUT /api/media/{mediaId}/listening-state"),
    "ListeningHeartbeatResult",
  );
  exactKeys(data, ["listeningState", "heartbeatGeneration", "heartbeatSequence"], "ListeningHeartbeatResult");
  return {
    listeningState: decodeListeningState(data.listeningState),
    heartbeatGeneration: asString(data.heartbeatGeneration, "ListeningHeartbeatResult.heartbeatGeneration"),
    heartbeatSequence: asInt(data.heartbeatSequence, "ListeningHeartbeatResult.heartbeatSequence"),
  };
}

function toApiError(error: unknown): ApiError {
  // Classify unauthenticated failures to the login-redirect owner. A 401 PUT
  // recovers via GET, which also 401s and funnels here before suspension.
  handleUnauthenticatedApiError(error);
  if (isApiError(error)) return error;
  return new ApiError(
    0,
    "E_HEARTBEAT_GET_FAILED",
    error instanceof Error ? error.message : "Heartbeat GET failed",
  );
}

// --- Engine ------------------------------------------------------------------

type EngineStatus = "Active" | "Recovering" | "Suspended" | "Stopped";

interface InFlight {
  generation: string;
  sequence: number;
  controller: AbortController;
  settled: Promise<void>;
}

export function createListeningHeartbeat(config: ListeningHeartbeatConfig): ListeningHeartbeat {
  const {
    deviceId,
    readSample,
    now,
    mintGeneration,
    onStateAdopted,
    onPersistenceSuspended,
    onPersistenceResumed,
    onOverlayUpdate,
  } = config;
  const listeningPath: ApiPath = `/api/media/${config.mediaId}/listening-state`;

  let status: EngineStatus = "Active";
  let expectedWriteRevision = config.initial.writeRevision;
  let expectedResetEpoch = config.initial.resetEpoch;
  let lastKnownPositionMs = config.initial.positionMs;
  let generation = mintGeneration();
  let sequence = 0;
  let dwellAnchorMs = now();
  let inFlight: InFlight | undefined;
  let resendQueued = false;

  function clampDwell(deltaMs: number): number {
    if (deltaMs <= 0) return 0;
    if (deltaMs >= MAX_DWELL_MS) return MAX_DWELL_MS;
    return Math.round(deltaMs);
  }

  function buildBody(sample: HeartbeatSample, seq: number, dwellMsDelta: number): ListeningHeartbeatIn {
    return {
      positionMs: sample.positionMs,
      durationMs: sample.durationMs,
      playbackSpeed: sample.playbackSpeed,
      dwellMsDelta,
      deviceId,
      expectedWriteRevision,
      expectedResetEpoch,
      heartbeatGeneration: generation,
      heartbeatSequence: seq,
    };
  }

  function installState(state: ListeningStateOut): void {
    expectedWriteRevision = state.writeRevision;
    expectedResetEpoch = state.resetEpoch;
    lastKnownPositionMs = state.positionMs;
    onOverlayUpdate({
      positionMs: state.positionMs,
      writeRevision: state.writeRevision,
      resetEpoch: state.resetEpoch,
    });
  }

  function maybeResend(): void {
    if (status !== "Active" || inFlight !== undefined || !resendQueued) return;
    resendQueued = false;
    performSend();
  }

  function handleResponse(record: InFlight, result: HeartbeatResult): void {
    if (inFlight === record) inFlight = undefined;
    if (status === "Stopped") return;
    if (record.generation !== generation) {
      // The generation was retired (adopt / recovery) while this PUT was in
      // flight: ignore its install, but honor a coalesced resend under the
      // current generation (spec §5.4 "install ... only when generation +
      // sequence still match").
      maybeResend();
      return;
    }
    if (
      result.heartbeatGeneration !== record.generation ||
      result.heartbeatSequence !== record.sequence
    ) {
      // justify-defect: a same-system server MUST echo the exact generation +
      // sequence it was sent; a mismatch is a backend/schema defect.
      throw new Error("Heartbeat response generation/sequence echo mismatch (defect).");
    }
    installState(result.listeningState);
    maybeResend();
  }

  function handleFailure(record: InFlight, _error: unknown): void {
    if (inFlight === record) inFlight = undefined;
    if (status === "Stopped") return;
    if (record.generation !== generation) {
      maybeResend();
      return;
    }
    // Timeout, network failure, and stale-revision (409) all re-sync via GET.
    // The dwell for this send is already discarded because the anchor advanced
    // at send time, so at-most-once holds (spec §5.4).
    status = "Recovering";
    void recover({ fromSuspended: false });
  }

  function performSend(): void {
    const sample = readSample();
    lastKnownPositionMs = sample.positionMs;
    const at = now();
    const dwellMsDelta = clampDwell(at - dwellAnchorMs);
    dwellAnchorMs = at;
    const seq = sequence;
    sequence += 1;
    const body = buildBody(sample, seq, dwellMsDelta);
    const controller = new AbortController();
    const record: InFlight = { generation, sequence: seq, controller, settled: Promise.resolve() };
    inFlight = record;
    record.settled = runSend(record, body, controller);
  }

  async function runSend(record: InFlight, body: ListeningHeartbeatIn, controller: AbortController): Promise<void> {
    const timer = setTimeout(() => {
      controller.abort(new DOMException("Heartbeat deadline exceeded", "TimeoutError"));
    }, HEARTBEAT_DEADLINE_MS);
    try {
      const raw = await apiFetch<unknown>(listeningPath, {
        method: "PUT",
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(timer);
      handleResponse(record, decodeHeartbeatResult(raw));
    } catch (error) {
      clearTimeout(timer);
      handleFailure(record, error);
    }
  }

  async function recover(options: { fromSuspended: boolean }): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort(new DOMException("Heartbeat GET deadline exceeded", "TimeoutError"));
    }, HEARTBEAT_DEADLINE_MS);
    let state: ListeningStateOut | undefined;
    let failure: unknown;
    try {
      const raw = await apiFetch<unknown>(listeningPath, { method: "GET", signal: controller.signal });
      state = decodeListeningStateEnvelope(raw);
    } catch (error) {
      failure = error;
    } finally {
      clearTimeout(timer);
    }
    if (status === "Stopped") return;
    if (state === undefined) {
      status = "Suspended";
      onPersistenceSuspended(toApiError(failure), retryGet);
      return;
    }
    if (state.resetEpoch !== expectedResetEpoch) {
      // Reset epoch advanced: discard old samples and adopt the canonical reset.
      onStateAdopted(state, { seek: true });
      lastKnownPositionMs = state.positionMs;
      onOverlayUpdate({
        positionMs: state.positionMs,
        writeRevision: state.writeRevision,
        resetEpoch: state.resetEpoch,
      });
    } else {
      // Same epoch: retain the newest local position; only refresh the fence.
      onOverlayUpdate({
        positionMs: lastKnownPositionMs,
        writeRevision: state.writeRevision,
        resetEpoch: state.resetEpoch,
      });
    }
    expectedWriteRevision = state.writeRevision;
    expectedResetEpoch = state.resetEpoch;
    generation = mintGeneration();
    sequence = 0;
    dwellAnchorMs = now();
    status = "Active";
    if (options.fromSuspended) onPersistenceResumed();
    maybeResend();
  }

  function retryGet(): void {
    if (status !== "Suspended") return;
    status = "Recovering";
    void recover({ fromSuspended: true });
  }

  function tick(): void {
    if (status === "Stopped" || status === "Suspended") return;
    if (status === "Recovering" || inFlight !== undefined) {
      resendQueued = true;
      return;
    }
    performSend();
  }

  function stop(): void {
    status = "Stopped";
    resendQueued = false;
    const current = inFlight;
    inFlight = undefined;
    if (current !== undefined) {
      current.controller.abort(new DOMException("Heartbeat engine stopped", "AbortError"));
    }
  }

  async function drainAndStop(deadlineMs: number): Promise<void> {
    const current = inFlight;
    if (current !== undefined) {
      await raceWithTimeout(current.settled, deadlineMs);
    }
    stop();
  }

  // Adopt the Unread command result: seek to the reset state, replace the
  // overlay, and start a new generation. A stale in-flight PUT under the old
  // generation is left to resolve and is ignored by the generation check.
  function adoptServerState(state: ListeningStateOut): void {
    expectedWriteRevision = state.writeRevision;
    expectedResetEpoch = state.resetEpoch;
    lastKnownPositionMs = state.positionMs;
    onStateAdopted(state, { seek: true });
    onOverlayUpdate({
      positionMs: state.positionMs,
      writeRevision: state.writeRevision,
      resetEpoch: state.resetEpoch,
    });
    generation = mintGeneration();
    sequence = 0;
    dwellAnchorMs = now();
    resendQueued = false;
    status = "Active";
  }

  function flushKeepalive(): void {
    if (status === "Stopped") return;
    const sample = readSample();
    const at = now();
    const body = buildBody(sample, sequence, clampDwell(at - dwellAnchorMs));
    sequence += 1;
    dwellAnchorMs = at;
    void apiKeepaliveJson(listeningPath, body).catch(() => {
      // justify-ignore-error: the beforeunload keepalive is best-effort; the page
      // is unloading and there is no install or retry path for its outcome.
    });
  }

  return { tick, drainAndStop, adoptServerState, flushKeepalive, stop };
}

function raceWithTimeout(promise: Promise<void>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    promise.then(finish, finish);
  });
}
