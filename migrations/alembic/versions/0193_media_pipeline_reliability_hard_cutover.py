"""Add the media content revision and teardown lookup indexes.

Revision ID: 0193
Revises: 0192
Create Date: 2026-07-24
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0193"
down_revision: str | None = "0192"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


_INDEXES: tuple[tuple[str, str, tuple[str, ...]], ...] = (
    (
        "ix_content_blocks_parent_block_id",
        "content_blocks",
        ("parent_block_id",),
    ),
    (
        "ix_content_chunk_parts_block_id",
        "content_chunk_parts",
        ("block_id",),
    ),
    (
        "ix_evidence_spans_start_block_id",
        "evidence_spans",
        ("start_block_id",),
    ),
    (
        "ix_evidence_spans_end_block_id",
        "evidence_spans",
        ("end_block_id",),
    ),
    (
        "ix_content_chunks_primary_evidence_span_id",
        "content_chunks",
        ("primary_evidence_span_id",),
    ),
    (
        "ix_content_embeddings_chunk_id",
        "content_embeddings",
        ("chunk_id",),
    ),
    (
        "ix_media_claims_evidence_span_id",
        "media_claims",
        ("evidence_span_id",),
    ),
)


def _revision_column_state(bind: sa.engine.Connection) -> str:
    row = (
        bind.execute(
            sa.text(
                """
            SELECT
                a.atttypid = 'pg_catalog.int8'::regtype AS is_bigint,
                a.atttypmod AS type_modifier,
                a.attnotnull AS is_not_null,
                pg_get_expr(d.adbin, d.adrelid) AS default_expression
            FROM pg_attribute a
            JOIN pg_class table_relation ON table_relation.oid = a.attrelid
            JOIN pg_namespace table_namespace
              ON table_namespace.oid = table_relation.relnamespace
            LEFT JOIN pg_attrdef d
              ON d.adrelid = a.attrelid AND d.adnum = a.attnum
            WHERE table_namespace.nspname = 'public'
              AND table_relation.relname = 'content_index_states'
              AND a.attname = 'revision'
              AND a.attnum > 0
              AND NOT a.attisdropped
            """
            )
        )
        .mappings()
        .one_or_none()
    )
    if row is None:
        return "absent"
    if (
        row["is_bigint"]
        and row["type_modifier"] == -1
        and row["is_not_null"]
        and row["default_expression"] == "0"
    ):
        return "exact"
    raise RuntimeError(
        f"0193 content_index_states.revision has the wrong storage shape: {dict(row)!r}"
    )


def _index_state(
    bind: sa.engine.Connection,
    *,
    name: str,
    table: str,
    columns: tuple[str, ...],
) -> str:
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
            {"name": name},
        )
        .mappings()
        .one_or_none()
    )
    if row is None:
        return "absent"
    expected_definition = (
        f"CREATE INDEX {name} ON public.{table} USING btree ({', '.join(columns)})"
    )
    if row["definition"] != expected_definition:
        raise RuntimeError(f"0193 index {name} has the wrong definition: {dict(row)!r}")
    return "exact_valid" if row["is_valid"] else "exact_invalid"


def _require_index_state(
    bind: sa.engine.Connection,
    *,
    name: str,
    table: str,
    columns: tuple[str, ...],
    expected: str,
) -> None:
    actual = _index_state(bind, name=name, table=table, columns=columns)
    if actual != expected:
        raise RuntimeError(
            f"0193 index {name} expected state {expected!r}, found {actual!r}"
        )


def upgrade() -> None:
    bind = op.get_bind()
    column_state = _revision_column_state(bind)
    index_states = {
        name: _index_state(bind, name=name, table=table, columns=columns)
        for name, table, columns in _INDEXES
    }

    if column_state == "absent":
        op.add_column(
            "content_index_states",
            sa.Column(
                "revision",
                sa.BigInteger(),
                nullable=False,
                server_default=sa.text("0"),
            ),
        )
        if _revision_column_state(bind) != "exact":
            raise RuntimeError(
                "0193 content_index_states.revision was not created with the exact shape"
            )

    with op.get_context().autocommit_block():
        for name, table, columns in _INDEXES:
            state = index_states[name]
            if state == "exact_invalid":
                op.drop_index(
                    name,
                    table_name=table,
                    postgresql_concurrently=True,
                )
                _require_index_state(
                    bind,
                    name=name,
                    table=table,
                    columns=columns,
                    expected="absent",
                )
                state = "absent"
            if state == "absent":
                op.create_index(
                    name,
                    table,
                    list(columns),
                    unique=False,
                    postgresql_concurrently=True,
                )
            _require_index_state(
                bind,
                name=name,
                table=table,
                columns=columns,
                expected="exact_valid",
            )


def downgrade() -> None:
    bind = op.get_bind()
    column_state = _revision_column_state(bind)
    index_states = {
        name: _index_state(bind, name=name, table=table, columns=columns)
        for name, table, columns in _INDEXES
    }

    with op.get_context().autocommit_block():
        for name, table, columns in reversed(_INDEXES):
            if index_states[name] != "absent":
                op.drop_index(
                    name,
                    table_name=table,
                    postgresql_concurrently=True,
                )
                _require_index_state(
                    bind,
                    name=name,
                    table=table,
                    columns=columns,
                    expected="absent",
                )

    if column_state == "exact":
        op.drop_column("content_index_states", "revision")
        if _revision_column_state(bind) != "absent":
            raise RuntimeError("0193 content_index_states.revision was not dropped")
