import type { FeedbackContent } from "@/components/feedback/Feedback";
import { isApiError, isUnauthenticatedApiError } from "@/lib/api/client";
import { isAbortError } from "@/lib/errors";
import {
  mediaCaptureStatus,
  toMediaCaptureFeedback,
} from "@/lib/media/captureFeedback";
import {
  addMediaFromUrl,
  isFailedSourceIngest,
  isMediaIngestionDefect,
  type SourceIngestResult,
} from "@/lib/media/ingestionClient";

export function isSourceUrlCaptureDefect(error: unknown): boolean {
  return (
    isMediaIngestionDefect(error) ||
    (!isApiError(error) &&
      !(error instanceof TypeError) &&
      !isAbortError(error))
  );
}

export type SourceUrlCaptureResult =
  | {
      label: string;
      ok: true;
      status: string;
      path: string;
      mediaId: string;
      sourceAttemptId: string;
      sourceFailed: boolean;
      duplicate: boolean;
      result: SourceIngestResult;
    }
  | {
      label: string;
      ok: false;
      feedback: FeedbackContent;
    };

export async function captureSourceUrl({
  url,
  libraryIds,
  idempotencyKey,
  fallback,
  signal,
}: {
  url: string;
  libraryIds: readonly string[];
  idempotencyKey?: string;
  fallback?: string;
  signal?: AbortSignal;
}): Promise<SourceUrlCaptureResult> {
  try {
    const result = await addMediaFromUrl({
      url,
      libraryIds,
      idempotencyKey,
      signal,
    });
    const sourceFailed = isFailedSourceIngest(result);
    return {
      label: url,
      ok: true,
      status: mediaCaptureStatus(result.duplicate, sourceFailed),
      path: `/media/${result.mediaId}`,
      mediaId: result.mediaId,
      sourceAttemptId: result.sourceAttemptId,
      sourceFailed,
      duplicate: result.duplicate,
      result,
    };
  } catch (error) {
    if (
      isUnauthenticatedApiError(error) ||
      signal?.aborted ||
      isAbortError(error)
    ) {
      throw error;
    }
    if (isSourceUrlCaptureDefect(error)) {
      throw error;
    }
    return {
      label: url,
      ok: false,
      feedback: toMediaCaptureFeedback(error, fallback),
    };
  }
}
