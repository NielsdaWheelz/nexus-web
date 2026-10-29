"""separate piece bibliography from its source edition.

refuse disputed data before clearing exact child copies. retain job history with an
explicit empty report, removing the retired manual-author flag from historical
completed results. rollback requires the paired backup because cleared facts
and revision increments cannot be reconstructed safely.
"""

from collections.abc import Sequence
from datetime import datetime

import sqlalchemy as sa
from alembic import op

revision: str = "0322"
down_revision: str | Sequence[str] | None = "0321"
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
    connection = op.get_bind()
    conflicts = connection.execute(
        sa.text("""
        SELECT p.media_id, p.source_media_id,
            array_remove(ARRAY[
                CASE WHEN c.edition_published_date IS NOT NULL AND
                    c.edition_published_date IS DISTINCT FROM s.edition_published_date
                    THEN 'edition_published_date' END,
                CASE WHEN c.edition_isbn IS NOT NULL AND
                    c.edition_isbn IS DISTINCT FROM s.edition_isbn THEN 'edition_isbn' END,
                CASE WHEN c.publisher IS NOT NULL AND
                    c.publisher IS DISTINCT FROM s.publisher THEN 'publisher' END,
                CASE WHEN s.id IS NULL THEN 'missing_source' END,
                CASE WHEN ps.source_media_id IS NULL THEN 'missing_source_set' END
            ], NULL) AS fields
        FROM media_parts p JOIN media c ON c.id=p.media_id
        LEFT JOIN media s ON s.id=p.source_media_id
        LEFT JOIN media_part_sets ps ON ps.source_media_id=p.source_media_id
        WHERE s.id IS NULL OR ps.source_media_id IS NULL
           OR (c.edition_published_date IS NOT NULL AND
               c.edition_published_date IS DISTINCT FROM s.edition_published_date)
           OR (c.edition_isbn IS NOT NULL AND c.edition_isbn IS DISTINCT FROM s.edition_isbn)
           OR (c.publisher IS NOT NULL AND c.publisher IS DISTINCT FROM s.publisher)
    """)
    ).all()
    if conflicts:
        raise RuntimeError(f"disputed piece edition fields: {conflicts}")
    credits = connection.execute(
        sa.text("""
        SELECT p.media_id, cc.id FROM media_parts p
        JOIN contributor_credits cc ON cc.media_id=p.media_id AND cc.role='publisher'
    """)
    ).all()
    if credits:
        raise RuntimeError(f"piece publisher credits require repair: {credits}")
    candidates = connection.execute(
        sa.text("""
        SELECT id, finding FROM media_part_candidates WHERE part_id IS NULL AND finding IS NOT NULL
    """)
    ).all()
    for candidate_id, finding in candidates:
        if not isinstance(finding, dict) or "contributors" not in finding:
            raise RuntimeError(f"malformed candidate finding: {candidate_id}")
        roles = finding["contributors"]
        if roles is not None:
            if not isinstance(roles, list) or any(
                not isinstance(role, dict)
                or not isinstance(role.get("role"), str)
                or not isinstance(role.get("credits"), list)
                for role in roles
            ):
                raise RuntimeError(f"malformed candidate contributors: {candidate_id}")
            if any(role["role"] == "publisher" and role["credits"] for role in roles):
                raise RuntimeError(
                    f"candidate publisher credits require repair: {candidate_id}"
                )

    results = connection.execute(
        sa.text("""
        SELECT id, payload, result FROM background_jobs
        WHERE kind='enrich_metadata' AND result IS NOT NULL
          AND (payload->>'purpose'='bibliography' OR result->>'purpose'='bibliography')
    """)
    ).all()
    convert = []
    for job_id, payload, result in results:
        if (
            not isinstance(payload, dict)
            or payload.get("purpose") != "bibliography"
            or not isinstance(result, dict)
            or result.get("purpose") != "bibliography"
        ):
            raise RuntimeError(f"malformed bibliography result: {job_id}")
        status = result.get("status")
        if status == "failed":
            continue
        keys = {"status", "purpose", "completed_at"}
        if status == "completed":
            keys |= {"changed_fields", "unresolved_fields"}
            if "retained_manual_authors" in result:
                if type(result["retained_manual_authors"]) is not bool:
                    raise RuntimeError(f"malformed manual-author flag: {job_id}")
                keys.add("retained_manual_authors")
        elif status != "no_findings":
            raise RuntimeError(f"malformed bibliography result: {job_id}")
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
        convert.append(job_id)

    connection.execute(
        sa.text("""
        WITH changed AS (
            UPDATE media c SET edition_published_date=NULL, edition_isbn=NULL,
                publisher=NULL, updated_at=clock_timestamp()
            FROM media_parts p WHERE p.media_id=c.id AND
                (c.edition_published_date IS NOT NULL OR c.edition_isbn IS NOT NULL
                 OR c.publisher IS NOT NULL)
            RETURNING c.id, p.source_media_id
        ), versions AS (
            UPDATE media_parts p SET version=p.version+1 FROM changed c
            WHERE p.media_id=c.id RETURNING p.media_id
        ), revisions AS (
            UPDATE media_part_sets s SET revision=s.revision+c.count
            FROM (SELECT source_media_id, count(*) AS count FROM changed GROUP BY source_media_id) c
            WHERE s.source_media_id=c.source_media_id RETURNING s.source_media_id
        )
        UPDATE keyword_occurrences k SET publisher=NULL FROM changed c
        WHERE k.family='media' AND k.ref='media:' || c.id::text
    """)
    )
    for job_id in convert:
        connection.execute(
            sa.text("""
            UPDATE background_jobs SET result=(result-'retained_manual_authors') || jsonb_build_object('container_report', NULL)
            WHERE id=:id
        """),
            {"id": job_id},
        )
    op.create_check_constraint(
        "ck_media_text_part_edition_null",
        "media",
        "kind <> 'text_part' OR (edition_published_date IS NULL AND edition_isbn IS NULL AND publisher IS NULL)",
    )


def downgrade() -> None:
    raise RuntimeError("restore the paired backup to reverse contained-work metadata")
