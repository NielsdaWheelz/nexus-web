# the document embed aggregate is written and never read

**problem**: `document_embed_artifact_states` (status and four counts per document) is
created by embed extraction and re-aggregated on every resolution change, but nothing
reads it since `MediaOut.document_embed_summary` left the wire (media core C1). media
teardown no longer re-aggregates it for documents that embedded a deleted one (N6).

**impact**: a table, its writers and one query per resolution change for no reader;
counts of documents whose embed target was deleted go stale (no one sees them).

**evidence**: `python/nexus/services/document_embeds.py` (`_set_state_counts`, the state
row created at extraction and re-counted in the resolution update); the only reader,
`document_embed_summaries_for_media`, was deleted with the media core reauthor; the
teardown deletes the deleted document's own row (`services/media_deletion.py`).

**resolved when**: the reader slice drops the table, its model and its writers by
migration (or a reader of the aggregate exists again and teardown re-counts parents).
