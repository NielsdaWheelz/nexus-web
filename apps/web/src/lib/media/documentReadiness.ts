export type DocumentProcessingStatus =
  | "pending"
  | "extracting"
  | "ready_for_reading"
  | "failed";

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
  return status === "ready_for_reading" || status === "failed";
}

export function canReadMediaDocument(media: {
  capabilities?: { can_read?: boolean } | null;
}): boolean {
  return media.capabilities?.can_read === true;
}

export function shouldLoadInitialMediaFragments(media: {
  kind?: string;
  capabilities?: { can_read?: boolean } | null;
}): boolean {
  return (
    (media.kind === "podcast_episode" || media.kind === "video") &&
    canReadMediaDocument(media)
  );
}

export function shouldLoadWebArticleFragments(
  media: {
    kind?: string;
    capabilities?: { can_read?: boolean } | null;
  } | null,
  currentFragmentCount: number,
): boolean {
  return (
    media?.kind === "web_article" &&
    currentFragmentCount === 0 &&
    canReadMediaDocument(media)
  );
}
