# a second highlight delete answers 404

status: open · origin: 2026-10-20 db substrate harness (`ORM.highlight-delete-idempotent`) · area: reader python / highlights

`DELETE /highlights/{id}` of a highlight that is already gone answers
404 `E_MEDIA_NOT_FOUND`. `delete_highlight_in_current_transaction`
(`python/nexus/services/highlights.py:941`) reads the highlight through
`get_highlight_for_author_write_or_404` (`:105-114`), which 404s on a missing
row, before `delete_highlight_rows` (whose own missing-row branch at `:913`
returns quietly) can run.

the reader sends its delete directly, outside the tab write queue, and clears the
mark only after success (`apps/web/src/app/(authenticated)/media/[id]/annotations.ts:268-272`).
after a lost reply the mark stays painted until the map is next read, and deleting
it again meets the 404 and says "Highlight wasn’t deleted"
(`media/[id]/useAnnotationVerbs.ts:161-168`). source at `2e154f053`, not run.

impact: AGENTS.md says a delete is idempotent; a client retrying a delete whose
answer was lost sees a failure for a delete that landed, and the code names
media for a highlight. pages, libraries, grants and media answer 204 twice.

evidence: harness runs `2026-10-20/db/harness/runs/baseline-*.txt` (main
`4428634e8` and `f2025d935`): DELETE 204, again 404 E_MEDIA_NOT_FOUND.

fix: a missing highlight answers 204 (as a missing media does); one owned by
another user stays 404. keep authorization and the parent media lock for a live row.

resolved when: the harness journey's second DELETE answers 204, and the reader's
second delete of a mark whose first reply was lost clears it without a failure notice.
