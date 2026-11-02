"use client";

/**
 * The Android shell's audio engine: a thin client of the native service behind
 * `window.nexusPlayer`, which owns playback, listening facts, activity and natural ends.
 *
 * Frames are bounded snake_case json; both ends ship in one release train, and the
 * object's name is the compatibility identity (its absence means an older app).
 *   request {id, op, ...args} -> reply {id, ok: true, snapshot?} | {id, ok: false, error}
 *   push    {snapshot} on every change and each second while playing; {unavailable: true}
 *           when the service controller disconnects (not an empty player)
 * Session ops carry `key` and `expected_load_id`; the service checks the load at application.
 * A stale command has no effect. Replies cannot replace an intervening confirmed load.
 * Queue installs stage <=100 occurrences per frame and commit paused; routine snapshots
 * carry a header, with revision-bound pages. Native resolves each activation itself: a
 * downloaded package's lease, else its own descriptor read; no renderer authority.
 * `listening_revision` invalidates the fixed listening projection. Ordinary close
 * detaches; explicit account departure unbinds.
 */

import {
  IDLE_ENGINE_STATE,
  PLAYER_CHANGED,
  PlaybackPreferenceError,
  type Engine,
  type EngineState,
  type PlayerDescriptor,
  type PlayerSource,
  type PreviewAudioDescriptor,
} from "@/lib/player/playerRuntime";
import { publishChange } from "@/lib/api/changes";
import { ApiError } from "@/lib/api/client";
import { announceListeningRevision, listeningSourceReconnected, setObservationTransport } from "@/lib/consumption/listening";
import { QueueCommandError, type NativeQueueOwner, type QueueEntry, type QueueHeader, type QueueRequest } from "@/lib/player/queue";
import {
  expectArray, expectBoolean, expectCanonicalRfcUuid, expectExactRecord, expectFiniteNumber, expectNonnegativeInteger,
  expectNullableString, expectOneOf, expectRecord, expectString,
} from "@/lib/validation";

interface Port {
  postMessage(frame: string): void;
  onmessage: ((event: { readonly data: unknown }) => void) | null;
}

interface NativeSnapshot {
  readonly snapshot_id: number;
  readonly source:
    | { readonly kind: "Episode"; readonly descriptor: Omit<PlayerDescriptor, "chapters">; readonly package_id: string | null }
    | { readonly kind: "Preview"; readonly descriptor: PreviewAudioDescriptor; readonly package_id: null }
    | null;
  readonly queue: QueueHeader | null;
  readonly load_id: string | null;
  readonly phase: EngineState["phase"];
  readonly position_ms: number;
  readonly duration_ms: number;
  readonly buffered_ms: number;
  readonly rate: number;
  readonly shorten_pauses: boolean;
  readonly shorten_pauses_saved_ms: number;
  readonly error: string | null;
  readonly playback_failed: boolean;
  readonly synced: boolean;
  readonly consumption_revision: number;
  readonly listening_revision: string;
}
type Reply = { readonly id: number; readonly ok: true; readonly snapshot?: NativeSnapshot;
  readonly entries?: QueueEntry[]; readonly chapters?: PlayerDescriptor["chapters"]; readonly chapter_count?: number };
type Frame =
  | { readonly snapshot: NativeSnapshot }
  | { readonly unavailable: true }
  | Reply
  | { readonly id: number; readonly ok: false; readonly error: string };

// ---- strict frame decoding at the native boundary ----
// Descriptors and chapters are the same-deploy server's types that native
// carries verbatim; only their object shape and identity fields are checked here.

const REVISION = /^(0|[1-9][0-9]{0,18})$/;
function expectRevision(raw: unknown, name: string): string {
  const value = expectString(raw, name);
  if (!REVISION.test(value)) throw new TypeError(`${name} must be a decimal revision`);
  return value;
}
const nullable = <T,>(raw: unknown, decode: (value: unknown) => T): T | null => raw === null ? null : decode(raw);

function decodeEntry(raw: unknown, name: string): QueueEntry {
  const value = expectExactRecord(raw, ["id", "media_id"], name);
  return { id: expectCanonicalRfcUuid(value.id, `${name}.id`), media_id: expectCanonicalRfcUuid(value.media_id, `${name}.media_id`) };
}

function decodeHeader(raw: unknown): QueueHeader {
  const value = expectExactRecord(raw, ["queue_id", "revision", "current_entry_id", "current_entry", "current_index", "count", "can_restore"], "queue");
  const header: QueueHeader = {
    queue_id: expectCanonicalRfcUuid(value.queue_id, "queue.queue_id"),
    revision: expectRevision(value.revision, "queue.revision"),
    current_entry_id: nullable(value.current_entry_id, raw => expectCanonicalRfcUuid(raw, "queue.current_entry_id")),
    current_entry: nullable(value.current_entry, raw => decodeEntry(raw, "queue.current_entry")),
    current_index: nullable(value.current_index, raw => expectNonnegativeInteger(raw, "queue.current_index")),
    count: expectNonnegativeInteger(value.count, "queue.count"),
    can_restore: expectBoolean(value.can_restore, "queue.can_restore"),
  };
  // justify-defect: these fields describe one accepted native queue, never a partial header.
  if (header.count > 10_000 || (header.current_entry_id === null
    ? header.current_entry !== null || header.current_index !== null
    : header.current_entry?.id !== header.current_entry_id || header.current_index === null || header.current_index >= header.count))
    throw new TypeError("inconsistent native queue header");
  return header;
}

function decodeSource(raw: unknown): NativeSnapshot["source"] {
  const value = expectExactRecord(raw, ["kind", "package_id", "descriptor"], "source");
  const kind = expectOneOf(value.kind, ["Episode", "Preview"] as const, "source.kind");
  const descriptor = expectRecord(value.descriptor, "source.descriptor");
  if (kind === "Preview") {
    if (value.package_id !== null) throw new TypeError("source.package_id must be null for a preview");
    expectString(descriptor.target, "source.descriptor.target");
    // justify-type-assertion: a preview descriptor is the renderer's own frozen bridge input, echoed back.
    return { kind, descriptor: descriptor as unknown as PreviewAudioDescriptor, package_id: null };
  }
  expectCanonicalRfcUuid(descriptor.media_id, "source.descriptor.media_id");
  // justify-type-assertion: an episode descriptor is the server's PlayerDescriptor (or a lease's rendition in that shape).
  return { kind, descriptor: descriptor as unknown as Omit<PlayerDescriptor, "chapters">,
    package_id: nullable(value.package_id, raw => expectCanonicalRfcUuid(raw, "source.package_id")) };
}

function decodeSnapshot(raw: unknown): NativeSnapshot {
  const value = expectExactRecord(raw, ["snapshot_id", "source", "queue", "load_id", "phase", "position_ms", "duration_ms",
    "buffered_ms", "rate", "shorten_pauses", "shorten_pauses_saved_ms", "error", "playback_failed", "synced",
    "consumption_revision", "listening_revision"], "snapshot");
  return {
    snapshot_id: expectNonnegativeInteger(value.snapshot_id, "snapshot_id"),
    source: nullable(value.source, decodeSource),
    queue: nullable(value.queue, decodeHeader),
    load_id: nullable(value.load_id, raw => expectCanonicalRfcUuid(raw, "load_id")),
    phase: expectOneOf(value.phase, ["Buffering", "Playing", "Paused", "Ended"] as const, "phase"),
    position_ms: expectNonnegativeInteger(value.position_ms, "position_ms"),
    duration_ms: expectNonnegativeInteger(value.duration_ms, "duration_ms"),
    buffered_ms: expectNonnegativeInteger(value.buffered_ms, "buffered_ms"),
    rate: expectFiniteNumber(value.rate, "rate"),
    shorten_pauses: expectBoolean(value.shorten_pauses, "shorten_pauses"),
    shorten_pauses_saved_ms: expectNonnegativeInteger(value.shorten_pauses_saved_ms, "shorten_pauses_saved_ms"),
    error: expectNullableString(value.error, "error"),
    playback_failed: expectBoolean(value.playback_failed, "playback_failed"),
    synced: expectBoolean(value.synced, "synced"),
    consumption_revision: expectNonnegativeInteger(value.consumption_revision, "consumption_revision"),
    listening_revision: expectRevision(value.listening_revision, "listening_revision"),
  };
}

function decodeFrame(data: unknown): Frame {
  const value = expectRecord(JSON.parse(expectString(data, "frame")), "frame");
  if (!("id" in value)) {
    if ("unavailable" in value) {
      if (expectExactRecord(value, ["unavailable"], "frame").unavailable !== true) throw new TypeError("frame.unavailable must be true");
      return { unavailable: true };
    }
    return { snapshot: decodeSnapshot(expectExactRecord(value, ["snapshot"], "frame").snapshot) };
  }
  const id = expectNonnegativeInteger(value.id, "frame.id");
  if (!expectBoolean(value.ok, "frame.ok")) return { id, ok: false, error: expectString(expectExactRecord(value, ["id", "ok", "error"], "frame").error, "frame.error") };
  for (const key of Object.keys(value))
    if (!["id", "ok", "snapshot", "entries", "chapters", "chapter_count"].includes(key)) throw new TypeError(`frame.${key} is not a reply field`);
  return {
    id, ok: true,
    ...(value.snapshot === undefined ? {} : { snapshot: decodeSnapshot(value.snapshot) }),
    ...(value.entries === undefined ? {} : { entries: expectArray(value.entries, (entry, index) => decodeEntry(entry, `entries[${index}]`), "entries") }),
    // justify-type-assertion: chapters are the server's ChapterOut rows from the loaded descriptor.
    ...(value.chapters === undefined ? {} : { chapters: expectArray(value.chapters, (chapter, index) => expectRecord(chapter, `chapters[${index}]`), "chapters") as unknown as PlayerDescriptor["chapters"] }),
    ...(value.chapter_count === undefined ? {} : { chapter_count: expectNonnegativeInteger(value.chapter_count, "chapter_count") }),
  };
}

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
let active: { readonly unbind: () => Promise<void>; readonly retryListening: (mediaId: string) => Promise<void> } | null = null;

/** Explicit account departure; ordinary renderer teardown leaves the native service playing. */
export async function unbindNativePlayer(): Promise<void> {
  if (active !== null) await active.unbind();
}

/** Explicit retry of one media's suspended delivery; native rechecks access and fences. */
export async function retryNativeListening(mediaId: string): Promise<void> {
  if (active === null) throw new ApiError(409, "E_PLAYBACK_REFUSED", "the player isn’t connected.");
  await active.retryListening(mediaId);
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
  if (port === undefined) throw new Error("window.nexusPlayer is unavailable");
  const listeners = new Set<() => void>();
  const pending = new Map<
    number,
    { resolve: (reply: Reply) => void; reject: (error: Error) => void }
  >();
  let state: EngineState = IDLE_ENGINE_STATE;
  let responding = true;
  let snapshotId = 0;
  let bound = true;
  /** Sends and checks of a queue change that went unanswered; 0 once every change is confirmed. */
  let unanswered = 0;
  let chaptersSubject: string | null = null;
  let chapters: PlayerDescriptor["chapters"] = [];
  let lastError: string | null = null;
  let unsaved = 0; // keys each new native place error, so a repeat refusal speaks again
  const respond = (value: boolean) => {
    if (responding === value) return;
    responding = value;
    onResponding(value);
    if (value) listeningSourceReconnected();
  };

  const publish = (snapshot: NativeSnapshot) => {
    if (snapshot.snapshot_id <= snapshotId) return;
    const before = state.queue;
    const next = snapshot.queue;
    // justify-defect: one accepted revision fixes the sequence and cursor; undo eligibility is memory-owned.
    if (before !== null && next !== null && before.queue_id === next.queue_id && before.revision === next.revision &&
        (before.count !== next.count || before.current_entry_id !== next.current_entry_id || before.current_index !== next.current_index ||
          before.current_entry?.id !== next.current_entry?.id || before.current_entry?.media_id !== next.current_entry?.media_id))
      throw new TypeError("native queue changed without a revision");
    snapshotId = snapshot.snapshot_id;
    announceListeningRevision(snapshot.listening_revision);
    if (snapshot.consumption_revision !== state.consumptionRevision)
      publishChange("Consumption");
    const loadId = snapshot.load_id;
    const pushed = snapshot.source;
    const nativeError = lastError;
    lastError = snapshot.error;
    // Keep the source's identity across position pushes, so session readers do not re-render.
    const held = state.source;
    const same = loadId === state.playbackSubject && pushed?.kind === held?.kind &&
      (pushed?.kind !== "Episode" || held?.kind === "Episode" && pushed.package_id === held.packageId) &&
      JSON.stringify(pushed?.descriptor) === JSON.stringify(held?.kind === "Episode" ? { ...held.descriptor, chapters: undefined } : held?.descriptor);
    const source: PlayerSource | null = pushed === null ? null : pushed.kind === "Episode"
      ? { kind: "Episode", packageId: pushed.package_id,
          descriptor: { ...pushed.descriptor, chapters: loadId === chaptersSubject ? chapters : [] } }
      : { kind: "Preview", descriptor: pushed.descriptor };
    state = {
      source: same ? state.source : source,
      queue: JSON.stringify(snapshot.queue) === JSON.stringify(state.queue) ? state.queue : snapshot.queue,
      playbackSubject: loadId,
      phase: snapshot.phase,
      positionMs: snapshot.position_ms,
      durationMs: snapshot.duration_ms,
      bufferedMs: snapshot.buffered_ms,
      rate: snapshot.rate,
      shortenPauses: snapshot.shorten_pauses,
      shortenPausesSavedMs: snapshot.shorten_pauses_saved_ms,
      // Kotlin's words never show: a non-failed error is read as the listening save stopping.
      error: snapshot.error === null || snapshot.playback_failed ? null
        : nativeError === snapshot.error && state.error !== null ? state.error : { kind: "Unsaved", attempt: ++unsaved },
      playbackFailed: snapshot.playback_failed,
      synced: snapshot.synced,
      consumptionRevision: snapshot.consumption_revision,
    };
    if (source?.kind === "Episode" && loadId !== null && loadId !== chaptersSubject) {
      chaptersSubject = loadId;
      chapters = [];
      void readChapters(source.descriptor.media_id, loadId);
    }
    for (const listener of listeners) listener();
  };
  port.onmessage = (event) => {
    // A malformed frame is a native contract defect for the boundary, never a guess.
    const frame = decodeFrame(event.data);
    // The service controller disconnected: confirmed state survives, commands wait.
    if ("unavailable" in frame) return respond(false);
    respond(true);
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
      if (new TextEncoder().encode(frame).byteLength > (op.startsWith("queue_") || op === "observe_consumption" ? 32 * 1024 : 64 * 1024)) {
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
      // Each message is the reason its press is told; the account owns sign-in.
      if (error.message === "Stale" || error.message === "Closed")
        throw new ApiError(409, "E_PLAYBACK_STALE", PLAYER_CHANGED);
      if (error.message === "Reconciled")
        throw new ApiError(409, "E_PLAYBACK_REFUSED", "its saved place just changed.");
      if (error.message === "Fenced")
        throw new ApiError(409, "E_PLAYBACK_REFUSED", "its progress is changing.");
      if (error.message === "Unauthenticated")
        throw new ApiError(401, "E_UNAUTHENTICATED", "");
      if (error.message === "AuthorityRefused")
        throw new ApiError(409, "E_PLAYBACK_REFUSED", "");
      if (error.message === "NotConnected")
        throw new ApiError(409, "E_PLAYBACK_REFUSED", "the player isn’t connected.");
      if (error.message === "NotResponding" || error.message === "Unavailable")
        throw new ApiError(0, "E_PLAYBACK_UNCONFIRMED", "it may have gone through.");
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
    if (loaded === null || subject === null) throw new PlaybackPreferenceError(PLAYER_CHANGED);
    if (!responding) throw new PlaybackPreferenceError("the player isn’t responding.");
    try {
      await call(op, { ...args, key: loaded, expected_load_id: subject });
    } catch (error) {
      if (error instanceof Error) {
        if (error.message === "Stale") throw new PlaybackPreferenceError(PLAYER_CHANGED);
        if (error.message === "NotResponding") throw new PlaybackPreferenceError("the player isn’t responding.");
        if (nativeUnavailable(error)) throw new PlaybackPreferenceError("");
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
  /** A read names what it could not load; a change, what it could not do. A service that did not
   * answer leaves an unanswered change unsettled, its held line standing; otherwise it says so. */
  const queueError = (error: unknown, read: boolean): Error => {
    if (!(error instanceof Error)) throw error;
    switch (error.message) {
      case "Unauthenticated": return new ApiError(401, "E_UNAUTHENTICATED", "");
      case "Stale": return new QueueCommandError(read ? "LoadFailed" : "Changed");
      case "Limit": return new QueueCommandError("TooMany");
      case "Invalid": return new QueueCommandError(read ? "LoadFailed" : "Refused");
      case "NotConnected": return new QueueCommandError("NotConnected");
      case "Unavailable":
      case "NotResponding": return new QueueCommandError(unanswered > 0 ? "Unsettled" : "Unresponsive");
      default: return error;
    }
  };
  const readQueue = async () => {
    await call("queue_read", { reconcile: unanswered > 0 }, { timeoutMs: LOAD_TIMEOUT_MS });
    unanswered = 0;
    return state.queue;
  };
  /** A sent change the service did not answer may have landed: it is unanswered until a read
   * reconciles it, tried once here. */
  const unsettle = async (error: Error) => {
    unanswered = 1;
    const refusal = queueError(error, false);
    await readQueue().catch(() => undefined);
    return refusal;
  };
  const queue: NativeQueueOwner = {
    known: () => snapshotId > 0,
    unanswered: () => unanswered,
    async read() {
      try { return await readQueue(); }
      catch (error) {
        if (unanswered > 0) unanswered += 1;
        throw queueError(error, true);
      }
    },
    async page(input) {
      try {
        const reply = await call("queue_page", input);
        // justify-defect: every successful queue page supplies its entries, including an empty page.
        if (reply.entries === undefined) throw new TypeError("native queue page omitted entries");
        return reply.entries;
      } catch (error) { throw queueError(error, true); }
    },
    async replace({ state: next, expected_revision, is_current }) {
      const begin = { queue_id: next.queue_id, expected_revision, count: next.entries.length,
        current_entry_id: next.current_entry_id };
      if (!bound) throw queueError(new Error("NotConnected"), false);
      if (!is_current()) throw queueError(new Error("Stale"), false);
      if (unanswered > 0) throw new QueueCommandError("Unsettled");
      try { await call("queue_begin", begin); } catch (error) { throw queueError(error, false); }
      let committed = false;
      try {
        for (let offset = 0; offset < next.entries.length; offset += 100) {
          if (!bound) throw queueError(new Error("NotConnected"), false);
          if (!is_current()) throw queueError(new Error("Stale"), false);
          await call("queue_chunk", { queue_id: next.queue_id, offset, entries: next.entries.slice(offset, offset + 100) });
        }
        if (!bound) throw queueError(new Error("NotConnected"), false);
        if (!is_current()) throw queueError(new Error("Stale"), false);
        committed = true;
        return header(await call("queue_commit", { queue_id: next.queue_id }, { timeoutMs: LOAD_TIMEOUT_MS }));
      } catch (error) {
        if (committed && nativeUnavailable(error)) throw await unsettle(error);
        await call("queue_cancel", { queue_id: next.queue_id }).catch(() => undefined);
        throw queueError(error, false);
      }
    },
    async command(input: QueueRequest) {
      if (unanswered > 0) throw new QueueCommandError("Unsettled");
      try { return header(await call("queue_command", { ...input }, { timeoutMs: LOAD_TIMEOUT_MS })); }
      catch (error) { throw nativeUnavailable(error) ? await unsettle(error) : queueError(error, false); }
    },
  };
  const owner = {
    unbind: async () => { bound = false; await call("unbind", {}, { timeoutMs: LOAD_TIMEOUT_MS }); },
    retryListening: async (mediaId: string) => { await command("retry_listening", { media_id: mediaId }); },
  };
  active = owner;
  setObservationTransport(async (account_id, observations) => { await call("observe_consumption", { account_id, observations }); });
  void call("hello").catch(() => undefined);

  const play = async () => {
    const loaded = key();
    if (loaded === null) throw new ApiError(409, "E_PLAYBACK_STALE", PLAYER_CHANGED);
    await command("play", { key: loaded, expected_load_id: state.playbackSubject });
  };

  return {
    supportsSilenceSkipping: true,
    queue,
    state: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async load(descriptor, play, positionMs) {
      await command("load", { media_id: descriptor.media_id, play, position_ms: positionMs }, LOAD_TIMEOUT_MS);
    },
    preview: descriptor => command("preview", { descriptor }, LOAD_TIMEOUT_MS).then(() => {}),
    play,
    retry: play, // listeningSaveFailed pauses the service, so its line's retry resumes it
    async resumeLoaded(expectedSubject) {
      const loaded = key();
      if (loaded === null || state.playbackSubject !== expectedSubject || state.phase === "Ended" || state.playbackFailed || state.error !== null)
        throw new ApiError(409, "E_PLAYBACK_STALE", PLAYER_CHANGED);
      await command("play", { key: loaded, expected_load_id: expectedSubject });
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
      keyed("seek", { position_ms: Math.max(0, Math.round(positionMs)) });
    },
    skipBy: (deltaMs) => keyed("skip", { delta_ms: deltaMs }),
    setRate: (value) => preference("rate", { value }),
    setShortenPauses: (on) => preference("sessionShortenPauses", { on }),
    async prepareProgressFence(mediaId) {
      if (key() !== mediaId) return;
      try {
        await call("fence", { key: mediaId, expected_load_id: state.playbackSubject }, { timeoutMs: LOAD_TIMEOUT_MS });
      } catch (error) {
        if (!nativeUnavailable(error)) throw error;
        throw new ApiError(0, "E_NATIVE_PLAYER_NOT_RESPONDING", error.message === "NotConnected" ? "the player isn’t connected." : "the player isn’t responding.");
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
      if (active === owner) {
        active = null;
        setObservationTransport(null);
      }
      port.onmessage = null;
      for (const { reject } of pending.values()) reject(new Error("Closed"));
      pending.clear();
      listeners.clear();
    },
  };
}
