# two old web publications lack heading normalization required by indexing

status: open; exact clone heading prerequisite satisfied, index/consumer qualification pending
origin: 2026-09-26 read-only production investigation
area: reader publication / content index

the 2026-09-26 production investigation at
`7dc68929b4d5ddfd77eb1a50228d477fa0148b5d` found dead current index
jobs for this living hand `16b411ce-d0f6-47aa-8bc6-22827cfb9ab0` and letters
of keats to fanny brawne `51c2b8a8-1352-4bde-9f87-4a8234e6dc13`:
`web source fragment is missing Nexus heading anchors`.
`services/content_indexing.py:213-218` requires publication normalization.

exact stored-body probes found 1 and 56 headings missing ids. current heading
normalization is idempotent, preserves the stored canonical text byte-for-byte,
loses no authored ids, and yields 14 and 521 valid index blocks. neither source
has fragment-only links; both have zero highlight anchors. private evidence:
`/tmp/nexus-processing-review-20260926/index-normalization-probe.json`.

the 2026-10-15 read-only clone census now proves the exact retained html of both
publications is already idempotent under `web_article_structure.add_heading_anchors`.
the fragment ids are `bd65d0fd-b130-45ec-aac1-a2824db5511c` and
`e7957164-8d4d-440e-a9b8-969541ec7139`; both publication generations are 4.
their full fragment rows and source hashes equal the frozen repair inputs.
all 52 selected articles pass this prerequisite. private evidence:
`a-maintenance/selected52-early-census-v1/root-execution/execution/output/census/receipt.json`
sha256 `9c7ab5bd21882b1d9c76e5ed419cc9bd9268d8ba911450bf837891c5eb3d4949`,
with `article-readiness.json` sha256
`6f8333005e89f6c90c1a1f57df9153168188d09007db32776bcf372a3e43436b`.

this establishes the current clone prerequisite, not when normalization occurred,
current production readiness, a successful index run or consumer acceptance.
do not normalize these already-normalized clone rows again. merged #609 skips
reindex for equal complete index inputs; qualify that preservation on the final
artifact. any required ordinary reindex still has the
separate [saved-evidence preservation gap](reindex-invalidates-saved-evidence-targets.md).
if a later production read actually finds unnormalized html, use the existing
reader publication owner, preserving fragment ids, canonical text, authored
targets and saved reader state. retain old failed job history; do not refetch
changing remote html or weaken the index assertion.

acceptance: both indexes become ready; search resolves valid passages; existing
reader positions and canonical offsets survive; ordinary reader rendering works.

the historical cursor census found letters at revision 1, with the existing fragment id and text
offset 52; this living hand has an empty revision-2 cursor. these are concrete
preservation obligations for repair, not permission to reset reading progress.
