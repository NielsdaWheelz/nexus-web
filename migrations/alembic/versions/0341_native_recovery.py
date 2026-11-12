"""Archive terminal native identities and require incarnation-bound active work.

Requires stopped writers and no open old bindings. Preserve every closed native
identity verbatim in its existing terminal audit; invent no host incarnation.
Unconvertible records abort the transaction. No compatibility reader remains.
"""

import json

import sqlalchemy as sa
from alembic import op

revision = "0341"
down_revision = "0340"
branch_labels = None
depends_on = None


def upgrade():
    db = op.get_bind()
    rows = (
        db.execute(
            sa.text("""SELECT id,outcome,terminal,native_execution
        FROM llm_calls WHERE native_execution IS NOT NULL ORDER BY id""")
        )
        .mappings()
        .all()
    )
    for row in rows:
        native, terminal = row["native_execution"], row["terminal"]
        reason = None
        if row["outcome"] is None:
            reason = "open native binding requires settlement before cutover"
        elif (
            not isinstance(native, dict)
            or set(native) != {"profile_key", "thread_handle", "settled"}
            or not isinstance(native["profile_key"], str)
            or not native["profile_key"]
            or not isinstance(native["thread_handle"], str)
            or not native["thread_handle"]
            or type(native["settled"]) is not bool
        ):
            reason = "malformed terminal native binding"
        elif not isinstance(terminal, dict) or "native_execution" in terminal:
            reason = "terminal audit is absent, malformed or already has native identity"
        if reason is not None:
            raise RuntimeError(f"0341 generation {row['id']}: {reason}")
    for row in rows:
        db.execute(
            sa.text("""UPDATE llm_calls
            SET terminal=terminal || jsonb_build_object('native_execution',CAST(:native AS jsonb)),
                native_execution=NULL WHERE id=:id"""),
            {"id": row["id"], "native": json.dumps(row["native_execution"])},
        )
    op.create_check_constraint(
        "ck_llm_calls_native_execution_open",
        "llm_calls",
        "native_execution IS NULL OR outcome IS NULL",
    )


def downgrade():
    raise RuntimeError("0341 is a hard cut; restore the verified backup and paired release")
