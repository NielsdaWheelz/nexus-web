import { apiFetch } from "@/lib/api/client";
import { publishChange } from "@/lib/api/changes";

/** Remove a media from the viewer's whole workspace; resending after it landed is fine. */
export async function deleteMedia(mediaId: string): Promise<void> {
  await apiFetch(`/api/media/${encodeURIComponent(mediaId)}`, {
    method: "DELETE",
  });
  // Removal unfiles the media from every library at once.
  publishChange("Entries");
}
