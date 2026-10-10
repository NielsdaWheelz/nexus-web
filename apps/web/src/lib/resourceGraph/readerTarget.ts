import type { RetrievalLocator } from "@/lib/resourceGraph/citationOut";

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
