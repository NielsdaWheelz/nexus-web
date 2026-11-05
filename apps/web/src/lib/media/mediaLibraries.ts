import { apiFetch } from "@/lib/api/client";
import { publishChange } from "@/lib/api/changes";
import type { ApiJson, Schema } from "@/lib/api/wire";

export async function mediaRemovalPreview(mediaId: string, signal: AbortSignal): Promise<Schema<"MediaRemovalPreviewOut">> {
  return (await apiFetch<ApiJson<"/media/{media_id}/removal-preview", "get">>(
    `/api/media/${encodeURIComponent(mediaId)}/removal-preview`, { signal },
  )).data;
}

/** Remove a media from the viewer's whole workspace; resending after it landed is fine. */
export async function deleteMedia(mediaId: string, expectedAcquisitionRevision: string): Promise<void> {
  await apiFetch(`/api/media/${encodeURIComponent(mediaId)}`, {
    method: "DELETE",
    body: JSON.stringify({ expected_acquisition_revision: expectedAcquisitionRevision }),
  });
  // Removal unfiles the media from every library and takes it off the Lectern.
  publishChange("Entries", "Lectern");
}
