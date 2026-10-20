# release: resource references re-slice

status: owed with the next release · area: release / resource references

the re-slice changes the api and the web together (hard cutover). no
`X-Nexus-Wire` bump of its own: no request a current client sends changes shape,
and the removed response fields had no reader; it rides main's 13 (#688). no apk or
extension build.

owed steps:

- migration `0301_drop_resource_view_state_payload` (on main's 0300).
  writers stopped. preflight on the newest backup:
  `SELECT count(*) FROM resource_view_states WHERE state <> '{}'::jsonb` must be 0;
  any row is a release blocker the owner decides, never a silent conversion (the
  migration refuses it). after: `resource_view_states` has no `state` column and no
  `ck_resource_view_states_state_object`; its row count is unchanged.
- owner smoke after deploy:
  - a library dossier's citation chip opens its passage for a member of that library.
  - Connections on a page: "add item" links an item; remove it again.
  - a chat's Context: remove one item; a removal made against an older version says
    "this connection can’t be removed here" and offers "refresh context".
  - a media's menu: its verbs load; "Remove from Nexus" confirms by quoting the bare
    title.
  - the Evidence pane of a book with links and citations loads, its link notes and
    source text render.
  - a footnote whose location is missing: its menu offers Chat about this…, which
    opens a chat quoting it; "add item" on its row links it by its words.

resolved when: the release carrying these changes ran the migration and the owner
smoke passed; delete this file then.
