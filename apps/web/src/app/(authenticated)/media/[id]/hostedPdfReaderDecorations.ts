/**
 * Hosted PDF decoration adapter — the media pane's HTTP implementation of the
 * reader's decoration port. Highlights are a hosted layer over canonical
 * content, so this transport lives with the hosted composition rather than in
 * `lib/reader/`; offline readers supply no decoration implementation.
 */
import { apiFetch, decodeApiPayload } from "@/lib/api/client";
import { decodeMediaHighlight } from "@/lib/highlights/highlightContract";
import type { ReaderPublicationDescriptor } from "@/lib/reader/publicationContract";
import type { DocumentReaderSession } from "@/lib/reader/DocumentReaderSession";
import { expectExactRecord } from "@/lib/validation";
import type { HighlightColor } from "@/lib/highlights/segmenter";
import type {
  PdfHighlightOut,
  PdfHighlightWrite,
  PdfReaderDecorations,
} from "@/lib/reader/ReaderDecorations";

class HostedPdfReaderDecorations implements PdfReaderDecorations {
  constructor(readonly descriptor: Extract<ReaderPublicationDescriptor, { kind: "pdf" }>, readonly session: DocumentReaderSession) {}

  adoptHighlightPaint(highlight: PdfHighlightOut) { return this.session.adoptPdfHighlight(highlight); }

  async createHighlight(
    input: PdfHighlightWrite & { readonly color: HighlightColor },
  ): Promise<PdfHighlightOut> {
    const response = await apiFetch<unknown>(
      `/api/media/${this.descriptor.media_id}/pdf-highlights`,
      {
        method: "POST",
        body: JSON.stringify({
          reader_generation: this.descriptor.reader_generation,
          page_number: input.pageNumber,
          quads: input.quads,
          exact: input.exact,
          color: input.color,
        }),
      },
    );
    return this.decodeWrittenHighlight(response, null);
  }

  async updateHighlight(
    highlightId: string,
    input: PdfHighlightWrite,
  ): Promise<PdfHighlightOut> {
    const response = await apiFetch<unknown>(`/api/highlights/${highlightId}`, {
      method: "PATCH",
      body: JSON.stringify({
        exact: input.exact,
        anchor: {
          type: "pdf_page_geometry",
          reader_generation: this.descriptor.reader_generation,
          page_number: input.pageNumber,
          quads: input.quads,
        },
      }),
    });
    return this.decodeWrittenHighlight(response, highlightId);
  }

  private decodeWrittenHighlight(response: unknown, expectedId: string | null): PdfHighlightOut {
    return decodeApiPayload(response, (raw) => {
      const highlight = decodeMediaHighlight(expectExactRecord(raw, ["data"], "PDF highlight response").data);
      if (highlight.anchor.type !== "pdf_page_geometry" ||
          (expectedId !== null && highlight.id !== expectedId) ||
          highlight.anchor.media_id !== this.descriptor.media_id ||
          highlight.anchor.source_sha256 !== this.descriptor.document_asset_ref.sha256) {
        throw new Error("PDF highlight write returned another document source");
      }
      return { ...highlight, anchor: highlight.anchor };
    }, "PDF highlight");
  }
}

export function createHostedPdfReaderDecorations(
  descriptor: Extract<ReaderPublicationDescriptor, { kind: "pdf" }>,
  session: DocumentReaderSession,
): PdfReaderDecorations {
  return new HostedPdfReaderDecorations(descriptor, session);
}
