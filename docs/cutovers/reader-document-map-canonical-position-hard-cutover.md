# Reader Document Map Canonical Position Hard Cutover

Status: IMPLEMENTED - focused proof complete; release-stack gates listed below - 2026-07-31

Type: one coordinated hard cutover. No feature flag, dual position model,
legacy payload, approximate heading fallback, primary-only cluster path, or
mixed-version support.

No blocking product question remains. The decisions below are locked.

Follow all of [`docs/rules/`](../rules/index.md), especially cleanliness,
simplicity, boundaries, correctness, frontend, and the repository-local
[`testing-standards.md`](../local-rules/testing-standards.md).

This document owns the correction scope and proof. The existing
[`reader-document-map-evidence-trail-hard-cutover.md`](reader-document-map-evidence-trail-hard-cutover.md)
continues to own the aggregate and secondary surfaces. After implementation,
its rail clauses and the current reader module docs must describe only this
final state.

## Decision

Position is source-coordinate truth. Progress is a projection. Rendered pixels
are temporary measurement input. Structure is context, never a locator.

One format-owned capture publishes one semantic viewport. Cursor persistence,
Consumption activity, and the desktop overview rail consume that capture. The
rail owns presentation only and performs no scroll discovery or position math.

The shipped surface remains the desktop **Document Map overview rail**. Do not
introduce a second Reader Map product, store, route, or API.

## Goals

- Align viewport, resume, Contents, and Evidence to one document coordinate.
- Restore the saved web fragment before applying its exact locator.
- Place every EPUB Contents marker at its canonical anchor.
- Preserve and activate every member of a dense marker cluster.
- Make the rail quiet, legible, keyboard-complete, and non-color-dependent.
- Remove the duplicate pixel-position owner and repeated-EPUB-section length
  model.

## Scope

In scope:

- desktop web article, transcript, EPUB, and PDF viewport projection;
- exact web/EPUB Contents and existing Evidence marker projection;
- multi-fragment web cold resume;
- EPUBs with multiple navigation locations in one fragment;
- the existing Document Map aggregate, navigation payload, format capture,
  progress/activity owners, rail, fixtures, tests, and current docs;
- one new pure frontend position module and one backend canonical-anchor helper.

Non-goals:

- mobile chrome or mobile reader redesign;
- cursor, Consumption, completion, reset, CAS, or reader-state API changes;
- a visible last-location or high-water layer in this cut;
- drag scrubbing, time remaining, read-wear, heatmaps, analytics, gaze, or ML;
- EPUB CFI, OCR, thumbnails, a text minimap, source-revision repair, or
  annotation import/export;
- new database tables, columns, migrations, workers, caches, or realtime;
- generic viewport, geometry, navigation, or synchronization frameworks.

## Target behavior

| Situation | Final behavior |
| --- | --- |
| Ordinary reading or reflow | The viewport band follows canonical visible content, independent of pixel density |
| Highlight beside a heading | Both remain identifiable; a cluster exposes both destinations |
| Activate one marker | Navigate to that exact owned target; do not write progress until genuine reader input |
| Activate a multi-marker cluster | Open its member list; never select an implicit primary |
| Bare web route with a saved fragment-two cursor | Open fragment two, then apply the exact saved locator |
| EPUB with several headings in one XHTML file | Each heading has its own canonical position; document length counts the fragment once |
| PDF with unequal pages, gaps, or zoom | Band and markers use page plus normalized page-space position, not scrollbar fraction |
| Find preview/Return or restore | Update the visible band; preserve existing progress/activity fences |
| EPUB target names a missing anchor | Reject the navigation source explicitly; never guess a midpoint or unrelated target |
| No markers | Publish no rail, unchanged from the current contract |

## Final architecture

```text
rendered reader
  -> existing real format scrollport / renderer
  -> format-owned semantic viewport capture
       Text(fragment_id, canonical offset)
       PDF(page, normalized page-space y)
  -> readerDocumentPosition pure projection
       -> existing ReaderResumeState builder / useReaderProgress
       -> existing ReaderActivityAdapter
       -> normalized visible start/end -> overview rail

domain locators + exact navigation anchors
  -> reader_locations projection
  -> reader_evidence_markers
  -> existing GET /media/{id}/document-map
  -> strict decoder
  -> overview rail markers
```

Ownership:

| Concern | Final owner |
| --- | --- |
| Durable cursor, CAS, save ordering | existing `useReaderProgress` and Consumption |
| Text visible-range capture | `paneTextAnchor.ts` |
| PDF visible-range capture | `PdfReader.tsx` |
| Browser document-position projection | new `readerDocumentPosition.ts` |
| EPUB anchor-to-canonical-offset conversion | `canonicalize.py`, consumed by `epub_read.py` |
| Navigation read model | existing `reader_navigation.py` / `epub_read.py` |
| Marker projection | existing `reader_locations.py` / `reader_evidence_markers.py` |
| Aggregate and transport | existing Document Map service/schema/decoder |
| Composition | `MediaPaneBody.tsx` |
| Presentation and clustering | `ReaderDocumentMapOverviewRail.tsx` |

No owner may derive another owner's state from a scrollbar percentage.

## Capability contract

The browser uses one internal semantic vocabulary:

```ts
type ReaderDocumentPoint =
  | { kind: "Text"; fragmentId: string; offset: number }
  | { kind: "Pdf"; page: number; pageFraction: number };

type ReaderPositionIntent =
  | "Reader"
  | "Restore"
  | "Preview"
  | "Return";

interface ReaderSemanticViewport {
  sourceKey: string;
  layoutGeneration: number;
  intent: ReaderPositionIntent;
  primaryLocator: ReaderResumeState;
  visibleStart: ReaderDocumentPoint;
  visibleEnd: ReaderDocumentPoint;
  atEnd: boolean;
}

interface ReaderDocumentOverviewRange {
  start: number; // closed 0..1
  end: number;   // closed 0..1; end >= start
}
```

Rules:

1. The active format publishes a snapshot only when both visible endpoints are
   exact for the current layout generation.
2. Absence is local state; do not fabricate zero points.
3. `primaryLocator` remains the existing persistence payload. Do not add a
   second cursor schema.
4. Preview, Return, and restore snapshots may paint the rail but retain their
   existing no-write/no-activity semantics.
5. `readerDocumentPosition.ts` projects points and ranges only. It owns no DOM,
   React state, fetch, persistence, clustering, or policy.
6. The rail receives `markers`, `visibleRange`, and activation callbacks. It
   receives no content ref, scroll ref, document span, or format flag.
7. `sourceKey` and `layoutGeneration` are session-local fences. They are never
   parsed, persisted, or sent over HTTP.

## Position rules

### Text

- A point is `(fragment_id, canonical Unicode-codepoint offset)`.
- Document order is the ordered unique fragment list; each fragment contributes
  its canonical length exactly once.
- Project with `(prefix fragment length + offset) / total length`.
- Capture the first and last visible canonical codepoints in one bounded DOM
  pass. Consolidate current first-visible callers on that helper; do not keep a
  second full scan for the rail.
- If a viewport intersects only non-text content, use its exact surrounding
  canonical boundaries. A document with no canonical text publishes no text
  viewport range.
- Typography, heading height, images, embeds, and viewport width may change the
  observed endpoints but never the coordinate definition.

### PDF

- A point is `(one-based page, pageFraction)` where `pageFraction` is normalized
  against the full canonical page height, not its scrollable remainder.
- Project with `((page - 1) + pageFraction) / pageCount`.
- Capture the first and last intersecting page and convert viewport clipping
  through the rendered page's PDF viewport transform.
- Gaps, shadows, margins, and zoom are excluded from semantic progress.

### Markers

- Contents, embeds, Highlights, citations, Links, and Synapses project their
  exact target start locus. Do not average a range.
- An EPUB Contents position is its exact `href_fragment` element start; a spine
  target without a fragment is offset `0`.
- Reject an external EPUB navigation target whose named anchor does not exist.
  A ready trusted target missing its derived offset is a defect. There is no
  midpoint, ordinal, section-count, or section-top guess.
- Sort by position, then stable kind and id. Sort order does not imply
  activation priority.

## Navigation API hard cut

Keep the existing routes:

```text
GET /api/media/{id}/navigation
GET /api/media/{id}/document-map
```

Hard-cut `MediaNavigationOut` to separate document units from navigation
targets:

```text
ReaderNavigationFragment {
  fragment_id: uuid
  fragment_idx: integer >= 0
  char_count: integer >= 0
}

ReaderNavigationSection {
  section_id: string
  label: string
  ordinal: integer >= 0
  fragment_id: uuid
  fragment_idx: integer >= 0
  start_offset: integer >= 0
  end_offset: integer | null
  level/depth/href_path/href_fragment/anchor_id: existing fields
}

MediaNavigation {
  media_id
  kind
  fragments: ReaderNavigationFragment[]
  sections
  toc_nodes
  landmarks
  page_list
}
```

Delete `ReaderNavigationSection.char_count`. Delete the convention that the
first navigation row carries the fragment length and later same-fragment rows
carry zero. EPUB Find, restore, total length, and active-fragment start consume
the unique `fragments` list.

`canonicalize.py` remains the sole canonical-text algorithm. Extend its one DOM
walk to return requested element-start offsets from the same normalized output.
`epub_read.py` resolves all requested IDs once per distinct stored fragment and
populates exact section offsets. Do not add another canonicalizer or cache.
`epub_ingest.py` validates named navigation anchors before publishing ready
navigation.

`GET /document-map` retains its marker schema. `position` changes to the exact
start-locus semantics above. Both strict browser decoders reject the removed
navigation shape; no old/new union survives.

Database, reader-state API, and persisted locators are unchanged.

## Web resume correction

Cold web source precedence is:

```text
fresh feature target
  -> saved Positioned target.fragment_id
  -> default first fragment only for Empty cursor
```

Select the saved fragment before exact restore begins. A mismatched saved
source must not settle restore on fragment one. Keep the existing locator
resolution ladder and no-write echo fence; neither is a compatibility path.

## Rail interaction and visual rules

- Keep the fixed 28px allocation; use a quiet 2px track and invisible 24px hit
  bands. The stored pane width does not change.
- The semantic viewport is a soft translucent band.
- Contents is a neutral hairline. Highlight is a diamond. Citation is a dot.
  Link/Synapse is a ring. Embed is a square. Warning adds an outline. Tone may
  supplement, never replace, shape.
- Cluster only when 24px targets would overlap. Use the median member position;
  never retain the first member's position as cluster authority.
- A single-member button activates directly. A multi-member button opens a
  labelled popover/list of native buttons for every member.
- Roving Arrow/Home/End navigation moves between rail buttons. Enter/Space
  activates a singleton or opens a cluster. Escape closes and returns focus.
- Preview text includes type, label/excerpt, and rounded document percentage.
  Preview is supplementary; every destination is named and operable without it.
- Do not add drag interaction, a slider role, live announcements on scroll, or
  a generic Document Map opener to the rail.
- Respect forced colors, reduced motion, 200-400% zoom, and existing warm-neutral
  reader tokens. No animation is required for correctness.

## Hard-cut cleanup

Delete in the same change:

- rail-owned `findScrollParent`, scroll listener, animation-frame state,
  content `ResizeObserver`, `scrollTop / scrollHeight`, and `documentSpan`
  prop/model; a track-only `ResizeObserver` may recompute presentation clusters
  after fixed-chrome reflow but reads no document geometry;
- `MediaPaneBody`'s rail-only `documentSpan` derivation;
- primary-member cluster activation and its approving tests;
- section-level EPUB length accumulation and zero-length repeated-row rules;
- Contents midpoint and ordinal/section-count position fallbacks;
- stale comments, fixtures, decoder branches, types, styles, and tests for the
  removed payload and behavior.

Do not preserve aliases, deprecated props, dual decoders, data adapters, or
feature switches.

## Implementation order

1. Add demonstrated-red owner tests for the four reported defects.
2. Hard-cut navigation fragments/sections and exact EPUB anchor offsets.
3. Add the pure position model and format semantic viewport capture.
4. Fix web saved-fragment precedence.
5. Convert the rail to a dumb semantic-range presenter and replace clustering.
6. Delete superseded paths, update current docs, then run focused proof.

Do not implement this concurrently with another change to
`MediaPaneBody`, `PdfReader`, `paneTextAnchor`, or the reader scrollport.

## Files

Primary backend:

- `python/nexus/services/canonicalize.py`
- `python/nexus/services/epub_ingest.py`
- `python/nexus/services/epub_read.py`
- `python/nexus/services/reader_navigation.py`
- `python/nexus/services/reader_locations.py`
- `python/nexus/services/reader_evidence_markers.py`
- `python/nexus/schemas/media.py`

Primary frontend:

- `apps/web/src/lib/media/readerNavigation.ts`
- `apps/web/src/lib/media/epubFind.ts`
- `apps/web/src/lib/reader/readerDocumentPosition.ts` (new)
- `apps/web/src/app/(authenticated)/media/[id]/epubRestore.ts`
- `apps/web/src/app/(authenticated)/media/[id]/paneTextAnchor.ts`
- `apps/web/src/app/(authenticated)/media/[id]/ReaderActivityAdapter.ts`
- `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.tsx`
- `apps/web/src/components/PdfReader.tsx`
- `apps/web/src/components/reader/ReaderDocumentMapOverviewRail.tsx`
- `apps/web/src/components/reader/ReaderDocumentMapOverviewRail.module.css`

Proof and fixtures:

- focused colocated tests for every owner above;
- `python/tests/test_reader_locations.py`
- `python/tests/test_reader_document_map_api.py`
- `python/scripts/seed_e2e_data.py`
- `e2e/tests/reader-document-map-overview-rail.spec.ts`
- `e2e/tests/reader-progress-continuity.spec.ts`

Current docs updated with implementation:

- `docs/architecture.md`
- `docs/modules/reader-implementation.md`
- `docs/modules/reader-design-rationale.md`
- `docs/cutovers/reader-document-map-evidence-trail-hard-cutover.md`
- `docs/cutovers/reader-progress-continuity-hard-cutover.md`

Do not touch Consumption schemas/services, reader-state routes, migrations,
workspace history, mobile chrome, Pane Find lifecycle, or secondary-surface
identity.

## Acceptance criteria

1. One semantic viewport capture drives cursor construction, text activity, and
   the rail; the rail has no scroll or document resize observer.
2. Marker and viewport projection agree under reflow, late image load, tall
   headings, tables, embeds, font/profile changes, and pane resizing.
3. Multi-fragment bare-route web resume restores the saved fragment and exact
   quote without a save echo.
4. Multiple EPUB headings in one fragment have distinct exact positions;
   document progression is monotonic and counts the fragment once.
5. PDF projection remains aligned across unequal page heights, page gaps, zoom,
   short pages, and a viewport crossing pages.
6. Every clustered member is discoverable, focusable, and independently
   activatable. No kind wins by array order.
7. Marker meaning survives monochrome/forced colors and all pointer targets are
   at least 24x24 CSS pixels.
8. No old navigation payload, raw-pixel position owner, midpoint/ordinal guess,
   primary-only activation, compatibility decoder, or stale normative claim
   remains.
9. The implementation reduces net position/clustering paths and introduces no
   database, persistence, worker, telemetry, or generic-framework surface.
10. Semantic capture runs at most once per animation frame, performs no second
    full DOM walk for the rail, and causes no long task in the large fixture.

## Required proof

Follow `docs/local-rules/testing-standards.md`.

- Demonstrate each regression red against the current defect or an equivalent
  temporary injected fault, then green after implementation.
- Use independent fixtures with known canonical offsets; do not copy current
  output as the oracle.
- Prove pure text/PDF projection laws: clamped endpoints, ordering,
  monotonicity, and exact section-start semantics.
- Use real Chromium for layout, focus, popover, forced-color, zoom, reflow, and
  late-load behavior.
- Use one thin real-stack Web/EPUB/PDF journey for transport and reader wiring;
  keep edge cases at owner level.
- Sensitivity: reintroduce raw scrollbar projection, repeated section lengths,
  or `members[0]` activation and observe the owning proof fail.
- Run focused checks first, then the smallest owning public lanes. Report
  backend, frontend unit, Chromium component, E2E, build, and production/device
  evidence separately; an unrun gate is not passed.

## Verification status

Focused backend, frontend unit, and real-Chromium owner suites are green.
Injected faults prove the exact text start, repeated-fragment length, missing
EPUB anchor, PDF page-space projection, cluster-member activation, and web
Empty-cursor precedence assertions are sensitive. The large text fixture
bounds recurring layout reads but does not establish a Long Tasks duration
budget.

The standard real-stack Playwright lane requires a production web build, which
was explicitly out of scope for this implementation run; Web/EPUB/PDF
real-stack journeys, forced-colors/browser-zoom exercise, build, CI, deploy,
device, and production evidence remain open release gates.

## Definition of done

The cutover is complete only when implementation, cleanup, current docs,
demonstrated-sensitive proof, and the thin real-stack journey all agree on the
single final contract. Static or focused green alone is not final acceptance.
