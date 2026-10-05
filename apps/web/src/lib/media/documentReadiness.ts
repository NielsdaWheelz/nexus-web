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
