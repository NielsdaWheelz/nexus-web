# a lone acquisition can still exhaust its serializable retry

status: open · origin: 2026-11-02 import acquisition (slice 1) lab · area: ingest

acceptance runs SERIALIZABLE and reads wide: the generic-web match in
`media_source_ingest._accept_url` scans the viewer's media with per-row attempt
subqueries (no index holds its key), and the visibility and reference-barrier reads
span libraries, entries, grants, credits and teardown markers. the worker settling
the previous link (`source_runner._fail`, which also refreshes every user's
contributor projection) reads and writes the same relations. so acceptance and
settlement form read/write cycles, and in the lab postgres cancelled acceptance as a
pivot when settlement committed first, in bursts: of acceptances cancelled once,
about half were cancelled again.

state: `accept_url_source` takes six attempts, a budget sized on lab evidence alone.
upload confirm (add-panel files, extension capture) and x capture keep the default
three, unmeasured.

impact: an acceptance past its budget answers 409 `E_RESOURCE_CONFLICT` and its row
reads `save needs review` though nothing changed; a client cannot tell exhaustion
from the removal fence. the lab's tables are tiny, so every scan there takes a
relation lock; production's rate is unknown, afaict lower for point reads but not
for the unindexed generic match.

evidence, add panel sending one at a time:
- three attempts, run `20261102-102717-60f31f549d2d`: 8 of 449 acceptances
  exhausted, 8 of 30 two-then-twelve batches refused a link. cancelled attempts per
  request: once 7, twice 8, three times 8. sampling `pg_locks` during the batches
  showed relation-level SIRead locks held by acceptance statements on `media`,
  `library_entries`, `libraries`, `users`, `resource_grants`, `contributor_credits`
  and `media_teardown_intents`.
- six attempts, run `20261102-105206-2b3b47717273`: 0 of 877 refused, 60 of 60
  batches. cancelled once 22, twice 11, three times 4, never a fourth.

fix, afaict: narrow acceptance's serializable reads. index the generic match's key
(the first attempt's `canonical_source_url`) so it reads one url's rows; skip the
contributor refresh when a filing changes no credit visibility (a new media has no
credits); stop settlement refreshing every user's contributors. proving it needs a
lab seeded at production table sizes, since here every index fits one page.

resolved when: in such a lab, url acceptance and upload confirm at the default three
attempts accept every item of twenty two-then-twelve link batches and a twelve-file
batch, with no `db.resource_busy` in the api log.
