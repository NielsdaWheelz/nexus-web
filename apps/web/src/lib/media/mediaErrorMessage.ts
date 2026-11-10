/**
 * What a reader is told about a media's stopped import or its text search, as one line each.
 * The words per failure code are `lib/imports/copy.ts`'s. Search state alone grants no recovery.
 */

import type { Line } from "@/components/feedback/stage";
import { FAILURE_COPY, isSafeFailureCode } from "@/lib/imports/copy";
import type { MediaDetail } from "./mediaDetail";

const SEARCH: Record<string, Line | null> = {
  ready: null,
  pending: { fact: "preparing text search." },
  indexing: { fact: "preparing text search." },
  failed: { fact: "text search stopped." },
  suspended: { fact: "search preparation needs a repair." },
  no_text: { fact: "this copy has no searchable text." },
  ocr_required: { fact: "this copy needs text recognition before it can be searched." },
};

/** Text search's state; null once it is ready. Related matches prepare after text search. */
export function mediaSearchLine(retrievalStatus: string | null, textSearchReady: boolean): Line | null {
  if (retrievalStatus === null) return null;
  const line = SEARCH[retrievalStatus];
  if (line === undefined)
    // justify-defect: retrieval status is same-system data.
    throw new Error(`Unsupported media retrieval status: ${retrievalStatus}`);
  if (textSearchReady && line !== null && retrievalStatus !== "no_text" && retrievalStatus !== "ocr_required")
    return { fact: retrievalStatus === "suspended"
      ? "text search is ready. related matches need a repair."
      : retrievalStatus === "failed" ? "text search is ready. related matches aren’t."
        : "text search is ready. related matches are still preparing." };
  return line;
}

/** A stopped or failed import; null while processing runs or after it succeeded. */
export function mediaSourceLine(processingStatus: MediaDetail["processing_status"], lastErrorCode: string | null): Line | null {
  if (processingStatus === "suspended") {
    const fact = "this import needs a repair.";
    if (lastErrorCode === null) return { fact };
    if (!isSafeFailureCode(lastErrorCode))
      // justify-defect: last_error_code is same-system source state.
      throw new Error(`Unsupported media source error code: ${lastErrorCode}`);
    return { fact, reason: `${FAILURE_COPY[lastErrorCode].reason}.` };
  }
  if (processingStatus !== "failed") return null;
  // A failure with no recorded code says only what the catalog says of a stopped import.
  const code = lastErrorCode ?? "E_INGEST_FAILED";
  if (!isSafeFailureCode(code))
    // justify-defect: last_error_code is same-system source state.
    throw new Error(`Unsupported media source error code: ${code}`);
  const { title, explanation } = FAILURE_COPY[code];
  return explanation === null ? { fact: title } : { fact: title, reason: explanation };
}
