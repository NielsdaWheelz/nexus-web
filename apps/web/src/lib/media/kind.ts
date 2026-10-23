import type { Schema } from "@/lib/api/wire";

export type MediaKind = Schema<"MediaKind">;

const MEDIA_KIND_LABELS: Record<MediaKind, string> = {
  web_article: "article",
  epub: "book",
  text_part: "piece",
  pdf: "pdf",
  podcast_episode: "episode",
  video: "video",
};

/** human media identity; unknown structured kinds are contract defects. */
export function mediaKindLabel(kind: string): string {
  for (const [knownKind, label] of Object.entries(MEDIA_KIND_LABELS)) {
    if (kind === knownKind) return label;
  }
  throw new Error(`unknown media kind: ${kind}`);
}

export const MEDIA_KINDS = [
  "web_article",
  "epub",
  "text_part",
  "pdf",
  "podcast_episode",
  "video",
] as const satisfies readonly MediaKind[];
