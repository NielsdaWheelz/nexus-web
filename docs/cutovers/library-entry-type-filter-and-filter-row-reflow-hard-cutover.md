# Library Entry Type Filter + FilterRows Reflow Hard Cutover

> **Podcast container-first All update (2026-08-02):**
> [`podcast-container-first-all-hard-cutover.md`](podcast-container-first-all-hard-cutover.md)
> makes exact type filtering consume Default/All's root-subsumed inventory.
> `podcast` returns active subscription containers; `podcast_episode` excludes
> their child episodes while the subscription remains active.

**Status:** IMPLEMENTED AND VERIFIED · 2026-08-02
**Type:** Hard cutover — one final path; no feature flag, legacy URL alias,
fallback parser, dual filter, compatibility branch, or mixed layout policy
**Scope:** One-user production-shaped prototype; 80/20 slice only

Follow `docs/rules/`, `docs/local-rules/`, and `docs/modules/library.md`.
No blocking product question remains. Decisions below are locked.

This specification supersedes only:

- the one-line/local-inline-overflow rule for `FilterRows` in
  `pane-chrome-frame-hard-cutover.md`;
- the prior collection cutover's no-new-domain-filter scope boundary; and
- Library view contracts that omit entry type.

`FindOccurrences` and reader instruments retain their current single-line
behavior.

## Decision

Add one URL/API/cursor-owned **Type** facet to Library detail entries and make
shared `FilterRows` chrome reflow without horizontal scrolling.

```text
URL LibraryEntryView
  -> Library-entry service: membership + projection + completion + type
  -> order + keyset + limit
  -> exhaustive page drain
  -> visit-local literal text filter
  -> canonical collection rows
```

Type is a reversible view lens. It never changes Library membership.

## Target behavior

| Situation | Final behavior |
| --- | --- |
| Select a Type | Commit it to URL, request the exact server view, retain old rows until commit |
| Reload or Back/Forward | Restore the exact Type view |
| Enter local text | Narrow the exhaustive committed Type view without navigation |
| Select Podcast shows from an incompatible view | Normalize to All items / show finished; preserve order |
| Select Unfiled or In Progress from Podcast shows | Normalize Type to All types; preserve order |
| Clear filters | Install the canonical All-types view and dismiss local text |
| Compress or zoom the pane | Stack/wrap FilterRows controls; create no horizontal scrollbar |

## Goals

- Filter every Library detail by its complete resource type, like Browse.
- Keep one exact view identity across URL, request, cache, and signed cursor.
- Preserve the intentional global-search / local-FilterRows boundary.
- Eliminate horizontal panning from every `FilterRows` control surface.
- Reuse current view, pagination, collection, form, and chrome primitives.
- Remove touched duplication, stale contracts, and obsolete scrollbar proof.

## Non-goals

- Filtering the `/libraries` index.
- Multi-select, facet counts, saved views, smart collections, Boolean builders,
  semantic filtering, recommendations, personalization, or AI.
- A generic query/facet DSL or universal Browse/Library taxonomy.
- New endpoint, response field, table, migration, index, worker, or realtime
  path.
- File format, MIME, source, capability, topic, or inferred genre facets.
- A Refine popover/sheet; wrapping is the approved compressed behavior.
- Redesigning `FindOccurrences`, PDF/EPUB instruments, or Browse.

## Product rules

1. Type and projection/completion compose as `AND`.
2. Visit-local text composes with the committed type view as `AND`.
3. Type changes never mutate membership, order, progress, or acquisition.
4. `All types` is the default and is omitted from URL/API.
5. Podcast shows and podcast episodes are distinct types.
6. Capability-impossible combinations are unrepresentable, not empty results.
7. Clear filters resets the full domain view and dismisses local text, matching
   current Library behavior.
8. Navigable domain state belongs in the URL; local draft text does not.
9. Form controls adapt to pane space. Users never pan chrome to find controls.

## Final ownership

| Concern | Sole owner |
| --- | --- |
| Library media-kind inventory | `lib/libraries/mediaKind.ts` |
| Type/view model, labels, transitions, URL/API codec | `libraryView.ts` |
| Same-visit URL commits | existing `usePaneUrlState` |
| Request/cache identity | existing `libraryEntriesResource` |
| Rendering, focus, requested/committed handoff | `LibraryPaneBody` |
| Strict query parsing and type predicate | `services/library_entries.py` |
| Persisted media kind / Podcast target | existing Media / Library-entry facts |
| FilterRows vs instrument geometry | `PaneToolbar` + `PaneShell` |
| Visit-local literal query | existing Pane Search foundation |

Browse keeps its acquisition-specific `BrowseKind` and section plan. Share
matching product copy locally; do not make Browse the Library taxonomy owner.

## Capability contract

### Types

Create one frontend runtime inventory and derive its type:

```ts
const LIBRARY_MEDIA_KINDS = [
  "web_article", "epub", "pdf", "podcast_episode", "video",
] as const;

type LibraryMediaKind = (typeof LIBRARY_MEDIA_KINDS)[number];
type LibraryExactEntryType = LibraryMediaKind | "podcast";
type LibraryEntryType =
  | { kind: "AllTypes" }
  | { kind: "ExactType"; value: LibraryExactEntryType };

interface LibraryEntryView {
  order: LibraryEntryOrder;
  projection: LibraryEntryProjection;
  entryType: LibraryEntryType;
}
```

Python mirrors the closed `AllTypes | ExactType` union. Use the existing
`MediaKind` values plus exact `"podcast"`; do not widen service code to strings.

| UI label | URL/API value | Predicate |
| --- | --- | --- |
| All types | omitted | none |
| Web articles | `web_article` | media and `media.kind = web_article` |
| EPUBs | `epub` | media and `media.kind = epub` |
| PDFs | `pdf` | media and `media.kind = pdf` |
| Videos | `video` | media and `media.kind = video` |
| Podcast episodes | `podcast_episode` | media and `media.kind = podcast_episode` |
| Podcast shows | `podcast` | Podcast target |

There is no `Other`, `Unknown`, or `all` wire value. Adding a persisted kind
requires a coordinated owner cutover.

### Valid states and transitions

Podcast shows support only `AllItems(completion="all")`.

- Selecting Podcast shows normalizes projection to `AllItems(all)` and preserves
  order.
- Selecting Unfiled or In Progress while Podcast shows is active normalizes Type
  to `All types` and preserves order.
- Hide finished is absent when Podcast shows is active.
- All other Type changes preserve projection, completion, and order.
- Sort changes preserve Type exactly.
- Clear installs canonical `AllItems(all) + AllTypes + Canonical` and dismisses
  local text.
- Direct URL/API states violating these rules are invalid; never normalize
  untrusted input.

Keep transitions exhaustive in `libraryView.ts`; components do not reconstruct
these rules.

### Query and pagination

- Add `entry_type` to the strict Library-entry query inventory.
- Apply its predicate in the existing single view query, after membership facts
  exist and before keyset, order, and `limit + 1`.
- Derive Podcast as `target_kind = podcast`; derive media types from `md.kind`.
- Include exact `entryType` in `_view_json()` and therefore the signed cursor
  query digest.
- A cursor from another type fails `E_INVALID_CURSOR`.
- A Type commit requests a fresh first page. Only the latest exact view commits.
- During requested/committed mismatch, retain committed rows; disable pagination,
  mutations, and reorder as today.
- Folio counts the exhaustive committed domain view. Local text does not change
  folio.
- Reorder is enabled only for complete, committed, non-default
  `Canonical + AllItems(all) + AllTypes`.

Do not add an index before a real query plan demonstrates need.

### FilterRows reflow

Make `PaneToolbar` require one closed semantic variant:

```ts
variant: "Refinement" | "Instrument"
```

- `PaneSearchBar` maps `FilterRows` to `Refinement` and `FindOccurrences` to
  `Instrument`.
- Both Media reader call sites declare `Instrument`.
- No default/optional compatibility variant remains.

`Refinement` behavior:

- comfortable pane: search, filters, status/controls remain inline when they fit;
- compact pane `< 480px`: segments stack in DOM order; filters wrap;
- compressed pane `< 360px`: labelled select fields occupy full available width;
- every flexible ancestor has `min-inline-size: 0`;
- the contextual row has automatic block size, visible block overflow, and no
  inline scroll owner;
- document and contextual-row horizontal overflow are both zero;
- labels, focus rings, controls, and touch targets are never clipped or hidden.

Use the existing named primary-pane container and CSS container queries. Existing
mobile chrome measurement remains the sole height-obstruction projection; add no
JS breakpoint or second observer.

`Instrument` retains fixed-height, single-line, locally operable overflow where
its two-dimensional function requires it.

## API design

Existing endpoint, one added strict query key:

```text
GET /libraries/{library_id}/entries
  ?entry_type=web_article|epub|pdf|video|podcast_episode|podcast
  &projection=unfiled|in-progress
  &completion=unfinished
  &sort=title|creator|published|added
  &direction=asc|desc
  &cursor=...
  &limit=...
  &collection_revision=...
```

- Omission means `AllTypes`; `entry_type=all` is invalid.
- Duplicate, empty, unknown, or incompatible values return
  `E_INVALID_REQUEST`.
- Response envelope and `LibraryEntryListItemOut` are unchanged.
- BFF/proxy forwarding is unchanged.
- No old `kind`, `type`, or `types` alias is accepted.

## Intra-system composition

```text
Type Select
  -> libraryView transition
  -> usePaneUrlState replace
  -> libraryEntriesResource exact URL/cache key
  -> FastAPI strict parser
  -> LibraryEntryView
  -> repeatable-read Library-entry query
  -> signed exact-view cursors
  -> exhaustive pagination controller
  -> local FilterRows narrowing
  -> CollectionView / canonical ResourceRow
```

No component filters loaded rows by type. No endpoint or presenter duplicates
the service predicate.

## UX details

- Place labelled native **Type** beside View and Sort by.
- Order values as in the taxonomy table; show `All types` first.
- Count non-All Type as one active domain control.
- Preserve focus on Type/View/Sort across URL commits.
- Empty copy names the selected type and offers **Clear filters**.
- Distinguish Library empty, domain-view empty, and local-text no-match states.
- Keep current requested/committed status copy and retained-row behavior.
- Use existing `Select`, `Toggle`, `Button`, Pane Search, focus, spacing, theme,
  forced-colors, reduced-motion, and coarse-pointer primitives.

## Hard-cut cleanup and reuse

- Add `lib/libraries/mediaKind.ts`; move the duplicated runtime kind inventory and
  `LibraryMediaKind` there.
- Delete local `MEDIA_KINDS` declarations from `readingTime.ts` and
  `entryListItem.ts`; import the one inventory directly, with no barrel/re-export.
- Delete the stale Library CSS comment claiming the current filters slot wraps.
- Replace the current test expectation that compact `FilterRows` scrolls.
- Remove the unqualified/default PaneToolbar layout path; update every call site.
- Update superseded one-line/no-new-filter documentation in the same change.
- Add no aliases, fallback parsing, client-only Type filter, duplicate controls,
  dead styles, or compatibility tests.

Do not centralize Browse enums/labels: the episode mismatch proves the contracts
are not identical. Leave small copy duplication rather than create hollow reuse.

## Files

Add:

- `apps/web/src/lib/libraries/mediaKind.ts`

Primary frontend:

- `apps/web/src/lib/libraries/{libraryView,libraryView.test,entryListItem,readingTime}.ts`
- `apps/web/src/app/(authenticated)/libraries/[id]/LibraryPaneBody.tsx`
- `apps/web/src/app/(authenticated)/libraries/[id]/LibraryPaneBody.module.css`
- matching LibraryPaneBody focused/browser tests
- `apps/web/src/components/ui/{PaneToolbar.tsx,PaneToolbar.module.css}`
- `apps/web/src/components/workspace/{PaneSearchBar.tsx,PaneShell.tsx}`
- matching CSS and focused/browser tests

Backend:

- `python/nexus/api/routes/libraries.py` — endpoint contract text only
- `python/nexus/services/library_entries.py`
- `python/tests/test_libraries.py`
- `python/tests/test_library_entry_plans.py`

Thin journeys and living docs:

- `e2e/tests/{libraries,pane-chrome}.spec.ts`
- `docs/modules/library.md`
- narrow supersession notes in the three cutovers named at the top

Verified unchanged:

- `apps/web/src/lib/api/resource.ts` — existing exact query drives cache identity
- `python/nexus/schemas/library.py`
- Browse code, database models, migrations, tables, and workers

## Acceptance criteria

1. Library detail exposes exactly All plus the six types above; every type returns
   all and only matching committed entries.
2. Type survives reload/back/forward and valid view/sort changes; canonical All
   emits no `entry_type`.
3. Invalid, duplicate, empty, aliased, or incompatible URL/API values fail; no
   fallback or normalization occurs at ingress.
4. Type filtering occurs before keyset and `limit + 1`; no hidden match is lost
   across pages.
5. Cross-type cursor reuse fails, while same-type pagination remains stable and
   exhaustive.
6. Local text narrows the committed Type view without URL/API/request changes.
7. Podcast transition normalization, Hide-finished applicability, Clear, active
   count, empty recovery, and focus behavior match this specification.
8. Reorder is impossible for every non-All Type and unchanged for the complete
   canonical All-types named-Library view.
9. Requested/committed handoff retains navigable rows and blocks stale commits,
   pagination, mutation, and reorder.
10. `FilterRows` has zero contextual-row and document horizontal overflow at
    320, 390, 479, 480, narrow desktop, and wide desktop widths.
11. The same no-overflow proof passes at 200% text scale / 400%-zoom reflow, with
    longest labels, maximum controls, coarse pointer, and always-visible
    scrollbars.
12. Cmd/Ctrl+F, typing, select commits, Clear, Escape, Close, Tab order, focus
    visibility, themes, forced colors, and reduced motion remain correct.
13. `FindOccurrences` and PDF/EPUB instruments retain current behavior.
14. One Library media-kind runtime inventory remains; no local Type predicate,
    old scrollbar expectation, stale wrapping comment, URL alias, or default
    PaneToolbar variant survives.
15. Response schemas, persistence, Browse, and unrelated collection behavior are
    unchanged.

## Verification and implementation order

1. Red: add strict codec/API/cursor/type-plan tests and real-Chromium no-overflow
   proof; demonstrate sensitivity against current behavior.
2. Centralize the Library media-kind inventory.
3. Extend the typed view, transitions, URL/API codec, cursor digest, and service
   predicate.
4. Wire Type UI, lifecycle, focus, empty, Clear, folio, and reorder rules.
5. Cut shared `Refinement` reflow; declare every `Instrument` call site.
6. Delete superseded code/tests/comments and update living/supersession docs.
7. Run focused frontend tests, real Chromium browser tests, focused backend DB
   tests, the two thin Playwright journeys, exact changed-file static checks,
   and `git diff --check`.

Implementation is complete only when all old contracts are removed, the new
proof fails on the unfixed behavior and passes on the final path, and total
complexity decreases.

## Verification evidence

- Strict Library API/type/cursor/query-plan slice: 35 passed.
- Library view/taxonomy unit slice: 170 passed.
- Library pane browser slice: 58 passed.
- Shared chrome Chromium slice: 17 passed.
- Exact Library and pane-chrome journeys: 2 passed each, including setup.
- Exact changed-file ESLint, Ruff check/format, and `git diff --check`: passed.
- Sensitivity was demonstrated before implementation for strict type ingress,
  predicate placement, Type UI, and contextual-row overflow.
