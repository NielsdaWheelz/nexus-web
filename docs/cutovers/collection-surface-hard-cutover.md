# Collection Surface — Hard Cutover

## Status

Implemented — 2026-06-19 (completion audit passed). S0–S6 are built, with
follow-up audit fixes folded into this working tree: collection reflow is committed by
`CollectionView` around ready row-order changes; media-reader morph targets are reader-owned
thumb/title elements; pane navigation preloads the target pane chunk before media-reader
transitions; mobile swipe rejects nested controls; reduced-motion is guarded in JS and global
`::view-transition-*` CSS; and the `isNestedInteractiveTarget(target, boundary)` guard takes the
activating element so a button-primary's own inert content does not suppress activation.

Completion proof from this audit:

- Frontend: `cd apps/web && bun run typecheck`; `bun run lint`; `bun run lint:css-tokens`;
  `bun run test:unit` (117 files / 886 tests); `bun run test:browser` (151 files / 1152 tests);
  targeted collection/resource guard shards; `make check-bundle` (authenticated First Load JS
  103.0 kB gz, budget 115 kB gz); `make audit`; `make check-workflows`; pinned
  provider-runtime local worktree gate (`214 passed, 156 deselected`).
- Backend: `make check-back`; `make type-back`; focused S3/S5 backend shard; `make
  test-back-integration` (1894 passed, 1375 deselected, 1 existing warning).
- Browser/security: `make test-e2e` (149 passed, 5 skipped) and `make test-csp` (13 passed).
- Real-media: `make test-real-media` (backend `41 passed, 3418 deselected`, then Playwright
  real-media `13 passed`).
Proposed — 2026-06-18. Repo-validated and corrected 2026-06-19.
Supersedes the row/list grammar established by
`docs/cutovers/pane-surface-kit-resource-row-hard-cutover.md` (Implemented 2026-06-12);
that doc's `PaneSurface` / `PaneSection` / `ResourceList` / `ResourceRow` primitives
remain, but `ResourceRow`'s anatomy and aesthetic are rewritten and a new domain layer
is introduced above them.

This is a hard-cutover plan. No legacy rendering path, no compatibility shims, no fallbacks,
no feature flags on the rendering layer. When a slice lands, the per-pane inline slot-mapping
and bespoke per-pane CSS for that surface are deleted in the same change; every row-shaped list
surface moves to the new presenter + collection layer together. The only forward-compatibility
hook is explicit and named: read-state is **derived** in v1 and a unified `consumption_state` table is
left as a documented v2 follow-up (§ Non-Goals N6), and synapse (AI) edges are **excluded** from
v1 connection surfacing (§ Key Decision 3).

Verification gate for each slice: `cd apps/web && bun run typecheck && bun run lint &&
bun run lint:css-tokens` green; `make check-bundle` ≤ 115 kB gz; FE unit + browser suites
green. For backend slices: `make check-back`, `make type-back`, and
`make test-back-integration` green. For the completed cutover, `make test-e2e` and
`make test-csp` are green.

## Summary

Every row-shaped authenticated list surface — library media/podcasts, the libraries directory,
search, browse, authors, notes, conversations, podcasts, podcast episodes, and settings rows —
renders through `CollectionView`/`CollectionRow` and then `ResourceRow`. Library manual reorder is
still owned by `SortableList`, but `SortableList` now opts into `ResourceList` semantics for that
collection path instead of being a second list renderer. The current primitive is "dumb slots": equal-weight
`title · meta · contributors · actions` in a bordered, rounded, filled box
(`ResourceRow.module.css:1-14`). There is **no owner of "what matters for this kind of thing,"**
so nothing is ever prioritized: a book, a podcast, a search hit and an author all render as the
same shape. Cover art is a 18px afterthought in library rows and ad hoc in browse/podcast rows,
author is shoved to a side cluster, and generic read-state, progress, and the connection graph
the product already stores are invisible. Podcast episode rows have local play-state/progress,
but that logic is not shared. The result reads as generic because the list is an *enumerator*,
not a *prioritizer*.

The fix has three moves. **(1)** Rewrite `ResourceRow`'s anatomy and aesthetic to a calm,
type-forward, borderless *Editorial Index* row, and add a *Gallery* view-mode + density control.
**(2)** Introduce a per-kind **presenter** layer — pure functions `present<Kind>(item, ctx) →
CollectionRowView` that own the decision of what earns weight per kind — feeding a new
  `CollectionView` / `CollectionRow` domain layer that owns list/gallery composition, keyboard
  navigation, CSS-native virtualization, reflow motion, and read-state/connection affordances.
This collapses the current row-surface inventory into 10 presenters and thin panes. **(3)** Make the list
*radiate* what the substrate knows, deterministically and AI-free: per-row connection summaries
from `resource_edges`, computed similarity/shared-author "related" peers, derived read-state +
progress, and a "Surfaced today" recency lane and "Resonance" ordering over a library.

First migration slice (S0) introduces the new aesthetic + shared atoms; the rendering cutover
(S2) is the load-bearing one; backend slices (S3–S5) are additive to storage (no legacy backend
path to cut and no Alembic migration expected), but they still change public schemas, route
signatures, BFF proxy routes, API route-count tests, and backend/frontend contract tests.

## SME Framing

The wrong question is *"how do we make the cards prettier?"* A card is a layout primitive; the
problem is not the primitive but that the surface has no information architecture. The right
questions, the ones an information-design practitioner asks:

- **What is the user doing at this surface?** Resuming a half-read book, finding one thing,
  deciding what to read next, discovering how two things relate. The list must serve retrieval
  and re-entry, not curation (per Spotify Research's finding that users have "limits of interest
  in spending effort manually organizing their libraries" → design for retrieval over curation).
- **What single fact decides the next action for *this kind* of item?** Book → progress + time
  left. Podcast → unplayed count. Episode → played-state + duration. Search hit → the matching
  snippet. Author → how present they are. A surface that gives every fact equal weight has made
  no decision. The presenter layer is where that decision finally has an owner.
- **What does the substrate already know that we are hiding?** The provenance graph
  (`resource_edges`), document resume (`reader_media_state`), audio play-state
  (`podcast_listening_states`), and authorship (`contributor_credits`) all exist. Authorship is
  partially visible, and podcast episodes expose local progress, but the substrate is not surfaced
  consistently across collection lists. "Surface what exists" (`docs/horizons.md`) is the
  differentiator: a knowledge tool's list should expose connection and progress at rest, which a
  flat enumerator structurally cannot.
- **Overview → zoom/filter → details-on-demand** (Shneiderman). The redesign gives the surface
  an overview (lanes, resonance ordering, density), real filtering (consolidated toolbar), and
  details-on-demand (reveal-on-hover actions, in-row connection rail, expand) — the three things
  the current middle-only list lacks.

The production-grade move is to stop smearing per-kind presentation logic across pane bodies and
row adapters and give it one owner, then render that owner's output through a primitive that stays
dumb. The aesthetic rewrite and the intelligence are downstream of that one architectural seam.

## Existing Architecture Boundaries

These boundaries stay intact.

- **The four pane-kit primitives** (`apps/web/src/components/ui/PaneSurface.tsx`,
  `PaneSection.tsx`, `ResourceList.tsx`, `ResourceRow.tsx`) remain the public layout/row grammar.
  `ResourceRow` and `ResourceList` are rewritten in place; `PaneSurface`/`PaneSection` are
  unchanged. Primitives stay domain-free: no imports of workspace, pane runtime, route model,
  domain API clients, or pane bodies (pane-surface-kit AC-10).
- **Pane runtime & per-pane URL scoping.** `usePaneSearchParams()` (`lib/panes/paneRuntime.tsx:339`)
  for reads and `paneRouter.replace(href)` for writes; state is per-pane `href`, never global
  `searchParams`. New view-mode/density/sort/filter state uses this exact mechanism.
- **Hydration cache + resource keys.** `useResource` (`lib/api/useResource.ts`) stays the fetch
  hook with its per-pane resource keys and consume-once hydration; AC-4 hydration tests preserved
  (pane-surface-kit N7 still forbids a universal resource adapter).
- **The provenance graph read path.** The current detailed reader is `query_connections()`
  (`python/nexus/services/resource_graph/connections.py:32`) behind
  `POST /resource-graph/connections/query`. The cutover adds a second graph-owned read model
  (`connection_summaries.py`) for counts/top peers, but it must stay inside
  `services/resource_graph`, reuse the same ref parsing, visibility, endpoint hydration, and
  `ConnectionEndpointOut` wire shape, and leave edge writers plus `resource_edges` shape untouched.
- **Reader resume + listening state.** `reader_media_state` / `podcast_listening_states` and their
  services (`services/reader.py`, `services/listening_state.py`) remain the source of truth;
  read-state is derived from them, not duplicated.
- **`SortableList`** (`components/sortable/SortableList.tsx`, dnd-kit) stays the drag-reorder owner
  for manual library-entry ordering. It can opt into `ResourceList` semantics for collection
  rows, so dnd is still one owner without creating a parallel list surface.
- **CSS modules + design tokens.** No Tailwind, no raw colors (`lint:css-tokens`); the warm
  editorial token system (`app/globals.css`) and the glass recipe are the visual vocabulary.
- **CSP + bundle.** Nonce strict-dynamic (`lib/security/csp.ts`), `img-src 'self' data:` via the
  media image proxy, First Load JS ≤ 115 kB gz (`scripts/check-bundle.mjs`). Pane bodies stay
  `React.lazy` (`lib/panes/paneRenderRegistry.tsx`), so per-pane code is off the shell.

## Governing Repo Rules

- `docs/rules/cleanliness.md` — "one owner per concern"; "collapse repeated logic to a single
  owner"; "make illegal states unrepresentable, delete downstream guards, give unions
  discriminants." The presenter layer and the consolidations (CT-1…CT-9) are direct applications.
- `docs/rules/simplicity.md` — "do not add speculative API surface"; "expose each capability in
  one primary form." `CollectionRowView` is built for the ten real row kinds, no speculative
  variants.
- `docs/rules/control-flow.md` — exhaustive matching on finite sets; presenter dispatch on
  `CollectionItemKind`, status maps, and view-mode switch are exhaustively matched.
- `docs/rules/frontend.md` — navigable state in the URL; one explicit empty-state representation;
  map domain/API errors to UI near the boundary (`*ErrorMessage`); fail loud on invariant breaks.
- `docs/local-rules/testing_standards.md` — real providers + fetch-boundary mock; role/label
  queries; `.test.ts` node / `.test.tsx` chromium browser.

## Current Duplication Inventory

### Top-Level Pane Surfaces (current row surfaces to dissolve)

Current repo scan: 19 direct `<ResourceRow>` call sites and 13 direct `<ResourceList>` call
sites under `apps/web/src/app/(authenticated)` plus `components/search/SearchResultRow.tsx`.
Each row-shaped surface builds `ResourceRow` slots by hand or through a thin adapter. Verbatim
mapping per surface:

- `libraries/[id]/LibraryPaneBody.tsx` — media rows (`:1008-1069`) and podcast rows (`:893-944`)
  inside `SortableList`; `leading` = local `MEDIA_KIND_ICONS` (`:83-88`, duplicates
  `RESOURCE_SCHEME_ICONS`), inline `.mediaStatus` processing chip, drag handle + `ActionMenu`.
- `libraries/LibrariesPaneBody.tsx` (`:315-350`) — library rows, `Pill` default badge.
- `browse/BrowsePaneBody.tsx` (`:417-702`) — four section types, all `primary:"button"`, inline
  `.typeBadge`, `MediaImage`-or-`.fallback`, `LibraryDestinationPicker`, per-section load-more.
- `search/SearchPaneBody.tsx` + `components/search/SearchResultRow.tsx` (`:39-58`) — snippet
  `<mark>` title, `noteBody` expanded. **Already presenter-shaped** via `SearchResultRowViewModel`,
  but still a React adapter that emits `ResourceRow` slots and must be folded into the presenter
  contract or explicitly left as the sole search exception.
- `authors/AuthorsPaneBody.tsx` (`:247-257`) + `authors/[handle]/AuthorPaneBody.tsx` (`:599-607`).
- `notes/NotesPaneBody.tsx` (`:102-110`), `conversations/ConversationsPaneBody.tsx` (`:150-165`).
- `podcasts/PodcastsPaneBody.tsx` (`:577-680`) + `podcasts/[podcastId]/PodcastEpisodeRow.tsx`
  (`:140-344`, the densest row: unplayed dot, progress `role=progressbar`, transcript form).
- `settings/*` rows (`SettingsPaneBody`, `identities`, `PasswordRow`, `keybindings`) — static or
  link/button rows; `keys`/`billing`/`local-vault`/`appearance`/`account`/`reader` are form/section
  panes and are not collection rows unless they render row-shaped resources.

### Existing Shared Primitives (reuse, do not duplicate)

- `ResourceRow` / `ResourceList` / `ItemCard` (full contracts in § Capability Contract).
- `lib/actions/resourceActions.ts` — `mediaResourceOptions` / `podcastResourceOptions` /
  `episodeResourceOptions` / `libraryResourceOptions` / `conversationResourceOptions`: **already
  the per-kind decision extracted to pure data**. The presenter template.
- `components/ui/Pill.tsx` (tones) / `Chip.tsx` (pressable+removable) / `MediaImage.tsx` (owned|
  proxied) / `ActionMenu.tsx` / `ActionBar.tsx` / `Tabs.tsx` (roving) / `Toggle.tsx` / `Select.tsx`.
- `components/contributors/ContributorCreditList.tsx`; `lib/resources/resourceKind.ts`
  (`RESOURCE_SCHEME_ICONS`); `components/feedback/Feedback.tsx` (`toFeedback`/`FeedbackNotice`);
  `components/workspace/PaneLoadingState.tsx`.
- `lib/useStringIdSet.ts`; `lib/ui/rovingIndex.ts`; `lib/ui/*` overlay/focus hooks; `useResource`.

### Why The Existing Pieces Are Not Enough

The primitives render chrome; nothing owns per-kind *content* decisions, so each pane re-derives
them, and the same cross-cutting concerns are re-implemented per pane. The redesign adds the
missing owner (presenters) and the missing domain composition layer (CollectionView/Row), and in
doing so consolidates these repeated patterns, each with a single proposed owner:

| ID | Repeated pattern | Occurrences | Single owner |
|----|------------------|-------------|--------------|
| CT-1 | Load-more / cursor pagination + footer button | search, authors, conversations, podcasts, podcast-detail, browse (6) | `lib/api/useCursorPagination.ts` + `LoadMoreFooter` |
| CT-2 | "busy id set" add/await/finally-remove dance | 15 `useStringIdSet` sites | `lib/ui/useOptimisticAction.ts` (`runWithBusy`) |
| CT-3 | Status/sync/played/type chip rendering | ≥6 bespoke `<span.*Badge>` + 3 `statusVariant` pairs | `lib/status/*` maps → `Pill` (in presenters) |
| CT-4 | empty/loading/error → `state` slot wiring | 24 panes | `PaneSurface` derives from `useResource` union |
| CT-5 | filter/sort/search toolbar + URL read/write + debounce | browse, search, authors, podcasts ×2 | `PaneToolbar` + `lib/api/usePaneUrlState.ts` + one `useDebouncedValue` |
| CT-5b | cover-image-or-icon-fallback idiom + two icon maps | ≥6 | `components/ui/ResourceThumb.tsx` + one icon map |
| CT-6 | per-kind `ActionMenu` builders | `resourceActions.ts` (already central) | folded into presenters' `actions` |
| CT-7 | `ContributorCreditList` `maxVisible` inconsistency + leftover external `hasContributorLinks` guard | 8 | density-derived constant; delete redundant caller guards (the component already returns `null` for missing/unlinked credits) |
| CT-8 | `useResource` page-1 + hand-rolled append | overlaps CT-1 | CT-1 only; `useDebouncedFetch` unified into the pattern |
| CT-9 | second row primitive `ItemCard` + its capabilities | reader sidecars | `ItemCard` kept; its guard + clamp extracted to shared hooks |

## Target Behavior

After the cutover:

- Every list renders through `CollectionView` fed by a per-kind presenter. Panes fetch data,
  pick a presenter, and pass rows + a toolbar; they contain no slot-mapping, no status-chip
  markup, no load-more/busy/debounce boilerplate.
- Rows are calm, type-forward, borderless *Editorial Index* rows: the headline fact earns weight,
  metadata is dimmed tabular figures, actions reveal on hover/focus (persistent overflow on touch/
  keyboard), and read-state + progress + a connection count are visible at rest.
- A **Gallery** view-mode (cover-forward) and a **comfortable/compact** density toggle are
  available where they make sense, persisted in the pane URL, defaulting to the Editorial list.
- Lists are keyboard composites: a single tab stop, arrow/Home/End navigation, type-ahead, Enter
  to open. Large lists stay smooth via `content-visibility`. Filtering/sorting reflows rows with
  a View Transition rather than a teleport; opening a row morphs it into the reader.
- On mobile, rows expose swipe-to-action; the same actions remain in the overflow menu and via
  keyboard.
- A media row shows "↳ N connected"; expanding reveals deterministic peers (label + link + edge
  tone), no AI, no generated text. A library offers a **Resonance** ordering and a **Surfaced
  today** lane computed from recency, connection count, shared author, and similarity.

## Goals

- **G1** One owner per per-kind presentation decision: the presenter layer; zero inline
  slot-mapping left in pane bodies.
- **G2** One row primitive family with a single visual contract; the Editorial aesthetic and any
  future re-skin live in `ResourceRow.module.css` + `CollectionRow`, propagating to all surfaces.
- **G3** Per-kind prioritization: each row leads with the fact that drives the next action;
  read-state, progress, and connection count are first-class, not absent.
- **G4** List ⟷ Gallery view-modes + density, URL-persisted, default to the list.
- **G5** Keyboard-composite navigation + type-ahead; `content-visibility` virtualization;
  View-Transition reflow + grid→reader morph; mobile swipe — all at zero shell-bundle cost.
- **G6** Surface the provenance graph in lists, deterministically and AI-free: per-row connection
  summaries + similarity/shared-author "related" peers.
- **G7** A "Surfaced today" recency lane and a "Resonance" ordering over a library, deterministic.
- **G8** Consolidate CT-1…CT-9; net deletion of per-pane boilerplate and bespoke CSS.
- **G9** Accessibility: real semantic HTML, ARIA composite list, reveal-on-hover never the only
  affordance, reduced-motion honored including View-Transition pseudo-elements.
- **G10** Stay within all rails: ≤ 115 kB gz, nonce-CSP, token-only colors, mode-pure mobile,
  no new heavy dependency.

## Non-Goals

- **N1** No AI/LLM at request time anywhere in this surface. No generated reasons, summaries, or
  rankings. (Embedding *similarity* is precomputed-vector math, not an LLM call — in scope.)
- **N2** No synapse (AI-judged) edges in v1 connection surfacing (§ Key Decision 3).
- **N3** No "Shortlist"/saved-priority lane (it is another library; future).
- **N4** No Peek/Quick-Look hover-detail surface (future).
- **N5** No dedicated "Continue/Resume" button — Enter/click/tap on the row resumes.
- **N6** No `consumption_state` migration in v1; read-state is derived (§ Key Decision 4). The
  unified table + true "opened" event + highlight-count index are a documented v2 follow-up.
- **N7** No universal resource fetch adapter (pane-surface-kit N7 stands); CT-1 layers on
  `useResource`, it does not replace per-pane keys/hydration.
- **N8** Reader document-map sidecars and `ItemCard` are not merged into `CollectionRow`; only
  their reusable guard + clamp are extracted (CT-9).
- **N9** No real-time/SSE list deltas; optimistic single-item mutations only (as today).
- **N10** No new image domains; remote art stays on the same-origin proxy (`img-src 'self' data:`).
- **N11** No virtualization library and no gesture/animation library; CSS-native only.

## Scope

### In Scope

- Rewrite `ResourceRow.tsx` + `.module.css` (anatomy + Editorial aesthetic + nested-action guard
  + reveal-on-hover); evolve `ResourceList.tsx` + `.module.css` (composite keyboard nav,
  `content-visibility`, density/view-mode data attributes).
- New domain layer: `lib/collections/types.ts` (`CollectionRowView`), `presenters/*` (10 kinds),
  `components/collections/{CollectionView,CollectionRow,CollectionGalleryCard,ConnectionRail,
  ReadStateBadge}`.
- New shared atoms/hooks: `ResourceThumb`, `PaneToolbar`, `LoadMoreFooter`, `SortSelect`;
  `useCursorPagination`, `useOptimisticAction`, `usePaneUrlState`, `useDebouncedValue`,
  `useCollectionKeyboard` (+ `typeAhead`), `useRowSwipe`, `isNestedInteractiveTarget`,
  `useClampWithToggle`; `lib/status/*`; `lib/collections/collectionViewState.ts`; relative-time
  in `lib/display/format.ts`.
- Migrate every row-shaped surface in the current inventory to presenters + `CollectionView`;
  delete inline mappings + bespoke CSS; reconcile the two icon maps. The hard gate is source
  based, not count based: no direct `<ResourceRow>` outside the approved collection/search
  wrappers after S2.
- Backend (additive to storage, no Alembic migration expected): derive
  `read_state`/`progress_fraction`/`last_engaged_at` on `MediaOut`; add a
  `connection_summaries` batch service + `POST /resource-graph/connections/summary`; add
  `GET /media/{id}/related` (similarity + shared-author); add library `?sort=resonance` +
  `surfaced_today` fields. These are still contract changes: schemas, routes, BFF proxy routes,
  `apps/web/src/app/api/proxy-routes.test.ts` `API_ROUTE_COUNT`, frontend clients, and tests
  must change with them.

### Out Of Scope

- Synapse surfacing, Shortlist, Peek, consumption_state migration, real-time deltas, reader
  sidecar/`ItemCard` merge (N2–N9).
- Settings `keys`/`billing`/`local-vault`/`appearance`/`account`/`reader` form surfaces (not
  row-shaped); they keep `PaneSection`. They adopt `lib/status/*` only for status pills they
  actually render, not as a forced collection migration.
- Any new image optimization/CDN; blur-up for proxied (unoptimized) covers (CSS skeleton only).

## Final Architecture

### Ownership Map

| Concern | Final owner | Notes |
|---------|-------------|-------|
| Row chrome / slot DOM / activation | `ResourceRow` (rewritten) | dumb, domain-free; gains nested-action guard + reveal-on-hover |
| List semantics / spacing / keyboard composite / virtualization | `ResourceList` (evolved) | `role` composite, `content-visibility`, density/view data-attrs |
| Per-kind content decision ("what matters") | `lib/collections/presenters/*` | pure `present<Kind>(item, ctx) → CollectionRowView` |
| Row view-model shape | `lib/collections/types.ts` `CollectionRowView` | one discriminated shape for 10 kinds |
| Domain row rendering + affordances | `components/collections/CollectionRow` | maps view-model → `ResourceRow`; owns connection rail, read-state badge, swipe |
| List/gallery/density/lanes/states orchestration | `components/collections/CollectionView` | owns toolbar slot, keyboard, reflow, empty/loading/error |
| Cover-or-icon lead | `components/ui/ResourceThumb` | one icon map (`resourceKind.ts`) |
| Status chips | `lib/status/*` → `Pill` | `mediaProcessingStatusPill`, `podcastSyncStatusPill`, `apiKeyStatusPill`, … |
| Per-kind menus | `lib/actions/resourceActions.ts` | consumed by presenters' `actions` |
| Pagination | `lib/api/useCursorPagination` + `LoadMoreFooter` | opaque cursor; offset variant for podcasts |
| Optimistic busy gating | `lib/ui/useOptimisticAction` | wraps `useStringIdSet` |
| Toolbar + URL state + debounce | `PaneToolbar` + `usePaneUrlState` + `useDebouncedValue` | one debounce constant |
| View/density/sort/filter state | `lib/collections/collectionViewState.ts` | value-object ⇆ `URLSearchParams` |
| Connection summary (read) | `services/resource_graph/connection_summaries.py` | one aggregate query; reuses graph ref parsing, visibility, resolve, and activation helpers for peers |
| Related peers (similarity + author) | `services/media_related.py` + `api/routes/media.py` `GET /media/{id}/related` | precomputed vectors; no LLM |
| Resonance ordering + surfaced-today | `services/library_entries` (`?sort=resonance`) | deterministic score over existing signals |
| Read-state derivation | `services/media.py` → `MediaOut` | from `reader_media_state` + `podcast_listening_states` |

### Dependency Direction

```
pane body (fetch + wire)
   ──> CollectionView ──> CollectionRow ──> ResourceRow / ResourceList   (primitives: domain-free)
   │        │                  │
   │        │                  └─> ResourceThumb, Pill(status), ContributorCreditList, ActionMenu
   │        └─> useCollectionKeyboard, useCursorPagination, PaneToolbar, collectionViewState
   └─> presenters/*  ──> resourceActions, lib/status/*, lib/display/format, connection/read-state view types

presenters  ──> domain types + API view-models        (NOT ──> primitives, NOT ──> pane runtime)
primitives  ─/─> workspace | pane runtime | API clients | pane bodies   (forbidden, unchanged rule)
CollectionView ─/─> raw fetch   (panes fetch; View renders)
```

## Capability Contract

### `ResourceRow` (rewritten primitive)

It owns: the row DOM, the `primary` activation union, slot placement, the Editorial aesthetic,
the nested-action click guard, reveal-on-hover action visibility, and the `@container` reflow.

It does not own: data, fetching, per-kind decisions, connection/read-state semantics, list
keyboard nav, or view-mode. Those are above it.

Proposed API (reconciles the three drifts the audit found: `badges`/`as`/`rel` are real; no
top-level `disabled`; guard now lands here, not only on `ItemCard`):

```tsx
type ResourceRowPrimary =
  | { kind: "link"; href: string; paneTitleHint?: string; target?: "_self" | "_blank"; rel?: string }
  | { kind: "button"; onActivate: () => void | Promise<void>; disabled?: boolean; busy?: boolean; label: string }
  | { kind: "static" };

interface ResourceRowProps {
  primary: ResourceRowPrimary;
  title: ReactNode;                 // the headline fact, type-forward
  eyebrow?: ReactNode;              // recency/lane reason
  badges?: ReactNode;              // read-state + status chips
  description?: ReactNode;          // shown only at comfortable density
  meta?: ReactNode;                 // dimmed tabular-figure signal facts
  contributors?: ReactNode;
  leading?: ReactNode;              // ResourceThumb
  trailing?: ReactNode;             // progress affordance + "↳ N connected"
  actions?: ReactNode;              // reveal-on-hover; persistent overflow
  expanded?: ReactNode;             // connection rail
  selected?: boolean;
  density?: "comfortable" | "compact";
  className?: string;
  as?: "li" | "div";               // "div" inside SortableList / gallery
}
```

Rules: borderless at rest (canvas bg, `--edge-subtle` hairline or rhythm), hover = `--surface-1`
wash not a bordered card; title uses size + `--tracking-tight` for weight; `meta` uses
`font-variant-numeric: tabular-nums`; actions `opacity:0` until `:hover`/`:focus-within`, but the
overflow trigger stays reachable and all actions exist in the menu; a click on a nested
interactive element (`isNestedInteractiveTarget`) never triggers row activation; tokens only.

### `ResourceList` (evolved primitive)

It owns: `<ul>`/`<li>` semantics, inter-row rhythm, the ARIA composite (single tab stop +
arrow/Home/End via `nextRovingIndexForKey`), `content-visibility:auto` + `contain-intrinsic-size`
per row, and `data-view`/`data-density` attributes that drive layout. Keeps `label`/`description`/
`footer`. It does not own data, gallery card markup, or which row is active beyond focus.

### `CollectionRowView` (the view-model — the heart)

```tsx
type CollectionItemKind =
  | "media" | "podcast" | "podcast_episode" | "library"
  | "contributor" | "note" | "conversation" | "search_result" | "browse_result"
  | "settings_row";

interface CollectionRowView {
  id: string;
  kind: CollectionItemKind;
  primary: ResourceRowPrimary;
  lead: ResourceThumbSpec;                         // { src?: ImageSrc; icon: IconName; shape: "cover" | "icon" }
  headline: { text: string; segments?: EmphasisSegment[] };   // segments → <mark> for search
  signals: SignalFact[];                           // 0–3: { label?: string; value: string }
  consumption?: { status: "unread" | "in_progress" | "finished"; fraction?: number }; // read/play-state
  status?: { tone: PillTone; label: string };      // non-read domain status (processing/sync/…)
  connections?: { total: number; dominantKind?: EdgeKind; topPeers: PeerChip[] };
  related?: PeerChip[];                            // similarity + shared-author (lazy)
  contributors?: { credits: ContributorCredit[]; maxVisible: number; showRole?: boolean };
  recency?: { at: string; reason: "added" | "connected" | "read" | "published" };
  actions?: { menu?: ActionMenuOption[]; inline?: InlineAction[] };
  swipeActions?: SwipeAction[];
  selected?: boolean;
}
```

Rules: presenters return data, not JSX (except `headline.segments`); `signals` capped at 3;
`consumption` and `status` are distinct because a real row can be both "in progress" and
"processing failed"; invalid status values are ruled out by the typed status maps; `id` is
globally unique for keyboard/selection/virtualization keys.

### Presenters (`lib/collections/presenters/*`)

Each is `present<Kind>(item: <DomainItem>, ctx: PresenterContext) → CollectionRowView`, pure, no
React, no fetch. `ctx` carries density, view-mode, the connection-summary map (batch-fetched
upstream), and per-kind callbacks (delete/retry/follow) that flow into `actions`. The `media`
presenter is the template: `lead` from `ResourceThumb` spec, `headline` = title, `signals` =
`[publisher, published_date]`, `consumption` from derived read-state, `status` from processing
state, `connections` from the summary map, `contributors` `maxVisible` from density, `actions` =
`mediaResourceOptions(...)`. Search keeps `SearchResultRowViewModel` but maps into
`CollectionRowView` (segments → `headline.segments`).

Complex row-local controls stay pane-owned. The podcast episode transcript reason form,
show-notes expansion, and library membership panel are not presenter JSX; presenters expose the
affordance/action metadata, while the pane controller supplies `rowPanels`/`expandedControls`
keyed by row id to `CollectionView`.

### `CollectionView` / `CollectionRow`

`CollectionView` props: `{ rows: CollectionRowView[]; view: "list" | "gallery"; density;
lanes?: Lane[]; toolbar?: ReactNode; state?: AsyncState; empty?: ReactNode; footer?: ReactNode;
rowPanels?: Record<string, ReactNode>; expandedControls?: Record<string, ReactNode>;
onActivateRow? }`. Owns the toolbar slot, keyboard composite, reflow View-Transition, lane
section headers, and empty/loading/error via `PaneSurface`. `CollectionRow` maps one view-model
to `ResourceRow` (list) or `CollectionGalleryCard` (gallery), and owns the connection-rail
expansion, the read-state/progress badge, optional pane-owned row panels, and `useRowSwipe`.

### Backend contracts (additive, no migration)

```
POST /resource-graph/connections/summary
  req:  { refs: string[] (≤200), origins?: EdgeOrigin[] }     # default LIST_CONNECTION_ORIGINS
  res:  { summaries: ConnectionSummaryOut[] }
        ConnectionSummaryOut { ref, total, by_kind, last_connected_at, dominant_kind,
                               top_peers: ConnectionEndpointOut[] }   # peers carry label+href

GET  /media/{id}/related?limit=N
  res:  { peers: ConnectionEndpointOut[] }   # chunk-embedding NN (existing content_embeddings) ∪ shared-author

GET  /libraries/{id}/entries?sort=resonance
  res:  existing LibraryEntryOut[] ordered by deterministic score
        + per-entry surfaced_today: bool, last_engaged_at, read_state, progress_fraction

MediaOut += read_state: "unread"|"in_progress"|"finished"|None,
            progress_fraction: float|None, last_engaged_at: datetime|None   # derived post-hoc
```

`LIST_CONNECTION_ORIGINS = ("user", "citation", "note_body", "highlight_note")` — declared like
`READER_CONNECTION_ORIGINS` (`services/reader_connections.py:37`), but intentionally narrower;
it excludes `synapse` (AI) and `system` (plumbing). Resonance score = weighted sum of
recency-decay(`GREATEST(added_at,
last_connected_at, last_engaged_at, published_at)`), `log1p(connection_count)`,
`shared_author_hits`, and bounded nearest-neighbor similarity over existing active
`content_embeddings`; rows without embeddings contribute zero for similarity. This is SQL/vector
math only, with no request-time LLM. `surfaced_today` =
`GREATEST(...) >= start_of_today(viewer_tz)`.

## API Design Principles

- **Presenters return data; components render chrome.** The only React/JSX a presenter emits is
  `headline.segments` (intrinsic to the text). Everything else is structured data.
- **Slot-based primitive, data-driven layer above it.** `ResourceRow` never learns about kinds;
  `CollectionRow` never owns DOM chrome.
- **One discriminated view-model, exhaustively matched.** `CollectionItemKind` dispatch,
  `consumption.status`, and domain status maps are finite unions, not ad hoc strings.
- **Batch the graph reads.** One `/connections/summary` call per visible page (≤200 refs), not
  one per row.
- **Default-deny per surface.** Every connection read declares its origin allowlist explicitly.
- **URL is the state.** View/density/sort/filter are a value-object serialized to the pane href.
- **Derive, don't duplicate.** Read-state reads the authoritative resume/listening tables.

## Composition With Other Systems

- **Workspace / pane runtime.** Panes stay `React.lazy` (`paneRenderRegistry.tsx`); list/gallery/
  virtualization/keyboard/swipe code lives in the pane body, off First Load JS. View/density/sort
  state uses `usePaneSearchParams` + `paneRouter.replace` (per-pane href), so split layouts keep
  independent view-modes for free.
- **Hydration.** `useResource` keys + consume-once hydration unchanged; CT-1's
  `useCursorPagination` consumes page 1 from `useResource` and appends thereafter (AC-4 tests
  preserved).
- **Search / Browse.** `SearchResultRowViewModel` and `browseState.ts` helpers become the
  search/browse presenters; the search round-trip invariant (`searchHref` ⇆ `SearchQuery`) is
  untouched — `CollectionView` is a rendering change, not a query change.
- **Sortable lists.** Library manual reorder routes through `CollectionView`'s sortable mode;
  `SortableList` remains the dnd owner, renders rows through `ResourceList` when requested, and
  keeps the drag handle in pane-supplied row controls. Reorder optimism unchanged.
- **Resource graph.** Connection summaries stay inside the graph owner, aggregate from
  `resource_edges`, and reuse endpoint hydration / `ConnectionEndpointOut` so peers carry live
  label+href with no per-peer frontend round trip. The reader Document Map connections lens is
  unchanged; the list uses the non-anchored summary path.
- **Reader.** Read-state derives from `reader_media_state` (docs) and `podcast_listening_states`
  (audio); opening a row morphs into the reader via the View Transitions API (same-document
  `startViewTransition`).
- **CSS tokens / motion.** All visuals use semantic tokens; motion uses `--ease-*`/`--duration-*`;
  reduced-motion is auto-handled for token-driven CSS, with an explicit guard added for
  View-Transition pseudo-elements (outside the token cascade).
- **CSP / bundle.** `content-visibility` (CSS), View Transitions (`style-src 'unsafe-inline'`
  covers inline `view-transition-name`; `script-src` nonce untouched), proxy images (`img-src
  'self' data:`), and pointer-event swipe add **zero** dependencies and stay under 115 kB gz.

## Key Decisions

1. **A presenter layer above a dumb `ResourceRow`, not a richer `ResourceRow`.** Keeps the
   primitive domain-free (preserving the pane-surface-kit boundary + tests) while giving per-kind
   logic one owner. `resourceActions.ts` and `SearchResultRowViewModel` already prove the shape.
2. **Editorial borderless aesthetic over the card box.** NN/g: typographic lists beat card grids
   for scanning/comparing homogeneous items; the box is the generic "AI-default" tell. Gallery is
   the deliberate secondary mode for visual browsing, never the list default.
3. **Connections in v1 are deterministic provenance edges only; synapse excluded.** Honors "leave
   AI out for v1 / no generated reasons." `LIST_CONNECTION_ORIGINS` omits `synapse`. Synapse
   becomes a labeled "Suggestions" lane in a later version (provenance discipline).
4. **Read-state derived; no migration.** `reader_media_state.locator.total_progression` and
   `podcast_listening_states.is_completed`/`position_ms` are authoritative today; deriving
   `MediaOut.read_state` is schema+service only. Documented caveat: documents have no explicit
   "opened" event, so `unread` means "no committed scroll position." The unified `consumption_state`
   table (true `last_opened_at`, folds in listening-state, + `highlights(user_id, anchor_media_id)`
   index for engagement counts) is the v2 follow-up.
5. **CSS-native `content-visibility`, not a virtualizer.** Zero JS/bundle, keeps native focus +
   in-page-find; arrow-nav uses `scrollIntoView({block:"nearest"})` to reveal. Revisit only at
   10k-row lists, and then inside the lazy pane body.
6. **Native View Transitions for reflow + grid→reader morph.** CSP-safe, zero bundle, graceful
   (`document.startViewTransition?.()`); explicit reduced-motion guard for VT pseudo-elements.
7. **Pointer-event swipe hook, no gesture library.** Adapts the `MobileSheet` recipe
   (`setPointerCapture` + direct `transform` write + threshold); swipe is never the only path to
   an action.
8. **View/density/sort/filter as a URL value-object.** Mirrors `searchParams.ts`; deep-linkable,
   per-pane-scoped, pane back/forward for free.
9. **One icon map.** `RESOURCE_SCHEME_ICONS` (`resourceKind.ts`) wins; the local
   `MEDIA_KIND_ICONS` in `LibraryPaneBody` is deleted.
10. **`ItemCard` stays for reader sidecars; its guard + clamp are extracted.**
    `isNestedInteractiveTarget` + `useClampWithToggle` become shared; `ResourceRow` finally gets
    the guard the original spec promised but never implemented.

## Migration Plan

### S0 — Aesthetic + shared atoms/hooks (foundation, no behavior cut yet)

Files: `ResourceRow.tsx` + `.module.css` (Editorial anatomy, guard, reveal-on-hover, density);
`ResourceList.tsx` + `.module.css` (composite nav, `content-visibility`, data-attrs);
new `components/ui/{ResourceThumb,PaneToolbar,LoadMoreFooter,SortSelect}`; new
`lib/ui/{useCollectionKeyboard,typeAhead,useRowSwipe,useOptimisticAction,isNestedInteractiveTarget,
useClampWithToggle,useDebouncedValue}`; `lib/api/{useCursorPagination,usePaneUrlState}`;
`lib/status/*`; `lib/display/format.ts` (+ `formatRelativeTime`, day-grouping).
Work: build the primitive rewrite + atoms with screenshot/browser tests; extract `ItemCard`'s
guard + clamp into the shared hooks and re-point `ItemCard` at them (no behavior change).
Acceptance for S0: typecheck/lint/css-tokens green; `ResourceRow`/`ItemCard` browser snapshots
updated; `make check-bundle` ≤ 115 kB; no pane migrated yet.

### S1 — Presenter layer + `CollectionView`/`CollectionRow`

Files: `lib/collections/types.ts`, `lib/collections/collectionViewState.ts`,
`lib/collections/presenters/*` (10), `components/collections/{CollectionView,CollectionRow,
CollectionGalleryCard,ConnectionRail,ReadStateBadge}` (+ css).
Work: define `CollectionRowView`; implement presenters against current domain types (read-state/
connections fields optional, populated in S3–S4); `CollectionView` list+gallery+density+keyboard+
reflow+states; unit-test each presenter (pure), browser-test `CollectionView`.
Acceptance for S1: presenter unit suite green; `CollectionView` browser tests (list+gallery+
keyboard+empty/loading/error) green; still no pane cut over.

### S2 — Rendering hard cutover (all row surfaces) ⟵ load-bearing

Files: all row-shaped pane bodies/adapters in § Current Duplication Inventory; delete bespoke
CSS (`.mediaStatus`, `.syncBadge`, `.typeBadge`, duplicate `.artwork`/`.fallback`,
`.searchForm` copies); delete local `MEDIA_KIND_ICONS`; route pagination →
`useCursorPagination` (CT-1), busy → `useOptimisticAction` (CT-2), status → `lib/status/*`
(CT-3), states → `PaneSurface`-derived (CT-4), toolbars → `PaneToolbar` + `usePaneUrlState`
(CT-5), thumbs → `ResourceThumb` (CT-5b).
Work: each pane becomes fetch + presenter + `CollectionView`; library entries keep `SortableList`.
Acceptance for S2: every row-shaped list renders via `CollectionView`; direct `<ResourceRow>`
usage exists only inside `components/collections/*` and `components/ui/ResourceRow.tsx`; source
gates (below) pass; FE unit + browser suites green; bundle ≤ 115 kB; e2e/CSP green.

### S3 — Derived read-state + progress + "Surfaced today" recency

Files (BE): `services/media.py` derivation, `schemas/media.py` (`MediaOut` fields),
`services/library_entries` (`surfaced_today`, `last_engaged_at`, `sort` branch). Files (FE):
`ReadStateBadge`/progress wiring in `CollectionRow`; `media` presenter `consumption`; recency
lane in `CollectionView`.
Work: derive read-state (docs from `reader_media_state`, audio from `podcast_listening_states`);
expose recency timestamps; "Surfaced today" lane on the library; document the no-explicit-open
caveat in code + this doc.
Acceptance for S3: BE `ruff`/`pyright`/`test-back-integration` green; read-state shows correctly
for a read doc, an in-progress episode, and an unopened item; `GET /libraries/{id}/entries`
still defaults to position order; the surfaced-today lane orders deterministically.

### S4 — Connection summaries in-row

Files (BE): `services/resource_graph/connection_summaries.py`, `schemas/resource_graph.py`
(`ConnectionSummaryOut`), `api/routes/resource_graph.py` (`/connections/summary`),
`LIST_CONNECTION_ORIGINS`. Files (FE): `app/api/resource-graph/connections/summary/route.ts`,
`lib/api/connections.ts` or `lib/resourceGraph/connections.ts`, batch fetch in panes, presenter
`connections`, `ConnectionRail` expansion, and `app/api/proxy-routes.test.ts` route count.
Work: one aggregate query grouped by ref + top-peers hydrated through graph resolve/activation
helpers; batch per visible page; "↳ N connected" trailing affordance + rail of peer chips
(label+link+edge tone), no generated text.
Acceptance for S4: BE green; a media row with edges shows the count + rail; deleted/forbidden
peers render `missing` (not leaked); synapse edges absent from the surface; BFF proxy route count
and frontend graph client tests updated.

### S5 — Related (similarity + shared-author) + Resonance ordering

Files (BE): `services/media_related.py` + `api/routes/media.py` `GET /media/{id}/related`
(embedding NN over the target media's existing `content_embeddings` rows +
`contributor_credits` shared-author join), `?sort=resonance` on entries. Files (FE):
`app/api/media/[id]/related/route.ts`, frontend media client, presenter `related`, "Related"
affordance, Resonance sort option in the library toolbar, and `app/api/proxy-routes.test.ts`
route count.
Work: the one new SQL shape is media-owner-seeded chunk NN (existing helper is query-vector
seeded); the resonance score includes a low-weight nearest-neighbor similarity term from existing
active `content_embeddings` rows and contributes zero when no embedding exists, preserving the
no-migration claim; shared-author uses the existing `contributor_credits` rollup/join patterns.
Acceptance for S5: BE green; `/related` returns deterministic peers with no request-time LLM call
(assert no provider call in test); resonance ordering stable for identical input; default library
entry order remains `_ENTRY_ORDER` when `sort` is omitted.

### S6 — Motion + mobile swipe polish

Files (FE): View-Transition grid→reader morph + reflow guards; `useRowSwipe` wired into
`CollectionRow` mobile composition.
Work: `startViewTransition` around list→reader and filter/sort; reduced-motion guard for VT
pseudo-elements; swipe-to-action on mobile rows with menu/keyboard parity.
Acceptance for S6: morph + reflow degrade gracefully and respect reduced-motion; swipe works on a
touch device profile; bundle ≤ 115 kB; e2e/CSP green.

## Final File Set

New (FE): `lib/collections/{types,collectionViewState}.ts`, `lib/collections/presenters/{media,
podcast,episode,library,contributor,note,conversation,search,browse,settings}.ts`,
`components/collections/{CollectionView,CollectionRow,CollectionGalleryCard,ConnectionRail,
ReadStateBadge}.tsx`(+css), `components/ui/{ResourceThumb,PaneToolbar,LoadMoreFooter,SortSelect}.tsx`(+css),
`lib/ui/{useCollectionKeyboard,typeAhead,useRowSwipe,useOptimisticAction,isNestedInteractiveTarget,
useClampWithToggle,useDebouncedValue}.ts`, `lib/api/{useCursorPagination,usePaneUrlState,connections}.ts`,
`lib/status/*`.
New (BE): `services/resource_graph/connection_summaries.py`, `services/media_related.py`,
resonance service code, schema + route additions (above). No migration.
Migrated: `ResourceRow.*`, `ResourceList.*`, every row-shaped pane body/adapter in the current
inventory, `resourceActions.ts` (consumed by presenters), `lib/display/format.ts`, `ItemCard.*`
(re-points to extracted hooks), `MediaOut`, `LibraryEntryOut`, and the Next BFF proxy route
manifest/count.
Deleted/folded: per-pane bespoke chip CSS (`.mediaStatus`/`.syncBadge`/`.typeBadge`), duplicate
`.artwork`/`.fallback`, local `MEDIA_KIND_ICONS`, the migrated cursor/debounce/busy
boilerplate now owned by `useCursorPagination`, `useDebouncedValue`, `usePaneUrlState`,
and `useOptimisticAction`, and all inline slot-mapping.

## Acceptance Criteria

### Product Behavior

- **AC-1** Every row-shaped list surface renders through `CollectionView`; no pane builds
  `ResourceRow` slots inline. The legacy `SearchResultRow` component is deleted; search
  maps `SearchResultRowViewModel` through the `search_result` presenter.
- **AC-2** A media row leads with its headline fact and shows read-state + progress + "↳ N
  connected" at rest; a podcast leads with unplayed count; a search hit leads with the matching
  snippet; an author leads with presence.
- **AC-3** List ⟷ Gallery and comfortable/compact toggles work, persist in the pane URL, and
  default to the Editorial list.
- **AC-4** Arrow/Home/End + type-ahead navigate the list (single tab stop); Enter opens; large
  lists scroll smoothly; reduced-motion disables reflow/morph.
- **AC-5** Expanding a media row shows deterministic peers (label + link + edge tone) with no
  generated text; no synapse edges appear; deleted/forbidden peers render as missing.
- **AC-6** A library offers "Surfaced today" + "Resonance" ordering, deterministic and stable for
  identical input; the existing default entry order remains position-based.
- **AC-7** Mobile rows expose swipe-to-action; the same actions exist in the overflow menu and via
  keyboard.

### Architecture

- **AC-8** `ResourceRow`/`ResourceList` import no workspace, pane runtime, API client, or pane
  body (boundary preserved).
- **AC-9** Presenters are pure (no React import, no fetch) and exhaustively match
  `CollectionItemKind`.
- **AC-10** CT-1…CT-9 consolidations landed; the listed bespoke CSS, the local icon map, and the
  per-pane boilerplate are deleted (net line reduction).
- **AC-11** No request-time LLM call on any collection path (asserted in S5 test); no new
  dependency; `make check-bundle` ≤ 115 kB gz; `lint:css-tokens` clean.
- **AC-12** New backend routes have matching Next proxy routes, frontend client tests, and the
  explicit `API_ROUTE_COUNT` guard updated in `apps/web/src/app/api/proxy-routes.test.ts`.

### Source Gates

```bash
# no pane builds ResourceRow slots inline (presenters only)
if rg -n "<ResourceRow" apps/web/src/app apps/web/src/components \
  --glob '!**/*.test.*' \
  --glob '!apps/web/src/components/collections/**' \
  --glob '!apps/web/src/components/ui/ResourceRow.tsx'; then
  echo "FAIL: inline rows remain"
  exit 1
fi
# bespoke status chip CSS deleted
if rg -n "mediaStatus|syncBadge|typeBadge" apps/web/src --glob '!**/*.test.*'; then
  echo "FAIL: bespoke status CSS remains"
  exit 1
fi
# duplicate icon map deleted
if rg -n "MEDIA_KIND_ICONS" apps/web/src --glob '!**/*.test.*'; then
  echo "FAIL: local icon map remains"
  exit 1
fi
# new proxy routes are counted and proxy-only
(cd apps/web && bun run test:unit -- src/app/api/proxy-routes.test.ts)
# synapse excluded from list connections
if ! rg -n "LIST_CONNECTION_ORIGINS" python/nexus/services/resource_graph/connection_summaries.py; then
  echo "FAIL: LIST_CONNECTION_ORIGINS missing"
  exit 1
fi
if rg -n "LIST_CONNECTION_ORIGINS.*synapse|synapse.*LIST_CONNECTION_ORIGINS" python/nexus/services/resource_graph/connection_summaries.py; then
  echo "FAIL: LIST_CONNECTION_ORIGINS includes synapse"
  exit 1
fi
# presenters pure
if rg -n "from \"react\"|from 'react'|useState|useEffect|JSX\\." apps/web/src/lib/collections/presenters; then
  echo "FAIL: impure presenter"
  exit 1
fi
if rg -n "@/lib/collections/useConnectionSummaries" apps/web/src/lib/collections/presenters; then
  echo "FAIL: presenter imports client connection hook module"
  exit 1
fi
```

### Verification Commands

```bash
cd apps/web && bun run typecheck
cd apps/web && bun run lint
cd apps/web && bun run lint:css-tokens
cd apps/web && bun run test:unit
cd apps/web && bun run test:browser
PATH=/home/niels/.bun/bin:$PATH make check-bundle
make check-back
make type-back
PATH=/home/niels/.bun/bin:$PATH make test-back-integration
PATH=/home/niels/.bun/bin:$PATH make test-e2e
PATH=/home/niels/.bun/bin:$PATH make test-csp
```

## Risks And Controls

- **Risk: the rendering cutover (S2) is large and atomic.** Control: S0/S1 land the primitive +
  layer behind tests first; S2 migrates pane-by-pane within the slice with the source gates failing
  the build if any inline row remains.
- **Risk: `content-visibility` mis-estimates variable row heights → scroll jump.** Control:
  per-view-mode `contain-intrinsic-size: auto <est>`; the browser remembers real sizes after first
  paint; arrow-nav `scrollIntoView({block:"nearest"})`.
- **Risk: View-Transition pseudo-elements ignore the token-zeroed reduced-motion.** Control:
  explicit `@media (prefers-reduced-motion: reduce)` rule on `::view-transition-*` + skip
  `startViewTransition` when reduced.
- **Risk: per-row connection fetch N+1.** Control: one batch `/connections/summary` per visible
  page (≤200 refs); peers carry label+href so no per-peer round trip.
- **Risk: derived read-state misreads "opened but untouched" docs as unread.** Control: documented
  caveat in code + this doc; v2 `consumption_state` adds a true opened event (N6).
- **Risk: bundle creep from new atoms.** Control: list/gallery/swipe/keyboard code lives in lazy
  pane bodies; `make check-bundle` gates every slice; no new dependency.
- **Risk: swipe-only actions break keyboard/desktop.** Control: AC-7 requires menu + keyboard
  parity; swipe is additive.

## Definition Of Done

- [x] S0–S6 landed; each slice's acceptance met; source gates green.
- [x] Every row-shaped list surface renders through `CollectionView`; inline slot-mapping deleted.
- [x] Editorial list + Gallery + density shipped; keyboard composite + type-ahead; reflow + morph
      with reduced-motion guards; mobile swipe with parity.
- [x] Read-state + progress + "Surfaced today" + Resonance live; no migration shipped.
- [x] Connection summaries + related peers live; deterministic; AI-free (no request-time LLM);
      synapse excluded.
- [x] CT-1…CT-9 consolidated; bespoke CSS + duplicate icon map + per-pane boilerplate deleted.
- [x] typecheck/lint/css-tokens/bundle green; FE unit+browser green; BE ruff/pyright/integration
      green; BFF proxy route-count guard green; e2e/csp status noted.
- [x] v2 follow-ups recorded: `consumption_state` table + true opened-event + highlight-count
      index; synapse "Suggestions" lane; Shortlist; Peek.
