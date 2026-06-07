import { isRetrievalLocator, type RetrievalLocator } from "@/lib/api/sse/locators";
import type { MessageRetrieval } from "./types";

/**
 * A citation activation target. Discriminated on `kind`:
 *  - `media` — a span inside a media reader (PDF / EPUB / web / transcript …),
 *    located by `media_id` + a media `RetrievalLocator`.
 *  - `note` — a span inside a notes page, located by `page_id` / `block_id` and
 *    a character offset range. Notes are not media, so they have no `media_id`.
 */
export type ReaderSourceTarget = MediaReaderTarget | NoteReaderTarget;

export interface MediaReaderTarget {
  kind: "media";
  source: "message_retrieval";
  media_id: string;
  locator: RetrievalLocator;
  snippet: string | null;
  highlight_behavior: "pulse";
  focus_behavior: "scroll_into_view";
  status: string;
  label?: string;
  href?: string | null;
  evidence_span_id?: string | null;
  evidence_id?: string;
}

export interface NoteReaderTarget {
  kind: "note";
  source: "message_retrieval";
  page_id: string;
  block_id: string;
  start_offset: number;
  end_offset: number;
  snippet: string | null;
  highlight_behavior: "pulse";
  focus_behavior: "scroll_into_view";
  status: string;
  label?: string;
  href?: string | null;
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

/** Deep link for a note citation: the notes pane focused on a single block. */
export function hrefForNoteTarget(input: { block_id: string }): string {
  return `/notes/${input.block_id}`;
}

export function readerTargetFromRetrieval(
  retrieval: MessageRetrieval,
): ReaderSourceTarget | null {
  if (!isRetrievalLocator(retrieval.locator ?? null)) {
    return null;
  }
  const locator = retrieval.locator!;

  // Note-block citations carry no media_id; they are located inside a notes page.
  if (retrieval.result_type === "note_block" || locator.type === "note_block_offsets") {
    if (locator.type !== "note_block_offsets") return null;
    return {
      kind: "note",
      source: "message_retrieval",
      page_id: locator.page_id,
      block_id: locator.block_id,
      start_offset: locator.start_offset,
      end_offset: locator.end_offset,
      snippet: retrieval.exact_snippet ?? null,
      highlight_behavior: "pulse",
      focus_behavior: "scroll_into_view",
      status: retrieval.retrieval_status ?? "retrieved",
      label: retrieval.source_title ?? undefined,
      href: retrieval.deep_link ?? hrefForNoteTarget({ block_id: locator.block_id }),
      evidence_id: retrieval.id,
    };
  }

  if (!retrieval.media_id) {
    return null;
  }
  return {
    kind: "media",
    source: "message_retrieval",
    media_id: retrieval.media_id,
    locator,
    snippet: retrieval.exact_snippet ?? null,
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
