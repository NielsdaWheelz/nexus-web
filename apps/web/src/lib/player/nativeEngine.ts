"use client";

/**
 * The Android shell's audio engine: a thin client of the native service behind
 * `window.nexusPlayer`, which owns playback, listening writes, activity and natural ends.
 *
 * Frames are trusted json in the grammar of `window.nexusDownloads`: both ends ship in one release
 * train, and the object's name is the compatibility identity (its absence means an older app).
 *   request {id, op, ...args} -> reply {id, ok: true, snapshot?} | {id, ok: false, error}
 *   push    {snapshot} on every change and each second while playing
 * Session ops carry `key` and `expected_load_id`; the service checks the load at application.
 * A stale command has no effect. Replies cannot replace an intervening confirmed load.
 */

import {
  IDLE_ENGINE_STATE,
  PlaybackPreferenceError,
  type Engine,
  type EngineState,
} from "@/lib/player/playerRuntime";
import { publishChange } from "@/lib/api/changes";
import { ApiError } from "@/lib/api/client";

interface Port {
  postMessage(frame: string): void;
  onmessage: ((event: { readonly data: unknown }) => void) | null;
}

type NativeSnapshot = Omit<EngineState, "playbackSubject"> & { readonly load_id: string | null };
type Frame =
  | { readonly snapshot: NativeSnapshot }
  | { readonly id: number; readonly ok: true; readonly snapshot?: NativeSnapshot }
  | { readonly id: number; readonly ok: false; readonly error: string };

const port =
  typeof window === "undefined"
    ? undefined
    : (window as Window & { nexusPlayer?: Port }).nexusPlayer;

export const nativePlayerAvailable = port !== undefined;

const REPLY_TIMEOUT_MS = 5_000;
/** `load` replies after the outgoing episode's last write and the start of playback. */
const LOAD_TIMEOUT_MS = 20_000;
// The port survives engine/account replacement; late replies must never reuse a new call's id.
let nextId = 1;

/** `onResponding(false)` when a reply times out, `(true)` again on the next frame. */
export function createNativeEngine(
  accountId: string,
  onResponding: (responding: boolean) => void,
): Engine {
  if (port === undefined) throw new Error("window.nexusPlayer is unavailable");
  const listeners = new Set<() => void>();
  const pending = new Map<
    number,
    { resolve: () => void; reject: (error: Error) => void; publication: number }
  >();
  let state: EngineState = IDLE_ENGINE_STATE;
  let responding = true;
  let publication = 0;
  const respond = (value: boolean) => {
    if (responding === value) return;
    responding = value;
    onResponding(value);
  };

  const publish = ({ load_id, ...snapshot }: NativeSnapshot) => {
    publication += 1;
    if (snapshot.consumptionRevision !== state.consumptionRevision)
      publishChange("Consumption");
    // Keep the source's identity across position pushes, so session readers do not re-render.
    const same =
      JSON.stringify(snapshot.source) === JSON.stringify(state.source);
    state = { ...snapshot, source: same ? state.source : snapshot.source, playbackSubject: load_id };
    for (const listener of listeners) listener();
  };
  port.onmessage = (event) => {
    respond(true);
    const frame = JSON.parse(event.data as string) as Frame;
    if (!("id" in frame)) return publish(frame.snapshot);
    const waiting = pending.get(frame.id);
    if (waiting === undefined) return; // an expired reply cannot replace a newer pushed snapshot
    if (frame.ok && frame.snapshot &&
        (waiting.publication === publication || frame.snapshot.load_id === state.playbackSubject))
      publish(frame.snapshot);
    pending.delete(frame.id);
    if (frame.ok) waiting.resolve();
    else waiting.reject(new Error(frame.error));
  };

  const call = (
    op: string,
    args: Record<string, unknown> = {},
    options: { timeoutMs?: number } = {},
  ) => {
    const id = nextId++;
    return new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        pending.delete(id);
        respond(false);
        reject(new Error("NotResponding"));
      }, options.timeoutMs ?? REPLY_TIMEOUT_MS);
      pending.set(id, {
        publication,
        resolve: () => {
          window.clearTimeout(timer);
          resolve();
        },
        reject: (error) => {
          window.clearTimeout(timer);
          reject(error);
        },
      });
      port.postMessage(JSON.stringify({ ...args, id, op }));
    });
  };
  /** Capture the loaded occurrence; a retired command is silently ignored by the service. */
  const send = (op: string, args: Record<string, unknown> = {}) =>
    void call(op, args).catch((error: Error) => {
      if (error.message !== "NotResponding" && error.message !== "Stale")
        console.warn("native_player_op_rejected", { op, error: error.message });
    });
  const key = () => {
    const source = state.source;
    return source === null
      ? null
      : source.kind === "Episode"
        ? source.descriptor.media_id
        : source.descriptor.target;
  };
  const keyed = (op: string, args: Record<string, unknown> = {}) => {
    const loaded = key();
    const subject = state.playbackSubject;
    if (loaded !== null && subject !== null && responding)
      send(op, { ...args, key: loaded, expected_load_id: subject });
  };
  const preference = async (op: string, args: Record<string, unknown>) => {
    const loaded = key();
    const subject = state.playbackSubject;
    if (loaded === null || subject === null)
      throw new PlaybackPreferenceError("playback source changed. try again.");
    if (!responding)
      throw new PlaybackPreferenceError("the native player is not responding. try again.");
    try {
      await call(op, { ...args, key: loaded, expected_load_id: subject });
    } catch (error) {
      if (error instanceof Error) {
        if (error.message === "Stale")
          throw new PlaybackPreferenceError("playback source changed. try again.");
        if (error.message === "NotResponding" || error.message === "NotConnected" || error.message === "Unavailable")
          throw new PlaybackPreferenceError("the native player is not responding. try again.");
      }
      throw error;
    }
  };

  void call("hello", { accountId }).catch(() => undefined);

  return {
    supportsSilenceSkipping: true,
    state: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    load: (descriptor) => call("load", { descriptor }, { timeoutMs: LOAD_TIMEOUT_MS }),
    preview: (descriptor) => call("preview", { descriptor }, { timeoutMs: LOAD_TIMEOUT_MS }),
    play: (given) => keyed("play", given ? { descriptor: given } : {}),
    pause: () => keyed("pause"),
    seekTo({ positionMs, expectedSubject }) {
      const subject = expectedSubject ?? state.playbackSubject;
      if (subject === null || subject !== state.playbackSubject) return;
      keyed("seek", { positionMs: Math.max(0, Math.round(positionMs)) });
    },
    skipBy: (deltaMs) => keyed("skip", { deltaMs }),
    setRate: (value) => preference("rate", { value }),
    setShortenPauses: (on) => preference("sessionShortenPauses", { on }),
    async prepareProgressFence(mediaId) {
      if (key() !== mediaId) return;
      try {
        await call("fence", { key: mediaId, expected_load_id: state.playbackSubject }, { timeoutMs: LOAD_TIMEOUT_MS });
      } catch (error) {
        if (!(error instanceof Error) || error.message !== "NotResponding") throw error;
        throw new ApiError(0, "E_NATIVE_PLAYER_NOT_RESPONDING",
          "The native player is not responding. Reload the app and try again.");
      }
    },
    async reconcileProgressFence(mediaId) {
      if (key() !== mediaId) return;
      try {
        await call("reconcile", { key: mediaId, expected_load_id: state.playbackSubject }, { timeoutMs: LOAD_TIMEOUT_MS });
      } catch (error) {
        if (!(error instanceof Error) ||
            (error.message !== "Unavailable" && error.message !== "NotResponding")) throw error;
        // justify-ignore-error: the service's retry snapshot or onResponding(false) owns the outage; saving stays fenced until authority returns.
      }
    },
    dismiss: () => call("dismiss", {}, { timeoutMs: LOAD_TIMEOUT_MS }).catch(() => undefined),
    close() {
      port.onmessage = null;
      for (const { reject } of pending.values()) reject(new Error("Closed"));
      pending.clear();
      listeners.clear();
    },
  };
}
