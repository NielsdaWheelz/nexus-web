# the personal lane once ranked another note above the one the question names

status: open · origin: 2026-10-05 combined oracle landing (cleanup/oracle-reauthor, harness run r14) · area: oracle / search

the isolated harness asks "Where does the grey heron wait in the shallow water?" as
the owner, whose personal fixtures are four single-subject notes (lighthouse,
beekeeping, heron, ...); its fake model takes the first `user_media` candidate. in 12
recorded runs the heron note came first; in r14 (at 2c53a1fe9) the folio cited "Beekeeping
Through Winter" instead (`J4.unresolvable-typographic` precondition), and r15 on the
same commit passed. the lane is semantic only: `readings._prepare` asks
`search.semantic.nearest_chunks` under `_PERSONAL_CHUNKS` (before the search reauthor,
the deleted `search/chunks.retrieve_content_chunk_candidates`) and keeps the first
chunk per owner, so the same question over the same notes ranked differently once: a
reindex in flight (the owner's index not `ready`), an approximate ivfflat miss, or a
tie, unknown. `nearest_chunks` orders by cosine, ties by chunk id (as the old lane's
`cc.id` did), so a tie cannot reorder the lane.

proposed: the journey now prints the personal candidates the snapshot offered, in
order (from the job's frozen admission); on the next occurrence, compare them with the
heron media's index state at that moment.

acceptance: the cause is named and fixed, or shown to be the harness's index timing
and this ticket deleted.
