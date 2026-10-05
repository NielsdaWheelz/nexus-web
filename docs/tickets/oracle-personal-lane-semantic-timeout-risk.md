# the oracle's personal lane inherits the semantic search timeout risk

status: open · origin: 2026-10-04 oracle rewrite (cleanup/oracle-reauthor) · area: oracle / search

`readings._prepare` calls `search/chunks.retrieve_content_chunk_candidates`, an
ANN-ordered query over every visible media and note chunk (corpus media excluded in
SQL), limit 200. on a restored production corpus the semantic document search
already times out (`semantic-document-search-times-out-on-restored-corpus.md`); a
timeout here fails the job, and a job that keeps failing dies with its reading
pending (`oracle-dead-jobs-can-lose-publication-replay.md`).

prerequisite: the semantic search timeout ticket's diagnosis.
acceptance: a production-scale reading's personal lane completes inside the
statement timeout, or its failure settles the reading typed.
