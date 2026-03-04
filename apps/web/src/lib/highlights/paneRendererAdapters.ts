import type { PdfHighlightNavigationRequest, PdfHighlightOut } from "@/components/PdfReader";

export interface PaneNavigationAdapter {
  resolveNavigationRequest(highlightId: string): PdfHighlightNavigationRequest | null;
}

class NoopNavigationAdapter implements PaneNavigationAdapter {
  resolveNavigationRequest(): PdfHighlightNavigationRequest | null {
    return null;
  }
}

class PdfNavigationAdapter implements PaneNavigationAdapter {
  private readonly byId: Map<string, PdfHighlightOut>;

  constructor(highlights: PdfHighlightOut[]) {
    this.byId = new Map(highlights.map((highlight) => [highlight.id, highlight]));
  }

  resolveNavigationRequest(highlightId: string): PdfHighlightNavigationRequest | null {
    const highlight = this.byId.get(highlightId);
    if (!highlight) {
      return null;
    }
    return {
      highlightId: highlight.id,
      pageNumber: highlight.anchor.page_number,
      quads: highlight.anchor.quads,
    };
  }
}

const NOOP_NAVIGATION_ADAPTER = new NoopNavigationAdapter();

export function createPdfPaneNavigationAdapter(highlights: PdfHighlightOut[]): PaneNavigationAdapter {
  return new PdfNavigationAdapter(highlights);
}

export function createNoopPaneNavigationAdapter(): PaneNavigationAdapter {
  return NOOP_NAVIGATION_ADAPTER;
}

