# PDF Find Hard Cutover

Status: IMPLEMENTED — FOCUSED VERIFIED; REAL-STACK E2E PENDING
Type: hard cutover
Date: 2026-07-29

Open questions: none. Approved defaults are `Cmd/Ctrl+F`, **Entire PDF**,
frozen **This page**, literal PDF.js matching, Match case, Whole word,
Previous/Next, Companion results, search-neutral progress, and only **Go back
to reading position**.

Governing contracts:

- [`docs/rules/README.md`](../rules/README.md) and every rule it indexes;
- [`pane-search-foundation-hard-cutover.md`](pane-search-foundation-hard-cutover.md);
- [`canonical-text-surfaces-find-hard-cutover.md`](canonical-text-surfaces-find-hard-cutover.md);
- [`docs/modules/pdf.md`](../modules/pdf.md);
- [`docs/modules/reader-implementation.md`](../modules/reader-implementation.md).

## Decision

Add pane-local `FindOccurrences` to readable PDFs.

- Exactly pin PDF.js `5.7.284`; this cut depends on that version's exported
  `PDFFindController`, `PDFLinkService`, Find getters, overridable `match`, and
  EventBus events.
- Search the already loaded PDF in the browser. PDF.js remains the sole Find
  text, normalization, occurrence, and text-layer authority.
- Wrap PDF.js with one Nexus controller subclass and one find-only link-service
  subclass. The former captures page coverage and exposes direct result
  selection; the latter suppresses PDF.js's private automatic page jumps.
- Settle on the final `updatefindmatchescount`, never
  `updatefindcontrolstate`.
- Keep `usePaneFind` as the only session, stepping, Companion, and Return
  controller. Add no second Pane Find controller.
- Capture a provisional origin and acquire the existing media preview lease
  before each PDF.js query can run.

This is the 80/20 cut: complete native PDF Find and reversible preview without
a backend endpoint, OCR, index, migration, copied PDF.js algorithm, or
cross-extractor reconciliation.

## Goals

- Complete, deterministic PDF-page-order results.
- O(1) activation of any Companion occurrence.
- No PDF.js movement or marks before Nexus accepts complete results.
- One immutable reading origin and exact one-shot Return.
- No Find-induced progress, activity, completion, URL, target, or history.
- One query/controller path with explicit version and concurrency contracts.

## Scope

In: readable PDF panes, Entire PDF/This page scope, PDF.js matching and
text-layer marks, typed snippets, Companion activation, origin/lease handling,
Return, cancellation, accessibility, exact version pinning, and focused tests.

## Non-goals

- OCR or searching pixels, annotations, comments, forms, metadata, Nexus
  Highlights, apparatus, or linked resources.
- Fuzzy, semantic, stemmed, regex, AI, ranked, global, or saved search.
- Backend/BFF APIs, `media.plain_text`, `pdf_page_text_spans`, indexes, workers,
  caches, analytics, or persisted query state.
- A new PDF renderer, text layer, normalizer, generic matcher, or incremental
  result protocol.
- Multiple origins, a Find navigation stack, or **Continue from here**.
- PDF ingestion, highlight, resume-schema, or ordinary navigation redesign.

## Hard-cut Rules

- A ready PDF publishes only Pane `FindOccurrences`; no native browser Find,
  `window.find`, hidden PDF.js find bar, legacy search, compatibility path, or
  fallback remains.
- Never combine PDF.js locators with backend extracted text.
- Use only PDF.js exports, public accessors/methods, and EventBus events. Never
  read or mutate underscore-prefixed or `#private` state.
- PDF Find never calls `goToPage`, reader targets, URL navigation, Nexus
  Highlight navigation, or ordinary resume commands.
- The find-only link service must suppress PDF.js automatic page mutation.
  Early origin capture alone is insufficient.
- Source replacement aborts; malformed runtime state defects. No alternate
  search path is allowed.

## Target Behavior

| Event | Required result |
| --- | --- |
| `Cmd/Ctrl+F` in a ready PDF | Open/focus **Find in PDF** in that active pane |
| Open Find | Freeze source identity and current page for the session |
| Query starts | Capture provisional origin and acquire lease before PDF.js dispatch; stay at the reading position with no marks |
| Query/options change | Abort prior generation, clear its presentation, then run one debounced complete query |
| Ready | Activate the document-order first result once; show all marks and commit Return origin |
| Previous/Next | Wrap through shared `usePaneFind` row order |
| Companion row | Activate that exact occurrence directly |
| Show results | Existing transient `resource-search`; rows show `Page N` plus typed context |
| Empty/no matches | Do not move; discard an uncommitted origin/lease |
| Match 2,001 | `TooManyMatches(2000)`; no rows or transient marks |
| Close/Escape | Clear query/marks; leave a successfully previewed position and Return available |
| Go back | Restore page, zoom, page-to-viewport delta, and horizontal scroll; release lease and retire origin |
| Genuine input after preview | Existing activity owner releases lease; committed Return remains |
| Source/route replacement | Abort work and clear scope, results, marks, origin, and lease |

The scope defaults to **Entire PDF**. **This page (N)** is the page frozen by
`prepare`; preview movement never changes it. Reopening Find without a
committed Return origin prepares the current page again.

## Final Architecture And Ownership

```text
PaneShell / Cmd-F
  -> useMediaPaneFind                 (sole usePaneFind caller)
    -> exact Web | Transcript | PDF adapter selection
      -> usePdfPaneFind               (PaneFindAdapter)
        -> PdfFindRuntime from PdfReader
          -> NexusPdfFindController
          -> NexusPdfFindLinkService  (navigation-neutral)
          -> PDF.js EventBus / TextHighlighter
        -> shared media preview lease
  -> existing resource-search Companion
```

- Shared Pane Search and Companion remain format-blind and unchanged.
- `useMediaPaneFind` receives `pdfAdapter` as the third exact format branch. It
  remains the only `usePaneFind` caller; never call `usePaneFind` inside
  `usePdfPaneFind` or `PdfReader`.
- Before the PDF runtime is ready, PDF Find is not published. Runtime
  publication changes the active adapter/source key, causing the existing
  controller effect to abort/re-prepare before Find becomes available.
- Generalize active-adapter lifecycle wiring so every source switch, including
  PDF runtime readiness, calls `previewLease.beginSource()` once.
- `usePdfPaneFind.ts` owns the Pane adapter, provisional/committed origin,
  occurrence map, source assertions, runtime-result mapping, and lease calls.
- `PdfReader` owns one `PdfFindRuntime` and per-document EventBus.
- `pdfPaneFind.ts` owns both dynamic PDF.js subclasses, query generations,
  coverage, result projection, and one-shot selection scroll.
- Existing PDF viewer, resume, reader-progress, `ReaderActivityAdapter`, and
  Resource Inspector owners remain authoritative.

If EPUB Find lands first, reuse its extracted
`mediaFindPreviewLease.ts`. If PDF lands first, perform that exact extraction
here; EPUB must consume it later. Leave no duplicate lease owner or re-export.

## Capability Contract

Compose the implemented `PaneFindAdapter<PdfFindError>`:

```ts
type PdfFindError =
  | { readonly kind: "OriginUnavailable" }
  | { readonly kind: "TextUnavailable"; readonly scope: "EntirePdf" }
  | { readonly kind: "RuntimeUnavailable" };

interface PdfFindSource {
  readonly mediaId: string;
  readonly fingerprints: readonly (string | null)[];
  readonly numPages: number;
}

type PdfFindScope =
  | { readonly kind: "EntirePdf" }
  | { readonly kind: "Page"; readonly pageNumber: number };

interface PdfFindLocator {
  readonly kind: "PdfTextMatch";
  readonly pageNumber: number;       // one-based
  readonly matchIndexOnPage: number; // zero-based public pageMatches index
  readonly startUtf16: number;       // PDF.js text-layer offset
  readonly endUtf16: number;
}

interface PdfFindOrigin {
  readonly pageNumber: number;
  readonly zoom: number;
  readonly pageTopDeltaPx: number;
  readonly scrollLeft: number;
}

type PdfFindOriginCapture =
  | { readonly kind: "Captured"; readonly value: PdfFindOrigin }
  | { readonly kind: "Unavailable" };

interface PdfRuntimeFindRequest {
  readonly generation: number;
  readonly query: string;
  readonly scope: PdfFindScope;
  readonly matchCase: boolean;
  readonly wholeWord: boolean;
  readonly signal: AbortSignal;
}

interface PdfRuntimeFindOccurrence {
  readonly locator: PdfFindLocator;
  readonly snippet: readonly EmphasisSegment[];
}

type PdfRuntimeFindResult =
  | {
      readonly kind: "Ready";
      readonly generation: number;
      readonly occurrences: readonly PdfRuntimeFindOccurrence[];
    }
  | { readonly kind: "NoMatches"; readonly generation: number }
  | {
      readonly kind: "TooManyMatches";
      readonly generation: number;
      readonly threshold: 2_000;
    }
  | { readonly kind: "TextUnavailable"; readonly generation: number }
  | { readonly kind: "RuntimeUnavailable"; readonly generation: number };

interface PdfFindRuntime {
  readonly source: PdfFindSource;
  search(request: PdfRuntimeFindRequest): Promise<PdfRuntimeFindResult>;
  activate(locator: PdfFindLocator, signal: AbortSignal): Promise<void>;
  captureOrigin(): PdfFindOriginCapture;
  restoreOrigin(origin: PdfFindOrigin, signal: AbortSignal): Promise<void>;
  clearPresentation(): void;
}
```

- Source key:
  `{ kind: "Pdf", mediaId, fingerprints, numPages }`.
- Preserve the complete ordered `PDFDocumentProxy.fingerprints` array so an
  incrementally modified PDF is a new source.
- Once the document is loaded, a missing first fingerprint or non-positive
  `numPages` violates an invariant and defects unconditionally.
- Result-key source is compact: `{ kind: "Pdf", mediaId }`.
- Result-key locator is the complete `PdfFindLocator`.
- Build all keys through `createPaneFindResultKey`; never parse or persist them.
- `OriginUnavailable` rejects before dispatch or movement.
- Entire-PDF empty extraction maps to retryable `Failed(TextUnavailable)` with
  copy: **Searchable text could not be extracted from this PDF. Retry does not
  perform OCR.**
- Empty page-scoped extraction maps to complete `NoMatches`; never claim the
  entire mixed PDF lacks text.
- Runtime `TextUnavailable`/`RuntimeUnavailable` map exhaustively to the same
  Pane errors. Observable dispatch, matched-page text load, command, or
  query-stall failure is `RuntimeUnavailable`.
- Runtime-not-ready means no capability. Source replacement is cancellation.
- Invalid offsets/counts/events and impossible render state defect.

## Exact PDF.js Boundary

Pin `"pdfjs-dist": "5.7.284"` in `package.json` and the canonical Bun lock.
Make `copy-pdfjs.mjs` assert that exact installed version before copying.

`pdfReaderRuntime.ts` must type:

- exported `PDFFindController` and `PDFLinkService`;
- `PDFDocumentProxy.fingerprints`, `getPage`, and page text items;
- EventBus `dispatch`, `on`, and `off`;
- public `highlightMatches`, `pageMatches`, `pageMatchesLength`, `selected`,
  `state`, `match`, `setDocument`, and `scrollMatchIntoView`;
- `PDFLinkService.page/pagesCount`;
- `PDFViewer`'s `findController` option.

The module is dynamically imported. Build subclasses through a class factory
after the exact module loads; do not use a static import-time `extends`.

### Navigation-neutral link service

Construct:

```ts
class NexusPdfFindLinkService extends PDFLinkService {
  override get page(): number {
    return super.page;
  }
  override set page(_value: number) {
    // PDF.js Find may select internally; Nexus alone moves the reader.
  }
}
```

Give the ordinary link service to `PDFViewer`; give this second service only to
`PDFFindController`. Attach both to the same document/viewer. Normal PDF links
and reader navigation retain the ordinary service.

This blocks PDF.js's internal `linkService.page = ...` without private access
or interference with genuine navigation.

### Nexus controller

`NexusPdfFindController` may override only:

1. `match(query, pageContent, pageIndex)`:
   record current-generation page coverage and scoped text presence, return
   `[]` outside the frozen page scope, otherwise return `super.match(...)`.
2. `selected`:
   expose Nexus-owned `{ pageIdx, matchIdx }` to `TextHighlighter`.
3. `scrollMatchIntoView(...)`:
   scroll only when the arguments equal a pending one-shot Nexus selection;
   clear the guard before scrolling so zoom/re-render only repaints.

It retains its constructor EventBus reference explicitly; never read
`_eventBus`. `activate(locator)` validates against current public
`pageMatches/pageMatchesLength`, sets the Nexus selection and one-shot guard,
uses the PDF preview viewport command to reveal and await the target text
layer, then dispatches `updatetextlayermatches` for old/new pages.

The controller has no destroy API. Teardown removes Nexus EventBus listeners,
sets both link services/controller to document `null`, clears callbacks, and
drops the per-document EventBus/runtime.

## Query And Settlement Protocol

Use a truthy fixed event type such as `type: "nexus-query"` to bypass PDF.js's
internal 250 ms debounce; the foundation's 120 ms debounce remains sole input
scheduling.

Before dispatch:

1. invalidate the prior runtime generation and reject its waiter as
   `AbortError`;
2. reset Nexus selection, coverage, text-presence, and result state;
3. capture a provisional origin if no committed origin exists;
4. acquire the media preview lease;
5. arm generation and frozen scope;
6. dispatch:

```ts
{
  type: "nexus-query",
  query,
  caseSensitive: matchCase,
  entireWord: wholeWord,
  matchDiacritics: true,
  highlightAll: false,
  findPrevious: false,
}
```

Instantiate with `updateMatchesCountOnProgress: false`.

Do not listen to `updatefindcontrolstate`: in PDF.js 5.7.284, its terminal
state transitions occur before the last page increments `visitedPagesCount`,
so the configured guard suppresses them.

Listen to `updatefindmatchescount` and settle only when:

- event source is the current controller;
- the runtime generation is current;
- subclass coverage contains every page exactly once for that generation; and
- `matchesCount.total` equals the sum of final public `pageMatches` lengths.

Coverage rejects the early mixed-generation count event possible during
supersession. A complete-generation count disagreement defects. Derive
Ready/NoMatches/TooMany solely from final public arrays; `FindState` is not a
settlement input.

PDF.js extraction itself is not abortable. Abort only retires the Nexus waiter
and identities; the next query supersedes controller state and every late event
is inert until current-generation coverage completes.

Use one named inactivity timeout, reset whenever page coverage advances:
`PDF_FIND_STALL_TIMEOUT_MS = 30_000`. Expiry is
`RuntimeUnavailable`; it is not a partial result.

PDF.js may normalize a candidate to a zero-length rendered match and omit it.
Only final public `pageMatches/pageMatchesLength` define result count, keys, and
activation indices; never publish the raw `super.match` array.

No marks appear while searching: `highlightAll` is false and Nexus selection is
empty. If count exceeds 2,000, dispatch `findbarclose`, discard all Nexus state,
and return only `TooManyMatches(2000)`. PDF.js may transiently hold more than
2,000 internal matches; this v1 cap bounds Nexus rows/snippets, not PDF.js
internal memory.

On first successful `preview`, set the Nexus selection, reveal it, then dispatch
`type: "highlightallchange", highlightAll: true`. Later activations update only
selection and old/new text-layer pages.

## Results And Snippets

- Order is page number, then public match index. No ranking.
- Context is `["Page N"]`.
- Locators use the public mapped UTF-16 offsets and lengths.
- Apply the 2,000 cap from public arrays before loading any matched-page text or
  building snippets.
- For pages with matches only, call public page
  `getTextContent({ includeMarkedContent: true, disableNormalization: true })`;
  concatenate text-item `str` values without EOL separators, matching
  `TextHighlighter.textContentItemsStr`.
- Build one UTF-16-boundary-to-codepoint map and one codepoint array per matched
  page. Validate every public range against that projection once.
- Rename/export the existing private
  `snippetSegments(codePoints, startCp, endCp)` in
  `canonicalTextFind.ts` as the sole TypeScript
  `canonicalTextFindSnippet` owner. Keep its existing 64-codepoint semantics
  and reuse the already-built arrays; do not introduce a text/UTF-16 helper or
  decode once per match.
- Conversation Find consumes `canonicalTextFind` and deletes its local snippet
  helper in its own atomic cutover. EPUB's Python scanner keeps its
  cross-runtime 64-codepoint implementation and shared corpus. No sibling spec
  creates another TypeScript snippet owner.

Empty query remains `Idle`; one codepoint is valid; the foundation enforces the
256-codepoint maximum.

## Origin, Preview, Progress, And Return

Origin state is closed:

```ts
type PdfFindOriginState =
  | { readonly kind: "Absent" }
  | { readonly kind: "Provisional"; readonly value: PdfFindOrigin }
  | { readonly kind: "Committed"; readonly value: PdfFindOrigin };
```

- Capture Provisional before dispatch because PDF.js query execution is
  asynchronous. It is not exposed as Return.
- If genuine input releases the lease while a Provisional query runs, recapture
  the current live origin and reacquire immediately before first activation.
- A successful first activation promotes Provisional to Committed. Later
  queries/previews never replace Committed, even after genuine input.
- Record whether the lease was active before each query. NoMatches, TooMany,
  failure, or abort restores that prior fence state: a neutral query must not
  re-freeze progress after genuine input merely because Committed Return exists.
- NoMatches, TooMany, failure, abort, or Close discards Provisional and calls
  `cancelUnreportedPreview`. A pre-existing Committed origin survives query
  failure and Close.
- A partial failed first activation restores Provisional before rejecting and
  publishes no Return.

Extract shared PDF viewport scaffolding, not shared locator math:

```ts
type PdfViewportIntent = "ReaderRestore" | "FindPreview" | "FindReturn";
```

Find intents never call the ordinary page action or publish resume state. The
preview lease remains the final fence for incidental PDF.js page/scroll
observations: `useReaderProgress` rejects movement while active, and
`ReaderActivityAdapter` owns trusted PDF input release.

Return:

1. reacquires the lease;
2. sets the captured zoom;
3. sets the captured page through the FindReturn viewport command;
4. awaits that page's post-zoom layout and text-layer render epoch;
5. restores page-top viewport delta, then horizontal scroll, in the next frame;
6. validates that the origin is renderable;
7. clears marks/selection/origin;
8. calls `previewLease.completeReturn()` and focuses the PDF viewport.

Add `completeReturn()` to the extracted media lease and use it from existing
Web/Transcript Return paths too. It is idempotent and releases the fence without
pretending genuine input occurred. Source exit still retires; Close with a
Committed origin does not release.

## API, Security, And Performance

No HTTP API, Next route, Python service, database schema, migration, or stored
state changes.

The PDF binary is already authorized and loaded through the signed source path.
Find performs no new source fetch. Do not expose PDF text in logs, analytics,
URLs, or storage.

Backend PDF text uses another extractor and cannot safely drive PDF.js
text-layer selection without a reconciliation model.

First Entire-PDF Find extracts every page before Ready; a first This-page query
also pays PDF.js's whole-document extraction cost. Large PDFs may remain
`Searching` for seconds. Subsequent queries reuse controller text extraction.
Counts are deliberately non-incremental, and every productive debounced query
auto-previews its first result once because the foundation requires it.

These are accepted v1 tradeoffs. Do not claim bounded PDF.js match memory,
instant large-document search, or incremental results. A worker/index or custom
page-only engine requires a successor spec.

## Lifecycle And Accessibility

- Publish only when `media.kind === "pdf"`,
  `media.capabilities.can_read === true`, and exact runtime is ready.
- Publish `onFindRuntimeReady(null)` before document replacement/teardown.
- Source/runtime changes cancel stale query, result, preview, Return, and
  Companion generations before re-preparation.
- `findbarclose` plus Nexus selection reset clears presentation.
- Zoom/text-layer rebuild retains marks but cannot re-scroll without a new
  one-shot activation guard.
- Override PDF.js global `.textLayer .highlight` and `.highlight.selected`
  defaults inside the PDF reader owner; do not style Nexus Highlight overlay
  rectangles.
- All-match and selected marks use semantic tokens verified against the PDF
  reader's true-white canvas in both app themes. Selected adds a non-color
  distinction such as outline/underline, plus explicit `forced-colors` rules.
- The foundation remains responsible for query focus, result/live
  announcements, keyboard wrapping, Companion focus, mobile behavior, and
  Return labeling.

## Files

Add:

- `apps/web/src/components/pdfPaneFind.ts`
- `apps/web/src/components/pdfPaneFind.browser.test.tsx`
- `apps/web/src/components/pdfPaneFind.pdfjs.browser.test.tsx`
- `apps/web/src/app/(authenticated)/media/[id]/usePdfPaneFind.ts`
- `apps/web/src/app/(authenticated)/media/[id]/usePdfPaneFind.browser.test.tsx`
- `apps/web/src/app/(authenticated)/media/[id]/mediaFindPreviewLease.ts` and
  focused test, only if EPUB has not already established them

Modify:

- `apps/web/package.json`
- `apps/web/bun.lock`
- `apps/web/scripts/copy-pdfjs.mjs`
- `apps/web/src/components/pdfReaderRuntime.ts`
- `apps/web/src/components/PdfReader.tsx`
- `apps/web/src/components/PdfReader.module.css`
- `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.tsx`
- `apps/web/src/app/(authenticated)/media/[id]/ReaderActivityAdapter.ts`
- `apps/web/src/app/(authenticated)/media/[id]/useMediaPaneFind.ts`
- existing Web/Transcript media Find adapters and tests for
  `completeReturn()`/shared lease ownership
- `apps/web/src/lib/reader/canonicalTextFind.ts` and test
- `apps/web/src/__tests__/components/PdfReader.test.tsx`
- `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.test.tsx`
- `apps/web/vitest.config.ts`
- `e2e/tests/pdf-reader.spec.ts`

Do not modify backend PDF services, migrations, global Search, shared Pane
Search components, or copied `public/pdfjs` assets by hand.

## Implementation Order

1. Exact-pin/assert PDF.js and type its public boundary.
2. Establish the shared snippet export and media lease owner/Return release.
3. Implement/test dynamic controller plus navigation-neutral link service,
   generation coverage, final-count settlement, and one-shot activation.
4. Add PDF preview/Return viewport intents and runtime publication.
5. Thread `pdfAdapter` through the single `useMediaPaneFind` controller.
6. Add accessibility, browser/E2E proof, cleanup, and residue gates.

## Acceptance Criteria

1. `Cmd/Ctrl+F` opens **Find in PDF** only for the active ready PDF;
   `Cmd/Ctrl+K` remains global.
2. Every query settles from current-generation `updatefindmatchescount`;
   `updatefindcontrolstate` is unused.
3. Searching, empty, failure, and TooMany never move the viewer or show marks.
4. Entire PDF and frozen This page results are complete, ordered, and honor
   Match case, Whole word, and exact diacritics.
5. First, Previous/Next, and any Companion row activate the exact public
   PDF.js match without `findagain`, private state, or an intermediate jump.
6. Result keys use compact source identity; source keys use full fingerprints.
7. Snippets use the one codepoint helper and public rendered offset space.
8. Match 2,001 produces only `TooManyMatches(2000)`; page-empty and
   document-empty copy are scope-correct.
9. Close clears marks without returning. Return restores the immutable
   post-layout page/zoom/viewport origin exactly once and releases the lease.
10. Preview/search does not mutate progress, activity, completion, URL/history,
    targets, Nexus Highlights, or playback. Trusted input resumes normal
    observation while Return remains.
11. Source/query/runtime races cannot settle or move a replacement document.
12. Marks survive zoom without re-scroll and have non-color/forced-colors
    selected distinction.
13. The app and copied runtime resolve exact PDF.js `5.7.284`.
14. Focused unit/browser/E2E tests and broad residue scans pass; no legacy,
    duplicate PDF helper, second controller, fallback, or dead path remains.

## Verification

The implementation run uses only the focused commands below. The real-stack
Playwright scenario is authored and load-verified, but its standard harness
invokes the broad production build/Make gates excluded from this run; execute
that final gate separately.

```bash
cd apps/web
bun install --frozen-lockfile --ignore-scripts
bun run test:unit -- \
  src/lib/reader/canonicalTextFind.test.ts \
  'src/app/(authenticated)/media/[id]/mediaFindPreviewLease.test.ts' \
  'src/app/(authenticated)/media/[id]/transcriptPaneFind.test.ts'
bun run test:browser -- \
  src/components/pdfPaneFind.browser.test.tsx \
  src/components/pdfPaneFind.pdfjs.browser.test.tsx \
  'src/app/(authenticated)/media/[id]/usePdfPaneFind.browser.test.tsx' \
  src/__tests__/components/PdfReader.test.tsx \
  'src/app/(authenticated)/media/[id]/useMediaPaneFind.browser.test.tsx' \
  'src/app/(authenticated)/media/[id]/transcriptPaneFind.browser.test.tsx' \
  'src/app/(authenticated)/media/[id]/ReaderActivityAdapter.test.tsx' \
  'src/app/(authenticated)/media/[id]/MediaPaneBody.test.tsx'

cd ../../e2e
bunx playwright test tests/pdf-reader.spec.ts --project=chromium \
  --grep 'find previews PDF matches and returns without changing reading progress'

cd ..
rg -n "window\\.find|findagain|updatefindcontrolstate|Continue from here|media\\.plain_text|pdf_page_text_spans" \
  apps/web/src/components/PdfReader.tsx \
  apps/web/src/components/pdfPaneFind.ts \
  apps/web/src/components/pdfReaderRuntime.ts \
  apps/web/src/app/'(authenticated)'/media/'[id]'/usePdfPaneFind.ts \
  apps/web/src/app/'(authenticated)'/media/'[id]'/useMediaPaneFind.ts
rg -n "\\._(selected|eventBus|pageMatches|pageMatchesLength|pageContents|offset)" \
  apps/web/src/components/PdfReader.tsx \
  apps/web/src/components/pdfPaneFind.ts \
  apps/web/src/components/pdfReaderRuntime.ts \
  apps/web/src/app/'(authenticated)'/media/'[id]'/usePdfPaneFind.ts
rg -n '"pdfjs-dist"\\s*:\\s*"[^"]*\\^|pdfjs-dist@5\\.6' \
  apps/web/package.json apps/web/bun.lock
```

Expected residue is zero. Full repository gates remain required after focused
proof.
