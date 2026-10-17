# pillow original note links disagree

status: open; inherited source defect, outside the selected repair pairs.
origin: 2026-10-15 retained-book campaign, exact original-source review.
area: epub source apparatus / link correspondence.

the original for `34a607a2-ee0e-4800-9681-a9d6a346e669`, sha256
`8f625aa3c9f1fd0084e1c014fc27a390f3d278bc1f50519a0272ebef7a60e88f`,
contains two distinct numbered note paragraphs with inconsistent source links:

- `OEBPS/html/notes.html#ich53en02` returns to `chapter.html#ch52en01`,
  whose opener targets `ich52en01`. the separate `ch53en02` opener correctly
  targets `ich53en02`.
- `notes.html#ich109en02` returns to `chaptera.html#ch109en02`, but that
  opener targets `ich104en02`.

both paragraphs are explicit second notes under their corresponding numbered
subsection headings. neither belongs to the 570 newly proposed note pairs.
these are authored source inconsistencies, not demonstrated repair damage or
installed-reader failures. their distinct note boundaries must not be described
as proved reciprocal pairs.

evidence: private `c-sources/pillow-two-original-note-link-mismatches-v1.json`
binds the exact three source documents, generation 2, and frozen proposal
`463eb45b6f8d3f9654353eb42d0f9b057435dd0cfad122911130638ffa94c257`.
all source input comes from the previously admitted archive; no new retrieval.

prerequisite and fix: retain this source-defect disposition. any later link
correction needs independent intended-destination evidence and an explicit
source-repair policy; matching identifier suffixes alone must not rewrite links.

acceptance: establish each intended destination independently, apply only a
source-proved correction and verify actual forward/return routing without
changing other notes. the current campaign may finish with these source defects
explicitly unresolved; that disposition leaves this ticket open.
