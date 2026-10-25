# integrated publication retries during unrelated edits

the actual0312→0315→0316 rehearsal passes canonical/vector preservation and all
fifteen logical/native families on `a3e6b8ee2`. its subsequent book replacement
needs two serializable attempts: the first rolls back with40001 after21.8s,
the second commits after25.1s. this fails the controlled single-attempt gate.

postgres identifies the failing statement as the final content-chunk projection
`INSERT INTO keyword_occurrences … SELECT FROM content_chunks JOIN
content_index_states`, with a conflict-out-to-pivot during read. it is neither
the source-clock upsert nor old-key withdrawal. a later local probe observes no
publisher state-table predicate lock before that insert, then a relation-level
lock when its natural plan scans the state table. this proves a late broad read
in the local fixture; the historical dependency cycle remains unproved.
unrelated colour/note edits acknowledge200 and are reread before publication
commits; the collector skips later reads after a separate related timeout.

private evidence: `search-release-integration/corpus-client/run/artifacts/`
and `corpus-final-host.private.json`. publisher cleanup, native withdrawal and
original source equality pass. the overall receipt remains failed/quarantined;
all owned services and credentials were removed normally, without oom.

`0a4098235` passes the publisher's own revision to its exact chunk projection,
removing that late state-table join. the paired local probe observes no state-table
plan node or new predicate lock at the final insert; the publication and unrelated
edit each commit once with live claims. all twenty projected columns match
canonical rows, and native occurrence membership matches all 256 chunk refs.
the three retained local checks also pass.
these local results do not change the earlier failed populated receipt. resolve
after the affected populated operation proves the same single-attempt publication
and durable unrelated edits. retain bounded retries for genuinely conflicting
writers; retrieval remains frozen.
