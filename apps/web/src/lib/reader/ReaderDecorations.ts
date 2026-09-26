/**
 * Reader decoration contracts.
 *
 * Highlights/decorations are a hosted layer over canonical content: these are
 * the leaf-facing types only. The hosted HTTP adapter lives with the hosted
 * composition (`app/(authenticated)/media/[id]/hostedPdfReaderDecorations.ts`);
 * offline supplies no decoration implementation.
 */
import type { HighlightColor } from "@/lib/highlights/segmenter";
import type { PdfHighlightQuad } from "@/lib/highlights/pdfTypes";
import type { HighlightLinkedNoteBlock } from "@/lib/highlights/highlightContract";

export interface PdfHighlightOut {
  readonly id: string;
  readonly anchor: {
    readonly type: "pdf_page_geometry";
    readonly media_id: string;
    readonly page_number: number;
    readonly quads: PdfHighlightQuad[];
  };
  readonly color: HighlightColor;
  readonly exact: string;
  readonly prefix: string;
  readonly suffix: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly author_user_id: string;
  readonly is_owner: boolean;
  readonly linked_conversations?: {
    readonly conversation_id: string;
    readonly title: string;
  }[];
  readonly linked_note_blocks: HighlightLinkedNoteBlock[];
}

export interface PdfHighlightWrite {
  readonly pageNumber: number;
  readonly quads: PdfHighlightQuad[];
  readonly exact: string;
}

export interface PdfReaderDecorations {
  loadPageHighlights(
    pageNumber: number,
    signal: AbortSignal,
  ): Promise<readonly PdfHighlightOut[]>;
  createHighlight(
    input: PdfHighlightWrite & { readonly color: HighlightColor },
  ): Promise<PdfHighlightOut>;
  updateHighlight(
    highlightId: string,
    input: PdfHighlightWrite,
  ): Promise<void>;
}
