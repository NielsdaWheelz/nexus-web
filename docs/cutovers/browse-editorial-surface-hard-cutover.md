# Browse Editorial Surface Hard Cutover

**Status:** IMPLEMENTED LOCALLY · FOCUSED VERIFIED · 2026-08-02
**Type:** Hard cutover — no legacy path, fallback, compatibility shim, dual
renderer, feature flag, or partial migration
**Scope:** One-user production-shaped prototype; smallest coherent visual and
composition repair

Follow [`docs/rules/`](../rules/index.md) and
[`docs/local-rules/`](../local-rules/index.md), especially cleanliness,
simplicity, boundaries, frontend, codebase, and testing.

This document supersedes only the pane grammar, top-level section presentation,
optional-result-thumbnail sentence, and affected frontend proof in
[`browse-discovery-preview-acquisition-hard-cutover.md`](browse-discovery-preview-acquisition-hard-cutover.md).
Its URL, retrieval, provider, memento, Preview, and acquisition contracts remain
authoritative.

No blocking product question remains. The decisions below are locked.

## Decision

Make Browse a quiet editorial acquisition desk built from the standard pane
kit:

```text
committed URL query
  -> fixed five-chapter / eight-source plan
  -> independent read-only source controllers
  -> canonical collection rows
  -> no-write Preview
  -> explicit Add / Subscribe
  -> canonical owned pane
```

The architecture is unchanged above and below the pane body. This cut repairs
leaf composition, visual hierarchy, validation, token correctness, and proof.

**Product principle:** Browse is reversible; acquisition is deliberate.

## Goals

1. Every Browse and Browse Preview state uses `PaneSurface`.
2. One query presents one visible, stable result story.
3. All renders five quiet kind chapters and eight independently truthful source
   blocks without comparing provider scores.
4. Search, validation, focus, facets, and touch behavior use existing controls
   and contracts.
5. Collection results retain the sole canonical row anatomy.
6. Repeated Browse plan data has one pure owner.
7. Static and real-Chromium proof prevents the current composition drift.
8. The cut deletes every superseded root, card wrapper, style, mock seam, stale
   guard comment, and duplicate plan declaration.

## Non-goals

- No backend, BFF, API, wire schema, database, migration, provider, cache,
  ranking, pagination, acquisition, player, or worker change.
- No workspace store, route model, pane runtime, navigation, history, memento,
  View Transition, Follow/Fork, or scroll-policy change.
- No recommendation feed, saved search, semantic mode, agent, analytics, result
  warehouse, generic federation DSL, or cross-provider reranking.
- No result thumbnail, cover/poster column, description row, card/grid/gallery,
  density, layout switch, badge cloud, or standing row action.
- No speculative facet, autocomplete, per-keystroke retrieval, virtualization,
  sticky toolbar, animation system, or design-system primitive.
- No repo-wide test, CSS, or pane migration beyond the exact guards and token
  defect class named here.

Rich imagery, description, media, provenance, and commitment controls remain in
Preview. Result rows follow the canonical rule: one stable anatomy, details on
demand.

## Final ownership

| Concern | Owner | Change |
| --- | --- | --- |
| Pane frame, chrome, scroll, history, memento | workspace / pane runtime | None |
| Standard body spacing and slots | `PaneSurface` | Browse and Preview adopt it |
| Draft query control | `BrowsePaneBody` + canonical `Input` | Repair |
| URL decode/encode | `lib/browse/query.ts` | Preserve |
| Kind/source applicability and render/request plan | `lib/browse/plan.ts` | One new pure owner |
| Concurrency and source request lifecycle | request gate + `BrowseSection` | Preserve |
| Source heading/state/continuation presentation | `BrowseSection` | Replace `PaneSection` shell |
| List and row semantics | `CollectionView -> CollectionRow -> ResourceRow` | Preserve |
| Preview retrieval and presentation | `BrowsePreviewPaneBody` | Adopt `PaneSurface` only |
| Add / Subscribe | existing canonical acquisition owners | Preserve |
| Theme values | `app/globals.css` | Reuse only |

## Capability contract

### Browse plan

Create `apps/web/src/lib/browse/plan.ts` as a pure, browser-safe module. It owns:

```ts
const BROWSE_KINDS: readonly ["All", ...BrowseKind[]];
const BROWSE_SOURCES: readonly BrowseSource[];
type BrowseQueryKind = "All" | BrowseKind;
type BrowseQuerySource = BrowseSource;
type BrowseQuerySort = BrowseSort;

interface BrowsePlanSelection {
  readonly kind: BrowseQueryKind;
  readonly source: BrowseQuerySource | null;
  readonly sort: BrowseQuerySort;
}

interface BrowseSectionIdentity {
  readonly kind: BrowseKind;
  readonly source: BrowseSource;
  readonly sort: BrowseSort;
}

interface BrowseResultChapter {
  readonly kind: BrowseKind;
  readonly sections: readonly BrowseSectionIdentity[];
}

const BROWSE_SECTION_PLAN: readonly BrowseSectionIdentity[];
function browseSourcesForKind(kind: BrowseQueryKind): readonly BrowseQuerySource[];
function browseResultChapters(
  selection: BrowsePlanSelection,
): readonly BrowseResultChapter[];
function browseSectionKey(identity: BrowseSectionIdentity): string;
```

`BROWSE_KINDS`, `BROWSE_SOURCES`, and their query types move here. `query.ts`
imports applicability from this owner but remains the sole URL codec.
`BrowseSectionIdentity`, the fixed eight-section constant, source applicability,
visible-section filtering, and section-key construction have no second
declaration.

The fixed All plan remains, in order:

1. PDF — Nexus
2. EPUB — Nexus, Project Gutenberg
3. Web Article — Nexus, Brave
4. Video — Nexus, YouTube
5. Podcast — Podcast Index

Grouping changes only DOM composition. It does not alter request identity,
start order, maximum concurrency `3`, cursor, score, retry, failure, or memento
state. Chapters and source blocks never reorder as requests settle.

### Browse surface

`BrowsePaneBody` renders exactly one `PaneSurface`:

| Slot | Content |
| --- | --- |
| `opener` | Existing `SectionOpener` heading and standfirst |
| `toolbar` | Search form, Kind group, applicable Source group, supported Sort group |
| `state` | Visible run summary for a non-empty committed query |
| `empty` | Quiet prompt for a valid empty query |
| children | Applicable kind chapters containing source blocks; five for All |

_Superseded by
[`canonical-pane-title-ownership-hard-cutover.md`](canonical-pane-title-ownership-hard-cutover.md):
`PaneSurface.opener` and `SectionOpener` are deleted. Browse's heading is the
canonical pane title in chrome and its standfirst moved to `PaneSurface.brief`._

An Invalid external URL renders `PaneSurface(state)` with the existing
warning and **Reset Browse**. It renders no toolbar, children, or provider
controller.

The search form uses canonical `Input` with `type="search"`, `size="md"`, and
`maxLength={200}`. It is not an ARIA combobox: Browse has no suggestions and
retrieves only on explicit submit.

Draft rules:

- `""` is valid local draft state; submission removes `q`.
- Submit trims and NFC-normalizes once through existing helpers.
- A non-empty invalid draft retains its text, performs no navigation or
  provider call, sets `aria-invalid`, focuses the input, and exposes visible
  associated help: **Use 1–200 characters without control characters.**
- Changing a facet preserves current URL rewrite and dependent-default rules.
- Empty Browse focuses the input and performs no provider call.

Kind, Source, and Sort remain labelled `aria-pressed` button groups. Canonical
small pill styling remains on fine pointers. On coarse pointers or compact
widths, controls have `min-height: 2.75rem`; no desktop density preference is
introduced.

### Result story

For a committed query, derive one summary from the existing section snapshots:

```ts
interface BrowseRunSummary {
  readonly surfaced: number;
  readonly settledSources: number;
  readonly sourceCount: number;
  readonly failedSources: number;
}
```

Render concise text such as:

```text
31 surfaced · 6 of 8 sources settled · 1 unavailable
```

Rules:

- Say **surfaced**, never total; pagination and provider coverage are partial.
- Omit zero-valued failure text.
- The summary has no global Retry and does not replace source-local state.
- Preserve two polite live announcements: first usable result and final settle.
  Do not announce every snapshot change.
- Visual and announced settled text come from the same derivation.

Each chapter is a semantic `<section>` with a kind heading. Each provider is a
source block with a subordinate heading, restrained divider/spacing, its own
loading/empty/failure state, canonical list, Retry, and continuation.

`BrowseSection` no longer imports or renders `PaneSection`. It continues to own
fetch, decode, pagination, restoration, controller publication, error mapping,
and `CollectionView surface={false}`. There is no border, radius, card
background, provider badge, or fake result row around a source.

### Preview surface

All valid, invalid, loading, failed, media, and Podcast Preview states start at
`PaneSurface`. Existing Preview lead image, copy, source action, media frame,
Podcast sections, episode `CollectionView`, and `AcquisitionControl` compose
inside its slots or children.

`PaneSection` remains allowed only for a genuine nested framed subsection. Do
not replace domain controllers or alter Preview fetch/acquisition behavior.

Successful Add/Subscribe still replaces Preview with the canonical pane. Open,
play, load, Back, and Preview remain non-acquiring.

### API and schema posture

There is no new HTTP API, command, endpoint, payload field, persisted schema,
cache record, or durable state. `plan.ts` is an internal pure capability; export
only the constants, types, and functions listed above. `BrowseRunSummary` is
derived render state and is neither exported nor stored in the pane memento.
Existing transport decoders and command inputs remain exact and unchanged.

### Tokens and CSS

- Replace Browse `--text-secondary` with `--ink-muted`.
- Replace Acquisition `--accent-contrast` and `--focus` with
  `--ink-on-accent` and `--ring`.
- Reuse `PaneSurface` padding/gaps and `Input` chrome; delete duplicate root,
  preview-root, input-width-only, card, padding, and obsolete responsive rules.
- Browse CSS owns only chapter/source hierarchy, toolbar arrangement, summary,
  continuation, Preview domain layout, and coarse-pointer adaptation.
- Add no raw color literal, shadow, type scale, radius, timing, or theme token.

Extend `scripts/check-css-tokens.mjs` to reject a `var(--name)` reference with no
CSS declaration in the scanned source set and no inline fallback. If runtime-
injected properties exist, enumerate only verified owners explicitly; do not
silently accept arbitrary unknown names. The existing raw-color check remains.

## Files

### Add

- `apps/web/src/lib/browse/plan.ts`

### Modify

- `apps/web/src/app/(authenticated)/browse/BrowsePaneBody.tsx`
- `apps/web/src/app/(authenticated)/browse/preview/BrowsePreviewPaneBody.tsx`
- `apps/web/src/app/(authenticated)/browse/browse.module.css`
- `apps/web/src/components/browse/BrowseSection.tsx`
- `apps/web/src/components/browse/AcquisitionControl.module.css`
- `apps/web/src/lib/browse/query.ts`
- `apps/web/scripts/check-css-tokens.mjs`
- `apps/web/src/lib/ui/paneSurfaceCutover.guards.test.ts`
- `apps/web/src/components/collections/canonicalCollectionRow.guards.test.ts`
- `apps/web/src/app/(authenticated)/browse/BrowsePaneBody.test.tsx`
- `apps/web/src/app/(authenticated)/browse/preview/BrowsePreviewPaneBody.test.tsx`
- `apps/web/src/components/browse/BrowseSection.test.tsx`

### Scope-proven owner repairs

- `lib/browse/contract.ts` owned the second `BROWSE_KINDS` / `BROWSE_SOURCES`
  declarations prohibited by the single-plan-owner criterion.
- `PodcastOverview.module.css`, `EvidencePaneSurface.module.css`,
  `ResourceSurfaceBodyEditor.module.css`, and `WalknoteReviewPanel.module.css`
  contained every remaining undeclared `var()` reference exposed by the new
  strict global gate. Their cut is semantic-token replacement only; selectors
  and layout do not change.

### Delete

- Superseded Browse/Preview root and provider-card CSS rules
- Duplicate plan constants/helpers/types in `BrowsePaneBody`, `query.ts`, and
  `BrowseSection`
- Internal React collaborator mocks in affected Browse tests
- Stale guard comments and assumptions that Browse is deleted
- Any import, export, helper, or style made unreachable by this cut

Do not modify files outside this list without first proving that they own a
named acceptance criterion below.

## Proof strategy

Use static gates for mechanically decidable architecture and real Chromium for
layout, semantics, focus, and navigation. Tests retain owned React collaborators
and stub external HTTP at `fetch`; they do not mock `BrowseSection`,
`CollectionView`, `PaneSurface`, `PaneSection`, or the Browse client.

Required focused scenarios:

1. Valid empty Browse: canonical control, field focus, no fetch.
2. Invalid external URL: standard surface, Reset, no fetch.
3. Invalid human draft: visible associated help, retained text, focused input,
   no navigation/fetch.
4. All query with staggered success, empty, and failure responses: fixed five
   chapters/eight sources, truthful visible summary, independent Retry, no DOM
   reorder.
5. Single kind/source and Video+YouTube sort: exact applicable controls and
   request identities.
6. Continuation: suffix append and summary update without calling the count a
   total.
7. Back from Preview: exact pages/cursors/scroll/focus restore without refetch;
   restored Pending remains **Search paused** until explicit Retry.
8. Follow, Fork, keyboard activation, and native modifiers retain existing
   ownership.
9. Preview Add/Subscribe still requires explicit commitment and replaces the
   Preview pane only on success.

Static gates enforce:

- Browse and Preview are named standard `PaneSurface` bodies.
- Browse is a named canonical `CollectionView` caller.
- Browse has no alternate row mode, imagery, raw `<input>`, or top-level
  `PaneSection` provider wrapper.
- Plan data and source applicability have one owner.
- Unknown custom properties fail token lint.

Before merge, review selected screenshots at 320–360px and ordinary desktop
pane width in light and dark themes, with long titles, dense results, empty
sources, and multiple failures. Preserve existing CSP and real-media acquisition
journeys as cross-boundary proof; they do not substitute for browser-component
visual proof.

## Acceptance criteria

- [x] One standard `PaneSurface` renders every Browse and Preview state.
- [x] Search uses canonical `Input`; draft and URL limits agree at 200 code
  points and invalid submission is actionable.
- [x] All presents five stable chapters and eight independently controlled
  source blocks without provider cards or score merging.
- [x] A visible summary truthfully reports surfaced/settled/failed state and
  shares its derivation with settled announcements.
- [x] Canonical collection rows remain mode-free, image-free, and action-free
  at rest; rich detail remains in Preview.
- [x] URL identity, concurrency `3`, independent retry/pagination, memento,
  no-refetch Back, and explicit acquisition are unchanged.
- [x] Compact/coarse-pointer facet controls meet the 2.75rem target contract;
  keyboard focus is visible and unobscured.
- [x] Undefined Browse/Acquisition variables are removed and unknown CSS
  variables fail the token gate.
- [x] Source guards name Browse/Preview and contain no stale deletion claim.
- [x] Affected tests use production-shaped owned composition with fetch-boundary
  fixtures and demonstrated sensitivity for repaired defects.
- [x] Superseded CSS, duplicate plan declarations, mocks, comments, imports,
  exports, and unreachable code are deleted in the same cut.
- [x] No file or behavior outside Scope changes.

Rollback is revert of the cutover commit. There is no runtime rollback path.
