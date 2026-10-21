# apparatus target ordering can invert nested source lists

status: open; cosmic's supported ordering preserved; api/device acceptance pending
origin: 2026-10-15 retained-book source qualification, candidate `150328b65`
area: html apparatus / retained reader repair

`python/nexus/services/html_apparatus.py` (`_source_order_key`) forms the key
by summing preceding sibling counts along the ancestor chain. that sum does
not preserve document order across sibling subtrees.

cosmic's proposed target order moves 195 positions and has 71 adjacent source
inversions across three documents. its old per-document target order matches
the source. one inversion places `ol[2]/li[2]/p` before `ol[1]/li[9]/p`.
private diagnostic: `book-repair/b-reader/cosmic-content-review-v1/sort-order-diagnostic.json`,
sha256 `ae937e23bccfce07ba458b0a17dd4ba438bb46626f2a3190c624a021cb20e9d3`.
the failed source-order proof is retained.

`reader_apparatus.py:228` orders target rows by this key, but
`ReaderApparatusResponse` is an internal payload, never serialized. the product
contract is passage groups in document order (`docs/modules/reader-implementation.md:278`).
all 1,774 cosmic locators are exact/current; each of its 887 targets belongs to
one unchanged marker and edge. actual composition produces the same 887 resolved
passage groups, target references, activation and ordering before/after.
reverting only proposed target sort keys yields identical complete composition.
private receipt: `book-repair/a-maintenance/cosmic-evidence-order-v1/receipt.json`,
sha256 `bb896718f08690d33dd942b5ac2aabcab9bc9c2512dc80d6c4c2359ac9471144`.
all 1,774 body-link document/anchor keys are unique and retain the same locator
map, so target enumeration cannot introduce a last-write collision:
`a-maintenance/cosmic-body-link-order-census.json`, sha256
`73a3ecd196f1ea9ba65bc859c527f63bfe4aaf51c764fa5d6946808f9635c07d`.

bounded disposition: preserve these supported consumer semantics and continue
cosmic qualification without changing the shared extractor. the source-order
defect and failed source-order proof remain open. the cost is leaving a latent
ordering defect for other source shapes; this evidence covers only these exact
cosmic rows. api/body-link rendering, browser and phone acceptance remain pending.

next: fix the shared extraction owner with a true
document-order representation, then requalify affected proposals and bounds.
do not weaken the source check merely to match the implementation.

acceptance: source keys preserve actual document order across nested sibling
subtrees, with affected extraction and consumer behavior requalified. the
bounded cosmic disposition does not close the shared defect.
