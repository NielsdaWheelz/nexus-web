# message_retrievals.evidence_span_id is never read; media_id only for x-post locks

status: open · area: chat storage, media deletion, reindex, x-post access

`services/chat/retrievals.py` `insert_retrieval` writes `media_id` and `evidence_span_id`
on every retrieval row, and two other areas maintain them: media deletion nulls
`media_id` (`services/media_deletion.py` around lines 207 and 319) and reindexing nulls
`evidence_span_id` (`services/content_indexing.py` around line 139).

- `evidence_span_id` has no reader.
- `media_id` has two, both for canonical x posts: the x-post lifetime rule
  (`auth/permissions.py` `retained_x_post_roots_sql`, around line 53) and chat's own deletion lock, which locks the
  x-post media a deleted turn's retrievals name (`services/chat/conversations.py` around
  line 321).

every fact a reader shows comes from `result_ref` and `captured_evidence`. the chat
re-slice (migration 0300) dropped the eight write-only columns it owned alone; these two
are kept up by media deletion and reindex, so dropping them crosses three areas.

proposed fix: drop `evidence_span_id` with the reindex maintenance. for `media_id`, move
both x-post reads to the captured owner (`captured_evidence #>> '{target,owner_ref}'`, as
their quote and citation arms already do), then drop the column with the media-deletion
maintenance; or keep `media_id` and say why.

resolved when: every remaining `message_retrievals` column has a reader, or the unread
ones are gone together with their maintenance.
