# Library All And Smart Views Hard Cutover

Status: IMPLEMENTED — 2026-07-27 (source cutover complete and focus-verified;
the production preflight, production-fixture query-plan comparison, and the
backend-first Hetzner/Vercel release in §Production Release remain release-time
operational steps)

Verification record — 2026-07-27:

- Backend: focused integration suites green — `test_libraries.py` +
  `test_atlas.py` + `test_resource_graph_resolve.py` + `test_resource_targets.py`
  + `test_search_candidates.py` (290 passed; one pre-existing unrelated teardown
  error in `TestListLibraryMedia::test_list_media_projects_document_reading_time_policy`
  reproduces at the pre-cutover HEAD). Local plan gate
  `test_library_entry_plans.py` green (12 EXPLAIN ANALYZE cases, no spill /
  correlated scan; no index added). Reserved-name preflight: zero conflicting
  rows.
- Frontend: `tsc --noEmit` clean; focused unit + browser suites green across the
  view codec (111), presentation/revision stores, pane (60), libraries list,
  destination components, publishers, and the placement residue enumeration.
- Adversarial review: multi-agent review over the full diff; six confirmed
  findings (four major pane revision races, two minor) and eight
  verifier-starved claims all fixed and re-tested.
- E2E: both specs updated (All/Unfiled/In Progress journey authored,
  statically typechecked); real-stack run deferred to the release window.

Type: hard cutover. No feature flag, legacy view shape, compatibility cursor,
fallback parser, dual product copy, or released intermediate state.

Open questions: none. Product decisions are fixed in this document.

Governing contracts:

- `docs/rules/{boundaries,cleanliness,control-flow,database,frontend,naming,simplicity,testing}.md`
- `docs/modules/library.md`
- `docs/cutovers/{default-library-virtualization-and-transient-state-pruning,library-sorting,library-entry-view-continuity,library-placement-resource-action}-hard-cutover.md`
- `deployment.md`
- `deploy/hetzner/README.md`

Normative copy superseded here:

- `docs/cutovers/add-content-intake-hard-cutover.md`
- `docs/cutovers/android-share-library-destinations-hard-cutover.md`

Sequencing:

- This cutover is the required predecessor of
  [`library-chooser-interaction-hard-cutover.md`](library-chooser-interaction-hard-cutover.md).
  Complete and verify this cutover before implementing that one; do not edit
  their shared picker, placement, Add, or Library-query owners concurrently.
- This document owns Default → All identity, reserved-name behavior, and
  destination meaning/copy. The downstream chooser cutover owns and supersedes
  only chooser component topology, surface behavior, search ordering/cursor,
  and interaction.

## Decision

Present the existing Default library as **All** on the closed identity surfaces
enumerated below. Preserve its internal `is_default` identity, storage row, API
fields, permissions, and virtual personal-set semantics.

Add two fixed, non-owning Library entry projections:

- **Unfiled** — available only in All.
- **In Progress** — available in All and every named or system Library.

They are URL-owned query projections over current facts. They are not Libraries,
resources, saved searches, tags, preferences, or persisted collections.

## Goals

- Make All's retrieval role legible without changing the Default domain model.
- Make unfiled work immediately findable and organizable.
- Make current consumption activity findable within any Library.
- Reuse the existing Library view, exact cursor, in-place request, placement,
  consumption, toolbar, focus, and `CollectionView` owners.
- Leave one small seam that can accept another proven fixed projection without
  building a generic smart-view platform.

## Scope

In scope:

- Browser-facing Default → All presentation.
- `All items | Unfiled | In Progress` Library entry projection selection.
- Exact URL/API parsing, server filtering, cursor binding, pagination, empty
  states, placement/consumption reconciliation, accessibility, tests, and docs.
- The `All` reserved-name rule, production-data preflight, and Library-name
  projection in user-facing resource-target search, Dossier labels, and Atlas
  constellation labels. This is an identity-alias correction, not a subsystem
  redesign.
- Removal of superseded product copy and old Library view/cursor shapes.
- Query-plan evidence and backend-first production release/rollback gates.

Out of scope:

- Renaming `is_default`, `default_library_id`, service functions, database rows,
  seeded internal names, or backend domain terminology.
- Smart-view entities, ids, tables, CRUD, sharing, counts, sidebar children,
  user-authored predicates, or preference persistence.
- Tags, folders, nested Libraries, AI filing, recommendation changes, or Slate
  filtering.
- Podcast-show progress aggregation. Podcast-show container entries never
  appear in In Progress; podcast-episode Media may appear through canonical
  Media consumption facts.
- Search ranking/taxonomy, Atlas behavior, Library Intelligence behavior, Dossier
  generation, Members, or native-shell API redesign.
- Rewriting previously generated Dossier prose that happens to contain the
  stored internal name.
- Push/realtime consistency across tabs, devices, browser processes, or
  background server writers. Re-activation and reload read current truth.
- A migration, cache, worker, materialized view, snapshot, or speculative index.
  If measured plans require an index, stop and amend this spec before adding it.

## Target Behavior And Final State

### Presentation

- The closed alias boundary is the Default Library row, pane title, pane label
  hint, accessibility name, resource-target result, Dossier Library label, and
  Atlas constellation label. Each presents **All**.
- The Default row secondary text is exactly **Across your libraries**.
- Internal code and APIs continue to call the domain object Default.
- Global Media removal copy is exactly **Delete "{title}" from All and libraries
  you manage? This cannot be undone.**
- **Added to Nexus** remains ingestion/time copy; it is not a Library identity
  alias and is not rewritten.
- Named Libraries retain their authored names except that **All** is reserved.
- Create and rename reject a non-default name whose trimmed Unicode-casefolded
  value is `all` with `400 E_NAME_INVALID`. A trusted system Library with that
  name is a defect. Create/rename drafts and picker creation suppress submission
  and show **All is reserved for the All view.** There is no suffix-based
  disambiguation.
- Production preflight must find zero non-default rows with that normalized
  name. Rename an ordinary conflict through the supported product/admin path. A
  system conflict blocks this release and requires a separately approved
  remediation. There is no automatic data rewrite or migration.
- One frontend helper owns the presentation:

```ts
libraryPresentation(library) =
  library.isDefault
    ? { name: "All", context: "Across your libraries" }
    : { name: library.name, context: library.role }
```

No component independently derives the Default display name. Server-owned
Library candidates match **All** when `is_default`; Library, Library-Dossier,
and Atlas labels project **All**. The stored seeded name is neither displayed
nor retained as a legacy search alias.

### Destination copy

Writable destination selection describes selected, additional, non-default
Libraries. It never claims to describe the complete placement set.

- Empty Media intake/Android Share selection: **No additional libraries**.
- Empty podcast subscription/OPML selection: **No libraries selected**.
- Destination field/picker contracts require caller-owned `emptyLabel`;
  `LibraryDestinationDisclosure` forwards it until the downstream chooser
  cutover replaces that component. Shared components define no semantic
  default.
- **Unfiled** is reserved for the derived All projection below. Empty selection
  never implies Unfiled, and assignment remains additive.

### View selector

The Library toolbar contains:

- visibly labelled `View` select;
- existing visibly labelled `Sort by` select;
- existing `Hide finished` checkbox when the selected projection supports it.

Options:

| Library | View options |
|---|---|
| All | All items, Unfiled, In Progress |
| Named or system | All items, In Progress |

Use the existing `Select` and `PaneToolbar`; do not add tabs, chips, a new
navigation level, or a smart-view component system.

Projection changes preserve the selected order. `All items ↔ Unfiled` preserves
the completion filter. Entering In Progress removes completion. Leaving In
Progress starts with finished items shown. No hidden per-projection state exists.

### Projection semantics

`All items` is the current complete Library entry set.

`Unfiled(media)` is true exactly when:

1. the requested Library is the viewer's own Default Library;
2. the Media has a direct physical entry in that Default Library; and
3. no physical entry for that Media exists in another current, non-system
   Library membership visible to the viewer.

Read-only shared Libraries count as filing. System Libraries and inaccessible
foreign Libraries do not. A shared-only item visible through All is not
Unfiled.

`In Progress(media)` is true exactly when the canonical consumption fact
relation returns `read_state = 'InProgress'`. Missing, Unread, and Finished facts
do not match. Podcast-show entry rows do not match.

Projection and completion filters compose before ordering and pagination.

## Capability Contract

```text
LibraryEntryProjection =
  | AllItems { completion: All | Unfinished }
  | Unfiled { completion: All | Unfinished }
  | InProgress

LibraryEntryView {
  order: Canonical | Title(direction) | Creator(direction)
       | Published(direction) | Added(direction)
  projection: LibraryEntryProjection
}
```

Rules:

- The union makes `InProgress + Unfinished` unrepresentable.
- Unfiled is valid only for Default.
- Factual ordering remains orthogonal to projection.
- Reorder is valid only for editable non-default `Canonical + AllItems(All)`
  with every page loaded.
- Projection availability is deterministic from trusted `LibraryOut.isDefault`;
  no new backend capability field is added.
- The API revalidates every projection against the requested Library.

## API Design

Reuse the only Library entry endpoint:

```text
GET /libraries/{library_id}/entries
  ?projection=unfiled|in-progress
  &completion=unfinished
  &sort=title|creator|published|added
  &direction=asc|desc
  &cursor=<opaque>
  &limit=<int>
```

Omissions:

- omitted `projection` means `AllItems`;
- omitted `completion` means `All`;
- canonical `AllItems(All)` emits neither key.

Validation:

- unknown or duplicate query keys fail `400 E_INVALID_REQUEST`;
- unsupported projection values fail `400 E_INVALID_REQUEST`;
- `projection=unfiled` on non-default fails `400 E_INVALID_REQUEST`;
- `projection=in-progress&completion=unfinished` fails
  `400 E_INVALID_REQUEST`;
- the existing strict sort/direction/completion rules remain;
- the Next.js BFF forwards the query and owns no defaults.

The response envelope and `LibraryEntryOut` do not change.

### Boundary

The FastAPI route consumes `request.query_params.multi_items()` and produces one
narrow request before calling the service:

```text
LibraryEntriesRequest {
  view: LibraryEntryView
  limit: PositivePageLimit
  cursor: Absent | EncodedLibraryEntryCursor
}
```

Unknown and duplicate keys are rejected there. Raw query strings and loose
projection values never reach query composition. Cursor syntax is narrowed at
the boundary; authentication and view-plan decoding occur in the Library entry
owner after authorization supplies the required viewer/Library context.

### Cursor

Hard-cut to `library_entries:view:v2`.

The cursor is:

```text
body = canonical JSON {
  v: 2,
  q: SHA-256(canonical { viewerId, libraryId, exact LibraryEntryView }),
  after: [exact tagged key values]
}
token = unpadded base64url(body || HMAC-SHA256(domainKey, body))
```

Requirements:

- the body has exactly `after`, `q`, and `v`; `q` is exactly 64 lowercase hex
  characters; every nested object rejects extra or missing keys;
- canonical JSON uses sorted keys, compact separators, and UTF-8;
- base64url is unpadded and must round-trip byte-for-byte;
- every keyset value has one exact tag/type; timestamps are canonical UTC
  RFC3339, UUIDs are canonical lowercase, and strings/numbers are never coerced;
- the viewer UUID is bound through `q` and the MAC but is not serialized;
- HMAC-SHA256 uses a domain-separated key derived from the existing effective
  stream-token signing root; compare authentication tags in constant time;
- decoding accepts exactly the current view's key count, order, tags, and types;
- extra/missing keys, noncanonical encoding, bad authentication, wrong viewer,
  Library, order, projection, completion, or cursor kind fail
  `400 E_INVALID_CURSOR`.

Follow the existing authenticated consumption-cursor algorithm and key source;
keep the tagged Library keyset codec local to `library_entries.py`. Do not build
a generic pagination framework.

There is no v1 decoder or v1-specific test. Generic malformed,
authentication, wrong-domain, and wrong-binding tests prove the closed current
contract.

### Pagination consistency

Each HTTP request sees one read-only repeatable-read snapshot. A cursor does not
create a multi-request historical snapshot:

- when membership, placement, projection, completion, and ordered facts are
  unchanged, continuation returns every remaining row exactly once;
- an insertion or move above the consumed boundary appears only after refresh;
- deletion removes the row;
- a concurrent fact crossing the keyset boundary may be omitted or repeated;
- a same-process definitive mutation invalidates the local traversal and starts
  the exact requested view from its first page.

A stale/deployment-era cursor is never reinterpreted. Load More presents
**This list can no longer continue.** with **Refresh list**; that action discards
the cursor and requests the first page of the same exact view.

## Backend Architecture

`python/nexus/services/library_entries.py` remains the only Library entry view
coordinator:

1. authorize current Library membership;
2. build the complete physical or Default virtual membership;
3. apply the projection predicate;
4. apply completion where the projection carries it;
5. compose existing factual sort relations;
6. apply the total order and exact keyset;
7. fetch `limit + 1`;
8. hydrate only returned rows.

Unfiled extends the existing Default membership query. It requires the direct
Default representative and a viewer-membership-scoped `NOT EXISTS` over other
non-system `library_entries`. It never infers filing from the hydrated
representative row.

In Progress composes the existing
`consumption.service.engagement_fact_rows_sql()` relation. Library code does not
reimplement consumption policy.

The existing `(media_id, library_id)` index is the initial query support.

### Performance release gate

Before implementation, capture the corresponding current `AllItems` plans.
Before release, capture `EXPLAIN (ANALYZE, BUFFERS)` against the same recorded,
production-like fixture for:

- Default `AllItems`, `Unfiled`, and `InProgress`;
- non-default `AllItems` and `InProgress`;
- every supported order and completion combination;
- first and continuation pages at `limit=100`.

Record fixture cardinalities, elapsed time, rows, loops, buffer reads/hits, and
sort spill. Release is blocked by a candidate-correlated full scan, disk spill,
unbounded continuation work, or a greater-than-2x regression in elapsed time or
buffer work for an existing `AllItems` case. After one warm-up, a new-projection
case must also complete within the greater of 250 ms or 2x its corresponding
`AllItems` baseline. Add no index speculatively; if this gate requires one, stop
and amend this document with that single measured index and migration.

## Frontend Architecture

`apps/web/src/lib/libraries/libraryView.ts` remains the sole frontend owner of:

- the closed view types;
- strict URL decode/encode;
- API query construction;
- available projection and order options;
- exact product labels for requested/committed views.

`LibraryPaneBody` continues to own one committed exact
`{view, entries, nextCursor}` listing state. Every first-page and continuation
request captures local fact revisions:

```text
LibraryEntryRequestIdentity {
  resourceKey,
  requestedViewKey,
  placementRevision,
  consumptionRevision
}
```

The revisions affect only the local resource identity; they are not API query
parameters. Projection changes use the existing `queryNavigation="in-place"`
lifecycle:

```text
View / Sort / Hide finished
  -> strict pane URL
  -> libraryEntriesResource exact view + revision key
  -> BFF passthrough
  -> FastAPI strict parse
  -> library_entries query
  -> matching view + current revisions commit atomically
  -> CollectionView performs the row transition
```

While requested and committed views differ, retain the prior rows and controls,
label the collection busy, reject stale results, and disable pagination,
reorder, and entry mutations. Failure retains the prior committed page with
exact Retry. Pane, scroll, focus, Slate, and Companion remain mounted.

Commit a result only when its requested view and both captured revisions still
equal current state. If either revision advances during a request, ignore that
result and request the **current requested view**, not the older committed view.
Coalesce repeated advances and allow at most one reconciliation request plus one
latest follow-up. An older response can never commit after a definitive
mutation.

The route bootstrap seeds only `Canonical + AllItems(All)` at revision zero. The
client claims that seed only while both process revisions remain zero; otherwise
the exact first page loads through the entries endpoint.

## Mutation Composition

### Library placement

The Library placement owner exposes one typed, process-local revision:

```text
LibraryPlacementChange {
  revision: MonotonicRevision
  targets: LibraryPlacementTarget[] | Unknown
  affectedLibraryIds: LibraryId[] | Unknown
}
```

Every definitive browser placement writer publishes through this seam after
authoritative success:

- resource-action add/remove;
- Add Content assignment, including partial-success batches;
- Reading Slate acceptance;
- podcast subscribe/unsubscribe and subscription placement;
- OPML import placement;
- Library deletion and current-viewer invitation acceptance, which publish
  `Unknown` because they can change visible membership and many placements.

The lowest authoritative command helper publishes exactly once after each
acknowledged write; wrappers and leaf components never republish it. Each
successful unit in a partial batch advances the revision. A single server command
covering unknown or bulk effects publishes once with `Unknown`. Consumers, not
writers, coalesce the resulting reconciliation. Residue tests enumerate all
direct placement HTTP writers.

A mounted All pane reacts to every placement revision. A named/system pane
reacts when its id is affected or scope is `Unknown`. The placement overlay
still refetches and decodes authoritative option state; the list independently
refetches its requested projection.

### Consumption

The consumption owner exposes a second typed, process-local revision:

```text
ConsumptionProjectionChange {
  revision: MonotonicRevision
  mediaIds: MediaId[] | Unknown
}
```

Publish only after an authoritative write is acknowledged/installed:

- every consumption-state command installed by `LecternProvider`, including
  completion Undo and batch state;
- every durable reader-state write;
- every accepted listening heartbeat.

Every in-flight result remains revision-bound. A ready In Progress or Unfinished
view also reconciles because an absent row may newly qualify; an unfiltered ready
view keeps the existing local media patch and does not refetch merely for a
heartbeat. Repeated writes are coalesced as above. This deliberately prefers a
bounded authoritative refetch where membership can change over duplicating the
canonical consumption derivation or its finish threshold in the browser.

The existing local media patch remains immediate:

- Mark Finished removes a row from Unfinished or In Progress.
- Mark Unread or Reset Progress removes a row from In Progress.
- Undo or reader/listening activity can add a previously absent qualifying row
  through revision reconciliation.
- Auto-pagination continues until a matching row appears or the cursor ends.

These guarantees cover definitive writes in the current browser process only.
Cross-tab/device and background mutations converge on pane activation or reload;
there is no realtime transport, general event bus, cache, or optimistic
projection truth.

## Interaction And Accessibility

- `View` and `Sort by` are labelled native selects.
- `Hide finished` remains the shared labelled checkbox.
- Controls wrap without horizontal scroll at 320px.
- Empty and failed results never remove the controls.
- Reduced motion changes no state semantics.

`libraryView.ts` formats every exact view as:

```text
{projection label} · {order label}[ · unfinished only]
```

The pending/failure status is a single polite `role=status` node outside the
`aria-busy` collection and carries `aria-controls=<library-entry-region-id>`.
The busy region contains rows/empty state only. Copy is exact:

- initial pending/failure: `Loading {requested}.` /
  `Could not load {requested}.`
- retained pending: `Loading {requested}. Showing {committed}.`
- retained failure: `Could not load {requested}. Showing {committed}.`

Empty-state precedence is the closed view union, not inferred counts:

| Projection | Completion | Empty title | Recovery |
|---|---|---|---|
| All items | All | All: `No media yet.`; other: `No podcasts or media in this library yet.` | none |
| All items | Unfinished | `No unfinished items.` | `Show finished` |
| Unfiled | All | `Everything is filed.` | `Show all items` |
| Unfiled | Unfinished | `No unfinished unfiled items.` | `Clear filters` |
| In Progress | n/a | `Nothing in progress.` | `Show all items` |

`Show all items` and `Clear filters` both request `AllItems(All)` while preserving
order. `Show finished` changes only completion.

Focus rules:

- `View`, `Sort by`, and `Hide finished` changes retain the initiating control.
- `Show all items` and `Clear filters` focus `View` after the matching commit.
- `Show finished` focuses `Hide finished` after the matching commit.
- successful Retry focuses `View`; failed Retry retains Retry.
- successful `Refresh list` focuses `View`; failure retains `Refresh list`.
- a removed focused row moves to next row, previous row, `View`, then `Sort by`;
- newly appearing rows never steal focus.

## Hard-Cut And Extirpation Rules

- Delete the v1 cursor encoder/decoder and every v1-specific fixture/test.
  Current generic malformed/authentication/domain/binding tests are sufficient.
- Replace the old `LibraryEntryView {order, completion}` shape everywhere; no
  optional projection field or default-filling internal adapter survives.
- Remove duplicated requested/committed view-label formatting in
  `LibraryPaneBody`; the view owner formats both.
- Remove user-facing `My Library`, `My Library only`, and `Default library`
  product copy from the closed alias boundary, destination flows, and their
  tests. Internal domain terminology, stored names, database names, and technical
  documentation remain Default.
- Replace normative Add Content and Android Share destination wording with the
  caller-specific copy above.
- Reject reserved `All`; do not retain a suffix, case exception, stored-name
  display fallback, or legacy `My Library` search alias.
- Do not keep an Unfiled checkbox beside the View selector.
- Do not retain client-side-only Unfiled filtering or per-row placement N+1
  reads.
- Do not retain a result-commit path that ignores fact revisions.
- Delete superseded tests, helpers, styles, and comments encountered in the
  touched owner paths.

## Files

Create:

- `apps/web/src/lib/libraries/presentation.ts`
- `apps/web/src/lib/libraries/presentation.test.ts`
- `apps/web/src/lib/libraries/placementRevision.ts`
- `apps/web/src/lib/libraries/placementRevision.test.ts`
- `apps/web/src/lib/consumption/projectionRevision.ts`
- `apps/web/src/lib/consumption/projectionRevision.test.ts`

Modify:

- `python/nexus/services/library_governance.py`
- `python/nexus/services/library_entries.py`
- `python/nexus/services/resource_graph/resolve.py`
- `python/nexus/services/search/retrievers/resource_metadata.py`
- `python/nexus/api/routes/{atlas,libraries}.py`
- `python/tests/{test_atlas,test_libraries,test_resource_graph_resolve,test_resource_targets,test_search_candidates}.py`
- `apps/web/src/lib/libraries/libraryView.ts`
- `apps/web/src/lib/libraries/libraryView.test.ts`
- `apps/web/src/lib/libraries/libraryPlacement.ts`
- `apps/web/src/lib/libraries/useLibraryPlacement.ts`
- `apps/web/src/lib/lectern/{LecternProvider.tsx,LecternProvider.test.tsx}`
- `apps/web/src/lib/reader/{useReaderProgress.ts,useReaderProgress.test.tsx}`
- `apps/web/src/lib/player/{listeningHeartbeat.ts,listeningHeartbeat.test.ts}`
- `apps/web/src/lib/podcasts/{opmlImport.ts,opmlImport.test.ts}`
- `apps/web/src/lib/api/resource.ts`
- `apps/web/src/lib/collections/presenters/library.ts`
- `apps/web/src/app/(authenticated)/libraries/{LibrariesPaneBody.tsx,[id]/LibraryPaneBody.tsx}`
- `apps/web/src/app/(authenticated)/libraries/{LibrariesPaneBody.ac4.test.tsx,LibrariesPaneBody.systemLibrary.test.tsx}`
- `apps/web/src/app/(authenticated)/libraries/[id]/{LibraryPaneBody.ac4.test.tsx,LibraryPaneBody.default.test.tsx,LibraryPaneBody.readingSlate.test.tsx}`
- `apps/web/src/app/(authenticated)/atlas/GrandAtlasPaneBody.test.tsx`
- `apps/web/src/app/(authenticated)/podcasts/{podcastSubscriptions.ts,podcastSubscriptions.test.ts,usePodcastSubscriptionActions.ts,usePodcastSubscriptionActions.test.tsx}`
- `apps/web/src/app/(authenticated)/podcasts/[podcastId]/{PodcastDetailPaneBody.tsx,PodcastDetailPaneBody.test.tsx}`
- `apps/web/src/components/libraries/LibraryPlacementOverlay.test.tsx`
- `apps/web/src/components/{LibraryDestinationDisclosure,LibraryDestinationPicker}.tsx`
- `apps/web/src/components/{LibraryDestinationDisclosure,LibraryDestinationPicker}.test.tsx`
- `apps/web/src/components/LibrarySettingsDialog.tsx`
- `apps/web/src/components/OpmlImportPanel.tsx`
- `apps/web/src/components/launcher/{AddPanel.tsx,AddPanel.test.tsx,Launcher.test.tsx,useAddContentSession.ts,useAddContentSession.test.tsx}`
- `apps/web/src/components/launcher/useLauncherController.ts`
- `apps/web/src/app/share/{ShareCapture.tsx,ShareCapture.test.tsx}`
- `apps/web/src/lib/media/mediaLibraries.ts`
- `apps/web/src/lib/media/mediaLibraries.test.ts`
- `e2e/tests/{authenticated-shell-ac4,libraries}.spec.ts`
- `docs/{architecture.md,modules/library.md}`
- `docs/cutovers/{add-content-intake,android-share-library-destinations}-hard-cutover.md`
- the governing Library sorting, continuity, placement, and virtualization docs
  only where their current contract is superseded.

No migration, schema DTO, new route, generic component, or dependency is added.

## Production Release

This is one source cutover with an explicit backend-first rollout:

1. Record the previous Hetzner SHA and READY Vercel deployment; build the release
   SHA and open a short Library maintenance window. No old Library pane may
   paginate during the incompatible backend/web interval.
2. Run reserved-name preflight and the query-plan gate. Stop on either failure.
3. Publish the release SHA on a non-production ref and deploy that exact SHA to
   Hetzner while the old Vercel web remains otherwise live.
4. Require `/health`, cursor-free canonical listing, all three new projections,
   authenticated v2 continuation, invalid-cursor, and mutation-readback smokes.
5. Fast-forward `main` to the same SHA; wait for its Vercel production deployment
   to report READY and the exact revision.
6. Hard-reload the browser, then smoke All → Unfiled → placement reconciliation
   and All/named In Progress. End the maintenance window.

An already-loaded old bundle cannot render the new recovery and must not be used
during the window. After the hard reload, any invalid or deployment-era cursor
gets the explicit recovery above. The backend has no v1 decoder.

If Hetzner fails before step 5, restore only the previous Hetzner SHA. After the
web release, rollback Vercel to the recorded deployment **first**, smoke initial
Library reads, then restore the previous Hetzner SHA, hard-reload to discard v2
cursors, and smoke again. Never roll back the backend first while the new web can
emit projections.

## Implementation Order

1. Run reserved-name preflight and capture current query-plan baselines.
2. Write failing boundary, cursor, projection, presentation, and revision-race
   tests.
3. Hard-cut reserved naming, backend projections, SQL predicates, and v2 cursor.
4. Hard-cut the frontend view codec/resource identity and View selector.
5. Centralize All/destination presentation and target/Dossier/Atlas aliases.
6. Route every placement and consumption writer through its typed revision seam;
   bind first-page adoption to exact view plus both revisions.
7. Close accessibility, focus, stale-cursor recovery, E2E, docs, plan, residue,
   and release gates.
8. Land one coherent source cutover and execute the backend-first release.

## Acceptance Criteria

1. Every surface in the closed alias boundary presents Default as **All** with
   Default-row context **Across your libraries**. Target search matches All and
   Dossier/target/Atlas labels never expose the stored name.
2. Normalized `All` is rejected for every non-default create/rename; production
   preflight proves no conflict and drafts show the reserved-name message. No
   migration, suffix, or legacy alias exists.
3. Empty Media destinations say **No additional libraries**; empty podcast/OPML
   destinations say **No libraries selected**. Neither says or implies Unfiled.
4. All offers All items, Unfiled, and In Progress; every other Library offers
   All items and In Progress only.
5. Unfiled returns direct-Default Media with no other current visible
   non-system placement; direct+named and shared-only Media are absent.
6. System placement and inaccessible foreign placement do not change Unfiled.
7. In Progress returns exactly Media with canonical `InProgress`; Unread,
   Finished, missing facts, and podcast-show rows are absent.
8. Projection is applied before completion, ordering, keyset, and `limit + 1`;
   every supported projection/order/filter combination paginates without false
   empty or short pages when qualifying/order facts are unchanged. Concurrent
   behavior matches the explicit live-pagination contract.
9. Raw query syntax is narrowed once at FastAPI; invalid combinations fail
   visibly and never normalize, fall back, or reach query composition as loose
   strings.
10. Every v2 cursor is canonical, authenticated, non-coercing, hides the viewer
    UUID, and binds the exact viewer/Library/view/key plan. Generic malformed,
    authentication, domain, and binding tests pass; no v1 code/test remains.
11. Projection changes preserve pane, focus, scroll, prior committed rows,
    Slate, and Companion until one matching page commits.
12. Every definitive same-process placement and consumption writer advances its
    owner revision. A response whose requested view or captured revision is
    stale never commits; current requested view reconciles, including absent-row
    In Progress creation and completion Undo.
13. Reorder exists only for fully loaded editable non-default
    `Canonical + AllItems(All)`.
14. The status node is outside the busy collection; exact requested/committed
    labels, every valid empty-state cell, Retry/recovery focus, removed-row
    focus, reduced motion, desktop, mobile, and 320px satisfy the interaction
    contract.
15. The complete plan matrix passes the blocking `EXPLAIN (ANALYZE, BUFFERS)`
    gate; no index is added without amending this spec.
16. No smart-view persistence, count, generic query DSL, migration, new cache,
    worker, new endpoint, fallback, compatibility shim, or speculative index
    exists.
17. Focused backend integration, frontend codec/component/browser, one
    authenticated real-stack Library journey, and the backend-first
    release/rollback smokes pass.

## Focused Verification

- Backend API tests: boundary parsing, semantics, combinations, unchanged-fact
  pagination, cursor canonicality/authentication/scope, reserved names,
  membership changes, and system/foreign boundaries.
- Frontend pure tests: view codec, labels, option availability, resource keys,
  All presentation, destination copy, and both owner revision stores.
- Browser tests: view controls, retained-row lifecycle, mutation
  reconciliation during requested/committed mismatch, absent-row entry,
  completion Undo, focus, status placement, every empty-state cell,
  stale-cursor recovery, and responsive wrapping.
- Real-stack E2E: open All → Unfiled → file one item through Libraries… → row
  disappears → reader/listening activity creates an In Progress row → completion
  removes it → Undo restores it → reload preserves the exact URL view.
- Query-plan matrix and production smokes from the gates above.
- Residue scan for v1 cursor code/tests, old view shape, direct placement writers
  without publication, result adoption without revisions, duplicate display
  derivation, closed-boundary Default/My Library copy, and normative `My Library
  only` destination copy.
- `git diff --check`.
