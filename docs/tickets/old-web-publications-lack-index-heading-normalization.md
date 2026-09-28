# two old web publications lack heading normalization required by indexing

status: open
origin: 2026-09-26 read-only production investigation
area: reader publication / content index

production `7dc68929b4d5ddfd77eb1a50228d477fa0148b5d` has dead current index
jobs for this living hand `16b411ce-d0f6-47aa-8bc6-22827cfb9ab0` and letters
of keats to fanny brawne `51c2b8a8-1352-4bde-9f87-4a8234e6dc13`:
`web source fragment is missing Nexus heading anchors`.
`services/content_indexing.py:213-218` requires publication normalization.

exact stored-body probes found 1 and 56 headings missing ids. current heading
normalization is idempotent, preserves the stored canonical text byte-for-byte,
loses no authored ids, and yields 14 and 521 valid index blocks. neither source
has fragment-only links; both have zero highlight anchors. private evidence:
`/tmp/nexus-processing-review-20260926/index-normalization-probe.json`.

normalize these stored publications through `services/reader_publication.py`,
preserving fragment ids, canonical text, authored targets and saved reader
state. advance publication generation and request a fresh index revision in
the same transaction. retain old failed job history. do not refetch changing
remote html or weaken the index assertion.

acceptance: both indexes become ready; search resolves valid passages; existing
reader positions and canonical offsets survive; ordinary reader rendering works.

current cursor census: letters has revision 1, the existing fragment id and text
offset 52; this living hand has an empty revision-2 cursor. these are concrete
preservation obligations for repair, not permission to reset reading progress.
