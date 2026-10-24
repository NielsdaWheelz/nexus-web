/** Collection state transport. Owners retain exact reviewed request/receipt bytes; reads acknowledge nothing. */
import { apiFetch } from "@/lib/api/client";
import type { ApiJson, Schema } from "@/lib/api/wire";

export type CollectionTarget = Schema<"CollectionConsumptionRequest">["target"];
export type CollectionSelection = Schema<"CollectionConsumptionPrepareRequest">["selection"];

export async function prepareCollectionConsumption(selection: CollectionSelection, signal: AbortSignal) {
  return (await apiFetch<ApiJson<"/consumption/collections/prepare", "post">>("/api/consumption/collections/prepare", {
    method: "POST", body: JSON.stringify({ selection }), signal,
  })).data;
}

export async function applyCollectionConsumption(body: string, signal: AbortSignal) {
  return (await apiFetch<ApiJson<"/consumption/collections", "put">>("/api/consumption/collections", { method: "PUT", body, signal })).data;
}

export async function undoCollectionConsumption(body: string, signal: AbortSignal) {
  return (await apiFetch<ApiJson<"/consumption/collections/undo", "put">>("/api/consumption/collections/undo", { method: "PUT", body, signal })).data;
}
