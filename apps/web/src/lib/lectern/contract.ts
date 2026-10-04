/** native lectern facts projected into branded player and collection values. */

import type { ApiJson, Schema } from "@/lib/api/wire";
import type { Presence } from "@/lib/api/presence";
import type { CollectionRevision } from "@/lib/api/collectionPage";
import { mediaSummaryFromWire, type MediaSummary } from "@/lib/media/mediaSummary";
import type { ReaderCursorSnapshot } from "@/lib/reader/readerProgress";
import type { ResourceActionSubject } from "@/lib/resources/resourceActionTarget";
import { canonicalResourceRef } from "@/lib/sharing/targets";
import { isCanonicalUuid } from "@/lib/validation";
import { normalizeWorkspaceHref } from "@/lib/workspace/workspaceHref";

export type MediaId = string & { readonly __mediaId: unique symbol };
export type LecternItemId = string & { readonly __lecternItemId: unique symbol };
export type CompletionHandle = string & { readonly __completionHandle: unique symbol };
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

export type ConsumptionInfo = Schema<"ConsumptionOut">;
export type ConsumptionState = ConsumptionInfo["state"];
export type ChapterOut = Schema<"ChapterOut">;
export type FooterAudioActivation = Schema<"FooterAudioActivation">;
export type Activation = Schema<"LecternItemOut">["activation"];
export type PlaybackRateResolution = Schema<"PlaybackRateResolution">;
export type ListeningStateOut = ApiJson<
  "/media/{media_id}/listening-state",
  "get"
>["data"];

export type PlayerDescriptor = Omit<Schema<"PlayerDescriptor">, "mediaId"> & {
  mediaId: MediaId;
};
export type LecternItem = Omit<
  Schema<"LecternItemOut">,
  "itemId" | "mediaSummary" | "href"
> & {
  itemId: LecternItemId;
  mediaSummary: MediaSummary;
  href: AppHref;
  actionSubject: ResourceActionSubject;
};
export type LecternSnapshot = Omit<Schema<"LecternSnapshot">, "items"> & {
  items: LecternItem[];
};
export type MediaProgressState = Omit<
  Schema<"MediaProgressState">,
  "mediaId" | "readerCursor"
> & {
  mediaId: MediaId;
  readerCursor: ReaderCursorSnapshot;
};

export type Placement =
  | Schema<"FirstPlacement">
  | (Omit<Schema<"AfterPlacement">, "itemId"> & { itemId: LecternItemId })
  | Schema<"LastPlacement">;
export type NextCapability = Schema<"FinishLecternItemCommand">["nextCapability"];
export type NaturalEndTerminalListening = Schema<"TerminalListeningIn">;
export type NaturalEndSettlement = Omit<
  Schema<"SettleNaturalEndCommand">,
  "kind" | "nextCapability" | "mediaId" | "origin"
> & {
  mediaId: MediaId;
  origin:
    | Schema<"DirectNaturalEndOrigin">
    | (Omit<Schema<"LecternNaturalEndOrigin">, "itemId"> & { itemId: LecternItemId });
};

export type LecternCommand =
  | (Omit<Schema<"PlaceItemsCommand">, "mediaIds" | "placement"> & {
      mediaIds: MediaId[];
      placement: Placement;
    })
  | (Omit<Schema<"RemoveItemCommand">, "itemId"> & { itemId: LecternItemId })
  | (Omit<Schema<"SetOrderCommand">, "itemIds"> & { itemIds: LecternItemId[] });
export type ConsumptionCommand =
  | (Omit<Schema<"EnsureMediaFinishedCommand">, "mediaId"> & { mediaId: MediaId })
  | (Omit<Schema<"FinishLecternItemCommand">, "mediaId" | "itemId"> & {
      mediaId: MediaId;
      itemId: LecternItemId;
    })
  | (NaturalEndSettlement & Pick<
      Schema<"SettleNaturalEndCommand">,
      "kind" | "nextCapability"
    >)
  | (Omit<Schema<"SetUnreadCommand">, "mediaId"> & { mediaId: MediaId })
  | (Omit<Schema<"ResetProgressCommand">, "mediaId"> & { mediaId: MediaId })
  | (Omit<Schema<"UndoCompletionCommand">, "completionHandle"> & {
      completionHandle: CompletionHandle;
    })
  | (Omit<Schema<"SetBatchStateCommand">, "mediaIds"> & { mediaIds: MediaId[] });

export type LecternOutcome =
  | (Omit<Schema<"PlacedOutcome">, "itemIds"> & { itemIds: LecternItemId[] })
  | (Omit<Schema<"RemovedOutcome">, "itemId"> & { itemId: LecternItemId })
  | Schema<"OrderedOutcome">;
export type LecternResult = Omit<Schema<"LecternResult">, "outcome" | "lectern"> & {
  outcome: LecternOutcome;
  lectern: LecternSnapshot;
};
type ConsumptionStateKind = Schema<"ConsumptionStateOutcome">["kind"];
export type ConsumptionOutcome =
  | { [Kind in ConsumptionStateKind]: { kind: Kind } }[ConsumptionStateKind]
  | (Omit<Schema<"ConsumptionRemovedOutcome">, "itemId" | "nextItemId"> & {
      itemId: LecternItemId;
      nextItemId: Presence<LecternItemId>;
    });
export type ConsumptionResult = Omit<
  Schema<"ConsumptionResult">,
  | "outcome"
  | "lectern"
  | "nextItem"
  | "progressState"
  | "completionHandle"
  | "libraryEntriesCollectionRevision"
> & {
  outcome: ConsumptionOutcome;
  lectern: LecternSnapshot;
  nextItem: Presence<LecternItem>;
  progressState: Presence<MediaProgressState>;
  completionHandle: Presence<CompletionHandle>;
  libraryEntriesCollectionRevision: CollectionRevision;
};

export const LECTERN_MAX_ITEMS = 2000;

export function lecternItemFromWire(item: Schema<"LecternItemOut">): LecternItem {
  const mediaSummary = mediaSummaryFromWire(item.mediaSummary);
  const href = assumeAppHref(item.href);
  return {
    itemId: parseLecternItemId(item.itemId),
    mediaSummary,
    playerDisplay: item.playerDisplay,
    href,
    addedAt: item.addedAt,
    consumption: item.consumption,
    activation: item.activation,
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
