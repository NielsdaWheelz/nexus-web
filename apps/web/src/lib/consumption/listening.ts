/**
 * Android's committed listening facts and their one presentation projection.
 *
 * Native folds its recorder lane; this module only reads the fixed projection
 * (`/_nexus/device/listening.json`) after a newer `listening_revision`, drops older or
 * other-account reads, and forwards canonical observations native does not hold yet.
 * `local` is unacknowledged activity only; an acknowledgement remains as `observed`.
 * Revisions are decimal strings compared as bigint. Nothing here persists or writes.
 */
import { useSyncExternalStore } from "react";
import { WIRE_HEADER } from "@/lib/api/client";
import type { ServerValue } from "@/lib/api/serverState";
import type { Schema } from "@/lib/api/wire";
import { WIRE_REVISION } from "@/lib/api/wire.gen";
import { installedApp } from "@/lib/native/admission";
import { currentLocalContent } from "@/lib/offline/localContent";
import {
  expectArray, expectBoolean, expectCanonicalRfcUuid, expectExactRecord, expectInteger, expectNonnegativeInteger,
  expectOneOf, expectString,
} from "@/lib/validation";

export type EpisodeConsumptionState = Schema<"EpisodeConsumptionState">;
export type EpisodeConsumptionObservation = Schema<"EpisodeConsumptionObservation">;
export interface LocalListening {
  readonly sequence: string;
  readonly reset_epoch: number;
  readonly position_ms: number;
  readonly duration_ms: number | null;
  /** A sticky >=95% crossing or a natural end in this unacknowledged activity. */
  readonly completed: boolean;
  readonly terminal: { readonly expected_override_revision: number | null } | null;
  readonly disposition: "Pending" | "SourceUnavailable";
}
export interface ListeningEntry {
  readonly media_id: string;
  readonly observed: EpisodeConsumptionObservation | null;
  readonly local: LocalListening | null;
}
export interface ListeningFacts {
  readonly account_id: string;
  readonly revision: string;
  readonly episodes: ReadonlyMap<string, ListeningEntry>;
}
/** `current`: no announced revision is newer than `facts`; `error`: the last read failed
 * (unreadable or malformed native data), keeping the last good facts. */
export interface ListeningState {
  readonly facts: ListeningFacts | null;
  readonly current: boolean;
  readonly error: { readonly code: string; readonly message: string } | null;
}

const EMPTY: ListeningState = { facts: null, current: false, error: null };
let state: ListeningState = EMPTY;
let accountId: string | null = null;
let lifetime = 0;
let announced: bigint | null = null;
let flight: Promise<void> | null = null;
const sent = new Map<string, bigint>();
const listeners = new Set<() => void>();
let transport: ((accountId: string, observations: EpisodeConsumptionObservation[]) => Promise<void>) | null = null;

function publish(next: ListeningState): void {
  state = next;
  for (const listener of listeners) listener();
}

const REVISION = /^(0|[1-9][0-9]{0,18})$/;
function expectRevision(raw: unknown, name: string): string {
  const value = expectString(raw, name);
  if (!REVISION.test(value)) throw new TypeError(`${name} must be a decimal revision`);
  return value;
}
const expectNullableInteger = (raw: unknown, name: string) => raw === null ? null : expectInteger(raw, name);

function decodeObservation(raw: unknown, name: string): EpisodeConsumptionObservation {
  const value = expectExactRecord(raw, ["media_id", "consumption_revision", "state"], name);
  const state = expectExactRecord(value.state, ["reset_epoch", "consumption_override_revision", "consumption_override_status",
    "position_ms", "duration_ms", "lectern_member"], `${name}.state`);
  return {
    media_id: expectCanonicalRfcUuid(value.media_id, `${name}.media_id`),
    consumption_revision: expectRevision(value.consumption_revision, `${name}.consumption_revision`),
    state: {
      reset_epoch: expectNonnegativeInteger(state.reset_epoch, `${name}.state.reset_epoch`),
      consumption_override_revision: expectNullableInteger(state.consumption_override_revision, `${name}.state.consumption_override_revision`),
      consumption_override_status: state.consumption_override_status === null ? null
        : expectOneOf(state.consumption_override_status, ["finished", "unread"] as const, `${name}.state.consumption_override_status`),
      position_ms: expectNullableInteger(state.position_ms, `${name}.state.position_ms`),
      duration_ms: expectNullableInteger(state.duration_ms, `${name}.state.duration_ms`),
      lectern_member: expectBoolean(state.lectern_member, `${name}.state.lectern_member`),
    },
  };
}

function decodeLocal(raw: unknown, name: string): LocalListening {
  const value = expectExactRecord(raw, ["sequence", "reset_epoch", "position_ms", "duration_ms", "completed", "terminal", "disposition"], name);
  const terminal = value.terminal === null ? null : expectExactRecord(value.terminal, ["expected_override_revision"], `${name}.terminal`);
  return {
    sequence: expectRevision(value.sequence, `${name}.sequence`),
    reset_epoch: expectNonnegativeInteger(value.reset_epoch, `${name}.reset_epoch`),
    position_ms: expectNonnegativeInteger(value.position_ms, `${name}.position_ms`),
    duration_ms: expectNullableInteger(value.duration_ms, `${name}.duration_ms`),
    completed: expectBoolean(value.completed, `${name}.completed`),
    terminal: terminal === null ? null : { expected_override_revision: expectNullableInteger(terminal.expected_override_revision, `${name}.terminal.expected_override_revision`) },
    disposition: expectOneOf(value.disposition, ["Pending", "SourceUnavailable"] as const, `${name}.disposition`),
  };
}

/** Strict at the native boundary: malformed bytes are a typed local error, never empty facts. */
function decodeFacts(raw: unknown): ListeningFacts {
  const value = expectExactRecord(raw, ["account_id", "revision", "episodes"], "listening");
  const episodes = expectArray(value.episodes, (entry, index) => {
    const row = expectExactRecord(entry, ["media_id", "observed", "local"], `episodes[${index}]`);
    const media_id = expectCanonicalRfcUuid(row.media_id, `episodes[${index}].media_id`);
    const observed = row.observed === null ? null : decodeObservation(row.observed, `episodes[${index}].observed`);
    if (observed !== null && observed.media_id !== media_id) throw new TypeError(`episodes[${index}].observed names another media`);
    return { media_id, observed, local: row.local === null ? null : decodeLocal(row.local, `episodes[${index}].local`) };
  }, "episodes");
  return { account_id: expectCanonicalRfcUuid(value.account_id, "account_id"), revision: expectRevision(value.revision, "revision"),
    episodes: new Map(episodes.map(entry => [entry.media_id, entry])) };
}

/** One flight; it reads until the facts cover the newest announcement or a read fails. */
function read(): Promise<void> {
  if (flight === null && accountId !== null) {
    const mine = lifetime;
    flight = readFacts(mine, accountId).finally(() => { if (mine === lifetime) flight = null; });
  }
  return flight ?? Promise.resolve();
}

async function readFacts(mine: number, account: string): Promise<void> {
  for (;;) {
    const wanted = announced;
    let next: ListeningFacts | { readonly code: string; readonly message: string };
    try {
      const response = await fetch("/_nexus/device/listening.json", { cache: "no-store", headers: { [WIRE_HEADER]: String(WIRE_REVISION) } });
      const body: unknown = await response.json();
      try {
        if (response.ok) next = decodeFacts(body);
        else {
          const error = expectExactRecord(expectExactRecord(body, ["error"], "error body").error, ["code", "message"], "error");
          next = { code: expectString(error.code, "error.code"), message: expectString(error.message, "error.message") };
        }
      } catch {
        next = { code: "E_LOCAL_LISTENING_INVALID", message: "listening progress couldn’t be read" };
      }
    } catch {
      next = { code: "E_LOCAL_LISTENING_IO", message: "listening progress couldn’t be read" };
    }
    if (mine !== lifetime) return;
    // The next committed change or an explicit retry reads again; failed reads keep dated facts, never empty ones.
    if (!("revision" in next)) { publish({ ...state, current: false, error: next }); return; }
    if (next.account_id !== account) return;
    if (state.facts === null || BigInt(next.revision) >= BigInt(state.facts.revision))
      publish({ facts: next, current: announced === null || BigInt(next.revision) >= announced, error: null });
    if (announced === wanted) return;
  }
}

/** Explicit retry after a failed read (the device notice's action); resolves when it settles. */
export async function retryListeningRead(): Promise<void> {
  await flight;
  await read();
}

/** Binds this document's account; retirement drops facts and unsent observation memory. */
export function connectListening(account: string): () => void {
  const mine = ++lifetime;
  accountId = account;
  void read();
  return () => {
    if (mine !== lifetime) return;
    lifetime += 1;
    accountId = null;
    announced = null;
    flight = null;
    sent.clear();
    publish(EMPTY);
  };
}

/** The player adapter's committed-change invalidation (never a clock tick). */
export function announceListeningRevision(revision: string): void {
  const value = BigInt(revision);
  if (announced !== null && value <= announced) return;
  announced = value;
  if (state.facts !== null && BigInt(state.facts.revision) < value) publish({ ...state, current: false });
  void read();
}

/** The native player registers while bound; observations are dropped without it. */
export function setObservationTransport(next: typeof transport): void {
  transport = next;
  if (next !== null) listeningSourceReconnected();
}

/**
 * The native player (re)connected: a failed read retries once at the same committed
 * revision. Same-revision snapshot announcements never retry, so a persistently
 * failing read is not polled; adoption stays monotone through the one read path.
 */
export function listeningSourceReconnected(): void {
  if (state.error !== null) void read();
}

/**
 * Forwards observations for media native retains (listening facts or a download),
 * newer than what it observed and what this document already sent. Frames hold at
 * most 100 observations and 32 KiB; a failed frame is resent by a later reader.
 */
export function observeConsumption(observations: readonly EpisodeConsumptionObservation[]): void {
  const facts = state.facts;
  const send = transport;
  if (facts === null || send === null || accountId !== facts.account_id) return;
  const account = facts.account_id;
  const downloaded = new Set((currentLocalContent().index?.items ?? [])
    .filter(item => item.kind === "podcast_episode").map(item => item.media_id));
  const newest = new Map<string, EpisodeConsumptionObservation>();
  for (const observation of observations) {
    const entry = facts.episodes.get(observation.media_id);
    if (entry === undefined && !downloaded.has(observation.media_id)) continue;
    let known = sent.get(observation.media_id) ?? BigInt(0);
    for (const revision of [entry?.observed?.consumption_revision, newest.get(observation.media_id)?.consumption_revision])
      if (revision !== undefined && BigInt(revision) > known) known = BigInt(revision);
    if (BigInt(observation.consumption_revision) > known) newest.set(observation.media_id, observation);
  }
  // 30 KiB of observations leaves the frame envelope inside native's 32 KiB bound.
  const frames: { observations: EpisodeConsumptionObservation[]; bytes: number }[] = [{ observations: [], bytes: 0 }];
  for (const observation of newest.values()) {
    const bytes = new TextEncoder().encode(JSON.stringify(observation)).byteLength + 1;
    const frame = frames[frames.length - 1]!;
    if (frame.observations.length === 100 || frame.bytes + bytes > 30 * 1024) frames.push({ observations: [observation], bytes });
    else { frame.observations.push(observation); frame.bytes += bytes; }
  }
  for (const { observations: frame } of frames) {
    if (frame.length === 0) continue;
    void send(account, frame).then(() => {
      if (accountId !== account) return;
      for (const observation of frame) {
        const revision = BigInt(observation.consumption_revision);
        if (revision > (sent.get(observation.media_id) ?? BigInt(0))) sent.set(observation.media_id, revision);
      }
    }, () => undefined);
  }
}

/** A list page's consumption revision, carried as its metadata. */
export interface ConsumptionStamp {
  readonly consumption_revision: string;
}
/** A targeted live read and the consumption revision of its one read snapshot. */
export interface StampedRead<T> {
  readonly data: T;
  readonly consumption_revision: string;
}
/** Forwards a stamped response's episode observations; its revision gates group promotion. */
export function stampedRead<T>(body: StampedRead<T> & { readonly episode_consumption: readonly { readonly media_id: string; readonly state: EpisodeConsumptionState }[] }): StampedRead<T> {
  if (body.episode_consumption.length > 0)
    observeConsumption(body.episode_consumption.map(row => ({ media_id: row.media_id, consumption_revision: body.consumption_revision, state: row.state })));
  return { data: body.data, consumption_revision: body.consumption_revision };
}
/** The live value a stamped read carries, keeping its read state. */
export function unstamped<T>(value: ServerValue<StampedRead<T>>): ServerValue<T> {
  return value.status === "ready" ? { ...value, data: value.data.data } : value;
}
/** A list traversal covers only its oldest page's revision. */
export const oldestRevision = (earlier: ConsumptionStamp, later: ConsumptionStamp) =>
  BigInt(later.consumption_revision) < BigInt(earlier.consumption_revision) ? later : earlier;

export function currentListening(): ListeningState {
  return state;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useListening(): ListeningState {
  return useSyncExternalStore(subscribe, currentListening, () => EMPTY);
}

// ---- presentation projection: the consumption owner's rules over dated sources ----

/** What a dated source shows after this device's listening; never a server override. */
export interface EffectiveEpisode {
  readonly status: "finished" | "unread" | null;
  readonly position_ms: number | null;
  readonly duration_ms: number | null;
  readonly lectern_member: boolean;
}

/**
 * Null when the dated source already shows the newest known state. A newer canonical
 * observation replaces the source; unacknowledged activity applies only within its
 * reset epoch (completion is monotone within one: player.md invariant 4), and its
 * natural end only at its captured override revision. Duration is
 * the activity's, else the observed listening record's, else the dated feed's; a known
 * zero stays unknown rather than falling through.
 */
export function effectiveEpisode(
  source: { readonly revision: string; readonly state: EpisodeConsumptionState; readonly source_duration_ms: number | null },
  entry: ListeningEntry | undefined,
): EffectiveEpisode | null {
  if (entry === undefined) return null;
  const newer = entry.observed !== null && BigInt(entry.observed.consumption_revision) > BigInt(source.revision);
  const base = newer ? entry.observed!.state : source.state;
  const local = entry.local !== null && entry.local.reset_epoch === base.reset_epoch ? entry.local : null;
  if (!newer && local === null) return null;
  const ended = local?.terminal != null && local.terminal.expected_override_revision === base.consumption_override_revision;
  return {
    status: local === null ? base.consumption_override_status
      : local.completed || ended || base.consumption_override_status === "finished" ? "finished" : null,
    position_ms: local?.position_ms ?? base.position_ms,
    duration_ms: local?.duration_ms ?? base.duration_ms ?? source.source_duration_ms,
    lectern_member: base.lectern_member && !ended,
  };
}

export function episodeReadState(episode: EffectiveEpisode): "Finished" | "InProgress" | "Unread" {
  if (episode.status === "finished") return "Finished";
  if (episode.status === "unread") return "Unread";
  return (episode.position_ms ?? 0) > 0 ? "InProgress" : "Unread";
}

const knownDuration = (episode: EffectiveEpisode) =>
  episode.duration_ms !== null && episode.duration_ms > 0 ? episode.duration_ms : null;

export function episodeProgress(episode: EffectiveEpisode): number | null {
  const duration = knownDuration(episode);
  return duration === null || episode.position_ms === null ? null
    : Math.min(1, Math.max(0, episode.position_ms / duration));
}

/** The canonical override-independent physical remaining time. */
export function episodeRemainingSeconds(episode: EffectiveEpisode): number | null {
  const duration = knownDuration(episode);
  return duration === null ? null : Math.max(0, duration - (episode.position_ms ?? 0)) / 1000;
}

export function episodeDuration(episode: EffectiveEpisode): Schema<"MediaDurationOut"> | null {
  const duration = knownDuration(episode);
  return duration === null ? null : { modality: "Listen", estimate: {
    total_minutes: Math.ceil(duration / 60_000),
    remaining_minutes: Math.ceil(Math.max(0, duration - (episode.position_ms ?? 0)) / 60_000),
  } };
}

/**
 * A connected live group may replace its dated catalog projection only when no relevant
 * delivery is pending and every contributing part covers the relevant observation floor.
 * Source-unavailable facts never hold a live group. Facts must be read at the newest
 * announced revision, so a fact committed during promotion is not missed.
 */
export function liveGroupCovers(
  listening: ListeningState,
  relevant: (mediaId: string) => boolean,
  revisions: readonly string[],
): boolean {
  // Only the installed app has device listening; until its facts are read nothing is proven.
  if (!installedApp) return true;
  if (listening.facts === null || !listening.current) return false;
  let floor = BigInt(0);
  for (const entry of listening.facts.episodes.values()) {
    if (!relevant(entry.media_id)) continue;
    if (entry.local?.disposition === "Pending") return false;
    if (entry.observed !== null && BigInt(entry.observed.consumption_revision) > floor)
      floor = BigInt(entry.observed.consumption_revision);
  }
  return revisions.every(revision => BigInt(revision) >= floor);
}
