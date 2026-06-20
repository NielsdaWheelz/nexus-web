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

// The ONE initial-fragments gate (allowlist), shared by the server seed, the client
// mount, and prefetch via paneResourceLoaders — so a server seed can never under-load
// vs the client for a given kind. Only podcast/video render the `fragments` array as
// first-paint content (epub → /sections, pdf → binary, web_article → its own deferred
// loader). C9: any future fragment-rendering kind must be added here AND given an
// empty-seed recovery loader (the web_article / shouldLoadWebArticleFragments pattern),
// since a consumed empty seed skips the client's first fetch and never self-heals.
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
