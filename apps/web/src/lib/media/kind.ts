import * as Icon from "@/lib/ui/icons";
import type { Schema } from "@/lib/api/wire";

export type MediaKind = Schema<"MediaKind">;

// The medium ingest proved for each kind, as a sign and a count noun.
const KINDS: Record<MediaKind, readonly [Icon.Glyph, string]> = {
  epub: [Icon.Book, "book"],
  web_article: [Icon.WebText, "article"],
  pdf: [Icon.Page, "pdf"],
  text_part: [Icon.Page, "piece"],
  podcast_episode: [Icon.Episode, "episode"],
  video: [Icon.Video, "video"],
};

export const mediaKindGlyph = (kind: MediaKind): Icon.Glyph => KINDS[kind][0];
export const mediaKindLabel = (kind: MediaKind): string => KINDS[kind][1];

export const MEDIA_KINDS = [
  "web_article",
  "epub",
  "text_part",
  "pdf",
  "podcast_episode",
  "video",
] as const satisfies readonly MediaKind[];
