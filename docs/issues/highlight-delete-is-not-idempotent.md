# a second highlight delete answers 404

status: open · origin: 2026-10-20 db substrate harness (`ORM.highlight-delete-idempotent`) · area: reader python / highlights

`DELETE /highlights/{id}` of a highlight that is already gone answers
404 `E_MEDIA_NOT_FOUND`. `delete_highlight_in_current_transaction`
(`python/nexus/services/highlights.py:941`) reads the highlight through
`get_highlight_for_author_write_or_404` (`:105-114`), which 404s on a missing
row, before `delete_highlight_rows` (whose own missing-row branch at `:913`
returns quietly) can run.

impact: AGENTS.md says a delete is idempotent; a client retrying a delete whose
answer was lost sees a failure for a delete that landed, and the code names
media for a highlight. pages, libraries, grants and media answer 204 twice.

evidence: harness runs `2026-10-20/db/harness/runs/baseline-*.txt` (main
`4428634e8` and `f2025d935`): DELETE 204, again 404 E_MEDIA_NOT_FOUND.

fix: a missing highlight answers 204 (as a missing media does); one owned by
another user stays 404.

resolved when: the harness journey's second DELETE answers 204.
