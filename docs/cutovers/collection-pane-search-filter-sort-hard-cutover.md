# Collection Pane Search, Filter, And Sort Hard Cutover

Status: SOURCE CUTOVER VERIFIED — 2026-07-29; production cutover pending
Type: hard cutover
Date: 2026-07-29

Open questions: none.

Governing contracts:

- `docs/cutovers/pane-search-foundation-hard-cutover.md`
- `docs/cutovers/complete-collection-lists-hard-cutover.md`
- `docs/cutovers/{library-sorting,library-entry-view-continuity,library-all-and-smart-views,resource-native-pages-and-notes}-hard-cutover.md`
- `docs/rules/{boundaries,cleanliness,codebase,concurrency,control-flow,correctness,errors,frontend,function-parameters,keys-and-identities,naming,overrides,simplicity,tagged-unions,testing,timing}.md`

Assume Complete Collection Lists is implemented. This cutover lands the
foundation's approved `FilterRows` successor amendment and supersedes:

- Complete Collection Lists' Podcast-subscription and Podcast-episode `q`
  query identities, list predicates, `PodcastEpisodeSelection.query`, and
  “matching” command copy for both text and state-only filtering;
- Library Sorting and Library All/Smart Views only where they require a
  permanently visible physical toolbar or name `View`/`Sort by` as the final
  focus fallback; exact view options, labels, URL state, server semantics,
  continuity, and 320px reflow remain authoritative;
- Library Entry View Continuity only for physical control placement. Its
  requested/committed ownership and focus-retention rules remain.

No other predecessor clause changes.

## Decision

Use the foundation's single `FilterRows` capability:

- Author works, Conversations, Libraries, Library entries, Podcast
  subscriptions, Podcast episodes, and the Notes Page index filter loaded rows
  while their exhaustive owner drains, then the complete current rows.
- Page and Note filter only `surface.orderedItems`, one direct level deep.
- Existing domain filters/sorts move into the expanded Pane Search row. A
  collapsed Filter action visibly and accessibly marks non-default domain state.
- Query matching and row updates are immediate. Only the nonvisual polite
  announcement is debounced.
- The query is visit-local and never a URL, HTTP, cursor, snapshot, command
  selection, or persistence input.

**Filter is a reversible view over known rows, not retrieval.** Global retrieval
remains `Cmd/Ctrl+K`; pane-local Filter remains `Cmd/Ctrl+F`.

## Goals

- One immediate, accessible Filter interaction across collection-shaped panes.
- Search the complete current scope without query-triggered requests.
- Preserve domain membership, ordering, mutation, and continuity owners.
- Prevent query-driven View Transitions and hidden structural edits.
- Delete the superseded Podcast query path end to end.

## Scope And Row Policy

| Surface                | Match fields                                                 | Unit / complete filtered-empty copy                   | Existing domain controls/order    |
| ---------------------- | ------------------------------------------------------------ | ----------------------------------------------------- | --------------------------------- |
| Author works           | work title                                                   | work/works — `No works match this filter.`            | current contributor-work order    |
| Conversations          | conversation title                                           | chat/chats — `No chats match this filter.`            | current conversation order        |
| Libraries              | presented Library name                                       | library/libraries — `No libraries match this filter.` | current Library order             |
| Library entries        | row title; contributor display/credited names                | entry/entries — `No entries match this filter.`       | projection, completion, and order |
| Podcast subscriptions  | title; contributor display/credited names                    | show/shows — `No shows match this filter.`            | status, Library scope, and sort   |
| Podcast episodes       | title; contributor display/credited names                    | episode/episodes — `No episodes match this filter.`   | episode state and sort            |
| Notes index            | Page title                                                   | page/pages — `No pages match this filter.`            | API order                         |
| Page/Note direct items | Note body text, or linked-resource label and visible summary | item/items — `No items match this filter.`            | authored `orderedItems` order     |

Only these fields match. Dates, status, progress, counts, action labels, hidden
metadata, linked content, incoming edges, and descendants do not.

When an exhaustive collection is still Partial and has no loaded match, use
neutral copy **No matching {unit} found so far.** beside the existing loading
state. Never show the domain-zero copy while an effective query is nonempty.
Collection empty states use `FeedbackNotice severity="neutral"`; Page/Note uses
its inline `role="status"` item.

## Non-goals

- Find controls, occurrence navigation, highlighting, snippets, visible result
  counts, Companion results, or **Go back to reading position**.
- Fuzzy, semantic, token, stemming, regex, operator, accent-insensitive, or
  locale-specific search.
- New domain filters/sorts, local re-sorting, saved views, search history, or
  cross-resource retrieval.
- Filtering Library members, choosers, destination overlays, global Search,
  Nexus, Settings, Companion surfaces, or Add-item target search.
- New backend search endpoints, indexes, database changes, migrations,
  virtualization, or a generic collection controller.

The foundation's visually hidden live status is accessibility feedback, not
result-count chrome.

## Target Behavior

1. Filter and `Cmd/Ctrl+F` open/focus the active pane's row. Typing filters on
   every keystroke; repeating the shortcut focuses/selects the query.
2. Existing domain controls render in `publication.filters`. Their native
   labels, semantics, URL state, focus retention, and 320px reflow remain.
3. `activeDomainControlCount` counts every non-default View/Filter/Sort value,
   including a non-default sort. While collapsed, the Filter action shows a
   marker and accessible label **Filter, N controls active**.
4. Close or `Escape` performs one deliberate stage: clear the local query,
   collapse the row, and focus Filter. Domain controls remain applied and the
   collapsed marker remains. Reopen to inspect/change them.
5. A domain Clear control resets its domain controls and local query. Creation,
   Today, Browse, import/export, and action menus remain outside Pane Search.
6. Domain membership/projection applies first; the local query narrows it; the
   existing domain order remains final. Query never sorts.
7. Query-derived row changes commit synchronously without a View Transition.
   Domain view commits and mutations retain `CollectionView`'s current
   transition policy.
8. While exhaustive loading is Partial, filter loaded rows and announce
   **N matching {unit} among L loaded; loading remaining {plural unit}.**
   Completion announces **N matching {unit} of M total.** Appended matches do
   not move focus/scroll.
9. Where a visual header folio exists, it reports the exhaustive domain view,
   never the local query subset. Before completion it remains pending/no-count.
   For Podcasts this intentionally replaces the old server-`q` match count.
10. Pane inactivity preserves query state. Route/source replacement clears it.
    Domain view replacement retains it and recomputes against the committed
    rows. For `FilterRows`, the expanded row is keyed to the mounted
    visit/route/path session, not the query-bearing `routeKey`; a domain URL
    replacement on the same path therefore preserves the input and focused
    native control. A new visit, route, or path collapses it. Find remains
    strictly route-keyed.
11. During a Library requested/committed mismatch, filter retained committed
    rows. A later exact-view commit recomputes against the same query; the query
    neither starts nor keys the request.
12. Local/optimistic mutations feed the same derivation immediately. Focus
    recovery is owner work defined below; newly appearing rows never steal focus.
13. Page/Note reads the current optimistic `surface.orderedItems`, never global
    Search, target search, or a graph endpoint.

## Composition And Ownership

```text
loaded canonical domain rows
  -> existing domain projection/filter
  -> domain presenter and explicit match fields
  -> local literal Pane query
  -> existing domain order
  -> CollectionView immediate filter commit

ResourceSurface session.orderedItems
  -> direct-item match fields
  -> local literal Pane query
  -> authored order
  -> inspection-only filtered region
```

| Concern                                    | Sole owner                     |
| ------------------------------------------ | ------------------------------ |
| shortcut, bar, open/close/focus            | Pane Search foundation         |
| collapsed marker and spoken row status     | `PaneShell` / `PaneSearchBar`  |
| source-keyed query/publication memoization | field-free `usePaneFilterRows` |
| literal folding/matching                   | pure Pane row-filter helper    |
| searchable fields                          | domain producer                |
| domain filter/sort state and requests      | existing domain controller     |
| query-change transition bypass             | `CollectionView`               |
| mutation neighbor capture/recovery         | each domain pane body          |
| direct items and optimistic edits          | Resource Surface session       |
| global retrieval                           | Nexus and `/search`, unchanged |

Do not add searchable fields to `CollectionRowView`, a universal row-filter
schema, search context, registry, route table, or shell text scraper.

## Shared Internal Contracts

Import the foundation's approved `PaneFilterRowsPublication`,
`PaneFilterRowsStatus`, and `PaneFilterRowsUnit`; do not restate them here.

Add one field-free producer hook:

```ts
usePaneFilterRows({
  sourceKey,
  inputLabel,
  placeholder,
  getRowStatus,
  activeDomainControlCount,
  filters,
  controls,
}): {
  readonly query: string;
  readonly publication: PaneFilterRowsPublication;
}
```

It owns only source-keyed query state, stable change/dismiss callbacks, and
publication memoization. `getRowStatus(query)` is a stable domain-owned callback
that derives status from that query and the producer's current rows; the hook
only invokes it. Source change resets query; inactivity does not; dismiss
clears query. It owns no rows, fields, matching, domain controls, or filter
derivation. All in-scope producers use it; delete the duplicated Page/Note
`filterState` glue.

Add one pure matcher:

```ts
matchesPaneFilterQuery(
  query: string,
  fields: readonly string[],
): boolean
```

Rules:

- trim only outer query whitespace;
- normalize query/fields to NFC, then use Unicode default lowercase conversion;
- literal substring match within any one field;
- never concatenate fields, construct regex, parse operators, or strip accents;
- empty effective query returns `true`;
- producers pass only the Scope table's fields.

This deliberately differs from canonical Find's length-preserving simple case
folding: row filtering has no locator offsets to preserve. It matches the
implemented Chat lowercase-comparison precedent but remains a separate
contract.

Extend `CollectionView` narrowly:

```ts
rowChangePresentation?: {
  readonly kind: "ImmediateOnKeyChange";
  readonly key: string;
}
```

Every in-scope `CollectionView` passes the effective query as `key`.
`CollectionView` remembers the prior key: a key change commits rows directly;
the same key uses existing suffix/reorder/replacement classification. Do not
infer query changes from row counts or identities.

## Domain Controls And Focus

- Moving controls into Pane Search explicitly supersedes predecessor
  always-visible physical-toolbar placement. When expanded, controls remain
  mounted through zero rows, pending, and failure.
- The collapsed active marker is the sole duplicate-free discoverability
  affordance. Do not auto-expand or silently reset domain state.
- Re-home the create-Library form from `PaneToolbar.filters` to
  `SectionOpener.actions`, following Conversations' **New chat** pattern.
- Keep Create Page, Today, Browse, import/export, and page actions in their
  current always-reachable opener/header/body owner.
- Lists without existing domain controls publish count `0` and only the query.

For a focused row removed by a mutation, its pane body captures the pre-mutation
filtered row sequence. **Semantic neighbor** means the next visible row in that
sequence, then the previous visible row. After commit, focus that row; if none,
focus the Pane Search input while expanded, otherwise the mounted Filter action;
on mobile, where Filter is folded into Options, focus that existing Options
trigger. Add one exact helper beside `findPaneChromeFocusTarget` for those
canonical chrome targets; do not query row text or mint per-pane selectors.
Query typing itself retains input focus and needs no row recovery.

## Page And Note Inspection Safety

While the effective query is nonempty:

- source Page title/source Note body remains editable;
- direct Note bodies render `readOnly`; split and empty-backspace removal are
  unavailable;
- direct-item Move/Remove, Add note, and Add item controls are absent;
- linked-resource activation remains;
- one `role="status"` notice precedes the rows:
  **Filtered view is inspection only — clear Filter to edit.**

No disabled/dead editing controls remain. Clear/Close restores full structural
editing. Resource Surface Add-item search remains unchanged when editing is
available.

## Podcast API And Command Hard Cut

1. Remove subscription `q` from the pane URL codec, query identity, snapshots,
   cache/exhaustion keys, first/continuation requests, strict API parser, cursor
   digest, normalization, SQL title predicate, and contributor-credit predicate.
2. Remove episode `q` from URL state, debounce/input/query state, query identity,
   snapshots, first/continuation requests, strict API parser, cursor digest,
   normalization, and SQL.
3. Both list APIs reject `q` as unknown. Delete
   `podcast_credit_text_match_sql`, its sole import/call, dead
   `episode_selection()`, `_selection_query_value`, and orphan tests.
4. Replace `PodcastEpisodeSelection { state, query }` with `{ state }` for Mark
   Played and transcript forecast/request. Preserve the canonical selected-ID
   fingerprint and `E_SELECTION_CHANGED`.
5. While a local episode query is nonempty, both episode-wide commands remain
   visible but `aria-disabled`, use `disabledReason`
   **Clear Filter to use episode-wide actions**, and refuse activation.
   `ActionMenu` must keep described `aria-disabled` commands in roving focus so
   keyboard/screen-reader users can encounter the reason.
6. Rename stale action id `transcribe-unplayed` to `transcribe-episodes`.
   `mark-all-played` remains.

Exact state copy:

| State         | Transcript                          | Mark Played                             |
| ------------- | ----------------------------------- | --------------------------------------- |
| `all`         | Transcribe all episodes             | Mark all episodes as played             |
| `unplayed`    | Transcribe all unplayed episodes    | Mark all unplayed episodes as played    |
| `in_progress` | Transcribe all in-progress episodes | Mark all in-progress episodes as played |
| `played`      | Transcribe all played episodes      | All played episodes are already played  |

The played-state Mark item is disabled with reason
**Every episode in this state is already played.** Local-query reason takes
precedence while filtering. Per-row actions remain available.

This intentionally breaks the superseded list-query API. There is no ignored
`q`, legacy decoder, optional query member, dual server/local path, or feature
flag. Chooser/global-search query APIs are separate and remain.

## Hard Cut And Cleanup

- Delete Podcast subscriptions' inline submit form and `PaneToolbar`; rehome
  existing domain controls through the publication.
- Delete Podcast episodes' raw search input, debounce, and old
  `episodeFilterBar`; rehome its state/sort nodes through the publication.
- Delete converted panes' duplicate search state, URL decoding, CSS, and stale
  tests. Replace Page/Note private lowercase matching with the shared helper.
- Delete the now-empty Libraries `PaneToolbar` after moving Create Library.
- Preserve Resource Surface Add-item search, manual choosers, global Search,
  Nexus, browser Find, and excluded endpoints.
- No compatibility exports, fallback, generic filter schema/controller,
  alternate render path, or speculative abstraction.

## Files

Shared web owners:

- `apps/web/src/lib/panes/{paneSearch,panePublications}.ts`;
- `apps/web/src/lib/panes/{paneRouteModel,paneRouteModel.test}.ts`;
- new `apps/web/src/lib/panes/{usePaneFilterRows,paneRowFilter}.ts` and tests;
- `apps/web/src/lib/workspace/paneDom.ts`;
- `apps/web/src/components/workspace/{PaneSearchBar,PaneShell}.tsx` and tests;
- `apps/web/src/components/workspace/WorkspaceHost.test.tsx`;
- `apps/web/src/components/collections/CollectionView.tsx` and tests;
- `apps/web/src/components/ui/ActionMenu.tsx` and tests.

Domain web owners:

- `apps/web/src/app/(authenticated)/authors/[handle]/AuthorPaneBody.tsx`;
- `apps/web/src/app/(authenticated)/conversations/ConversationsPaneBody.tsx`;
- `apps/web/src/app/(authenticated)/libraries/{LibrariesPaneBody,[id]/LibraryPaneBody}.tsx`;
- `apps/web/src/app/(authenticated)/podcasts/PodcastsPaneBody.tsx`;
- `apps/web/src/app/(authenticated)/podcasts/[podcastId]/{PodcastDetailPaneBody,PodcastEpisodeList,useEpisodeTranscriptController}.{ts,tsx}`;
- `apps/web/src/app/(authenticated)/notes/{NotesPaneBody,[blockId]/NotePaneBody}.tsx`;
- `apps/web/src/app/(authenticated)/pages/[pageId]/PagePaneBody.tsx`;
- `apps/web/src/components/resource-surface/{ResourceSurfaceEditor,ResourceSurfaceBodyEditor}.tsx`;
- colocated styles and focused tests only where behavior changes.

Podcast API owners:

- `python/nexus/schemas/podcast.py`;
- `python/nexus/api/routes/{podcasts,podcast_transcripts}.py`;
- `python/nexus/services/contributor_credits.py`;
- `python/nexus/services/consumption/service.py`;
- `python/nexus/services/podcasts/{episodes,subscriptions_query,transcription}.py`;
- new selection-shape coverage in `python/tests/test_podcast_schemas.py`;
- focused service, route, cursor, command, and query-plan tests.

Update `docs/modules/{library,podcast,panes-tabs}.md`, the approved foundation
amendment status, and superseded Complete Collection Lists/Library clauses when
code lands.

## Implementation And Deployment

1. Land the shared publication/status, hook, collapsed marker, live region,
   focus helper, and immediate-row-change seam with simple inventory producers.
2. Cut over Author, Conversations, Libraries, and Notes index; move Create
   Library to `SectionOpener.actions`.
3. Cut over Library entries while preserving requested/committed continuity and
   domain view semantics.
4. Cut over Page/Note matching and inspection-only filtered rendering.
5. Hard-cut Podcast web/API query transport, selection schema, contributor SQL,
   action accessibility/copy, and raw search UI together.
6. Delete residue, update governing docs, then run focused, API, accessibility,
   and active-pane end-to-end proof.

The breaking Podcast API and web callers deploy in one maintenance window:
make the app unavailable, deploy API and web, hard-reload, run subscription,
episode-filter, transcript-forecast, and Mark Played smoke checks, then restore
access. Neither side deploys independently; no compatibility interval exists.

Each surface lands atomically with its old search path removed.

## Acceptance Criteria

1. Every in-scope pane publishes exactly one amended `FilterRows`; active-pane
   `Cmd/Ctrl+F` works and `Cmd/Ctrl+K` remains global.
2. Query changes synchronously filter exact fields with NFC/lowercase literal
   semantics, stable domain order, no request/URL/snapshot change, and no View
   Transition.
3. Partial and Complete visible counts receive the exact debounced polite
   announcement; no visible count/ordinal chrome appears.
4. Non-default domain controls remain applied after Close and are visibly and
   accessibly discoverable from the collapsed Filter action.
5. Expanded controls retain native labels, semantics, 320px reflow, focus
   retention, and presence through empty/pending/failure states.
6. Visual folios show complete domain-view totals and ignore local query.
   Podcast folios no longer mean server-`q` result count.
7. Library requested/committed continuity, exhaustive loading, revisions,
   domain transitions, and URL-owned `LibraryEntryView` remain intact.
8. Query-key changes bypass `CollectionView` transitions; same-key mutations
   and domain commits retain current transition classification.
9. Mutation focus recovery uses the exact visible semantic neighbor, then
   Search input/mounted Filter action or mobile Options trigger. Newly appearing
   rows never steal focus.
10. Complete filtered-empty and Partial-no-match states use exact Filter copy,
    never a domain-zero state.
11. Page/Note searches one direct optimistic level, preserves authored order,
    never dereferences, locks only direct-item editing, and announces why.
12. Podcast list APIs reject `q`; cursor identities, schemas, SQL, contributor
    helper, and `PodcastEpisodeSelection` contain no text query.
13. Episode-wide commands use exact state copy, remain discoverably disabled
    during local filtering, preserve selected-ID fingerprinting, and per-row
    actions remain.
14. Create Library uses `SectionOpener.actions`; Create Page, Today, Browse,
    import/export, and page actions remain independently reachable.
15. Close/Escape is single-stage; source replacement, inactivity, optimistic
    mutation, and zero-match behavior follow this contract.
16. Pure matcher/hook/contract tests, owner component tests, strict Podcast
    schema/service/API tests, ActionMenu accessibility tests, and one
    desktop/mobile-width active-pane Playwright journey pass.
17. No new endpoint, database change, virtualization, generic
    registry/context/schema/controller, compatibility path, or fallback lands.
18. Web/API deploy atomically and the four named production smokes pass before
    access resumes.

## Verification Record

AC1–17 are source-verified:

- focused matcher, hook, pane-shell, collection-owner, route-continuity,
  accessibility, and Podcast web tests pass;
- web typecheck, scoped lint, CSS-token lint, and diff checks pass;
- Podcast schema tests pass 5/5; exact real-stack service/API tests pass 4/4;
  scoped Ruff and all nine residue gates pass;
- the exact production-mode desktop/mobile active-pane Playwright journey
  passes 1/1.

AC18 remains pending production deployment authority. Do not mark this cutover
complete until the atomic maintenance deployment and all four production smokes
pass.

## Residue Gates

```text
rg -n 'appliedSearch|searchText|episodeSearch(Input|Query)|EPISODE_SEARCH_DEBOUNCE_MS|Search followed podcasts|Search episodes' apps/web/src/app/\(authenticated\)/podcasts
rg -n 'params\.set\("q"|paneSearchParams\.get\("q"|query:\s*episodeSearch' apps/web/src/app/\(authenticated\)/podcasts
rg -n 'podcast_credit_text_match_sql|normalize_episode_query|_selection_query_value|episode_selection\(|selection\.query|q_pattern' python/nexus/api/routes/podcasts.py python/nexus/api/routes/podcast_transcripts.py python/nexus/schemas/podcast.py python/nexus/services/contributor_credits.py python/nexus/services/podcasts
rg -n 'Mark matching episodes|Transcribe matching episodes|transcribe-unplayed' apps/web/src/app/\(authenticated\)/podcasts
rg -n '<PaneToolbar|type="search"' apps/web/src/app/\(authenticated\)/{authors,conversations,libraries,notes,pages,podcasts}
rg -n 'rowFilterQuery.*toLowerCase|visibleItemText\(.*\)\.toLowerCase' apps/web/src/components/resource-surface
rg -n 'setFilterState|sourceRef === filterState\.sourceRef' apps/web/src/app/\(authenticated\)/{authors,conversations,libraries,notes,pages,podcasts}
rg -n 'Pane(Filter|Search)(Registry|Context)|Universal(Collection|Pane).*Filter|searchFields.*CollectionRowView' apps/web/src
rg -n 't[y]pe PaneFilterRowsPublication|i[n]terface PaneFilterRowsPublication' docs/cutovers/collection-pane-search-filter-sort-hard-cutover.md
```

Expected residue, by gate:

1. Zero old Podcast query/input/debounce symbols, including the exact `_MS`
   constant.
2. Zero pane-query transport in Podcast web owners.
3. Zero Podcast list/selection text-query schema, normalization, SQL, or dead
   constructors in the named backend owners.
4. Zero “matching” command copy and zero stale action id.
5. Zero route-owned `PaneToolbar` or raw search input in converted panes.
   Shared `PaneSearchBar` retains the sole Pane Search `PaneToolbar`; Resource
   Surface Add-item search remains outside these route paths.
6. Zero private Page/Note lowercase matcher. The `rowFilterQuery` prop remains.
7. Zero route-local source-keyed query-state copies; the shared hook remains.
8. Zero forbidden registry, context, universal filter schema, or
   `CollectionRowView` search-field expansion.
9. Zero child restatement of the foundation publication type.
