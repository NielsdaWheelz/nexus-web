import type { RetrievalLocator } from "@/lib/api/sse/locators";

export type CitationRole = "supports" | "contradicts" | "context";
export type CitationTargetType = "evidence_span" | "content_chunk" | "media";

export interface CitationTargetRef {
  type: CitationTargetType;
  id: string;
}

export interface CitationSnapshot {
  title?: string | null;
  excerpt?: string | null;
  section_label?: string | null;
  /** Per-media abstract from media_summaries; populated by the chat/search citation path, not by library-intelligence. */
  summary_md?: string | null;
  result_type?: string | null;
}

export interface CitationOut {
  ordinal: number;
  role: CitationRole;
  target_ref: CitationTargetRef;
  /** The jump anchor. For an evidence_span citation, target_ref.id is the span, NOT the media. */
  media_id: string | null;
  locator: RetrievalLocator | null;
  deep_link: string | null;
  snapshot: CitationSnapshot | null;
}
