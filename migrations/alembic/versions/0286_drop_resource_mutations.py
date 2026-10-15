"""Drop the replay ledger: nothing reads or writes ``resource_mutations`` any more.

Revision ID: 0286
Revises: 0285

Every write that recorded a receipt now names its own result (a chat run is the
client's ``Idempotency-Key``, a new author and a link take client-minted ids) or is
absolute (authors) or a plain increment (launcher selections). Every row is a
disposable receipt; nothing refuses. A chat send pending across the deploy is admitted
again when retried (its receipt is gone): the release waits for none to be pending.

Irreversible: the release's pre-migration backup holds the table.
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0286"
down_revision: str | Sequence[str] | None = "0285"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("DROP TABLE resource_mutations")


def downgrade() -> None:
    raise NotImplementedError("0286 is irreversible; restore the pre-release backup")
