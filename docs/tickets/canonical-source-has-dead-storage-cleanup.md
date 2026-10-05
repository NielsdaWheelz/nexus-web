# canonical source has dead storage cleanup

status: open, source-qualified; no runtime probe.
origin: 2026-10-04 source-acquisition review, base `031c3c95de81f25306b4e17fd656d9eeaf72218c`; independent review `8a97ccc8`, o7, verified by web_map.
area: source runner / canonical supersession / storage ownership.

`python/nexus/services/media_deletion.py:316-350` returns `[]` on both paths of
`delete_duplicate_document_media`; the teardown job owns storage deletion.
its only caller, `media_source_ingest.py:2314-2355`, forwards that empty list.
the runner still initializes and assigns `superseded_storage_paths` at
`2055-2067` and passes it to `delete_document_storage_objects` at `2116`.
this cannot delete an object and falsely suggests shared cleanup ownership.

prerequisite/fix: keep canonical reference transfer and teardown scheduling
behavior fixed. hard-cut the private helper's obsolete storage-path return and
the runner's empty-list plumbing together; retain the teardown owner's actual
path enumeration/deletion. this does not resolve settlement ordering or replay
lifetime.

acceptance: no source-runner storage-path result or empty cleanup call remains;
canonical supersession still transfers references and schedules one teardown,
whose checkpointed owner deletes the same enumerated objects after commit.
