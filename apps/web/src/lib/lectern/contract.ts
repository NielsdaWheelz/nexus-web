/** Lectern and player wire, projected once into branded domain values. */

import type { Schema } from "@/lib/api/wire";
import type { Presence } from "@/lib/api/presence";
import {
  decodeCollectionRevision,
  type CollectionRevision,
} from "@/lib/api/collectionPage";
import {
  mediaSummaryFromWire,
  type MediaSummary,
} from "@/lib/media/mediaSummary";
import {
  parseReaderCursorSnapshot,
  type ReaderCursorSnapshot,
} from "@/lib/reader/readerProgress";
import type { ResourceActionSubject } from "@/lib/resources/resourceActionTarget";
import { canonicalResourceRef } from "@/lib/sharing/targets";
import { isCanonicalUuid } from "@/lib/validation";
import { normalizeWorkspaceHref } from "@/lib/workspace/workspaceHref";

export type MediaId = string & { readonly __mediaId: unique symbol };
export type LecternItemId = string & {
  readonly __lecternItemId: unique symbol;
};
/** A finish (the clientMutationId of its EnsureMediaFinished or Done), named to undo it. */
export type FinishId = string & { readonly __finishId: unique symbol };
export type AppHref = string & { readonly __appHref: unique symbol };

function uuid<T extends string>(value: string, name: string): T {
  if (!isCanonicalUuid(value))
    throw new Error(`Invalid ${name}: ${JSON.stringify(value)}`);
  return value as T;
}

export const parseMediaId = (value: string) => uuid<MediaId>(value, "MediaId");
export const assumeMediaId = parseMediaId;
export const parseLecternItemId = (value: string) =>
  uuid<LecternItemId>(value, "LecternItemId");
export const assumeLecternItemId = parseLecternItemId;

export function assumeAppHref(value: string): AppHref {
  if (!value.startsWith("/") || normalizeWorkspaceHref(value) !== value) {
    throw new Error(`Non-canonical AppHref: ${JSON.stringify(value)}`);
  }
  return value as AppHref;
}

export type ConsumptionInfo = Schema<"ConsumptionOut">;
export type ConsumptionState = ConsumptionInfo["state"];
export type ChapterOut = Schema<"ChapterOut">;
export type ListeningIn = Schema<"ListeningIn">;
export type PlayerDescriptor = Omit<Schema<"PlayerDescriptor">, "mediaId"> & {
  mediaId: MediaId;
};
export type Activation =
  | { kind: "FooterAudio"; descriptor: PlayerDescriptor }
  | { kind: "Readable" }
  | { kind: "OpenPane" };
export interface LecternItem {
  itemId: LecternItemId;
  mediaSummary: MediaSummary;
  href: AppHref;
  addedAt: string;
  consumption: ConsumptionInfo;
  activation: Activation;
  actionSubject: ResourceActionSubject;
}
export interface LecternSnapshot {
  items: LecternItem[];
}
export type Placement =
  | { kind: "First" }
  | { kind: "After"; itemId: LecternItemId }
  | { kind: "Last" };
export interface LecternResult {
  outcome:
    | { kind: "Placed"; itemIds: LecternItemId[] }
    | { kind: "Removed"; itemId: LecternItemId }
    | { kind: "Ordered" };
  lectern: LecternSnapshot;
}
export interface MediaProgressState {
  mediaId: MediaId;
  readerCursor: ReaderCursorSnapshot;
  listeningState: Presence<{ positionMs: number; resetEpoch: number }>;
}
export interface ConsumptionResult {
  outcome: "Done" | "Superseded" | "Gone";
  lectern: LecternSnapshot;
  nextItem: Presence<LecternItem>;
  finishId: Presence<FinishId>;
  progressState: Presence<MediaProgressState>;
  libraryEntriesCollectionRevision: CollectionRevision;
}
export interface NaturalEnd {
  mediaId: MediaId;
  terminalListening: ListeningIn;
  expectedConsumptionOverrideRevision: Presence<number>;
}
export interface UndoRestore {
  itemId: LecternItemId;
  addedAt: string;
  after: Presence<LecternItemId>;
}

export const LECTERN_MAX_ITEMS = 2000;

export function playerDescriptorFromWire(
  descriptor: Schema<"PlayerDescriptor">,
): PlayerDescriptor {
  return { ...descriptor, mediaId: parseMediaId(descriptor.mediaId) };
}

export function lecternItemFromWire(
  item: Schema<"LecternItemOut">,
): LecternItem {
  const mediaSummary = mediaSummaryFromWire(item.mediaSummary);
  const activation = item.activation;
  return {
    itemId: parseLecternItemId(item.itemId),
    mediaSummary,
    href: assumeAppHref(item.href),
    addedAt: item.addedAt,
    consumption: item.consumption,
    activation:
      activation.kind === "FooterAudio"
        ? {
            kind: "FooterAudio",
            descriptor: playerDescriptorFromWire(activation.descriptor),
          }
        : activation,
    actionSubject: {
      ref: canonicalResourceRef({ scheme: "media", id: mediaSummary.mediaId }),
    },
  };
}

export function lecternSnapshotFromWire(
  snapshot: Schema<"LecternSnapshot">,
): LecternSnapshot {
  return { items: snapshot.items.map(lecternItemFromWire) };
}

export function consumptionResultFromWire(
  result: Schema<"ConsumptionResult">,
): ConsumptionResult {
  const { nextItem, finishId, progressState } = result;
  return {
    outcome: result.outcome,
    lectern: lecternSnapshotFromWire(result.lectern),
    nextItem:
      nextItem.kind === "Present"
        ? { kind: "Present", value: lecternItemFromWire(nextItem.value) }
        : nextItem,
    finishId:
      finishId.kind === "Present"
        ? { kind: "Present", value: uuid<FinishId>(finishId.value, "FinishId") }
        : finishId,
    progressState:
      progressState.kind === "Present"
        ? {
            kind: "Present",
            value: {
              mediaId: parseMediaId(progressState.value.mediaId),
              readerCursor: parseReaderCursorSnapshot(
                progressState.value.readerCursor,
              ),
              listeningState: progressState.value.listeningState,
            },
          }
        : progressState,
    libraryEntriesCollectionRevision: decodeCollectionRevision(
      result.libraryEntriesCollectionRevision,
    ),
  };
}
