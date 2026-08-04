# Collection Refinement Capability Hard Cutover

Status: IMPLEMENTED — 2026-08-03
Type: hard cutover
Date: 2026-08-03

Open questions: none.

Governing contracts:

- [`pane-search-foundation-hard-cutover.md`](pane-search-foundation-hard-cutover.md)
- [`collection-pane-search-filter-sort-hard-cutover.md`](collection-pane-search-filter-sort-hard-cutover.md)
- [`complete-collection-lists-hard-cutover.md`](complete-collection-lists-hard-cutover.md)
- [`library-sorting-hard-cutover.md`](library-sorting-hard-cutover.md)
- [`library-entry-type-filter-and-filter-row-reflow-hard-cutover.md`](library-entry-type-filter-and-filter-row-reflow-hard-cutover.md)
- `docs/rules/{boundaries,cleanliness,codebase,control-flow,database,errors,frontend,index,naming,simplicity,tagged-unions,testing}.md`

This spec supersedes the collection cutover's no-new-domain-sort boundary only
for the exact surfaces and orders below. Imported Pane Search, pagination,
Library, Podcast, Page/Note safety, and retrieval contracts remain authoritative.

## Decision

Make primary collection panes instances of one refinement grammar:

```text
Filter text -> domain controls -> Clear filters
                 View / Filter / Sort by
```

The shell owns the grammar. Each domain owns a closed view type, URL codec,
options, request identity, server query, total order, cursor, and match fields.

This is a capability expansion, not a universal query engine. Do not add a row
metadata schema, runtime registry, generic controller, Boolean AST, or client
sorting of pageable rows.

## Goals

- Close the primary refinement gaps with existing primitives.
- Use identical labels, lifecycle, Clear/Escape behavior, focus, and responsive
  presentation while keeping options domain-specific.
- Preserve canonical/authored order and existing collection defaults.
- Make every navigable domain view strict, URL-addressable, deterministic, and
  exactly pageable.
- Remove permissive and duplicated view paths touched by the cutover.

## Scope

In scope:

1. Add local `FilterRows` and factual view sorting to Lectern.
2. Add factual view sorting to Author works, Chats, Libraries, and Notes index.
3. Keep existing Library, Podcast-subscription, and Podcast-episode capabilities;
   standardize `Sort by` copy and hard-cut permissive Podcast URL decoding.
4. Add the owner codecs, API query support, cursor plans, focused tests, module
   docs, and static capability/exemption matrix required by this spec.

Explicit exemptions:

- Browse, Search, and Preview are retrieval surfaces with body-owned query,
  facets, ranking, and provider continuation.
- Page/Note direct items preserve authored order and retain local inspection-only
  Filter behavior.
- Chat messages, TOCs, chapters, transcripts, sources, citations, trust trails,
  fork trees, navigation, menus, settings choices, destination pickers, and
  ranked Slate/Related lists retain semantic owner order.

## Non-goals

- New facets, facet counts, totals, grouping, layout choice, multi-sort, saved
  views, smart collections, preferences, or filter persistence.
- Fuzzy, semantic, full-text, operator, query-language, AI, recommendation, or
  personalization work.
- Connections, Downloads, Library members/invites, choosers, overlays, Preview
  episodes, Stats tables, or other secondary lists.
- New text-search endpoints, virtualization, client databases, snapshots,
  caches, feature flags, or generic sort/filter APIs.
- Changing canonical defaults, Library/Podcast server semantics, Page/Note
  structure, Browse federation, or Search ranking.
- Speculative migrations or indexes. Add an owner-specific index only when the
  accepted high-cardinality query fails its measured plan budget.

## Target Behavior

1. `Filter` and `Cmd/Ctrl+F` use the existing Pane Search row. The text query is
   immediate, visit-local, request-free, URL-free, and source-keyed.
2. Every in-scope sort renders as one visibly labelled native `Sort by` select
   in `publication.filters`. Options use complete labels such as
   `Title — A–Z`; no separate direction control exists.
3. Selecting a sort replaces the current pane URL. Defaults are omitted. Reload,
   Back/Forward, pane restoration, request cache, and continuation restore the
   exact view.
4. Unknown, duplicate, empty, redundant-default, or inapplicable owned URL/API
   keys are invalid. Render `Invalid {surface} view` with `Reset view`; make no
   collection request. Never normalize or silently default invalid state.
5. A same-path domain-view change retains the local text query, expanded row,
   initiating control focus, pane scroll, and prior committed rows until the
   exact first page commits. Only the latest requested view may commit.
6. A non-default sort contributes one to `activeDomainControlCount`. Collapsed
   chrome retains the existing active marker and spoken count.
7. Escape/Close clears local text, collapses, and retains the domain view. The
   existing `Clear filters` action clears local text and installs the canonical
   domain view. Controls remain available through loading, failure, and zero rows.
8. Domain membership/projection applies first, then local text, with the selected
   domain order final. Header folios describe the exhaustive domain view, never
   the local subset.
9. Domain view commits retain collection reflow transitions. Text-filter commits
   remain immediate and transition-free. Reduced motion changes no semantics.
10. Mutations reconcile the exact committed view and retain existing focus-neighbor
    recovery. Continuation is disabled during requested/committed mismatch.
11. Lectern alternate sorting is a reversible view over its complete bounded
    snapshot. It never calls `SetOrder`; drag reorder is available only in
    `Custom order` with no local text query. Membership and consumption commands
    remain ID-addressed and available.

## Capability Contract

| Surface | Local match fields | Canonical/default view | `Sort by` options | Execution |
| --- | --- | --- | --- | --- |
| Lectern | title; presented subtitle | Custom order | Custom order; Added — newest/oldest; Title — A–Z/Z–A | client over complete snapshot |
| Author works | work title | Published — newest | Published — newest/oldest; Title — A–Z/Z–A | owner SQL before keyset |
| Chats | chat title | Updated — newest | Updated — newest/oldest; Title — A–Z/Z–A | owner SQL before keyset |
| Libraries | presented Library name | Created — oldest | Created — oldest/newest; Name — A–Z/Z–A | owner SQL before keyset |
| Notes index | Page title | Updated — newest | Updated — newest/oldest; Title — A–Z/Z–A | owner SQL over complete result |
| Library entries | existing fields | existing canonical view | existing contract | unchanged |
| Podcast subscriptions | existing fields | Recent Episode | existing filters/scopes; `Sort by` Recent Episode/Most Unplayed/Title — A–Z | existing owner query |
| Podcast episodes | existing fields | Newest | existing state; `Sort by` Newest/Oldest/Shortest/Longest | existing owner query |
| Page/Note direct items | existing direct fields | Authored order | no sort | existing inspection Filter |

The matrix is documentation and test input, not a production runtime registry.
Every primary collection must be represented here or explicitly exempted in
Scope.

## Domain Schemas

Use closed discriminated unions; do not model correlated optional fields.

```text
Direction = Asc | Desc

LecternView = Custom | Added { direction } | Title { direction }
AuthorWorksView = Canonical | PublishedOldest | Title { direction }
ConversationIndexView = Canonical | UpdatedOldest | Title { direction }
LibrariesIndexView = Canonical | CreatedNewest | Name { direction }
NotesIndexView = Canonical | UpdatedOldest | Title { direction }
```

`Canonical` is the existing default order and sole omitted representation.
Frontend view modules solely own type, option inventory, labels, strict URL
decode/encode, API query construction, active-state test, and view formatting.
Backend owners map transport values directly into equivalent rich types.

Do not create a shared `CollectionViewSpec`. Small local option-label duplication
is cheaper than moving domain vocabulary into a hollow abstraction.

## API Design

New owner query keys:

```text
GET /contributors/{handle}/works
  ?sort=published|title&direction=asc|desc
  &cursor&collection_revision&limit

GET /conversations
  ?scope=mine|all|shared
  &sort=updated|title&direction=asc|desc
  &cursor&collection_revision&limit

GET /libraries
  ?sort=created|name&direction=asc|desc
  &cursor&collection_revision&limit

GET /notes/pages
  ?sort=updated|title&direction=asc|desc
```

Defaults omit both keys. The only valid non-default pairs are:

| Endpoint | Valid non-default pairs |
| --- | --- |
| Author works | `published+asc`; `title+asc|desc` |
| Conversations | `updated+asc`; `title+asc|desc` |
| Libraries | `created+desc`; `name+asc|desc` |
| Notes | `updated+asc`; `title+asc|desc` |

`sort` or `direction` alone, explicit default pairs, unknown values, duplicate
keys, and view keys in conversation chooser/context modes fail
`400 E_INVALID_REQUEST`.

Use `parse_collection_query(..., domain_keys={"sort", "direction", ...})` for
revisioned lists and a strict owner parser over `request.query_params.multi_items()`
for Notes. Existing response envelopes remain unchanged.

Lectern remains `GET /lectern` with no query parameters. Atomically add required
`addedAt: AwareDatetime` to every `LecternItemOut`; project the existing queue
`added_at` fact and hard-cut the web decoder in the same release. Lectern view
state is frontend pane-URL state and never reaches the API.

Podcast API parameters remain unchanged. Their frontend URL codecs become strict,
total `Valid | Invalid` decoders; default `filter/state/sort` values are omitted.

Next.js routes forward the incoming query unchanged and own no view defaults,
validation, or compatibility behavior.

## Ordering And Cursor Rules

Every advertised order is total, stable, and generated by one owner order-plan
function used for `ORDER BY`, keyset predicate, cursor values, and cursor kinds.

- Published: missing date last in both directions; date direction; title ASC;
  outward work href ASC.
- Author title: `lower(btrim(title))` direction; raw title direction; missing/date
  newest; outward href ASC.
- Chat updated: `updated_at` direction; conversation id same direction.
- Chat title: presented-title key
  `coalesce(nullif(btrim(title), ''), 'Untitled chat')`, lowercased, direction;
  presented title direction; `updated_at DESC`; id DESC.
- Library created: `created_at` direction; Library id same direction.
- Library name: presented-name key (`All` when `is_default`, else authored
  `name`), trimmed/lowercased, direction; presented name direction; id ASC.
- Notes updated: `updated_at` direction; title ASC; Page id ASC.
- Notes title: `lower(btrim(title))` direction; raw title direction;
  `updated_at DESC`; Page id ASC.
- Lectern Added/Title use the same primary semantics and `itemId ASC` final tie;
  Custom uses canonical position.

Do not strip leading articles or fabricate missing facts. Direction changes the
semantic primary key; listed secondary keys remain as specified.

Version the three changed signed cursor families. Bind every cursor to viewer,
scope/resource identity, cursor-family version, exact effective view, revision,
and final key. Old-family, tampered, cross-view, cross-scope, and cross-viewer
cursors fail `400 E_INVALID_CURSOR`; add no compatibility decoder.

## Intra-System Composition

```text
pane URL
  -> strict domain frontend codec (Invalid makes zero request)
  -> requested view + owner-built API query/cache identity
  -> BFF exact forwarding
  -> strict route parse + backend domain view
  -> authorized base relation
  -> domain membership/filter -> order plan -> keyset -> limit+1
  -> strict existing response decoder
  -> committed exact-view exhaustive drain
  -> domain presenter + explicit local match fields
  -> visit-local Filter query
  -> CollectionView
```

The URL is requested state. Each pane controller commits
`{view, rows, collectionRevision, nextCursor, exhaustion}` atomically. A query
change starts a new first-page chain; only the committed exact view may continue.
Existing mutation seams and collection-revision bumps remain authoritative.

For Notes, the endpoint is exhaustive and has no cursor/revision contract; SQL
still owns ordering and the response commits as one exact view.

## Structure And Reuse

- Reuse `PaneFilterRowsPublication`, `usePaneFilterRows`, Pane Search chrome,
  `usePaneUrlState`, `CollectionView`, `Select`, exhaustive pagination,
  `CollectionPage`, `parse_collection_query`, collection revisions, and signed
  keyset cursors.
- Adapt `libraryView.ts` as the strict owner-codec reference without moving
  Library vocabulary into shared code.
- Keep domain controls as React nodes in `publication.filters`; standardize
  grammar and labels, not state ownership.
- In `resource.ts`, collapse the duplicate contributor/library collection-page
  suffix builders into one private page-query helper; domain view modules build
  their own view query.
- Extract Podcast URL state from pane components into sole-owner view modules.
  Delete permissive decoder functions, episode URL-mirroring component state,
  and effect-based URL synchronization.
- Delete old cursor-family acceptance, duplicate sort derivations, client sort of
  pageable rows, fallback defaults, compatibility exports, and orphaned tests or
  styles encountered in touched paths.

## Files

Add:

- `apps/web/src/lib/lectern/view.ts`
- `apps/web/src/lib/contributors/workView.ts`
- `apps/web/src/lib/conversations/indexView.ts`
- `apps/web/src/lib/libraries/libraryIndexView.ts`
- `apps/web/src/lib/notes/pageIndexView.ts`
- `apps/web/src/lib/podcasts/subscriptionView.ts`
- `apps/web/src/lib/podcasts/episodeView.ts`
- focused pure codec/order tests beside each new view module
- focused API/service, component/browser, and E2E behavior tests

Modify:

- `apps/web/src/lib/api/resource.ts`
- `apps/web/src/lib/{contributors/api,conversations/indexApi,lectern/contract}.ts`
- the in-scope pane bodies under
  `apps/web/src/app/(authenticated)/{lectern,authors,conversations,libraries,notes,podcasts}`
- `python/nexus/api/routes/{contributors,conversations,libraries,notes}.py`
- `python/nexus/schemas/consumption.py`
- `python/nexus/services/{contributors,conversations,library_governance,notes}.py`
- `python/nexus/services/consumption/_projection.py`
- applicable module docs: `docs/{architecture.md,modules/{chat,library,panes-tabs,podcast,workspace}.md}`

Verify unchanged unless a behavior test exposes forwarding drift:

- `apps/web/src/app/api/{contributors,conversations,libraries,notes,lectern}/**/route.ts`
- shared Pane Search, `CollectionView`, page envelope, cursor, and revision owners

Final file scope follows actual ownership. Do not create forwarding wrappers,
barrels, generic `collectionViews` directories, or parallel APIs to match this
planning inventory.

## Hard-Cut Residue Gates

The final tree contains zero:

- permissive or fallback decoding for in-scope view keys;
- duplicated component state mirroring URL-owned Podcast view state;
- old cursor-family decoding or legacy query aliases;
- local sorting of revisioned/pageable collections;
- temporary dual old/new controls, feature flags, compatibility exports, or
  migration comments after cutover;
- universal row search fields, runtime collection registry, generic refinement
  controller, or query/facet DSL.

## Delivery Workflow

1. Write failing pure codec/order and API behavior tests from Acceptance first.
2. Land backend rich view types, strict parsing, order plans, versioned cursors,
   and Lectern `addedAt`; verify real-database page equality and plans.
3. Land frontend owner codecs/resources/controllers and Podcast cleanup.
4. Add shared controls to each pane one domain at a time; remove old paths in
   the same change.
5. Update final-state module docs, run residue searches, then complete desktop,
   mobile, E2E, and full repository verification.
6. Release API and web atomically. No intermediate payload or query shape is a
   supported state.

## Measured Plan Budgets

Measured with `EXPLAIN (ANALYZE, BUFFERS)` on the local test PostgreSQL at the
migrated head, seeded with 20,000 owned chats and 20,000 owned Pages — roughly
twenty times any realistic single-user volume:

| Accepted query | Plan | Execution |
| --- | --- | --- |
| Chats canonical, first page | Index Scan `idx_conversations_owner_updated_at` + Incremental Sort | 0.13 ms |
| Chats `Title — A–Z`, first page | Seq Scan + top-N heapsort (49 kB) | 26.1 ms |
| Chats `Title — A–Z`, mid-drain keyset page | Seq Scan + top-N heapsort (49 kB) | 41.4 ms |
| Notes canonical, exhaustive | Seq Scan + quicksort (2.8 MB) | 7.6 ms |
| Notes `Title — A–Z`, exhaustive | Seq Scan + quicksort (3.4 MB) | 66.3 ms |

Every sort completes in memory; none spills to disk. The Libraries index is
bounded by a viewer's membership count, and Author works reuses the pre-existing
distinct-works relation and changes only its sort key, so neither adds a new
scan. **No index was added:** every accepted high-cardinality query meets its
budget, and a functional index on a presented-title expression would have no
owning query that fails without it.

## Acceptance Criteria

1. Every in-scope and existing primary collection matches the capability matrix
   or is explicitly exempted.
2. Lectern filters title/subtitle locally and sorts complete rows without calling
   `SetOrder`; reorder exists only in unfiltered Custom order.
3. Author, Chats, Libraries, and Notes expose the exact `Sort by` inventories,
   preserve existing defaults, and restore exact non-default views from URL.
4. Revisioned filtering/order executes before keyset and `limit+1`; concatenated
   pages equal one stable real-database snapshot with no duplicate or skipped row.
5. Equal keys, missing publication dates, Unicode text, empty titles where legal,
   and both directions satisfy the specified total orders.
6. Cursors reject tamper, old family, changed view/revision, cross-scope,
   cross-resource, and cross-viewer replay.
7. Unknown, duplicate, partial, explicit-default, and inapplicable URL/API states
   fail visibly and make no unintended request.
8. Same-path view replacement retains local text, focus, pane scroll, and prior
   committed rows until one latest-wins atomic commit; reload and Back/Forward
   restore the exact view.
9. Escape retains domain state; Clear resets domain state and local text; active
   counts, partial/complete announcements, folios, zero states, failures, and
   mutation-neighbor focus remain truthful.
10. `Sort by` controls remain labelled, keyboard-operable, and usable at 320px,
    200%/400% zoom, forced colors, reduced motion, coarse pointer, and
    always-visible scrollbars without horizontal chrome panning.
11. Accepted high-cardinality queries meet measured `EXPLAIN ANALYZE` budgets;
    any new index has evidence and an owning accepted query.
12. Static analysis, build, unit, real-database integration, browser/component,
    focused E2E, and routine/full repository gates pass under `docs/rules/testing.md`.
13. All Hard-Cut Residue Gates return zero findings and the final change lowers
    total duplication/complexity in touched paths.
