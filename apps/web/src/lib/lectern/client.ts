/** Lectern and consumption HTTP transport with one native-to-domain projection. */

import { apiFetch, decodeApiPayload } from "@/lib/api/client";
import { decodeCollectionRevision } from "@/lib/api/collectionPage";
import { absent, present } from "@/lib/api/presence";
import type { ApiJson, Schema } from "@/lib/api/wire";
import {
  assumeAppHref,
  assumeLecternItemId,
  assumeMediaId,
  parseCompletionHandle,
  type ConsumptionCommand,
  type ConsumptionResult,
  type LecternCommand,
  type LecternItem,
  type LecternResult,
  type LecternSnapshot,
} from "@/lib/lectern/contract";
import { mediaSummaryFromWire } from "@/lib/media/mediaSummary";
import { canonicalResourceRef } from "@/lib/sharing/targets";

function itemFromWire(item: Schema<"LecternItemOut">): LecternItem {
  const mediaSummary = mediaSummaryFromWire(item.mediaSummary);
  return {
    ...item,
    itemId: assumeLecternItemId(item.itemId),
    mediaSummary,
    href: assumeAppHref(item.href),
    actionSubject: {
      ref: canonicalResourceRef({ scheme: "media", id: mediaSummary.mediaId }),
    },
  };
}

function snapshotFromWire(snapshot: Schema<"LecternSnapshot">): LecternSnapshot {
  return { items: snapshot.items.map(itemFromWire) };
}

export async function getLectern(options: {
  signal?: AbortSignal;
  cache?: RequestCache;
} = {}): Promise<LecternSnapshot> {
  const body = await apiFetch<ApiJson<"/lectern", "get">>("/api/lectern", options);
  return decodeApiPayload(
    body,
    ({ data }) => snapshotFromWire(data),
    "GET /api/lectern",
  );
}

export async function postLecternCommand(
  command: LecternCommand,
  signal?: AbortSignal,
): Promise<LecternResult> {
  const body = await apiFetch<ApiJson<"/lectern/commands", "post">>(
    "/api/lectern/commands",
    { method: "POST", body: JSON.stringify(command), signal },
  );
  return decodeApiPayload(
    body,
    ({ data }): LecternResult => {
      const lectern = snapshotFromWire(data.lectern);
      switch (data.outcome.kind) {
        case "Placed":
          return {
            outcome: { kind: "Placed", itemIds: data.outcome.itemIds.map(assumeLecternItemId) },
            lectern,
          };
        case "Removed":
          return {
            outcome: { kind: "Removed", itemId: assumeLecternItemId(data.outcome.itemId) },
            lectern,
          };
        case "Ordered":
          return { outcome: { kind: "Ordered" }, lectern };
      }
    },
    "POST /api/lectern/commands",
  );
}

export async function postConsumptionCommand(
  command: ConsumptionCommand,
  signal?: AbortSignal,
): Promise<ConsumptionResult> {
  const body = await apiFetch<ApiJson<"/consumption/commands", "post">>(
    "/api/consumption/commands",
    { method: "POST", body: JSON.stringify(command), signal },
  );
  return decodeApiPayload(
    body,
    ({ data }): ConsumptionResult => ({
      outcome: data.outcome.kind === "Removed"
        ? {
            kind: "Removed",
            itemId: assumeLecternItemId(data.outcome.itemId),
            nextItemId: data.outcome.nextItemId.kind === "Present"
              ? present(assumeLecternItemId(data.outcome.nextItemId.value))
              : absent(),
          }
        : data.outcome,
      lectern: snapshotFromWire(data.lectern),
      nextItem: data.nextItem.kind === "Present"
        ? present(itemFromWire(data.nextItem.value))
        : absent(),
      progressState: data.progressState.kind === "Present"
        ? present({
            ...data.progressState.value,
            mediaId: assumeMediaId(data.progressState.value.mediaId),
          })
        : absent(),
      completionHandle: data.completionHandle.kind === "Present"
        ? present(parseCompletionHandle(data.completionHandle.value))
        : absent(),
      libraryEntriesCollectionRevision: decodeCollectionRevision(
        data.libraryEntriesCollectionRevision,
      ),
    }),
    "POST /api/consumption/commands",
  );
}
