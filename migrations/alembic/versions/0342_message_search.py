"""Publish retained partial answers for browser message search.

Data effects: backfill only nonempty error/cancelled message occurrences in
256-identity batches. Preserve canonical messages, turns, timestamps and actions.
Reject unknown message roles/statuses; pending messages remain valid and unindexed.
Frozen SQL matches current publication without importing application code.
Writers must be stopped; restore the verified backup and paired release to revert.
"""

import sqlalchemy as sa
from alembic import op

revision = "0342"
down_revision = "0341"
branch_labels = None
depends_on = None


def upgrade():
    db = op.get_bind()
    invalid = db.execute(
        sa.text("""SELECT id,role,status FROM messages
        WHERE role NOT IN ('user','assistant')
           OR status NOT IN ('pending','complete','error','cancelled')
        ORDER BY id LIMIT 1""")
    ).first()
    if invalid is not None:
        raise RuntimeError(
            f"0342 message {invalid.id}: unknown role/status {invalid.role}/{invalid.status}"
        )
    db.execute(sa.text("SET LOCAL paradedb.global_mutable_segment_rows=0"))
    previous = None
    while True:
        identities = db.scalars(
            sa.text("""SELECT id FROM messages
            WHERE status IN ('error','cancelled') AND content<>''
              AND (CAST(:previous AS uuid) IS NULL OR id>:previous)
            ORDER BY id LIMIT 256"""),
            {"previous": previous},
        ).all()
        if not identities:
            break
        db.execute(
            sa.text("DELETE FROM keyword_occurrences WHERE doc_key=ANY(:keys)"),
            {"keys": [f"message:{identity}" for identity in identities]},
        )
        db.execute(
            sa.text("""INSERT INTO keyword_occurrences
            (doc_key,ref,owner_ref,family,admission_key,body)
            SELECT 'message:'||id::text,'message:'||id::text,'message:'||id::text,
                   'message','message:'||id::text,content
            FROM messages WHERE id=ANY(CAST(:ids AS uuid[]))"""),
            {"ids": identities},
        )
        previous = identities[-1]


def downgrade():
    raise RuntimeError("0342 is a hard cut; restore the verified backup and paired release")
