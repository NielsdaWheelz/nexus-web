# release: resource references re-slice

status: owed with the next release · area: release / resource references

the re-slice changes the api and the web together (hard cutover). no
`X-Nexus-Wire` bump of its own: no request a current client sends changes shape,
and the removed response fields had no reader; it rides main's 13 (#688). no apk or
extension build.

owed steps:

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

resolved when: the owner smoke passed on the release carrying these changes; delete
this file then.
