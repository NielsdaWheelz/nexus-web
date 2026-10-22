"use client";

/**
 * The Android shell's audio engine: a thin client of the native service behind
 * `window.nexusPlayer`, which owns playback, listening writes, activity and natural ends.
 *
 * Frames are trusted json in the grammar of `window.nexusDownloads`: both ends ship in one release
 * train, and the object's name is the compatibility identity (its absence means an older app).
 *   request {id, op, ...args} -> reply {id, ok: true, snapshot?} | {id, ok: false, error}
 *   push    {snapshot} on every change and each second while playing
 * Session ops carry `key` (the media id, or a preview's target); a key not loaded is "Stale".
 */

import {
  IDLE_ENGINE_STATE,
  PlaybackPreferenceError,
  type Engine,
  type EngineState,
  type PlayerDescriptor,
  type PreviewAudioDescriptor,
} from "@/lib/player/playerRuntime";
import { publishChange } from "@/lib/api/changes";
import { ApiError } from "@/lib/api/client";

interface Port {
  postMessage(frame: string): void;
  onmessage: ((event: { readonly data: unknown }) => void) | null;
}

type Frame =
  | { readonly snapshot: EngineState }
  | { readonly id: number; readonly ok: true; readonly snapshot?: EngineState }
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

/** The bridge's finite availability outcomes; other replies remain defects. */
function nativeUnavailable(error: unknown): error is Error {
  return error instanceof Error && (error.message === "NotResponding" ||
    error.message === "NotConnected" || error.message === "Unavailable");
}

/** `onResponding(false)` when a reply times out, `(true)` again on the next frame. */
export function createNativeEngine(
  accountId: string,
  onResponding: (responding: boolean) => void,
): Engine {
  if (port === undefined) throw new Error("window.nexusPlayer is unavailable");
  const listeners = new Set<() => void>();
  const pending = new Map<
    number,
    { resolve: () => void; reject: (error: Error) => void; source: EngineState["source"] }
  >();
  let state: EngineState = IDLE_ENGINE_STATE;
  let responding = true;
  const respond = (value: boolean) => {
    if (responding === value) return;
    responding = value;
    onResponding(value);
  };

  const publish = (snapshot: EngineState) => {
    if (snapshot.consumptionRevision !== state.consumptionRevision)
      publishChange("Consumption");
    // Keep the source's identity across position pushes, so session readers do not re-render.
    const same =
      JSON.stringify(snapshot.source) === JSON.stringify(state.source);
    state = same ? { ...snapshot, source: state.source } : snapshot;
    for (const listener of listeners) listener();
  };
  port.onmessage = (event) => {
    respond(true);
    const frame = JSON.parse(event.data as string) as Frame;
    if (!("id" in frame)) return publish(frame.snapshot);
    const waiting = pending.get(frame.id);
    if (waiting === undefined) return; // an expired reply cannot replace a newer pushed snapshot
    if (frame.ok && frame.snapshot && (waiting.source === null || waiting.source === state.source))
      publish(frame.snapshot);
    pending.delete(frame.id);
    if (frame.ok) waiting.resolve();
    else waiting.reject(new Error(frame.error));
  };

  const call = (
    op: string,
    args: Record<string, unknown> = {},
    options: { timeoutMs?: number; source?: EngineState["source"] } = {},
  ) => {
    const id = nextId++;
    return new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        pending.delete(id);
        respond(false);
        reject(new Error("NotResponding"));
      }, options.timeoutMs ?? REPLY_TIMEOUT_MS);
      pending.set(id, {
        source: options.source ?? null,
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
  /** Fire a session op at whatever is loaded; a stale key is harmless and only logged. */
  const send = (op: string, args: Record<string, unknown> = {}) =>
    void call(op, args).catch((error: Error) => {
      if (error.message !== "NotResponding")
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
    if (loaded !== null) send(op, { ...args, key: loaded });
  };
  const preference = async (op: string, args: Record<string, unknown>) => {
    const loaded = key();
    if (loaded === null)
      throw new PlaybackPreferenceError("playback source changed. try again.");
    try {
      await call(op, { ...args, key: loaded }, { source: state.source });
    } catch (error) {
      if (error instanceof Error) {
        if (error.message === "Stale")
          throw new PlaybackPreferenceError("playback source changed. try again.");
        if (nativeUnavailable(error))
          throw new PlaybackPreferenceError("the native player is not responding. try again.");
      }
      throw error;
    }
  };

  const installSource = async (op: "load" | "preview", descriptor: PlayerDescriptor | PreviewAudioDescriptor) => {
    try { await call(op, { descriptor }, { timeoutMs: LOAD_TIMEOUT_MS }); }
    catch (error) {
      if (!nativeUnavailable(error)) throw error;
      throw new ApiError(0, "E_NATIVE_PLAYER_NOT_RESPONDING", "The native player is unavailable. Try again.");
    }
  };

  void call("hello", { accountId }).catch(() => undefined);

  return {
    state: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    load: descriptor => installSource("load", descriptor),
    preview: descriptor => installSource("preview", descriptor),
    play: (given) => keyed("play", given ? { descriptor: given } : {}),
    pause: () => keyed("pause"),
    seekTo: (positionMs) =>
      keyed("seek", { positionMs: Math.max(0, Math.round(positionMs)) }),
    skipBy: (deltaMs) => keyed("skip", { deltaMs }),
    setRate: (value) => preference("rate", { value }),
    setVolume: (value) => send("volume", { value }),
    setShortenPauses: (on) => preference("sessionShortenPauses", { on }),
    async prepareProgressFence(mediaId) {
      if (key() !== mediaId) return;
      try {
        await call("fence", { key: mediaId }, { timeoutMs: LOAD_TIMEOUT_MS });
      } catch (error) {
        if (!(error instanceof Error) || error.message !== "NotResponding") throw error;
        throw new ApiError(0, "E_NATIVE_PLAYER_NOT_RESPONDING",
          "The native player is not responding. Reload the app and try again.");
      }
    },
    async reconcileProgressFence(mediaId) {
      if (key() !== mediaId) return;
      try {
        await call("reconcile", { key: mediaId }, { timeoutMs: LOAD_TIMEOUT_MS });
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
