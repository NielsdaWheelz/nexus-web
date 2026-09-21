"""Baseline schema: revisions 0001-0236 squashed into the schema they produced.

Revision ID: 0236
Revises:
Create Date: 2026-09-21

Production already stands at 0236, so this revision never runs there; it is the
same node in the graph that 0237 revises. It exists so a database can be built
from nothing without replaying 236 hand-written revisions. The SQL beside this
file is `pg_dump --schema-only` of the old chain replayed to 0236, plus the
reference rows those revisions seed (`oracle_plates`, the system user, the
`Heavy` capacity lease, the viewer collection revisions).
"""

from collections.abc import Sequence
from pathlib import Path

from alembic import op

revision: str = "0236"
down_revision: str | Sequence[str] | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # The dumped SQL carries literal `%` (LIKE patterns, percent-encoded URLs), so it goes
    # straight to a DBAPI cursor: SQLAlchemy's text() would read `:` as a bind parameter and
    # exec_driver_sql() would hand psycopg a parameterised query and choke on the `%`.
    with op.get_bind().connection.cursor() as cursor:
        for name in ("0236_baseline_schema.sql", "0236_baseline_data.sql"):
            cursor.execute(Path(__file__).with_name(name).read_text(encoding="utf-8"))


def downgrade() -> None:
    raise NotImplementedError("0236 is the baseline schema; there is nothing beneath it")
