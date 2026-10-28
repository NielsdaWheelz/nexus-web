/**
 * What a reader is told about a media's failed import or unavailable search. The copy
 * per failure code is `lib/imports/copy.ts`'s; this maps it and the
 * retrieval status to shared feedback. Recovery commands are named, not repeated: the action
 * catalog owns their wording, and Imports offers them.
 */

import { ACTION_CATALOG } from "@/lib/actions/catalog";
import type { FeedbackContent } from "@/components/feedback/Feedback";
import { FAILURE_COPY, isSafeFailureCode } from "@/lib/imports/copy";
import type { MediaDetail } from "./mediaDetail";

type MediaErrorInput =
  | {
      kind: "Source";
      processingStatus: MediaDetail["processing_status"];
      lastErrorCode: string | null;
    }
  | { kind: "Retrieval"; retrievalStatus: string | null; textSearchReady: boolean };

export interface MediaErrorPresentation extends FeedbackContent {
  kind: MediaErrorInput["kind"];
}

const RETRIEVAL: Record<string, FeedbackContent | null> = {
  ready: null,
  pending: { tone: "Neutral", title: "preparing text search" },
  indexing: { tone: "Neutral", title: "preparing text search" },
  failed: { tone: "Warning", title: "preparing text search", message: "open imports to continue search preparation." },
  suspended: { tone: "Warning", title: "preparing text search", message: `${ACTION_CATALOG.RepairSearch.label} in imports continues search preparation from the imported text.` },
  no_text: { tone: "Neutral", title: "no searchable text was found in this copy" },
  ocr_required: { tone: "Neutral", title: "this copy needs text recognition before its text can be searched" },
};

export function mediaErrorMessage(
  input: MediaErrorInput,
): MediaErrorPresentation | null {
  if (input.kind === "Retrieval") {
    if (input.retrievalStatus === null) return null;
    const banner = RETRIEVAL[input.retrievalStatus];
    if (banner === undefined)
      // justify-defect: retrieval status is same-system data.
      throw new Error(
        `Unsupported media retrieval status: ${input.retrievalStatus}`,
      );
    if (input.textSearchReady && (input.retrievalStatus === "pending" || input.retrievalStatus === "indexing" || input.retrievalStatus === "failed" || input.retrievalStatus === "suspended")) {
      const stopped = input.retrievalStatus === "failed" || input.retrievalStatus === "suspended";
      return { kind: "Retrieval", tone: stopped ? "Warning" : "Neutral", title: stopped ? "text search is ready; related matches are unavailable" : "text search is ready; related matches are preparing" };
    }
    return banner && { kind: "Retrieval", ...banner };
  }
  if (input.processingStatus === "suspended")
    return {
      kind: "Source",
      tone: "Danger",
      title: "processing stopped before this import finished",
      message: `automatic retries are used up. ${ACTION_CATALOG.RepairSource.label} in imports runs the stopped attempt again.`,
    };
  if (input.processingStatus !== "failed") return null;
  // A failure with no recorded code says only what the catalog says of a stopped import.
  const code = input.lastErrorCode ?? "E_INGEST_FAILED";
  if (!isSafeFailureCode(code))
    // justify-defect: last_error_code is same-system source state.
    throw new Error(`Unsupported media source error code: ${code}`);
  const { title, explanation } = FAILURE_COPY[code];
  return { kind: "Source", tone: "Danger", title, message: explanation };
}
