/**
 * One media's caller-driven listening persistence. PUTs single-flight and
 * coalesce to the newest dirty sample. Modeled failures refresh the native
 * revision/reset fences through GET; defects stop this engine and reach its
 * observer. Playback cadence and physical playback belong to the caller.
 */
import {
  ApiError,
  apiFetch,
  apiKeepaliveJson,
  isApiError,
  type ApiPath,
} from "@/lib/api/client";
import type { Presence } from "@/lib/api/presence";
import type { ApiJson, Schema } from "@/lib/api/wire";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { publishConsumptionProjectionChange } from "@/lib/consumption/projectionRevision";
import type { ListeningStateOut, MediaId } from "@/lib/lectern/contract";
import type { OverlayEntry } from "@/lib/player/playerSession";

export const HEARTBEAT_DEADLINE_MS = 20_000;
export const SYNC_INTERVAL_MS = 15_000;

export interface HeartbeatSample {
  positionMs: number;
  durationMs: Presence<number>;
  episodePlaybackRate: Presence<number>;
}

export interface ListeningHeartbeatConfig {
  mediaId: MediaId;
  initial: { writeRevision: number; resetEpoch: number; positionMs: number };
  readSample: () => HeartbeatSample;
  mintGeneration: () => string;
  onStateAdopted: (state: ListeningStateOut, options: { seek: boolean }) => void;
  onPersistenceSuspended: (error: ApiError, retryGet: () => void) => void;
  onPersistenceResumed: () => void;
  onOverlayUpdate: (entry: OverlayEntry) => void;
  /** Nonthrowing observer of one terminal defect, including partial effects. */
  onDefect: (error: unknown) => void;
}

export interface ListeningHeartbeat {
  tick: () => void;
  /** Wait for the captured PUT only, up to the caller's deadline, then stop. */
  drainAndStop: (deadlineMs: number) => Promise<void>;
  /** Best-effort write with no installation, publication, or recovery. */
  flushKeepalive: () => void;
  /** Abort PUT; an outstanding GET finishes with its result ignored. */
  stop: () => void;
}

type HeartbeatBody = Schema<"ListeningHeartbeatIn">;
type HeartbeatResult = ApiJson<"/media/{media_id}/listening-state", "put">["data"];
type Status = "Active" | "Recovering" | "Suspended" | "Stopped";
type DirtySample = { version: number; sample: HeartbeatSample };
type PendingPut = {
  generation: string;
  sequence: number;
  dirtyVersion: number;
  controller: AbortController;
  settled: Promise<void>;
};

function isModeledFailure(error: unknown): error is ApiError {
  if (!isApiError(error)) return false;
  switch (error.code) {
    case "E_NETWORK":
      return error.status === 0;
    case "E_STALE_LISTENING_REVISION":
      return error.status === 409;
    case "E_MEDIA_NOT_FOUND":
      return error.status === 404;
    case "E_UNAUTHENTICATED":
      return error.status === 401;
    case "E_UPSTREAM":
      return error.status === 502;
    case "E_UPSTREAM_TIMEOUT":
      return error.status === 504;
    case "E_AUTH_UNAVAILABLE":
      return error.status === 503;
    default:
      return false;
  }
}

export function createListeningHeartbeat(
  config: ListeningHeartbeatConfig,
): ListeningHeartbeat {
  const path: ApiPath = `/api/media/${config.mediaId}/listening-state`;
  let status: Status = "Active";
  let writeRevision = config.initial.writeRevision;
  let resetEpoch = config.initial.resetEpoch;
  let generation = config.mintGeneration();
  let sequence = 0;
  let version = 0;
  let dirty: DirtySample | undefined;
  let pending: PendingPut | undefined;

  function body(sample: HeartbeatSample, seq: number): HeartbeatBody {
    return {
      positionMs: sample.positionMs,
      durationMs: sample.durationMs,
      episodePlaybackRate: sample.episodePlaybackRate,
      expectedWriteRevision: writeRevision,
      expectedResetEpoch: resetEpoch,
      heartbeatGeneration: generation,
      heartbeatSequence: seq,
    };
  }

  async function request<T>(
    method: "GET" | "PUT",
    controller: AbortController,
    payload?: HeartbeatBody,
  ): Promise<T> {
    const deadline = new DOMException(
      method === "GET" ? "Heartbeat GET deadline exceeded" : "Heartbeat deadline exceeded",
      "TimeoutError",
    );
    const timer = setTimeout(() => {
      controller.abort(deadline);
    }, HEARTBEAT_DEADLINE_MS);
    try {
      return await apiFetch<T>(path, {
        method,
        signal: controller.signal,
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
      });
    } catch (error) {
      // This owner knows its deadline even when an aborted response-body read
      // reaches the API parser as an AbortError or invalid JSON response.
      if (controller.signal.aborted && controller.signal.reason === deadline) {
        throw new ApiError(0, "E_NETWORK", "Network request failed");
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  function stop(): void {
    status = "Stopped";
    dirty = undefined;
    const current = pending;
    pending = undefined;
    current?.controller.abort(new DOMException("Heartbeat engine stopped", "AbortError"));
  }

  function reportDefect(error: unknown): void {
    if (status === "Stopped") return;
    // justify-defect: unexpected request failures and installation/callback
    // failures cannot establish persistence. Observe them without pretending
    // earlier callback effects can be undone or the write did not commit.
    stop();
    config.onDefect(error);
  }

  function sendDirty(): void {
    if (status !== "Active" || pending !== undefined || dirty === undefined) {
      return;
    }
    const record: PendingPut = {
      generation,
      sequence: sequence++,
      dirtyVersion: dirty.version,
      controller: new AbortController(),
      settled: Promise.resolve(),
    };
    const payload = body(dirty.sample, record.sequence);
    pending = record;
    record.settled = send(record, payload).catch(reportDefect);
  }

  async function send(record: PendingPut, payload: HeartbeatBody): Promise<void> {
    let result: HeartbeatResult;
    try {
      result = (await request<ApiJson<"/media/{media_id}/listening-state", "put">>(
        "PUT",
        record.controller,
        payload,
      )).data;
    } catch (error) {
      if (pending === record) pending = undefined;
      if (status === "Stopped") return;
      if (record.generation !== generation) {
        sendDirty();
        return;
      }
      if (!isModeledFailure(error)) throw error;
      status = "Recovering";
      // Recovery is deliberately outside this PUT's settlement/drain promise.
      void recover(false).catch(reportDefect);
      return;
    }
    if (pending === record) pending = undefined;
    if (status === "Stopped") return;
    if (record.generation !== generation) {
      sendDirty();
      return;
    }
    // justify-defect: the native service must echo this exact write identity.
    if (
      result.heartbeatGeneration !== record.generation ||
      result.heartbeatSequence !== record.sequence
    ) {
      throw new Error("Heartbeat response generation/sequence echo mismatch (defect).");
    }
    writeRevision = result.listeningState.writeRevision;
    resetEpoch = result.listeningState.resetEpoch;
    config.onOverlayUpdate({
      positionMs: result.listeningState.positionMs,
      writeRevision,
      resetEpoch,
    });
    publishConsumptionProjectionChange();
    if (dirty?.version === record.dirtyVersion) dirty = undefined;
    sendDirty();
  }

  async function recover(fromSuspended: boolean): Promise<void> {
    let state: ListeningStateOut;
    try {
      state = (await request<ApiJson<"/media/{media_id}/listening-state", "get">>(
        "GET",
        new AbortController(),
      )).data;
    } catch (error) {
      if (status === "Stopped") return;
      if (!isModeledFailure(error)) throw error;
      status = "Suspended";
      // Preserve PUT401 -> GET401 -> the existing redirect owner -> suspension.
      handleUnauthenticatedApiError(error);
      config.onPersistenceSuspended(error, retryGet);
      return;
    }
    if (status === "Stopped") return;
    if (state.resetEpoch !== resetEpoch) {
      dirty = undefined;
      config.onStateAdopted(state, { seek: true });
      config.onOverlayUpdate({
        positionMs: state.positionMs,
        writeRevision: state.writeRevision,
        resetEpoch: state.resetEpoch,
      });
    } else {
      // justify-service-invariant-check: only a failed PUT starts recovery;
      // its sample remains dirty through GET failures and same-epoch retries.
      if (dirty === undefined) {
        throw new Error("Heartbeat recovery lost its dirty sample (defect).");
      }
      config.onOverlayUpdate({
        positionMs: dirty.sample.positionMs,
        writeRevision: state.writeRevision,
        resetEpoch: state.resetEpoch,
      });
    }
    writeRevision = state.writeRevision;
    resetEpoch = state.resetEpoch;
    generation = config.mintGeneration();
    sequence = 0;
    status = "Active";
    sendDirty();
    if (fromSuspended) config.onPersistenceResumed();
  }

  function retryGet(): void {
    if (status !== "Suspended") return;
    status = "Recovering";
    void recover(true).catch(reportDefect);
  }

  function tick(): void {
    if (status === "Stopped") return;
    const sample = config.readSample();
    if (sample.episodePlaybackRate.kind === "Absent") return;
    dirty = { version: ++version, sample };
    sendDirty();
  }

  async function drainAndStop(deadlineMs: number): Promise<void> {
    const captured = pending;
    if (captured !== undefined) {
      await new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(finish, deadlineMs);
        void captured.settled.then(finish, finish);
      });
    }
    stop();
  }

  function flushKeepalive(): void {
    if (status === "Stopped") return;
    const sample = config.readSample();
    if (sample.episodePlaybackRate.kind === "Absent") return;
    void apiKeepaliveJson(path, body(sample, sequence++)).catch(() => {
      // justify-ignore-error: this best-effort retirement/unload write has no
      // installation or retry path; its response cannot change local truth.
    });
  }

  return { tick, drainAndStop, flushKeepalive, stop };
}
