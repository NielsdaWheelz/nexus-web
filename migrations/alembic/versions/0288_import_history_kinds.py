"""Import history names its own facts; source supersessions move to ingest.

Revision ID: 0288
Revises: 0287

Writers are stopped (release runbook). Every row of `media_upload_events` and
`media_processing_events` is one of the shapes in `_SHAPES`: its payload becomes
`{kind, <the facts a reader is told>}` (execution, job, retry-time, winner and published
ids leave; a source recovery keeps its own kind as plain text; a 0225 baseline's outcome
becomes `outcome` + `outcome_code`), and both tables lose `event_type`. A source
`Superseded` row is not narration (it was rehomed to the winner in the transaction that
wrote it): each becomes one `media_source_supersessions` row (attempt -> surviving media)
and leaves history. Every other row keeps its id, owner, time, stage and code.

Refuses, writing nothing, when a row has another shape (an `UploadExecutionStarted`
included), a failure code outside the catalog (the retired `E_UPLOAD_TRANSPORT_FAILED` and
`E_IDEMPOTENCY_KEY_REPLAY_MISMATCH` included) is in history or in a column imports narrows
(`media.last_error_code` of a failed media, `media_source_attempts.error_code`,
`media_upload_sessions.verification_error_code`), or one superseded attempt names two media;
and, after converting, when a row is not one the history reader builds (a stage outside the
pipeline, a fact value outside its vocabulary): the transaction rolls back. The check reads
`schemas/import_history.py`, so until 0288 has run in production a change to that
vocabulary changes this migration with it. Irreversible: the release's pre-migration backup
holds the old payloads.
"""

import json
from collections import Counter
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from pydantic import ValidationError

from nexus.schemas.import_history import SAFE_FAILURE_CODES, HistoryEntry, decode_facts

revision: str = "0288"
down_revision: str | Sequence[str] | None = "0287"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# (table, event_type, revision present, stored keys, kind, kept keys)
_SHAPES = """(VALUES
    ('upload', 'Accepted', false, '{generation}', 'UploadAccepted', '{generation}'),
    ('upload', 'RecoveryAccepted', false, '{generation}', 'UploadRecoveryAccepted', '{generation}'),
    ('upload', 'Failed', false, '{generation}', 'UploadFailed', '{generation}'),
    ('upload', 'Published', false, '{generation,media_id,source_attempt_id}', 'UploadPublished',
        '{generation}'),
    ('upload', 'HistoryBaseline', false, '{generation}', 'UploadHistoryBaseline', '{generation}'),
    ('processing', 'Accepted', false, '{attempt_no,source_attempt_id}', 'SourceAccepted',
        '{attempt_no,source_attempt_id}'),
    ('processing', 'ExecutionStarted', false, '{execution_id,source_attempt_id}',
        'SourceExecutionStarted', '{source_attempt_id}'),
    ('processing', 'StageChanged', false, '{execution_id,source_attempt_id}',
        'SourceStageChanged', '{source_attempt_id}'),
    ('processing', 'RetryScheduled', false, '{execution_id,next_attempt_at,source_attempt_id}',
        'SourceRetryScheduled', '{source_attempt_id}'),
    ('processing', 'Failed', false, '{execution_id,origin,progress,source_attempt_id,terminal}',
        'SourceFailed', '{origin,progress,source_attempt_id,terminal}'),
    ('processing', 'RecoveryAccepted', false, '{recovery,source_attempt_id}',
        'SourceRecoveryAccepted', '{source_attempt_id}'),
    ('processing', 'Succeeded', false, '{execution_id,source_attempt_id}', 'SourceSucceeded',
        '{source_attempt_id}'),
    ('processing', 'HistoryBaseline', false, '{attempt_no,outcome,source_attempt_id}',
        'SourceHistoryBaseline', '{attempt_no,source_attempt_id}'),
    ('processing', 'Superseded', false, '{source_attempt_id,winner_media_id}', NULL, NULL),
    ('processing', 'Accepted', true, '{job_id,revision}', 'IndexAccepted', '{revision}'),
    ('processing', 'ExecutionStarted', true, '{execution_id,job_id,revision}',
        'IndexExecutionStarted', '{revision}'),
    ('processing', 'RetryScheduled', true, '{execution_id,job_id,next_attempt_at,revision}',
        'IndexRetryScheduled', '{revision}'),
    ('processing', 'Failed', true, '{execution_id,job_id,origin,revision,terminal}',
        'IndexFailed', '{revision,terminal}'),
    ('processing', 'RecoveryAccepted', true, '{job_id,revision}', 'IndexRecoveryAccepted',
        '{revision}'),
    ('processing', 'Succeeded', true, '{execution_id,job_id,revision}', 'IndexSucceeded',
        '{revision}'),
    ('processing', 'Superseded', true, '{execution_id,job_id,revision}', 'IndexSuperseded',
        '{revision}')
) AS shape(tbl, event_type, indexed, stored, kind, kept)"""

_KEYS = """ARRAY(SELECT k FROM jsonb_object_keys({}) k ORDER BY k COLLATE "C")"""

_EVENTS = f"""(
    SELECT 'upload' AS tbl, event_type, false AS indexed, stage, payload,
        {_KEYS.format("payload")} AS stored
    FROM media_upload_events
    UNION ALL
    SELECT 'processing', event_type, payload ? 'revision', stage, payload,
        {_KEYS.format("payload")}
    FROM media_processing_events
) e"""

_REFUSALS = f"""
SELECT 'unknown shape ' || e.tbl || ' ' || e.event_type || ' ' || e.stored::text, count(*)
FROM {_EVENTS} LEFT JOIN {_SHAPES}
    ON shape.tbl = e.tbl AND shape.event_type = e.event_type AND shape.indexed = e.indexed
    AND shape.stored::text[] = e.stored
WHERE shape.tbl IS NULL GROUP BY 1
UNION ALL
SELECT 'uncatalogued code ' || code, count(*) FROM (
    SELECT failure_code AS code FROM media_upload_events
    UNION ALL SELECT failure_code FROM media_processing_events
    UNION ALL SELECT last_error_code FROM media WHERE processing_status = 'failed'
    UNION ALL SELECT error_code FROM media_source_attempts
    UNION ALL SELECT verification_error_code FROM media_upload_sessions
) codes WHERE code <> ALL(CAST(:codes AS text[])) GROUP BY 1
UNION ALL
SELECT 'superseded attempt with two media ' || (payload->>'source_attempt_id'), 1
FROM media_processing_events WHERE event_type = 'Superseded' AND NOT payload ? 'revision'
GROUP BY payload->>'source_attempt_id' HAVING count(DISTINCT media_id) > 1
"""

_KEPT = """jsonb_build_object('kind', shape.kind)
    || (SELECT jsonb_object_agg(k, v) FROM jsonb_each(t.payload) kv(k, v)
        WHERE k = ANY(shape.kept::text[]))"""

_UPGRADE = f"""
CREATE TABLE media_source_supersessions (
    source_attempt_id uuid PRIMARY KEY,
    media_id uuid NOT NULL REFERENCES media(id)
);
CREATE INDEX ix_media_source_supersessions_media ON media_source_supersessions (media_id);
INSERT INTO media_source_supersessions (source_attempt_id, media_id)
SELECT DISTINCT (payload->>'source_attempt_id')::uuid, media_id FROM media_processing_events
WHERE event_type = 'Superseded' AND NOT payload ? 'revision';
DELETE FROM media_processing_events WHERE event_type = 'Superseded' AND NOT payload ? 'revision';

UPDATE media_upload_events t SET payload = {_KEPT}
FROM {_SHAPES} WHERE shape.tbl = 'upload' AND shape.event_type = t.event_type;

UPDATE media_processing_events t SET payload = {_KEPT}
    || CASE shape.kind
        WHEN 'SourceRecoveryAccepted'
            THEN jsonb_build_object('recovery', t.payload->'recovery'->'kind')
        WHEN 'SourceHistoryBaseline' THEN jsonb_build_object(
            'outcome', t.payload->'outcome'->'kind',
            'outcome_code', COALESCE(t.payload->'outcome'->'failure_code', 'null'::jsonb))
        ELSE '{{}}'::jsonb END
FROM {_SHAPES}
WHERE shape.tbl = 'processing' AND shape.event_type = t.event_type
  AND shape.indexed = (t.payload ? 'revision');

ALTER TABLE media_upload_events DROP COLUMN event_type;
ALTER TABLE media_processing_events DROP COLUMN event_type;
"""


def upgrade() -> None:
    bind = op.get_bind()
    refused: Counter[str] = Counter()
    for reason, count in bind.execute(sa.text(_REFUSALS), {"codes": sorted(SAFE_FAILURE_CODES)}):
        refused[reason] += count
    if not refused:
        op.execute(_UPGRADE)
        for table in ("media_upload_events", "media_processing_events"):
            rows = bind.execute(
                sa.text(f"SELECT occurred_at, stage, failure_code, payload FROM {table}")
            )
            for row in rows:
                try:
                    HistoryEntry(
                        id=table,
                        occurred_at=row.occurred_at,
                        stage=row.stage,
                        failure_code=row.failure_code,
                        facts=decode_facts(row.payload),
                    )
                except ValidationError as error:
                    unreadable = (
                        ".".join(map(str, e["loc"])) + "=" + json.dumps(e["input"], default=str)
                        for e in error.errors()
                    )
                    refused["unreadable " + ", ".join(unreadable)] += 1
    if refused:
        raise RuntimeError(
            "0288 refuses import history it cannot convert: "
            + "; ".join(f"{reason} ({count})" for reason, count in refused.items())
        )


def downgrade() -> None:
    raise NotImplementedError("0288 is irreversible; restore the pre-release backup")
