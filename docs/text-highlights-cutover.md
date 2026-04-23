# text highlights hard cutover

this document defines the implementation target for non-pdf text highlight
selection, creation, update, and rendering across web article, transcript, and
epub readers.

it is a hard cutover plan. do not preserve retained dom-range state, alternate
selector families, fallback create paths, fuzzy reattachment branches,
compatibility request shapes, or transition-era abstractions once the new path
is in place.

## standards

this cutover aligns the text highlight surface to:

- `docs/codebase-cleanup-cutover.md`
- `docs/reader-implementation.md`
- `docs/rules/simplicity.md`
- `docs/rules/control-flow.md`
- `docs/rules/correctness.md`
- `docs/rules/errors.md`
- `docs/rules/layers.md`
- `docs/rules/module-apis.md`
- `docs/rules/concurrency.md`
- `docs/rules/testing_standards.md`

## goals

- make non-pdf highlight creation deterministic across rerenders, highlight
  hydration, resume restore, and html re-decoration
- keep one canonical text highlight contract for web article, transcript, and
  epub readers
- capture durable highlight input immediately in canonical text space instead of
  retaining dom selection primitives
- separate ephemeral popover geometry from durable highlight data
- keep backend transport minimal and typed
- keep control flow local and explicit in the owning files
- make highlight failures explicit and named instead of silently dropping the
  action
- keep highlight create and quote-to-chat on the same anchor path
- remove stale selection and selector code instead of layering on top of it

## non-goals

- redesigning pdf highlight geometry or pdf highlight transport
- introducing a generic web-annotation framework, adapter, registry, or dsl
- preserving raw `Range`, `Selection`, node, or element-boundary objects as
  retained app state
- adding xpath, css-selector, dom-path, viewport-pixel, or scroll-offset text
  selectors
- adding fuzzy anchoring or orphan recovery for arbitrary external page drift
- broad reader refactors unrelated to non-pdf text highlight ownership
- moving business logic into next.js bff routes
- adding a reusable highlight manager hook, state machine, or helper bag to
  hide the cutover

## hard cutover rules

- raw dom `Range`, `Selection`, `Node`, and `Element` objects are ephemeral ui
  primitives only
- convert a live selection to canonical fragment-anchor data immediately or
  discard it immediately
- do not store a cloned `Range` or any other dom selection object as retained
  selection state
- do not reinterpret a previously captured dom selection against a later dom or
  later canonical cursor
- fragment offsets are the only canonical non-pdf highlight anchor
- persisted quote context remains `exact`, `prefix`, and `suffix`; do not add a
  second selector family for the same highlight
- highlight create transport stays minimal: `start_offset`, `end_offset`, and
  `color`
- the backend remains the single owner that derives persisted `exact`,
  `prefix`, and `suffix` from canonical text
- public highlight responses stay on the standard response envelope and expose
  only typed `anchor` data; do not reintroduce flat residue fields
- popover positioning data is ui-only and must not be treated as highlight
  business data
- if fragment identity, mismatch state, or canonical text ownership changes,
  invalidate retained selection explicitly
- dom/canonical mismatch is a defect, not a product-facing fuzzy-recovery case
- keep one non-pdf highlight path for web article, transcript, and epub readers
- `MediaPaneBody.tsx` remains the route owner; do not replace it with a generic
  highlight controller or mega-hook
- bff routes stay proxy-only
- fastapi routes validate typed payloads and call services; services own
  highlight business rules
- if a helper exists only to shuttle selection state between handlers, inline it
  or delete it

## target behavior

- selecting text in a non-pdf reader immediately captures a stable canonical
  highlight snapshot for the active fragment
- the selection popover may move or disappear with ui geometry changes without
  changing the retained highlight snapshot
- clicking a highlight color after highlight hydration, resume restore, or html
  re-decoration still creates the originally selected highlight range for the
  same fragment
- if the fragment changes or highlighting becomes disabled before create, the
  retained selection is cleared explicitly and create is blocked explicitly
- a paragraph-start or other element-boundary selection either creates the
  intended highlight or returns a named user-visible error; it never stalls with
  no request and no message
- each create action issues at most one network create request
- duplicate-range creates focus the existing highlight instead of creating a
  second copy
- quote-to-chat uses the same retained highlight snapshot as highlight creation;
  it does not have a second selection-conversion path
- highlight rendering remains anchored by canonical fragment offsets against the
  current rendered cursor
- existing highlights remain deterministic across typography reflow because the
  dom is remapped from canonical text on each render

## final state

- `MediaPaneBody.tsx` no longer stores retained non-pdf selection as a cloned
  `Range`
- retained non-pdf selection is one immutable snapshot in canonical text space
  for the active fragment, with ui geometry stored separately for popover
  placement
- the retained snapshot contains only data with real payoff for later actions:
  active fragment identity, canonical `start_offset`, canonical `end_offset`,
  and the exact selected text needed by downstream ui
- selection conversion happens once, at selection time, against the current
  canonical cursor
- the non-pdf dom-selection conversion lives in one leaf module with one job:
  convert live browser selection to canonical fragment-anchor data
- only low-level reusable highlight primitives remain shared:
  canonical cursor building, selection conversion, and html segment
  application
- `mediaHighlights.ts` owns fragment highlight fetch/create/update/delete
  transport only; it does not own selection interpretation
- `SelectionPopover.tsx` remains a pure ui surface for actions and placement; it
  does not own selection conversion or business fallback logic
- `HtmlRenderer.tsx` remains render-only; it does not participate in selection
  ownership or highlight business logic
- `MediaHighlightsPaneBody.tsx` and `LinkedItemsPane.tsx` remain secondary-pane
  render owners only; they consume scoped highlights and anchor metadata but do
  not own fetch or mutate policy
- `apps/web/src/app/api/fragments/[fragmentId]/highlights/route.ts` remains a
  thin proxy to fastapi
- `apps/web/src/app/api/highlights/[highlightId]/route.ts` and
  `apps/web/src/app/api/highlights/[highlightId]/annotation/route.ts` remain
  thin proxies to fastapi
- `python/nexus/schemas/highlights.py` keeps the minimal typed fragment create
  request and the typed fragment/pdf output contracts
- runtime highlight reads and writes continue to reject residue-only rows that
  lack a coherent typed anchor, even if the database still tolerates them until
  a separate schema cleanup removes that residue
- `python/nexus/services/highlights.py` remains the single owner for offset
  validation, duplicate detection, media-ready checks, and persisted
  `exact`/`prefix`/`suffix` derivation
- no retained-selection code path remains that depends on a dom range surviving
  rerender
- no alternate text selector contract remains in production code

## files in scope

- `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.tsx`
- `apps/web/src/app/(authenticated)/media/[id]/mediaHighlights.ts`
- `apps/web/src/components/SelectionPopover.tsx`
- `apps/web/src/components/HtmlRenderer.tsx`
- `apps/web/src/components/LinkedItemsPane.tsx`
- `apps/web/src/lib/highlights/canonicalCursor.ts`
- `apps/web/src/lib/highlights/selectionToOffsets.ts`
- `apps/web/src/lib/highlights/applySegments.ts`
- `apps/web/src/lib/highlights/useHighlightInteraction.ts`
- `apps/web/src/app/(authenticated)/media/[id]/MediaHighlightsPaneBody.tsx`
- `apps/web/src/app/api/fragments/[fragmentId]/highlights/route.ts`
- `apps/web/src/app/api/highlights/[highlightId]/route.ts`
- `apps/web/src/app/api/highlights/[highlightId]/annotation/route.ts`
- `python/nexus/api/routes/highlights.py`
- `python/nexus/db/models.py`
- `python/nexus/responses.py`
- `python/nexus/schemas/highlights.py`
- `python/nexus/services/highlights.py`
- `apps/web/src/lib/highlights/selectionToOffsets.test.ts`
- `apps/web/src/lib/highlights/canonicalCursor.test.ts`
- `apps/web/src/__tests__/components/SelectionPopover.test.tsx`
- `e2e/tests/web-articles.spec.ts`
- `e2e/tests/epub.spec.ts`
- `e2e/tests/youtube-transcript.spec.ts`
- `python/tests/test_highlights.py`
- `python/tests/test_pdf_highlights_integration.py`
- `python/tests/test_send_message.py`
- `python/tests/test_podcasts.py`
- `python/tests/test_vault.py`

## file-by-file target

- `MediaPaneBody.tsx`
  keep route-level orchestration, content fetch, and reader-specific branching
  remove retained dom-range selection state
  capture immutable canonical selection snapshot immediately on selection
  invalidate retained selection explicitly on fragment and mismatch transitions
  keep quote-to-chat and highlight create on the same retained snapshot path
- `mediaHighlights.ts`
  keep transport calls explicit and local
  do not add selector conversion, retry policy branching, or alternative request
  payload shapes
- `SelectionPopover.tsx`
  keep action ui and placement only
  do not add selection repair, selection reread, or create fallback logic
- `MediaHighlightsPaneBody.tsx` and `LinkedItemsPane.tsx`
  keep secondary-pane ordering, measurement, and focus rendering only
  do not add fetch, selection conversion, or mutation ownership there
- `canonicalCursor.ts`
  remain the single dom-to-canonical text mapping owner for non-pdf highlight
  placement and selection conversion
  do not add alternate cursor builders or selector maps
- `applySegments.ts`
  remain the only html-segmentation owner for rendered text highlights
  do not add a second decorated-html path
- `selectionToOffsets.ts`
  either stay as the single selection-to-canonical-anchor converter or be
  renamed to match that job exactly
  do not keep a second retained-range-based conversion path anywhere else
- `useHighlightInteraction.ts`
  keep it only if more than one production owner remains after the cutover
  otherwise inline it back into the owning reader file
- `apps/web/src/app/api/fragments/[fragmentId]/highlights/route.ts`
  stay proxy-only
- `apps/web/src/app/api/highlights/[highlightId]/route.ts`
  stay proxy-only
- `apps/web/src/app/api/highlights/[highlightId]/annotation/route.ts`
  stay proxy-only
- `python/nexus/api/routes/highlights.py`
  keep input validation and response shaping only
- `python/nexus/responses.py`
  remain the one response-envelope owner for highlight endpoints
- `python/nexus/db/models.py`
  keep the typed-anchor tables as the only supported runtime shape
  do not add runtime fallback behavior for residue rows
- `python/nexus/schemas/highlights.py`
  keep one typed fragment create contract and one typed highlight output
  contract
  do not add dom-oriented or quote-only create payload variants
- `python/nexus/services/highlights.py`
  stay the only owner that validates fragment offsets, derives
  `exact`/`prefix`/`suffix`, checks duplicates, and persists text highlights
- tests
  add coverage for the stale-selection race, decorated-dom selection mapping,
  and real create flows on web article, transcript, and epub readers
  delete or rewrite tests that depend on retained dom-range behavior

## key decisions

- keep `fragment_offsets` as the only canonical non-pdf highlight anchor
  reason: the repo owns canonicalized fragment text, and canonical offsets are
  the simplest durable selector that matches the shipped data model

- keep create transport minimal and let the backend derive `exact`, `prefix`,
  and `suffix`
  reason: canonical text is already the backend source of truth, so duplicating
  quote-context ingress would add transport surface without improving ownership

- keep the public api on the existing typed-anchor response contract
  reason: the backend already exposes one discriminated `anchor` union, and
  reopening flat legacy fields would reintroduce duplicate contracts

- capture canonical selection at selection time, not at color-click time
  reason: dom selections are ephemeral and unsafe across rerenders, while
  canonical offsets are durable for the active fragment

- keep selection geometry separate from highlight data
  reason: popover placement is a ui concern and should not affect highlight
  business behavior

- explicitly invalidate retained selection on ownership changes
  reason: fragment changes and mismatch-disabled state are real business
  boundaries; silent reuse across them is incorrect

- do not add fuzzy reattachment for text highlight creation
  reason: this product highlights server-owned canonical fragments, not
  arbitrary drifting web pages, so mismatch is a defect to surface, not a
  selector-recovery workflow to preserve

- keep one shared non-pdf create path for web article, transcript, and epub
  reason: these readers already share the same fragment canonical-text model, so
  separate create stacks would be duplication

- keep `MediaPaneBody.tsx` as the route owner instead of adding a generic
  highlight hook or controller
  reason: the repo rules favor one obvious owner and direct control flow over a
  new abstraction layer

- keep resume and highlight logic aligned on canonical offsets and quote context
  without extracting a generic reader-anchor framework
  reason: sharing the data discipline is useful, but a framework layer would add
  indirection without enough reuse payoff

## implementation order

1. write failing unit and e2e coverage for the stale-selection race
2. cut retained non-pdf selection over from dom-range state to canonical
   snapshot state
3. make highlight create and quote-to-chat consume the same retained snapshot
4. invalidate retained selection explicitly on fragment changes, mismatch
   disablement, and selection clear
5. remove or rename the old selection-conversion surface so one canonical path
   remains
6. tighten backend and contract tests so the final request/response shape is the
   only supported shape
7. run the full frontend and targeted backend verification path

## acceptance criteria

- no non-pdf production code retains a cloned dom `Range` as selection state
- non-pdf highlight creation does not reread or reinterpret an old dom range at
  color-click time
- a selection made before highlight hydration or html re-decoration still
  creates the intended highlight for the same fragment
- changing the active fragment or entering mismatch-disabled state clears the
  retained selection before create
- the paragraph-start element-boundary case in `web-articles.spec.ts` either
  sends a create request or raises a named visible error; it never times out
  waiting for a request that was never sent
- quote-to-chat and color-based create share the same retained selection data
- `POST /api/fragments/{fragment_id}/highlights` accepts exactly one typed
  fragment create payload shape
- highlight responses expose only typed `anchor` output inside the standard
  success envelope
- persisted text highlights remain `fragment_offsets` plus derived
  `exact`/`prefix`/`suffix`
- runtime highlight reads and writes do not revive residue-only or flat-anchor
  legacy rows
- no production code path remains for xpath, dom-path, viewport-offset, or
  retained-range text selectors
- unit coverage proves selection conversion on decorated html and later
  paragraphs in long documents
- e2e coverage proves real highlight creation on web article and epub, and
  transcript coverage is added or expanded for the same path

## validation

- `bun run typecheck`
- `bun run test:unit`
- `bun run test:browser`
- `make test-e2e PLAYWRIGHT_ARGS="tests/web-articles.spec.ts --project=chromium --workers=1"`
- `make test-e2e PLAYWRIGHT_ARGS="tests/epub.spec.ts --project=chromium --workers=1"`
- targeted transcript highlight create coverage in `make test-e2e`
- `make verify`

## shipping bar

- do not ship if non-pdf highlight creation still depends on a retained dom
  range surviving rerender
- do not ship if the paragraph-start element-boundary case still flakes
- do not ship if quote-to-chat and highlight create still have separate
  selection-conversion paths
- do not ship dead retained-range code or alternate selector code in production
  files
- if the final code still needs a comment to explain whether retained selection
  is dom state or canonical text state, the ownership is still too indirect and
  should be simplified
