# jobs module describes a retired media-unit outcome

status: open. origin: 2026-10-04 backend owner audit at `bbfd1df4`; area: jobs documentation. priority: p3.

`docs/modules/jobs.md` says `media_unit_build` declares `failed_result_statuses`. current `jobs/registry.py` declares `failed_result_statuses` only for podcast backfill and synapse scan; the media-unit handler stores its domain outcome within an outer successful queue result. a stale description, not an observed product failure. (the chat half of this ticket, the retired `execute_chat_run` outcome union and its `tasks/chat_run.py` serializer, was fixed by the 2026-10-10 chat rewrite, which rewrote that paragraph.)

update only the affected jobs module paragraph from current registry/task source. acceptance: no media-unit failed-result declaration remains in that doc; it describes the actual queue versus domain result boundary. no runtime change is implied.
