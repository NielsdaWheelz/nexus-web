"""Store absent retrieval locators as SQL NULL, never JSON null.

Revision ID: 0303
Revises: 0302

Data effects: every ``message_retrievals.locator`` equal to JSON ``null`` becomes SQL NULL;
no other column or row changes. Python decodes both forms as ``None``; ``IS NULL`` matched
only SQL NULL. The 8a67e218a backup holds nine. The count is printed to stdout, which the
release log keeps. Every such value converts, so nothing refuses. Then
``ck_message_retrievals_locator_object`` loses its JSON ``null`` arm: a locator is SQL NULL
or a JSON object, and the database refuses any other write.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0303"
down_revision: str | Sequence[str] | None = "0302"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    converted = op.get_bind().execute(
        sa.text("UPDATE message_retrievals SET locator = NULL WHERE locator = 'null'::jsonb")
    )
    print(f"0303 converts {converted.rowcount} json-null retrieval locators")
    op.execute(
        """
        ALTER TABLE message_retrievals DROP CONSTRAINT ck_message_retrievals_locator_object,
            ADD CONSTRAINT ck_message_retrievals_locator_object
            CHECK (locator IS NULL OR jsonb_typeof(locator) = 'object')
        """
    )


def downgrade() -> None:
    raise NotImplementedError("0303 is irreversible; restore the pre-release backup")
