# integrated publication retries during unrelated edits

the actual0312→0315→0316 rehearsal passes canonical/vector preservation and all
fifteen logical/native families on `a3e6b8ee2`. its subsequent book replacement
needs two serializable attempts: the first rolls back with40001 after21.8s,
the second commits after25.1s. this fails the controlled single-attempt gate.

postgres identifies the failing statement as the final content-chunk projection
`INSERT INTO keyword_occurrences … SELECT FROM content_chunks JOIN
content_index_states`, with a conflict-out-to-pivot during read. it is neither
the source-clock upsert nor old-key withdrawal. normal diagnostics do not name
the conflicting relation or other participant; the dependency cycle is unproved.
unrelated colour/note edits acknowledge200 and are reread before publication
commits; the collector skips later reads after a separate related timeout.

private evidence: `search-release-integration/corpus-client/run/artifacts/`
and `corpus-final-host.private.json`. publisher cleanup, native withdrawal and
original source equality pass. the overall receipt remains failed/quarantined;
all owned services and credentials were removed normally, without oom.

resolve the actual shared read/write dependency through the real mutation owners.
prove the controlled unrelated edits commit promptly and publication commits once;
retain bounded retries for genuinely conflicting writers. freeze retrieval.
