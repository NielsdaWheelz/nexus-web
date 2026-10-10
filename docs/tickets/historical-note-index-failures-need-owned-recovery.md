# historical note indexes need owned recovery

status: open
origin: 2026-09-26 read-only production processing investigation
area: note indexing

production `7dc68929b4d5ddfd77eb1a50228d477fa0148b5d`, database `0241`:
note blocks `b82f3d88-aac1-4a8c-a242-c82bdb2078ca` and
`3de3a281-5092-488f-92d1-b2671db59911` have failed index states dated
2026-06-17: `E_INTERNAL: Object of type UUID is not JSON serializable`.
the note path at the time (`services/note_indexing.py`, `services/content_indexing.py`
chunk locators, `jobs/registry._run_note_reindex`) serialized these identities as
strings; the 2026-10-10 reauthor rewrote it (`note_indexing.run_note_reindex_job`,
`content_chunking._chunk_locator`) with the same string ids.
a pure current locator serialization probe passed; full reindex was not run.
no retained queue work was identified for these historical obligations.
the original failing serialization field and any historical correction remain
unidentified; a narrow successful probe does not establish either.

migration `0273` re-admits them: it enqueues one `backfill` `note_reindex_job`
for every `pending` or `failed` note index whose note exists and has no live job.
what remains is to watch those jobs in production after the release: verify
current note existence/content and provider readiness first. preserve note
identity and authoring history. only change serializer code if current execution
reproduces a defect.

acceptance: each current note becomes ready/no-text as appropriate and searchable
when nonempty, with no uuid serialization error or duplicate content chunks.
