import type { Schema } from "@/lib/api/wire";

export type MediaKind = Schema<"MediaKind">;

export const MEDIA_KINDS = [
  "web_article",
  "epub",
  "pdf",
  "podcast_episode",
  "video",
] as const satisfies readonly MediaKind[];
