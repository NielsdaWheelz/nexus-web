# gate 0/a's recorded limits are incomplete, so the ordering it mandates never happened

- status: open
- origin: 2026-09-14 adversarial review of the bounded-workspace implementation
- area: capacity qualification / committed limit owners

## what is wrong

gate 0/a requires that, **before tuning**, numeric limits are recorded in their
committed owners with linked run receipts: cold/warm/peak cgroup bytes;
unit/index/response bytes; read/worker concurrency; thread/database headroom;
foreground deadlines; browser lease/cache budgets; retained-growth tolerance;
probe/host reserve.

`python/nexus/config.py:285-292` defaults `reader_publication_limits`,
`api_read_admission_limits` and `image_decoder_limits` to `None`, and the only
supplier in the repository is the test controller
(`python/nexus_test_control/services.py:451-453`) plus
`python/tests/capacity/test_api_reader_capacity.py`. the branch therefore tuned
against controller **experiment** values, which is the opposite of the mandated
order.

three quantities have no committed owner at all:

- a numeric thread/database headroom reservation for progress, auth, readiness
  and streams. `settings.database_pool_size` / `database_max_overflow` exist
  (`python/nexus/db/engine.py:36-37`) but are unchanged and linked to no receipt,
  and the spec's explicit warning that "a global uvicorn connection cap alone is
  insufficient" appears in no dossier — the word `uvicorn` appears in none of the
  four.
- a retained-growth tolerance value. it is named as a remaining gate item
  (`bounded-workspace-progress.md:45`) but is not a number anywhere.
- a probe/host reserve. `bounded-workspace-runtime-progress.md:402` says only
  "this is not a production-host reserve".

## prerequisites

none for recording the quantities; the measurement is the capacity run's job.

## proposed fix

add the missing quantities to the same committed owners as the ones that exist —
database pool/thread headroom beside the engine configuration, host reserve and
retained-growth tolerance in the capacity scenario's typed profile — and have the
`api-capacity` receipt assert each recorded number against its observed value, so
a receipt cannot be published for a profile that was never written down.
recording them only in dossier prose is not acceptable: a number that lives in a
markdown file cannot fail a gate.

## acceptance

every quantity gate 0/a names has a committed owner, the `api-capacity` receipt
asserts each recorded number against its observed value, and the capacity run
fails when a profile field is absent.
