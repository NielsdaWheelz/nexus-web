/** Lectern and player wire, projected once into branded domain values. */

import type { Schema } from "@/lib/api/wire";
import {
  type MediaSummary,
} from "@/lib/media/mediaSummary";
import type { CanonicalResourceRef } from "@/lib/sharing/types";
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
export type PlayerDescriptor = Omit<Schema<"PlayerDescriptor">, "media_id"> & {
  media_id: MediaId;
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
  activation: Activation;
  resourceRef: CanonicalResourceRef;
}
export interface LecternSnapshot {
  items: LecternItem[];
  atCapacity: boolean;
}
export type Placement =
  | { kind: "First" }
  | { kind: "After"; itemId: LecternItemId };
export interface LecternResult {
  outcome:
    | { kind: "Ensured" }
    | { kind: "Placed"; itemIds: LecternItemId[] }
    | { kind: "Removed"; itemId: LecternItemId }
    | { kind: "Ordered" };
  lectern: LecternSnapshot;
}
export type ListeningPosition = Schema<"ListeningPositionOut">;
export interface MediaProgressState {
  mediaId: MediaId;
  readerCursor: Schema<"MediaProgressState">["reader_cursor"];
  listeningState: ListeningPosition | null;
}
export interface ConsumptionResult {
  outcome: "Done" | "Superseded" | "Gone";
  lectern: LecternSnapshot;
  nextItem: LecternItem | null;
  finishId: FinishId | null;
  progressState: MediaProgressState | null;
}
export interface NaturalEnd {
  mediaId: MediaId;
  terminalListening: ListeningIn;
  expectedConsumptionOverrideRevision: number | null;
}
export interface UndoRestore {
  itemId: LecternItemId;
  addedAt: string;
  after: LecternItemId | null;
}

export function playerDescriptorFromWire(
  descriptor: Schema<"PlayerDescriptor">,
): PlayerDescriptor {
  return { ...descriptor, media_id: parseMediaId(descriptor.media_id) };
}

export function lecternItemFromWire(
  item: Schema<"LecternItemOut">,
): LecternItem {
  const mediaSummary = item.media_summary;
  const activation = item.activation;
  return {
    itemId: parseLecternItemId(item.item_id),
    mediaSummary,
    href: assumeAppHref(item.href),
    addedAt: item.added_at,
    activation:
      activation.kind === "FooterAudio"
        ? {
            kind: "FooterAudio",
            descriptor: playerDescriptorFromWire(activation.descriptor),
          }
        : activation,
    resourceRef: canonicalResourceRef({ scheme: "media", id: mediaSummary.media_id }),
  };
}

export function lecternSnapshotFromWire(
  snapshot: Schema<"LecternSnapshot">,
): LecternSnapshot {
  return { items: snapshot.items.map(lecternItemFromWire), atCapacity: snapshot.at_capacity };
}

export function consumptionResultFromWire(
  result: Schema<"ConsumptionResult">,
): ConsumptionResult {
  const { next_item: nextItem, finish_id: finishId, progress_state: progressState } = result;
  return {
    outcome: result.outcome,
    lectern: lecternSnapshotFromWire(result.lectern),
    nextItem:
      nextItem !== null
        ? lecternItemFromWire(nextItem)
        : nextItem,
    finishId:
      finishId !== null
        ? (uuid<FinishId>(finishId, "FinishId"))
        : finishId,
    progressState:
      progressState !== null
        ? {
              mediaId: parseMediaId(progressState.media_id),
              readerCursor: progressState.reader_cursor,
              listeningState: progressState.listening_state,
            }
        : progressState,
  };
}
