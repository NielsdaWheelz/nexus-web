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
import type {
  PositiveMinutes,
  ProgressFraction,
} from "@/lib/consumption/activityFacts";
import { isRecord } from "@/lib/validation";
import { normalizeWorkspaceHref } from "@/lib/workspace/workspaceHref";

// --- Branded identities ------------------------------------------------------
//
// The cutover preserves the existing raw media/item UUID wire families and
// decodes each into a distinct branded type (spec §4 "Bounded identity
// exception"). Sealed handles are named follow-up debt, not this cutover.
// `parseX`/`assumeX` mirror `lib/contributors/handle.ts`: both validate and
// throw; `parse*` is the wire-ingress name used by decoders, `assume*` is the
// already-canonical name used by callers holding a known-good string.

const CANONICAL_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type MediaId = string & { readonly __mediaId: unique symbol };
export type LecternItemId = string & { readonly __lecternItemId: unique symbol };

/** Server-produced in-app path (leading "/"), branded so leaves cannot pass a raw string. */
export type AppHref = string & { readonly __appHref: unique symbol };

export function parseMediaId(value: string): MediaId {
  if (!CANONICAL_UUID_RE.test(value)) {
    throw new Error(`Invalid MediaId: ${JSON.stringify(value)}`);
  }
  return value as MediaId;
}

export function assumeMediaId(value: string): MediaId {
  if (!CANONICAL_UUID_RE.test(value)) {
    throw new Error(`Non-canonical MediaId: ${JSON.stringify(value)}`);
  }
  return value as MediaId;
}

export function parseLecternItemId(value: string): LecternItemId {
  if (!CANONICAL_UUID_RE.test(value)) {
    throw new Error(`Invalid LecternItemId: ${JSON.stringify(value)}`);
  }
  return value as LecternItemId;
}

export function assumeLecternItemId(value: string): LecternItemId {
  if (!CANONICAL_UUID_RE.test(value)) {
    throw new Error(`Non-canonical LecternItemId: ${JSON.stringify(value)}`);
  }
  return value as LecternItemId;
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
  playbackSpeed: number;
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
  kind: ConsumptionMediaKind;
  title: string;
  subtitle: Presence<string>;
  href: AppHref;
  consumption: ConsumptionInfo;
  activation: Activation;
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

const CONSUMPTION_MEDIA_KINDS = [
  "web_article",
  "epub",
  "pdf",
  "video",
  "podcast_episode",
] as const;

export type ConsumptionMediaKind = (typeof CONSUMPTION_MEDIA_KINDS)[number];

/** Derived from a `LecternItem`/media/podcast DTO whose activation is `FooterAudio`. */
export interface PlayerDescriptor {
  mediaId: MediaId;
  title: string;
  subtitle: Presence<string>;
  activation: FooterAudioActivation;
}

export interface ListeningStateOut {
  positionMs: number;
  durationMs: Presence<number>;
  playbackSpeed: number;
  writeRevision: number;
  resetEpoch: number;
}

export interface MediaListeningState {
  mediaId: MediaId;
  state: ListeningStateOut;
}

// --- Command types (wire: camelCase keys, PascalCase kinds) -------------------

export type Placement =
  | { kind: "First" }
  | { kind: "After"; itemId: LecternItemId }
  | { kind: "Last" };

export type NextCapability = "Stop" | "FooterAudio" | "Readable";

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
  | { kind: "SetUnread"; clientMutationId: string; mediaId: MediaId }
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
  | { kind: "Removed"; itemId: LecternItemId; nextItemId: Presence<LecternItemId> };

export interface ConsumptionResult {
  outcome: ConsumptionOutcome;
  lectern: LecternSnapshot;
  nextItem: Presence<LecternItem>;
  listeningStates: MediaListeningState[];
}

// --- Bounds ------------------------------------------------------------------

const MAX_SNAPSHOT_ITEMS = 2000;
const MAX_CHAPTERS = 100;
const MAX_CHAPTER_TITLE = 300;
const INT32_MAX = 2_147_483_647;

// --- Scalar decoders ---------------------------------------------------------

function asRecord(raw: unknown, ctx: string): Record<string, unknown> {
  if (!isRecord(raw)) {
    const got = raw === null ? "null" : Array.isArray(raw) ? "array" : typeof raw;
    throw new Error(`Invalid ${ctx}: expected an object, got ${got}`);
  }
  return raw;
}

function exactKeys(rec: Record<string, unknown>, expected: readonly string[], ctx: string): void {
  const keys = Object.keys(rec);
  if (keys.length !== expected.length || !expected.every((key) => key in rec)) {
    throw new Error(
      `Invalid ${ctx}: expected keys [${expected.join(", ")}], got [${keys.join(", ")}]`,
    );
  }
}

function asString(raw: unknown, ctx: string): string {
  if (typeof raw !== "string") {
    throw new Error(`Invalid ${ctx}: expected a string, got ${typeof raw}`);
  }
  return raw;
}

function asFiniteNumber(raw: unknown, ctx: string): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    throw new Error(`Invalid ${ctx}: expected a finite number, got ${JSON.stringify(raw)}`);
  }
  return raw;
}

function asNonNegativeInt32(raw: unknown, ctx: string): number {
  const value = asFiniteNumber(raw, ctx);
  if (!Number.isInteger(value) || value < 0 || value > INT32_MAX) {
    throw new Error(
      `Invalid ${ctx}: expected a non-negative signed 32-bit integer, got ${value}`,
    );
  }
  return value;
}

function asPlaybackSpeed(raw: unknown, ctx: string): number {
  const value = asFiniteNumber(raw, ctx);
  if (value < 0.25 || value > 3) {
    throw new Error(`Invalid ${ctx}: expected a value in 0.25..3, got ${value}`);
  }
  return value;
}

function asFraction(raw: unknown, ctx: string): number {
  const value = asFiniteNumber(raw, ctx);
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

function asLiteral<T extends string>(raw: unknown, allowed: readonly T[], ctx: string): T {
  if (typeof raw !== "string" || !(allowed as readonly string[]).includes(raw)) {
    throw new Error(
      `Invalid ${ctx}: expected one of [${allowed.join(", ")}], got ${JSON.stringify(raw)}`,
    );
  }
  return raw as T;
}

function decodeMediaId(raw: unknown): MediaId {
  return parseMediaId(asString(raw, "MediaId"));
}

function decodeLecternItemId(raw: unknown): LecternItemId {
  return parseLecternItemId(asString(raw, "LecternItemId"));
}

function decodeAppHref(raw: unknown): AppHref {
  return assumeAppHref(asString(raw, "AppHref"));
}

// --- Domain decoders ---------------------------------------------------------

export function decodeChapter(raw: unknown): ChapterOut {
  const rec = asRecord(raw, "ChapterOut");
  exactKeys(rec, ["title", "startMs", "endMs"], "ChapterOut");
  const title = asString(rec.title, "ChapterOut.title");
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
  const rec = asRecord(raw, "consumption");
  exactKeys(rec, ["state", "progress"], "consumption");
  return {
    state: asLiteral(rec.state, ["Unread", "InProgress", "Finished"] as const, "consumption.state"),
    progress: decodePresence(rec.progress, (v) => asFraction(v, "consumption.progress")),
  };
}

export function decodeActivation(raw: unknown): Activation {
  const rec = asRecord(raw, "activation");
  const kind = asLiteral(rec.kind, ["FooterAudio", "Readable", "OpenPane"] as const, "activation.kind");
  switch (kind) {
    case "FooterAudio": {
      exactKeys(
        rec,
        [
          "kind",
          "streamUrl",
          "sourceUrl",
          "positionMs",
          "writeRevision",
          "resetEpoch",
          "playbackSpeed",
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
        streamUrl: asString(rec.streamUrl, "FooterAudioActivation.streamUrl"),
        sourceUrl: asString(rec.sourceUrl, "FooterAudioActivation.sourceUrl"),
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
        playbackSpeed: asPlaybackSpeed(
          rec.playbackSpeed,
          "FooterAudioActivation.playbackSpeed",
        ),
        durationMs: decodePresence(rec.durationMs, (v) =>
          asNonNegativeInt32(v, "FooterAudioActivation.durationMs"),
        ),
        artworkUrl: decodePresence(rec.artworkUrl, (v) =>
          asString(v, "FooterAudioActivation.artworkUrl"),
        ),
        chapters: chapters.map(decodeChapter),
      };
    }
    case "Readable": {
      exactKeys(rec, ["kind"], "ReadableActivation");
      return { kind: "Readable" };
    }
    case "OpenPane": {
      exactKeys(rec, ["kind"], "OpenPaneActivation");
      return { kind: "OpenPane" };
    }
  }
}

export function decodeLecternItem(raw: unknown): LecternItem {
  const rec = asRecord(raw, "LecternItemOut");
  exactKeys(
    rec,
    ["itemId", "mediaId", "kind", "title", "subtitle", "href", "consumption", "activation"],
    "LecternItemOut",
  );
  return {
    itemId: decodeLecternItemId(rec.itemId),
    mediaId: decodeMediaId(rec.mediaId),
    kind: asLiteral(rec.kind, CONSUMPTION_MEDIA_KINDS, "LecternItemOut.kind"),
    title: asString(rec.title, "LecternItemOut.title"),
    subtitle: decodePresence(rec.subtitle, (v) => asString(v, "LecternItemOut.subtitle")),
    href: decodeAppHref(rec.href),
    consumption: decodeConsumption(rec.consumption),
    activation: decodeActivation(rec.activation),
  };
}

/**
 * Decode a `PlayerDescriptor` (spec §4). This is the exact shape the backend
 * adds under the fixed camelCase key `playerDescriptor` on podcast-episode list
 * items and `MediaOut` for podcast episodes (even inside otherwise snake_case
 * DTOs). Its activation is `FooterAudio` by contract; any other kind throws.
 */
export function decodePlayerDescriptor(raw: unknown): PlayerDescriptor {
  const rec = asRecord(raw, "PlayerDescriptor");
  exactKeys(rec, ["mediaId", "title", "subtitle", "activation"], "PlayerDescriptor");
  const activation = decodeActivation(rec.activation);
  if (activation.kind !== "FooterAudio") {
    throw new Error(
      `Invalid PlayerDescriptor.activation: expected FooterAudio, got ${activation.kind}`,
    );
  }
  return {
    mediaId: decodeMediaId(rec.mediaId),
    title: asString(rec.title, "PlayerDescriptor.title"),
    subtitle: decodePresence(rec.subtitle, (v) => asString(v, "PlayerDescriptor.subtitle")),
    activation,
  };
}

/** Decode the `Presence<PlayerDescriptor>` a media/episode DTO exposes. */
export function decodePresentPlayerDescriptor(raw: unknown): Presence<PlayerDescriptor> {
  return decodePresence(raw, decodePlayerDescriptor);
}

export function decodeLecternSnapshot(raw: unknown): LecternSnapshot {
  const rec = asRecord(raw, "LecternSnapshot");
  exactKeys(rec, ["items"], "LecternSnapshot");
  const items = asArray(rec.items, "LecternSnapshot.items");
  if (items.length > MAX_SNAPSHOT_ITEMS) {
    throw new Error(
      `Invalid LecternSnapshot.items: at most ${MAX_SNAPSHOT_ITEMS}, got ${items.length}`,
    );
  }
  return { items: items.map(decodeLecternItem) };
}

export function decodeListeningState(raw: unknown): ListeningStateOut {
  const rec = asRecord(raw, "ListeningStateOut");
  exactKeys(
    rec,
    ["positionMs", "durationMs", "playbackSpeed", "writeRevision", "resetEpoch"],
    "ListeningStateOut",
  );
  return {
    positionMs: asNonNegativeInt32(rec.positionMs, "ListeningStateOut.positionMs"),
    durationMs: decodePresence(rec.durationMs, (v) =>
      asNonNegativeInt32(v, "ListeningStateOut.durationMs"),
    ),
    playbackSpeed: asPlaybackSpeed(rec.playbackSpeed, "ListeningStateOut.playbackSpeed"),
    writeRevision: asNonNegativeInt32(
      rec.writeRevision,
      "ListeningStateOut.writeRevision",
    ),
    resetEpoch: asNonNegativeInt32(rec.resetEpoch, "ListeningStateOut.resetEpoch"),
  };
}

function decodeMediaListeningState(raw: unknown): MediaListeningState {
  const rec = asRecord(raw, "MediaListeningState");
  exactKeys(rec, ["mediaId", "state"], "MediaListeningState");
  return {
    mediaId: decodeMediaId(rec.mediaId),
    state: decodeListeningState(rec.state),
  };
}

function decodeLecternOutcome(raw: unknown): LecternOutcome {
  const rec = asRecord(raw, "LecternOutcome");
  const kind = asLiteral(rec.kind, ["Placed", "Removed", "Ordered"] as const, "LecternOutcome.kind");
  switch (kind) {
    case "Placed": {
      exactKeys(rec, ["kind", "itemIds"], "LecternOutcome.Placed");
      return { kind: "Placed", itemIds: asArray(rec.itemIds, "LecternOutcome.itemIds").map(decodeLecternItemId) };
    }
    case "Removed": {
      exactKeys(rec, ["kind", "itemId"], "LecternOutcome.Removed");
      return { kind: "Removed", itemId: decodeLecternItemId(rec.itemId) };
    }
    case "Ordered": {
      exactKeys(rec, ["kind"], "LecternOutcome.Ordered");
      return { kind: "Ordered" };
    }
  }
}

export function decodeLecternResult(raw: unknown): LecternResult {
  const rec = asRecord(raw, "LecternResult");
  exactKeys(rec, ["outcome", "lectern"], "LecternResult");
  return {
    outcome: decodeLecternOutcome(rec.outcome),
    lectern: decodeLecternSnapshot(rec.lectern),
  };
}

function decodeConsumptionOutcome(raw: unknown): ConsumptionOutcome {
  const rec = asRecord(raw, "ConsumptionOutcome");
  const kind = asLiteral(rec.kind, ["StateOnly", "Removed"] as const, "ConsumptionOutcome.kind");
  switch (kind) {
    case "StateOnly": {
      exactKeys(rec, ["kind"], "ConsumptionOutcome.StateOnly");
      return { kind: "StateOnly" };
    }
    case "Removed": {
      exactKeys(rec, ["kind", "itemId", "nextItemId"], "ConsumptionOutcome.Removed");
      return {
        kind: "Removed",
        itemId: decodeLecternItemId(rec.itemId),
        nextItemId: decodePresence(rec.nextItemId, decodeLecternItemId),
      };
    }
  }
}

export function decodeConsumptionResult(raw: unknown): ConsumptionResult {
  const rec = asRecord(raw, "ConsumptionResult");
  exactKeys(rec, ["outcome", "lectern", "nextItem", "listeningStates"], "ConsumptionResult");
  return {
    outcome: decodeConsumptionOutcome(rec.outcome),
    lectern: decodeLecternSnapshot(rec.lectern),
    nextItem: decodePresence(rec.nextItem, decodeLecternItem),
    listeningStates: asArray(rec.listeningStates, "ConsumptionResult.listeningStates").map(
      decodeMediaListeningState,
    ),
  };
}

export function decodeDataEnvelope<T>(
  raw: unknown,
  decodeInner: (value: unknown) => T,
  ctx: string,
): T {
  const rec = asRecord(raw, ctx);
  exactKeys(rec, ["data"], ctx);
  return decodeInner(rec.data);
}
