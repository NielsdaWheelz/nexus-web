/**
 * What the playback bar shows: one total, pure reading of the player session and of the stored
 * summary of the episode it names, with no clock. Leaves render a mode; the root reads the session
 * and that one summary. Pointer geometry and the folio's grammar live here too, so hover, drag and
 * commit share one mapping and every surface prints time left one way.
 */
import { assertNever } from "@/lib/assertNever";
import type { MediaSummary } from "@/lib/media/mediaSummary";
import type { PlayerSession, PlayerState } from "./playerRuntime";

type Loaded = Extract<PlayerState, { kind: "Loaded" }>;

/** An episode at rest, as its stored summary names it. */
export interface BarSubject {
  readonly mediaId: string;
  readonly title: string;
  readonly show: string | null;
  readonly imageUrl: string | null;
  readonly progress: number | null;
  readonly remainingMinutes: number | null;
}

/** The summary read for `barSubjectId`; an absent subject reads as a ready null. */
export type SubjectRead = { readonly kind: "Pending" } | { readonly kind: "Ready"; readonly summary: MediaSummary | null };

/** While pending the bar paints a frame and no text, so a reload never names a state before its
 * episode. Unnamed: no subject, or its read found none or failed. */
export type Episode = { readonly kind: "Pending" } | { readonly kind: "Unnamed" } | ({ readonly kind: "Named" } & BarSubject);

export type BarKey = "previous" | "back" | "disc" | "forward" | "next" | "speed" | "chapters" | "upNext" | "more";

/** `Unknown`'s read: in flight, failed with no other owner (up next's panel retries it), or
 * refused with an error whose feedback already says so. */
export type BarMode =
  | { readonly kind: "Unknown"; readonly read: "Loading" | "Failed" | "Reported" }
  | { readonly kind: "Empty" }
  | { readonly kind: "UpdateRequired" }
  | { readonly kind: "Finished"; readonly count: number }
  | { readonly kind: "Stopped"; readonly episode: Episode; readonly index: number | null; readonly count: number }
  | { readonly kind: "Starting"; readonly episode: Episode }
  | { readonly kind: "Advancing"; readonly loaded: Loaded }
  | { readonly kind: "Active"; readonly loaded: Loaded; readonly failed: boolean }
  | { readonly kind: "NotResponding"; readonly episode: Episode };

/** The media a subjectless mode names: the cursor at rest and while the native player is silent,
 * the admitted start while it starts. A loaded bar names its descriptor instead. */
export function barSubjectId({ state, queue, pendingPlayback }: PlayerSession): string | null {
  switch (state.kind) {
    case "Loaded": return null;
    case "Unavailable": return state.reason === "NotResponding" ? queue.header?.current_entry?.media_id ?? null : null;
    case "Absent": return pendingPlayback?.mediaId ?? (queue.known ? queue.header?.current_entry?.media_id ?? null : null);
    default: return assertNever(state);
  }
}

function episode(read: SubjectRead): Episode {
  if (read.kind === "Pending") return { kind: "Pending" };
  const summary = read.summary;
  if (summary === null) return { kind: "Unnamed" };
  return {
    kind: "Named", mediaId: summary.media_id, title: summary.title, show: summary.show?.title ?? null,
    imageUrl: summary.show?.image_url ?? null, progress: summary.consumption.progress,
    remainingMinutes: summary.duration?.estimate.remaining_minutes ?? null,
  };
}

/** Total over the session; first match wins (SPEC.md modes). `read` is the summary of
 * `barSubjectId(session)`. */
export function barMode(session: PlayerSession, read: SubjectRead): BarMode {
  const { state, queue, pendingPlayback, playbackSubject } = session;
  switch (state.kind) {
    case "Unavailable":
      return state.reason === "UpdateRequired" ? { kind: "UpdateRequired" } : { kind: "NotResponding", episode: episode(read) };
    case "Loaded":
      if (playbackSubject === null || pendingPlayback !== null && pendingPlayback.mediaId !== state.source.descriptor.media_id)
        return { kind: "Advancing", loaded: state };
      return { kind: "Active", loaded: state, failed: state.playbackFailed || state.error !== null };
    case "Absent": {
      if (pendingPlayback !== null) return { kind: "Starting", episode: episode(read) };
      if (!queue.known)
        return { kind: "Unknown", read: queue.error !== null ? "Reported" : queue.index.kind === "Failed" ? "Failed" : "Loading" };
      const header = queue.header;
      if (header === null || header.count === 0) return { kind: "Empty" };
      if (header.current_entry_id === null) return { kind: "Finished", count: header.count };
      return { kind: "Stopped", episode: episode(read), index: header.current_index, count: header.count };
    }
    default: return assertNever(state);
  }
}

const ALL: readonly BarKey[] = ["previous", "back", "disc", "forward", "next", "speed", "chapters", "upNext", "more"];

/** The keys a mode offers, each enabled unless its precondition fails. A key absent from the map
 * holds its slot unpainted; a disabled one stays focusable (`aria-disabled`). Every enhancement
 * degrades to absence: an episode without chapters has no chapters key. */
export function liveKeys(mode: BarMode, session: PlayerSession): ReadonlyMap<BarKey, "Enabled" | "Disabled"> {
  const { queue, preferences, playbackSubject } = session;
  const header = queue.header;
  const ready = queue.known && queue.phase === "Ready";
  const keys = new Map<BarKey, "Enabled" | "Disabled">();
  const offer = (key: BarKey, enabled: boolean) => keys.set(key, enabled ? "Enabled" : "Disabled");
  const nextEntry = ready && header !== null && header.current_index !== null && header.current_index + 1 < header.count;
  switch (mode.kind) {
    case "Unknown": if (mode.read === "Failed") offer("upNext", true); break;
    case "Empty": offer("upNext", true); break;
    case "UpdateRequired": case "NotResponding": break;
    case "Finished": offer("previous", ready); offer("upNext", true); break;
    case "Stopped":
      // previous with nothing loaded steps the cursor; at the first entry it would restart an
      // absent engine, which refuses.
      offer("previous", ready && mode.index !== null && mode.index > 0);
      offer("disc", ready);
      offer("next", nextEntry);
      offer("upNext", true);
      break;
    case "Starting": offer("disc", true); offer("upNext", true); break;
    case "Advancing":
      for (const key of ALL) if (key !== "chapters" || mode.loaded.source.descriptor.chapters.length > 0) offer(key, key === "disc" || key === "upNext");
      break;
    case "Active": {
      const subject = playbackSubject !== null;
      offer("previous", ready && header !== null && header.count > 0);
      offer("back", subject);
      offer("disc", true);
      offer("forward", subject);
      offer("next", nextEntry);
      offer("speed", subject && preferences !== null);
      if (mode.loaded.source.descriptor.chapters.length > 0) offer("chapters", subject);
      offer("upNext", true);
      offer("more", true);
      break;
    }
    default: assertNever(mode);
  }
  return keys;
}

type MiniKey = Extract<BarKey, "upNext" | "disc">;

/** The mini's two keys: the disc rightmost, up next beside it only while nothing sounds. */
export function miniKeys(mode: BarMode): ReadonlySet<MiniKey> {
  const keys = (...names: MiniKey[]): ReadonlySet<MiniKey> => new Set(names);
  switch (mode.kind) {
    case "Unknown": return mode.read === "Failed" ? keys("upNext") : keys();
    case "UpdateRequired": case "NotResponding": return keys();
    case "Empty": case "Finished": return keys("upNext");
    case "Starting": case "Advancing": return keys("disc");
    case "Stopped": return keys("upNext", "disc");
    case "Active":
      return !mode.failed && (mode.loaded.phase === "Playing" || mode.loaded.phase === "Buffering") ? keys("disc") : keys("upNext", "disc");
    default: return assertNever(mode);
  }
}

/** What the rule and the folio read: the clock of a confirmed load (seekable) or of one being
 * replaced (held), else a still progress and the summary's minutes left at 1×. */
export type BarClock =
  | { readonly kind: "Live"; readonly loaded: Loaded; readonly seekable: boolean }
  | { readonly kind: "Still"; readonly progress: number | null; readonly remainingMinutes: number | null };

export function barClock(mode: BarMode): BarClock {
  switch (mode.kind) {
    case "Active": return { kind: "Live", loaded: mode.loaded, seekable: true };
    case "Advancing": return { kind: "Live", loaded: mode.loaded, seekable: false };
    case "Finished": return { kind: "Still", progress: 1, remainingMinutes: null };
    case "Stopped":
      return mode.episode.kind === "Named" ? { kind: "Still", progress: mode.episode.progress, remainingMinutes: mode.episode.remainingMinutes }
        : { kind: "Still", progress: null, remainingMinutes: null };
    case "Unknown": case "Empty": case "UpdateRequired": case "Starting": case "NotResponding":
      return { kind: "Still", progress: null, remainingMinutes: null };
    default: return assertNever(mode);
  }
}

/** One mapping from a pointer to media time for hover, drag and commit. Within `reachPx` of a drawn
 * start the nearest start wins, so the preview names what the release will land on. */
export function positionAt(x: number, width: number, durationMs: number, snaps: readonly number[], reachPx: number): { positionMs: number; snapped: boolean } {
  if (width <= 0 || durationMs <= 0) return { positionMs: 0, snapped: false };
  const clamped = Math.min(width, Math.max(0, x));
  let nearest: { startMs: number; distance: number } | null = null;
  for (const startMs of snaps) {
    const distance = Math.abs((startMs / durationMs) * width - clamped);
    if (distance <= reachPx && (nearest === null || distance < nearest.distance)) nearest = { startMs, distance };
  }
  return nearest !== null ? { positionMs: nearest.startMs, snapped: true } : { positionMs: (clamped * durationMs) / width, snapped: false };
}

/** Time left in your time: media time at `rate`, ceiled to the minute as the server ceils
 * `remaining_minutes`, so it never claims less than remains. Your time falls at wall speed at any
 * steady rate, so unattended the text changes once a minute. Minutes are padded past the hour so
 * the right-aligned folio keeps one width. */
export function folioRest(remainingMs: number, rate: number, approximate: boolean): string {
  const minutes = Math.ceil(Math.max(0, remainingMs) / rate / 60_000);
  const left = minutes < 60 ? `${minutes}m left` : `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m left`;
  return approximate ? `≈ ${left}` : left;
}
