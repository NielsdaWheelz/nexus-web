# metadata recovery still needs production outcome checks

metadata and durable-job recovery merged in `e6ef89a08` (#913). the recorded
2026-11-10 release reached `422dc2596`/schema 0337 after a clean retry
([shutdown history](production-container-exit-history-unexplained.md)).
that supersedes instructions to apply 0336; it does not establish the reader
repair or reviewed job outcomes below. inspect the actual release vector before
further operations through [deployment](../../deployment.md).

migration 0336 removes review storage and report/search-only fields, converts
historical `no_findings` to `failed/no_result` at its original timestamp, and
introduces held work and failed-execution accounting without resetting history.
current contracts are [metadata](../modules/media-metadata.md),
[jobs](../modules/jobs.md) and [model tools](../modules/model-tools.md).
later recovery must preserve pending authored commands and use the actual
durable-format boundaries; the old code-only rollback premise is inapplicable.

remaining reader repair: freshly preflight salvatier
(`d6204c4c-914a-425c-bd7b-732e48d32459`), including exact html hashes,
generation, source pins, structural paths and retained references. use
`python/scripts/repair_reader_html.py` through its publication owner. preserve
canonical bytes, fragment ids/order, anchors, offsets and historical captures;
changed html advances generation and rebuilds table projections, followed by
normal index reconciliation. observe a mounted reader replace its old units.
keats (`49e3ad12-8db3-445d-a0f6-cd26d8a5e89a`) required only the now-merged
excerpt-adapter repair; unchanged html must retain its generation.

the 2026-11-05T21:16:23Z production census found 35 metadata jobs created
18:26–18:40 utc: 26 succeeded, nine dead, none unfinished. eight failures were
comment tails; one was the keats helper rejection. review each current target
and latest operation before admitting a normal new update. preserve historical
dead rows and diagnostics; do not blanket replay them. record deleted,
superseded or already-repaired targets separately, then verify ordinary new
outcomes and author credits without manual bibliographic patches.

at deployed `191ae44612d22626251a0d17950d3077d89650da`/schema 0335 on
2026-11-05, ordinary commands recorded `web_search: not_available` while
correcting the three sonnets to william shakespeare and several poems to john
keats; later results credited greg egan and anne carson as interview guest.
“the last of the monsters with iron teeth”
(`0b0eb5f6-52f2-40b4-a50b-fbfc38049b9b`) completed job
`01a1acfa-682b-7b5d-9f8e-55dc677114b3` with a description change but retained
the author credit “authors”. by 19:47:09 utc all three known oom-interrupted
jobs had recovered on attempt 2; salvatier also succeeded, without proving its
reader-coordinate repair. these observations establish neither working
[public search](brave-search-payment-required.md) nor installed-client display.

close after the reader repair, reviewed nine-job disposition and actual
metadata/recovery outcomes are independently observed on identified artifacts.
[worker capacity](metadata-worker-memory-exhaustion.md),
[database capacity](production-search-postgres-oom.md) and
[chat continuation](chat-generation-lacks-durable-continuation.md) remain
separate obligations.
