"""Oracle creates take client resource ids.

Revision ID: 0295
Revises: 0294

Data effects: discard obsolete replay keys. Preserve all existing reading ids,
folios, publications, citations, statuses and jobs. No row conversion is needed.
The removed default makes every future creation supply its resource id.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0295"
down_revision: str | Sequence[str] | None = "0294"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.drop_index("uq_oracle_readings_user_idempotency_key", table_name="oracle_readings")
    op.drop_column("oracle_readings", "idempotency_key")
    op.alter_column("oracle_readings", "id", existing_type=sa.UUID(), server_default=None)


def downgrade() -> None:
    raise NotImplementedError("0295 is irreversible; restore the pre-release backup")
