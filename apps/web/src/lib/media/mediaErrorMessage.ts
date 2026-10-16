/**
 * What a reader is told about a media's failed import or unavailable search. The copy
 * per failure code is `lib/imports/copy.ts`'s; this maps it, the source url and the
 * retrieval status to a banner. Recovery commands are named, not repeated: the action
 * catalog owns their wording, and Imports offers them.
 */

import { ACTION_CATALOG } from "@/lib/actions/catalog";
import { FAILURE_COPY, isSafeFailureCode } from "@/lib/imports/copy";
import type { MediaDetail } from "./mediaDetail";

type MediaErrorInput =
  | {
      kind: "Source";
      processingStatus: MediaDetail["processing_status"];
      lastErrorCode: string | null;
      // Unread (issue media-pane-contract-leftovers): its owner drops it.
      capabilities: { can_retry: boolean };
      sourceUrl: string | null;
    }
  | { kind: "Retrieval"; retrievalStatus: string | null };

export interface MediaErrorPresentation {
  kind: MediaErrorInput["kind"];
  severity: "warning" | "error";
  title: string;
  explanation: string;
  action: { kind: "None" } | { kind: "OpenSource"; href: string };
}

type Banner = Pick<
  MediaErrorPresentation,
  "severity" | "title" | "explanation"
>;

const NONE = { kind: "None" } as const;
const PREPARING: Banner = {
  severity: "warning",
  title: "Search and AI are still preparing.",
  explanation: "You can keep reading while document search is prepared.",
};
const RETRIEVAL: Record<string, Banner | null> = {
  ready: null,
  pending: PREPARING,
  indexing: PREPARING,
  failed: {
    severity: "error",
    title: "This document is readable, but search and AI are unavailable.",
    explanation: "Reading and quoting remain available.",
  },
  suspended: {
    severity: "error",
    title: "Search indexing stopped. You can still read this document.",
    explanation: `${ACTION_CATALOG.RepairSearch.label} in Imports rebuilds it from the text already imported; the source is not fetched or extracted again.`,
  },
  no_text: {
    severity: "warning",
    title: "Search and AI are unavailable because no text was found.",
    explanation: "The document can still be read.",
  },
  ocr_required: {
    severity: "warning",
    title: "Search and AI are unavailable until this document has OCR.",
    explanation: "The document can still be read.",
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
      severity: "error",
      title: "Processing stopped before this import finished.",
      explanation: `Automatic retries are used up. Imports offers ${ACTION_CATALOG.RepairSource.label}, which runs the stopped attempt again without creating a new one.`,
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
    recovery === "OpenOriginal" && input.sourceUrl !== null
      ? ({ kind: "OpenSource", href: input.sourceUrl } as const)
      : NONE;
  return { kind: "Source", severity: "error", title, explanation, action };
}
