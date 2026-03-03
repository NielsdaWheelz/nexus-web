# pr-07: frontend pdf highlights and linked-items adapter

## goal
Ship persistent PDF highlight UX in the web reader and integrate PDF highlights into the existing linked-items pane via a PDF alignment adapter.

## builds on
- pr-04 (PDF highlight create/list/update APIs and typed highlight responses)
- pr-05 (PDF quote-to-chat semantics on highlight/annotation targets)
- pr-06 (PDF.js reader transport, readiness states, and signed-URL recovery)

## acceptance
- text-layer selection capture creates persistent PDF highlights with captured `exact` text and stable geometry, and created highlights reappear in the same page region after reload.
- PDF highlight edit/delete/color/annotation actions work through existing highlight routes and preserve existing ownership/visibility semantics.
- PDF overlay rendering applies persisted highlight color semantics from the existing palette, supports overlaps, and does not collapse to a single hardcoded color.
- overlay reprojection/redraw trigger matrix is explicit and covered for at least: page/text-layer render availability changes, viewer zoom/scale changes, viewer rotation changes (if rotation is exposed), and highlight-data changes.
- highlights for not-yet-rendered pages may be absent initially but appear when that page/text layer becomes available, without refetching or rewriting persisted geometry.
- the existing linked-items pane shell is reused for PDF highlights; in S6 it is active-page scoped and updates when active page changes while preserving row interactions (focus/scroll/quote/annotation).
- if DOM text walking is used for PDF selection capture or pane alignment, those paths share a single text-layer eligibility/filtering domain.
- pages without a usable text layer do not present a false-success PDF highlight creation path.
- existing HTML/EPUB highlight and linked-items behavior remains unchanged.

## key decisions
- **active-page scope in s6**: PDF highlight overlay + linked-items behavior is page-scoped; media-wide PDF highlight browsing remains deferred.
- **adapter boundary**: linked-items alignment for PDF uses renderer-provided anchor positions and does not require HTML span-anchor injection semantics.

## implementation notes (current)
- the web reader now delegates rendering to upstream PDF.js viewer primitives (`PDFViewer`, `PDFLinkService`, `EventBus`) instead of custom canvas/text-layer orchestration.
- continuous reading is enabled with vertical scroll mode, so multiple page text layers can exist simultaneously in the DOM.
- viewer runtime assets are served via Next routes (`/api/pdfjs/module`, `/api/pdfjs/worker`, `/api/pdfjs/viewer`) to preserve CSP-safe loading in app/runtime tests.
- `pdfjs-dist/web/pdf_viewer.css` is loaded globally; this is required for text-layer positioning and annotation-link hit targets.
- E2E tests must scope text selection to a specific page number instead of assuming a single `.textLayer` element.

## non-goals
- no separate PDF-only linked-items pane and no full cross-object linked-items unification beyond the S6 PDF adapter.
- no perfect text-to-geometry reconciliation across all PDFs/text layers.
- no required direct click/hover interaction on PDF overlay rectangles beyond pane-driven interactions.
- no changes to backend geometry canonicalization or PDF quote-match persistence contracts.
