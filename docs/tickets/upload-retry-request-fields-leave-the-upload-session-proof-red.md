# `RetryUploadSessionRequest`'s two new fields leave a priority-risk proof red

**Status:** open (blocking for Track B; the schema change itself is correct)
**Origin:** 2026-09-08, imports workspace hard cutover, Track C1 (reviewer finding)
**Area:** `python/nexus/schemas/media.py`,
`python/tests/service/test_media_upload_sessions.py`

## What is wrong

Contract §4 adds `client_mutation_id` and `expected_generation` to
`RetryUploadSessionRequest` (`python/nexus/schemas/media.py:441-442`), and the
model forbids extras and defaults neither field. Five constructions in the
upload-session proof still pass only `filename`/`content_type`/`size_bytes`:
`python/tests/service/test_media_upload_sessions.py:273, 299, 897, 911, 1003`.

That file is a registered priority-risk node — `testdata/proofs.json:655` lists
`"pytest:python/tests/service/test_media_upload_sessions.py"` under
`document-import-reliability` — and it is red now:

`t.sh ./scripts/test changed pytest:python/tests/service/test_media_upload_sessions.py::test_upload_session_fences_generations_and_atomically_publishes_or_converges`
→ `changed: fail` (run `0f088ac75d27b0e7`).

`docs/local-rules/testing-standards.md` §14: a priority-risk legacy proof stays
blocking until its replacement meets the six conditions; nothing replaces this
one — Track B keeps it as the canonical upload owner and adds named cases to it
(contract §3).

## Prerequisites

Track B's `retry_upload_session` admission (it consumes both fields).

## Proposed fix

Track B supplies `client_mutation_id=str(uuid4())` and the session's current
`expected_generation` at the five construction sites, as part of the named cases
contract §3 gives that file (duplicate retry admission, stale
`expected_generation`, replay after expiry).

## Acceptance

`t.sh ./scripts/test changed pytest:python/tests/service/test_media_upload_sessions.py`
is green with both fields supplied at every construction site.
