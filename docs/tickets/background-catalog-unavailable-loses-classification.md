# background catalog unavailability loses classification

status: open · origin: 2026-10-07 connections live verification · area: generation / queue

an absent codex host makes `generation_catalog.py:227-235` raise
`GenerationCatalogRefreshError` during background admission. it escapes the
task and becomes generic `E_WORKER_HANDLER_FAILED` in `jobs/worker.py:692-698`,
instead of retaining the known unavailable-catalog cause.

observed on disposable job `d9876778-7a7b-46c2-877f-c94fd58136ba`: real indexing,
hybrid retrieval and scan enqueue passed; no generation/edge was created;
queue result was `failed` / `generation catalog definition refresh failed`.

keep admission closed. preserve the existing catalog-unavailable classification
at the generation/worker owner boundary without a fallback model. verify a
real host-down attempt records that cause and a later supported host can admit
the next ordinary retry. deferred with generation behavior improvements.
