/**
 * Hosted PDF decoration adapter — the media pane's HTTP implementation of the
 * reader's decoration port. Highlights are a hosted layer over canonical
 * content, so this transport lives with the hosted composition rather than in
 * `lib/reader/`; offline readers supply no decoration implementation.
 */
import { apiFetch } from "@/lib/api/client";
import type { HighlightColor } from "@/lib/highlights/segmenter";
import { decodeHighlightLinkedNoteBlock } from "@/lib/highlights/highlightContract";
import type {
  PdfHighlightOut,
  PdfHighlightWrite,
  PdfReaderDecorations,
} from "@/lib/reader/ReaderDecorations";

interface PdfHighlightListResponse {
  readonly data: {
    readonly page_number: number;
    readonly highlights: PdfHighlightOut[];
  };
}

interface PdfHighlightCreateResponse {
  readonly data: PdfHighlightOut;
}

class HostedPdfReaderDecorations implements PdfReaderDecorations {
  constructor(readonly mediaId: string) {}

  async loadPageHighlights(
    pageNumber: number,
    signal: AbortSignal,
  ): Promise<readonly PdfHighlightOut[]> {
    const response = await apiFetch<PdfHighlightListResponse>(
      `/api/media/${this.mediaId}/pdf-highlights?page_number=${pageNumber}&mine_only=false`,
      { signal },
    );
    return response.data.highlights.map((highlight) => ({
      ...highlight,
      linked_note_blocks: highlight.linked_note_blocks.map((note, index) =>
        decodeHighlightLinkedNoteBlock(note, `PDF highlight ${highlight.id} note ${index}`),
      ),
    }));
  }

  async createHighlight(
    input: PdfHighlightWrite & { readonly color: HighlightColor },
  ): Promise<PdfHighlightOut> {
    const response = await apiFetch<PdfHighlightCreateResponse>(
      `/api/media/${this.mediaId}/pdf-highlights`,
      {
        method: "POST",
        body: JSON.stringify({
          page_number: input.pageNumber,
          quads: input.quads,
          exact: input.exact,
          color: input.color,
        }),
      },
    );
    return {
      ...response.data,
      linked_note_blocks: response.data.linked_note_blocks.map((note, index) =>
        decodeHighlightLinkedNoteBlock(note, `PDF highlight note ${index}`),
      ),
    };
  }

  async updateHighlight(
    highlightId: string,
    input: PdfHighlightWrite,
  ): Promise<void> {
    await apiFetch(`/api/highlights/${highlightId}`, {
      method: "PATCH",
      body: JSON.stringify({
        exact: input.exact,
        anchor: {
          type: "pdf_page_geometry",
          page_number: input.pageNumber,
          quads: input.quads,
        },
      }),
    });
  }
}

export function createHostedPdfReaderDecorations(
  mediaId: string,
): PdfReaderDecorations {
  return new HostedPdfReaderDecorations(mediaId);
}
