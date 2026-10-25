// Source-backed piece commands. The server owns geometry, authority and replay.
import { apiFetch } from "@/lib/api/client";
import type { ApiJson, Schema } from "@/lib/api/wire";
import { publishChange } from "@/lib/api/changes";

export async function partPage(source: string, cursor: string | null, signal: AbortSignal) {
  const body = await apiFetch<ApiJson<"/media/{source_media_id}/parts", "get">>(`/api/media/${source}/parts${cursor === null ? "" : `?cursor=${encodeURIComponent(cursor)}`}`, { signal });
  return { ...body.page, rows: body.data };
}
export const partDefinition = (id: string, signal: AbortSignal) => apiFetch<ApiJson<"/media/{media_id}/part", "get">>(`/api/media/${id}/part`, { signal }).then(body => body.data);
export const partNavigation = (id: string, signal: AbortSignal) => apiFetch<ApiJson<"/media/{media_id}/navigation", "get">>(`/api/media/${id}/navigation`, { signal }).then(body => body.data);
export const previewPart = (source: string, selection: Schema<"SectionSelection">, signal: AbortSignal) => apiFetch<ApiJson<"/media/{source_media_id}/parts/preview", "post">>(`/api/media/${source}/parts/preview`, { method: "POST", body: JSON.stringify({ selection }), signal }).then(body => body.data);
export async function savePart(source: string, id: string | null, request: Schema<"PartCreate"> | Schema<"PartUpdate">) {
  const body = id === null
    ? await apiFetch<ApiJson<"/media/{source_media_id}/parts", "post">>(`/api/media/${source}/parts`, { method: "POST", body: JSON.stringify(request) })
    : await apiFetch<ApiJson<"/media/{media_id}/part", "put">>(`/api/media/${id}/part`, { method: "PUT", body: JSON.stringify(request) });
  publishChange("Metadata", "Entries", "Consumption");
  return body.data;
}
export async function prepareParts(source: string, request: Schema<"PartPrepare">) {
  await apiFetch<ApiJson<"/media/{source_media_id}/parts/prepare", "post">>(`/api/media/${source}/parts/prepare`, { method: "POST", body: JSON.stringify(request) });
  publishChange("Metadata");
}
export async function discoverParts(source: string, request: Schema<"PartDiscovery">) {
  const result = await apiFetch<ApiJson<"/media/{source_media_id}/part-discovery", "post">>(`/api/media/${source}/part-discovery`, { method: "POST", body: JSON.stringify(request) });
  publishChange("Metadata");
  return result.data;
}
export async function decidePart(source: string, candidate: string, request: Schema<"PartCandidateDecision">) {
  const result = await apiFetch<ApiJson<"/media/{source_media_id}/part-candidates/{candidate_id}", "put">>(`/api/media/${source}/part-candidates/${candidate}`, { method: "PUT", body: JSON.stringify(request) });
  publishChange("Metadata", "Entries");
  return result.data;
}
