import { isRetrievalLocator, type RetrievalLocator } from "@/lib/api/sse/locators";
import type { ReaderSelectionOut } from "@/lib/conversations/readerSelection";
import type { MessageRetrieval } from "./types";

/**
 * A citation activation target. Discriminated on `kind`:
 *  - `media` — a span inside a media reader (PDF / EPUB / web / transcript …),
 *    located by `media_id` + a media `RetrievalLocator`.
 *  - `note` — a span inside a note block. Notes are not media, so they have
 *    no `media_id`.
 */
export type ReaderSourceTarget = MediaReaderTarget | NoteReaderTarget;

export interface MediaReaderTarget {
  kind: "media";
  source: "message_retrieval" | "reader_selection";
  media_id: string;
  locator: RetrievalLocator;
  snippet: string | null;
  highlight_behavior: "pulse";
  focus_behavior: "scroll_into_view";
  // Retrieval-status hint, set by `readerTargetFromRetrieval`. The CitationOut
  // render path (`readerTargetForCitation`) has no status source, so optional.
  status?: string;
  label?: string;
  href?: string | null;
  evidence_span_id?: string | null;
  evidence_id?: string;
}

export interface NoteReaderTarget {
  kind: "note";
  source: "message_retrieval";
  block_id: string;
  start_offset: number;
  end_offset: number;
  snippet: string | null;
  highlight_behavior: "pulse";
  focus_behavior: "scroll_into_view";
  status?: string;
  label?: string;
  href?: string | null;
  evidence_id?: string;
}

/**
 * Build a reader-source activation target from an immutable reader-quote
 * snapshot (`ReaderSelectionOut`). CRITICAL: the reader positions from this
 * IMMUTABLE snapshot locator, never the live `#highlight-{id}` anchor — a sent
 * quote must resolve to exactly the passage it captured even after the live
 * Highlight moves, is edited, or disappears. Backend activation routes to
 * `/media/{id}` (visibility-gated); the FE scrolls via this locator target.
 */
export function readerTargetFromReaderSelection(
  selection: ReaderSelectionOut,
): ReaderSourceTarget {
  return {
    kind: "media",
    source: "reader_selection",
    media_id: selection.key.mediaId,
    locator: selection.locator,
    snippet: selection.exact,
    highlight_behavior: "pulse",
    focus_behavior: "scroll_into_view",
    label: selection.sourceLabel,
  };
}

export function readerTargetFromRetrieval(
  retrieval: MessageRetrieval,
): ReaderSourceTarget | null {
  if (!isRetrievalLocator(retrieval.locator ?? null)) {
    return null;
  }
  const locator = retrieval.locator!;

  // Note-block citations carry no media_id.
  if (retrieval.result_type === "note_block" || locator.type === "note_block_offsets") {
    if (locator.type !== "note_block_offsets") return null;
    return {
      kind: "note",
      source: "message_retrieval",
      block_id: locator.block_id,
      start_offset: locator.start_offset,
      end_offset: locator.end_offset,
      snippet: retrieval.exact_snippet ?? null,
      highlight_behavior: "pulse",
      focus_behavior: "scroll_into_view",
      status: retrieval.retrieval_status ?? "retrieved",
      label: retrieval.source_title ?? undefined,
      href: null,
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
    href: null,
    evidence_span_id: retrieval.evidence_span_id ?? null,
    evidence_id: retrieval.id,
  };
}
