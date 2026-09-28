"""Delete the Postgres rate limiter and the stream-token replay claims.

Revision ID: 0248
Revises: 0247

Both tables hold only ephemeral rows. Chat admission receipts memoized with
E_RATE_LIMITED are deleted because ChatAdmissionRejectionCode no longer admits
that code; replaying such a key re-admits the send, which is safe because the
rejection had no effects.
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0248"
down_revision: str | Sequence[str] | None = "0247"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.drop_table("rate_limit_request_log")
    op.drop_table("stream_token_jti_claims")
    op.execute(
        """
        DELETE FROM resource_mutations
        WHERE mutation_scope = 'chat:admission'
          AND response_json #>> '{outcome,reason,code}' = 'E_RATE_LIMITED'
        """
    )


def downgrade() -> None:
    raise NotImplementedError("0248 is an irreversible feature deletion")
