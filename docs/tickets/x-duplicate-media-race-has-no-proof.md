# the X duplicate-media race is fixed but unproved

- status: open
- origin: 2026-09-14 adversarial review of the bounded-workspace implementation
- area: X ingest / concurrency proof

## what is wrong

the product defect is fixed: `_XMediaLockSetChanged` carries `media_id | None`,
both publishers raise `_XMediaLockSetChanged(None)` when the planned winner is
gone and nothing was prepared (`python/nexus/services/x_ingest.py:540` thread,
`:883` post), `planned_existing_id` / `planned_thread_winner_id` are recomputed —
including back to `None` — on every discovery pass (`:813`, `:294`), the thread
handler only adds a non-null id to `locked_existing_quote_ids` (`:383-385`,
`:720-722`), and the two surviving lock-set assertions carry `justify-defect`
(`:723-725`, `:935-937`).

no proof drives it. writing a blind race proof against a path no existing proof
reaches would be the false-confidence fixture the testing standards forbid, so
the construction is recorded here instead.

## prerequisites — the only reachable construction

the **post** path's duplicate branch cannot be constructed through
`accept_embedded_source`: that owner sets `provider_id='post:<id>'` on the
accepted media (`media_source_ingest.py:937-943,969`) and the partial unique
index `uix_media_x_provider_id` (`provider='x' AND provider_id IS NOT NULL`)
forbids a second media holding it — and if the duplicate exists first, accept
reuses it and there is no race.

the reachable path is `X_AUTHOR_THREAD`, whose accept leaves `provider_id` NULL
(`media_source_ingest.py:2263-2272`).

## proposed fix — the proof, exactly

1. create media B with `provider='x'`, `provider_id='post:<id>'`.
2. accept the thread URL to create media A with NULL `provider_id`.
3. monkeypatch the thread snapshot fetch — nothing in `python/tests` fakes
   `fetch_author_thread_snapshot` today and the network guard denies it.
4. monkeypatch `nexus.services.x_ingest.lock_x_provider_identity` to DELETE B in
   a separate committed session on its first call, then delegate.
5. assert the worker run succeeds with `idempotency_outcome` `refreshed`, no
   `superseded_by_media_id`, and generation-1 units for A.

## acceptance

the proof fails against the pre-fix code with the `AssertionError` ("X post
winner vanished before object preparation") and passes after, and a registered
fault re-injects the assertion.
