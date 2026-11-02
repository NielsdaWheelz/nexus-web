import { AudioLines, BookOpen, FileText, Scroll, Video, type LucideIcon } from "lucide-react";
import type { Schema } from "@/lib/api/wire";

export type MediaKind = Schema<"MediaKind">;

// The medium ingest proved for each kind, as a drawing and a count noun.
const KINDS: Record<MediaKind, readonly [LucideIcon, string]> = {
  epub: [BookOpen, "book"],
  web_article: [Scroll, "article"],
  pdf: [FileText, "pdf"],
  text_part: [FileText, "piece"],
  podcast_episode: [AudioLines, "episode"],
  video: [Video, "video"],
};

export const mediaKindGlyph = (kind: MediaKind): LucideIcon => KINDS[kind][0];
export const mediaKindLabel = (kind: MediaKind): string => KINDS[kind][1];

export const MEDIA_KINDS = [
  "web_article",
  "epub",
  "text_part",
  "pdf",
  "podcast_episode",
  "video",
] as const satisfies readonly MediaKind[];
