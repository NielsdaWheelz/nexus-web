# retained dossier receipts need controller verification

- status: open; retained index and controller guard implemented, verification pending
- origin: 2026-09-14 adversarial review of the bounded-workspace implementation
- area: evidence / dossier auditability

## what is wrong

the delivery now retains all 681 cited runs in
`testdata/evidence/bounded-workspace-receipts.json`: 417 pass, 260 fail and four
not-run results, with original summary/context hashes and artifact identities.
all 1,362 metadata files reconstruct byte-for-byte. no historical verdict was
changed. the index is 3,307,362 bytes; it keeps metadata, not raw artifact bodies.
the repository policy checks coverage and retained hashes. its ordinary proof
and missing-reference BASE replay remain required before closing this ticket.
use the existing whole-file public proof against
`5d687cdc8a9e1a9b2a0106d0e136df4537c281d7`, immediately before the receipt guard
and retained index, then the current candidate. the new policy-file mutation was
removed because that file is outside the existing product-fault allowlist; the
allowlist and source guard remain unchanged.

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
the controller fails a dossier reference that does not. the actual old-source
run must reach `missing receipt evidence was accepted`, followed by a current
green through the same public `repository_violations` proof.

```sh
./scripts/test prove --proof pytest:python/tests/kernel/nexus_test_control/test_policy.py --against base:5d687cdc8a9e1a9b2a0106d0e136df4537c281d7
```
