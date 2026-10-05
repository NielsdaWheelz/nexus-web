# oracle anchor chips stay typographic between a corpus reindex and the next reading

status: open · origin: 2026-10-04 oracle rewrite (cleanup/oracle-reauthor) · area: oracle corpus

anchor pointers heal lazily: only the reading job's `corpus.refresh_anchors` writes
them (reads never write). after a corpus work is reindexed (heading normalization,
an embedding cutover), its anchors point at deleted chunks, so every existing
folio's public chips for that work render without a link until someone asks a new
reading. the harness journey `J9.reindex-self-heals` shows the heal.

fix if it matters: refresh anchors from the reindex completion of a corpus media.
acceptance: a reindexed work's chips link again without a new reading.
