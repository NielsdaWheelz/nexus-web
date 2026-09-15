export const MEDIA_KINDS = [
  "web_article",
  "epub",
  "pdf",
  "podcast_episode",
  "video",
] as const;

export type MediaKind = (typeof MEDIA_KINDS)[number];
