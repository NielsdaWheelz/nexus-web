# Libraries

Libraries organize access to content; they do not own media ingestion or asset
delivery.

The domain is split into three owned modules, each owning its own tables:

- **`services/library_governance.py`** owns the `libraries` and `memberships`
  tables: library CRUD, membership/role management, ownership transfer, the
  membership guards (`lock_library_for_member` returns a frozen
  `LibraryMembershipContext`; `require_admin` / `require_non_default`), the
  writable-destination contract ingest paths call
  (`list_writable_library_destinations`,
  `validate_writable_library_destinations`,
  `resolve_writable_non_default_library_ids`,
  `default_library_id_for_user`), and Universal Dossier subject cleanup through
  the generic artifact engine.
- **`services/library_entries.py`** is the **sole writer and lifecycle owner of
  the `library_entries` table**. It owns the `EntryTarget` discriminated union
  (`{kind: "media"|"podcast", id}` — a faithful model of the
  exactly-one-target check) and the `media_target`/`podcast_target` constructors,
  the single canonical entry ordering constant (`_ENTRY_ORDER = "position ASC,
created_at DESC, id DESC"`), the locked `ensure_entry` append, deletes and
  `normalize_positions`, all read accessors, hydration, and the item-in-library
  commands (`list_item_libraries`, `ensure_media_in_library`,
  `add_podcast_to_library`, `remove_podcast_from_library`, `reorder_entries`,
  `ensure_media_in_libraries_for_viewer`,
  `ensure_media_absent_from_library_for_viewer`, `assign_libraries_for_media`,
  named Podcast placement/compaction, and unsubscribe placement teardown).
  It also composes, for reads only, the factual view lenses (Title/Creator/
  Published/Added, each ascending or descending) and a hide-finished
  completion filter — see
  [`cutovers/library-sorting-hard-cutover.md`](../cutovers/library-sorting-hard-cutover.md);
  none of these write `position`.
- **`services/library_invitations.py`** owns the `library_invitations` table:
  create/list/list-for-viewer/accept/decline/revoke. Accept is one transaction
  — membership upsert, then invite status update — and returns
  `{invite, membership, idempotent}`. The membership commit alone is what
  changes the accepting user's default-library list/count on the very next
  read; there is no backfill job, projection worker, or provenance row to
  catch up afterward.

Media capabilities call these services to attach or validate visibility, then
return to their own owners for ingestion, playback, files, or assets.

## Membership sharing versus resource sharing

A library is shared only through membership/invitation governance. It never has
a `resource_grants` row or anonymous public reader. Copying a library URL changes
no access; a non-member remains masked. Default and system libraries are
copy-only and cannot accept membership changes.

The Library pane's capability-gated **Members** Companion tab is the sole
non-default membership-governance UI, including invitation lifecycle, roles,
removal, and ownership transfer. Library Share retains member-only link actions
and exposes one authorized **Manage members** activation into that tab.
`LibrarySettingsDialog` owns name/color settings only. Media and podcast
placement is a separate top-level `Libraries…` resource relationship action
backed by `LibraryEntryEditor`; it never appears inside Share. Library entries
are organization references rather than access-grant provenance. See
[resource-sharing.md](resource-sharing.md) and
[library-placement-resource-action-hard-cutover.md](../cutovers/library-placement-resource-action-hard-cutover.md).

The admin member and pending-invitation reads return exact
`{data, page: {nextCursor: Presence<string>}}` envelopes. Members traverse
immutable `user_id ASC`; invitations traverse the indexed
`created_at DESC, id DESC` keyset. Their opaque cursors are bound to viewer,
Library, endpoint, and invitation status. Member, invitation, and user-search
person fields preserve semantic absence as `Presence`; governance commands
return fully hydrated projections and use the standard serializable retry
boundary.

Library entry mutations are commands, not refreshed read models. Successful
media-placement add/remove, add-podcast, and reorder requests return `204 No
Content`; the placement overlay refreshes server truth after each command.
Agent filing receives only inserted/already-present truth for Undo and never
hydrates an entry payload.

## System libraries

`libraries.system_key` (nullable, unique where present) is the policy handle for
system-maintained libraries — there are **no name-based checks**. The Oracle
Corpus is one such library (`system_key = 'oracle_corpus'`). A system library
behaves like any library for reads (it appears in `GET /libraries`, opens, and is
searchable with `scope=library:<id>`) but is **protected from user mutation**:
rename, delete, share, and entry edits are blocked. `ensure_system_library` is the
idempotent (by `system_key`) creator, and the seed is an explicit system-maintenance
command, never a user request — system libraries still never bypass
`library_entries`.

`LibraryOut` carries the policy to the client so UI never infers protection or
owner authority from names, roles, or raw identity: `system_key`, plus the
booleans `can_rename` / `can_delete` / `can_edit_entries` /
`can_manage_members` / `can_transfer_ownership`.
`library_governance._library_capabilities` is the one place they are computed.
A library is mutable only when `system_key IS NULL` and it is not the default
library. Rename, entry editing, and member management require an admin; delete
and ownership transfer require the current owner.

## The `library_entries` sole-writer rule

Every INSERT/UPDATE/DELETE on `library_entries` goes through
`library_entries.py`; no other module issues DML against the table.

- **Reference-mutation order.** Media-entry adds/removals lock affected media
  UUIDs in ascending order before affected library UUIDs in ascending order.
  `ensure_entry` remains the only inserter and the locked library row is the
  per-library append point, so concurrent appends cannot both derive the same
  `MAX(position)+1`. Library teardown snapshots its media lock set before taking
  those locks and restarts the whole bounded transaction if revalidation finds
  that the set changed; it never acquire-expands while holding a library lock.
- **Position invariant.** Migration `0131` makes the per-library position a DB
  invariant: `UNIQUE (library_id, position) DEFERRABLE INITIALLY DEFERRED`. The
  set-based `reorder_entries` (one `unnest(...) WITH ORDINALITY` UPDATE) and the
  renormalizer rely on deferral to swap positions within a transaction.
- **Explicit cleanup.** `0131` also drops the `media_id`/`podcast_id`
  `ON DELETE CASCADE` FKs — entry cleanup on media/podcast deletion is now
  explicit in app code, not the database. Zero-reference document cleanup runs
  while the media lock is held; object-store deletion happens only after commit.
- **One read tier (Tier-R).** Writes have one owner; visibility/search readers
  read the table under an explicit allowlist: `auth/permissions.py`,
  `services/search/scope.py`, `services/contributors.py`,
  `services/agent_tools/app_search.py`, `services/note_indexing.py`, and
  `services/artifacts/bindings/library.py`. `services/object_refs.py` is deleted;
  its former note/@-mention reads are superseded by `services/resource_items/
  targets.py` (target search) and the shared frontend target controller — see
  [universal-link-authoring-hard-cutover.md](../cutovers/universal-link-authoring-hard-cutover.md).
  Visibility itself remains the boolean predicates in `auth/permissions.py`;
  `services/highlights.py` reuses `permissions.highlight_library_intersection_exists`
  rather than re-implementing the intersection.

## The default library's virtual read surface

The default library holds no provenance, closure, or backfill machinery. Its
read surface — "personal All" — is a live union, computed on every read, of:

1. the distinct Media reachable through the viewer's current non-system
   memberships; and
2. the viewer's active Podcast subscriptions.

Media is deduplicated by `media_id` (a direct entry in the viewer's own default
library wins over an indirect shared-Library entry; ties within a kind resolve
by earliest entry). The Podcast arm is virtual: Default stores no Podcast
`library_entries` row and the DTO exposes `placement: Absent`, never a fabricated
entry ID or position. Losing a membership removes that Library's Media
contribution on the next read; unsubscribing removes the virtual show row.

- **The one actor-authorized filing command.**
  `library_entries.ensure_media_in_library` is the sole path that files media
  into any library, including the default one. Filing into the default
  library always inserts (or idempotently keeps) a direct, physical
  `library_entries` row there — there is no separate "intrinsic" bookkeeping
  distinct from the row itself. A work already visible virtually through
  another membership can still be explicitly filed; that direct row is what
  survives a later membership loss that would otherwise have removed it from
  view.
- **Stateless keyset pagination, one authenticated cursor codec.** Listing any
  library never touches a snapshot table. Every listing uses the shared signed
  keyset cursor bound to `LibraryEntries` and the exact
  `(viewer, library, view)` query. Continuation also requires the unchanged
  `collectionRevision`; concurrent membership or ordering changes return
  `409 E_COLLECTION_CHANGED`. A cursor from the wrong viewer, library, view, or
  pre-cutover family is `400 E_INVALID_CURSOR`, never reinterpreted.
- **Fixed entry projections.** `GET /libraries/{id}/entries` accepts
  `projection=unfiled|in-progress` (omitted means All items). `Unfiled` is
  valid only for the viewer's own Default library: direct-Default media with
  no other current, non-system membership placement visible to the viewer
  (read-only shared libraries count as filing; system and inaccessible foreign
  libraries do not). `In Progress` is exactly the canonical consumption
  relation's `read_state = 'InProgress'` (composed from
  `consumption.service.engagement_fact_rows_sql()`; podcast-show rows never
  match), and combining it with `completion=unfinished` is
  `400 E_INVALID_REQUEST` — the projection union makes that state
  unrepresentable. Projection applies before completion, ordering, keyset, and
  `limit + 1`. These are URL-owned query projections — not Libraries, saved
  searches, or persisted collections — and there is deliberately no generic
  smart-view platform behind them.
- **Podcast placement and child subsumption.** Named Podcast placement is exactly
  `library_entries(podcast_id)`. In one named Library, a Podcast entry and direct
  entries for its episodes are mutually exclusive. Subscribe/filing confirms
  and compacts direct child placements through the Library owner; later removing
  the parent does not recreate them. Adding an episode to a Library that already
  contains its Podcast returns `IncludedThroughPodcast` rather than creating a
  redundant child entry.
- **Media deletion counts physical references only.** Whether a document
  media has any reference left — the question that gates last-reference
  teardown — is answered by counting physical `library_entries` rows for
  that `media_id` and nothing else; there is no closure/intrinsic count to
  reconcile against it. `services/media_deletion.py` is a pure orchestrator
  over the public `library_entries` API; it issues zero direct
  `library_entries` DML of its own.
- **Placement removal is convergent and non-destructive.**
  `ensure_media_absent_from_library_for_viewer` authorizes a mutable target
  library, returns `204` when the entry is already absent without exposing media
  existence, and removes exactly one present entry. It supports every
  media kind and refuses the final lifetime reference with
  `409 E_MEDIA_LAST_REFERENCE`; it never hides or deletes the media resource.
  Whole-resource `DELETE /media/{id}` accepts no query string.

## Reading-time projection

Reading time is owned by the Library list read model, not `MediaOut` and not an
ingestion writer. Migration `0187` stores same-row word-count derivatives beside
canonical fragment text and PDF plain text. `services/media_document_metrics.py`
is the sole media-level aggregate owner: it sums stored integers for a bounded
batch and never reads document text on a request. Shared PDF quote readiness
likewise uses the stored positive word count instead of scanning `plain_text`.

`services/library_entries.py` applies the one product policy (240 words/minute,
coarse half-up 1/5/15-minute rounding) while hydrating entries. Only ready,
quotable web articles, EPUBs, and text PDFs with a positive count receive a
value. Every `LibraryEntryOut` has a required
`readingTimeEstimate: Presence<ReadingTimeEstimateOut>`: total is always present
inside a present estimate; remaining is present only for in-progress web/EPUB
media with the consumption projection's monotonic whole-document progression.
PDF is total-only. Nested `media` is the sole entry consumption owner; root entry
read-state/progress fields do not exist.

## Presentation: Default is presented as All

`apps/web/src/lib/libraries/presentation.ts` is the single frontend owner of
the Default display alias: `libraryPresentation(library)` yields
`{name: "All", context: "Across your libraries"}` when `isDefault`, else the
authored name and viewer role. No component independently derives the Default
display name. Server-owned label surfaces project the same alias when
`is_default` — resource-target search candidates (which match the token `All`
and never the stored seeded name), Library and Dossier labels in
`resource_graph/resolve.py`, and Atlas constellation labels. The stored seeded
name is neither displayed nor retained as a search alias, and `All`
(trimmed, Unicode-casefolded) is a reserved name: create and rename of any
non-default library reject it with `400 E_NAME_INVALID`
(`library_governance._validate_library_name`).

Writable destination selection describes selected, additional, non-default
Libraries only. Default/All is implicit for acquired Media and active Podcast
subscriptions. `LibraryDestinationField` requires a caller-supplied
`emptyLabel` and defines no semantic default: Media intake and Android Share
pass **No additional libraries**; Podcast Subscribe, episode Add, and OPML pass
**No libraries selected**.

## Frontend entry-view lifecycle

The pane URL owns the requested `LibraryEntryView` (order + projection + entry
type); the Library controller owns one committed exact collection
`{view, entries, collectionRevision, nextCursor, exhaustion}`.
A same-visit query replacement is in-place: pane chrome, controls, focus, live
ShellScroll position, Slate, and Companion stay mounted while the exact first
page loads. The full query remains runtime/history identity.
`lib/libraries/libraryView.ts` is the sole owner of the closed view types, the
strict URL codec, API query construction, projection/order option availability,
entry-type transitions, and exact view formatting. The closed inventory is All
types plus Web articles, EPUBs, PDFs, Videos, Podcast episodes, and Podcast
shows. Omitted `entry_type` means All types; Podcast shows compose only with All
items / show finished.

- A keyed `useResource` request is latest-wins; only a result associated with
  the current requested view commits.
- Every first-page and continuation request captures the current placement and
  consumption revisions (`lib/libraries/placementRevision.ts`,
  `lib/consumption/projectionRevision.ts`); a result whose requested view or
  captured revision is stale never commits — the pane instead requests the
  current requested view, coalescing repeated advances. Every definitive
  same-process placement/consumption writer publishes its seam exactly once
  after each acknowledged write.
- A mounted All pane reacts to every placement revision; a named/system pane
  reacts when its id is affected or the scope is `Unknown`. A consumption
  advance reconciles In Progress and unfinished views (an absent row may newly
  qualify); an unfiltered All-items view keeps the immediate local media patch
  and does not refetch for it.
- While requested and committed views differ, prior rows and row navigation
  remain available; continuation, reorder, and entry mutations do not. Reorder
  exists only for a complete, editable, non-default
  `Canonical + All items (all) + All types` view.
- Failure retains and labels the prior committed collection. Network/5xx
  exhaustion offers **Retry**; an invalid cursor or changed revision offers
  **Refresh list**, which requests the first page of the same view without
  clearing committed rows.
- Pane return captures only a ready snapshot whose committed view equals the
  URL view, and restores Library plus page as one coherent value.
- A matching commit atomically swaps view, rows, and cursor, resets the
  collection region, and lets `CollectionView` own the single row transition;
  reduced motion performs the same commit without animation.
- The route bootstrap seeds only `Canonical + All items (all)` at revision
  zero; the client claims that seed only while both process revisions remain
  zero.

Pane-local Filter is a visit-local view over the committed rows. It matches
presented entry title and contributor display/credited names after the
server-owned projection and before the existing order. It never enters
`LibraryEntryView`, request, cursor, snapshot, or folio identity. `Type`, `View`,
`Sort by`, and applicable `Hide finished` render in expanded Pane Search; when
collapsed, the Filter action marks their non-default state. A query-key row
change bypasses the collection View Transition, while domain commits and
mutations retain the existing transition and requested/committed lifecycle.

See
[library-entry-view-continuity-hard-cutover.md](../cutovers/library-entry-view-continuity-hard-cutover.md).

## Resonance and Reading Slate

`python/nexus/services/resonance/` is the sole relevance-policy owner. It
composes public, policy-neutral read ports from `library_entries`, consumption,
the resource graph, contributor credits, media/podcasts, and the semantic index;
those modules retain their tables and mutations.

- Library entry ordering is no longer Resonance's: it is the factual view
  lenses owned by `library_entries` (see
  [`cutovers/library-sorting-hard-cutover.md`](../cutovers/library-sorting-hard-cutover.md)).
  Resonance here retains only the Reading Slate.
- `GET /libraries/{id}/slate` returns zero to ten deterministic suggestions
  outside complete destination placement. A library suggestion must have a
  factual graph, shared-author, or calibrated semantic relation to one of five
  representative complete-placement anchors; recency cannot qualify it.
- A non-default, non-system admin library accepts media plus actively
  subscribed podcasts. Default accepts media suggestions only. Member-only and
  system libraries return an empty Slate because their actor-facing filing
  commands cannot add entries. `Finished` media remains eligible for an
  addable destination.
- Every read uses one repeatable-read, read-only snapshot and performs no
  request-time AI, generation, embedding, scheduled job, or persisted
  recommendation state.

The frontend renders **Suggested for this library** after the complete entry
inventory in a fixed comfortable List, independent of the main collection's
empty state, Gallery choice, or density. Add delegates to the existing
media/podcast filing command. It does not synthesize a `LibraryEntry`; visible
Slate survivors stay in order, at most one canonical replacement is appended,
and the main entry projection reloads on the next pane activation.

## Writable library destinations

`library_ids` in ingest and assignment request bodies means selected
non-default libraries where the viewer can write entries. It does not mean every
library the viewer can read.

- **Search/list.** `GET /libraries/writable-destinations` is the sole backend
  list contract for destination pickers (`LibraryDestinationField` +
  `LibraryChooserSurface` + `LibraryDestinationPicker` adapter on the
  frontend). It excludes the default library and member-only libraries,
  performs server-side search, and pages with the opaque
  `library_destinations:v2` keyset cursor (rank + `lower(name)` + name + id,
  ascending). A blank query is
  alphabetical; a non-empty query ranks exact → prefix → contains matches, then
  alphabetically within each rank. Only `:v2` is accepted — a pre-cutover or
  malformed cursor returns `400 E_INVALID_CURSOR`; there is no compatibility
  decoder for the old unversioned/timestamp cursor.
- **Standing placement ordering.** `library_entries.list_item_libraries` (the
  `Libraries…` resource-action listing) orders `lower(name) ASC, name ASC, id
  ASC`; the `LibraryChooser` client filters that complete inventory by
  substring locally rather than re-querying.
- **Validation.** Write paths call
  `validate_writable_library_destinations` or
  `resolve_writable_non_default_library_ids`; default IDs, duplicate IDs,
  inaccessible IDs, and member-only IDs are invalid for destination arrays.
- **Assignment.** `library_entries.assign_libraries_for_media` is the standalone
  transaction-owning command for attaching media to the viewer's default library
  plus selected destinations. Media creation workflows that already own a
  transaction call `assign_libraries_for_media_in_current_transaction` before
  committing the created media. `ensure_media_in_libraries_for_viewer` adds
  post-hoc destinations atomically as a bodyless command.

The canonical HTTP placement surface is
`GET/POST /media/{media_id}/libraries` plus
`DELETE /media/{media_id}/libraries/{library_id}`. There is no inverse
library-to-media write route and no scoped resource-delete query mode.
Both POST and DELETE mutations return `204 No Content`.

## Composition Rules

- URL ingest validates requested writable destination IDs at the durable
  acceptance boundary. `media_source_ingest.py` owns source-attempt creation and
  assigns default plus selected destinations through `library_entries` inside
  the media creation transaction.
- Source-specific materializers such as X, remote file, YouTube, and web-article
  adapters do not own durable acceptance, retry, dispatch, or destination
  policy. They may attach deduped canonical media only by calling
  `library_entries` from the shared source-ingest transaction.
- Library entries never make a private media file public.
- Public owned Oracle plates are not library resources; readings may reference
  them, but the plate asset route is owned by `oracle_plates.py`.
- The default library's virtual read surface affects which media rows are
  visible, not object-storage keys.

## Library Resource Inspector And Dossier

The Library primary pane owns entries and the route-keyed membership controller.
One shared Companion action opens the pane-local Resource Inspector with
capability-gated `Members | Connections | Dossier`; Members is present only for
mutable Libraries the viewer can administer, and Dossier remains default. The
same publication drives desktop and mobile; no feature-specific column, modal,
drawer, or second governance state machine exists.

Library Dossier is one binding of the Universal Dossier engine. Its head is
keyed by the Library subject and Library audience, so membership is the read and
generation boundary. The binding collects direct entries, expands Podcast
entries to Episodes, intersects all Media with audience visibility, and records
typed coverage/freshness in the revision manifest. Generate, Regenerate,
history, Make current, provenance, and retry use the same API and surface as
every other eligible resource.

Dossier citations are `resource_edges` sourced from
`artifact_revision:<id>`, never a Library-owned citation table. Promotion
repoints only the stable `artifact:<id>` head; historical revision content and
citations remain immutable.

The current revision body is one accepted semantic `content_html` article plus
its derived `content_text`. Library search/chat consume the text projection;
the Dossier surface renders the article through the shared sandboxed document
frame.
