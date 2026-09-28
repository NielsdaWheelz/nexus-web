"""Drop the write-only and never-written schema.

Revision ID: 0251
Revises: 0250

No code, SQL, wire model or constraint reads these tables or columns. Postgres drops
every index, CHECK and foreign key naming a dropped column with it, including
ck_oracle_passage_anchors_resolution_state: the oracle status/pointer rule is held by
oracle_corpus's writers, and every reader already fails closed on a null pointer.
Stored reindex payloads lose request_id before the three-key validator can see them;
dead reindex jobs are never pruned and requeue their payload verbatim.

Irreversible: the release's pre-migration backup is the only copy of the dropped data.
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0251"
down_revision: str | Sequence[str] | None = "0250"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.drop_table("highlight_pdf_text_anchors")
    for table, columns in {
        "media_source_attempts": ("request_id", "retry_after_seconds", "started_at", "run_count"),
        "media_upload_sessions": (
            "verification_token",
            "verification_generation",
            "verification_expires_at",
            "request_id",
        ),
        "messages": ("context_items",),
        "contributor_credits": ("normalized_credited_name",),
        "media": ("processing_attempts", "processing_completed_at"),
        "highlight_pdf_anchors": (
            "plain_text_match_status",
            "plain_text_start_offset",
            "plain_text_end_offset",
        ),
        "chat_prompt_assemblies": (
            "prompt_block_manifest",
            "generation_intent_digest",
            "max_context_tokens",
            "included_retrieval_ids",
            "budget_breakdown",
        ),
        "project_gutenberg_catalog": (
            "gutenberg_type",
            "issued",
            "language",
            "locc",
            "copyright_status",
            "raw_metadata",
            "synced_at",
        ),
        "evidence_spans": (
            "start_block_id",
            "end_block_id",
            "start_block_offset",
            "end_block_offset",
        ),
        "epub_fragment_sources": (
            "manifest_item_id",
            "spine_itemref_id",
            "media_type",
            "linear",
            "reading_order",
        ),
        "oracle_passage_anchors": ("resolution_error", "resolved_at"),
        "media_atlas_positions": ("projection_version",),
    }.items():
        for column in columns:
            op.drop_column(table, column)
    op.execute(
        "UPDATE background_jobs SET payload = payload - 'request_id'"
        " WHERE kind = 'media_content_reindex_job'"
    )


def downgrade() -> None:
    raise NotImplementedError("0251 is an irreversible schema deletion")
