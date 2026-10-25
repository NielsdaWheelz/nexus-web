"""add source-backed pieces without changing existing text or synthesizing pieces.

revision 0316 follows actual head 0315. navigation/index proof columns start null;
no source scan runs. prefeature bibliography job payloads gain a null definition
fence. terminal reindex jobs gain explicit null request/witness/partition fields;
live reindex jobs must be drained before this migration and cause a refusal.
stored retrieval context refs gain a null passage target, including nested result
refs. malformed JSON shapes raise rather than being discarded or guessed.

accepted definitions restrict source publication/fragment replacement through FKs;
candidates never pin. downgrade refuses retained pieces, decisions or discovery
history; use the paired backup for such a rollback.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0316"
down_revision: str | Sequence[str] | None = "0315"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    connection = op.get_bind()
    if connection.scalar(
        sa.text("""SELECT EXISTS (SELECT 1 FROM background_jobs
        WHERE kind='media_content_reindex_job' AND status IN ('pending','failed','running'))""")
    ):
        raise RuntimeError(
            "drain all live media_content_reindex_job rows before contained-works revision 0316"
        )
    if connection.scalar(
        sa.text("""SELECT EXISTS (SELECT 1 FROM background_jobs
        WHERE kind='media_content_reindex_job' AND (
            jsonb_typeof(payload) IS DISTINCT FROM 'object'
            OR jsonb_typeof(payload->'media_id') IS DISTINCT FROM 'string'
            OR (payload->>'media_id') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
            OR jsonb_typeof(payload->'revision') IS DISTINCT FROM 'number'
            OR (payload->>'revision') !~ '^[0-9]+$'
            OR jsonb_typeof(payload->'reason') IS DISTINCT FROM 'string'
            OR (payload ? 'request' AND payload->'request'!='null'::jsonb)
            OR (payload ? 'section_witness_key' AND payload->'section_witness_key'!='null'::jsonb)
            OR (payload ? 'section_bounds_key' AND payload->'section_bounds_key'!='null'::jsonb)))""")
    ):
        raise RuntimeError("cannot convert malformed terminal media content reindex payload")
    if connection.scalar(
        sa.text("""SELECT EXISTS (SELECT 1 FROM message_retrievals
        WHERE jsonb_typeof(context_ref) IS DISTINCT FROM 'object'
           OR jsonb_typeof(result_ref) IS DISTINCT FROM 'object'
           OR (result_ref ? 'context_ref' AND jsonb_typeof(result_ref->'context_ref') IS DISTINCT FROM 'object')
           OR (context_ref ? 'passage_target' AND context_ref->'passage_target'!='null'::jsonb)
           OR (result_ref->'context_ref' ? 'passage_target' AND result_ref #> '{context_ref,passage_target}'!='null'::jsonb))""")
    ):
        raise RuntimeError(
            "cannot convert malformed retrieval context refs or prefeature passage targets"
        )
    op.execute("""UPDATE background_jobs SET payload=payload ||
        jsonb_build_object('request',NULL,'section_witness_key',NULL,'section_bounds_key',NULL)
        WHERE kind='media_content_reindex_job' AND status IN ('succeeded','dead')""")
    op.execute("""UPDATE message_retrievals SET context_ref=context_ref || jsonb_build_object('passage_target',NULL)
        WHERE NOT context_ref ? 'passage_target'""")
    op.execute("""UPDATE message_retrievals
        SET result_ref=jsonb_set(result_ref,'{context_ref,passage_target}','null'::jsonb,true)
        WHERE result_ref ? 'context_ref' AND NOT (result_ref->'context_ref') ? 'passage_target'""")
    op.drop_constraint("ck_media_kind", "media", type_="check")
    op.execute("""UPDATE background_jobs SET payload=payload || jsonb_build_object('part_definition_version',NULL)
        WHERE kind='enrich_metadata' AND payload->>'purpose'='bibliography'""")
    op.create_unique_constraint(
        "uq_reader_publications_media_generation",
        "reader_publications",
        ["media_id", "generation"],
    )
    op.create_table(
        "media_part_sets",
        sa.Column("source_media_id", sa.UUID(), sa.ForeignKey("media.id"), primary_key=True),
        sa.Column("revision", sa.BigInteger(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
    )
    op.create_table(
        "media_parts",
        sa.Column("media_id", sa.UUID(), sa.ForeignKey("media.id"), primary_key=True),
        sa.Column("source_media_id", sa.UUID(), sa.ForeignKey("media.id"), nullable=False),
        sa.Column("source_generation", sa.BigInteger(), nullable=False),
        sa.Column("start_fragment_idx", sa.Integer(), nullable=False),
        sa.Column("start_offset", sa.Integer(), nullable=False),
        sa.Column("end_fragment_idx", sa.Integer(), nullable=False),
        sa.Column("end_offset", sa.Integer(), nullable=False),
        sa.Column("start_dom_path", postgresql.ARRAY(sa.BigInteger()), nullable=False),
        sa.Column("start_dom_edge", sa.Text(), nullable=False),
        sa.Column("end_dom_path", postgresql.ARRAY(sa.BigInteger()), nullable=False),
        sa.Column("end_dom_edge", sa.Text(), nullable=False),
        sa.Column("form", sa.Text()),
        sa.Column("version", sa.BigInteger(), nullable=False),
        sa.Column("word_count", sa.Integer(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["source_media_id", "source_generation"],
            ["reader_publications.media_id", "reader_publications.generation"],
            name="fk_media_parts_source_publication",
        ),
        sa.ForeignKeyConstraint(
            ["source_media_id", "start_fragment_idx"],
            ["fragments.media_id", "fragments.idx"],
            name="fk_media_parts_start_fragment",
        ),
        sa.ForeignKeyConstraint(
            ["source_media_id", "end_fragment_idx"],
            ["fragments.media_id", "fragments.idx"],
            name="fk_media_parts_end_fragment",
        ),
        sa.UniqueConstraint(
            "source_media_id",
            "source_generation",
            "start_fragment_idx",
            "start_offset",
            "end_fragment_idx",
            "end_offset",
            name="uq_media_parts_source_extent",
        ),
    )
    op.create_table(
        "media_part_candidates",
        sa.Column("id", sa.UUID(), primary_key=True),
        sa.Column("source_media_id", sa.UUID(), sa.ForeignKey("media.id"), nullable=False),
        sa.Column("source_generation", sa.BigInteger(), nullable=False),
        sa.Column("range_key", sa.Text(), nullable=False),
        sa.Column("start_fragment_idx", sa.Integer(), nullable=False),
        sa.Column("start_offset", sa.Integer(), nullable=False),
        sa.Column("end_fragment_idx", sa.Integer(), nullable=False),
        sa.Column("end_offset", sa.Integer(), nullable=False),
        sa.Column("finding", postgresql.JSONB()),
        sa.Column("user_decision", sa.Text()),
        sa.Column("part_id", sa.UUID(), sa.ForeignKey("media.id")),
        sa.Column("accepted_selection", postgresql.JSONB()),
        sa.Column("version", sa.BigInteger(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.UniqueConstraint(
            "source_media_id",
            "source_generation",
            "range_key",
            name="uq_media_part_candidates_extent",
        ),
        sa.UniqueConstraint("part_id", name="uq_media_part_candidates_part"),
    )
    for side in ("start", "end"):
        op.add_column(
            "epub_nav_locations",
            sa.Column(f"{side}_dom_path", postgresql.ARRAY(sa.BigInteger())),
        )
        op.add_column("epub_nav_locations", sa.Column(f"{side}_dom_edge", sa.Text()))
    op.add_column("content_index_states", sa.Column("section_witness_key", sa.Text()))
    op.add_column("content_index_states", sa.Column("section_bounds_key", sa.Text()))


def downgrade() -> None:
    if op.get_bind().scalar(sa.text("SELECT EXISTS (SELECT 1 FROM media_parts)")):
        raise RuntimeError("cannot remove contained works while pieces exist")
    if op.get_bind().scalar(
        sa.text(
            "SELECT EXISTS (SELECT 1 FROM media_part_candidates) OR EXISTS (SELECT 1 FROM background_jobs WHERE kind='discover_document_parts')"
        )
    ):
        raise RuntimeError(
            "cannot downgrade contained-work decisions or discovery history; restore the paired backup"
        )
    op.execute("""UPDATE background_jobs SET payload=payload-'request'-'section_witness_key'-'section_bounds_key'
        WHERE kind='media_content_reindex_job'""")
    op.execute(
        "UPDATE message_retrievals SET context_ref=context_ref-'passage_target', result_ref=result_ref #- '{context_ref,passage_target}'"
    )
    op.execute(
        "UPDATE background_jobs SET payload=payload-'part_definition_version' WHERE kind='enrich_metadata' AND payload->>'purpose'='bibliography'"
    )
    op.drop_table("media_part_candidates")
    op.drop_table("media_parts")
    op.drop_table("media_part_sets")
    for column in ("section_bounds_key", "section_witness_key"):
        op.drop_column("content_index_states", column)
    for side in ("start", "end"):
        op.drop_column("epub_nav_locations", f"{side}_dom_edge")
        op.drop_column("epub_nav_locations", f"{side}_dom_path")
    op.drop_constraint(
        "uq_reader_publications_media_generation", "reader_publications", type_="unique"
    )
