# page-delete confirmation misstates note lifetime

status: open
origin: 2026-10-14 release phase6 cleanup review; source b6768bee
area: notes / resource actions

`apps/web/src/lib/actions/resourceActions.ts:350` confirms deletion of a page
“and its note blocks”. `services/notes.py:218–235` (under `python/nexus/`)
deletes the page, edges, daily binding and protocol state; it preserves the
independent note blocks. `db/models.py:206` has no note-to-page ownership fk.
the surface undo contract also explicitly preserves generated note resources
(`services/resource_items/surfaces.py:370`).

impact: the confirmation promises deletion the operation does not perform.
removing the page or an occurrence does not prove a scratch note was cleaned up.
this is source-confirmed at b6768bee; no production deletion was attempted.

fix the page confirmation at its copy owner to state that notes remain. keep
independent note lifetime intact. ordinary user-created note deletion is a
separate product decision: the current closed action union/routes provide none;
the existing hard-delete path only undoes a genuine assistant-created note
through its recorded assistant write. do not fabricate that provenance.

acceptance: the ordinary page-delete confirmation accurately says which data
survives; a bounded real check confirms page gone and independent note retained.
source review: release artifact `phase6-b6768bee-preparation/`
`note-cleanup-owner-review.json` (all responsible source hashes retained).
