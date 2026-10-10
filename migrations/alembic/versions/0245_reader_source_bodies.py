"""Preserve source note bodies and enrich exact existing fragment targets.

Revision ID: 0245
Revises: 0244

Reads and writes the 0244 schema with plain SQL: an ORM model describes the
head schema, so loading one here breaks whenever a later revision changes a
mapped column or enum (production media still carried `failure_stage='metadata'`,
which 0256 clears and the live enum no longer has). Only pure HTML/text helpers
come from application code.
"""

from collections import defaultdict
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0245"
down_revision: str | Sequence[str] | None = "0244"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    from nexus.services.canonicalize import generate_canonical_text
    from nexus.services.html_apparatus import is_empty_apparatus_return_body
    from nexus.services.html_tree import inner_html, parse_html_document

    connection = op.get_bind()
    missing_count, sample_ids = connection.execute(
        sa.text("""
        WITH missing AS (
            SELECT DISTINCT item.media_id
            FROM reader_apparatus_items item
            LEFT JOIN reader_publications publication ON publication.media_id = item.media_id
            WHERE publication.media_id IS NULL
        )
        SELECT (SELECT COUNT(*) FROM missing),
               ARRAY(SELECT media_id FROM missing ORDER BY media_id LIMIT 10)
        """)
    ).one()
    if missing_count:
        raise RuntimeError(
            f"0245 blocked: {missing_count} apparatus media have no reader publication; "
            f"sample media ids: {', '.join(str(media_id) for media_id in sample_ids)}. "
            "repair publication linkage and retry"
        )

    op.add_column(
        "reader_apparatus_items",
        sa.Column("body_html_sanitized", sa.Text(), nullable=True),
    )
    media_ids = connection.scalars(
        sa.text("""
        SELECT DISTINCT item.media_id FROM reader_apparatus_items item
        JOIN media ON media.id = item.media_id
        WHERE media.kind IN ('web_article', 'epub')
        """)
    ).all()
    for media_id in media_ids:
        # Enrich uniquely stamped current nodes without replacing any source bytes or ids.
        labels = {
            str(row.stable_key): (row.label, row.source_ref)
            for row in connection.execute(
                sa.text("""
                SELECT stable_key, label, source_ref FROM reader_apparatus_items
                WHERE media_id=:id AND kind NOT LIKE '%\\_ref' ESCAPE '\\'
                """),
                {"id": media_id},
            )
        }
        candidates: dict[str, list[str]] = defaultdict(list)
        for html in connection.scalars(
            sa.text("SELECT html_sanitized FROM fragments WHERE media_id=:id"), {"id": media_id}
        ):
            root = parse_html_document(html)
            for element in root.xpath("//*[@data-reader-apparatus-item-id]"):
                key = element.get("data-reader-apparatus-item-id")
                if key in labels:
                    label, source = labels[key]
                    document_href = (
                        source.get("package_href") or source.get("target_href")
                        if isinstance(source, dict)
                        else None
                    )
                    if isinstance(document_href, str) and is_empty_apparatus_return_body(
                        root, element, label, document_href
                    ):
                        continue
                    candidates[key].append(inner_html(element))
        updates = {
            key: values[0]
            for key, values in candidates.items()
            if len(values) == 1 and values[0].strip()
        }
        if not updates:
            continue
        for key, body in updates.items():
            connection.execute(
                sa.text("""
                UPDATE reader_apparatus_items SET body_html_sanitized=:body, body_text=:plain
                WHERE media_id=:id AND stable_key=:key
                """),
                {"body": body, "plain": generate_canonical_text(body), "id": media_id, "key": key},
            )
        # The publication bump that tells offline readers the projection changed.
        connection.execute(
            sa.text("""
            UPDATE reader_publications SET generation = generation + 1, changed_at = now()
            WHERE media_id=:id
            """),
            {"id": media_id},
        )


def downgrade() -> None:
    raise NotImplementedError(
        "0245 requires restoring the previous application and database together"
    )
