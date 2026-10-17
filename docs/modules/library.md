# Libraries

Libraries are named, shareable collections of media and podcast shows, and the
access group for what they file: membership is what lets a co-member read the
media filed in a library. Every account owns one default library, presented as
**All**, whose listing is a live union of everything the viewer can reach plus
their followed shows. Libraries do not own ingestion or asset delivery.

## Modules and what each owns

- **`services/libraries.py`** owns the `libraries` table and the viewer's
  authority over one: `access(db, viewer, library, lock=)` returns a
  `LibraryAccess` (the row plus the viewer's role) with `require_*` methods and
  `.out(viewer)`, the one capability rule. Create, rename, delete, the index,
  writable destinations (`list_writable_library_destinations`,
  `resolve_writable_destinations`), `default_library_id`, system libraries and
  `library_management_facts` (action snapshots).
- **`services/library_entries.py`** is the **sole writer of `library_entries`**:
  `ensure_entry` (the only inserter), deletes, the read accessors, the placement
  inventory, media filing and unfiling, show placement, the move command, and
  the relations atlas, search and suggestions compose
  (`library_media_ids_cte_sql`, `destination_membership_rows_sql`,
  `library_anchor_facts`).
- **`services/library_listing.py`** owns the entry view lenses and the one
  keyset page statement; it writes nothing.
- **`services/library_members.py`** owns `memberships` and
  `library_invitations`: members, roles, leaving, transfer and the invitation
  lifecycle; it authorizes through `libraries.access`. Its routes live in
  `api/routes/library_members.py`.

Web: `lib/libraries/api.ts` (typed calls; a committed write publishes its change
topics), `views.tsx` (the url's view options), `errors.ts` (the one failure-copy
map), the two panes, `LibrarySettingsDialog`, and the chooser stack:
`LibraryChooser` (the listbox) under `DestinationChooser` (pick destinations;
`DestinationField` on the web, inline in the extension popup) and
`PlacementOverlay` ("Libraries…", opened through `placementController`).
Membership: `LibraryMembers` (the inspector's Members tab; its hook runs in the
library pane), `LibraryInvitations` (the viewer's inbox above the index) and
`components/users/PeopleSearch` (shared with the Share overlay). Each command is
request, then reread: one at a time, and after any outcome the lists and the
library are read again, so a refused command shows its copy and the tab goes
once the reread says the viewer no longer manages the library.

## Contract (`/api` via the BFF; `{data}`; pages are `{items, next_cursor}`)

| route | contract | retry rule |
|---|---|---|
| `GET /libraries?sort=created_desc\|name_asc\|name_desc` | absent sort is oldest created (All first); names sort as shown | read |
| `POST /libraries {id, name}` → 201 `LibraryOut` | `All` (casefold) and 1–100 chars enforced | same id and owner → that row; another owner's id → 409 `E_RESOURCE_CONFLICT` |
| `GET /libraries/{id}` | members only; anyone else 404 `E_LIBRARY_NOT_FOUND` | read |
| `PATCH /libraries/{id} {name, expected_name}` → `LibraryOut` | admin of a named, non-system library | already that name → ok; renamed meanwhile → 409 `{current_name}` |
| `DELETE /libraries/{id}` → 204 | owner; media held nowhere else move to the owner's All; nothing else is deleted | absent or invisible → 204 |
| `GET /libraries/{id}/entries?sort&entry_type&projection&completion` | every combination composes; `unfiled` only on All; pages include nullable `order_revision` | read |
| `GET /libraries/{id}/order` | current member of a mutable named library; complete visible `{entry_ids, order_revision}` | repeatable-read snapshot |
| `PUT /libraries/{id}/entries/{entry_id}/position {before_entry_id\|null, expected_order_revision}` → 200 `{entry_ids, order_revision}` | admin, named; stale revision or invisible/missing actor or successor → 409 `E_RESOURCE_CONFLICT`; self-anchor → 400 | exact original precondition; never rebase |
| `GET /libraries/placements/{ref}` | `[{library_id, name, is_default, relation, blocked}]`; `ref` is `media:<id>` or `podcast:<id>` | read |
| `PUT /libraries/{id}/items/{ref} {replace_episodes}` → 204 | file a media (All = Saved in Nexus) or a followed show (named only) | keyed by (library, item): a no-op when already there |
| `DELETE /libraries/{id}/items/{ref}` → 204 | the last entry of a media anywhere → 409 `E_MEDIA_LAST_REFERENCE` | absent → 204 |
| `GET /libraries/destinations?q&cursor&limit≤50`, `GET /extension/library-destinations` | named libraries the viewer admins, exact → prefix → contains → name | read |
| `GET /libraries/{id}/suggestions` | the Reading Slate (below) | read |
| `GET /libraries/{id}/members?cursor&limit` | admin; `{user_id, role, is_owner, email, display_name, created_at}` by user id | read |
| `PATCH /libraries/{id}/members/{user_id} {role, expected_role}` → 204 | admin of a mutable library; the owner's role is fixed (403 `E_OWNER_EXIT_FORBIDDEN`) | already that role → ok; changed meanwhile → 409 `{current_role}` |
| `DELETE /libraries/{id}/members/{user_id}` → 204 | admin, or the viewer themself; never the owner | absent, or a library the viewer cannot see → 204 |
| `DELETE /libraries/{id}/membership` → 204 | the viewer leaves; the owner transfers first | as above |
| `POST /libraries/{id}/transfer-ownership {user_id}` → 204 | owner; the target must be a member and becomes admin; the old owner stays admin | already that owner → ok |
| `POST /libraries/{id}/invites {id, invitee_user_id, invitee_email\|null, role}` → 201 `LibraryInvitationOut` | admin of a mutable library; `invitee_email` is the email the admin typed, stored as typed (one that is not the invitee's, ignoring case, is 400); a member, the inviter included, 409 `E_INVITE_MEMBER_EXISTS`; one pending per invitee 409 `E_INVITE_ALREADY_EXISTS` | same id → that invitation; an id naming another one → 409 `E_RESOURCE_CONFLICT` |
| `GET /libraries/{id}/invites?cursor&limit` | admin; pending, newest first; `{id, library_id, role, status, invitee_user_id, invitee_email, invitee_display_name, created_at}` | read |
| `GET /libraries/invites?cursor&limit` | the viewer's pending invitations: `{id, library_id, library_name, role, inviter_email, inviter_display_name, created_at}` | read |
| `POST /libraries/invites/{id}/accept\|decline` → 204 | the invitee; accept inserts the membership in the same transaction | the same answer again → ok; any other state → 409 `E_INVITE_NOT_PENDING` |
| `DELETE /libraries/invites/{id}` → 204 | admin of its library | revoked, absent or invisible → 204 |

`LibraryOut`: `{id, name, is_default, system_key, role, can_manage, can_delete,
can_transfer_ownership, can_leave, created_at, updated_at}`. `can_manage`
(rename, file, reorder, manage members) is an admin of a mutable library; delete
and transfer need its owner; every other member may leave. A library is mutable when it is neither the default nor a
system library. Entry rows: `{kind:"media", entry_id|null, added_at,
media_summary}` or `{kind:"podcast", entry_id|null, added_at, podcast_id, title,
contributors, unplayed_count, published_date|null, sync_status|null}`;
`entry_id` is null on All, whose rows are not stored entries.

Show placement where a library files some of the show's episodes directly is
refused with 409 `E_PODCAST_REPLACES_EPISODES {conflicts[{library_id,
library_name, episode_count}]}` unless `replace_episodes`: the show then takes
the earliest displaced episode's position, those episode rows go, and the
episodes stay in the viewer's All. Subscribe carries the same flag. A library
the caller cannot see is a 404 before anything about the show.

## Invariants

- One default library per user; the owner is an admin member and cannot leave
  or be demoted (transfer first); default and system libraries take no rename,
  delete, invitation or member change, and system libraries take no user entry
  writes.
- At most one pending invitation per (library, invitee), never to oneself
  (database); accepting writes the membership and the status in one
  transaction.
- An invitation shows the invitee's email only as the inviter typed it, or once
  the invitee is a member; otherwise null (the web shows the display name, else
  "Unknown person"). People search returns an email only on an exact match, so
  neither reveals an address the viewer did not already hold. The invitee's
  inbox names the inviter, email included.
- An entry files exactly one media or one show, once per library. In a named
  library a show and direct entries for its episodes are mutually exclusive.
- Positions only order a library (`UNIQUE (library_id, position) DEFERRABLE
  INITIALLY DEFERRED`). Gaps are fine; `move_entry` renumbers 0..n-1 and appends
  take `MAX(position)+1` under the library row lock.
- `libraries.order_revision` uses the shared logged bigint sequence (migration
  `0287`). structural changes and every accepted strict move advance it under
  that lock. moves preserve membership, rewrite all stored positions, and
  return visible ids from the same transaction. revisions cross the wire as
  canonical positive decimal strings, compared with `BigInt` in the browser.
  unfiltered custom-order pages bind their revision into the cursor; a changed
  revision rejects the cursor and the browser discards the incomplete walk.
- Lock order, every writer: podcast row, then media rows (uuid asc), then
  library rows (uuid asc). `ensure_entry` takes its own media and library
  locks and answers 404 for a row deleted while it waited. The media lock is
  also the teardown barrier: a filing and a teardown claim never both commit,
  and a filer that cannot read the media gets 404, never `E_MEDIA_DELETING`.
- A document media with no entry and no grant is torn down; unfiling never
  removes a media's last entry (only deleting the media does), and deleting a
  library re-files the media it alone held.
- Non-members get the masked 404 on every library route.
- Only `library_entries.py` issues DML on `library_entries`; readers (the
  allowlist: `auth/permissions.py`, `search/scope.py`, `contributors.py`,
  `note_indexing.py`, `dossier/inputs.py`, `tools/writes.py`) only SELECT.

## All, the default library's live read

All is the union of the media reachable through the viewer's non-system
memberships and the viewer's followed shows. A media appears once: its row is
the direct All entry if any, else the earliest shared one, and that entry's
creation is when it was **added** (re-saving moves it to the top of Recently
added). A followed show is one row that folds in its episodes. **Unfiled** keeps
media filed nowhere but All. Losing a membership removes that library's media on
the next read. Filing into All always writes a direct row, which survives a
later membership loss.

## Views and the panes

The url owns `sort`, `entry_type`, `projection` (`unfiled`, `in_progress`) and
`completion=unfinished` and passes them to the server, which validates them and
ANDs their predicates; the panes never re-apply a lens to live summaries, so a
row leaves Hide finished or In Progress on the next read (the `Consumption`
stamp rereads those views). A show has no read state, so the engagement lenses
list no shows. Local text filtering is a visit-local view over the shown rows.
The panes show the view in the shared pane query toolbar
([workspace](workspace.md)): the text filter and the sort select stay above the
rows; Type, View and Hide finished are inline options, each applied one a
removable chip; Clear filters keeps text and sort; Reset view clears all of it.
the visible grip owns dragging and its up/down menu; the ellipsis owns resource
actions. reorder requires a complete, unfiltered custom-order view of a named
library the viewer manages. `CollectionOrderProvider` owns one exact pending
move per account/collection across panes, monotonic snapshots and tab-scoped
recovery. a successful move adopts its acknowledgement immediately; uncertainty
retains the original request in session storage and offers `check order`.
recovery reads current truth, replaying only at the original unchanged revision;
a greater revision fences old intent. filters and sort keep their own projection.
geometry and the visible insertion line share one successor; only the owning
pane scrolls, and invalid or interrupted releases write nothing. see
[the reorder contract](../index-reordering-plan.md).
a library the
viewer cannot see says "Library not found" in place, on the first read or on a
reread (deleted meanwhile, or the viewer left or was removed).

## Reading Slate

`services/suggestions.py` owns relevance (see [connections](connections.md)).
`GET /libraries/{id}/suggestions` returns up to ten suggestions outside the
library's complete placement, related to one of five anchors; member-only and
system libraries get none. Add files through the placement route.

## System libraries

`libraries.system_key` marks a system-maintained library (the Oracle Corpus).
It reads like any library and is never user-mutable; `ensure_system_library` and
`join_system_library` maintain it, and its membership never makes co-members'
highlights visible to each other.

## Membership versus resource sharing

A library is shared only through membership and invitations (the Members tab of
the inspector); it never has a grant or a public link. Users and invitations are
addressed by plain uuids (owner decision 2026-10-10). Placement ("Libraries…")
is a resource action of media and shows, separate from Share. See
[resource sharing](resource-sharing.md).

## Library dossier

Library Dossier is one binding of the Universal Dossier engine keyed by the
library subject and audience: membership is its read and generation boundary.
Its citations are `resource_edges` from `artifact_revision:<id>`.
