# jobs module describes retired handler outcomes

status: open. origin: 2026-10-04 backend owner audit at `bbfd1df4`; area: jobs documentation. priority: p3.

`docs/modules/jobs.md:150-178` says `media_unit_build` declares `failed_result_statuses` and `execute_chat_run` returns a `Published | Degraded | Failed | Cancelled | Skipped` outcome serialized by `tasks/chat_run.py`, with its kind logged by the worker. current `jobs/registry.py:157,253` declares `failed_result_statuses` only for podcast backfill and synapse scan. `chat_run_worker.py:275-410` returns `None` for handled terminal paths; `tasks/chat_run.py:22-43` forwards it. these are stale descriptions, not observed product failures. current media-unit handler stores its domain outcome within an outer successful queue result.

update only the affected jobs module paragraphs from current registry/task/worker source. acceptance: no retired chat outcome union, serializer or media-unit failed-result declaration remains in that doc; describe the actual queue versus domain result boundary. no runtime change is implied.
