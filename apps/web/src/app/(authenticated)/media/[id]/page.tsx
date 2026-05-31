import { callFastAPI } from "@/lib/api/server";
import {
  isReadableStatus,
  type MediaNavigationResponse,
} from "@/lib/media/readerNavigation";
import MediaPaneBody, { type Media } from "./MediaPaneBody";

type Params = Promise<{ id: string }>;

export default async function MediaPage({ params }: { params: Params }) {
  const { id } = await params;
  const mediaResp = await callFastAPI<{ data: Media }>(`/media/${id}`);
  const media = mediaResp.data;

  const shouldPrefetchNavigation =
    (media.kind === "epub" || media.kind === "web_article") &&
    isReadableStatus(media.processing_status);

  // Navigation prefetch is best-effort: if it fails the client hook will load
  // it (and retry on transient failures). This is not a redundant parallel
  // fetch — it only runs when the prefetch did not produce data.
  const initialNavigation: MediaNavigationResponse | null =
    shouldPrefetchNavigation
      ? await callFastAPI<MediaNavigationResponse>(
          `/media/${id}/navigation`,
        ).catch(() => null)
      : null;

  return (
    <MediaPaneBody
      initialMedia={media}
      initialNavigation={initialNavigation}
    />
  );
}
