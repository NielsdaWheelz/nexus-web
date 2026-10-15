# apparatus target ordering can invert nested source lists

status: open; reader impact under review; cosmic repair not approved
origin: 2026-10-15 retained-book source qualification, candidate `150328b65`
area: html apparatus / retained reader repair

`python/nexus/services/html_apparatus.py:1806` forms `_source_order_key`
by summing preceding sibling counts along the ancestor chain. that sum does
not preserve document order across sibling subtrees.

cosmic's proposed target order moves 195 positions and has 71 adjacent source
inversions across three documents. its old per-document target order matches
the source. one inversion places `ol[2]/li[2]/p` before `ol[1]/li[9]/p`.
private diagnostic: `book-repair/b-reader/cosmic-content-review-v1/sort-order-diagnostic.json`,
sha256 `ae937e23bccfce07ba458b0a17dd4ba438bb46626f2a3190c624a021cb20e9d3`.
the failed source-order proof is retained.

`reader_apparatus.py:228` orders target rows by this key. the current
document-map consumer also uses marker ownership and retained locators;
whether this target-only permutation changes a visible reader list remains
unproved. body correspondence does not establish correct ordering.

next: establish the actual ordering contract and trace every current consumer.
if source order is required, fix the shared extraction owner with a true
document-order representation, then requalify affected proposals and bounds.
do not weaken the source check merely to match the implementation.

acceptance: source and consumer evidence establish correct ordering, or an
explicit bounded disposition records why this internal permutation does not
change supported reader behavior while any latent defect remains open.
cosmic apply and consumer qualification require that decision first.
