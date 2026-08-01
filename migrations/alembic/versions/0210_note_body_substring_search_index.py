"""Index note-body substring search for the Openables hot path.

Revision ID: 0210
Revises: 0209
Create Date: 2026-08-01
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0210"
down_revision: str | Sequence[str] | None = "0209"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_INDEX_NAME = "ix_note_blocks_body_text_trgm"
_EXPECTED_INDEX_DEFINITION = (
    "CREATE INDEX ix_note_blocks_body_text_trgm ON public.note_blocks "
    "USING gin (body_text gin_trgm_ops)"
)


def _index_state(bind: sa.engine.Connection) -> str:
    row = (
        bind.execute(
            sa.text(
                """
                SELECT
                    index_metadata.indisvalid AS is_valid,
                    pg_get_indexdef(index_metadata.indexrelid) AS definition
                FROM pg_class index_relation
                JOIN pg_namespace index_namespace
                  ON index_namespace.oid = index_relation.relnamespace
                JOIN pg_index index_metadata
                  ON index_metadata.indexrelid = index_relation.oid
                WHERE index_namespace.nspname = 'public'
                  AND index_relation.relname = :name
                """
            ),
            {"name": _INDEX_NAME},
        )
        .mappings()
        .one_or_none()
    )
    if row is None:
        return "absent"
    if row["definition"] != _EXPECTED_INDEX_DEFINITION:
        raise RuntimeError(f"0210 index {_INDEX_NAME} has the wrong definition: {dict(row)!r}")
    return "exact_valid" if row["is_valid"] else "exact_invalid"


def _require_index_state(bind: sa.engine.Connection, expected: str) -> None:
    actual = _index_state(bind)
    if actual != expected:
        raise RuntimeError(
            f"0210 index {_INDEX_NAME} expected state {expected!r}, found {actual!r}"
        )


def upgrade() -> None:
    bind = op.get_bind()
    state = _index_state(bind)

    # ILIKE is a required one-character-capable reference-search contract. The
    # existing full-text GIN index cannot serve that substring branch.
    op.execute("CREATE EXTENSION IF NOT EXISTS pg_trgm")

    # Concurrent creation keeps note writes available. A killed CREATE INDEX
    # CONCURRENTLY can leave an invalid relation behind, so this migration is
    # deliberately restart-safe for that committed failure prefix.
    with op.get_context().autocommit_block():
        if state == "exact_invalid":
            op.drop_index(
                _INDEX_NAME,
                table_name="note_blocks",
                postgresql_concurrently=True,
            )
            _require_index_state(bind, "absent")
            state = "absent"
        if state == "absent":
            op.create_index(
                _INDEX_NAME,
                "note_blocks",
                ["body_text"],
                postgresql_using="gin",
                postgresql_ops={"body_text": "gin_trgm_ops"},
                postgresql_concurrently=True,
            )
        _require_index_state(bind, "exact_valid")


def downgrade() -> None:
    raise RuntimeError("0210 is a hard cutover migration and has no downgrade path")
