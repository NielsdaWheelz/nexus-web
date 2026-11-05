"""Record unknown historical metadata-search use without inferring evidence.

Adds web_search:null to retained completed/no-findings bibliography outcomes,
including jobs whose media was deleted. No payload, fact, timestamp or review
changes. Validate all candidates before updates; refuse malformed history.
Downgrade requires the paired pre-release backup and matching binaries.
"""

from collections.abc import Sequence
from datetime import datetime

import sqlalchemy as sa
from alembic import op

revision: str = "0331"
down_revision: str | Sequence[str] | None = "0330"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

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


def upgrade() -> None:
    db = op.get_bind()
    rows = db.execute(
        sa.text("""SELECT id, payload, result FROM background_jobs
            WHERE kind='enrich_metadata' AND result IS NOT NULL
              AND (payload->>'purpose'='bibliography' OR result->>'purpose'='bibliography')
        """)
    ).all()
    convert = []
    for job_id, payload, result in rows:
        if (
            not isinstance(payload, dict)
            or payload.get("purpose") != "bibliography"
            or not isinstance(result, dict)
            or result.get("purpose") != "bibliography"
        ):
            raise RuntimeError(f"malformed bibliography purpose: {job_id}")
        status = result.get("status")
        if status == "failed":
            continue
        keys = {"status", "purpose", "completed_at", "container_report"}
        if status == "completed":
            keys |= {"changed_fields", "unresolved_fields"}
        elif status != "no_findings":
            raise RuntimeError(f"malformed bibliography status: {job_id}")
        if set(result) != keys or not isinstance(result["completed_at"], str):
            raise RuntimeError(f"malformed bibliography result: {job_id}")
        try:
            stamp = datetime.fromisoformat(
                result["completed_at"].replace("Z", "+00:00")
            )
            if stamp.utcoffset() is None:
                raise ValueError("naive timestamp")
        except ValueError:
            raise RuntimeError(f"malformed bibliography timestamp: {job_id}") from None
        if status == "completed" and any(
            not isinstance(result[key], list)
            or any(
                not isinstance(field, str) or field not in _FIELDS
                for field in result[key]
            )
            for key in ("changed_fields", "unresolved_fields")
        ):
            raise RuntimeError(f"malformed bibliography fields: {job_id}")
        report = result["container_report"]
        if report is not None:
            if (
                not isinstance(report, dict)
                or set(report) != {"source_title", "discrepancies"}
                or not isinstance(report["source_title"], str)
                or not isinstance(report["discrepancies"], list)
                or not 1 <= len(report["discrepancies"]) <= 7
            ):
                raise RuntimeError(f"malformed bibliography report: {job_id}")
            for discrepancy in report["discrepancies"]:
                if (
                    not isinstance(discrepancy, dict)
                    or set(discrepancy) != {"field", "explanation"}
                    or not isinstance(discrepancy["field"], str)
                    or discrepancy["field"] not in _FIELDS - {"description"}
                    or not isinstance(discrepancy["explanation"], str)
                    or not 1 <= len(discrepancy["explanation"]) <= 400
                    or not discrepancy["explanation"].strip()
                ):
                    raise RuntimeError(f"malformed bibliography discrepancy: {job_id}")
        convert.append(job_id)
    for job_id in convert:
        db.execute(
            sa.text("""UPDATE background_jobs
                SET result=result || jsonb_build_object('web_search', NULL) WHERE id=:id"""),
            {"id": job_id},
        )


def downgrade() -> None:
    raise RuntimeError("restore the paired pre-release backup and matching binaries")
