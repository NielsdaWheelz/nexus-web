# historical note indexes need owned recovery

status: open
origin: 2026-09-26 read-only production processing investigation
area: note indexing

production `7dc68929b4d5ddfd77eb1a50228d477fa0148b5d`, database `0241`:
note blocks `b82f3d88-aac1-4a8c-a242-c82bdb2078ca` and
`3de3a281-5092-488f-92d1-b2671db59911` have failed index states dated
2026-06-17: `E_INTERNAL: Object of type UUID is not JSON serializable`.
`services/note_indexing.py:20-42`, `services/content_indexing.py:572-622`,
and `jobs/registry._run_note_reindex` (formerly `tasks/note_reindex.py:39-42`) serialize these inspected identities as strings.
a pure current locator serialization probe passed; full reindex was not run.
no retained queue work was identified for these historical obligations.
the original failing serialization field and any historical correction remain
unidentified; a narrow successful probe does not establish either.

verify current note existence/content and provider readiness; invoke the
existing owned note reindex admission. preserve note identity and authoring
history. only change serializer code if current execution reproduces a defect.

acceptance: each current note becomes ready/no-text as appropriate and searchable
when nonempty, with no uuid serialization error or duplicate content chunks.
