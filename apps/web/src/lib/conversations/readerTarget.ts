import type { RetrievalLocator } from "@/lib/api/sse/locators";

export interface ReaderSourceTarget {
  source: "message_retrieval";
  media_id: string;
  locator: RetrievalLocator;
  snippet: string | null;
  highlight_behavior: "pulse";
  focus_behavior: "scroll_into_view";
  label?: string;
  href?: string | null;
  evidence_span_id?: string | null;
}

export function hrefForReaderTarget(input: {
  media_id: string;
  evidence_span_id?: string | null;
  locator?: RetrievalLocator | null;
  highlight_id?: string | null;
}): string {
  const base = `/media/${input.media_id}`;
  if (input.evidence_span_id) return `${base}#evidence-${input.evidence_span_id}`;
  if (input.highlight_id) return `${base}#highlight-${input.highlight_id}`;
  const locator = input.locator;
  if (
    locator &&
    (locator.type === "web_text_offsets" || locator.type === "epub_fragment_offsets")
  ) {
    return `${base}#fragment-${locator.fragment_id}`;
  }
  if (locator && locator.type === "pdf_page_geometry") {
    return `${base}#page-${locator.page_number}`;
  }
  if (locator && locator.type === "transcript_time_range") {
    return `${base}#t-${locator.t_start_ms}`;
  }
  return base;
}
