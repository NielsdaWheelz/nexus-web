"""Publish native x evidence and preserve metadata history with its actual purpose."""

import json
from typing import Literal
from uuid import UUID

import sqlalchemy as sa
from alembic import op
from pydantic import AwareDatetime, BaseModel, ConfigDict, TypeAdapter
from sqlalchemy.dialects.postgresql import JSONB, UUID as PG_UUID

revision = "0278"
down_revision = "0277"
branch_labels = None
depends_on = None


# These are the stored 0277 shapes, pinned here so later application contracts
# cannot change how this migration interprets historical work.
class _Closed(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class _Payload(_Closed):
    media_id: UUID
    requester_user_id: UUID
    request_id: str | None


_Field = Literal[
    "title",
    "contributors",
    "original_published_date",
    "edition_published_date",
    "edition_isbn",
    "publisher",
    "language",
    "description",
]


class _Completed(_Closed):
    status: Literal["completed"]
    completed_at: AwareDatetime
    changed_fields: list[_Field]
    unresolved_fields: list[_Field]
    retained_manual_authors: bool


class _NoFindings(_Closed):
    status: Literal["no_findings"]
    completed_at: AwareDatetime


class _Failed(_Closed):
    status: Literal["failed"]
    completed_at: AwareDatetime
    reason: Literal[
        "model_unavailable",
        "authentication_failed",
        "quota_unavailable",
        "research_timeout",
        "invalid_output",
        "input_too_large",
        "output_limit",
        "stale_input",
        "no_longer_eligible",
        "access_revoked",
        "cancelled",
        "policy_violation",
        "worker_interrupted",
        "execution_failed",
    ]


def upgrade() -> None:
    connection = op.get_bind()
    blocked = connection.scalar(
        sa.text("""
        SELECT EXISTS (
            SELECT 1 FROM background_jobs
            WHERE kind='enrich_metadata' AND status NOT IN ('succeeded','dead')
        ) OR EXISTS (
            SELECT 1 FROM llm_calls WHERE owner_kind='media_enrichment' AND outcome IS NULL
        ) OR EXISTS (
            SELECT 1 FROM media_source_attempts a
            LEFT JOIN background_jobs j ON j.id=a.job_id
            WHERE a.source_type IN ('x_author_thread','x_post')
              AND (a.status IN ('accepted','queued','running')
                   OR j.status NOT IN ('succeeded','dead'))
        )
    """)
    )
    if blocked:
        raise RuntimeError("unsettled metadata or x source work blocks x title cutover")
    updates = []
    for row in connection.execute(
        sa.text(
            "SELECT id, payload, result, status FROM background_jobs WHERE kind='enrich_metadata'"
        )
    ).mappings():
        payload = _Payload.model_validate_json(json.dumps(row["payload"]))
        result = row["result"]
        rewritten_result = None
        if isinstance(result, dict) and "completed_at" in result:
            outcome = TypeAdapter(_Completed | _NoFindings | _Failed).validate_json(
                json.dumps(result)
            )
            if (row["status"] == "succeeded") != (outcome.status == "completed"):
                raise RuntimeError(f"metadata job {row['id']} has inconsistent settlement")
            rewritten_result = {**result, "purpose": "bibliography"}
        elif row["status"] == "succeeded":
            raise RuntimeError(f"metadata job {row['id']} has no typed outcome")
        updates.append(
            (
                row["id"],
                {**payload.model_dump(mode="json"), "purpose": "bibliography"},
                rewritten_result,
            )
        )
    op.create_table(
        "x_source_snapshots",
        sa.Column("id", PG_UUID(as_uuid=True), primary_key=True),
        sa.Column("media_id", PG_UUID(as_uuid=True), sa.ForeignKey("media.id"), nullable=False),
        sa.Column(
            "source_attempt_id",
            PG_UUID(as_uuid=True),
            sa.ForeignKey("media_source_attempts.id"),
            nullable=False,
        ),
        sa.Column(
            "published_at",
            sa.TIMESTAMP(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("payload", JSONB, nullable=False),
        sa.UniqueConstraint("media_id"),
    )
    outcome_statement = sa.text(
        "UPDATE background_jobs SET payload=:payload, result=:result WHERE id=:id"
    ).bindparams(sa.bindparam("payload", type_=JSONB), sa.bindparam("result", type_=JSONB))
    payload_statement = sa.text(
        "UPDATE background_jobs SET payload=:payload WHERE id=:id"
    ).bindparams(sa.bindparam("payload", type_=JSONB))
    for job_id, payload, result in updates:
        # Raw dead-job results, including SQL NULL versus JSON null, stay byte-for-byte.
        statement = payload_statement if result is None else outcome_statement
        changed = connection.execute(
            statement, {"id": job_id, "payload": payload, "result": result}
        )
        if changed.rowcount != 1:
            raise AssertionError("locked metadata migration row disappeared")


def downgrade() -> None:
    raise NotImplementedError("x title cutover requires the verified release backup")
