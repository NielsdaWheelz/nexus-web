"""Create Consumption activity span and first-completion fact storage.

Revision ID: 0194
Revises: 0193
Create Date: 2026-07-24
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0194"
down_revision: str | Sequence[str] | None = "0193"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE consumption_activity_spans (
            id                          uuid        PRIMARY KEY,
            user_id                     uuid        NOT NULL,
            media_id                    uuid        NOT NULL,
            modality                    text        NOT NULL,
            device_id                   text        NOT NULL,
            device_class                text        NOT NULL,
            occurred_at                 timestamptz NOT NULL,
            duration_ms                 bigint      NOT NULL,
            progress_start              double precision NULL,
            progress_end                double precision NULL,
            word_start                  bigint      NULL,
            word_end                    bigint      NULL,
            media_position_start_ms     bigint      NULL,
            media_position_end_ms       bigint      NULL,
            created_at                  timestamptz NOT NULL DEFAULT now(),

            CONSTRAINT fk_consumption_activity_spans_user
                FOREIGN KEY (user_id) REFERENCES users(id),
            CONSTRAINT fk_consumption_activity_spans_media
                FOREIGN KEY (media_id) REFERENCES media(id)
        )
        """
    )
    op.execute(
        """
        CREATE INDEX ix_consumption_activity_spans_user_occurred_id
            ON consumption_activity_spans (user_id, occurred_at, id)
        """
    )
    op.execute(
        """
        CREATE INDEX ix_consumption_activity_spans_user_media_occurred_id
            ON consumption_activity_spans (user_id, media_id, occurred_at, id)
        """
    )
    op.execute(
        """
        CREATE INDEX ix_consumption_activity_spans_user_device_occurred_id
            ON consumption_activity_spans (user_id, device_id, occurred_at, id)
        """
    )
    op.execute(
        """
        CREATE INDEX ix_consumption_activity_spans_media_id
            ON consumption_activity_spans (media_id, id)
        """
    )
    op.execute(
        """
        CREATE TABLE consumption_completion_facts (
            id          uuid        PRIMARY KEY,
            user_id     uuid        NOT NULL,
            media_id    uuid        NOT NULL,
            modality    text        NOT NULL,
            created_at  timestamptz NOT NULL DEFAULT now(),

            CONSTRAINT fk_consumption_completion_facts_user
                FOREIGN KEY (user_id) REFERENCES users(id),
            CONSTRAINT fk_consumption_completion_facts_media
                FOREIGN KEY (media_id) REFERENCES media(id),
            CONSTRAINT uq_consumption_completion_facts_user_media
                UNIQUE (user_id, media_id)
        )
        """
    )
    op.execute(
        """
        CREATE INDEX ix_consumption_completion_facts_user_created_id
            ON consumption_completion_facts (user_id, created_at, id)
        """
    )
    op.execute(
        """
        CREATE INDEX ix_consumption_completion_facts_media_id
            ON consumption_completion_facts (media_id, id)
        """
    )


def downgrade() -> None:
    raise RuntimeError(
        "0194 is a hard cutover migration; Consumption activity facts have no downgrade path"
    )
