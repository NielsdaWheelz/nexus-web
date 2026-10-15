# page delete is not idempotent

problem: `DELETE /notes/pages/{page_id}` answers 404 when the page is already gone
(`services/notes.py` `delete_page` → `get_page_for_owner_or_404`). the campaign rule is that
deletes are idempotent, and the actions design (§4.4) assumes it.

impact: a page deleted elsewhere between a menu's open and its Delete page click, or a manual
retry of a delete whose response was lost, shows "Could not Delete page / Page not found" and
leaves panes on the page unsettled (they show the page's own not-found). rare: the menu reads
the page's existence when it opens.

evidence: `python/nexus/services/notes.py` `delete_page`; the web's `deletePage`
(`apps/web/src/lib/notes/api.ts`) settles panes only after a 2xx.

fix: the notes slice's rewrite of the page delete answers 204 when the viewer has no such page
(nothing to delete), per the campaign idempotency rule; the web needs no change.

resolved when: a second `DELETE /notes/pages/{id}` for the same page answers 204 and a menu
delete of an already-deleted page settles its panes.
