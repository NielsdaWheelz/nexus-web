# Reader Document Map / Evidence Trail — Final Contract

**Status:** BUILT

**Type:** Hard cutover; one aggregate, one instrument, no compatibility lanes.

## Scope

This document owns the reader-local aggregate, marker projection, secondary
surface vocabulary, and desktop overview rail. The final Evidence payload and
presentation are specified by
[`reader-evidence-scope-associations-hard-cutover.md`](reader-evidence-scope-associations-hard-cutover.md).
Header placement, the one semantic action, mobile Options behavior, secondary
region ARIA, and focus return are specified by
[`pane-header-identity-hard-cutover.md`](pane-header-identity-hard-cutover.md).

## Final State

```text
domain owners
  -> reader_document_map service
  -> GET /media/{media_id}/document-map
  -> strict web decoder / ReaderDocumentMap
       -> Contents secondary surface (when navigation exists)
       -> Evidence secondary surface
       -> desktop Document Map overview rail

readable capability + reader-tools publication
  -> documentMapAction
       -> desktop resource-header icon
       -> mobile Show/Hide Options item
```

Document Map is the reader's single side instrument. Its complete surface
vocabulary is `Contents | Evidence`; Evidence is always published and Contents
is included only when usable navigation exists. Desktop renders the publication
in the attached secondary pane. Mobile renders the same publication in the
workspace secondary sheet. Chat remains a conversation-pane capability, not a
Document Map tab.

The overview rail is ambient, desktop-only fixed primary chrome. It projects
the aggregate's positioned markers and current viewport band. Activating a
marker invokes its contextual target; the rail has no generic list/open button.
The semantic header/Options action is the only generic Document Map entrance.

## Aggregate Contract

`GET /media/{media_id}/document-map` authorizes the viewer, reads each domain
owner, and returns one strict aggregate:

- media identity and `ready | empty | partial` status;
- source-version fields for media, apparatus, graph, and highlights;
- optional navigation and document embeds;
- typed Evidence passage groups and whole-document items;
- normalized markers with stable id, kind, item id, position `0..1`, tone,
  label, and optional preview;
- explicit omitted-item diagnostics.

The service orchestrates existing owners; it does not create a second evidence
store. Highlights, source-authored apparatus, resource-graph connections,
navigation, embeds, and media authorization remain owned by their respective
services. A partial subordinate source produces the typed aggregate status and
diagnostics; authorization and missing media remain canonical not-found errors.

The browser decodes the response through `documentMapContract.ts`. Unknown,
missing, or malformed transport shapes fail at that boundary. UI code receives
only `ReaderDocumentMap` and its tagged Evidence/marker types.

## Marker And Activation Rules

- Marker positions are normalized from owner locators and document metadata,
  never scraped from rendered DOM geometry.
- Marker kinds are `Contents`, `Embed`, or an Evidence fact kind. Contents
  targets the Contents surface; Evidence facts target Evidence; embeds activate
  their contextual reader target without inventing an Embeds tab.
- Activation that changes section/location uses the reader's canonical target
  and pane-location seams. No secondary history or duplicate navigation model
  is introduced.
- Dense markers cluster visually while retaining their members and accessible
  count. Keyboard navigation is roving and deterministic.
- Hover/touch preview is supplementary. It cannot become the only way to
  identify or activate a marker.
- Unavailable or stale targets stay typed and visibly explained; they never
  silently jump to an approximate unrelated location.

## Composition Rules

- `MediaPaneBody` is the composition boundary: it loads the aggregate, derives
  the `reader-tools` publication and fixed rail from the same state, and
  publishes the one `documentMapAction` only when the readable capability and
  secondary publication both exist.
- `paneSecondaryModel.ts` owns group/surface identity and defaults.
- `SecondaryPaneShell` and `MobileSecondaryPaneHost` project the same
  publication. Every tab's `aria-controls` target remains mounted; only the
  active panel mounts its body.
- The group-level region id is pane-local and exists only while expanded.
  Collapsed desktop actions omit `aria-controls`; mobile Options never exposes
  submenu/disclosure IDREFs.
- The overview rail is fixed primary chrome and never changes stored primary
  pane width. The secondary pane width remains independent.
- Reader shortcuts operate only when their owning reader/Document Map layer is
  topmost; nested modal or menu interaction suppresses them.

## Ownership

| Concern | Owner |
|---|---|
| API route | `python/nexus/api/routes/reader.py` |
| Aggregate orchestration | `python/nexus/services/reader_document_map.py` |
| Evidence and marker projection | `python/nexus/services/reader_evidence.py`, `reader_evidence_markers.py` |
| Transport schema | `python/nexus/schemas/reader_document_map.py` |
| Strict browser contract | `apps/web/src/lib/reader/documentMapContract.ts` |
| Browser domain/helpers | `apps/web/src/lib/reader/documentMap.ts` |
| Reader composition | `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.tsx` |
| Evidence UI | `apps/web/src/components/reader/document-map/EvidencePaneSurface.tsx` |
| Semantic action | `apps/web/src/components/reader/document-map/documentMapAction.tsx` |
| Desktop rail | `apps/web/src/components/reader/ReaderDocumentMapOverviewRail.tsx` |
| Secondary identity | `apps/web/src/lib/panes/paneSecondaryModel.ts` |

## Acceptance Criteria

- One authorized aggregate request supplies navigation, Evidence, markers,
  source versions, and diagnostics; no Document Map UI dual-reads retired
  product routes.
- The reader exposes only `Contents | Evidence`; no Highlights, Citations,
  Connections, Embeds, or Chat tab survives.
- Every eligible pane has exactly one generic Document Map action per active
  projection and no overview-rail opener. Ineligible/playback-only media has
  none.
- Desktop and mobile consume the same typed secondary publication and preserve
  valid pane-scoped tab/tabpanel relationships.
- Every marker has a bounded position, stable activation result, accessible
  label, deterministic clustering, and typed unavailable behavior.
- The rail is desktop-only, fixed primary chrome, keyboard operable, and does
  not alter stored pane sizing.
- Aggregate status and subordinate omissions are explicit; authorization and
  invariant failures are not converted to empty UI.
- Current docs and tests contain no superseded multi-lens, duplicate-opener, or
  fallback architecture.

## Verification

- Backend aggregate/schema/service/route tests under `python/tests/`.
- `apps/web/src/lib/reader/documentMap.test.ts` and decoder contract tests.
- `EvidencePaneSurface.test.tsx`, `documentMapAction.test.tsx`, and
  `ReaderDocumentMapOverviewRail.test.tsx`.
- `MediaPaneBody.test.tsx`, `paneSecondaryModel.test.ts`,
  `SecondaryPaneShell.test.tsx`, and `MobileSecondaryPaneHost.test.tsx`.
- `e2e/tests/reader-document-map-overview-rail.spec.ts` and the reader/header
  E2E suites named by the pane-header contract.
