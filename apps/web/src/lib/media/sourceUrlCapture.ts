import type { FeedbackContent } from "@/components/feedback/Feedback";
import {
  mediaCaptureStatus,
  toMediaCaptureFeedback,
} from "@/lib/media/captureFeedback";
import {
  addMediaFromUrl,
  isFailedSourceIngest,
  type SourceIngestResult,
} from "@/lib/media/ingestionClient";

export const SOURCE_INGEST_CONCURRENCY = 2;

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
}: {
  url: string;
  libraryIds: string[];
  idempotencyKey?: string;
  fallback?: string;
}): Promise<SourceUrlCaptureResult> {
  try {
    const result = await addMediaFromUrl({
      url,
      libraryIds,
      idempotencyKey,
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
    return {
      label: url,
      ok: false,
      feedback: toMediaCaptureFeedback(error, fallback),
    };
  }
}

export async function runBoundedSourceUrlCaptures<T>(
  urls: string[],
  capture: (url: string) => Promise<T>,
  concurrency = SOURCE_INGEST_CONCURRENCY,
): Promise<T[]> {
  const settled: T[] = new Array(urls.length);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, urls.length) },
    async () => {
      while (nextIndex < urls.length) {
        const index = nextIndex;
        nextIndex += 1;
        settled[index] = await capture(urls[index]);
      }
    },
  );
  await Promise.all(workers);
  return settled;
}
