"""Hard-cut command palette usage history to Nexus href history.

Revision ID: 0199
Revises: 0198
Create Date: 2026-07-29
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0199"
down_revision: str | Sequence[str] | None = "0198"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_FORWARD_SOURCE_SQL = """
CASE source
    WHEN 'static' THEN 'Static'
    WHEN 'workspace' THEN 'Workspace'
    WHEN 'recent' THEN 'Recent'
    WHEN 'oracle' THEN 'Oracle'
    WHEN 'search' THEN 'Search'
    WHEN 'ai' THEN 'Ai'
END
"""

_REVERSE_SOURCE_SQL = """
CASE source
    WHEN 'Static' THEN 'static'
    WHEN 'Workspace' THEN 'workspace'
    WHEN 'Recent' THEN 'recent'
    WHEN 'Oracle' THEN 'oracle'
    WHEN 'Search' THEN 'search'
    WHEN 'Ai' THEN 'ai'
END
"""


def _report(message: str) -> None:
    print(f"0199: {message}")


def _assert_no_rows(bind, sql: str, message: str) -> None:
    count = bind.scalar(sa.text(sql))
    if count:
        raise RuntimeError(f"0199: {message}: {count} row(s)")


def upgrade() -> None:
    bind = op.get_bind()

    counts = bind.execute(
        sa.text(
            """
            SELECT target_kind, source, count(*) AS row_count
            FROM command_palette_usages
            GROUP BY target_kind, source
            ORDER BY target_kind, source
            """
        )
    ).all()
    if counts:
        for target_kind, source, row_count in counts:
            _report(
                "preflight "
                f"target_kind={target_kind!r} source={source!r} rows={row_count}"
            )
    else:
        _report("preflight no usage rows")

    op.execute("DELETE FROM command_palette_usages WHERE target_kind <> 'href'")
    _assert_no_rows(
        bind,
        """
        SELECT count(*)
        FROM command_palette_usages
        WHERE target_kind <> 'href' OR target_href IS NULL
        """,
        "retained history must be href-only with a target_href",
    )

    op.rename_table("command_palette_usages", "nexus_usages")
    op.execute(
        "ALTER TABLE nexus_usages "
        "RENAME CONSTRAINT command_palette_usages_pkey TO nexus_usages_pkey"
    )
    op.execute(
        "ALTER TABLE nexus_usages "
        "RENAME CONSTRAINT command_palette_usages_user_id_fkey "
        "TO nexus_usages_user_id_fkey"
    )
    op.execute(
        "ALTER TABLE nexus_usages "
        "RENAME CONSTRAINT ck_command_palette_usages_use_count "
        "TO ck_nexus_usages_use_count"
    )
    op.execute(
        "ALTER INDEX ix_command_palette_usages_user_last_used_at_id "
        "RENAME TO ix_nexus_usages_user_last_used_at_id"
    )
    op.execute(
        "ALTER INDEX ix_command_palette_usages_user_query_last_used_at "
        "RENAME TO ix_nexus_usages_user_query_last_used_at"
    )

    op.alter_column(
        "nexus_usages",
        "title_snapshot",
        new_column_name="label_snapshot",
    )

    op.drop_constraint(
        "uq_command_palette_usages_user_query_target",
        "nexus_usages",
        type_="unique",
    )
    op.create_unique_constraint(
        "uq_nexus_usages_user_query_href",
        "nexus_usages",
        ["user_id", "query_normalized", "target_href"],
    )
    op.drop_column("nexus_usages", "target_key")

    op.drop_constraint(
        "ck_command_palette_usages_target_kind",
        "nexus_usages",
        type_="check",
    )
    op.drop_constraint(
        "ck_command_palette_usages_target_href",
        "nexus_usages",
        type_="check",
    )
    op.drop_column("nexus_usages", "target_kind")
    op.alter_column("nexus_usages", "target_href", nullable=False)

    op.drop_constraint(
        "ck_command_palette_usages_source",
        "nexus_usages",
        type_="check",
    )
    op.execute(f"UPDATE nexus_usages SET source = {_FORWARD_SOURCE_SQL}")
    _assert_no_rows(
        bind,
        """
        SELECT count(*)
        FROM nexus_usages
        WHERE source NOT IN ('Static', 'Workspace', 'Recent', 'Oracle', 'Search', 'Ai')
        """,
        "forward source mapping produced an unsupported value",
    )


def downgrade() -> None:
    bind = op.get_bind()
    _assert_no_rows(
        bind,
        """
        SELECT count(*)
        FROM nexus_usages
        WHERE source NOT IN ('Static', 'Workspace', 'Recent', 'Oracle', 'Search', 'Ai')
        """,
        "cannot reverse an unsupported Nexus source",
    )
    op.execute(f"UPDATE nexus_usages SET source = {_REVERSE_SOURCE_SQL}")

    op.add_column("nexus_usages", sa.Column("target_key", sa.Text(), nullable=True))
    op.add_column("nexus_usages", sa.Column("target_kind", sa.Text(), nullable=True))
    op.execute(
        """
        UPDATE nexus_usages
        SET target_kind = 'href',
            target_key = target_href
        """
    )
    op.alter_column("nexus_usages", "target_key", nullable=False)
    op.alter_column("nexus_usages", "target_kind", nullable=False)
    op.alter_column("nexus_usages", "target_href", nullable=True)

    op.alter_column(
        "nexus_usages",
        "label_snapshot",
        new_column_name="title_snapshot",
    )
    op.drop_constraint(
        "uq_nexus_usages_user_query_href",
        "nexus_usages",
        type_="unique",
    )
    op.create_unique_constraint(
        "uq_command_palette_usages_user_query_target",
        "nexus_usages",
        ["user_id", "query_normalized", "target_key"],
    )
    op.create_check_constraint(
        "ck_command_palette_usages_target_kind",
        "nexus_usages",
        "target_kind IN ('href', 'action', 'prefill')",
    )
    op.create_check_constraint(
        "ck_command_palette_usages_source",
        "nexus_usages",
        "source IN ('static', 'workspace', 'recent', 'oracle', 'search', 'ai')",
    )
    op.create_check_constraint(
        "ck_command_palette_usages_target_href",
        "nexus_usages",
        "(target_kind = 'href' AND target_href IS NOT NULL) OR "
        "(target_kind <> 'href' AND target_href IS NULL)",
    )

    op.execute(
        "ALTER TABLE nexus_usages "
        "RENAME CONSTRAINT nexus_usages_pkey TO command_palette_usages_pkey"
    )
    op.execute(
        "ALTER TABLE nexus_usages "
        "RENAME CONSTRAINT nexus_usages_user_id_fkey "
        "TO command_palette_usages_user_id_fkey"
    )
    op.execute(
        "ALTER TABLE nexus_usages "
        "RENAME CONSTRAINT ck_nexus_usages_use_count "
        "TO ck_command_palette_usages_use_count"
    )
    op.execute(
        "ALTER INDEX ix_nexus_usages_user_last_used_at_id "
        "RENAME TO ix_command_palette_usages_user_last_used_at_id"
    )
    op.execute(
        "ALTER INDEX ix_nexus_usages_user_query_last_used_at "
        "RENAME TO ix_command_palette_usages_user_query_last_used_at"
    )
    op.rename_table("nexus_usages", "command_palette_usages")
