/**
 * The reader-facing presentation of a media failure. It holds no reason
 * dictionary of its own: the one record per `SafeFailureCode` lives in
 * `lib/status/imports.ts`, and this module maps that record plus this viewer's
 * capabilities, source URL and retrieval status to what the screen shows
 * (contract §6).
 */

import { RESOURCE_ACTION_CATALOG } from "@/lib/actions/resourceActions";
import { assertNever } from "@/lib/assertNever";
import { SAFE_FAILURE_CODES } from "@/lib/imports/importRef";
import {
  IMPORT_FAILURE_COPY,
  type ImportFailureCopy,
} from "@/lib/status/imports";
import type { MediaProcessingProjectionStatus } from "./documentReadiness";

interface SourceCapabilities {
  can_retry: boolean;
}

type MediaErrorInput =
  | {
      kind: "Source";
      processingStatus: MediaProcessingProjectionStatus;
      lastErrorCode: string | null | undefined;
      capabilities: SourceCapabilities;
      sourceUrl: string | null;
    }
  | {
      kind: "Retrieval";
      retrievalStatus: string | null | undefined;
    };

type MediaErrorAction =
  | { kind: "None" }
  | { kind: "Retry" }
  | { kind: "OpenSource"; href: string };

export interface MediaErrorPresentation {
  kind: MediaErrorInput["kind"];
  severity: "warning" | "error";
  title: string;
  explanation: string;
  action: MediaErrorAction;
}

export function mediaErrorMessage(
  input: MediaErrorInput,
): MediaErrorPresentation | null {
  switch (input.kind) {
    case "Source":
      return sourceErrorMessage(input);
    case "Retrieval":
      return retrievalErrorMessage(input.retrievalStatus);
  }
}

/**
 * A failed import whose owner recorded no code says only what the catalog says
 * about an import that stopped; it never invents a cause.
 */
function failureCopy(raw: string | null | undefined): ImportFailureCopy {
  if (raw === null || raw === undefined) return IMPORT_FAILURE_COPY.E_INGEST_FAILED;
  const code = SAFE_FAILURE_CODES.find((candidate) => candidate === raw);
  if (code === undefined) {
    // justify-defect: last_error_code is decoded same-system source state.
    throw new Error(`Unsupported media source error code: ${raw}`);
  }
  return IMPORT_FAILURE_COPY[code];
}

function sourceAction(
  recovery: ImportFailureCopy["recovery"],
  capabilities: SourceCapabilities,
  sourceUrl: string | null,
): MediaErrorAction {
  switch (recovery) {
    case "SameSource":
      return capabilities.can_retry ? { kind: "Retry" } : { kind: "None" };
    case "OpenOriginal":
      return sourceUrl === null
        ? { kind: "None" }
        : { kind: "OpenSource", href: sourceUrl };
    case "None":
      return { kind: "None" };
    default:
      return assertNever(recovery, "Unreachable failure recovery");
  }
}

/**
 * A stopped import and a stopped search index are both states the reader is
 * offered a command for in Imports, so this names the command the action
 * catalog owns rather than repeating its wording here.
 */
const REPAIR_SOURCE_LABEL =
  RESOURCE_ACTION_CATALOG["ResourceOperation.Media.RepairSource"].label;
const REPAIR_SEARCH_LABEL =
  RESOURCE_ACTION_CATALOG["ResourceOperation.Media.RepairSearch"].label;

function sourceErrorMessage(
  input: Extract<MediaErrorInput, { kind: "Source" }>,
): MediaErrorPresentation | null {
  if (input.processingStatus === "suspended") {
    return {
      kind: "Source",
      severity: "error",
      title: "Processing stopped before this import finished.",
      explanation: `Automatic retries are used up. Imports offers ${REPAIR_SOURCE_LABEL}, which runs the stopped attempt again without creating a new one.`,
      action: { kind: "None" },
    };
  }
  if (input.processingStatus !== "failed") return null;
  const copy = failureCopy(input.lastErrorCode);
  return {
    kind: "Source",
    severity: "error",
    title: copy.title,
    explanation: copy.explanation,
    action: sourceAction(copy.recovery, input.capabilities, input.sourceUrl),
  };
}

function retrievalErrorMessage(
  retrievalStatus: string | null | undefined,
): MediaErrorPresentation | null {
  switch (retrievalStatus) {
    case null:
    case undefined:
    case "ready":
      return null;
    case "pending":
    case "indexing":
      return {
        kind: "Retrieval",
        severity: "warning",
        title: "Search and AI are still preparing.",
        explanation: "You can keep reading while document search is prepared.",
        action: { kind: "None" },
      };
    case "failed":
      return {
        kind: "Retrieval",
        severity: "error",
        title: "This document is readable, but search and AI are unavailable.",
        explanation: "Reading and quoting remain available.",
        action: { kind: "None" },
      };
    case "suspended":
      return {
        kind: "Retrieval",
        severity: "error",
        title: "Search indexing stopped. You can still read this document.",
        explanation: `${REPAIR_SEARCH_LABEL} in Imports rebuilds it from the text already imported; the source is not fetched or extracted again.`,
        action: { kind: "None" },
      };
    case "no_text":
      return {
        kind: "Retrieval",
        severity: "warning",
        title: "Search and AI are unavailable because no text was found.",
        explanation: "The document can still be read.",
        action: { kind: "None" },
      };
    case "ocr_required":
      return {
        kind: "Retrieval",
        severity: "warning",
        title: "Search and AI are unavailable until this document has OCR.",
        explanation: "The document can still be read.",
        action: { kind: "None" },
      };
    default:
      // justify-defect: retrieval status is decoded same-system data.
      throw new Error(`Unsupported media retrieval status: ${retrievalStatus}`);
  }
}
