import type { MediaProcessingProjectionStatus } from "./documentReadiness";

interface SourceCapabilities {
  can_retry: boolean;
  can_refresh_source: boolean;
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

function sourceErrorMessage(
  input: Extract<MediaErrorInput, { kind: "Source" }>,
): MediaErrorPresentation | null {
  if (input.processingStatus === "suspended") {
    return {
      kind: "Source",
      severity: "error",
      title: "Import stopped; repair required.",
      explanation:
        "Automatic retries are exhausted. The stopped import remains visible for operator repair.",
      action: { kind: "None" },
    };
  }
  if (input.processingStatus !== "failed") return null;

  switch (input.lastErrorCode) {
    case "E_SOURCE_ACCESS_DENIED":
      return {
        kind: "Source",
        severity: "error",
        title: "This page blocked the import.",
        explanation:
          "Open the original page in your browser and use Nexus Capture there.",
        action: input.sourceUrl
          ? { kind: "OpenSource", href: input.sourceUrl }
          : { kind: "None" },
      };
    case "E_INVALID_FILE_TYPE":
      return {
        kind: "Source",
        severity: "error",
        title: "This link is not a valid PDF or EPUB.",
        explanation: "Use a valid direct download link or upload the file.",
        action: input.capabilities.can_retry
          ? { kind: "Retry" }
          : { kind: "None" },
      };
    case "E_SOURCE_TOO_LARGE":
      return {
        kind: "Source",
        severity: "error",
        title: "This document is too large to import.",
        explanation: "Use a smaller PDF or EPUB, or upload a smaller file.",
        action: input.capabilities.can_retry
          ? { kind: "Retry" }
          : { kind: "None" },
      };
    case "E_SOURCE_NOT_READABLE":
      return {
        kind: "Source",
        severity: "error",
        title: "Nexus could not find a readable article.",
        explanation:
          "Use a different source, or open the original page and capture it from your browser.",
        action: input.sourceUrl
          ? { kind: "OpenSource", href: input.sourceUrl }
          : { kind: "None" },
      };
    case "E_PDF_PASSWORD_REQUIRED":
      return {
        kind: "Source",
        severity: "error",
        title: "This PDF is password-protected.",
        explanation: "Upload an unlocked PDF to read it in Nexus.",
        action: input.capabilities.can_retry
          ? { kind: "Retry" }
          : { kind: "None" },
      };
    case "E_ARCHIVE_UNSAFE":
      return {
        kind: "Source",
        severity: "error",
        title: "This EPUB cannot be opened safely.",
        explanation: "Use a valid EPUB from a trusted source.",
        action: input.capabilities.can_retry
          ? { kind: "Retry" }
          : { kind: "None" },
      };
    case "E_BILLING_REQUIRED":
      // Retrying the same source cannot clear a billing requirement, so the
      // copy is causal and offers no futile Retry.
      return {
        kind: "Source",
        severity: "error",
        title: "Import needs billing set up.",
        explanation: "This import isn’t available on the current plan.",
        action: { kind: "None" },
      };
    case "E_PODCAST_QUOTA_EXCEEDED":
    case "E_X_PROVIDER_CREDITS_DEPLETED":
      // An exhausted import allowance is not cleared by retrying the same
      // source, so the copy is causal and offers no futile Retry.
      return {
        kind: "Source",
        severity: "error",
        title: "Import allowance reached.",
        explanation:
          "This source can’t be imported right now because an import allowance was used up.",
        action: { kind: "None" },
      };
    case null:
    case undefined:
    case "E_CAPTURE_TOO_LARGE":
    case "E_FILE_TOO_LARGE":
    case "E_INGEST_FAILED":
    case "E_INGEST_TIMEOUT":
    case "E_INVALID_CONTENT_TYPE":
    case "E_INVALID_REQUEST":
    case "E_PODCAST_PROVIDER_UNAVAILABLE":
    case "E_SANITIZATION_FAILED":
    case "E_SIGN_UPLOAD_FAILED":
    case "E_SOURCE_FETCH_FAILED":
    case "E_SSRF_BLOCKED":
    case "E_STORAGE_ERROR":
    case "E_STORAGE_MISSING":
    case "E_TRANSCRIPTION_FAILED":
    case "E_TRANSCRIPTION_TIMEOUT":
    case "E_TRANSCRIPT_UNAVAILABLE":
    case "E_X_POST_UNAVAILABLE":
    case "E_X_PROVIDER_AUTH_REJECTED":
    case "E_X_PROVIDER_RATE_LIMITED":
    case "E_X_PROVIDER_TIMEOUT":
      return {
        kind: "Source",
        severity: "error",
        title: "Import failed.",
        explanation: input.capabilities.can_retry
          ? "The source could not be imported. You can retry the same source."
          : "The source could not be imported. Use a different source.",
        action: input.capabilities.can_retry
          ? { kind: "Retry" }
          : { kind: "None" },
      };
    default:
      // justify-defect: last_error_code is decoded same-system source state.
      throw new Error(
        `Unsupported media source error code: ${input.lastErrorCode}`,
      );
  }
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
        title: "Search and AI stopped and need repair.",
        explanation: "Reading remains available; repair is an internal operation.",
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
