# historical epub source and published text drift

status: open; candidate fix under restored-clone review
origin: 2026-09-27 production corpus census, base `3029201f`
area: epub navigation repair

old-code inspect failed 17 of 239 hash-verified ready epubs because current
source reparse text or hrefs differed from retained publication rows. pillow and
montaigne are in this class. the immutable source size/sha256 checks passed;
private evidence: `/tmp/nexus-chapter-rehearsal.nx22kQ/census/receipts.jsonl`
(0600). exact source-text equality in `epub_ingest.py` rejected historical
published coordinates.

prerequisites: replay all 17 on the same restored clone with
`6eeea8989bf10c0e336f0193e42d6d95c197ad87`; classify true ordered-href
mismatches separately from text-only drift. use retained html/text for all
coordinates only after verified source hash, ordered href, self-canonical text
and authored target identity checks.

acceptance: every text-only case inspects and applies without changing retained
fragments or saved state; every unprovable href or target mismatch fails without
writing. delete this ticket when the full class is settled.
