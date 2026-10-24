"use client";

/**
 * The Android shell's audio engine: a thin client of the native service behind
 * `window.nexusQueueSession`, which owns playback, listening writes, activity and natural ends.
 *
 * Frames are trusted json in the grammar of `window.nexusDownloads`: both ends ship in one release
 * train, and the object's name is the compatibility identity (its absence means an older app).
 *   request {id, op, ...args} -> reply {id, ok: true, snapshot?} | {id, ok: false, error}
 *   push    {snapshot} on every change and each second while playing
 * Session ops carry `key` and `expected_load_id`; the service checks the load at application.
 * A stale command has no effect. Replies cannot replace an intervening confirmed load.
 * Queue installs stage <=100 occurrences per frame and commit paused; routine snapshots
 * carry a header, with revision-bound pages. Known descriptors stage metadata/chapters
 * as an outage candidate, adopted only after native transport failure. Origin refusal
 * retires that candidate. Ordinary close detaches; explicit account departure unbinds.
 */

import {
  IDLE_ENGINE_STATE,
  PlaybackPreferenceError,
  type Engine,
  type EngineState,
  type PlayerDescriptor,
} from "@/lib/player/playerRuntime";
import { publishChange } from "@/lib/api/changes";
import { ApiError } from "@/lib/api/client";
import { QueueCommandError, type NativeQueueOwner, type QueueEntry, type QueueHeader, type QueueRequest } from "@/lib/player/queue";

interface Port {
  postMessage(frame: string): void;
  onmessage: ((event: { readonly data: unknown }) => void) | null;
}

type NativeSnapshot = Omit<EngineState, "playbackSubject" | "playbackFailed"> & { readonly load_id: string | null; readonly playback_failed: boolean; readonly snapshot_id: number };
type Reply = { readonly id: number; readonly ok: true; readonly snapshot?: NativeSnapshot;
  readonly entries?: QueueEntry[]; readonly chapters?: PlayerDescriptor["chapters"]; readonly chapter_count?: number };
type Frame =
  | { readonly snapshot: NativeSnapshot }
  | Reply
  | { readonly id: number; readonly ok: false; readonly error: string };

const port =
  typeof window === "undefined"
    ? undefined
    : (window as Window & { nexusQueueSession?: Port }).nexusQueueSession;

export const nativePlayerAvailable = port !== undefined;

const REPLY_TIMEOUT_MS = 5_000;
/** `load` replies after the outgoing episode's last write and the start of playback. */
const LOAD_TIMEOUT_MS = 20_000;
// The port survives engine/account replacement; late replies must never reuse a new call's id.
let nextId = 1;
let activeUnbind: (() => Promise<void>) | null = null;

/** Explicit account departure; ordinary renderer teardown leaves the native service playing. */
export async function unbindNativePlayer(): Promise<void> {
  if (activeUnbind !== null) await activeUnbind();
}

/** The bridge's finite availability outcomes; other replies remain defects. */
function nativeUnavailable(error: unknown): error is Error {
  return error instanceof Error && (error.message === "NotResponding" ||
    error.message === "NotConnected" || error.message === "Unavailable");
}

/** `onResponding(false)` when a reply times out, `(true)` again on the next frame. */
export function createNativeEngine(
  onResponding: (responding: boolean) => void,
): Engine {
  if (port === undefined) throw new Error("window.nexusQueueSession is unavailable");
  const listeners = new Set<() => void>();
  const pending = new Map<
    number,
    { resolve: (reply: Reply) => void; reject: (error: Error) => void }
  >();
  let state: EngineState = IDLE_ENGINE_STATE;
  let responding = true;
  let snapshotId = 0;
  let bound = true;
  let uncertain = false;
  let chaptersSubject: string | null = null;
  let chapters: PlayerDescriptor["chapters"] = [];
  const respond = (value: boolean) => {
    if (responding === value) return;
    responding = value;
    onResponding(value);
  };

  const publish = ({ load_id, snapshot_id, playback_failed, ...snapshot }: NativeSnapshot) => {
    if (snapshot_id <= snapshotId) return;
    snapshotId = snapshot_id;
    if (snapshot.consumptionRevision !== state.consumptionRevision)
      publishChange("Consumption");
    // Keep the source's identity across position pushes, so session readers do not re-render.
    const same =
      load_id === state.playbackSubject && JSON.stringify(snapshot.source) === JSON.stringify(state.source?.kind === "Episode"
        ? { ...state.source, descriptor: { ...state.source.descriptor, chapters: undefined } } : state.source);
    const source = snapshot.source?.kind === "Episode"
      ? { ...snapshot.source, descriptor: { ...snapshot.source.descriptor,
          chapters: load_id === chaptersSubject ? chapters : [] } }
      : snapshot.source;
    state = { ...snapshot, queue: JSON.stringify(snapshot.queue) === JSON.stringify(state.queue) ? state.queue : snapshot.queue,
      source: same ? state.source : source, playbackSubject: load_id, playbackFailed: playback_failed };
    if (source?.kind === "Episode" && load_id !== null && load_id !== chaptersSubject) {
      chaptersSubject = load_id;
      chapters = [];
      void readChapters(source.descriptor.media_id, load_id);
    }
    for (const listener of listeners) listener();
  };
  port.onmessage = (event) => {
    respond(true);
    const frame = JSON.parse(event.data as string) as Frame;
    if (!("id" in frame)) return publish(frame.snapshot);
    const waiting = pending.get(frame.id);
    if (waiting === undefined) return; // an expired reply cannot replace a newer pushed snapshot
    if (frame.ok && frame.snapshot) publish(frame.snapshot);
    pending.delete(frame.id);
    if (frame.ok) waiting.resolve(frame);
    else waiting.reject(new Error(frame.error));
  };

  const call = (
    op: string,
    args: Record<string, unknown> = {},
    options: { timeoutMs?: number } = {},
  ) => {
    const id = nextId++;
    const snapshotAtCall = snapshotId;
    return new Promise<Reply>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        pending.delete(id);
        if (snapshotId === snapshotAtCall) respond(false);
        reject(new Error("NotResponding"));
      }, options.timeoutMs ?? REPLY_TIMEOUT_MS);
      pending.set(id, {
        resolve: (reply) => {
          window.clearTimeout(timer);
          resolve(reply);
        },
        reject: (error) => {
          window.clearTimeout(timer);
          reject(error);
        },
      });
      const frame = JSON.stringify({ ...args, id, op });
      if (new TextEncoder().encode(frame).byteLength > (op.startsWith("queue_") || op.startsWith("known_") ? 32 * 1024 : 64 * 1024)) {
        pending.delete(id);
        window.clearTimeout(timer);
        reject(new Error("Limit"));
        return;
      }
      port.postMessage(frame);
    });
  };
  const command = async (op: string, args: Record<string, unknown> = {}, timeoutMs = REPLY_TIMEOUT_MS) => {
    try {
      return await call(op, args, { timeoutMs });
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      if (error.message === "Stale" || error.message === "Closed")
        throw new ApiError(409, "E_PLAYBACK_STALE", "playback source changed. try again.");
      if (error.message === "Reconciled")
        throw new ApiError(409, "E_PLAYBACK_REFUSED", "listening progress synchronized. press play to resume.");
      if (error.message === "Fenced")
        throw new ApiError(409, "E_PLAYBACK_REFUSED", "listening progress is being synchronized. try again after it finishes.");
      if (error.message === "Unauthenticated")
        throw new ApiError(401, "E_UNAUTHENTICATED", "sign in to resume playback.");
      if (error.message === "AuthorityRefused")
        throw new ApiError(409, "E_PLAYBACK_REFUSED", "the server refused this episode’s playback state. reload and try again.");
      if (error.message === "NotConnected")
        throw new ApiError(409, "E_PLAYBACK_REFUSED", "the player is not connected. reload the app and try again.");
      if (error.message === "NotResponding" || error.message === "Unavailable")
        throw new ApiError(0, "E_PLAYBACK_UNCONFIRMED", "the playback request was not confirmed.");
      throw error;
    }
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
        if (nativeUnavailable(error))
          throw new PlaybackPreferenceError("the native player is not responding. try again.");
      }
      throw error;
    }
  };

  const readChapters = async (mediaId: string, subject: string) => {
    try {
      const collected: PlayerDescriptor["chapters"] = [];
      let count = 1;
      while (collected.length < count) {
        const reply = await call("chapters", { key: mediaId, expected_load_id: subject, offset: collected.length, limit: 20 });
        if (state.playbackSubject !== subject) return;
        collected.push(...(reply.chapters ?? []));
        count = reply.chapter_count ?? 0;
      }
      if (state.playbackSubject !== subject || state.source?.kind !== "Episode") return;
      chapters = collected;
      state = { ...state, source: { ...state.source, descriptor: { ...state.source.descriptor, chapters } } };
      for (const listener of listeners) listener();
    } catch (error) {
      if (!(error instanceof Error) || !["Stale", "Closed", "NotResponding"].includes(error.message)) throw error;
      // justify-ignore-error: a retired load or unavailable service owns the visible state.
    }
  };
  const header = (_reply: Reply): QueueHeader => {
    const queue = state.queue;
    if (queue == null) throw new Error("NotConnected");
    return queue;
  };
  const queueError = (error: unknown): Error => {
    if (!(error instanceof Error)) throw error;
    switch (error.message) {
      case "Unauthenticated": return new ApiError(401, "E_UNAUTHENTICATED", "sign in to resume playback.");
      case "Stale": return new QueueCommandError("queue changed. check it and try again.");
      case "Limit": return new QueueCommandError("too many episodes; narrow this view");
      case "Invalid": return new QueueCommandError("couldn’t change the queue. reload and try again.");
      case "NotConnected": return new QueueCommandError("the native player is not connected. reload the app.");
      case "Unavailable":
      case "NotResponding": return new QueueCommandError("couldn’t confirm queue change");
      default: return error;
    }
  };
  const readQueue = async () => {
    await call("queue_read", { reconcile: uncertain }, { timeoutMs: LOAD_TIMEOUT_MS });
    uncertain = false;
    return state.queue;
  };
  const prepareKnown = async (id: string, descriptor: PlayerDescriptor, isCurrent: () => boolean) => {
    const { chapters, ...metadata } = descriptor;
    try {
      await call("known_begin", { preparation_id: id, descriptor: metadata, count: chapters.length });
      for (let offset = 0; offset < chapters.length; offset += 20) {
        if (!bound || !isCurrent()) throw new Error("Stale");
        await call("known_chunk", { preparation_id: id, offset, chapters: chapters.slice(offset, offset + 20) });
      }
      if (!bound || !isCurrent()) throw new Error("Stale");
      await call("known_commit", { preparation_id: id });
    } catch (error) {
      await call("known_cancel", { preparation_id: id }).catch(() => undefined);
      throw queueError(error);
    }
  };
  const queue: NativeQueueOwner = {
    known: () => snapshotId > 0,
    uncertain: () => uncertain,
    async read() { try { return await readQueue(); } catch (error) { throw queueError(error); } },
    async page(input) {
      try { return (await call("queue_page", input)).entries ?? []; }
      catch (error) { throw queueError(error); }
    },
    async replace({ state: next, expected_revision, is_current, known_descriptor }) {
      const begin = { queue_id: next.queue_id, expected_revision, count: next.entries.length,
        current_entry_id: next.current_entry_id, source: next.source };
      if (!bound) throw queueError(new Error("NotConnected"));
      if (!is_current()) throw queueError(new Error("Stale"));
      if (uncertain) throw new QueueCommandError("couldn’t confirm queue change");
      if (known_descriptor !== null) await prepareKnown(next.queue_id, known_descriptor, is_current);
      try { await call("queue_begin", begin); } catch (error) { throw queueError(error); }
      let committed = false;
      try {
        for (let offset = 0; offset < next.entries.length; offset += 100) {
          if (!bound) throw queueError(new Error("NotConnected"));
          if (!is_current()) throw queueError(new Error("Stale"));
          await call("queue_chunk", { queue_id: next.queue_id, offset, entries: next.entries.slice(offset, offset + 100) });
        }
        if (!bound) throw queueError(new Error("NotConnected"));
        if (!is_current()) throw queueError(new Error("Stale"));
        committed = true;
        return header(await call("queue_commit", { queue_id: next.queue_id }, { timeoutMs: LOAD_TIMEOUT_MS }));
      } catch (error) {
        if (committed && nativeUnavailable(error)) {
          uncertain = true;
          await readQueue().catch(() => undefined);
        }
        else {
          await call("queue_cancel", { queue_id: next.queue_id }).catch(() => undefined);
          await call("known_cancel", { preparation_id: next.queue_id }).catch(() => undefined);
        }
        throw queueError(error);
      }
    },
    async command(input: QueueRequest) {
      if (uncertain) throw new QueueCommandError("couldn’t confirm queue change");
      try { return header(await call("queue_command", { ...input }, { timeoutMs: LOAD_TIMEOUT_MS })); }
      catch (error) {
        if (nativeUnavailable(error)) {
          uncertain = true;
          await readQueue().catch(() => undefined);
        }
        throw queueError(error);
      }
    },
  };
  const unbind = async () => { bound = false; await call("unbind", {}, { timeoutMs: LOAD_TIMEOUT_MS }); };
  activeUnbind = unbind;
  void call("hello").catch(() => undefined);

  return {
    supportsSilenceSkipping: true,
    queue,
    state: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async load(descriptor, play, positionMs) {
      await prepareKnown(crypto.randomUUID(), descriptor, () => bound);
      await command("load", { media_id: descriptor.media_id, play, position_ms: positionMs }, LOAD_TIMEOUT_MS);
    },
    preview: descriptor => command("preview", { descriptor }, LOAD_TIMEOUT_MS).then(() => {}),
    async play() {
      const loaded = key();
      if (loaded === null) throw new ApiError(409, "E_PLAYBACK_STALE", "playback source changed. try again.");
      await command("play", { key: loaded, expected_load_id: state.playbackSubject });
    },
    async pause() {
      await command("cancelPlayback");
      const loaded = key();
      if (loaded !== null) await command("pause", { key: loaded, expected_load_id: state.playbackSubject });
    },
    cancelPendingPlayback: () => send("cancelPlayback"),
    seekAndPlay: (mediaId, positionMs) => command("seekAndPlay", { key: mediaId, expected_load_id: state.playbackSubject, position_ms: positionMs }).then(() => {}),
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
    dismiss: async () => { await command("dismiss", {}, LOAD_TIMEOUT_MS); },
    close() {
      if (activeUnbind === unbind) activeUnbind = null;
      port.onmessage = null;
      for (const { reject } of pending.values()) reject(new Error("Closed"));
      pending.clear();
      listeners.clear();
    },
  };
}
