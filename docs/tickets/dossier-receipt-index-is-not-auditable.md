# retained dossier receipts need controller verification

- status: open; retained index and controller guard implemented, verification pending
- origin: 2026-09-14 adversarial review of the bounded-workspace implementation
- area: evidence / dossier auditability

## what is wrong

the delivery now retains all 680 cited runs in
`testdata/evidence/bounded-workspace-receipts.json`: 417 pass, 259 fail and four
not-run results, with original summary/context hashes and artifact identities.
all 1,360 metadata files reconstruct byte-for-byte. no historical verdict was
changed. the index is 3,303,054 bytes; it keeps metadata, not raw artifact bodies.
the repository policy checks coverage and retained hashes. its ordinary proof
and missing-reference fault replay remain required before closing this ticket.

this makes old evidence inspectable; it cannot supply absent source, image or
sensitivity attestations. current qualification still uses the strict live
evidence loaders and requires the combined committed candidate.

original finding:

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
