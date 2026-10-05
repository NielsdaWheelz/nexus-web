# canonical source teardown deletes admission replay

status: open, source-qualified; runtime not reproduced here.
origin: 2026-10-04 add-content backend review at `464098c11`.
area: url source admission / canonical supersession / replay lifetime.

`python/nexus/services/media_source_ingest.py:485-510` finds a URL command only
through its viewer/key on `MediaSourceAttempt`. canonical supersession at
`2311-2353` transfers the losing media's references and admits its teardown.
`services/import_history.py:130-175` retains the accepted attempt identity on the
winner, but stores no request key. teardown deletes the attempt rows at
`services/media_deletion.py:475-484` and commits through
`tasks/media_teardown.py:141-166`. the original command's sole replay record dies.

reproduction: accept a generic page or remote document under key a; acquire it
as a duplicate of an existing document; complete the losing media's teardown;
resend the exact key-a request. `_replay_or_none` now misses and admission creates
another media/attempt/job. source identity recovery by known attempt id still
exists, but does not recover a lost admission response by its request key.

prerequisite: define command receipt lifetime across canonical supersession and
explicit media deletion. retain viewer/key/intent independently of disposable
execution rows, using the existing mutation-receipt owner where appropriate.
resolve the surviving canonical result without repointing an attempt away from
its execution fence. qualify historical rows before a hard-cut migration; keys
never persisted by joined admission cannot be reconstructed.

acceptance: exact admission replay before and after canonical teardown resolves
the same accepted command, exposes the surviving result, and creates no media,
attempt, history, or job. changed intent still conflicts. explicit deletion has
an agreed terminal replay result rather than silently admitting new work.
