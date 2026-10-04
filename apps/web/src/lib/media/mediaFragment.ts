import type { ApiJson } from "@/lib/api/wire";
import type { Fragment } from "@/lib/media/transcriptView";

export function mediaFragmentsFromResponse(
  response: ApiJson<"/media/{media_id}/fragments", "get">,
  expectedMediaId: string,
): Fragment[] {
  for (const fragment of response.data) {
    if (fragment.media_id !== expectedMediaId) {
      throw new TypeError("Media fragment must match the requested media");
    }
  }
  return response.data;
}
