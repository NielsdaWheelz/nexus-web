"""Drop the dead columns, tables, and orphan replay memos the slop sweep left.

Revision ID: 0234
Revises: 0233
Create Date: 2026-09-18
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0234"
down_revision: str | Sequence[str] | None = "0233"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        "DELETE FROM resource_mutations "
        "WHERE mutation_scope IN ('Consumption.Activity', 'Consumption.PreviewPosition')"
    )

    op.drop_constraint(
        "ck_resource_mutations_changed_lanes_object",
        "resource_mutations",
        type_="check",
    )
    op.drop_column("resource_mutations", "changed_lanes")

    op.drop_constraint("uq_passage_anchors_identity", "passage_anchors", type_="unique")
    op.drop_column("passage_anchors", "selector_version")
    op.create_unique_constraint(
        "uq_passage_anchors_identity",
        "passage_anchors",
        ["user_id", "owner_scheme", "owner_id", "anchor_key"],
    )

    op.drop_index("uq_resource_grants_share_token_hash", table_name="resource_grants")
    op.drop_column("resource_grants", "share_token_hash")
    op.create_index(
        "uq_resource_grants_share_token",
        "resource_grants",
        ["share_token"],
        unique=True,
        postgresql_where=sa.text("share_token IS NOT NULL"),
    )

    op.drop_column("artifact_learn_failures", "error_code")
    op.drop_column("chat_runs", "error_detail")
    op.drop_column("libraries", "color")
    op.drop_column("stripe_webhook_events", "processed_at")
    op.drop_column("document_embed_artifact_states", "extraction_error_code")
    op.drop_column("document_embed_artifact_states", "extraction_error_message")
    op.drop_column("fragment_blocks", "block_type")
    op.drop_column("fragment_blocks", "is_empty")
    op.drop_column("epub_resources", "fallback_item_id")
    op.drop_column("epub_resources", "manifest_item_id")
    op.drop_column("epub_resources", "properties")

    op.drop_constraint(
        "ck_resource_versions_content_hash_length",
        "resource_versions",
        type_="check",
    )
    op.drop_column("resource_versions", "content_hash")

    op.drop_constraint(
        "ck_resource_external_snapshots_source_object",
        "resource_external_snapshots",
        type_="check",
    )
    op.drop_column("resource_external_snapshots", "source_snapshot")

    op.drop_table("billing_entitlement_override_events")


def downgrade() -> None:
    raise NotImplementedError("0234 is an irreversible dead-schema hard cutover")
