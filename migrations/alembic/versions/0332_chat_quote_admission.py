"""Fence chat creation after deletion and index message-owned reader quotations.

revision 0332 follows head 0331. data effects: initialize one chat deletion fence
at 1 for every existing account; add the exact snapshot-owner lookup index and
backfill publication-owned table boundaries from each retained fragment. a table
whose frozen canonical text cannot be reproduced aborts the migration. no
message, quote, generation intent, authored row or historical evidence is rewritten.
stopped writers and a verified backup are required. downgrade requires that backup
and matching binaries: dropping the fence would permit deleted creation replay.
"""

from collections.abc import Sequence
from pathlib import Path
from runpy import run_path

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0332"
down_revision: str | Sequence[str] | None = "0331"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "chat_deletion_revisions",
        sa.Column("user_id", sa.UUID(), sa.ForeignKey("users.id"), primary_key=True),
        sa.Column("revision", sa.BigInteger(), nullable=False),
    )
    op.execute("INSERT INTO chat_deletion_revisions(user_id,revision) SELECT id,1 FROM users")
    op.execute(
        "CREATE INDEX ix_messages_reader_quote_owner ON messages "
        "((reader_selection_snapshot #>> '{evidence,target,owner_ref}')) "
        "WHERE reader_selection_snapshot IS NOT NULL"
    )
    op.create_table(
        "fragment_tables",
        sa.Column("id", sa.UUID(), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("fragment_id", sa.UUID(), sa.ForeignKey("fragments.id"), nullable=False),
        sa.Column("dom_path", postgresql.ARRAY(sa.BigInteger()), nullable=False),
        sa.Column("start_offset", sa.Integer(), nullable=False),
        sa.Column("end_offset", sa.Integer(), nullable=False),
        sa.UniqueConstraint("fragment_id", "dom_path", name="uq_fragment_tables_fragment_path"),
    )
    tables = run_path(
        str(Path(__file__).resolve().parent.parent / "frozen" / "0332_fragment_tables.py")
    )["fragment_tables"]
    db = op.get_bind()
    after = None
    while True:
        row = db.execute(
            sa.text(
                "SELECT id,html_sanitized,canonical_text FROM fragments WHERE CAST(:after AS uuid) IS NULL OR id>CAST(:after AS uuid) ORDER BY id LIMIT 1"
            ),
            {"after": after},
        ).first()
        if row is None:
            break
        try:
            boundaries = tables(row.html_sanitized, row.canonical_text)
        except (RuntimeError, ValueError, TypeError) as error:
            raise RuntimeError(
                f"fragment {row.id} cannot reproduce its table boundaries"
            ) from error
        if boundaries:
            db.execute(
                sa.text(
                    "INSERT INTO fragment_tables(fragment_id,dom_path,start_offset,end_offset) VALUES (:fragment_id,:dom_path,:start_offset,:end_offset)"
                ),
                [{"fragment_id": row.id, **boundary} for boundary in boundaries],
            )
        after = row.id


def downgrade() -> None:
    raise RuntimeError("Restore the verified pre-release backup and matching binaries to downgrade")
