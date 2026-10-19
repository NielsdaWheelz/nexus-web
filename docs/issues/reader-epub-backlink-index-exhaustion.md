# historical epub backlink index exceeds parser bound

status: open
origin: 2026-09-27 production corpus census, base `3029201f`
area: epub apparatus extraction

two of 239 hash-verified ready epubs failed inspect with `EPUB apparatus exceeds
its bounded index: HTML apparatus backlink count exceeded` from
`html_apparatus.py`. private evidence:
`/tmp/nexus-chapter-rehearsal.nx22kQ/census/receipts.jsonl` (0600). the repair
cannot establish note evidence within its declared parser budget.

prerequisites: inspect the two source backlink shapes and the existing output
bound; keep the index bounded while retaining all semantically relevant links.

acceptance: both epubs inspect and apply within the parser resource envelope,
or are proved unchanged and safe. otherwise the combined reader cutover waits;
no unbounded scan or silent link drop is introduced.
