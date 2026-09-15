"use client";

/**
 * Hosted page-highlight resource — the media pane's single owner of the PDF
 * page-highlight fetch that decorates the reader leaf. Highlights are a hosted
 * layer over canonical content, so this wiring (including the render-readiness
 * gate that keeps highlight fetches off unrendered pages) lives with the
 * hosted composition, not in the shared reader composition.
 */
import { useResource, type AsyncResource } from "@/lib/api/useResource";
import type { PdfReaderResourceState } from "@/components/PdfReader";
import type {
  PdfHighlightOut,
  PdfReaderDecorations,
} from "@/lib/reader/ReaderDecorations";

export function useHostedPdfPageHighlights({
  mediaId,
  enabled,
  decorations,
  resourceState,
  refreshToken,
}: {
  readonly mediaId: string;
  readonly enabled: boolean;
  readonly decorations: PdfReaderDecorations;
  readonly resourceState: PdfReaderResourceState;
  readonly refreshToken: number;
}): AsyncResource<PdfHighlightOut[]> {
  return useResource<PdfHighlightOut[]>({
    cacheKey:
      enabled &&
      resourceState.numPages > 0 &&
      !resourceState.loading &&
      resourceState.error === null
        ? `${mediaId}:${resourceState.pageNumber}:${refreshToken}`
        : null,
    load: (signal) =>
      decorations
        .loadPageHighlights(resourceState.pageNumber, signal)
        .then((highlights) => [...highlights]),
  });
}
