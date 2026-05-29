"""Conversation references cutover.

Replace the fragmented chat-context tables with a single polymorphic
``conversation_references`` table whose rows are pure pointers
(``resource_uri`` + ``created_at``). Drops the memory items, pinned
sources, singletons, per-message context items, and the dead source
manifests; replaces the ``source_manifest_delta`` chat_run_event type
with ``reference_added``. Hard cutover; no data migration, no downgrade.

Revision ID: 0121
Revises: 0120
Create Date: 2026-05-28
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0121"
down_revision: str | None = "0120"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # Child first: conversation_memory_item_sources references
    # conversation_memory_items via memory_item_id. Dropping these tables
    # also drops the constraint triggers that depend on the
    # enforce_conversation_memory_required_sources() function, which we
    # then drop explicitly (it is freestanding).
    op.drop_table("conversation_memory_item_sources")
    op.drop_table("conversation_memory_items")
    op.execute(
        "DROP FUNCTION IF EXISTS enforce_conversation_memory_required_sources()"
    )

    op.drop_table("conversation_pinned_sources")
    op.drop_table("chat_singletons")
    op.drop_table("message_context_items")

    # source_manifests is dead: the source_manifest_delta SSE event is
    # being removed, no producer remains in python/nexus/services/, and
    # the cutover spec replaces manifest plumbing with reference rows.
    op.drop_table("source_manifests")

    # Update chat_run_events.event_type CHECK: drop source_manifest_delta,
    # add reference_added. Keep legacy claim / claim_evidence so historical
    # rows from before 0116 remain valid.
    op.drop_constraint(
        "ck_chat_run_events_event_type",
        "chat_run_events",
        type_="check",
    )
    op.create_check_constraint(
        "ck_chat_run_events_event_type",
        "chat_run_events",
        "event_type IN ("
        "'meta', 'tool_call', 'retrieval_result', "
        "'citation_index', 'reference_added', "
        "'claim', 'claim_evidence', 'delta', 'done'"
        ")",
    )

    op.create_table(
        "conversation_references",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
            nullable=False,
        ),
        sa.Column(
            "conversation_id",
            postgresql.UUID(as_uuid=True),
            nullable=False,
        ),
        sa.Column("resource_uri", sa.Text(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["conversation_id"],
            ["conversations.id"],
        ),
        sa.UniqueConstraint(
            "conversation_id",
            "resource_uri",
            name="uq_conversation_references_conversation_uri",
        ),
    )
    op.create_index(
        "ix_conversation_references_resource_uri",
        "conversation_references",
        ["resource_uri"],
    )


def downgrade() -> None:
    raise NotImplementedError("Hard cutover: 0121 is not reversible")
