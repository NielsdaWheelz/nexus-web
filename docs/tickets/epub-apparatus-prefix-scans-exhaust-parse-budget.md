# portrait recovery still needs current publication proof after the prefix fix

status: recovery planned; prefix fix already implemented, publication proof open
origin: 2026-09-26 exact-source profiling; 2026-10-14 disposition correction
area: html apparatus / epub recovery

historical production `7dc68929b4d5ddfd77eb1a50228d477fa0148b5d` reported portrait
`9e5d8118-050d-48dc-9c99-870443481f61` as `E_ARCHIVE_UNSAFE` after a
58,836 ms / 30,000 ms parse failure. its original sha256 is
`6593c91398319d4b8582d1857fb8e8e6d0cd705e87c1838cf8364ef910a3bccb`.
that observation does not establish the present publication state.

historical profiling spent 32.95 s in 7,372 `_target_context` calls and rebuilt
1,611,400,478 normalized ancestor characters. a scratch exact-prefix comparison
fell from 33.67 s to 0.85 s with matching ordered outputs, sha256
`46f40b33c8adadbeab5e66cdb94177f1369f08ee319fd3eb732d82d4e867f00f`.
receipts remain under `/tmp/nexus-processing-review-20260926/`.

ancestor-prefix memoization subsequently shipped in `fdfb911eaf80c100b67c93f3f4bf6bb03efd2c08`;
bounded subtree text shipped in `47d8143cfb093132d3bfc7462eed255696c2ac96`.
both are present at released `58c7ecae6`. the old profile is not evidence that
this implementation is still missing or that it causes the current
[offline repair refusals](reader-repair-epub-parse-budget.md).

remaining book repairs are owner-deferred from the usable release. no new
portrait source replay, recovery or publication is proved by the local
performance candidates. retain the exact source and historical evidence.

2026-10-14 decision: use the existing fenced `reprocess-source` capability
under the [book-repair plan](../book-repair-plan.md), through the actual normal
worker and unchanged import limits. the owner accepts separate metadata
failure while brave remains unavailable; prove readable publication and
indexing independently. no new recovery or production publication has run.

acceptance: qualify current exact-source recovery and production publication,
with unchanged apparatus/canonical output and protected reader identities.
keep the import's bounds; establish offline-maintenance applicability separately
before using its 30-second setting as a maintenance acceptance rule.
