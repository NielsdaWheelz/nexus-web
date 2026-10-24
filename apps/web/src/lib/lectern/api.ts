/** Lectern transport. The account owner accepts acknowledgements before publishing changes. */
import { apiFetch } from "@/lib/api/client";
import type { ApiJson, Schema } from "@/lib/api/wire";
import type { Move, OrderRevision, Snapshot } from "@/lib/collections/order";
import { stampedRead, type StampedRead } from "@/lib/consumption/listening";

export type Lectern = Schema<"LecternOut">;
export type LecternItem = Lectern["items"][number];
export type Placement = NonNullable<Schema<"PlaceIn">["placement"]>;

/** Stamped with its read snapshot's consumption revision; observations reach native. */
export async function readLectern(signal: AbortSignal): Promise<StampedRead<Lectern>> {
  return stampedRead(await apiFetch<ApiJson<"/lectern", "get">>("/api/lectern", { signal }));
}

export async function moveLecternItem(move: Move, signal: AbortSignal): Promise<Snapshot> {
  const { data } = await apiFetch<ApiJson<"/lectern/items/{media_id}/position", "put">>(
    `/api/lectern/items/${move.itemId}/position`, {
      method: "PUT", signal,
      body: JSON.stringify({ before_media_id: move.beforeId,
        expected_order_revision: move.expectedRevision }),
    });
  return { revision: data.order_revision, ids: data.media_ids };
}

export async function writeLecternItem(input: {
  readonly mediaId: string;
  readonly intent: { readonly kind: "Place"; readonly placement: Placement | null } |
    { readonly kind: "Remove" };
  readonly expectedRevision: OrderRevision;
}, signal: AbortSignal): Promise<OrderRevision> {
  if (input.intent.kind === "Remove") {
    const query = new URLSearchParams({ expected_order_revision: input.expectedRevision });
    return (await apiFetch<ApiJson<"/lectern/items/{media_id}", "delete">>(
      `/api/lectern/items/${input.mediaId}?${query}`, { method: "DELETE", signal },
    )).data.order_revision;
  }
  return (await apiFetch<ApiJson<"/lectern/items/{media_id}", "put">>(
    `/api/lectern/items/${input.mediaId}`, {
      method: "PUT", signal,
      body: JSON.stringify({ placement: input.intent.placement,
        expected_order_revision: input.expectedRevision }),
    },
  )).data.order_revision;
}

/** A whole-resource snapshot is reviewed once. Sending never reselects or rebases it. */
export async function prepareCollectionLectern(target: Schema<"CollectionLecternPrepareRequest">["target"], signal: AbortSignal) {
  return (await apiFetch<ApiJson<"/lectern/collections/prepare", "post">>("/api/lectern/collections/prepare", {
    method: "POST", body: JSON.stringify({ target }), signal,
  })).data;
}

/** Transport only; the existing lectern lane admits and retains this exact batch. */
export async function writeCollectionLectern(body: string, signal: AbortSignal) {
  return (await apiFetch<ApiJson<"/lectern/collections", "put">>("/api/lectern/collections", {
    method: "PUT", body, signal,
  })).data;
}
