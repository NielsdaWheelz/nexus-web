# Library Entry View Continuity Hard Cutover

Status: IMPLEMENTED AND VERIFIED — 2026-07-24

> **Superseded in part (2026-07-27):**
> [`library-all-and-smart-views-hard-cutover.md`](library-all-and-smart-views-hard-cutover.md)
> extends the view with an entry projection, moves the pending/failure status
> node outside the `aria-busy` collection (with `aria-controls`), replaces the
> status copy with `Loading {requested}. Showing {committed}.` /
> `Could not load {requested}. Showing {committed}.`, and binds result commits
> to placement/consumption revisions. The in-place lifecycle, latest-wins
> commit, and retained-row rules below otherwise stand.
>
> **Pane Filter update (2026-07-29):**
> [`collection-pane-search-filter-sort-hard-cutover.md`](collection-pane-search-filter-sort-hard-cutover.md)
> changes only physical control placement and the final empty-neighbor focus
> target. Requested/committed ownership, retained rows, and exact-view commits
> remain authoritative here.
>
> **Library Type update (2026-08-02):**
> [`library-entry-type-filter-and-filter-row-reflow-hard-cutover.md`](library-entry-type-filter-and-filter-row-reflow-hard-cutover.md)
> extends exact view identity through URL, API, and cursor with one entry-type
> facet. The in-place latest-wins lifecycle and retained-row rules below stand.

Type: hard cutover. No feature flag, compatibility branch, legacy lifecycle,
silent fallback, or released intermediate state.

Open questions: none.

Governing contracts:

- `docs/rules/{simplicity,cleanliness,frontend,keys-and-identities,naming,tagged-unions,control-flow,boundaries,testing}.md`
- `docs/cutovers/library-sorting-hard-cutover.md`
- `docs/cutovers/collection-surface-hard-cutover.md`
- `docs/cutovers/pane-visit-return-memento-hard-cutover.md`
- `docs/modules/{library,workspace}.md`

## Decision

A Library sort/filter change is an in-place entry-view request against the same
Library pane. It never remounts the pane, reloads Library metadata, clears the
committed rows, or starts motion before data is ready.

The URL owns the requested `LibraryEntryView`. A Library-owned controller owns
the last committed entry page. Requested and committed views may differ only in
an explicit pending or failed state.

## Goals

- Preserve pane, toolbar, focus, Slate, Companion, and row continuity.
- Fetch only the requested entry page during an interactive view change.
- Keep server ordering, exact-view cursors, and the existing API authoritative.
- Make rapid changes latest-wins and stale cursors/actions impossible.
- Reuse `queryNavigation: "in-place"`, `useResource`, `CollectionView`, pane
  visit data, and the existing Library view codec.
- Delete the remount, clear-before-fetch, debounce, and URL-time transition
  paths.

## Scope

In scope:

- Library route mount identity for query-only navigation.
- Library first-page request/commit state.
- Canonical, factual-sort, and completion-filter transitions.
- Pending, failure, focus, scroll, motion, and pane-return behavior.
- Focused owner tests, one real-stack Library flow, docs, and residue checks.

Non-goals:

- Backend, BFF, wire schema, cursor, database, or query-plan changes.
- Client-side sorting, exhaustive loading, virtualization, or new indexes.
- A shared query/cache framework, new dependency, worker, persisted projection,
  or per-view cache.
- Exact-view server bootstrap for a factual-sort deep link.
- Search, Podcasts, Podcast Detail, Stats, or global route-policy changes.
- Entry mutation, reorder, Slate, Companion, connection-summary, or pane-memento
  redesign.
- Element-scoped View Transition infrastructure or motion-system redesign.

## Target Behavior

1. Changing `Sort by` or `Hide finished` updates the pane URL with `replace`.
2. `LibraryPaneBody` and its controls remain mounted.
3. The previous committed rows remain visible while the exact requested first
   page loads. No pane or collection skeleton replaces them.
4. The collection is `aria-busy="true"` and shows a quiet `role="status"`
   message naming the requested view and prior committed view.
5. Sort/filter controls remain enabled. Row navigation remains enabled.
   Pagination, reorder, and entry mutations are disabled until views match.
6. A newer view aborts/supersedes the older request. Only the current requested
   view may commit.
7. Success atomically replaces committed view, rows, and cursor, clears busy
   state, returns the collection region to its start, and runs one
   `CollectionView` row transition.
8. Failure retains the committed rows and requested URL, disables
   view-sensitive actions, and renders `Retry`. The UI explicitly says which
   prior view is displayed; mismatch is never silent.
9. Focus stays on the initiating select/toggle. Stable row keys preserve row
   focus where applicable; the existing next/previous/`Sort by` recovery owns
   filtered-row removal.
10. Reduced motion performs the same atomic commit without animation.

Retaining the last committed result is the primary refresh contract, not a
compatibility fallback.

## Identity And Capability Contract

| Concern | Owner | Identity | Changes on view request |
| --- | --- | --- | --- |
| Pane instance | pane route model | `library:<id>` route instance | no |
| Requested view | pane URL codec | `LibraryEntryView` | immediately |
| First-page query | Library resource client | library + exact view | yes |
| Committed page | Library controller | view + rows + cursor | on matching success |
| Row | Library row projection | media ID for Default; entry ID otherwise | no |
| Return snapshot | Library pane visit data | Library + committed page | only when views match |
| Motion | `CollectionView` | committed row-key sequence | on commit only |

The capability is:

```text
requestLibraryEntryView(requestedView)
  -> keep committed page visible
  -> load GET /libraries/{id}/entries for requestedView
  -> commit matching page | expose retryable failure
```

It is Library-owned. No second controller or interchangeable API is added.

## State Model

Use explicit variants:

```text
LibraryEntryPageSnapshot {
  view: LibraryEntryView
  entries: readonly LibraryEntry[]
  nextCursor: string | null
}

LibraryEntriesState =
  | InitialLoading {
      requestedView: LibraryEntryView
    }
  | Ready {
      committed: LibraryEntryPageSnapshot
    }
  | Refreshing {
      requestedView: LibraryEntryView
      committed: LibraryEntryPageSnapshot
    }
  | RefreshFailed {
      requestedView: LibraryEntryView
      committed: LibraryEntryPageSnapshot
      error: ApiError
    }

LibraryPaneSnapshot {
  library: Library
  entries: LibraryEntryPageSnapshot
}
```

Rules:

- `requestedView` comes only from the strict URL codec.
- Rows, cursor, pagination, mutations, and visit snapshots read only
  `committed`.
- A URL/view mismatch is always `Refreshing` or `RefreshFailed`.
- `Refreshing` may also retain the same view value after a newer request has
  invalidated the displayed page, such as rapid Factual → Canonical return.
- Same-system response defects throw; expected request failures become
  `RefreshFailed`.
- One AbortController/keyed resource request owns first-page concurrency.
- No boolean bundle or independently mutable entries/cursor/view triple.

Store the committed snapshot and keyed resource result once; derive
`LibraryEntriesState` from them. Do not mirror resource status in additional
booleans.

## Architecture

```text
Library view controls
  -> usePaneUrlState.replace(requested URL; no transition intent)
  -> pane route queryNavigation="in-place"
  -> mounted LibraryPaneBody derives requestedView
  -> exact-view useResource request
  -> Library-owned state installs matching page atomically
  -> CollectionView reconciles stable keyed rows
  -> pane visit data captures only Ready committed truth
```

### Route composition

- Add `queryNavigation: "in-place"` to the `library` route definition.
- Key in-place content by visit, route, and pathname: query replacement retains
  the body; a new visit or pathname remounts it.
- Keep the full query in `routeKey` for URL/history identity.
- Re-register pane-return capabilities under that full key, but do not request
  a return restore for the same live in-place visit/path. The Library commit
  owns its collection reset.
- Key resource-locator resolution by canonical locator identity, not query
  route identity; sorting does not resolve the same Library twice.
- A new visit receives normal `ShellScroll` remount/return behavior.

### Query composition

- Use the existing `libraryEntriesResource` and `useResource` request lifecycle.
- Key/wrap every result with the exact requested view or canonical request path;
  never apply unassociated retained hook data.
- Initial Canonical + All may adopt the composed route-entry seed once.
- After initial adoption, every different requested view—including returning to
  Canonical + All—uses the entries endpoint. The bootstrap page is not an
  eternal canonical cache.
- Remove `useDebouncedFetch` from first-page view loading; finite select/toggle
  changes have zero debounce. Its existing entry-reconciliation use is
  unchanged.
- Standard `useResource` cancellation/retry remains the sole request lifecycle.

### Commit and race rules

- A response commits only when its request key equals the current requested
  view.
- Commit `view`, `entries`, and `nextCursor` in one state update.
- Changing view cancels load-more and blocks starting pagination/reorder/entry
  mutations until commit.
- An older first-page response never mutates state after a newer request.
- Connection summaries requery only after committed rows change.
- Slate, Companion, Library metadata, and pane chrome remain mounted and do not
  refetch because of entry-view changes.

### Pane return

- Capture `LibraryPaneSnapshot` only in `Ready`, with committed view equal to the
  URL view.
- Capture nothing during `InitialLoading`, `Refreshing`, or `RefreshFailed`.
- Restored snapshots reinstall one coherent Library + entry-page value; no old
  snapshot shape is decoded.

## API Design

No API change.

```text
GET /api/libraries/{id}/entries
  ?sort=<existing factual sort>
  &direction=<existing direction>
  &completion=unfinished
  &cursor=<existing exact-view cursor>
```

- Request and response rules remain owned by
  `library-sorting-hard-cutover.md`.
- Interactive view changes issue only the exact requested first-page Library
  query, aside from standard retries and the dependent connection-summary
  request after commit.
- They do not issue `GET /libraries/{id}`, a canonical bootstrap entries GET,
  or any Slate request.
- No client comparator, compatibility query, alternate endpoint, or response
  field is added.

## UX, Motion, And Accessibility

- Keep pane chrome, Library title, toolbar geometry, and Slate visually stable.
- Do not dim or skeletonize the pane.
- Status copy is terse:
  `Updating to <requested>. Showing <committed> until it arrives.`
- Failure copy is explicit:
  `Could not load <requested>. Showing <committed>.` plus `Retry`.
- URL replacement owns no View Transition.
- `CollectionView` owns the single transition when committed row order changes;
  stable row IDs provide object continuity.
- No new animation duration, CSS keyframe, or motion dependency.
- The collection region owns `aria-busy`; status uses polite status semantics.
- Successful global reorder returns the collection region to its start without
  moving focus.

## Hard-Cut Rules

Delete from the Library path:

- URL-time `collection-reflow` replace options.
- Query-keyed pane remount behavior.
- `useDebouncedFetch` first-page loading.
- The effect that clears entries/cursor on view change.
- The factual-refresh `PaneLoadingState` branch.
- Applying hook data without proving it belongs to the requested view.
- Visit snapshots that omit committed `LibraryEntryView`.
- Tests/comments that assert reset-before-fetch or bootstrap-as-permanent-cache.

Keep:

- Initial route-entry loading/error UI.
- Strict view codec and invalid-view reset.
- Existing API, server ordering, cursor, pagination, mutation reconciliation,
  row identities, `CollectionView`, and reduced-motion behavior.
- `useDebouncedFetch` for its remaining owners; this cutover does not generalize
  or delete it globally.

Residue searches must find no Library-owned legacy path. Do not retain dead
aliases, dual state, or compatibility tests.

## Files

Create:

- `docs/cutovers/library-entry-view-continuity-hard-cutover.md`

Modify during implementation:

- `apps/web/src/lib/panes/paneRouteModel.ts`
- `apps/web/src/components/workspace/WorkspaceHost.tsx`
- `apps/web/src/components/workspace/WorkspaceHost.test.tsx`
- `apps/web/src/components/workspace/PaneShell.tsx`
- `apps/web/src/lib/workspace/paneReturnMemento.tsx`
- `apps/web/src/components/collections/CollectionView.tsx`
- `apps/web/src/components/collections/CollectionView.test.tsx`
- `apps/web/src/components/collections/CollectionRow.tsx`
- `apps/web/src/app/(authenticated)/libraries/[id]/LibraryPaneBody.tsx`
- `apps/web/src/app/(authenticated)/libraries/[id]/LibraryPaneBody.module.css`
- `apps/web/src/app/(authenticated)/libraries/[id]/LibraryPaneBody.ac4.test.tsx`
- `apps/web/src/app/(authenticated)/libraries/[id]/LibraryPaneBody.default.test.tsx`
- `apps/web/src/app/(authenticated)/libraries/[id]/LibraryPaneBody.readingSlate.test.tsx`
- `e2e/tests/libraries.spec.ts`
- `docs/modules/library.md`
- `docs/cutovers/library-sorting-hard-cutover.md`

No new source file, shared hook, dependency, BFF route, backend file, or
migration.

## Implementation Order

1. Add the failing Library in-place mount test by adapting the Stats precedent.
2. Add failing delayed-response behavior tests for continuity, busy/error
   states, latest-wins, action gating, canonical return, and coherent snapshots.
3. Opt Library into in-place query navigation.
4. Replace reset/debounce state with the requested/committed controller.
5. Move transition ownership from URL replacement to committed rows.
6. Update the existing real-stack Library flow and current docs.
7. Delete legacy branches/comments/tests; run residue searches and focused
   verification.

## Acceptance Criteria

1. A Library query replacement preserves the pane-body instance, control focus,
   and live pane/Slate/Companion state.
2. A new visit still follows normal `ShellScroll` remount semantics.
3. During a delayed view request, prior rows remain visible and no
   `PaneLoadingState` replaces the pane or collection.
4. Pending state is list-local, accessible, and visibly names requested and
   committed views.
5. Sort/filter controls remain usable; pagination, reorder, and mutations are
   unavailable while views differ.
6. Rapid view changes are latest-wins; aborted/stale responses never commit.
7. Success atomically commits matching view, rows, and cursor; the collection
   returns to its start without focus loss.
8. Failure retains prior rows, exposes Retry, and never presents them as the
   requested view.
9. Returning to Canonical after another view fetches current canonical truth;
   it does not reinstall the original bootstrap page.
10. Interactive sorting does not refetch Library metadata, canonical bootstrap
    entries, or Slate, and does not remount the pane body.
11. Pagination can never combine a requested view with another view's cursor.
12. Pane return captures/restores only a coherent committed view/page.
13. Motion starts only when rows commit; stable row IDs reflow once; reduced
    motion commits without animation.
14. Invalid URL state, strict API behavior, server ordering, Default
    deduplication, filtering, reorder gates, and mutation reconciliation remain
    unchanged.
15. No client sorting, generic query abstraction, cache, backend change, or
    compatibility path ships.
16. Library legacy-residue searches are empty and focused verification is green.

## Focused Verification

Run each group from the repository root:

```text
(cd apps/web &&
  /home/niels/.bun/bin/bunx eslint \
    src/lib/panes/paneRouteModel.ts \
    src/components/workspace/WorkspaceHost.tsx \
    src/components/workspace/WorkspaceHost.test.tsx \
    src/components/workspace/PaneShell.tsx \
    src/lib/workspace/paneReturnMemento.tsx \
    src/components/collections/CollectionView.tsx \
    src/components/collections/CollectionView.test.tsx \
    src/components/collections/CollectionRow.tsx \
    'src/app/(authenticated)/libraries/[id]/LibraryPaneBody.tsx' \
    'src/app/(authenticated)/libraries/[id]/LibraryPaneBody.ac4.test.tsx' \
    'src/app/(authenticated)/libraries/[id]/LibraryPaneBody.default.test.tsx' \
    'src/app/(authenticated)/libraries/[id]/LibraryPaneBody.readingSlate.test.tsx' \
    --max-warnings 0)

(cd apps/web &&
  /home/niels/.bun/bin/bun run test:browser -- \
    src/components/workspace/WorkspaceHost.test.tsx \
    src/components/collections/CollectionView.test.tsx \
    src/components/collections/CollectionRow.test.tsx \
    'src/app/(authenticated)/libraries/[id]/LibraryPaneBody.ac4.test.tsx' \
    'src/app/(authenticated)/libraries/[id]/LibraryPaneBody.default.test.tsx' \
    'src/app/(authenticated)/libraries/[id]/LibraryPaneBody.readingSlate.test.tsx')

./scripts/with_test_services.sh \
  ./scripts/with_supabase_services.sh --require-admin \
  sh -lc 'cd e2e &&
    NEXUS_ENV=test E2E_REAL_MEDIA=0 \
    bun run test:e2e -- tests/libraries.spec.ts --project=chromium'
git diff --check
```

Verification record — 2026-07-24:

- Scoped ESLint: passed with zero warnings.
- Focused browser tests: 6 files, 103 tests passed.
- Real-stack Chromium E2E: `tests/libraries.spec.ts`, 5 tests passed,
  including authenticated setup.
- Library legacy-residue searches: empty.
- Scoped `git diff --check`: passed.

Tests assert observable mount, focus, scroll, rows, status, URL, request, and
error behavior. They do not assert hook calls or internal state shape.

Implementation is present; the final combined focused browser and real-stack
commands above remain pending.
