# roughly half the cited receipts cannot be reached from the candidate

- status: open
- origin: 2026-09-14 adversarial review of the bounded-workspace implementation
- area: evidence / dossier auditability

## what is wrong

extracting every 16-hex receipt id from the four bounded-workspace dossiers gives
470 unique ids. `test-results/runs/` contains 253 of them; 217 are absent —
including load-bearing recent ones such as `1fc47eec594fefe3` (compact evidence
retirement), `de8b97e8117b6190` (visible gutter), `5b7cef176009c16f` and
`33dab28b28d0e746` (native table preparation) and `8367aa5c3498225a` (pulse).
they were produced in the separate proof checkouts the dossiers name.

`.gitignore:49` ignores `test-results/`, so none of them travels with the change
either. a reviewer working from the candidate cannot open roughly half the cited
evidence, which makes it an assertion rather than a receipt. the spec's 0/a
clause requires receipts that "identify images, source/schema versions and input
hashes"; an id with no retained summary identifies nothing.

## prerequisites

the candidate must be committed first, so retained summaries have a stable source
identity to name.

## proposed fix

publish a receipt index with the change: for each cited id retain its bounded
summary (result, run id, source/image digests, fault id, assertion fingerprint)
under a committed evidence manifest, and have the controller refuse a dossier
receipt reference that names no retained summary. do not commit raw multi-megabyte
run directories — the durable artifact is the identity tuple plus the assertion
fingerprint, which is small, diffable and exactly what a later auditor needs.

## acceptance

every 16-hex id cited in a dossier resolves to a committed retained summary, and
the controller fails a dossier reference that does not.
