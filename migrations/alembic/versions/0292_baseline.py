"""Baseline schema: revisions 0236-0292 squashed into the schema they produced.

Revision ID: 0292
Revises:
Create Date: 2026-10-18

Production already stands at 0292, so this revision never runs there; it is the
same node that 0293 revises. It builds a database from nothing. The SQL beside
this file is `pg_dump --schema-only --no-owner --no-privileges` of the old chain
replayed to 0292, plus the rows that chain seeds (the system user, the `Heavy`
capacity lease, the `suggestion_inputs` singleton and the two sequence positions),
minus pg_dump's `\\restrict` guards and its session `search_path` reset.
The chain's conversions, refusals and backfills left with it; production ran them.
"""

from collections.abc import Sequence
from pathlib import Path

from alembic import op

revision: str = "0292"
down_revision: str | Sequence[str] | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # The dumped SQL carries literal `%` and `:`, so it goes straight to a DBAPI cursor:
    # text() would read `:` as a bind parameter and exec_driver_sql() would hand psycopg
    # a parameterised query that chokes on the `%`.
    with op.get_bind().connection.cursor() as cursor:
        for name in ("0292_baseline_schema.sql", "0292_baseline_data.sql"):
            cursor.execute(Path(__file__).with_name(name).read_text(encoding="utf-8"))


def downgrade() -> None:
    raise NotImplementedError("0292 is the baseline schema; there is nothing beneath it")
