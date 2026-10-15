# external note materialization drops an authored continuation

status: open; essays repair unresolved, not applied
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

in `python/nexus/services/html_apparatus.py`, `_inferred_note_html` collects
continuation paragraphs, but `_materialize_external_targets_in_document`
recovers the leading paragraph and rebuilds the body from that paragraph alone.
preserve the verified complete body at this owner. retain refusal for unproved
boundaries; do not broaden inference, special-case this book or alter retained
fragments. this shared extraction fix is outside the bounded repair campaign.

acceptance: real-source preview preserves both paragraphs, rich structure,
label, reciprocal links and valid retained locators. qualify the full book
proposal and normal consumers before applying it. the positive raw-fragment
bridge remains not run because it cannot make this incomplete body safe.
earlier probe digest/wrapper mistakes and nine source-body versus retained-quote
differences remain separate observations, not additional extraction failures.
