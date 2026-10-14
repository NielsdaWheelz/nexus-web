# release: libraries (PR A, collections, placement and the chooser)

PR A changes these contracts at once; the api refuses the old forms and there is
no compatibility arm. `X-Nexus-Wire` is not bumped during the campaign
(conventions): web and api deploy together from the release sha, and an open tab
fails its library requests until reloaded.

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
| `GET /libraries/writable-destinations` `{data, page{has_more, next_cursor}}` | `GET /libraries/destinations` `{data: {items, next_cursor}}` |
| `GET /extension/library-destinations` (old envelope) | the same `{items, next_cursor}` page |
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
