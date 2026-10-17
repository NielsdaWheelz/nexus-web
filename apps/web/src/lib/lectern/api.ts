/** Lectern transport. The account owner accepts acknowledgements before publishing changes. */
import { apiFetch } from "@/lib/api/client";
import type { ApiJson, Schema } from "@/lib/api/wire";
import type { Move, OrderRevision, Snapshot } from "@/lib/collections/order";

export type Lectern = Schema<"LecternOut">;
export type LecternItem = Lectern["items"][number];
export type Placement = NonNullable<Schema<"PlaceIn">["placement"]>;

export async function readLectern(signal: AbortSignal): Promise<Lectern> {
  return (await apiFetch<ApiJson<"/lectern", "get">>("/api/lectern", { signal })).data;
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
