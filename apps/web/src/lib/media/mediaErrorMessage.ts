/**
 * What a reader is told about a media's failed import or unavailable search. The copy
 * per failure code is `lib/imports/copy.ts`'s; this maps it, the viewer's retry
 * capability, the source url and the retrieval status to shared feedback. Recovery commands
 * are named, not repeated: the action catalog owns their wording.
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
      // Only the Retry arm reads it, and no surface renders that arm (Q3; issue
      // media-pane-contract-leftovers).
      capabilities: { can_retry: boolean };
      sourceUrl: string | null;
    }
  | { kind: "Retrieval"; retrievalStatus: string | null };

export interface MediaErrorPresentation extends FeedbackContent {
  kind: MediaErrorInput["kind"];
  action:
    { kind: "None" } | { kind: "Retry" } | { kind: "OpenSource"; href: string };
}

const NONE = { kind: "None" } as const;
const PREPARING: FeedbackContent = {
  tone: "Neutral",
  title: "search and ai are preparing",
};
const RETRIEVAL: Record<string, FeedbackContent | null> = {
  ready: null,
  pending: PREPARING,
  indexing: PREPARING,
  failed: {
    tone: "Warning",
    title: "search and ai are unavailable",
    message: "open imports to check search recovery.",
  },
  suspended: {
    tone: "Warning",
    title: "search preparation stopped",
    message: `${ACTION_CATALOG.RepairSearch.label} in imports rebuilds search from the text already imported.`,
  },
  no_text: {
    tone: "Neutral",
    title: "search and ai need document text",
    message: "no searchable text was found in this copy.",
  },
  ocr_required: {
    tone: "Neutral",
    title: "search and ai need text recognition",
    message: "this copy needs ocr before its text can be searched.",
  },
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
    return banner && { kind: "Retrieval", ...banner, action: NONE };
  }
  if (input.processingStatus === "suspended")
    return {
      kind: "Source",
      tone: "Danger",
      title: "processing stopped before this import finished",
      message: `automatic retries are used up. ${ACTION_CATALOG.RepairSource.label} in imports runs the stopped attempt again.`,
      action: NONE,
    };
  if (input.processingStatus !== "failed") return null;
  // A failure with no recorded code says only what the catalog says of a stopped import.
  const code = input.lastErrorCode ?? "E_INGEST_FAILED";
  if (!isSafeFailureCode(code))
    // justify-defect: last_error_code is same-system source state.
    throw new Error(`Unsupported media source error code: ${code}`);
  const { title, explanation, recovery } = FAILURE_COPY[code];
  const action =
    recovery === "SameSource" && input.capabilities.can_retry
      ? ({ kind: "Retry" } as const)
      : recovery === "OpenOriginal" && input.sourceUrl !== null
        ? ({ kind: "OpenSource", href: input.sourceUrl } as const)
        : NONE;
  return { kind: "Source", tone: "Danger", title, message: explanation, action };
}
