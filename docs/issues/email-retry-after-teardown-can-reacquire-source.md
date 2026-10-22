# email retry after teardown can reacquire a removed source

problem: email deduplication finds its message id on the current media row. hard
teardown removes that row, so a later webhook redelivery can create a fresh
personal holding for the same message.

evidence: `python/nexus/services/email_ingest_service.py` checks `_media_for`
before creating media and calling `ensure_media_in_default_library`;
`services/media_deletion.py:_hard_delete` deletes the media and source attempts.
source-derived on 2026-10-22; not reproduced live.

reproduce: accept an email, remove its last holding, complete physical teardown,
then redeliver the same message id. the old per-media suppression cannot identify
the new media identity. this is outside the libraries change's explicit guarded
acquisition contract; it needs a separately chosen source-retention policy.

resolved when duplicate delivery after completed teardown cannot silently acquire
the removed source, while a genuinely new email still arrives normally.
