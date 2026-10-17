# release: libraries (PR A collections, placement and the chooser; PR B membership and sharing)

PR A changes these contracts at once; the api refuses the old forms and there is
no compatibility arm. the final combined release uses `X-Nexus-Wire: 2`:
web and api deploy together from the release sha, and an old tab fails its
library requests until reloaded.

| before | after |
|---|---|
| `GET /libraries?sort=created\|name&direction=` | `?sort=created_desc\|name_asc\|name_desc` (absent: oldest created) |
| `POST /libraries {library_id, name}`; same id, other name 409 | `{id, name}`; same id and owner answers that row |
| `PATCH /libraries/{id} {name}` | `{name, expected_name}`; 409 `{current_name}` when renamed meanwhile |
| `DELETE /libraries/{id}` 404 when absent; tore down media it alone held | 204 when absent or invisible; such media move to the owner's All |
| `LibraryOut` `owner_user_handle`, `can_rename`, `can_edit_entries`, `can_manage_members` | `can_manage` (one flag), no owner handle |
| entries `?sort=title&direction=asc`, `projection=in-progress`; rows `{placement, media{…}, subscription, reading_time_estimate, podcast{…}}` | `?sort=title_asc…`, `projection=in_progress`; rows `{entry_id, added_at, media_summary}` / `{entry_id, added_at, podcast_id, title, contributors, unplayed_count, published_date, sync_status}` |
| `PATCH /libraries/{id}/entries/reorder {entry_ids}` | `PUT /libraries/{id}/entries/{entry_id}/position {before_entry_id}` |
| `GET /media/{id}/libraries`, `GET /podcasts/{id}/libraries` | `GET /libraries/placements/{media:<id>\|podcast:<id>}` (flat rows) |
| `POST /media/{id}/libraries`, `PUT/DELETE /media/{id}/saved-in-nexus`, `DELETE /media/{id}/libraries/{lib}`, `PUT/DELETE /libraries/{lib}/podcasts/{pid}` | `PUT/DELETE /libraries/{lib}/items/{ref}` (`{replace_episodes}` on PUT; Saved in Nexus is the viewer's own All) |
| `GET /libraries/writable-destinations` `{data, page{has_more, next_cursor}}` | `GET /libraries/destinations` `{data: [...]}`: complete array; every query parameter refused |
| `GET /extension/library-destinations` (old envelope) | the same complete array and query refusal |
| subscribe `replacement_confirmation{conflict_fingerprint}`; 409 details `conflict_fingerprint` | `replace_episodes: bool`; 409 details `{conflicts[{library_id, library_name, episode_count}]}` |

## pairing (from the release sha, in the one release)

- **web + api**: one deploy. a tab open across it fails library reads and writes
  (422/400 or a decode error) until reloaded.
- **firefox extension**: rebuild and ship from the release sha. the old popup
  decodes the old destinations envelope and fails its destination search; capture
  without destinations still works. owner signs and ships it with the end
  release (pairs with the capture slice).
- **android**: no apk change (the `/share` capture page is web in the webview).

## preflight / env / data

- no migration (head stays the sweep's 0279), no env change, no backfill.
- data effects after deploy: removals leave gaps in `library_entries.position`
  (nothing reads density; a move renumbers its library 0..n-1). keyset cursors
  minted before the deploy answer `400 E_INVALID_CURSOR` once ("Refresh list").
- rehearsal census on a restored backup (mac only), for the release notes:
  - libraries with more than 500 entries (the old reorder cap's reach):
    `select library_id, count(*) from library_entries group by 1 having count(*) > 500;`
  - media whose only entry is one named library (deleting that library now
    re-files them instead of deleting them):
    `select le.media_id from library_entries le join libraries l on l.id = le.library_id where not l.is_default and l.system_key is null group by le.media_id having count(*) = 1 and (select count(*) from library_entries x where x.media_id = le.media_id) = 1;`
  - named libraries holding both a show and its episodes (expect 0):
    `select le.library_id from library_entries le join libraries l on l.id = le.library_id join podcast_episodes pe on pe.media_id = le.media_id join library_entries s on s.library_id = le.library_id and s.podcast_id = pe.podcast_id where not l.is_default and l.system_key is null;`

## owner smoke after release

- create, rename (a second tab still showing the old name gets "Someone changed
  this meanwhile") and delete a library; a media held only there appears in All.
- Libraries… on a media: Saved in Nexus off/on, file into a library, create and
  file; on a show whose episodes a library files: the replace confirm.
- drag a row in a named library; reload: the order holds.
- Add content: add a link, then the row's Libraries and Libraries for all….
- extension popup: destinations search, Load more, toggle, save.

## PR B: membership and sharing

Users, invitations and grants are plain uuids on the wire; the sealed `nus1.`,
`nli1.` and `nrg1.` handles are gone (share tokens, upload sessions and discovery
targets stay sealed). Same cutover as PR A: no compatibility arm, web and api
deploy together.

| before | after |
|---|---|
| `GET /libraries/{id}/members` `{data: [...], page: {next_cursor}}`, rows `user_handle` | `{data: {items, next_cursor}}`, rows `user_id` |
| `PATCH /libraries/{id}/members/{user_handle} {role}` → member | `PATCH …/members/{user_id} {role, expected_role}` → 204; 409 `{current_role}` when changed meanwhile |
| `DELETE /libraries/{id}/members/{user_handle}` (admin only) | `…/members/{user_id}` (admin, or the viewer themself) and `DELETE /libraries/{id}/membership` (leave); absent → 204 |
| `POST …/transfer-ownership {new_owner_user_handle}` → `LibraryOut`; a retry after success 403 | `{user_id}` → 204; already that owner → 204 |
| `POST …/invites {invitee: {kind, user_handle}, role}`; a retry 409 | `{id, invitee_user_id, invitee_email, role}` → 201; the same id answers that invitation |
| `GET …/invites?status=` `{data, page}`; `invitee_email` always | `?cursor&limit`, pending only, `{items, next_cursor}`; `invitee_email` only as the inviter typed it (or once a member), else null |
| `GET /libraries/invites?status&limit` (unpaged, at most 100) | `?cursor&limit` page with `library_name`, `inviter_email`, `inviter_display_name` |
| `POST /libraries/invites/{handle}/accept\|decline` → `{invite, membership?, idempotent}` | `…/{invitation_id}/accept\|decline` → 204 |
| `DELETE /libraries/invites/{handle}` | `…/{invitation_id}`; absent or invisible → 204 |
| `LibraryOut` | adds `can_leave` |
| `GET /users/search` `{data: [{user_handle, email?, display_name?}]}`, email prefix | `{user_id, email, display_name}`; display name contains, or exact email (email returned only then) |
| shares `{audience: {kind: "User", user_handle}}`, grants `handle`; the grantee's `email` always | `{id, audience: {kind: "User", user_id, email}}`, grants `id`; a non-reader's create is 404 (was 400); the grantee's `email` only as the sharer typed it, else null |
| `DELETE /resource-shares/{grant_handle}`; absent 404 | `/{grant_id}`; absent or not the viewer's → 204 |
| `GET /extension/session` `user_handle` | `user_id` |

### pairing

- **web + api**: one deploy, as PR A.
- **firefox extension**: the session decoder reads `user_id`; the old popup
  fails its session read against the new api. Ship the rebuilt extension with
  the release. A capture pinned before the update is bound to the old handle
  and reads as another account's: finish or discard pinned captures before
  updating (owner step).
- **android**: no change.

### preflight / env / data

- migration `0280_typed_counterparty_emails` (after 0279): adds nullable
  `library_invitations.invitee_email` and `resource_grants.grantee_email`. every
  existing row gets NULL, so existing pending invitations and person grants show
  the invitee's or grantee's display name, or "Unknown person" without one
  (nothing typed was stored before). nothing is refused; downgrade drops both
  columns. no env change, no backfill.
- rehearsal census on a restored backup, for the release notes:
  - pending invitations and person grants that will read "Unknown person"
    (counterparty without a display name):
    `select (select count(*) from library_invitations i join users u on u.id = i.invitee_user_id where i.status = 'pending' and u.display_name is null), (select count(*) from resource_grants g join users u on u.id = g.grantee_user_id where u.display_name is null);`
  - non-owner members of named libraries (who now see Leave library…; system
    libraries offer no Leave):
    `select count(*) from memberships m join libraries l on l.id = m.library_id where m.user_id <> l.owner_user_id and not l.is_default and l.system_key is null;`
  - accounts without a display name (people search now finds them only by
    exact email): `select count(*) filter (where display_name is null), count(*) from users;`
  - viewers with more than 100 pending invitations (the old inbox cap):
    `select invitee_user_id, count(*) from library_invitations where status = 'pending' group by 1 having count(*) > 100;`

### owner smoke after release

- invite a second account by display name (and once by exact email), accept
  from the other account (the row names who sent it), change its role, then
  leave from that account's library pane.
- transfer ownership and back; remove a member (Cancel returns focus to the
  row's Actions button).
- share a media with a person, open it as them, remove the share; turn a
  public link on and off.
- extension: reconnect, the popup shows the account, a capture saves.
