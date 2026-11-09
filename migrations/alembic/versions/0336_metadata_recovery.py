"""Cut over nullable metadata results and durable repair holds.

Adds held and a separate failed-execution counter; removes frozen attempt limits.
Existing counters, dead dispositions, facts and timestamps are unchanged. Completed
bibliography results lose quality reports; historical no_findings becomes failed
no_result at its original timestamp, including results for deleted media. Drops
per-viewer review storage. Refuses malformed results before changing any row.
Writers and old model generations must be drained before applying this revision.
Downgrade requires the paired backup and matching application.
"""

import json
from datetime import datetime

import sqlalchemy as sa
from alembic import op

revision = "0336"
down_revision = "0335"
branch_labels = None
depends_on = None

_FIELDS = {
    "title",
    "contributors",
    "original_published_date",
    "edition_published_date",
    "edition_isbn",
    "publisher",
    "language",
    "description",
}

_FAILURES = {
    "model_unavailable",
    "authentication_failed",
    "quota_unavailable",
    "research_timeout",
    "invalid_output",
    "input_too_large",
    "output_limit",
    "stale_input",
    "source_context_missing",
    "no_longer_eligible",
    "access_revoked",
    "cancelled",
    "policy_violation",
    "worker_interrupted",
    "execution_failed",
}


def upgrade() -> None:
    db = op.get_bind()
    converted = []
    for row in db.execute(
        sa.text("""SELECT id, payload, result FROM background_jobs
        WHERE kind='enrich_metadata' AND result IS NOT NULL""")
    ).mappings():
        result, payload = row["result"], row["payload"]
        if not isinstance(result, dict) or not isinstance(payload, dict):
            raise RuntimeError(f"invalid metadata result: {row['id']}")
        status, purpose = result.get("status"), result.get("purpose")
        if purpose not in ("bibliography", "title") or purpose != payload.get(
            "purpose"
        ):
            raise RuntimeError(f"invalid metadata purpose: {row['id']}")
        keys = {"status", "purpose", "completed_at"}
        if status == "failed":
            keys |= {"reason"}
            if (
                not isinstance(result.get("reason"), str)
                or result["reason"] not in _FAILURES
            ):
                raise RuntimeError(f"invalid metadata failure: {row['id']}")
        elif purpose == "title" and status == "completed":
            keys |= {"changed_fields", "disposition"}
            if result.get("disposition") not in ("generated", "source_label"):
                raise RuntimeError(f"invalid title disposition: {row['id']}")
        elif purpose == "bibliography" and status in ("completed", "no_findings"):
            keys |= {"container_report", "web_search"}
            if status == "completed":
                keys |= {"changed_fields", "unresolved_fields"}
        else:
            raise RuntimeError(f"invalid metadata status: {row['id']}")
        if set(result) != keys:
            raise RuntimeError(f"invalid metadata shape: {row['id']}")
        try:
            stamp = datetime.fromisoformat(
                result["completed_at"].replace("Z", "+00:00")
            )
            if stamp.utcoffset() is None:
                raise ValueError("naive timestamp")
        except (AttributeError, TypeError, ValueError) as exc:
            raise RuntimeError(f"invalid metadata timestamp: {row['id']}") from exc
        for key in ("changed_fields", "unresolved_fields"):
            if key not in result:
                continue
            fields = result[key]
            allowed = {"title"} if purpose == "title" else _FIELDS
            if (
                not isinstance(fields, list)
                or any(
                    not isinstance(field, str) or field not in allowed
                    for field in fields
                )
                or len(fields) != len(set(fields))
            ):
                raise RuntimeError(f"invalid metadata fields: {row['id']}")
        if purpose == "bibliography" and status in ("completed", "no_findings"):
            if result["web_search"] not in (
                None,
                "not_available",
                "not_used",
                "succeeded",
                "failed",
                "mixed",
            ):
                raise RuntimeError(f"invalid metadata observation: {row['id']}")
            report = result["container_report"]
            if report is not None:
                if (
                    not isinstance(report, dict)
                    or set(report) != {"source_title", "discrepancies"}
                    or not isinstance(report["source_title"], str)
                    or not isinstance(report["discrepancies"], list)
                    or not 1 <= len(report["discrepancies"]) <= 7
                ):
                    raise RuntimeError(f"invalid metadata report: {row['id']}")
                for item in report["discrepancies"]:
                    if (
                        not isinstance(item, dict)
                        or set(item) != {"field", "explanation"}
                        or item["field"] not in _FIELDS - {"description"}
                        or not isinstance(item["explanation"], str)
                        or not item["explanation"].strip()
                        or len(item["explanation"]) > 400
                    ):
                        raise RuntimeError(f"invalid metadata discrepancy: {row['id']}")
            result = {
                key: value
                for key, value in result.items()
                if key not in {"container_report", "web_search", "unresolved_fields"}
            }
            if status == "no_findings":
                result = result | {"status": "failed", "reason": "no_result"}
            converted.append((row["id"], result))
    for job_id, result in converted:
        db.execute(
            sa.text(
                "UPDATE background_jobs SET result=CAST(:result AS jsonb) WHERE id=:id"
            ),
            {"id": job_id, "result": json.dumps(result)},
        )
    op.drop_table("metadata_result_reviews")
    op.drop_constraint("ck_background_jobs_status", "background_jobs", type_="check")
    op.create_check_constraint(
        "ck_background_jobs_status",
        "background_jobs",
        "status IN ('pending','running','succeeded','failed','dead','held')",
    )
    op.add_column(
        "background_jobs",
        sa.Column(
            "failed_executions", sa.Integer(), nullable=False, server_default="0"
        ),
    )
    op.create_check_constraint(
        "ck_background_jobs_failed_executions_non_negative",
        "background_jobs",
        "failed_executions >= 0",
    )
    op.drop_column("background_jobs", "max_attempts")


def downgrade() -> None:
    raise RuntimeError("restore the paired pre-release backup and matching binaries")
