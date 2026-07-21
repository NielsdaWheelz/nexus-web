# The Second Apparatus — user + machine marginalia inline, passage-grain resonance, cross-document footnotes — Hard Cutover

**Status:** BUILT · margin/cite/stance foundation complete · 2026-07-20
**Type:** Hard cutover — no legacy code, no fallbacks, no compat shims, no flags-for-old-behavior. The margin becomes a real writing surface; the wide-viewport "evidence lives only in a drawer" assumption is deleted, not toggled.

## Current state and supersession

`MarginRail`, shared Evidence filter state, passage-grain Synapse targets, Cite,
and stance authoring are built. The approved
[`reader-evidence-scope-associations-hard-cutover.md`](reader-evidence-scope-associations-hard-cutover.md)
supersedes this document's storage-shaped Evidence inputs and
`highlight | apparatus | connection` filter mapping. It keeps MarginRail as the
wide spatial presenter and does not redesign Cite, stance, or Synapse dismissal.
Prerequisite and creation-language below records the historical implementation
plan rather than pending work.

## One-line

Build the *second* critical apparatus — the reader's own margin — where the user's writing and the machine's writing appear inline, at passage grain, across documents: widen Synapse to write **evidence_span**-grain edges, add a **Cite** verb that mints cross-document footnotes, add **stance marks** (conceding tick / doubting tilde) that finally fire the `supports`/`contradicts` vocabulary from the user's own hand, and render all of it in a new **MarginRail** beside the exact passage — the physical home dreams' *Take a Side* has been waiting for.

---

## 0. Prerequisites (hard, no fallback)

- **P-1. `machine-hand-hard-cutover.md` (SPEC) MUST land first.** `components/ui/MachineText.tsx` is the sole owner of the machine-voice register; the margin renders Synapse rationale through `MachineText` variant `"inline"`, `origin={{label:"Synapse"}}`. Its tokens (`--font-machine`/`--ink-machine`/`--rail-machine`) and the "only `MachineText.module.css` references them" gate do not exist yet. **MarginRail is a *new* `MachineText` inline consumer.** That spec's §7.3 forward-ref names `incoming-connections-reader-sidecar-*` (sibling #8, now `reader-sidecar-consolidation`) as the reader-connections consumer — it does **not** enumerate MarginRail. Adding MarginRail is consistent with machine-hand's extensibility intent (the "only `MachineText.module.css` references `--font-machine`" gate applies unchanged); confirm with the machine-hand owner that a new inline consumer needs no §7.3 amendment (F7).
- **P-2. `reader-sidecar-consolidation-hard-cutover.md` (SPEC) MUST land first.** Its `EvidencePaneSurface` (`apps/web/src/components/reader/document-map/EvidencePaneSurface.tsx`) merges highlight / apparatus / connection rows into one `EvidenceRow[]` union (`EvidenceRowKind = "highlight" | "apparatus" | "connection"`) with a `EvidenceFilterState` and three `aria-pressed` filter controls (**Highlights · Citations · Connections**). P-2 populates a *panel*, not the document gutter — the inline margin is complementary scope it does not address (no authorization from P-2 is needed; its N4 is about machine-output-in-place, not margins). This cutover fills that gap. We **amend** (do not delete) that spec: on wide viewports the margin becomes the default evidence presenter; the Evidence sidecar remains the narrow/mobile presenter **and the filter owner** (§10).
- **P-3. Synapse is BUILT** (`synapse-resonance-engine.md`, merged `038aa307`, mig `0149`). `python/nexus/services/synapse.py` is the sole writer of `origin='synapse'` edges; `synapse_suppressions` is the dismissal memory (media-pair-grain PK); `dismiss_synapse_edge` (synapse.py:349) suppresses + deletes. This cutover upgrades that one writer; it introduces no second connection store and no new origin.
- **P-4. The read model is already span-ready.** `reader_connections._anchor_for_ref` (`python/nexus/services/reader_connections.py:110`) resolves an `evidence_span` endpoint into `{locator, order_key, evidence_span_id, fragment_id, page_number}` via `reader_target_for_citation_target` (`resolve.py:225`); `query_connections` expands a `media:` ref to its owned `evidence_span` children (`resource_items/capabilities.py:430-435`, policy `media_owned_reader_children`). Verified: span-grain synapse edges surface in the existing reader-connections projection with no new endpoint (D-6).
- **P-5. The user-origin edge writer already exists.** `POST /resource-graph/edges` (`python/nexus/api/routes/resource_graph.py:166`) forces `origin='user'`, accepts any `kind ∈ {context, supports, contradicts}` and any visible source/target refs; FE proxy `apps/web/src/app/api/resource-graph/edges/route.ts`. Verified against `models.py`: **there is no `user`-origin shape CHECK** (only `synapse`/`citation`/`system`/`note_body`/`highlight_note` have per-origin shapes at models.py:643-758). A user edge `highlight→evidence_span` or `highlight→media` with `snapshot IS NULL`, `ordinal IS NULL` is **already legal today**. Both Cite and stance reuse this one writer (D-3).
- **P-6. The selection→highlight path exists.** `create_highlight_for_fragment` (`python/nexus/services/highlights.py:328`) is the machinery Cite/stance reuse when the target is a bare selection rather than an existing highlight (mirrors the quick-note composer's create-then-annotate).

---

## 1. Problem (grounded diagnosis)

### 1.1 The apparatus engine only ever set the source's own hand

Nexus parses, anchors, and typesets scholarly apparatus — footnotes, sidenotes, citations — but exclusively the *source's own* (`reader_apparatus_*`, rendered as the reader Contents/apparatus). The reader's writing lives in a parallel highlight sidecar; the machine's writing lives in the Connections drawer. `scriptorium.md §I` names it: "The one subsystem that knows how to put writing in the margin of a text has never been handed your writing." After `reader-sidecar-consolidation` (P-2) those two are merged into one *Evidence sidecar* — but a sidecar is still a drawer. On a wide screen the physical margin sits empty while evidence is exiled to a pane the user must summon with `G`.

### 1.2 Resonance is too coarse to be a sidenote

Synapse writes object-grain edges only: `ck_resource_edges_synapse_shape` (models.py:703-715) constrains `target_scheme IN ('media', 'note_block')`, and `_map_candidates` (synapse.py:549-585) collapses every `content_chunk` retrieval hit to `media:<media_id>` (synapse.py:563-570). A media-grain *"this book relates"* cannot live in a margin beside a line; only a span-grain rationale *is* a sidenote (`scriptorium.md §I`, "Passage-grain resonance"). Yet the retriever already carries the precision: `SearchResultContentChunkOut.evidence_span_ids` (`schemas/search.py:145`) ships the chunk's evidence span on every hit — Synapse throws it away at the map step.

### 1.3 The reader cannot point from document A to a passage in document B

There is no verb anywhere that mints an edge from a selection/highlight in one work to a passage in another. `buildHighlightActions` (`highlightActions.tsx:27-125`) offers color, note, quote-to-chat, edit-bounds, delete — nothing that says "this line answers *that* line, over there." The largest annotation gap in the reader, and the substrate to close it already exists: `resource_edges` + `evidence_span` targets + the `POST /resource-graph/edges` user writer (P-5).

### 1.4 The stance vocabulary has never been fired by the user's hand

`resource_edges.kind` has carried `supports`/`contradicts` since mig 0147; Synapse writes them as an *agent*. But the human has no gesture to assert a position. `dreams.md §Act II.2 (Take a Side)` specifies "a two-key chord in the reader minting a *user-origin* stance edge (conceding tick / doubting tilde in the margin). No dialog, no AI." It has no physical location because there is no margin. `scriptorium.md §I` is explicit: *Take a Side* lands **here** — "the margin, beside the passage, in your hand's register."

---

## 2. Target behavior (user-facing)

**Reader (wide viewport).** Beside the text, in the margin, you see: your highlight notes at their anchors (your hand); Synapse rationales set in the Machine Hand (`SYNAPSE`, cooler ink, no rail); cross-document footnotes (a superscript number, the target work's title + section); and your stance glyphs (a tick where you conceded, a tilde where you doubted). Items pack against their passages; when two want the same line, the later one slides down; when the margin runs out of room, a quiet "+N more" foot counts the overflow. Nothing is a card; hairline rhythm, small-caps kickers, amber only for the live focus.

**Passage-grain resonance.** A Synapse gloss appears *beside the exact sentence it is about*, not floating at the top of the document. Dismissing it (the existing dismiss button) silences **all** of that work's spans for the pair, forever — dismissal is a judgment about the two works, not one sentence.

**Cite (cross-document footnote).** Select a passage (or focus an existing highlight), invoke **Cite**. A scoped picker opens over your documents and their passages; choosing one mints a footnote from your passage to that passage — a superscript in your margin that deep-links to the other work. Citing a whole work (not a passage) is one choice in the same picker. From a fresh selection, the whole gesture is **≤ 3 interactions**: open Cite → type/pick target → confirm.

**Stance (Take a Side).** With a passage focused, two dedicated keystrokes — **concede** and **doubt** — place a tick or a tilde in the margin with **no dialog and no AI**. Concede records that you hold the passage; doubt records that you dispute it. The glyph is in *your* register (not the Machine Hand). Pressing the same key again removes the mark.

**Narrow / mobile.** Unchanged from `reader-sidecar-consolidation`: no margin; the Evidence sheet is the presenter and owns the kind filters. Cite and stance are still available from the highlight action menu; their results appear in the Evidence list (deliberate leave, §3 N-6).

---

## 3. Goals / Non-goals

### Goals

- **G-1.** Synapse writes `origin='synapse'`, `target_scheme='evidence_span'` edges when the chosen candidate maps to a chunk with an evidence span; `media` grain only as fallback. One CHECK widening; the sole writer stays `synapse.py`.
- **G-2.** A **Cite** verb on selections and existing highlights mints a `origin='user'` edge `highlight→evidence_span` (or `highlight→media` for a whole work) through the existing `POST /resource-graph/edges` writer. **No snapshot** on these edges.
- **G-3.** Two stance chords mint `origin='user'`, `kind ∈ {supports, contradicts}` edges from the focused passage, no dialog, no AI, idempotent-toggle.
- **G-4.** A new **MarginRail** renders user notes, Synapse rationales (`MachineText` inline), cross-doc footnotes, and stance glyphs inline in the reader margin on wide viewports, reusing `useAnchoredReaderProjection` + the existing overlap/overflow solver.
- **G-5.** Zero new tables. One migration (one CHECK widen + its `models.py` mirror). No new resource_edges origin. No new API route.
- **G-6.** Suppressions stay media-pair grain: dismissing a span-grain synapse edge suppresses the containing **media** pair, so re-scan proposes no span of that work.

### Non-goals

- **N-1. No new connection store, no new origin, no verb column.** Every assertion rides `resource_edges` (`scriptorium.md §I`: "machinery that already exists").
- **N-2. No AI in Cite or stance.** They are explicit user gestures; the model is not consulted. (Machine glosses are Synapse's separate, existing ambient path.)
- **N-3. No snapshot on user edges.** The target evidence_span is durable and internal; the gloss for a Cite is the highlight's existing linked note, not a snapshot copy (D-2). The `ck_resource_edges_snapshot_origin` CHECK already forbids snapshots on `origin='user'`.
- **N-4. No span-grain suppression.** Dismissal is a media-pair judgment (D-4).
- **N-5. No new margin backend endpoint.** The reader-connections projection already carries span-grain locators (P-4). A `GET /media/{id}/margin` is explicitly rejected (D-6).
- **N-6. No mobile margin.** Narrow/mobile keeps the Evidence sheet unchanged; the margin is a wide-viewport affordance only (deliberate leave).
- **N-7. No stance UI beyond the two chords + the glyph.** The Reckoning / Ledger of Positions (dreams §Act II.3–4) are downstream consumers of these edges, out of scope here.

---

## 4. Architecture and final state

### 4.1 Ownership

| Concern | Sole owner (final) | Replaces |
|---|---|---|
| Wide-viewport inline evidence rendering (margin) | `components/reader/MarginRail.tsx` (new) | the wide-viewport assumption that evidence is only in the Evidence sidecar (P-2) |
| Span-grain synapse edge writing | `services/synapse.py` (existing sole writer, upgraded) | media/note_block-only synapse targets |
| Cross-document footnote minting (`Cite`) | `buildHighlightActions` `cite` option → `POST /resource-graph/edges` (`origin='user'`) | (new; nothing pointed document→document) |
| Stance edge minting (`supports`/`contradicts`, user hand) | reader stance chords → the same `POST /resource-graph/edges` writer | (new; user could not assert a stance) |
| Cite target picker | `components/reader/CitePicker.tsx` (new) reusing `fetchSearchResultPage` | (new) |
| Covering-span resolution (highlight offsets → evidence_span) | `resource_graph/resolve.py::covering_evidence_span_for_highlight` (new) | (new) |
| Margin span-grain read model | existing `reader_connections` + graph ref expansion (P-4) | (already span-ready; no new endpoint) |
| Filter state (kind toggles) shared by margin + sidecar | `useEvidenceFilters` hook lifted into `MediaPaneBody` | filter state local to `EvidencePaneSurface` (P-2 §4.4) |
| Dismissal memory (media-pair) | `synapse_suppressions` via upgraded `dismiss_synapse_edge` | — |

### 4.2 Span-grain Synapse (the writer upgrade)

`_map_candidates` (synapse.py:549-585) changes only its `content_chunk` branch:

```python
if isinstance(result, SearchResultContentChunkOut):
    span_id = result.evidence_span_ids[0] if result.evidence_span_ids else None
    owner_media_id = result.source.media_id            # already in scope on the chunk out
    target = (
        ResourceRef(scheme="evidence_span", id=span_id)
        if span_id is not None
        else ResourceRef(scheme="media", id=owner_media_id)
    )
    candidate = _SynapseCandidate(
        target=target, owner_media_id=owner_media_id, label=result.source.title, snippet=...
    )
```

- **Dedup by target ref** (synapse.py:581-584) is unchanged; two chunks of the same work now dedupe to their spans (distinct sidenotes) rather than collapsing to one media row — passage grain is the point.
- **Cross-grain exclusion (the critical change, F-04).** `_excluded_refs` (synapse.py:493-547) still returns a `set[ResourceRef]` of `media:`/`note_block:` refs for self/kin/connected-pair/suppressed targets — these are all **containing-work grain**. The old check `candidate.target in excluded` (synapse.py:581) is now grain-mismatched (`evidence_span:S ≠ media:M`), so `_map_candidates` must compare at the owner-media grain: after building the span candidate, test **`ResourceRef(scheme="media", id=candidate.owner_media_id) in excluded`** (not `candidate.target in excluded`). `owner_media_id` is carried on `_SynapseCandidate` (populated above from `result.source.media_id`, already on `SearchResultContentChunkOut`); a media-grain fallback candidate compares itself directly. This is why suppression and connected-pair exclusions (media grain) keep blocking span candidates of an excluded work. `note_block`-owned spans do not arise here (chunk owners are media); the span target itself always has a media owner.
- **Per-work diversity cap (D-9).** Span-grain dedup lets one text-rich work fill every slot with its own spans. `_map_candidates` applies `SYNAPSE_MAX_CONNECTIONS_PER_WORK = 2` (keyed on `candidate.owner_media_id`) **before** the global `SYNAPSE_MAX_CONNECTIONS = 4` cap: two spans of a book is passage grain; four is monologue. This preserves the prior media-grain guarantee of inter-work diversity while allowing multiple sidenotes per work.
- **Snapshot rationale unchanged.** The edge still carries `snapshot=CitationSnapshot(title=<work title>, excerpt=<rationale>)` (synapse.py:324-330); `ck_resource_edges_synapse_snapshot_excerpt` (models.py:647-658) still requires it. Only `target_scheme` widens.

### 4.3 Dismissal stays media-pair grain (D-4)

`dismiss_synapse_edge` (synapse.py:349) normalizes the target before writing the suppression: if `edge.target_scheme == 'evidence_span'`, resolve the span's owner media and record `synapse_suppressions(source, media:<owner_id>)`. The exclusion re-check in `run_synapse_scan` (step 4d) already reads suppressions at the normalized grain (4.2). Result: dismissing one sentence silences the whole work-pair, and a re-scan proposes no span of it (AC-6).

### 4.4 MarginRail (the wide presenter)

`components/reader/MarginRail.tsx` — a sibling of `AnchoredSidecarSurface` that renders into the reader's margin gutter rather than a secondary pane. It **reuses** the exact projection + solve machinery:

- `useAnchoredReaderProjection` (`useAnchoredReaderProjection.ts:245`) for y-projection of each row against the live content DOM (`orderedRows`, `projections`, `viewportState`).
- The `alignRows` overlap algorithm (`AnchoredSidecarSurface.tsx:93-147`): sort by desired top, push each row below the previous bottom + gap, and count rows beyond the container height into `overflowCount` (the overflow counter loop is `AnchoredSidecarSurface.tsx:134-138`). MarginRail lifts the *pure* stacking core into a shared helper so both the sidecar and the margin call one solver (R-1 mitigation). Because `alignRows` also reads DOM (`containerRef.clientHeight`, `findScrollParent`), the live `viewportState.scrollTop`, and dispatches React state, the extraction takes only the geometry math — **each caller computes its own `baseline` + `desiredTop` first** (the margin's `containerRef` gutter geometry differs from the sidecar's pane geometry):

  ```ts
  // lib/reader/marginItems.ts
  export function stackAnchoredRows(
    positioned: { id: string; desiredTop: number }[],   // pre-sorted or unsorted; helper sorts
    opts: { rowHeights: Map<string, number>; rowHeight: number; gap: number; containerHeight: number },
  ): { alignedRows: { id: string; top: number }[]; overflowCount: number };
  ```

  Both call sites (sidecar `alignRows` and MarginRail) build `positioned` from `projections.map(p => ({ id, desiredTop: p.rect.top - viewportState.scrollTop + baseline }))`, sort by `desiredTop` (order-key tiebreak), then delegate the push-below-previous-bottom + overflow-count to the helper. `AnchoredSidecarSurface.alignRows` keeps ownership of the DOM reads and `setAlignedRows`/`setOverflowCount` dispatch; only the loop moves (F3).

Row kinds (one `MarginItem` union, tagged `kind`):

| `kind` | Register | Content | Anchor source |
|---|---|---|---|
| `note` | user (`--font-sans`, `--ink`) | linked note body (first line + expand) | highlight anchor (existing) |
| `synapse` | **MachineText inline**, `origin:{label:"Synapse"}` | `row.excerpt` (rationale) | connection `anchor.order_key`/`locator` (span-grain via P-4) |
| `footnote` | footnote register (small-caps kicker + superscript numeral) | target work title · section; deep-link | user Cite edge's target anchor |
| `stance` | user register glyph (`✓` tick / `~` tilde) | none (glyph only) | the covering span / highlight anchor |

Rendering law (per house `ResourceRow.module.css` doctrine): borderless, type-forward, calm; a hairline rule gives rhythm; focus is a quiet amber wash, never a bordered card. Footnote numerals use small-caps + `--tracking-wider`. Stance glyphs are text in the user ink, **never** a pill/badge.

**Breakpoint.** The margin renders only when the pane's available width ≥ `--reader-measure` + `--reader-margin-width`. **Both tokens are NEW** — neither exists in `globals.css` today (`grep reader-measure apps/web/src` is empty). S4 defines both in `apps/web/src/app/globals.css`: `--reader-measure: 65ch` (the reader column measure) and `--reader-margin-width: 19rem`. Measured via the pane `ResizeObserver` already present in `AnchoredSidecarSurface`; below threshold the margin is absent and the Evidence sheet is the presenter (N-6). No layout shift: the reader column keeps its measure; the margin occupies the previously-empty gutter.

**Crowding cap.** `MARGIN_MAX_ITEMS = 24` — a concrete named constant (`export const MARGIN_MAX_ITEMS = 24 as const` in `lib/reader/marginItems.ts`, with a comment citing the rationale: ~24 items at minimum row height fill a 1080p gutter; it has no `globals.css`/`config.py` home because it is a client render budget, not a style or server value). It caps rendered items; the overlap solver's `overflowCount` + the cap feed one "+N more" foot whose `onClick` opens the Evidence sidecar via the same pane activation as the `G` document-map verb targeting `reader-evidence` (`openSecondaryPane("reader-evidence")` on the pane runtime; the handler is wired in `MediaPaneBody`, §7.2). The sidecar is the full, filterable, scrollable escape hatch for a crowded margin (R-1).

### 4.5 Cite (cross-document footnote)

`buildHighlightActions` (`highlightActions.tsx:27`) gains one option, available on **both** target kinds (`existing` and `selection`):

```ts
options.push({
  id: "cite",
  label: "Cite a passage…",
  icon: <Quote size={14} aria-hidden="true" />,
  disabled: !isExisting && state.changingColor,
  onSelect: handlers.onCite,   // opens CitePicker
});
```

`onCite` flow (owned by `MediaPaneBody` via a `useCiteComposer` hook):
1. If target is a `selection`, first `create_highlight_for_fragment` (P-6) to obtain `highlight:<id>` (same create-then-annotate path as the note verb); if `existing`, use it directly.
2. Open `CitePicker` (a scoped `LauncherRow`-style list, not a modal card): debounced `fetchSearchResultPage` (`@/lib/search/searchApi`, the launcher's own search — `useLauncherController.ts:39,185`). **Result-type scoping (F-05, must be built — no FE path exists today).** `SearchQuery.requestedKinds` is `ReadonlySet<SearchKind>` where `SearchKind ∈ {documents, notes, highlights, conversations, people, web}` — `evidence_span`/`content_chunk`/`media` are internal `RESULT_TYPE_VALUES` discriminants (`types.ts:7`), **not** valid `SearchKind`s, and `searchParams.ts` exposes no `result_types` param. The backend `/search` route already accepts `result_types` (`routes/search.py:39`). **D-10: extend the FE query path** — add optional `resultTypes?: SearchType[]` to `SearchQuery` (`lib/search/query.ts`) and propagate it through `searchQueryToParams` (`searchParams.ts`) to the existing BE `result_types` param; CitePicker sets `resultTypes: ["evidence_span", "content_chunk", "media"]` and `requestedKinds: {documents}`. (*Rejected:* accept-all-documents + client post-filter — the `documents` kind fans out to 8 result types incl. podcast/video/apparatus, so the picker would show uncitable rows and waste a page of results.) Each row's `citable` ref (evidence_span for a passage, media for a whole work) is the target.
3. `POST /api/resource-graph/edges` with `{source_ref: "highlight:<id>", target_ref: <picked ref>, kind: "context"}` (origin forced to `user`, snapshot never sent — N-3). Refresh the reader-connections resource so the footnote appears in the margin.

Interaction budget from a fresh selection (AC-2):

| # | Interaction | Notes |
|---|---|---|
| 1 | invoke **Cite** (action-menu item or `c` chord on the selection popover) | opens `CitePicker` |
| 2 | type + arrow to a target passage/work | debounced `fetchSearchResultPage`; arrow keys are navigation, not counted per-key |
| 3 | **Enter** to confirm | POSTs the edge; footnote appears |

The highlight auto-create (P-6) is a side effect of step 3, not a user interaction. Citing an *existing* highlight is the same 3 (invoke → pick → confirm) since no selection is required first.

### 4.6 Stance (Take a Side)

Two reader stance chords. **Registration (F-09):** the `MediaPaneBody.tsx:4058` window listener handles *only* focus-mode cycling + Escape — **not** `n` or `G`. The `n` quick-note chord is a dedicated hook, `useHighlightNoteChord` (`MediaPaneBody.tsx:3305`, with `enabled`/`onTrigger`). Stance mirrors that pattern: register concede/doubt through a parallel `useReaderKeyChord`-style hook (or reuse the `useHighlightNoteChord` shape), **not** by patching the 4058 listener. The keys live in the reader keyboard model, not hardcoded in prose.

**Chord definition (D-11).** `dreams.md §Act II.2` says *"two-key chord in the reader minting a user-origin stance edge."* The existing reader chords (`G c`, `G e`) are *sequential composed keystrokes*. This cutover reads the "two keys" as **focus-a-passage + one dedicated key** (a modal activation-then-key), because a stance is intrinsically about the passage under attention — there is no meaningful stance without a focused locus. This is a deliberate departure from the `G x` sequential-chord shape; it is recorded here so the reader keyboard model can be checked for a single-key conflict. Exact keys: **`t`** = concede (tick), **`y`** = doubt (tilde) — chosen to avoid the existing `n`/`G`/focus-mode bindings; each fires only while a passage is focused, with **no dialog and no AI**.

Handler `mintStance(kind: "supports" | "contradicts")` (owned by `useStanceComposer` in `MediaPaneBody`):
1. Resolve the passage: if a highlight is focused, use it; else if there is a live selection, `create_highlight_for_fragment` (P-6) first.
2. Resolve the target: `covering_evidence_span_for_highlight` (§4.7); if it returns a span, target `evidence_span:<id>`; else fall back to `media:<anchor_media_id>` (the span-preferred/media-fallback pattern Synapse uses).
3. `POST /api/resource-graph/edges` with `{source_ref: "highlight:<id>", target_ref: <span|media>, kind}` (origin `user`).
4. **Toggle**: if a user stance edge with the same `(source, target, kind)` already exists, `DELETE /resource-graph/edges/{id}` instead (idempotent glyph). Distinct kinds coexist is disallowed by product sense — minting `contradicts` where `supports` exists replaces it (delete-then-create in one call sequence).

The stance edge's semantics: the **highlight is your hand** (the locus of attention that structurally cannot hold a stance); the **evidence_span is the durable claim-bearing text**; the **edge kind is the position** — the only place a stance can live. This is why the edge is not redundant with the highlight (D-5).

### 4.7 Covering-span resolver

`covering_evidence_span_for_highlight(db, *, viewer_id, highlight_id) -> ResourceRef | None` (new, `resource_graph/resolve.py`). Bridges the two coordinate systems (highlights anchor in fragment-offset / PDF-geometry space; evidence_spans anchor in `content_blocks` byte-offset space, models.py:2771-2819) **through the content-chunk locator layer** that already reconciles them:

- **Web/EPUB (fragment_offsets):** read the highlight's `(fragment_id, start_offset)`; find the `content_chunk` of `anchor_media` whose `summary_locator` covers that fragment offset (the same `summary_locator` reader-connections reads at reader_connections.py:132-155); return `evidence_span:<chunk.primary_evidence_span_id>` when present.
- **PDF (pdf_page_geometry):** find the chunk on the same `page_number`; return its `primary_evidence_span_id`.
- **No covering chunk / null span:** return `None` → caller falls back to `media:` grain.

This is a bounded, best-effort resolver (one media's chunks, indexed by fragment/page); it is explicitly allowed to miss (R-2). No new coordinate math is invented — it rides the chunk locator bridge already in production. Sketch (web branch):

```sql
-- given (:fragment_id, :offset, :media_id): the chunk whose web locator covers the offset
SELECT cc.primary_evidence_span_id
FROM content_chunks cc
WHERE cc.owner_kind = 'media' AND cc.owner_id = :media_id
  AND cc.summary_locator->>'fragment_id' = :fragment_id
  AND (cc.summary_locator->>'start_offset')::int <= :offset
  AND (cc.summary_locator->>'end_offset')::int   >= :offset
  AND cc.primary_evidence_span_id IS NOT NULL
ORDER BY cc.chunk_idx
LIMIT 1;
```

Permission is inherited from the caller having already resolved/created the highlight (P-6); the resolver reads only chunks of the highlight's own `anchor_media`.

### 4.8 MarginItem assembly (client-side, no new fetch)

`lib/reader/marginItems.ts::buildMarginItems(sources, filters)` composes the `MarginItem[]` union from data `MediaPaneBody` **already holds** after P-2 (it fetches all three for the Evidence sidecar):

| `MarginItem.kind` | Built from | Anchor / order key |
|---|---|---|
| `note` | `mediaHighlights[].linked_note_blocks` (only highlights with a note) | highlight `stable_order_key` (from `toTextAnchoredReaderRow`/`toPdfAnchoredReaderRow`) |
| `synapse` | `readerConnectionRows` where `source_category === "synapse"` | `anchor.order_key` (span-grain via P-4) |
| `footnote` | `readerConnectionRows` where `source_category === "user_link"` **and** `row.connection.kind === "context"` **and** the anchored endpoint is *this* media (the cite's source highlight) — the *other* endpoint's title/section is the footnote label | source highlight anchor |
| `stance` | `readerConnectionRows` where `row.connection.kind ∈ {supports, contradicts}` and `row.connection.origin === "user"` | covering-span / highlight anchor |

The function classifies each row into **exactly one** `kind` via a single if/else-if chain (F4): stance is matched first (`kind ∈ {supports, contradicts}` + `origin === "user"`), then footnote (`source_category === "user_link"` + `kind === "context"`), then synapse (`source_category === "synapse"`), then note. Because a stance edge is also a `user_link` row anchored to this media, the `kind === "context"` guard on footnote + the stance-first ordering prevents one edge from emitting two `MarginItem`s. It then sorts by a single comparable order key (highlight `stable_order_key` for notes/footnotes/stance; `anchor.order_key` for synapse — both are `document`-position strings compared with `compareStableString`, already imported by `useAnchoredReaderProjection.ts:20`), applies the shared `filters` (below), and truncates to `MARGIN_MAX_ITEMS`. It then hands `anchoredRows: AnchoredReaderRow[]` (each item projected to its anchor) into `stackAnchoredRows`. Because every source is already anchored by P-2's `EvidenceRow` merge, MarginRail introduces **no new backend round trip** (D-6).

Filter mapping (D-12, must match the sidecar's row classification — F6). The Evidence sidecar's three controls are `Highlights · Citations · Connections` and it classifies rows by `EvidenceRowKind = "highlight" | "apparatus" | "connection"`, so **every graph connection row — including user `Cite` footnotes and stance rows (both are `resource_edges` connections) — falls under the sidecar's `connection` toggle.** The margin MUST use the same mapping or AC-9 breaks (toggling `connection=false` would hide a footnote in the sidecar but leave it in the margin). Therefore: `note` maps under **Highlights** (`highlight` key); `footnote`, `stance`, **and** `synapse` all map under **Connections** (`connection` key); source-authored apparatus maps under **Citations** (`apparatus` key). One `useEvidenceFilters` state (`{highlight, apparatus, connection}`) drives both presenters identically (AC-9).

---

## 5. Data model / migration

**Migration `NNNN_synapse_span_grain_targets.py`.** *Number assigned at build time — main ends at **0168** (`0168_web_article_inline_embeds`), sibling `dawn-write-hard-cutover.md` claims **0169**, and the unmerged branch `codex/search-retrieval-roadmap` claims **0168–0173** and renumbers at merge.* `down_revision` = the then-current head at build.

One change, plus its `models.py` mirror. **No new table, no new column, no new origin.**

Widen `ck_resource_edges_synapse_shape` (models.py:703-715) target set to add `evidence_span`:

```sql
ALTER TABLE resource_edges DROP CONSTRAINT ck_resource_edges_synapse_shape;
ALTER TABLE resource_edges ADD CONSTRAINT ck_resource_edges_synapse_shape CHECK (
  origin != 'synapse' OR (
    source_scheme IN ('media', 'page', 'note_block', 'highlight')
    AND target_scheme IN ('media', 'note_block', 'evidence_span')   -- + evidence_span
    AND source_order_key IS NULL AND target_order_key IS NULL AND ordinal IS NULL
  )
);
```

`downgrade()` restores `target_scheme IN ('media', 'note_block')` — and MUST first delete `origin='synapse'` edges with `target_scheme='evidence_span'` (data-dependent downgrade; document it, mirroring 0149's downgrade note). The `ResourceEdge` `CheckConstraint` string in models.py:703-715 is edited to match. No other CHECK moves:

- **`user` (Cite + stance) edges need no migration.** Verified: no `user`-origin shape CHECK exists; `highlight→evidence_span`/`highlight→media` with `snapshot NULL`, `ordinal NULL`, `kind ∈ {context, supports, contradicts}` already passes every current constraint (`ck_resource_edges_snapshot_origin` permits snapshot only for citation/synapse → NULL for user is required and satisfied; `ck_resource_edges_ordinal_origin` requires ordinal NULL for non-citation). **D-1.**
- `evidence_spans.owner_kind` CHECK (`('media','note_block')`, models.py:2814-2817) is unchanged; synapse targets only media-owned spans (§4.2).

---

## 6. API

**None new.** Every write reuses existing routes:

| Method | Route | Used by | Notes |
|---|---|---|---|
| POST | `/resource-graph/edges` | Cite, stance | `origin` forced `user` (resource_graph.py:187); `kind` from body; no snapshot |
| DELETE | `/resource-graph/edges/{id}` | stance toggle-off | user-origin gate already enforced (resource_graph.py:214) |
| POST | `/synapse/edges/{id}/dismiss` | margin synapse dismiss | existing; now normalizes span→media (§4.3) |
| GET | (reader-connections projection, existing) | margin read model | already returns span anchors (P-4) |
| GET | `/api/web/search` / `fetchSearchResultPage` | Cite picker | existing launcher search |

`dismiss_synapse_edge` gains internal span→media normalization (§4.3) but its route signature is unchanged.

---

## 7. Frontend

### 7.1 Files created

```
apps/web/src/components/reader/MarginRail.tsx            # wide-viewport margin presenter
apps/web/src/components/reader/MarginRail.module.css     # borderless/hairline/footnote/stance-glyph styles
apps/web/src/components/reader/MarginRail.test.tsx        # Chromium: kinds render, MachineText inline for synapse, overflow foot, breakpoint
apps/web/src/components/reader/CitePicker.tsx            # scoped search picker (LauncherRow style)
apps/web/src/components/reader/CitePicker.test.tsx
apps/web/src/lib/reader/marginItems.ts                  # build MarginItem[] union from evidence sources; stackAnchoredRows helper home
apps/web/src/lib/reader/marginItems.test.ts             # unit: merge, sort, cap, kind tagging
apps/web/src/lib/reader/useEvidenceFilters.ts           # shared filter state (lifted from EvidencePaneSurface)
```

### 7.2 Adoption / modification map

| File | Change |
|---|---|
| `components/highlights/highlightActions.tsx` | add `cite` option (both target kinds); new `handlers.onCite` |
| `app/(authenticated)/media/[id]/MediaPaneBody.tsx` | mount `MarginRail` on wide; lift `useEvidenceFilters`; add `useCiteComposer` + `useStanceComposer`; register concede/doubt chords via a `useHighlightNoteChord`-style hook (NOT the 4058 focus-mode listener — F-09); wire `onCite` into the highlight action bar; add the "+N more" overflow-foot `onClick` that opens `reader-evidence` |
| `components/reader/document-map/EvidencePaneSurface.tsx` | consume the lifted `useEvidenceFilters` instead of local state; **stays the filter control owner** (its `aria-pressed` header) and the narrow/mobile presenter |
| `components/reader/AnchoredSidecarSurface.tsx` | extract `stackAnchoredRows` solver into `lib/reader/marginItems.ts`; call the shared helper (no behavior change) |
| `lib/reader/documentMap.ts` | reuse `ReaderConnectionRow`/`ReaderConnectionAnchor` types for `MarginItem` footnote/synapse kinds |
| `lib/resourceGraph/edges.ts` | **reuse the existing `createUserEdge({sourceRef, targetRef, kind})`** (edges.ts:55, already POSTs `/api/resource-graph/edges` with no origin param — server forces `user`); Cite/stance call it directly. No `createEdge` symbol exists; do **not** add one (F-06). |

### 7.3 Backend modifications

```
python/nexus/services/synapse.py                 # _map_candidates span mapping; _excluded_refs span→media; dismiss_synapse_edge normalization
python/nexus/services/resource_graph/resolve.py  # covering_evidence_span_for_highlight (new)
python/nexus/db/models.py                         # ck_resource_edges_synapse_shape target set += evidence_span
migrations/alembic/versions/NNNN_synapse_span_grain_targets.py  # the one widen
```

No change to `EDGE_ORIGINS` (BE `resource_graph/schemas.py`, FE `lib/resourceGraph/edges.ts`) — no new origin.

---

## 8. Key decisions

- **D-1. Cite and stance need no migration.** *Verified* there is no `user`-origin shape CHECK; user edges to any visible scheme with NULL snapshot/ordinal are already legal (P-5, §5). *Rejected:* pre-emptively adding a `user`-origin shape constraint — it would only narrow a working surface and create a migration where none is needed.
- **D-2. No snapshot on Cite/stance edges.** The target is a durable internal `evidence_span`; the human gloss is the highlight's existing linked note, not a copied excerpt. `ck_resource_edges_snapshot_origin` already forbids snapshots on `origin='user'`. *Rejected:* snapshotting the cited text onto the edge — duplicates durable content, and would fail the CHECK, forcing an origin lie.
- **D-3. One user-origin writer for both verbs.** Cite (`kind=context`) and stance (`kind ∈ {supports, contradicts}`) both go through `POST /resource-graph/edges`. *Rejected:* a dedicated `/cite` or `/stance` route — the generic writer already forces origin, validates visibility, and enforces the pair-uniqueness index; a second route would be a second writer for one concern.
- **D-4. Suppression stays media-pair grain.** Dismissing a span-grain synapse gloss suppresses the containing work-pair, silencing every span of it (§4.3). *Rejected:* span-grain suppression — dismissing "this book contradicts you" once should not require dismissing it sentence-by-sentence; the negative assertion is about the two works.
- **D-5. Stance = highlight (hand) → covering evidence_span (text); the edge kind is the position.** The highlight cannot carry a stance; the edge is the only home for it. *Rejected (a):* re-kinding an existing margin connection's endpoints — requires a pre-existing connection to take a side on, so dreams' bare "read a passage and doubt it" gesture would have no target, and it conflates "I agree with Synapse's proposal" (a meta-stance on the machine) with "I dispute this claim" (a stance on the text). *Rejected (b):* stance edge = highlight→media only — too coarse to aggregate into the Reckoning/Ledger; span grain when resolvable is the enabling precision.
- **D-6. No new margin endpoint; the read model is already span-ready.** `reader_connections` resolves `evidence_span` anchors and the graph expands `media→spans` (P-4). *Rejected:* `GET /media/{id}/margin` server-built projection — it would duplicate a read model that already carries locators + order keys, and add a round trip; the only reason spans weren't in the margin is that no writer targeted them.
- **D-7. Margin is the wide default; the sidecar is the narrow/mobile presenter + filter owner.** *Rejected:* deleting the Evidence sidecar on wide — it remains the filterable, scrollable, crowd-proof full list (the "+N more" escape) and the only place the kind filters live; the margin is ambient and inline but capped. This is the amendment to P-2, not its deletion (§10).
- **D-8. Span-preferred, media-fallback everywhere.** Both Synapse (§4.2) and stance (§4.6) prefer the evidence_span and fall back to media when no span resolves. *Rejected:* failing the gesture when no span exists — a coarse edge is better than a lost stance; the fallback is honest and re-heals if the document is later re-indexed.
- **D-9. Per-work diversity cap on span-grain Synapse (`SYNAPSE_MAX_CONNECTIONS_PER_WORK = 2`).** Span-grain dedup removes the old media-grain guarantee that one work took at most one slot; without a cap, a text-rich book could fill all `SYNAPSE_MAX_CONNECTIONS = 4` slots with its own spans (§4.2, F5). Two spans per work is passage grain; four is monologue. *Rejected:* no cap — reproduces the "one loud book crowds out every other resonance" failure the media-grain dedup implicitly prevented.
- **D-10. Extend the FE search query with `resultTypes` for CitePicker.** The BE `/search` route already accepts `result_types`, but the FE `SearchQuery` only carries `requestedKinds: SearchKind` and `evidence_span`/`content_chunk`/`media` are not `SearchKind`s (F-05, F2). Add optional `resultTypes?: SearchType[]` to `SearchQuery` + `searchParams.ts`. *Rejected:* fetch `documents` kind + client post-filter — the `documents` kind fans out to 8 result types (podcast/video/apparatus/…), wasting results and surfacing uncitable rows.
- **D-11. "Chord" = focus-a-passage + one dedicated key (modal), not a `G x` sequential chord.** `dreams.md`'s "two-key chord" is read as passage-focus + single key, because a stance requires a focused locus (§4.6, F8). *Rejected:* a literal two-key sequence (e.g. `s t`) — it would force a stance gesture to name its own target twice; the passage is already the focus. Recorded so the reader keyboard model can be verified for single-key (`t`/`y`) conflicts.
- **D-12. Margin filter mapping follows the sidecar's `EvidenceRowKind`, not the "your hand vs machine" register.** In the sidecar, all `resource_edges` connection rows (synapse **and** user Cite/stance) are `EvidenceRowKind = "connection"` under the **Connections** toggle. The margin maps `footnote`/`stance`/`synapse` all under `connection` so a toggle hides the kind in both presenters identically (§4.8, F6). *Rejected:* mapping Cite/stance under **Highlights** because they are "your hand" — it diverges from the sidecar's classification and breaks AC-9.

---

## 9. What dies (exhaustive)

This cutover is **additive-plus-adoption**; it deletes behavior and assumptions, not many modules.

- **Dies: the media-grain-only Synapse target.** `_map_candidates`'s unconditional `content_chunk → media:<media_id>` collapse (synapse.py:563-570) is replaced by the span-preferred mapping (§4.2). The `ck_resource_edges_synapse_shape` two-scheme target set (models.py:703-715) is superseded by the three-scheme set (§5).
- **Dies: filter state local to `EvidencePaneSurface`.** P-2's component-local `EvidenceFilterState` is lifted to `useEvidenceFilters` (shared by margin + sidecar). The `EvidencePaneSurface` header stays as the control; only the state *home* moves.
- **Dies: the wide-viewport assumption that evidence lives only in a drawer.** Not a file — a default. On wide, the margin is the ambient presenter; the sidecar becomes opt-in (`G e`).
- **NOT deleted:** `EvidencePaneSurface` (kept — narrow/mobile presenter + filter owner); the three `ReaderDocumentMap*Lens` components (already deleted by P-2, not by this spec); any highlight-card renderer (P-2 already consolidated highlight rendering into `EvidencePaneSurface`; the margin is an *alternate presenter*, not a replacement of that code — MarginRail composes the same row data, it does not fork highlight-card internals); `synapse_suppressions` (kept, only its write grain is normalized); `AnchoredSidecarSurface` (kept; its solver is extracted, not removed).
- **NOT added:** no new table, no new origin, no new API route, no second connection store.

---

## 10. Sibling cutovers and sequencing

- **`machine-hand-hard-cutover.md` (SPEC) — MUST land before this.** MarginRail's synapse rows render through `MachineText` variant `inline`, `origin={{label:"Synapse"}}` (P-1). That spec's §7.3 forward-ref names `incoming-connections-reader-sidecar-*` (sibling #8) as the reader-connections consumer, **not** MarginRail (F7); MarginRail is a *new* inline consumer, consistent with machine-hand's extensibility. We honor its gate unchanged (`MachineText` is the only referencer of `--font-machine`/`--ink-machine`; no `app/(oracle)/**` import) and confirm with the machine-hand owner that a new inline consumer needs no §7.3 amendment. Shared vocabulary: origin label **`Synapse`** is one of the labels that spec enumerates (Assistant, Synapse, Dossier, Dawn, Summary).
- **`reader-sidecar-consolidation-hard-cutover.md` (SPEC) — MUST land before this; we AMEND it.** Its `EvidencePaneSurface`/`EvidenceRow`/`EvidenceFilterState` are our input. It populates a *panel*, not the document gutter — the inline margin is complementary scope it does not address (its N4 is "No machine-output-in-place behavior", not a margin non-goal; no authorization from P-2 is invented — F1). **Amendment (stated for the record):** (1) on wide viewports the margin (`MarginRail`) is the default evidence presenter; (2) the Evidence sidecar remains the narrow/mobile presenter **and the sole owner of the kind-filter controls**; (3) filter state is lifted from `EvidencePaneSurface`-local into a shared `useEvidenceFilters` so the margin honors the sidecar's filters — with the margin using the **same `EvidenceRowKind` mapping** (Cite/stance/synapse all under `connection`, D-12); (4) the "+N more" margin overflow opens the sidecar. No surface IDs change; `reader-tools` stays exactly `{reader-contents, reader-evidence}` (that spec's AC-1). We do not re-add any of the five surfaces it deleted.
- **`synapse-resonance-engine.md` (BUILT) — we upgrade its sole writer.** One CHECK widen + `_map_candidates`/`_excluded_refs`/`dismiss_synapse_edge` edits; its D3 ("no per-span targets — spans stay citation-land") is the exact non-goal this cutover reverses, deliberately, now that the margin gives spans a home.
- **`dawn-write-hard-cutover.md` (SPEC)** claims mig **0169**; it also widens a CHECK (`ck_llm_calls_owner_kind`, disjoint from ours). No shared constraint; migration numbers are placeholders and renumber at merge. No shared file.
- **No sibling adds a resource_edges origin** (confirmed across the 10-spec slate); this cutover doesn't either. The overlap surface is `MediaPaneBody.tsx` — also touched by P-2, the machine-hand forward-ref, and **`lectern-hard-cutover.md` (SPEC), which adds `LecternNextPrompt`/`currentTotalProgression`** (disjoint regions from this spec's MarginRail mount + stance/cite chords; merge additively); land order P-1 → P-2 → this.

---

## 11. Slices (each independently buildable)

- **S0 — Schema widen.** Edit `ck_resource_edges_synapse_shape` (models.py) + migration `NNNN`. *Verify:* `cd python && uv run pyright && uv run ruff check .`; `make test-migrations` (head asserts synapse target CHECK includes `evidence_span`; downgrade deletes span-target synapse edges then narrows).
- **S1 — Span-grain Synapse writer.** `_map_candidates` span mapping; carry `owner_media_id` on `_SynapseCandidate`; compare **`media:<owner_media_id> in excluded`** (not the span ref) so media-grain suppression/connected-pair exclusions still fire (F-04); `SYNAPSE_MAX_CONNECTIONS_PER_WORK = 2` cap; dedup by target. *Verify:* extend `python/tests/test_synapse.py` — a chunk hit with `evidence_span_ids` writes `target_scheme='evidence_span'`; a chunk with no span falls back to `media`; two chunks of one work produce two span edges but **four chunks of one work produce at most two** (per-work cap); a span whose owner media is connected/suppressed is excluded (cross-grain); self/kin exclusion still holds at media grain. `make test-back-integration -k synapse`.
- **S2 — Dismissal normalization.** `dismiss_synapse_edge` span→media suppression; re-scan proposes no span of a dismissed work. *Verify:* `test_synapse.py` round-trip: dismiss a span edge → `synapse_suppressions` row is `(source, media:<owner>)` → next scan excludes all spans of that media (AC-6).
- **S3 — Read-model confirmation (no code if none needed).** Assert span-grain synapse edges surface in the reader-connections projection with `anchor.order_key`/`locator`/`evidence_span_id`. *Verify:* `test_reader_connections.py` — seed a `highlight→evidence_span` synapse edge on media X; `list_reader_connections(media_id=X)` returns it anchored. If a gap is found, extend `reader_connections` (not a new endpoint).
- **S4 — MarginRail.** Add `--reader-measure`/`--reader-margin-width` tokens to `globals.css`; build `MarginRail.tsx` + `marginItems.ts` (extract the pure `stackAnchoredRows(positioned, opts)` from `AnchoredSidecarSurface.alignRows` — caller keeps DOM reads/dispatch, F3; `MARGIN_MAX_ITEMS = 24` const); classify each row into exactly one kind (stance→footnote→synapse→note, F4); render the four kinds; synapse via `MachineText` inline; breakpoint tokens; cap + overflow-foot `onClick` → `openSecondaryPane("reader-evidence")`. Mount on wide in `MediaPaneBody`; lift `useEvidenceFilters` (mapping per D-12). *Verify:* `MarginRail.test.tsx` (Chromium): each kind renders; a single Cite/stance edge yields exactly one item (no footnote+stance double); synapse rationale is `MachineText`-inline; below-threshold width renders nothing; overflow foot appears past the cap and opens the sidecar; toggling `connection` hides footnote+stance+synapse. `marginItems.test.ts` (node): merge/sort/cap, `stackAnchoredRows` overlap + overflow count.
- **S5 — Cite verb.** Add `resultTypes` to `SearchQuery`/`searchParams.ts` (D-10); `cite` option in `buildHighlightActions`; `CitePicker.tsx` reusing `fetchSearchResultPage` with `resultTypes: [evidence_span, content_chunk, media]` + `requestedKinds: {documents}`; `useCiteComposer` (auto-create highlight on selection → `createUserEdge({sourceRef, targetRef, kind: "context"})` → refresh). *Verify:* `CitePicker.test.tsx` + `highlightActions.test.tsx`: the search request carries `result_types=evidence_span,content_chunk,media`; Cite appears on selection and existing; picking a passage POSTs `{source: highlight, target: evidence_span, kind: context}` with no snapshot; the footnote appears in the margin. Count interactions = 3 from a fresh selection (AC-2).
- **S6 — Stance marks.** `covering_evidence_span_for_highlight` resolver (BE) + `useStanceComposer` (→ `createUserEdge`, toggle-off via `DELETE`) + concede (`t`) / doubt (`y`) chords registered via a `useHighlightNoteChord`-style hook (NOT the 4058 listener, F-09) + margin glyphs. *Verify:* BE `test_resolve.py` covering-span over web + pdf + no-span-fallback; FE stance chord mints `supports`/`contradicts` with no dialog and toggles off on repeat; glyph is user-register text (AC-3, AC-7).

---

## 12. Acceptance criteria (testable)

- **AC-1.** A Synapse scan over a corpus with passage overlap writes at least one `origin='synapse'`, `target_scheme='evidence_span'` edge; that gloss appears in the margin **beside the exact passage** (its `anchor.order_key` matches the covering span's reader locator), rationale set in the Machine Hand.
- **AC-2.** From a bare selection, **Cite → pick a passage in another work → confirm** is ≤ 3 interactions and mints `origin='user'`, `source_scheme='highlight'`, `target_scheme='evidence_span'`, `snapshot IS NULL`; a superscript footnote appears in the margin deep-linking the other work.
- **AC-3.** With a passage focused, **one concede key** and **one doubt key** mint `origin='user'`, `kind='supports'` / `kind='contradicts'` edges respectively, **with no dialog and no model call**; pressing the same key again deletes the edge (toggle).
- **AC-4.** A Synapse candidate chunk carrying an `evidence_span_id` yields a span-grain edge; a chunk with no span yields a `media`-grain edge (fallback); two chunks of the same work yield two distinct span edges, not one collapsed media edge.
- **AC-5.** No user-origin edge (Cite or stance) is ever written with a `snapshot` (grep gate + BE test asserting `snapshot IS NULL` on every `origin='user'` row minted by these flows).
- **AC-6.** Dismissing a span-grain synapse gloss writes a **media-pair** suppression; a subsequent scan proposes **no span** of that work for the pair.
- **AC-7.** Stance glyphs render as user-register text (tick/tilde), not `MachineText` and not a pill/badge; the covering-span resolver returns a span for a web highlight over an indexed chunk and `None` (→ media fallback) when no chunk covers the offset.
- **AC-8.** The margin renders only when pane width ≥ `--reader-measure` + `--reader-margin-width`; below threshold, no margin and the Evidence sheet is unchanged (mobile parity).
- **AC-9.** Kind filters toggled in the Evidence sidecar header hide the corresponding margin kinds (shared `useEvidenceFilters`); the sidecar remains the sole filter control.
- **AC-10.** When margin items exceed the cap / container height, a single "+N more" foot counts the remainder and opens the Evidence sidecar; no overlap and no clipped rows remain.
- **AC-11.** Static + suites green: `cd python && uv run ruff check . && uv run pyright`; `make test-back-integration && make test-migrations`; `cd apps/web && bun run typecheck && bun run test:unit && bun run test:browser`.

---

## 13. Negative gates (grep-able)

Add to `python/tests/test_cutover_negative_gates.py` and a FE guard test `apps/web/src/lib/reader/secondApparatus.guards.test.ts`:

```bash
# 1. Sole writer: only synapse.py constructs a synapse edge targeting an evidence_span.
rg -n "target=ResourceRef\(scheme=\"evidence_span\"" python/nexus | rg -v "services/synapse.py|tests/" && exit 1 || true

# 2. No new resource_edges origin — EDGE_ORIGINS unchanged (still 7, no new member).
rg -n "document_embed" python/nexus/services/resource_graph/schemas.py   # anchor present
rg -n "EdgeOrigin" apps/web/src/lib/resourceGraph/edges.ts               # 7 members, no additions

# 3. No new table in the migration.
rg -n "create_table|CREATE TABLE" migrations/alembic/versions/NNNN_synapse_span_grain_targets.py && exit 1 || true

# 4. No snapshot on user (Cite/stance) edge minting — the composers never build a CitationSnapshot.
rg -n "CitationSnapshot|snapshot" apps/web/src/lib/reader/useCiteComposer* apps/web/src/lib/reader/useStanceComposer* 2>/dev/null && exit 1 || true

# 5. No new margin backend endpoint (read model is reused, not forked).
rg -n "/media/\{[a-z_]+\}/margin|def .*margin_projection" python/nexus/api && exit 1 || true

# 6. Machine register only via MachineText: MarginRail imports MachineText and never references --font-machine directly.
rg -n "font-machine|ink-machine|rail-machine" apps/web/src/components/reader/MarginRail.module.css && exit 1 || true
rg -n "MachineText" apps/web/src/components/reader/MarginRail.tsx   # must be present
```

Plus a BE integration assertion: after a Cite and a stance mint, `SELECT count(*) FROM resource_edges WHERE origin='user' AND snapshot IS NOT NULL` = 0 (AC-5).

---

## 14. Test plan

- **Unit (`.test.ts`, node):** `marginItems.test.ts` (merge/sort/cap/kind-tag, `stackAnchoredRows` overlap + overflow count); `secondApparatus.guards.test.ts` (§13 clauses 2, 4, 6).
- **Browser (`.test.tsx`, Chromium — real providers, fetch-boundary mock):** `MarginRail.test.tsx` (four kinds; `MachineText` inline for synapse; breakpoint present/absent; overflow foot; filter honoring); `CitePicker.test.tsx` (scoped search, ref selection, POST body shape, no snapshot); `highlightActions.test.tsx` (Cite on both target kinds); a `MediaPaneBody` browser smoke that a stance chord mints + toggles and renders a glyph.
- **Guards:** `test_cutover_negative_gates.py` (§13 clauses 1, 3, 5) + the `origin='user' snapshot IS NULL` integration assertion.
- **BE (`make test-back-integration`, `make test-migrations`):** `test_synapse.py` (span mapping, media fallback, two-span, kin/self exclusion at media grain, dismissal normalization + re-scan silence); `test_reader_connections.py` (span-grain synapse edge surfaces anchored); `test_resolve.py` (covering-span web/pdf/none); `test_resource_graph_edges.py` (user `highlight→evidence_span` context + supports/contradicts accepted, snapshot rejected); migration head + downgrade.
- **E2E (written, not run — house pattern):** reader margin shows a synapse gloss beside a passage; Cite from a selection creates a footnote; stance chord places a tick. Deferred per house convention; noted.

---

## 15. Files (created / modified / deleted)

**Created:** `apps/web/src/components/reader/MarginRail.tsx` (+ `.module.css`, `.test.tsx`); `apps/web/src/components/reader/CitePicker.tsx` (+ `.test.tsx`); `apps/web/src/lib/reader/marginItems.ts` (+ `.test.ts`); `apps/web/src/lib/reader/useEvidenceFilters.ts`; `apps/web/src/lib/reader/useCiteComposer.ts`; `apps/web/src/lib/reader/useStanceComposer.ts`; `apps/web/src/lib/reader/secondApparatus.guards.test.ts`; `migrations/alembic/versions/NNNN_synapse_span_grain_targets.py`; this spec.

**Modified:**
- `python/nexus/db/models.py` — `ck_resource_edges_synapse_shape` target set += `evidence_span`.
- `python/nexus/services/synapse.py` — `_map_candidates` span mapping; `_excluded_refs` span→media; `dismiss_synapse_edge` suppression normalization.
- `python/nexus/services/resource_graph/resolve.py` — `covering_evidence_span_for_highlight` (new).
- `apps/web/src/components/highlights/highlightActions.tsx` — `cite` option + `onCite` handler.
- `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.tsx` — mount `MarginRail` (wide); lift `useEvidenceFilters`; `useCiteComposer`/`useStanceComposer`; register concede/doubt chords via a `useHighlightNoteChord`-style hook; overflow-foot `onClick` → `openSecondaryPane("reader-evidence")`.
- `apps/web/src/components/reader/document-map/EvidencePaneSurface.tsx` — consume shared `useEvidenceFilters` (stays filter control + narrow presenter).
- `apps/web/src/components/reader/AnchoredSidecarSurface.tsx` — call extracted `stackAnchoredRows` (DOM reads + state dispatch stay local; only the stacking loop moves).
- `apps/web/src/lib/search/query.ts`, `apps/web/src/lib/search/searchParams.ts` — add optional `resultTypes?: SearchType[]` to `SearchQuery` and propagate to the BE `result_types` param (D-10, for CitePicker scoping).
- `apps/web/src/app/globals.css` — add `--reader-measure` (`65ch`) **and** `--reader-margin-width` (`19rem`) tokens (both new).
- `python/tests/test_cutover_negative_gates.py`, `python/tests/test_synapse.py`, `python/tests/test_reader_connections.py`, `python/tests/test_resolve.py`, `python/tests/test_migrations.py` — assertions above.

**Deleted:** no modules (behavior/assumption deletions only — §9).

---

## 16. Risks

- **R-1. Margin crowding (MEDIUM).** A dense passage can attract many notes/glosses/footnotes. *Mitigation:* the extracted `stackAnchoredRows` overlap solver (from `AnchoredSidecarSurface.tsx:93-147`) pushes rows below one another with a gap and counts overflow; `MARGIN_MAX_ITEMS` caps rendered items; a single "+N more" foot opens the full, scrollable, filterable Evidence sidecar (AC-10). The margin is ambient, not exhaustive — the sidecar is the escape hatch (D-7).
- **R-2. Anchoring drift in the covering-span resolver (MEDIUM).** Highlight offsets and evidence_span offsets live in different coordinate systems; the chunk-locator bridge (§4.7) is best-effort and can miss. *Mitigation:* miss → `None` → media-grain fallback (D-8), so a stance is never lost, only coarsened; if the document is later re-indexed the next mint resolves span-grain. The resolver is unit-tested over web + pdf + no-cover cases.
- **R-3. Suppression grain confusion (LOW).** A user could expect dismissing one sentence to leave other sentences of the same work. *Mitigation:* D-4 is deliberate and documented; dismissal is a work-pair judgment; the re-scan silence test (AC-6) pins the behavior.
- **R-4. Filter-owner split (LOW).** Lifting filter state out of `EvidencePaneSurface` risks the margin and sidecar diverging. *Mitigation:* one `useEvidenceFilters` hook is the single source; both presenters read it; the sidecar header is the only writer (AC-9).
- **R-5. Sequencing (LOW).** MarginRail hard-depends on `MachineText` (P-1) and `EvidenceRow`/`EvidenceFilterState` (P-2). *Mitigation:* land order P-1 → P-2 → this; the guard test (§13 clause 6) fails if MarginRail references machine tokens directly instead of through `MachineText`.
- **R-6. Span-vs-media dedup edge case (LOW).** A pair already connected at media grain by another origin (e.g. a user Cite to the whole work) should not be re-proposed span-grain by Synapse. *Mitigation:* `_excluded_refs` normalizes candidate spans to their owner media before the connected-pair check (§4.2), so the media-grain pair blocks all its spans — same grain as suppression.
