"""Add reader apparatus item resource refs.

Revision ID: 0165
Revises: 0164
Create Date: 2026-06-17
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0165"
down_revision: str | Sequence[str] | None = "0164"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

RESOURCE_SCHEMES = """
    'media', 'library', 'evidence_span', 'content_chunk',
    'highlight', 'page', 'note_block', 'fragment',
    'conversation', 'message', 'oracle_reading',
    'oracle_corpus_passage', 'library_intelligence_artifact',
    'library_intelligence_revision', 'external_snapshot',
    'contributor', 'podcast', 'reader_apparatus_item'
"""

RETRIEVAL_RESULT_TYPES = """
    'page', 'note_block', 'highlight', 'media', 'podcast', 'episode',
    'video', 'content_chunk', 'fragment', 'message', 'contributor',
    'evidence_span', 'conversation', 'web_result', 'reader_apparatus_item'
"""


def upgrade() -> None:
    op.drop_constraint("ck_resource_edges_source_scheme", "resource_edges", type_="check")
    op.drop_constraint("ck_resource_edges_target_scheme", "resource_edges", type_="check")
    op.create_check_constraint(
        "ck_resource_edges_source_scheme",
        "resource_edges",
        f"source_scheme IN ({RESOURCE_SCHEMES})",
    )
    op.create_check_constraint(
        "ck_resource_edges_target_scheme",
        "resource_edges",
        f"target_scheme IN ({RESOURCE_SCHEMES})",
    )

    op.drop_constraint("ck_resource_versions_resource_scheme", "resource_versions", type_="check")
    op.create_check_constraint(
        "ck_resource_versions_resource_scheme",
        "resource_versions",
        f"resource_scheme IN ({RESOURCE_SCHEMES})",
    )

    op.drop_constraint(
        "ck_resource_view_states_surface_scheme", "resource_view_states", type_="check"
    )
    op.drop_constraint(
        "ck_resource_view_states_target_scheme", "resource_view_states", type_="check"
    )
    op.create_check_constraint(
        "ck_resource_view_states_surface_scheme",
        "resource_view_states",
        f"surface_scheme IN ({RESOURCE_SCHEMES})",
    )
    op.create_check_constraint(
        "ck_resource_view_states_target_scheme",
        "resource_view_states",
        f"target_scheme IS NULL OR target_scheme IN ({RESOURCE_SCHEMES})",
    )

    op.drop_constraint("ck_user_pinned_objects_type", "user_pinned_objects", type_="check")
    op.create_check_constraint(
        "ck_user_pinned_objects_type",
        "user_pinned_objects",
        "object_type IN ("
        "'page', 'note_block', 'media', 'highlight', 'conversation', 'message', "
        "'podcast', 'content_chunk', 'fragment', 'contributor', 'evidence_span', "
        "'reader_apparatus_item')",
    )

    op.drop_constraint("ck_message_retrievals_result_type", "message_retrievals", type_="check")
    op.create_check_constraint(
        "ck_message_retrievals_result_type",
        "message_retrievals",
        f"result_type IN ({RETRIEVAL_RESULT_TYPES})",
    )

    op.drop_constraint(
        "ck_chat_run_turn_contexts_requested_subject_scheme",
        "chat_run_turn_contexts",
        type_="check",
    )
    op.drop_constraint(
        "ck_chat_run_turn_contexts_subject_scheme",
        "chat_run_turn_contexts",
        type_="check",
    )
    op.create_check_constraint(
        "ck_chat_run_turn_contexts_requested_subject_scheme",
        "chat_run_turn_contexts",
        f"requested_subject_scheme IS NULL OR requested_subject_scheme IN ({RESOURCE_SCHEMES})",
    )
    op.create_check_constraint(
        "ck_chat_run_turn_contexts_subject_scheme",
        "chat_run_turn_contexts",
        f"subject_scheme IS NULL OR subject_scheme IN ({RESOURCE_SCHEMES})",
    )


def downgrade() -> None:
    raise NotImplementedError("Hard cutover: 0165 is not reversible")
