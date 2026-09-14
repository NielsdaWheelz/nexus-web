# the retired "offline" identity survives in the BFF constants and two proof modules

- status: open
- origin: 2026-09-14 adversarial review of the bounded-workspace implementation
- area: reader progress / naming after the hard cut

## what is wrong

the shared progress boundary is account-bound, not offline-specific: the route
handlers are `get_reader_progress` / `put_reader_progress`, and the wire path
keeps its `offline-` spelling only because installed native copies address it
(documented in `docs/modules/reader-implementation.md`). three identifiers still
name the retired concept:

- `apps/web/src/lib/api/proxy.ts:99-108`:
  `OFFLINE_READER_PROGRESS_REQUEST_HEADERS` / `_RESPONSE_HEADERS` should be
  `ACCOUNT_BOUND_REQUEST_HEADERS` / `_RESPONSE_HEADERS`, matching
  `ACCOUNT_BOUND_RESPONSE_POLICY` at `:191-195`.
- `python/tests/service/test_offline_reader_progress.py` and
  `test_offline_reader_account_fence.py` should be `test_reader_progress*.py`.

## prerequisites

renaming the two proof modules requires editing `testdata/proofs.json` paths and
re-pinning the manifest's `python_exact_proof_owner_sha256`, so it must land with
a registry change and a replay, not on its own.

## proposed fix

rename the proxy constants immediately (no registry impact); do the proof-module
renames in the same change as the next registry settle and fault replay.

## acceptance

no identifier in the progress boundary names "offline" except the wire path
itself, whose reason is documented at its declaration.
