/**
 * Reader decoration contracts.
 *
 * Highlights/decorations are a hosted layer over canonical content: these are
 * the leaf-facing types only. The hosted HTTP adapter lives with the hosted
 * composition (`app/(authenticated)/media/[id]/hostedPdfReaderDecorations.ts`);
 * offline supplies no decoration implementation.
 */
import { publicationPayloadBytes } from "@/lib/api/resourceCache";
import type { HighlightColor } from "@/lib/highlights/segmenter";
import type { PdfHighlightQuad } from "@/lib/highlights/pdfTypes";
import type { ReaderPdfPaintLease, ReaderViewCapacity } from "./DocumentReaderSession";

/** Paint carries source geometry and identity; authored details have a separate read owner. */
export interface PdfHighlightPaint {
  readonly id: string;
  readonly color: HighlightColor;
  readonly created_at: string;
  readonly author_user_id: string;
  readonly is_owner: boolean;
  readonly quads: readonly PdfHighlightQuad[];
}

export interface PdfHighlightOut {
  readonly id: string;
  readonly anchor: {
    readonly type: "pdf_page_geometry";
    readonly media_id: string;
    readonly source_sha256: string | null;
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
  readonly linked_note_blocks?: {
    readonly note_block_id: string;
    readonly body_pm_json?: Record<string, unknown>;
    readonly body_text: string;
  }[];
}

export interface PdfHighlightWrite {
  readonly pageNumber: number;
  readonly quads: PdfHighlightQuad[];
  readonly exact: string;
}

export interface PdfReaderDecorations {
  adoptHighlightPaint(highlight: PdfHighlightOut): { readonly kind: "Acquired"; readonly lease: ReaderPdfPaintLease } | ReaderViewCapacity;
  createHighlight(
    input: PdfHighlightWrite & { readonly color: HighlightColor },
  ): Promise<PdfHighlightOut>;
  updateHighlight(
    highlightId: string,
    input: PdfHighlightWrite,
  ): Promise<PdfHighlightOut>;
}

export const PDF_PULSE_KEY_PREFIX = "reader-pulse-";

export interface PdfHighlightRectangle {
  readonly highlightId: string;
  readonly color: HighlightColor;
  readonly index: number;
  readonly isTemporary: boolean;
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** Both retiring and replacement rect payloads; node/allocator cost is separate. */
export function pdfHighlightProjectionPayloadBytes(highlightId: string, color: HighlightColor, quadCount: number): number {
  const rectangle: PdfHighlightRectangle = { highlightId, color, index: 0, isTemporary: false,
    left: 0, top: 0, width: 0, height: 0 };
  return 2 * quadCount * publicationPayloadBytes(rectangle);
}
