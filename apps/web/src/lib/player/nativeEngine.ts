"use client";

/**
 * The Android shell's audio engine: a thin client of the native service behind
 * `window.nexusAudio`, which owns playback, listening writes, activity and natural ends.
 *
 * Frames are trusted json in the grammar of `window.nexusOffline`: both ends ship in one release
 * train, and the object's name is the compatibility identity (its absence means an older app).
 *   request {id, op, ...args} -> reply {id, ok: true, snapshot?} | {id, ok: false, error}
 *   push    {snapshot} on every change and each second while playing
 * Session ops carry `key` (the media id, or a preview's target); a key not loaded is "Stale".
 */

import {
  IDLE_ENGINE_STATE,
  type Engine,
  type EngineState,
} from "@/lib/player/playerRuntime";

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
    : (window as Window & { nexusAudio?: Port }).nexusAudio;

export const nativePlayerAvailable = port !== undefined;

const REPLY_TIMEOUT_MS = 5_000;
/** `load` replies after the outgoing episode's last write and the start of playback. */
const LOAD_TIMEOUT_MS = 20_000;

/** `onResponding(false)` when a reply times out, `(true)` again on the next frame. */
export function createNativeEngine(
  accountId: string,
  onResponding: (responding: boolean) => void,
): Engine {
  if (port === undefined) throw new Error("window.nexusAudio is unavailable");
  const listeners = new Set<() => void>();
  const pending = new Map<
    number,
    { resolve: () => void; reject: (error: Error) => void }
  >();
  let state: EngineState = IDLE_ENGINE_STATE;
  let nextId = 1;
  let responding = true;
  const respond = (value: boolean) => {
    if (responding === value) return;
    responding = value;
    onResponding(value);
  };

  const publish = (snapshot: EngineState) => {
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
    if (frame.ok && frame.snapshot) publish(frame.snapshot);
    const call = pending.get(frame.id);
    pending.delete(frame.id);
    if (frame.ok) call?.resolve();
    else call?.reject(new Error(frame.error));
  };

  const call = (
    op: string,
    args: Record<string, unknown> = {},
    timeoutMs = REPLY_TIMEOUT_MS,
  ) => {
    const id = nextId++;
    return new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        pending.delete(id);
        respond(false);
        reject(new Error("NotResponding"));
      }, timeoutMs);
      pending.set(id, {
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
        ? source.descriptor.mediaId
        : source.descriptor.target;
  };
  const keyed = (op: string, args: Record<string, unknown> = {}) => {
    const loaded = key();
    if (loaded !== null) send(op, { ...args, key: loaded });
  };

  void call("hello", { accountId }).catch(() => undefined);

  return {
    state: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    load: (descriptor) => call("load", { descriptor }, LOAD_TIMEOUT_MS),
    preview: (descriptor) => call("preview", { descriptor }, LOAD_TIMEOUT_MS),
    play: (given) => keyed("play", given ? { descriptor: given } : {}),
    pause: () => keyed("pause"),
    seekTo: (positionMs) =>
      keyed("seek", { positionMs: Math.max(0, Math.round(positionMs)) }),
    skipBy: (deltaMs) => keyed("skip", { deltaMs }),
    setRate: (value) => keyed("rate", { value }),
    setVolume: (value) => send("volume", { value }),
    setShortenPauses: (on) => keyed("sessionShortenPauses", { on }),
    setShortenPausesDefault: (on) => send("shortenPauses", { on }),
    adopt(mediaId, positionMs, resetEpoch) {
      if (key() === mediaId)
        send("adopt", { key: mediaId, positionMs, resetEpoch });
    },
    dismiss: () => call("dismiss", {}, LOAD_TIMEOUT_MS).catch(() => undefined),
    close() {
      port.onmessage = null;
      for (const { reject } of pending.values()) reject(new Error("Closed"));
      pending.clear();
      listeners.clear();
    },
  };
}
