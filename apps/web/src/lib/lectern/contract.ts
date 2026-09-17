/**
 * Pure Lectern + consumption wire contract (spec
 * `docs/cutovers/lectern-player-lifecycle-hard-cutover.md` §4/§5).
 *
 * This is the ONE isomorphic owner of Lectern wire types and strict decoders.
 * It imports no HTTP transport, browser-only module, or server-only module, so
 * server seeding and client fetches decode the same contract without crossing
 * runtime boundaries. A shape violation is a code/schema-mismatch defect, not
 * a modelable branch.
 *
 * Decoder policy: every object shape is *exact-key* — a missing or an
 * unknown key throws. Discriminator `kind` values are the exact PascalCase
 * literals; alternate casing throws. Owned absence is `Presence<T>`
 * (`decodePresence`); `null`/omission/alternate casing throw. Bounded ranges
 * from the contract are enforced at decode (snapshot ≤ 2000 items,
 * chapters ≤ 100, chapter title 1..300, progress a finite
 * fraction in 0..1, `*Ms`/revision/epoch integers).
 */

import { decodePresence, type Presence } from "@/lib/api/presence";
import {
  decodeCollectionRevision,
  type CollectionRevision,
} from "@/lib/api/collectionPage";
import type {
  PositiveMinutes,
  ProgressFraction,
} from "@/lib/consumption/activityFacts";
import type { ResourceActionSubject } from "@/lib/resources/resourceActionTarget";
import { canonicalResourceRef } from "@/lib/sharing/targets";
import {
  parseReaderCursorSnapshot,
  type ReaderCursorSnapshot,
} from "@/lib/reader/readerProgress";
import { parsePlaybackRate } from "@/lib/player/playbackRate";
import {
  parsePauseShorteningMode,
  type PauseShorteningMode,
} from "@/lib/player/pauseShortening";
import {
  expectBoolean,
  expectExactRecord,
  expectFiniteNumber,
  expectIsoInstant,
  expectOneOf,
  expectRecord,
  expectString,
  isCanonicalUuid,
} from "@/lib/validation";
import { MEDIA_KINDS, type MediaKind } from "@/lib/media/kind";
import { normalizeWorkspaceHref } from "@/lib/workspace/workspaceHref";

// --- Branded identities ------------------------------------------------------
//
// The cutover preserves the existing raw media/item UUID wire families and
// decodes each into a distinct branded type (spec §4 "Bounded identity
// exception"). Sealed handles are named follow-up debt, not this cutover.
// `parseX`/`assumeX` mirror `lib/contributors/handle.ts`: both validate and
// throw; `parse*` is the wire-ingress name used by decoders, `assume*` is the
// already-canonical name used by callers holding a known-good string.

export type MediaId = string & { readonly __mediaId: unique symbol };
export type LecternItemId = string & { readonly __lecternItemId: unique symbol };
export type CompletionHandle = string & { readonly __completionHandle: unique symbol };

/** Server-produced in-app path (leading "/"), branded so leaves cannot pass a raw string. */
export type AppHref = string & { readonly __appHref: unique symbol };

export function parseMediaId(value: string): MediaId {
  if (!isCanonicalUuid(value)) {
    throw new Error(`Invalid MediaId: ${JSON.stringify(value)}`);
  }
  return value as MediaId;
}

export function assumeMediaId(value: string): MediaId {
  if (!isCanonicalUuid(value)) {
    throw new Error(`Non-canonical MediaId: ${JSON.stringify(value)}`);
  }
  return value as MediaId;
}

export function parseLecternItemId(value: string): LecternItemId {
  if (!isCanonicalUuid(value)) {
    throw new Error(`Invalid LecternItemId: ${JSON.stringify(value)}`);
  }
  return value as LecternItemId;
}

export function assumeLecternItemId(value: string): LecternItemId {
  if (!isCanonicalUuid(value)) {
    throw new Error(`Non-canonical LecternItemId: ${JSON.stringify(value)}`);
  }
  return value as LecternItemId;
}

export function parseCompletionHandle(value: string): CompletionHandle {
  if (!/^ncc1\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{22}$/.test(value)) {
    throw new Error(`Invalid CompletionHandle: ${JSON.stringify(value)}`);
  }
  return value as CompletionHandle;
}

export function assumeAppHref(value: string): AppHref {
  const normalized = normalizeWorkspaceHref(value);
  if (!value.startsWith("/") || normalized !== value) {
    throw new Error(`Non-canonical AppHref: ${JSON.stringify(value)}`);
  }
  return value as AppHref;
}

// --- Decoded domain types ----------------------------------------------------

export type ConsumptionState = "Unread" | "InProgress" | "Finished";

export interface ConsumptionInfo {
  state: ConsumptionState;
  progress: Presence<number>;
  progressResettable: boolean;
}

export interface ChapterOut {
  title: string;
  startMs: number;
  endMs: Presence<number>;
}

export interface FooterAudioActivation {
  kind: "FooterAudio";
  streamUrl: string;
  sourceUrl: string;
  positionMs: number;
  writeRevision: number;
  resetEpoch: number;
  playbackRate: PlaybackRateResolution;
  pauseShorteningMode: Presence<PauseShorteningMode>;
  consumptionOverrideRevision: Presence<number>;
  durationMs: Presence<number>;
  artworkUrl: Presence<string>;
  chapters: ChapterOut[];
}

export type Activation =
  | FooterAudioActivation
  | { kind: "Readable" }
  | { kind: "OpenPane" };

export interface LecternItem {
  itemId: LecternItemId;
  mediaId: MediaId;
  kind: MediaKind;
  title: string;
  subtitle: Presence<string>;
  href: AppHref;
  /** ISO 8601 aware instant this row joined the Lectern (the Added sort key). */
  addedAt: string;
  consumption: ConsumptionInfo;
  activation: Activation;
  actionSubject: ResourceActionSubject;
}

export interface LecternActivityFacts {
  totalMinutes: Presence<PositiveMinutes>;
  fraction: Presence<ProgressFraction>;
  remainingMinutes: Presence<PositiveMinutes>;
}

export function lecternActivityFacts(item: LecternItem): LecternActivityFacts {
  const fraction =
    item.consumption.progress.kind === "Present"
      ? {
          kind: "Present" as const,
          value: { value: item.consumption.progress.value },
        }
      : { kind: "Absent" as const };
  if (
    item.activation.kind !== "FooterAudio" ||
    item.activation.durationMs.kind === "Absent"
  ) {
    return {
      totalMinutes: { kind: "Absent" },
      fraction,
      remainingMinutes: { kind: "Absent" },
    };
  }
  const durationMs = item.activation.durationMs.value;
  if (durationMs <= 0 || item.activation.positionMs > durationMs) {
    throw new TypeError(
      "Lectern FooterAudio duration must be positive and at least positionMs",
    );
  }
  const remainingMs = durationMs - item.activation.positionMs;
  return {
    totalMinutes: {
      kind: "Present",
      value: { value: Math.ceil(durationMs / 60_000) },
    },
    fraction,
    remainingMinutes:
      remainingMs > 0
        ? {
            kind: "Present",
            value: { value: Math.ceil(remainingMs / 60_000) },
          }
        : { kind: "Absent" },
  };
}

export interface LecternSnapshot {
  items: LecternItem[];
}

/** Derived from a `LecternItem`/media/podcast DTO whose activation is `FooterAudio`. */
export interface PlayerDescriptor {
  mediaId: MediaId;
  title: string;
  subtitle: Presence<string>;
  activation: FooterAudioActivation;
}

export interface PlaybackRateResolution {
  value: number;
  source: "Episode" | "Podcast" | "Product";
  podcastPreference: Presence<{
    podcastId: string;
    value: Presence<number>;
  }>;
}

export interface ListeningStateOut {
  positionMs: number;
  durationMs: Presence<number>;
  episodePlaybackRate: Presence<number>;
  writeRevision: number;
  resetEpoch: number;
}

/** Canonical current-progress snapshot returned only by `ResetProgress`. */
export interface MediaProgressState {
  mediaId: MediaId;
  readerCursor: ReaderCursorSnapshot;
  listeningState: Presence<ListeningStateOut>;
}

// --- Command types (wire: camelCase keys, PascalCase kinds) -------------------

export type Placement =
  | { kind: "First" }
  | { kind: "After"; itemId: LecternItemId }
  | { kind: "Last" };

export type NextCapability = "Stop" | "FooterAudio" | "Readable";

export interface NaturalEndTerminalListening {
  positionMs: number;
  durationMs: Presence<number>;
  episodePlaybackRate: Presence<number>;
  expectedWriteRevision: number;
  expectedResetEpoch: number;
}

export interface NaturalEndSettlement {
  clientMutationId: string;
  mediaId: MediaId;
  origin:
    | { kind: "Direct" }
    | { kind: "Lectern"; itemId: LecternItemId };
  terminalListening: NaturalEndTerminalListening;
  expectedConsumptionOverrideRevision: Presence<number>;
}

export type LecternCommand =
  | { kind: "PlaceItems"; clientMutationId: string; mediaIds: MediaId[]; placement: Placement }
  | { kind: "RemoveItem"; clientMutationId: string; itemId: LecternItemId }
  | { kind: "SetOrder"; clientMutationId: string; itemIds: LecternItemId[] };

export type ConsumptionCommand =
  | { kind: "EnsureMediaFinished"; clientMutationId: string; mediaId: MediaId }
  | {
      kind: "FinishLecternItem";
      clientMutationId: string;
      mediaId: MediaId;
      itemId: LecternItemId;
      nextCapability: NextCapability;
    }
  | {
      kind: "SettleNaturalEnd";
      clientMutationId: string;
      mediaId: MediaId;
      origin:
        | { kind: "Direct" }
        | { kind: "Lectern"; itemId: LecternItemId };
      terminalListening: NaturalEndTerminalListening;
      expectedConsumptionOverrideRevision: Presence<number>;
      nextCapability: "FooterAudio";
    }
  | { kind: "SetUnread"; clientMutationId: string; mediaId: MediaId }
  | { kind: "ResetProgress"; clientMutationId: string; mediaId: MediaId }
  | {
      kind: "UndoCompletion";
      clientMutationId: string;
      completionHandle: CompletionHandle;
    }
  | {
      kind: "SetBatchState";
      clientMutationId: string;
      mediaIds: MediaId[];
      state: "Finished" | "Unread";
    };

export type LecternOutcome =
  | { kind: "Placed"; itemIds: LecternItemId[] }
  | { kind: "Removed"; itemId: LecternItemId }
  | { kind: "Ordered" };

export interface LecternResult {
  outcome: LecternOutcome;
  lectern: LecternSnapshot;
}

export type ConsumptionOutcome =
  | { kind: "StateOnly" }
  | { kind: "Removed"; itemId: LecternItemId; nextItemId: Presence<LecternItemId> }
  | { kind: "Completed" }
  | { kind: "CompletedWithoutAdvance" }
  | { kind: "Superseded" }
  | { kind: "TargetGone" };

export interface ConsumptionResult {
  outcome: ConsumptionOutcome;
  lectern: LecternSnapshot;
  nextItem: Presence<LecternItem>;
  progressState: Presence<MediaProgressState>;
  completionHandle: Presence<CompletionHandle>;
  libraryEntriesCollectionRevision: CollectionRevision;
}

// --- Bounds ------------------------------------------------------------------

/** Mirrors backend `LECTERN_MAX_ITEMS`; planners block before invoking writes. */
export const LECTERN_MAX_ITEMS = 2000;
const MAX_CHAPTERS = 100;
const MAX_CHAPTER_TITLE = 300;
const INT32_MAX = 2_147_483_647;

// --- Scalar decoders ---------------------------------------------------------

function asNonNegativeInt32(raw: unknown, ctx: string): number {
  const value = expectFiniteNumber(raw, ctx);
  if (!Number.isInteger(value) || value < 0 || value > INT32_MAX) {
    throw new Error(
      `Invalid ${ctx}: expected a non-negative signed 32-bit integer, got ${value}`,
    );
  }
  return value;
}

function asFraction(raw: unknown, ctx: string): number {
  const value = expectFiniteNumber(raw, ctx);
  if (value < 0 || value > 1) {
    throw new Error(`Invalid ${ctx}: expected a fraction in 0..1, got ${value}`);
  }
  return value;
}

function asArray(raw: unknown, ctx: string): unknown[] {
  if (!Array.isArray(raw)) {
    throw new Error(`Invalid ${ctx}: expected an array, got ${typeof raw}`);
  }
  return raw;
}

function decodeMediaId(raw: unknown): MediaId {
  return parseMediaId(expectString(raw, "MediaId"));
}

function decodeLecternItemId(raw: unknown): LecternItemId {
  return parseLecternItemId(expectString(raw, "LecternItemId"));
}

function decodeCompletionHandle(raw: unknown): CompletionHandle {
  return parseCompletionHandle(expectString(raw, "CompletionHandle"));
}

function decodeAppHref(raw: unknown): AppHref {
  return assumeAppHref(expectString(raw, "AppHref"));
}

function decodeUuidString(raw: unknown, context: string): string {
  const value = expectString(raw, context);
  if (!isCanonicalUuid(value)) {
    throw new Error(`Invalid ${context}: expected a canonical UUID.`);
  }
  return value;
}

// --- Domain decoders ---------------------------------------------------------

function decodePlaybackRateResolution(raw: unknown): PlaybackRateResolution {
  const rec = expectExactRecord(
    raw,
    ["value", "source", "podcastPreference"],
    "PlaybackRateResolution",
  );
  const source = expectOneOf(
    rec.source,
    ["Episode", "Podcast", "Product"] as const,
    "PlaybackRateResolution.source",
  );
  const podcastPreference = decodePresence(rec.podcastPreference, (rawValue) => {
    const preference = expectExactRecord(
      rawValue,
      ["podcastId", "value"],
      "PlaybackRateResolution.podcastPreference",
    );
    return {
      podcastId: decodeUuidString(
        preference.podcastId,
        "PlaybackRateResolution.podcastPreference.podcastId",
      ),
      value: decodePresence(preference.value, (value) =>
        parsePlaybackRate(
          value,
          "PlaybackRateResolution.podcastPreference.value",
        ),
      ),
    };
  });
  const value = parsePlaybackRate(rec.value, "PlaybackRateResolution.value");
  if (source === "Podcast") {
    if (
      podcastPreference.kind !== "Present" ||
      podcastPreference.value.value.kind !== "Present" ||
      podcastPreference.value.value.value !== value
    ) {
      throw new Error(
        "Invalid PlaybackRateResolution: Podcast source must equal the present podcast preference.",
      );
    }
  }
  if (source === "Product") {
    if (value !== 1) {
      throw new Error(
        "Invalid PlaybackRateResolution: Product source must resolve to 1.",
      );
    }
    if (
      podcastPreference.kind === "Present" &&
      podcastPreference.value.value.kind === "Present"
    ) {
      throw new Error(
        "Invalid PlaybackRateResolution: a present podcast preference must resolve from Podcast.",
      );
    }
  }
  return { value, source, podcastPreference };
}

export function decodeChapter(raw: unknown): ChapterOut {
  const rec = expectExactRecord(
    raw,
    ["title", "startMs", "endMs"],
    "ChapterOut",
  );
  const title = expectString(rec.title, "ChapterOut.title");
  if (title.length < 1 || title.length > MAX_CHAPTER_TITLE) {
    throw new Error(
      `Invalid ChapterOut.title: length must be 1..${MAX_CHAPTER_TITLE}, got ${title.length}`,
    );
  }
  return {
    title,
    startMs: asNonNegativeInt32(rec.startMs, "ChapterOut.startMs"),
    endMs: decodePresence(rec.endMs, (v) =>
      asNonNegativeInt32(v, "ChapterOut.endMs"),
    ),
  };
}

function decodeConsumption(raw: unknown): ConsumptionInfo {
  const rec = expectExactRecord(
    raw,
    ["state", "progress", "progressResettable"],
    "consumption",
  );
  return {
    state: expectOneOf(rec.state, ["Unread", "InProgress", "Finished"] as const, "consumption.state"),
    progress: decodePresence(rec.progress, (v) => asFraction(v, "consumption.progress")),
    progressResettable: expectBoolean(rec.progressResettable, "consumption.progressResettable"),
  };
}

export function decodeActivation(raw: unknown): Activation {
  const rec = expectRecord(raw, "activation");
  const kind = expectOneOf(rec.kind, ["FooterAudio", "Readable", "OpenPane"] as const, "activation.kind");
  switch (kind) {
    case "FooterAudio": {
      expectExactRecord(
        rec,
        [
          "kind",
          "streamUrl",
          "sourceUrl",
          "positionMs",
          "writeRevision",
          "resetEpoch",
          "playbackRate",
          "pauseShorteningMode",
          "consumptionOverrideRevision",
          "durationMs",
          "artworkUrl",
          "chapters",
        ],
        "FooterAudioActivation",
      );
      const chapters = asArray(rec.chapters, "FooterAudioActivation.chapters");
      if (chapters.length > MAX_CHAPTERS) {
        throw new Error(
          `Invalid FooterAudioActivation.chapters: at most ${MAX_CHAPTERS}, got ${chapters.length}`,
        );
      }
      return {
        kind: "FooterAudio",
        streamUrl: expectString(rec.streamUrl, "FooterAudioActivation.streamUrl"),
        sourceUrl: expectString(rec.sourceUrl, "FooterAudioActivation.sourceUrl"),
        positionMs: asNonNegativeInt32(
          rec.positionMs,
          "FooterAudioActivation.positionMs",
        ),
        writeRevision: asNonNegativeInt32(
          rec.writeRevision,
          "FooterAudioActivation.writeRevision",
        ),
        resetEpoch: asNonNegativeInt32(
          rec.resetEpoch,
          "FooterAudioActivation.resetEpoch",
        ),
        playbackRate: decodePlaybackRateResolution(rec.playbackRate),
        pauseShorteningMode: decodePresence(
          rec.pauseShorteningMode,
          (value) =>
            parsePauseShorteningMode(
              value,
              "FooterAudioActivation.pauseShorteningMode.value",
            ),
        ),
        consumptionOverrideRevision: decodePresence(
          rec.consumptionOverrideRevision,
          (value) =>
            asNonNegativeInt32(
              value,
              "FooterAudioActivation.consumptionOverrideRevision.value",
            ),
        ),
        durationMs: decodePresence(rec.durationMs, (v) =>
          asNonNegativeInt32(v, "FooterAudioActivation.durationMs"),
        ),
        artworkUrl: decodePresence(rec.artworkUrl, (v) =>
          expectString(v, "FooterAudioActivation.artworkUrl"),
        ),
        chapters: chapters.map(decodeChapter),
      };
    }
    case "Readable": {
      expectExactRecord(rec, ["kind"], "ReadableActivation");
      return { kind: "Readable" };
    }
    case "OpenPane": {
      expectExactRecord(rec, ["kind"], "OpenPaneActivation");
      return { kind: "OpenPane" };
    }
  }
}

export function decodeLecternItem(raw: unknown): LecternItem {
  const rec = expectExactRecord(
    raw,
    [
      "itemId",
      "mediaId",
      "kind",
      "title",
      "subtitle",
      "href",
      "addedAt",
      "consumption",
      "activation",
    ],
    "LecternItemOut",
  );
  const mediaId = decodeMediaId(rec.mediaId);
  const href = decodeAppHref(rec.href);
  return {
    itemId: decodeLecternItemId(rec.itemId),
    mediaId,
    kind: expectOneOf(rec.kind, MEDIA_KINDS, "LecternItemOut.kind"),
    title: expectString(rec.title, "LecternItemOut.title"),
    subtitle: decodePresence(rec.subtitle, (v) => expectString(v, "LecternItemOut.subtitle")),
    href,
    addedAt: expectIsoInstant(rec.addedAt, "LecternItemOut.addedAt"),
    consumption: decodeConsumption(rec.consumption),
    activation: decodeActivation(rec.activation),
    actionSubject: {
      ref: canonicalResourceRef({ scheme: "media", id: mediaId }),
    },
  };
}

/**
 * Decode a `PlayerDescriptor` (spec §4). This is the exact shape the backend
 * adds under the fixed camelCase key `playerDescriptor` on podcast-episode list
 * items and `MediaOut` for podcast episodes (even inside otherwise snake_case
 * DTOs). Its activation is `FooterAudio` by contract; any other kind throws.
 */
export function decodePlayerDescriptor(raw: unknown): PlayerDescriptor {
  const rec = expectExactRecord(
    raw,
    ["mediaId", "title", "subtitle", "activation"],
    "PlayerDescriptor",
  );
  const activation = decodeActivation(rec.activation);
  if (activation.kind !== "FooterAudio") {
    throw new Error(
      `Invalid PlayerDescriptor.activation: expected FooterAudio, got ${activation.kind}`,
    );
  }
  return {
    mediaId: decodeMediaId(rec.mediaId),
    title: expectString(rec.title, "PlayerDescriptor.title"),
    subtitle: decodePresence(rec.subtitle, (v) => expectString(v, "PlayerDescriptor.subtitle")),
    activation,
  };
}

export function decodeLecternSnapshot(raw: unknown): LecternSnapshot {
  const rec = expectExactRecord(raw, ["items"], "LecternSnapshot");
  const items = asArray(rec.items, "LecternSnapshot.items");
  if (items.length > LECTERN_MAX_ITEMS) {
    throw new Error(
      `Invalid LecternSnapshot.items: at most ${LECTERN_MAX_ITEMS}, got ${items.length}`,
    );
  }
  return { items: items.map(decodeLecternItem) };
}

export function decodeListeningState(raw: unknown): ListeningStateOut {
  const rec = expectExactRecord(
    raw,
    [
      "positionMs",
      "durationMs",
      "episodePlaybackRate",
      "writeRevision",
      "resetEpoch",
    ],
    "ListeningStateOut",
  );
  return {
    positionMs: asNonNegativeInt32(rec.positionMs, "ListeningStateOut.positionMs"),
    durationMs: decodePresence(rec.durationMs, (v) =>
      asNonNegativeInt32(v, "ListeningStateOut.durationMs"),
    ),
    episodePlaybackRate: decodePresence(rec.episodePlaybackRate, (value) =>
      parsePlaybackRate(value, "ListeningStateOut.episodePlaybackRate"),
    ),
    writeRevision: asNonNegativeInt32(
      rec.writeRevision,
      "ListeningStateOut.writeRevision",
    ),
    resetEpoch: asNonNegativeInt32(rec.resetEpoch, "ListeningStateOut.resetEpoch"),
  };
}

function decodeMediaProgressState(raw: unknown): MediaProgressState {
  const rec = expectExactRecord(
    raw,
    ["mediaId", "readerCursor", "listeningState"],
    "MediaProgressState",
  );
  return {
    mediaId: decodeMediaId(rec.mediaId),
    readerCursor: parseReaderCursorSnapshot(rec.readerCursor),
    listeningState: decodePresence(rec.listeningState, decodeListeningState),
  };
}

function decodeLecternOutcome(raw: unknown): LecternOutcome {
  const rec = expectRecord(raw, "LecternOutcome");
  const kind = expectOneOf(rec.kind, ["Placed", "Removed", "Ordered"] as const, "LecternOutcome.kind");
  switch (kind) {
    case "Placed": {
      expectExactRecord(rec, ["kind", "itemIds"], "LecternOutcome.Placed");
      return { kind: "Placed", itemIds: asArray(rec.itemIds, "LecternOutcome.itemIds").map(decodeLecternItemId) };
    }
    case "Removed": {
      expectExactRecord(rec, ["kind", "itemId"], "LecternOutcome.Removed");
      return { kind: "Removed", itemId: decodeLecternItemId(rec.itemId) };
    }
    case "Ordered": {
      expectExactRecord(rec, ["kind"], "LecternOutcome.Ordered");
      return { kind: "Ordered" };
    }
  }
}

export function decodeLecternResult(raw: unknown): LecternResult {
  const rec = expectExactRecord(raw, ["outcome", "lectern"], "LecternResult");
  return {
    outcome: decodeLecternOutcome(rec.outcome),
    lectern: decodeLecternSnapshot(rec.lectern),
  };
}

function decodeConsumptionOutcome(raw: unknown): ConsumptionOutcome {
  const rec = expectRecord(raw, "ConsumptionOutcome");
  const kind = expectOneOf(
    rec.kind,
    [
      "StateOnly",
      "Removed",
      "Completed",
      "CompletedWithoutAdvance",
      "Superseded",
      "TargetGone",
    ] as const,
    "ConsumptionOutcome.kind",
  );
  switch (kind) {
    case "StateOnly": {
      expectExactRecord(rec, ["kind"], "ConsumptionOutcome.StateOnly");
      return { kind: "StateOnly" };
    }
    case "Removed": {
      expectExactRecord(rec, ["kind", "itemId", "nextItemId"], "ConsumptionOutcome.Removed");
      return {
        kind: "Removed",
        itemId: decodeLecternItemId(rec.itemId),
        nextItemId: decodePresence(rec.nextItemId, decodeLecternItemId),
      };
    }
    case "Completed":
    case "CompletedWithoutAdvance":
    case "Superseded":
    case "TargetGone": {
      expectExactRecord(rec, ["kind"], `ConsumptionOutcome.${kind}`);
      return { kind };
    }
  }
}

export function decodeConsumptionResult(raw: unknown): ConsumptionResult {
  const rec = expectExactRecord(
    raw,
    [
      "outcome",
      "lectern",
      "nextItem",
      "progressState",
      "completionHandle",
      "libraryEntriesCollectionRevision",
    ],
    "ConsumptionResult",
  );
  return {
    outcome: decodeConsumptionOutcome(rec.outcome),
    lectern: decodeLecternSnapshot(rec.lectern),
    nextItem: decodePresence(rec.nextItem, decodeLecternItem),
    progressState: decodePresence(rec.progressState, decodeMediaProgressState),
    completionHandle: decodePresence(rec.completionHandle, decodeCompletionHandle),
    libraryEntriesCollectionRevision: decodeCollectionRevision(
      rec.libraryEntriesCollectionRevision,
    ),
  };
}

export function decodeDataEnvelope<T>(
  raw: unknown,
  decodeInner: (value: unknown) => T,
  ctx: string,
): T {
  const rec = expectExactRecord(raw, ["data"], ctx);
  return decodeInner(rec.data);
}
