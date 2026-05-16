"""Allow artifact parts as typed context refs.

Revision ID: 0090_artifact_part_context_refs
Revises: 0089_retrieval_rerank_ledgers
Create Date: 2026-05-14
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0090_artifact_part_context_refs"
down_revision: str | None = "0089_retrieval_rerank_ledgers"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

OBJECT_TYPES = (
    "'page', 'note_block', 'media', 'highlight', 'conversation', 'message', "
    "'podcast', 'content_chunk', 'fragment', 'contributor', 'evidence_span', "
    "'artifact', 'artifact_part'"
)
LEGACY_OBJECT_TYPES = (
    "'page', 'note_block', 'media', 'highlight', 'conversation', 'message', "
    "'podcast', 'content_chunk', 'fragment', 'contributor'"
)
MESSAGE_RETRIEVAL_TYPES = (
    "'page', 'note_block', 'highlight', 'media', 'podcast', 'episode', 'video', "
    "'content_chunk', 'fragment', 'message', 'contributor', 'evidence_span', "
    "'conversation', 'artifact', 'artifact_part', 'web_result', 'status'"
)
LEGACY_MESSAGE_RETRIEVAL_TYPES = (
    "'page', 'note_block', 'highlight', 'media', 'podcast', 'episode', 'video', "
    "'content_chunk', 'fragment', 'message', 'contributor', 'web_result', 'status'"
)


def upgrade() -> None:
    op.drop_constraint("ck_object_links_a_type", "object_links", type_="check")
    op.drop_constraint("ck_object_links_b_type", "object_links", type_="check")
    op.create_check_constraint(
        "ck_object_links_a_type",
        "object_links",
        f"a_type IN ({OBJECT_TYPES})",
    )
    op.create_check_constraint(
        "ck_object_links_b_type",
        "object_links",
        f"b_type IN ({OBJECT_TYPES})",
    )

    op.drop_constraint("ck_user_pinned_objects_type", "user_pinned_objects", type_="check")
    op.create_check_constraint(
        "ck_user_pinned_objects_type",
        "user_pinned_objects",
        f"object_type IN ({OBJECT_TYPES})",
    )

    op.drop_constraint(
        "ck_message_context_items_object_type",
        "message_context_items",
        type_="check",
    )
    op.create_check_constraint(
        "ck_message_context_items_object_type",
        "message_context_items",
        f"object_type IS NULL OR object_type IN ({OBJECT_TYPES})",
    )

    op.drop_constraint("ck_message_retrievals_result_type", "message_retrievals", type_="check")
    op.create_check_constraint(
        "ck_message_retrievals_result_type",
        "message_retrievals",
        f"result_type IN ({MESSAGE_RETRIEVAL_TYPES})",
    )


def downgrade() -> None:
    op.execute(
        """
        DELETE FROM message_retrievals
        WHERE result_type IN ('evidence_span', 'conversation', 'artifact', 'artifact_part')
        """
    )

    op.drop_constraint("ck_message_retrievals_result_type", "message_retrievals", type_="check")
    op.create_check_constraint(
        "ck_message_retrievals_result_type",
        "message_retrievals",
        f"result_type IN ({LEGACY_MESSAGE_RETRIEVAL_TYPES})",
    )

    op.execute(
        """
        DELETE FROM message_context_items
        WHERE object_type IN ('evidence_span', 'artifact', 'artifact_part')
        """
    )
    op.execute(
        """
        DELETE FROM user_pinned_objects
        WHERE object_type IN ('evidence_span', 'artifact', 'artifact_part')
        """
    )
    op.execute(
        """
        DELETE FROM object_links
        WHERE a_type IN ('evidence_span', 'artifact', 'artifact_part')
           OR b_type IN ('evidence_span', 'artifact', 'artifact_part')
        """
    )

    op.drop_constraint("ck_message_context_items_object_type", "message_context_items", type_="check")
    op.create_check_constraint(
        "ck_message_context_items_object_type",
        "message_context_items",
        f"object_type IS NULL OR object_type IN ({LEGACY_OBJECT_TYPES})",
    )

    op.drop_constraint("ck_user_pinned_objects_type", "user_pinned_objects", type_="check")
    op.create_check_constraint(
        "ck_user_pinned_objects_type",
        "user_pinned_objects",
        f"object_type IN ({LEGACY_OBJECT_TYPES})",
    )

    op.drop_constraint("ck_object_links_b_type", "object_links", type_="check")
    op.drop_constraint("ck_object_links_a_type", "object_links", type_="check")
    op.create_check_constraint(
        "ck_object_links_b_type",
        "object_links",
        f"b_type IN ({LEGACY_OBJECT_TYPES})",
    )
    op.create_check_constraint(
        "ck_object_links_a_type",
        "object_links",
        f"a_type IN ({LEGACY_OBJECT_TYPES})",
    )
