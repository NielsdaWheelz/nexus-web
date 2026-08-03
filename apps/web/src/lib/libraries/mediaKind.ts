export const LIBRARY_MEDIA_KINDS = [
  "web_article",
  "epub",
  "pdf",
  "podcast_episode",
  "video",
] as const;

export type LibraryMediaKind = (typeof LIBRARY_MEDIA_KINDS)[number];
