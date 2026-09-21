# the artifact_learn_* tables are write-free

status: open · origin: 2026-09-21 reauthoring (dossiers) · area: dossiers / schema

`artifact_learn_requests`, `artifact_learn_successes` and
`artifact_learn_failures` have no writer since the generated Idea resolver and
its learn ledger were deleted. They survive only so
`services/artifacts/idea.py` can delete leftover rows on highlight and head
teardown for FK safety.

impact: three dead tables and two delete blocks; existing rows are history
nothing reads.

fix: the next alembic revision drops the three tables (and `uq_artifact_learn_requests_user_key`
from `db/retries.py`), then the two delete blocks in `idea.py` and the ORM
classes go. `LlmCallOwnerKind` still admits `artifact_learn_request` as a read
vocabulary for existing `llm_calls` rows; drop it in the same change if those
rows are deleted.

resolved when: no `artifact_learn_*` table exists and no code names one.
