# Libraries

Libraries are how a reader keeps and shares things: named collections of media
and podcast shows that are also the access group for what they file
(membership is what lets a co-member read a library's media). Every account owns
one default library, presented as **All**, read as a live union of everything
the viewer can reach plus their followed shows. A **system library** (the Oracle
Corpus, `system_key`) reads like any other and is never user-mutable. Libraries
do not own ingestion or asset delivery.

## Concepts

- **Entry**: one media or one show in one library, at a position.
- **Placement**: an item's relation to each library the viewer can see
  (`Direct`, `Inherited` through a filed show, `Absent`) and why it cannot
  change (`RequiresAdmin`, `RequiresSubscription`, `SystemManaged`).
- **Destination**: a named, non-system library the viewer admins; new items
  (Add, share, browse, the extension) are filed into destinations.
- **Collection order**: a library's positions (or the Lectern's, see
  [player](player.md)), fenced by an **order revision** drawn from one global
  sequence (`collection_order_revision_seq`). A **move** names its item, its
  successor and the revision it expects.

## Owners

- `services/libraries.py`: the `libraries` table and the viewer's authority
  over one. `access(db, viewer, library, lock=)` returns a `LibraryAccess` with
  `require_*` and `.out(viewer)`, the one capability rule (action snapshots read
  it too). Create, rename, delete, the index, destinations, `default_library_id`
  and system libraries.
- `services/library_entries.py`: the sole writer of `library_entries`: filing,
  unfiling, show placement, the move, the placement read, and the relations
  other modules compose (`library_media_ids_cte_sql`,
  `destination_membership_rows_sql`, `library_anchor_facts`).
- `services/library_listing.py`: entry view lenses and the one keyset page and
  order read; writes nothing.
- `services/library_members.py`: memberships, invitations, roles, leaving and
  transfer, authorized through `access`; losing admin deletes the member's
  suggestion feed. Web: `LibraryMembers` (the inspector's Members tab),
  `LibraryInvitations` (the inbox above the index); each command is request,
  then reread.
- Web: `lib/libraries/api.ts` (typed calls; a committed write publishes its
  change topics), `views.tsx` (url view options, the name rule
  `libraryNameError`), `create.ts` (what a create's answer means), `errors.ts`
  (the one failure-copy map), `placementController.tsx` ("Libraries…"),
  `lib/collections/order.tsx` (collection order and library moves), the index
  and library panes, `LibrarySettingsDialog`, and the chooser stack
  (`LibraryChooser`, used directly by the extension; `DestinationChooser` and
  `DestinationField` on forms; `PlacementOverlay`).

## Contract (`/api` via the BFF; `{data}`; pages are `{items, next_cursor}`)

| route | contract | retry rule |
|---|---|---|
| `GET /libraries?sort=created_desc\|name_asc\|name_desc` | absent sort is oldest created (All first); names sort as shown | read |
| `POST /libraries {id, name}` → 201 `LibraryOut` | name trimmed, 1–100 characters, never All (any case): 400 `E_NAME_INVALID` | same id and owner → that row (even renamed); another owner's id → 409 `E_RESOURCE_CONFLICT` |
| `GET /libraries/{id}` | members only; anyone else 404 `E_LIBRARY_NOT_FOUND` | read |
| `PATCH /libraries/{id} {name, expected_name}` → `LibraryOut` | admin of a mutable library | already that name → ok; renamed meanwhile → 409 `{current_name}` |
| `DELETE /libraries/{id}` → 204 | owner; media held nowhere else move to the owner's All; its suggestion feeds go | absent or invisible → 204 |
| `GET /libraries/{id}/entries?sort&entry_type&projection&completion` | every combination composes; `unfiled` only on All; pages carry nullable `order_revision` | read |
| `GET /libraries/{id}/order` | member of a mutable library; complete visible `{entry_ids, order_revision}` | repeatable-read snapshot |
| `PUT /libraries/{id}/entries/{entry_id}/position {before_entry_id\|null, expected_order_revision}` → `{entry_ids, order_revision}` | admin; stale revision, or an invisible or missing actor or successor → 409 `E_RESOURCE_CONFLICT`; self-anchor → 400 | the exact original precondition; never rebased, so a resend after landing conflicts |
| `GET /libraries/placements/{media:<id>\|podcast:<id>}` | `[{library_id, name, is_default, relation, blocked}]`, All first for media, then by name | read |
| `PUT /libraries/{id}/items/{ref} {replace_episodes}` → 204 | a media into any admin library (All = Saved in Nexus), a followed show into a named one | keyed by (library, item): a no-op when present |
| `DELETE /libraries/{id}/items/{ref}` → 204 | a media's last entry anywhere → 409 `E_MEDIA_LAST_REFERENCE` | absent → 204 |
| `GET /libraries/destinations`, `GET /extension/library-destinations` | the complete `[{id, name}]` of destinations, `lower(name), name, id`; any parameter 400 | read |
| `GET\|POST /libraries/{id}/suggestions…` | [suggestions](suggestions.md) | |
| `GET /libraries/{id}/members?cursor&limit` | admin; `{user_id, role, is_owner, email, display_name, created_at}` by user id | read |
| `PATCH /libraries/{id}/members/{user_id} {role, expected_role}` → 204 | admin of a mutable library; the owner's role is fixed (403 `E_OWNER_EXIT_FORBIDDEN`); a demotion deletes that member's suggestion feed | already that role → ok; changed meanwhile → 409 `{current_role}` |
| `DELETE /libraries/{id}/members/{user_id}` → 204 | admin, or the viewer themself; never the owner; deletes that member's suggestion feed | absent, or a library the viewer cannot see → 204 |
| `DELETE /libraries/{id}/membership` → 204 | the viewer leaves; the owner transfers first | as above |
| `POST /libraries/{id}/transfer-ownership {user_id}` → 204 | owner; the target must be a member and becomes admin; the old owner stays admin | already that owner → ok |
| `POST /libraries/{id}/invites {id, invitee_user_id, invitee_email\|null, role}` → 201 `LibraryInvitationOut` | admin of a mutable library; `invitee_email` is stored as the admin typed it (one that is not the invitee's, ignoring case, is 400); a member 409 `E_INVITE_MEMBER_EXISTS`; one pending per invitee 409 `E_INVITE_ALREADY_EXISTS` | same id → that invitation; an id naming another one → 409 `E_RESOURCE_CONFLICT` |
| `GET /libraries/{id}/invites?cursor&limit` | admin; pending, newest first | read |
| `GET /libraries/invites?cursor&limit` | the viewer's pending invitations, with the inviter | read |
| `POST /libraries/invites/{id}/accept\|decline` → 204 | the invitee; accept inserts the membership in the same transaction | the same answer again → ok; any other state → 409 `E_INVITE_NOT_PENDING` |
| `DELETE /libraries/invites/{id}` → 204 | admin of its library | revoked, absent or invisible → 204 |

`LibraryOut`: `{id, name, is_default, role, can_manage, can_delete,
can_transfer_ownership, can_leave}`. A library is mutable when it is neither
the default nor a system library; `can_manage` (rename, file, reorder, manage
members) is an admin of a mutable library; delete and transfer need its owner;
every other member may leave. Entry rows are `{kind: "media", entry_id|null,
added_at, media_summary}` or `{kind: "podcast", entry_id|null, added_at,
podcast_id, title, image_url|null, contributors, unplayed_count, published_date|null,
sync_status|null}`; `entry_id` is null on All, whose rows are not stored
entries.

Placing a show where a named library files some of its episodes directly is
refused with 409 `E_PODCAST_REPLACES_EPISODES {conflicts[{library_id,
library_name, episode_count}]}` unless `replace_episodes`: the show takes the
earliest displaced episode's position, those episode rows go, and the episodes
stay in the viewer's All. A library the caller cannot see is a 404 before
anything about the show.

## Invariants

1. Non-members get the masked 404 on every library route. One default library
   per user; the owner is an admin member and cannot leave or be demoted
   (transfer first); default and system libraries take no rename, delete,
   invitation, member change or user entry write. At most one pending
   invitation per (library, invitee), never to oneself; an invitation shows the
   invitee's email only as the inviter typed it, or once the invitee is a
   member.
2. An entry files one media or one show, once per library; in a named library a
   show and direct entries for its episodes exclude each other. Positions are
   unique per library (`DEFERRABLE INITIALLY DEFERRED`); gaps are legal; appends
   take `MAX(position)+1` under the library row lock. Only
   `library_entries.py` writes the table; its readers only SELECT:
   `auth/permissions.py`, `atlas.py`, `dossier/inputs.py`,
   `library_listing.py`, `media_deletion.py`, `podcasts/sync.py`,
   `search/scope.py` (and the `db/models.py` mapping).
3. Lock order, every writer: podcast row, then media rows (uuid order), then
   library rows (uuid order). The media lock is also the teardown barrier: a
   filing and a teardown claim never both commit.
4. Unfiling never removes a media's last entry; deleting a library re-files the
   media it alone held into the owner's All; a document no durable reference
   retains is torn down (media deletion).
5. All is the union of the media reachable through the viewer's non-system
   memberships (the direct All row if any, else the earliest shared one, whose
   creation is when it was added) and the followed shows; Unfiled is what is
   filed nowhere but All. Losing a membership removes that library's media on
   the next read.
6. Every structural write and every accepted move advances the library's
   `order_revision` under its lock; a move applies only at the exact expected
   revision with a visible actor and successor, rewrites every position and
   answers the visible ids from the same transaction. Revisions cross the wire
   as decimal strings, compared with `BigInt`.
7. Only the unfiltered custom order of a mutable library carries
   `order_revision`, and its cursor binds it: a moved order rejects the cursor
   (400 `E_INVALID_CURSOR`) and the browser discards the incomplete walk.
8. Web, order: one pending move per (account, collection), held in memory for
   the tab's life and shared by every pane of that collection. A move is
   admitted only on the complete, unfiltered custom view of a library the viewer
   manages, at the revision its rows are current at. A lost answer is never
   replayed blindly: "check order" reads the current revision and resends at the
   original one only while nothing moved; any read past it settles the move
   ("order check complete"). A 409 asks the reader to review the current order.
   Nothing is written to browser storage; after a reload the reread shows the
   server's order.
9. Web, placement: edits per target run in admission order, one request at a
   time, and every outcome is followed by a reread; a lost answer is reread,
   never replayed. Closing a chooser never cancels accepted work.
10. Web, creation: an attempt freezes one `{id, name}`. A refusal (a modeled
    4xx other than 401) ends the attempt and the name can be fixed; any other
    outcome may only resend the same id. The server's echoed row is trusted.

## Views and panes

The url owns `sort`, `entry_type`, `projection` (`unfiled`, `in_progress`) and
`completion=unfinished`; the server validates and ANDs them, and the panes never
re-apply a lens to live summaries (the `Consumption` stamp rereads the views
that move with reading). An unknown url value is offered under a label of at
most 24 characters until the server's 400 shows the invalid-view notice with
Reset view. Local text filtering is a visit-local view of the shown rows; the
pane query toolbar ([workspace](workspace.md)) holds the filter and sort, with
Type, View and Hide finished as removable chips.

reorder: drag the row's title, metadata, padding or existing primary target to
the insertion line. opening targets keep their behavior; disclosure, independent
controls and expanded contents do not drag. mouse requires 8px movement; touch
requires one finger held 250ms within 8px. quick swipes retain scrolling and
pull-to-refresh. there are no grips, movement menus or keyboard movement
commands; this private-prototype limit provides no non-drag alternative.

movement requires at least two rows, a complete unfiltered custom view,
management permission and ready order. rows stay stationary with one insertion
boundary and an inert title preview. snapshot changes cancel; an activated drag's
release cannot open, invoke a control or refresh, even after cancellation.
sortable lists use the stable order scope for the existing outline session, so
linked-resource disclosures retain their fold, branch and editing owners.
the `data-row-fixed-artwork` renderer contract reserves fixed dimensions and
stable child/text nodes. only a captured load from its direct image child is
exempt from drag invalidation. other loads, content mutations, source replacement,
resize, order/revision changes and external scroll retain their guards.
the toolbar explains unavailable movement ("choose custom order to reorder.",
"clear filters to reorder.", "reordering is available when all items finish
loading.", "updating order…", "saving order…", "order not confirmed"). an
acknowledged order shows until rows catch up; "check order" retains the original
command and revision while recovering an unknown outcome. a library the viewer
cannot see says "Library not found" in place, on the first read or a reread.

## Creation

Three owners keep their lifetimes and share `sendCreation` (30 s deadline) and
`libraryNameError` ("enter a library name.", "use 100 characters or fewer.",
"All is reserved for the All view."):

- The index's "new library" dialog belongs to the pane visit. Submitting
  freezes the attempt; closing hides the sending work but never cancels it and
  gives up automatic navigation. A create acknowledged while the dialog is open
  and the pane keeps its visit and attention (`lib/panes/openResult.ts`) opens
  the library in that pane, or in a new pane when the submit or "new library"
  was shifted; otherwise it offers "library created" with "open library". An
  unknown outcome reads "creation not confirmed" and "retry creation" resends
  the same id; the attempt survives pane switches (`Libraries.Creation` visit
  data).
- Form destinations (Add, share, browse) create inline from the chooser; an
  unknown outcome keeps the attempt with "retry" under the same id.
- "Libraries…" creates and files in one step: the dependent placements are
  queued behind the create and sent only once it lands.

The launcher's "New library" keeps its own path
([issues](../issues/nexus-library-retry-whitespace-changes-identity.md)).

## Chooser and placement

`LibraryChooser` is one combobox over the complete catalog (no paging), matched
locally: type, arrow, enter, type again. A row shows its membership ("in 2 of 3
items"), why it is blocked, or "included through its show". Saved in Nexus is
All. Creating offers the typed name unless it is invalid, already a row, or
pending. Placing a show over filed episodes asks "replace filed episodes?".
Failures behind a closed chooser raise "library changes need attention" with a
review. The extension popup uses the same chooser over
`/extension/library-destinations` and creates nothing.

show placement requires a subscription only when adding to an absent destination.
an admin may remove an existing shared show placement after unsubscribing.
system-managed libraries and membership permissions still govern both directions.

## Reading Slate

Each library the viewer admins (All included) shows "suggested for this
library" from the [shortlist owner](suggestions.md); member-only and system
libraries show none. Entry pagination never gates suggestions.

## Membership, sharing and dossiers

A library is shared only through membership and invitations (the inspector's
Members tab); it never has a grant or a public link. Placement ("Libraries…") is
a resource action of media and shows, separate from Share
([resource sharing](resource-sharing.md)). The Library Dossier is one binding of
the Universal Dossier engine keyed by the library subject; membership is its
read and generation boundary. A system library's membership never makes
co-members' highlights visible to each other.
