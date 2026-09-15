export const DOCUMENT_PROCESSING_STATUSES = [
  "pending",
  "extracting",
  "ready_for_reading",
  "failed",
] as const;

export type DocumentProcessingStatus =
  (typeof DOCUMENT_PROCESSING_STATUSES)[number];

export const MEDIA_PROCESSING_PROJECTION_STATUSES = [
  ...DOCUMENT_PROCESSING_STATUSES,
  "suspended",
] as const;

export type MediaProcessingProjectionStatus =
  (typeof MEDIA_PROCESSING_PROJECTION_STATUSES)[number];

export function requireDocumentProcessingStatus(
  status: string,
): DocumentProcessingStatus {
  if (
    status === "pending" ||
    status === "extracting" ||
    status === "ready_for_reading" ||
    status === "failed"
  ) {
    return status;
  }
  throw new Error(`Unsupported media processing status: ${status}`);
}

export function isDocumentProcessingTerminal(status: string): boolean {
  return (
    status === "ready_for_reading" ||
    status === "failed" ||
    status === "suspended"
  );
}

export function canReadMediaDocument(media: {
  capabilities?: { can_read?: boolean } | null;
}): boolean {
  return media.capabilities?.can_read === true;
}

// The ONE initial-fragments gate (allowlist), shared by the server seed, the client
// mount, and prefetch via paneResourceLoaders — so a server seed can never under-load
// vs the client for a given kind. Only podcast/video render the `fragments` array as
// first-paint content (epub → /sections, pdf → binary, web_article → the reader
// session's text source). Any future fragment-rendering kind must be added here
// so the seed and its first-paint consumer remain aligned.
export function shouldLoadInitialMediaFragments(media: {
  kind?: string;
  capabilities?: { can_read?: boolean } | null;
}): boolean {
  return (
    (media.kind === "podcast_episode" || media.kind === "video") &&
    canReadMediaDocument(media)
  );
}
