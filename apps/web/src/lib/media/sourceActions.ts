import {
  refreshMediaSource,
  retryMediaSource,
} from "@/lib/media/ingestionClient";
import {
  projectSourceActionResult,
  type SourceActionProjection,
} from "@/lib/media/sourceActionProjection";

type SourceProcessingAction = "retry" | "refresh";

export async function runSourceProcessingAction({
  mediaId,
  action,
  successTitle,
  failedTitle,
}: {
  mediaId: string;
  action: SourceProcessingAction;
  successTitle: string;
  failedTitle?: string;
}): Promise<SourceActionProjection> {
  const result =
    action === "retry"
      ? await retryMediaSource(mediaId)
      : await refreshMediaSource(mediaId);
  return projectSourceActionResult(result, {
    action,
    successTitle,
    failedTitle,
  });
}
