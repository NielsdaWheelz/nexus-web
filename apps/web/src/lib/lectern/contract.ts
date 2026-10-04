/**
 * lectern domain commands and strict decoders for versioned player and
 * listening inputs. generated wire owns http shapes; client.ts projects leaves.
 */

import { decodePresence, type Presence } from "@/lib/api/presence";
import type { Schema } from "@/lib/api/wire";
import type { CollectionRevision } from "@/lib/api/collectionPage";
import type { ResourceActionSubject } from "@/lib/resources/resourceActionTarget";
import type { ReaderCursorSnapshot } from "@/lib/reader/readerProgress";
import { canonicalCpLength } from "@/lib/reader/textOffsets";
import { parsePlaybackRate } from "@/lib/player/playbackRate";
import { parsePauseShorteningMode } from "@/lib/player/pauseShortening";
import {
  expectBoolean,
  expectExactRecord,
  expectFiniteNumber,
  expectOneOf,
  expectRecord,
  expectString,
  isCanonicalUuid,
} from "@/lib/validation";
import type { MediaSummary } from "@/lib/media/mediaSummary";
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

export type ConsumptionState = Schema<"ConsumptionOut">["state"];
export type ConsumptionInfo = Schema<"ConsumptionOut">;
export type ChapterOut = Schema<"ChapterOut">;
export type FooterAudioActivation = Schema<"FooterAudioActivation">;
export type Activation = Schema<"LecternItemOut">["activation"];

export interface LecternItem {
  itemId: LecternItemId;
  mediaSummary: MediaSummary;
  playerDisplay: Presence<{ title: string; subtitle: Presence<string> }>;
  href: AppHref;
  /** ISO 8601 aware instant this row joined the Lectern (the Added sort key). */
  addedAt: string;
  consumption: ConsumptionInfo;
  activation: Activation;
  actionSubject: ResourceActionSubject;
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

export type PlaybackRateResolution = Schema<"PlaybackRateResolution">;
export type ListeningStateOut = Schema<"nexus__schemas__consumption__ListeningStateOut">;

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
  const length = canonicalCpLength(title);
  if (length < 1 || length > MAX_CHAPTER_TITLE) {
    throw new Error(
      `Invalid ChapterOut.title: length must be 1..${MAX_CHAPTER_TITLE}, got ${length}`,
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

export function decodeConsumption(raw: unknown): ConsumptionInfo {
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
