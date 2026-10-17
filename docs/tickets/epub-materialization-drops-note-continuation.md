# external note materialization drops an authored continuation

status: open; eight whole-book repairs unsafe, not applied
origin: 2026-10-15 book-repair source review, operator `150328b65`
area: epub apparatus body materialization

the essays proposal truncates note 483. the verified original has a citation
paragraph followed by an edition-variant paragraph about the same quoted
passage, before numbered note 484. the proposal retains the first 78 canonical
characters and omits the 92-character continuation; the complete body has 172
characters including its separator. existing navigation and notes remain
unrepaired; this does not establish lost text in the installed publication.

media: `e6b755eb-c744-4391-b6ec-2b3ed2553837`; source:
`01c64cceac36df2ee70ea4a1be0696a1bed2fd27e2f70f736ab7c33cc5e9c597`;
target: `The_Complete_Essays_split_787.html#filepos4301288`.
private source/proposal receipt:
`c-sources/essays-omitted-continuation-source-disposition.json`, sha256
`e5a550e8b19f55865530d61322f59e830160eb1bd4e5e00b1ce7e299d2fadda9`.
independent source/semantic review:
`a-maintenance/essays-continuation-independent-review.json`, sha256
`11b18d0e4f14872466d1ca5cc3cf645eca0b922ec3fd238c0cfc1c72a8a0f003`.
both bind the original paragraphs, reciprocal marker and actual final proposal.

the same defect affects media `6a7716ee-32f2-4d5c-bda0-ae56b05838b6`,
source `8002ff3472082e7de811497c1d1ddd7d4c5a6a00b0c28625c9c3d42d2811c92e`,
target `OEBPS/chapter010.xhtml#A_11`. four contiguous authored note paragraphs
develop the same literary example before numbered note 12. the final proposal
retains only the leading 299 characters of the complete 5,471-character body;
it omits 5,169 continuation characters plus three paragraph separators. the
whole proposal remains unapplied; this does not establish installed-text loss.
private source/semantic packet:
`c-sources/apparatus-6a-continuation-disposition-v1.json`, sha256
`4d7ccea2ac23ed8c7a5cf26463a18263f15bcf0bfe3c934b5f67bb45fb7f9e14`;
independent review:
`a-maintenance/apparatus-6a-continuation-independent-review.json`, sha256
`f6551c3003b6b31671127adb517c31374bebb3831e402e44ef2965422c1a28be`.
both bind the original numbered-note interval and final proposal sha256
`b9161eb981056e82539e25dd0d6d212d3abca40557055e9ab734c30d3d58618c`.

four further exact original intervals reproduce the same materialization loss:

| media | target | omitted paragraphs / canonical characters |
| --- | --- | ---: |
| `dc0c28e2-8263-4bdd-8ef6-dcfd6781051c` | `OEBPS/text/9780007590087_Footnote.xhtml#fn-4` | 3 / 935 |
| `6fc37025-9aab-4a0f-aa0c-b94db2437e9c` | `OPS/html/chapter005.html#fn18` | 1 / 705 |
| `260d82bd-251c-404c-ba1d-3cb30a65232c` | `main-13a.xhtml#bookmark11` | 6 / 1,609 |
| `d580cfca-da7e-4a2c-b011-754a7c4df040` | `dummy_split_009.html#filepos135707` | 1 / 273 |

each continuation lies inside the uninterrupted numbered-note interval before
the next reciprocal note. source note headings, classes and adjacent return
links corroborate that ownership; no independent full-prose reading is claimed.
the existing body-boundary owner collects the complete interval, but the target
materializer reconstructs only its leading paragraph. these are whole-proposal
refusals; other fields are unadjudicated and installed text loss is not claimed.

exact source bytes, current/next reciprocal pairs and all four full proposals:
`b-reader/four-note-continuation-review-v2/receipt.json`, sha256
`e199dff75e94addc9b058b82562983b8ff1e51c88cbaad896ad8ca712f7d15b6`;
independent review `c-sources/four-note-continuations-independent-review.json`,
sha256 `ba76c18e93d15a9c1c66b0d06d391f5e35f66bb47f03297fd7735ae42d6cf334`.
earlier local assumptions about an empty named anchor are retained as proof
failures; the corrected checks bind its exact adjacent reciprocal link.

two more fixed intervals show the same loss:

- `24e67f54-353e-4791-8db5-72c935a4bf9c`,
  `text/part0035.html#iPIVC03_5`: note 5's leading paragraph ends with a
  colon, followed by a 1,072-character block quotation before independently
  reciprocal note 6. the quotation's only anchor is an empty page marker.
- `11980da0-9758-40ab-902e-4bd1ea0b77e7`,
  `OEBPS/Text/notes.html#N13_n64`: a 157-character unnumbered note
  paragraph follows note 64 before the next explicit titled notes division.
  the unrelated first note after that heading is outside the selected-pair
  census and carries no new reciprocal-proof claim.

both complete bodies are collected by the boundary owner and then reduced
to their leading paragraphs by the materializer. evidence:
`b-reader/two-further-note-continuation-review-v2/receipt.json`, sha256
`114976c612b70d827d0da514f044abb1100890f952cc77d2e0f8334600d91960`;
independent `c-sources/two-further-continuations-independent-review.json`, sha256
`2afc56aee9263aa8f492c83483206fc38c40cba064658fb00054dfed977feada`.
the second possible quotation in 24e67 and other proposed fields remain
unadjudicated. the earlier next-note census assumption is retained as a local
proof failure; no extraction rerun or broader source reading was performed.

in `python/nexus/services/html_apparatus.py`, `_inferred_note_html` collects
continuation paragraphs, but `_materialize_external_targets_in_document`
recovers the leading paragraph and rebuilds the body from that paragraph alone.
preserve the verified complete body at this owner. retain refusal for unproved
boundaries; do not broaden inference, special-case this book or alter retained
fragments. this shared extraction fix is outside the bounded repair campaign.

acceptance: real-source previews preserve every authored paragraph in all eight
cases, rich structure, labels, reciprocal links and valid retained locators.
qualify each full book proposal and normal consumers before applying it. the
essays positive raw-fragment bridge remains not run because it cannot make
the incomplete body safe.
earlier probe digest/wrapper mistakes and nine source-body versus retained-quote
differences remain separate observations, not additional extraction failures.
