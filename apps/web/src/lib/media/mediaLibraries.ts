import { apiFetch } from "@/lib/api/client";
import { publishChange } from "@/lib/api/changes";
import type { ApiJson } from "@/lib/api/wire";

export type MediaDeleteResult = ApiJson<"/media/{media_id}", "delete">["data"];

/** Remove a media from the viewer's whole workspace. */
export async function deleteMedia(mediaId: string): Promise<MediaDeleteResult> {
  const response = await apiFetch<ApiJson<"/media/{media_id}", "delete">>(
    `/api/media/${mediaId}`,
    { method: "DELETE" },
  );
  // Removal unfiles the media from every library (Deleting does so later).
  publishChange("Entries");
  return response.data;
}
