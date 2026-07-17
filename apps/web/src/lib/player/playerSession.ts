/**
 * Pure player-session state machine (spec
 * `docs/cutovers/lectern-player-lifecycle-hard-cutover.md` §1 target-behavior
 * table + §6 "Frontend and UX").
 *
 * This module owns session / origin / history / resume logic with ZERO React and
 * ZERO I/O. Every export is a total function over plain data: given the current
 * state, the current device-local history, and typed inputs, it returns the next
 * state, the next history, and an `effect` describing the audio side-effect the
 * (impure) `GlobalPlayerProvider` must run. Keeping this layer pure makes the
 * whole origin/history/resume contract exhaustively unit-testable without a DOM,
 * a network, or fake timers.
 *
 * History stores DESCRIPTORS only, never a trusted origin (spec §6: "History
 * stores a descriptor, not a trusted origin"). Origin is always re-resolved
 * against the latest canonical `LecternSnapshot` at replay time.
 */

import type { ApiError } from "@/lib/api/client";
import type { Presence } from "@/lib/api/presence";
import type {
  LecternItem,
  LecternItemId,
  LecternSnapshot,
  MediaId,
  PlayerDescriptor,
} from "@/lib/lectern/client";

// --- Session / origin model (spec §6) ---------------------------------------

export type PlaybackPhase = "Playing" | "Paused" | "Buffering";

/**
 * Where the current audio session came from. A `Lectern` origin is bound to an
 * exact `itemId`; `Direct` audio has no Lectern row (or has been downgraded).
 * Only a canonical server install may downgrade a `Lectern` origin, and `Direct`
 * never upgrades until a fresh explicit Play (spec §6, `applySnapshotInstall`).
 */
export type PlayerOrigin =
  | { kind: "Lectern"; itemId: LecternItemId }
  | { kind: "Direct" };

export interface AudioSession {
  descriptor: PlayerDescriptor;
  origin: PlayerOrigin;
}

/** Media-element failure surfaced by the provider (spec §6 `PlayerError`). */
export interface PlayerError {
  code: string;
  message: string;
}

/**
 * The frozen terminal command an ended session runs. `Lectern` origins finish
 * the exact item and request an audio successor; `Direct` origins only record
 * state (spec §1 behavior table + §6 CompletionAttempt bullet).
 */
export type CompletionBody =
  | {
      kind: "FinishLecternItem";
      clientMutationId: string;
      mediaId: MediaId;
      itemId: LecternItemId;
      nextCapability: "FooterAudio";
    }
  | { kind: "EnsureMediaFinished"; clientMutationId: string; mediaId: MediaId };

/**
 * Minted ONCE when an ended session reaches the completion FIFO head. Both ids
 * and the chosen body are stable across Retry (spec §6: "One `CompletionAttempt`
 * mints `exactId` and `fallbackStateOnlyId` once ... and reuses it on Retry").
 * `exactId` keys the primary terminal command; `fallbackStateOnlyId` keys the
 * state-only `EnsureMediaFinished` run after an exact-end `E_NOT_FOUND`.
 */
export interface CompletionAttempt {
  exactId: string;
  fallbackStateOnlyId: string;
  body: CompletionBody;
}

/** Player session lifecycle (spec §6 `PlayerSessionState`). Pure data: the two
 * failure variants carry the raw error only; the provider decorates them with a
 * `retry` callback when it builds the public capability. */
export type PlayerSessionState =
  | { kind: "Absent" }
  | { kind: "Active"; session: AudioSession; phase: PlaybackPhase }
  | { kind: "Completing"; session: AudioSession; attempt: CompletionAttempt }
  | {
      kind: "CompletionFailed";
      session: AudioSession;
      attempt: CompletionAttempt;
      error: ApiError;
    }
  | { kind: "PlaybackFailed"; session: AudioSession; error: PlayerError }
  | { kind: "PausedAtEnd"; session: AudioSession };

// --- History + resume overlay -----------------------------------------------

/** Device-local navigation stacks. Both are LIFO: Previous pops `back` / pushes
 * `forward`; Next pops `forward` / pushes `back` (spec §6). */
export interface PlayerHistory {
  back: PlayerDescriptor[];
  forward: PlayerDescriptor[];
}

export const EMPTY_HISTORY: PlayerHistory = { back: [], forward: [] };

/** Provider-lifetime resume overlay entry (spec §6 resume-authority bullet). */
export interface OverlayEntry {
  positionMs: number;
  writeRevision: number;
  resetEpoch: number;
}

/** Manual Previous restarts the current audio strictly AFTER this many ms; at or
 * below it, Previous navigates device history (spec §1: "Previous restarts
 * current audio after three seconds"). */
export const PREVIOUS_RESTART_THRESHOLD_MS = 3000;

// --- Transition results ------------------------------------------------------

/** The audio side-effect a transition asks the provider to run. `StartSession`
 * loads `state.session.descriptor` from its resume position (via
 * {@link getStartPositionMs}); `RestartCurrent` seeks the active session to 0. */
export type PlaybackEffect =
  | { kind: "None" }
  | { kind: "StartSession" }
  | { kind: "RestartCurrent" };

export interface SessionTransition {
  state: PlayerSessionState;
  history: PlayerHistory;
  effect: PlaybackEffect;
}

// --- Internal helpers --------------------------------------------------------

function assertNever(value: never): never {
  throw new Error(`Unreachable player-session variant: ${JSON.stringify(value)}`);
}

/** The audio session a state carries, or `undefined` when Absent. */
function sessionOf(state: PlayerSessionState): AudioSession | undefined {
  switch (state.kind) {
    case "Absent":
      return undefined;
    case "Active":
    case "Completing":
    case "CompletionFailed":
    case "PlaybackFailed":
    case "PausedAtEnd":
      return state.session;
    default:
      return assertNever(state);
  }
}

function activeFrom(session: AudioSession): PlayerSessionState {
  return { kind: "Active", session, phase: "Buffering" };
}

/**
 * Build a `PlayerDescriptor` from a Lectern row. The row MUST be footer-playable;
 * calling this on a `Readable`/`OpenPane` row is a same-system defect because
 * only `FooterAudio` rows are ever selected as audio successors (spec §4:
 * "`FooterAudio` is the only footer-playable activation").
 */
export function descriptorFromLecternItem(item: LecternItem): PlayerDescriptor {
  if (item.activation.kind !== "FooterAudio") {
    throw new Error(
      `descriptorFromLecternItem requires FooterAudio, got ${item.activation.kind} (defect).`,
    );
  }
  return {
    mediaId: item.mediaId,
    title: item.title,
    subtitle: item.subtitle,
    activation: item.activation,
  };
}

// --- Origin resolution (spec §6 "Every Play ... resolves origin") -----------

/**
 * Resolve the origin for a descriptor about to play. When the snapshot contains
 * a row for this media, the origin is `Lectern`; otherwise `Direct`. When
 * multiple rows share the media, the exact `itemIdHint` (present when the Play
 * came from a specific Lectern row) wins, else the first matching row is used.
 */
export function resolveOriginForPlay(
  descriptor: PlayerDescriptor,
  snapshot: LecternSnapshot,
  itemIdHint?: LecternItemId,
): PlayerOrigin {
  const matches = snapshot.items.filter((item) => item.mediaId === descriptor.mediaId);
  if (matches.length === 0) return { kind: "Direct" };
  if (itemIdHint !== undefined) {
    const hinted = matches.find((item) => item.itemId === itemIdHint);
    if (hinted !== undefined) return { kind: "Lectern", itemId: hinted.itemId };
  }
  return { kind: "Lectern", itemId: matches[0].itemId };
}

/** Downgrade a `Lectern` origin to `Direct` when its item is gone or its media
 * no longer matches; preserve it when the row merely moved; never upgrade a
 * `Direct` origin (spec §6 origin-maintenance bullet). */
function maintainOrigin(session: AudioSession, snapshot: LecternSnapshot): AudioSession {
  const origin = session.origin;
  if (origin.kind === "Direct") return session;
  const item = snapshot.items.find((row) => row.itemId === origin.itemId);
  if (item !== undefined && item.mediaId === session.descriptor.mediaId) return session;
  return { descriptor: session.descriptor, origin: { kind: "Direct" } };
}

// --- Explicit Play (spec §6: replaces a DIFFERENT current session) ----------

/**
 * Explicit Play of `descriptor`. Resolves origin against the latest snapshot and
 * begins a fresh `Active` session. When it replaces a DIFFERENT current session
 * (different media), the outgoing descriptor is pushed to `back` and `forward`
 * is cleared; replaying the same media (e.g. from `PausedAtEnd`) starts a new
 * session but leaves history untouched. This also covers the `PausedAtEnd` ->
 * play-a-new-session rule (spec §6).
 */
export function playExplicit(
  state: PlayerSessionState,
  history: PlayerHistory,
  descriptor: PlayerDescriptor,
  snapshot: LecternSnapshot,
  itemIdHint?: LecternItemId,
): SessionTransition {
  const session: AudioSession = {
    descriptor,
    origin: resolveOriginForPlay(descriptor, snapshot, itemIdHint),
  };
  const current = sessionOf(state);
  const replacesDifferent =
    current !== undefined && current.descriptor.mediaId !== descriptor.mediaId;
  const nextHistory: PlayerHistory = replacesDifferent
    ? { back: [...history.back, current.descriptor], forward: [] }
    : history;
  return { state: activeFrom(session), history: nextHistory, effect: { kind: "StartSession" } };
}

// --- Previous (spec §1 + §6) -------------------------------------------------

/**
 * Manual Previous. Strictly after {@link PREVIOUS_RESTART_THRESHOLD_MS} (or with
 * an empty back stack) it restarts the current audio; at or below it, it pops
 * `back`, pushes the current descriptor to `forward`, and re-resolves the popped
 * descriptor's origin from the snapshot. No current session -> no-op.
 */
export function previous(
  state: PlayerSessionState,
  history: PlayerHistory,
  currentPositionMs: number,
  snapshot: LecternSnapshot,
): SessionTransition {
  const current = sessionOf(state);
  if (current === undefined) return { state, history, effect: { kind: "None" } };

  if (currentPositionMs > PREVIOUS_RESTART_THRESHOLD_MS || history.back.length === 0) {
    return { state: activeFrom(current), history, effect: { kind: "RestartCurrent" } };
  }

  const poppedDescriptor = history.back[history.back.length - 1];
  const back = history.back.slice(0, -1);
  const session: AudioSession = {
    descriptor: poppedDescriptor,
    origin: resolveOriginForPlay(poppedDescriptor, snapshot),
  };
  return {
    state: activeFrom(session),
    history: { back, forward: [...history.forward, current.descriptor] },
    effect: { kind: "StartSession" },
  };
}

// --- Manual Next (spec §1 "Early Next" + §6 suffix rule) --------------------

/** First footer-playable row strictly after the current origin's item (or from
 * the head for `Direct`), excluding the current media, with no wrap. */
function selectSuffixAudio(
  current: AudioSession,
  snapshot: LecternSnapshot,
): LecternItem | undefined {
  const items = snapshot.items;
  const originItemId = current.origin.kind === "Lectern" ? current.origin.itemId : undefined;
  let startIndex = 0;
  if (originItemId !== undefined) {
    const originIndex = items.findIndex((item) => item.itemId === originItemId);
    if (originIndex >= 0) startIndex = originIndex + 1;
  }
  for (let index = startIndex; index < items.length; index += 1) {
    const item = items[index];
    if (item.activation.kind === "FooterAudio" && item.mediaId !== current.descriptor.mediaId) {
      return item;
    }
  }
  return undefined;
}

/**
 * Manual Next. Pops `forward` when present (pushing the current descriptor to
 * `back`, re-resolving the popped origin); otherwise selects the first footer
 * audio after an exact origin (or from the head for `Direct`), excluding the
 * current media, with no wrap. When neither yields a candidate the effect is
 * `None` (the "returns none" case). The suffix branch is a non-history
 * replacement, so it pushes the outgoing descriptor to `back` and clears
 * `forward` (spec §6).
 */
export function manualNext(
  state: PlayerSessionState,
  history: PlayerHistory,
  snapshot: LecternSnapshot,
): SessionTransition {
  const current = sessionOf(state);
  if (current === undefined) return { state, history, effect: { kind: "None" } };

  if (history.forward.length > 0) {
    const poppedDescriptor = history.forward[history.forward.length - 1];
    const forward = history.forward.slice(0, -1);
    const session: AudioSession = {
      descriptor: poppedDescriptor,
      origin: resolveOriginForPlay(poppedDescriptor, snapshot),
    };
    return {
      state: activeFrom(session),
      history: { back: [...history.back, current.descriptor], forward },
      effect: { kind: "StartSession" },
    };
  }

  const nextItem = selectSuffixAudio(current, snapshot);
  if (nextItem === undefined) return { state, history, effect: { kind: "None" } };
  const session: AudioSession = {
    descriptor: descriptorFromLecternItem(nextItem),
    origin: { kind: "Lectern", itemId: nextItem.itemId },
  };
  return {
    state: activeFrom(session),
    history: { back: [...history.back, current.descriptor], forward: [] },
    effect: { kind: "StartSession" },
  };
}

// --- Manual-Next preview (spec §6 footer "Next on the Lectern" line) --------

/**
 * The presentation-only preview of the *actual* manual-Next target, computed by
 * the same head/suffix rule {@link manualNext} uses so the footer never
 * duplicates the selection logic. A pending forward entry wins ("Forward"); else
 * the first footer audio after an exact origin ("Lectern"); else "None". Purely
 * derived from current state — it moves nothing.
 */
export type NextPreview =
  | { kind: "None" }
  | { kind: "Forward"; descriptor: PlayerDescriptor }
  | { kind: "Lectern"; descriptor: PlayerDescriptor };

export function previewNextDescriptor(
  state: PlayerSessionState,
  history: PlayerHistory,
  snapshot: LecternSnapshot,
): NextPreview {
  const current = sessionOf(state);
  if (current === undefined) return { kind: "None" };
  if (history.forward.length > 0) {
    return { kind: "Forward", descriptor: history.forward[history.forward.length - 1] };
  }
  const nextItem = selectSuffixAudio(current, snapshot);
  if (nextItem === undefined) return { kind: "None" };
  return { kind: "Lectern", descriptor: descriptorFromLecternItem(nextItem) };
}

// --- Natural end advance (spec §1 + §6 "Natural end never consumes forward") -

/**
 * After a Lectern-origin terminal command succeeds, advance to the server-
 * selected `nextItem`. Automatic advance is a session-replacing non-history
 * action (spec §6): it pushes the outgoing (ended) descriptor to `back` and
 * clears `forward` — natural end never *consumes* forward history (it does not
 * pop-navigate to a forward entry), it invalidates it. With no successor the
 * ended session is retained `PausedAtEnd` and history is untouched (spec §1
 * "Direct audio ends -> paused at end"; §8.1 "no successor ... retain
 * PausedAtEnd").
 */
export function naturalEndAdvance(
  session: AudioSession,
  history: PlayerHistory,
  nextItem: Presence<LecternItem>,
): SessionTransition {
  if (nextItem.kind === "Present") {
    const item = nextItem.value;
    const nextSession: AudioSession = {
      descriptor: descriptorFromLecternItem(item),
      origin: { kind: "Lectern", itemId: item.itemId },
    };
    return {
      state: activeFrom(nextSession),
      history: { back: [...history.back, session.descriptor], forward: [] },
      effect: { kind: "StartSession" },
    };
  }
  return { state: { kind: "PausedAtEnd", session }, history, effect: { kind: "None" } };
}

// --- Canonical snapshot install (spec §6 origin maintenance) ----------------

/**
 * Canonical-install origin maintenance. Re-checks the current session's origin
 * against a freshly installed canonical snapshot: a `Lectern` origin downgrades
 * to `Direct` only when its item is gone or its media mismatches; a moved item
 * preserves the origin; `Direct` never upgrades. There is intentionally NO
 * parameter for an optimistic snapshot — the API shape makes it impossible to
 * downgrade an origin from optimistic (Remove/reorder) presentation, so a rolled
 * back Remove preserves the exact origin (spec §6).
 */
export function applySnapshotInstall(
  state: PlayerSessionState,
  snapshot: LecternSnapshot,
): PlayerSessionState {
  switch (state.kind) {
    case "Absent":
      return state;
    case "Active":
      return { ...state, session: maintainOrigin(state.session, snapshot) };
    case "Completing":
      return { ...state, session: maintainOrigin(state.session, snapshot) };
    case "CompletionFailed":
      return { ...state, session: maintainOrigin(state.session, snapshot) };
    case "PlaybackFailed":
      return { ...state, session: maintainOrigin(state.session, snapshot) };
    case "PausedAtEnd":
      return { ...state, session: maintainOrigin(state.session, snapshot) };
    default:
      return assertNever(state);
  }
}

// --- Resume authority (spec §6 resume-authority bullet) ---------------------

/**
 * Resume position for a media about to start. Precedence: a `finishedOverride`
 * (Finished / re-added-finished zero-start) forces 0; else the provider-lifetime
 * overlay entry; else the latest snapshot `FooterAudio` position; else 0. This
 * "replaces absence rather than clearing to a stale fallback" so history replay
 * cannot be rewound by a stale snapshot.
 */
export function getStartPositionMs(
  mediaId: MediaId,
  options: { finishedOverride: boolean },
  overlay: ReadonlyMap<MediaId, OverlayEntry>,
  snapshot: LecternSnapshot,
): number {
  if (options.finishedOverride) return 0;
  const entry = overlay.get(mediaId);
  if (entry !== undefined) return entry.positionMs;
  const item = snapshot.items.find(
    (row) => row.mediaId === mediaId && row.activation.kind === "FooterAudio",
  );
  if (item !== undefined && item.activation.kind === "FooterAudio") {
    return item.activation.positionMs;
  }
  return 0;
}

// --- Completion attempt minting (spec §6 CompletionAttempt bullet) ----------

/**
 * Mint the completion attempt for an ended session. `mintId` is caller-injected
 * (the provider passes `crypto.randomUUID`) so the identity is deterministic in
 * tests. The chosen body is frozen: a `Lectern` origin finishes the exact item
 * (requesting a `FooterAudio` successor); a `Direct` origin records media
 * Finished. `exactId` keys the body's command; `fallbackStateOnlyId` is reserved
 * for the post-`E_NOT_FOUND` state-only `EnsureMediaFinished`.
 */
export function mintCompletionAttempt(
  session: AudioSession,
  mintId: () => string,
): CompletionAttempt {
  const exactId = mintId();
  const fallbackStateOnlyId = mintId();
  const origin = session.origin;
  const body: CompletionBody =
    origin.kind === "Lectern"
      ? {
          kind: "FinishLecternItem",
          clientMutationId: exactId,
          mediaId: session.descriptor.mediaId,
          itemId: origin.itemId,
          nextCapability: "FooterAudio",
        }
      : {
          kind: "EnsureMediaFinished",
          clientMutationId: exactId,
          mediaId: session.descriptor.mediaId,
        };
  return Object.freeze({ exactId, fallbackStateOnlyId, body: Object.freeze(body) });
}

/**
 * Whether a completion-command `clientMutationId` belongs to a given attempt —
 * i.e. it is that attempt's primary `exactId` or its `fallbackStateOnlyId`. Used
 * by the provider to derive `CompletionFailed` from a parked FIFO failure, and by
 * the shell mutation notice to suppress its banner for a completion attempt the
 * player dock already surfaces (spec §6 CompletionAttempt bullet).
 */
export function mutationMatchesAttempt(
  clientMutationId: string,
  attempt: CompletionAttempt,
): boolean {
  return clientMutationId === attempt.exactId || clientMutationId === attempt.fallbackStateOnlyId;
}
