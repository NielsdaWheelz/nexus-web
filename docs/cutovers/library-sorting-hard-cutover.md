# Library View Lenses Hard Cutover

Status: APPROVED SPEC — 2026-07-22

Type: hard cutover. No compatibility decoding, legacy cursor support,
fallbacks, dual paths, feature flag, or released intermediate state.

Reverse directions apply to every factual sort, not canonical/custom order.

## Goal

Preserve authored library order while adding temporary, explicit, reversible ways to inspect the complete collection.

Separate:

- Canonical order: durable user intent.
- View lens: temporary sort/filter state.
- Discovery: Slate and Related.

## Target behavior

The Library toolbar contains:

- visibly labelled `Sort by` select
- native `Hide finished` checkbox using the shared `Toggle`

Sort presets:

- Custom order — non-default libraries
- Recently added — Default/My Library canonical mode
- Title — A–Z
- Title — Z–A
- Creator — A–Z
- Creator — Z–A
- Published — newest
- Published — oldest
- Added — newest
- Added — oldest

`Recently added` is Default's `Added — newest` baseline; do not render a
duplicate option there. Default still exposes `Added — oldest` as its reverse.

Rules:

- Alternate sorting never writes `library_entries.position`.
- Reordering is available only in Custom order, with finished items shown and
  every page loaded.
- Hide finished excludes canonical finished media before pagination.
- Podcast-show rows remain; zero unplayed episodes does not mean finished.
- Controls remain visible when no rows match.
- Filtered empty state: `No unfinished items`, with `Show finished`.
- Main collection controls do not affect Slate.
- Added date becomes visible row metadata while sorting by Added.
- Temporary state survives pane restoration/reload through the pane URL but is
  never stored as a user preference.
- Default, system, admin, and member-only libraries all support factual view
  lenses.

## Capability contract

| Surface | Canonical mode | Factual sorts | Hide finished | Reorder |
| --- | --- | --- | --- | --- |
| Editable non-default | Custom order | yes | yes | canonical + all + fully loaded only |
| Read-only/system non-default | Existing position order | yes | yes | no |
| Default/My Library | Recently added | yes | yes | no |

Default remains a live deduplicated virtual set. This cutover adds no persisted
ordering overlay.

## Internal model

Use a closed union, not optional correlated fields:

```text
LibraryEntryOrder =
  Canonical
  | Title { direction: Asc | Desc }
  | Creator { direction: Asc | Desc }
  | Published { direction: Asc | Desc }
  | Added { direction: Asc | Desc }

LibraryEntryView {
  order: LibraryEntryOrder
  completion: All | Unfinished
}
```

No generic sorting framework or query DSL.

## API

```text
GET /libraries/{library_id}/entries
  ?sort=title|creator|published|added
  &direction=asc|desc
  &completion=unfinished
  &cursor=<opaque>
  &limit=<int>
```

Canonical/all state omits sort, direction, and completion.

Validation:

- Explicit factual sort requires exactly one `direction`.
- `direction` without factual sort is invalid.
- `completion` is omitted or `unfinished`; no loose boolean parsing.
- Unknown or duplicate query parameters fail `400 E_INVALID_REQUEST`.
- Removed `sort=position`, `sort=manual`, `sort=resonance`, and
  `completion=all` fail `400 E_INVALID_REQUEST`.
- Old position/default/Resonance cursors fail `400 E_INVALID_CURSOR`.
- Response remains the existing `LibraryEntryOut` page; no compatibility
  fields.

The Next.js proxy forwards the query unchanged and owns no defaults.

Frontend URL decoding is equally strict for the view-owned `sort`, `direction`,
and `completion` keys while preserving unrelated pane parameters. Invalid view
state renders `Invalid library view` with `Reset view`; it never silently falls
back or normalizes.

## Ordering rules

Every order is total, stable, and keyset-pageable.

- Canonical, non-default: position ASC, created_at DESC, id DESC.
- Canonical, Default: media.created_at DESC, media.id DESC.
- Title: trimmed, lowercased canonical title in requested direction; identity
  tie-break.
- Creator: first displayed contributor by canonical ordinal; missing last in
  both directions; title then identity tie-break.
- Published: canonical partial-publication ordering; missing last in both
  directions; never fabricate month/day values.
- Added, non-default: `library_entries.created_at`.
- Added, Default: `media.created_at`, presented as `Added to Nexus`.
- Direction reverses the primary factual key. Deterministic secondary keys
  remain stable.
- Missing values are never treated as empty strings, zero, or epoch dates.

Do not strip leading articles such as “A” or “The.”

## Cursor design

One new cursor family:

```text
library_entries:view:v1 {
  viewerId
  libraryId
  order
  completion
  after: sort-specific tagged key
}
```

The tagged `after` variant carries missing-value rank, primary value, and stable
identity. The cursor is bound to the exact view. Cross-user, cross-library,
cross-sort, cross-direction, and cross-filter reuse fails.

Reads remain live under the existing repeatable-read request transaction; no
snapshot table or historical `asOf` fiction.

## Backend architecture

`library_entries` remains the Library view coordinator:

1. Authorize library membership.
2. Build complete Default or physical membership.
3. Compose owner-provided sort/filter facts.
4. Apply completion filtering.
5. Apply the selected total order.
6. Keyset-page with limit + 1.
7. Hydrate only returned entries.

Composition:

- `library_entries`: membership, canonical order, entry creation time,
  pagination, and hydration.
- `contributor_credits`: narrow public primary-creator sort relation; no direct
  table reach-through.
- consumption: existing canonical engagement/read-state relation.
- media: title, publication, and media creation facts.
- `media_document_metrics`: unchanged; time sorting is out of scope.
- Resonance: Slate and Related only.

No migration, persisted projection, cache, worker, or speculative index. If
representative query plans prove an index is required, revise this spec before
adding one.

## Frontend architecture

- Add a Library-specific view codec and closed types.
- Reuse `usePaneUrlState`.
- Replace parallel manual/Resonance arrays with one active paginated controller
  keyed by `LibraryEntryView`.
- Keep that controller Library-owned: its decoding, optimistic consumption,
  removal, and exact-set reorder lifecycle does not match the simpler shared
  `useCursorPagination` contract.
- Reuse `PaneToolbar`, `Select`, `Toggle`, `CollectionView`, and current reorder
  machinery.
- Hard-cut `SortSelect`; it has one caller and duplicates the visible
  labelled-select pattern already used by Podcasts.
- Hard-cut `PaneToolbar`'s unsupported `role="toolbar"` semantics; retain it as
  a plain responsive layout container.
- Use one select containing named direction presets—no icon-only direction button.
- When filtering or Mark Finished removes the focused row, focus moves to the
  next visible row, then previous row, then `Sort by`.
- Reflow without horizontal scrolling at 320px.

## Resonance cut

Delete only the Library-ranking consumer:

- `sort=resonance` route branch
- Library Resonance cursor
- `rank_library_entry_page`
- rank-only weights, result types, and SQL
- frontend resonance arrays, requests, errors, and tests
- Library-ranking clauses in current docs

Keep:

- Slate
- Related
- evidence acquisition
- semantic calibration
- graph normalization
- shared ranking helpers still used by those consumers

No hidden endpoint or deprecated alias remains.

## Non-goals

- Reading-time or time-remaining sorting
- Podcast/video TimeCommitment
- Search
- Saved views or persisted preferences
- Matching/total counts
- Reverse canonical/custom order
- Multi-column sorting
- Slate filtering or ranking changes
- Reorder redesign
- New database schema
- Client-side exhaustive loading and sorting
- New indexes without measured evidence

## Files

Create during implementation:

- `apps/web/src/lib/libraries/libraryView.ts`
- focused codec/unit test

Modify during implementation:

- `docs/architecture.md`
- `docs/modules/library.md`
- affected current cutover docs with explicit supersession
- `python/nexus/api/routes/libraries.py`
- `python/nexus/services/library_entries.py`
- `python/nexus/services/contributor_credits.py`
- `python/nexus/services/resonance/{service,_ranking}.py`
- focused backend tests
- `apps/web/src/lib/api/resource.ts`
- `LibraryPaneBody.tsx` and focused tests
- `PaneToolbar.tsx` and affected tests
- relevant Library styles/E2E

Delete during implementation:

- `SortSelect.tsx`
- `SortSelect.module.css`
- rank-specific tests and dead Library Resonance code

No database migration.

## Acceptance criteria

1. Alternate views perform no library_entries DML and never change positions.
2. All eight factual direction presets order the complete eligible set correctly.
3. Filtering occurs before pagination; no short/empty false pages.
4. Missing creator/publication facts stay last in both directions.
5. Every cursor is deterministic and exact-view scoped; all legacy cursors
   fail.
6. Default retains virtual-set semantics and never exposes Custom order or
   reorder.
7. Read-only/system libraries receive view capabilities without mutation
   capabilities.
8. Hide finished excludes only canonically finished media; podcast shows
   remain.
9. Mark Finished under the filter removes the row with correct focus recovery.
10. Reorder exists only for fully loaded Canonical + All editable non-default
    libraries.
11. URL state round-trips through reload, pane restoration, back, and forward.
12. Invalid URL/API view states fail visibly; none silently normalize.
13. Added sorting displays the governing added date.
14. Toolbar has visible labels, native semantics, keyboard access, and 320px reflow.
15. Library Resonance has no route, cursor, client, test, or current-doc residue.
16. Slate and Related behavior remain unchanged.
17. Focused query plans are measured; evidence requiring an index blocks this
    cutover pending an explicit spec revision.

## Implementation order

1. Land the hard-cutover document and closed contracts.
2. Replace backend list/cursor architecture and delete Library Resonance ranking.
3. Cut frontend state/UI to the new view controller.
4. Update docs and focused tests.
5. Run residue searches, focused browser/backend verification, and query-plan checks.
