import { isRetrievalLocator, type RetrievalLocator } from "@/lib/api/sse/locators";
import type { MessageRetrieval } from "./types";

export interface ReaderSourceTarget {
  source: "message_retrieval";
  media_id: string;
  locator: RetrievalLocator;
  snippet: string | null;
  source_version: string;
  highlight_behavior: "pulse";
  focus_behavior: "scroll_into_view";
  status: string;
  label?: string;
  href?: string | null;
  evidence_span_id?: string | null;
  evidence_id?: string;
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

export function readerTargetFromRetrieval(
  retrieval: MessageRetrieval,
): ReaderSourceTarget | null {
  if (
    !retrieval.media_id ||
    !retrieval.source_version ||
    !isRetrievalLocator(retrieval.locator ?? null)
  ) {
    return null;
  }
  return {
    source: "message_retrieval",
    media_id: retrieval.media_id,
    locator: retrieval.locator!,
    snippet: retrieval.exact_snippet ?? null,
    source_version: retrieval.source_version,
    highlight_behavior: "pulse",
    focus_behavior: "scroll_into_view",
    status: retrieval.retrieval_status ?? "retrieved",
    label: retrieval.source_title ?? undefined,
    href:
      retrieval.deep_link ??
      hrefForReaderTarget({
        media_id: retrieval.media_id,
        evidence_span_id: retrieval.evidence_span_id,
        locator: retrieval.locator,
      }),
    evidence_span_id: retrieval.evidence_span_id ?? null,
    evidence_id: retrieval.id,
  };
}
