# release: notes (index and online-only writing)

the commits "reauthor the notes index" and "make note writing online-only with one undo
stack" ship with the campaign's one release.

- **api and web deploy together** (hard cutover): every notes route and shape changed
  (`docs/modules/notes.md`). `GET`/`PATCH /notes/pages/{id}` and the resource-items
  surface, title and body routes are gone; capture takes `{note_id, text}`; annotation
  detaches take the note id in the path. `X-Nexus-Wire` is not bumped here (R6; the edge
  slice's first value covers every pre-release break). an open tab from before the deploy
  fails its notes writes until it reloads. the apk carries no notes code (share is a web
  page).
- **no migration, no env, config or job change.** `note_reindex_job` and its payload are
  unchanged. notes-scope rows of `resource_mutations` (`daily:capture`,
  `highlight_note:*`, `link_note:*`, `resource:*:surface_commands|title|body`) become
  unread; the slice that removes the table's last user drops it.
  `resource_view_states.state.collapsed` stays unread.
- **owner step, before the deploy**: in every browser profile and in the android app,
  open nexus on the OLD build and wait until no "unsaved" or recovery banner shows on
  notes, pages, Today and highlight notes, then close those tabs. the new build never
  reads `nexus.writingJournal:v{3,4,5}:*` or `nexus.dailyHandoff:v2:*`; what they hold
  is lost otherwise (owner decision: accepted loss).
- **rehearsal census on the restored backup (read-only)**:
  - (a) link marks the new grammar refuses. the server now validates every body write,
    so a stored unsafe href makes its note unsavable.
    `SELECT n.id, h FROM note_blocks n, jsonb_path_query(n.body_pm_json,
    'lax $.**.marks[*] ? (@.type == "link").attrs.href') AS h;` then check each href
    with `nexus.schemas.notes.safe_href`. if any fail, add one data migration that strips
    only those link marks (keeping the text) and bumps the notes' `body` versions,
    refusing on anything else; the census must then read zero.
  - (b) informational: empty notes with no place (no user link, `highlight_note`,
    `link_note` or `citation` edge); the old build left one per Enter-then-Backspace.
    they are not deleted by this release.
  - (c) informational: notes and pages with no `resource_versions` row; they read as
    version 1 and get rows on their first write.
- **post-deploy smoke**: create a titled page from the notes index (the first row is
  focused); type, wait 2 s, reload (saved); Enter, Tab, Shift-Tab, Cmd-Z and
  Cmd-Shift-Z in a page; "Add “…” to Today" from the launcher (Today opens with the
  caret after the text); write and remove a highlight note in the reader; open
  `/daily/{tomorrow}` (nothing stored until typing).
