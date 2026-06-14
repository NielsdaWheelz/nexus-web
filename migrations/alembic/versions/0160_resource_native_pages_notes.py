"""Resource-native pages and notes hard cutover.

Revision ID: 0160
Revises: 0159
Create Date: 2026-06-13
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0160"
down_revision: str | Sequence[str] | None = "0159"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("""
        CREATE TABLE resource_versions (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id uuid NOT NULL REFERENCES users(id),
            resource_scheme text NOT NULL,
            resource_id uuid NOT NULL,
            lane text NOT NULL,
            version integer NOT NULL DEFAULT 1,
            content_hash text NULL,
            created_at timestamptz NOT NULL DEFAULT now(),
            updated_at timestamptz NOT NULL DEFAULT now(),
            CONSTRAINT ck_resource_versions_resource_scheme CHECK (
                resource_scheme IN (
                    'media', 'library', 'evidence_span', 'content_chunk',
                    'highlight', 'page', 'note_block', 'fragment',
                    'conversation', 'message', 'oracle_reading',
                    'oracle_corpus_passage', 'library_intelligence_artifact',
                    'library_intelligence_revision',
                    'external_snapshot', 'contributor', 'podcast', 'tag'
                )
            ),
            CONSTRAINT ck_resource_versions_lane CHECK (
                lane IN ('title', 'body', 'outgoing_edges')
            ),
            CONSTRAINT ck_resource_versions_version_positive CHECK (version >= 1),
            CONSTRAINT ck_resource_versions_content_hash_length CHECK (
                content_hash IS NULL OR char_length(content_hash) = 64
            ),
            CONSTRAINT uix_resource_versions_lane UNIQUE (
                user_id, resource_scheme, resource_id, lane
            )
        )
    """)
    op.execute("""
        CREATE TABLE resource_mutations (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id uuid NOT NULL REFERENCES users(id),
            mutation_scope text NOT NULL,
            client_mutation_id text NOT NULL,
            request_hash text NOT NULL,
            changed_lanes jsonb NOT NULL,
            response_json jsonb NOT NULL,
            created_at timestamptz NOT NULL DEFAULT now(),
            CONSTRAINT ck_resource_mutations_scope_length CHECK (
                char_length(mutation_scope) BETWEEN 1 AND 300
            ),
            CONSTRAINT ck_resource_mutations_client_mutation_id_length CHECK (
                char_length(client_mutation_id) BETWEEN 1 AND 120
            ),
            CONSTRAINT ck_resource_mutations_request_hash_length CHECK (
                char_length(request_hash) = 64
            ),
            CONSTRAINT ck_resource_mutations_changed_lanes_object CHECK (
                jsonb_typeof(changed_lanes) = 'object'
            ),
            CONSTRAINT ck_resource_mutations_response_json_object CHECK (
                jsonb_typeof(response_json) = 'object'
            ),
            CONSTRAINT uix_resource_mutations_client_id UNIQUE (
                user_id, mutation_scope, client_mutation_id
            )
        )
    """)
    op.execute("""
        CREATE TABLE resource_view_states (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id uuid NOT NULL REFERENCES users(id),
            surface_scheme text NOT NULL,
            surface_id uuid NOT NULL,
            edge_id uuid NULL REFERENCES resource_edges(id),
            target_scheme text NULL,
            target_id uuid NULL,
            state jsonb NOT NULL,
            created_at timestamptz NOT NULL DEFAULT now(),
            updated_at timestamptz NOT NULL DEFAULT now(),
            CONSTRAINT ck_resource_view_states_surface_scheme CHECK (
                surface_scheme IN (
                    'media', 'library', 'evidence_span', 'content_chunk',
                    'highlight', 'page', 'note_block', 'fragment',
                    'conversation', 'message', 'oracle_reading',
                    'oracle_corpus_passage', 'library_intelligence_artifact',
                    'library_intelligence_revision',
                    'external_snapshot', 'contributor', 'podcast', 'tag'
                )
            ),
            CONSTRAINT ck_resource_view_states_target_scheme CHECK (
                target_scheme IS NULL OR target_scheme IN (
                    'media', 'library', 'evidence_span', 'content_chunk',
                    'highlight', 'page', 'note_block', 'fragment',
                    'conversation', 'message', 'oracle_reading',
                    'oracle_corpus_passage', 'library_intelligence_artifact',
                    'library_intelligence_revision',
                    'external_snapshot', 'contributor', 'podcast', 'tag'
                )
            ),
            CONSTRAINT ck_resource_view_states_target_pair CHECK (
                (target_scheme IS NULL) = (target_id IS NULL)
            ),
            CONSTRAINT ck_resource_view_states_state_object CHECK (
                jsonb_typeof(state) = 'object'
            )
        )
    """)
    op.create_index(
        "uix_resource_view_states_edge_occurrence",
        "resource_view_states",
        ["user_id", "surface_scheme", "surface_id", "edge_id"],
        unique=True,
        postgresql_where=sa.text("edge_id IS NOT NULL"),
    )

    op.execute("""
        INSERT INTO resource_versions (
            user_id, resource_scheme, resource_id, lane, version, updated_at
        )
        SELECT user_id, 'page', id, 'title', document_version, updated_at
        FROM pages
    """)
    op.execute("""
        INSERT INTO resource_versions (
            user_id, resource_scheme, resource_id, lane, version, updated_at
        )
        SELECT user_id, 'page', id, 'outgoing_edges', document_version, updated_at
        FROM pages
    """)
    op.execute("""
        INSERT INTO resource_versions (
            user_id, resource_scheme, resource_id, lane, version, updated_at
        )
        SELECT user_id, 'note_block', id, 'body', 1, updated_at
        FROM note_blocks
    """)
    op.execute("""
        INSERT INTO resource_versions (
            user_id, resource_scheme, resource_id, lane, version, updated_at
        )
        SELECT user_id, 'note_block', id, 'outgoing_edges', 1, updated_at
        FROM note_blocks
    """)
    op.execute("ALTER TABLE content_blocks DROP CONSTRAINT ck_content_blocks_owner_kind")
    op.execute("ALTER TABLE evidence_spans DROP CONSTRAINT ck_evidence_spans_owner_kind")
    op.execute("ALTER TABLE content_chunks DROP CONSTRAINT ck_content_chunks_owner_kind")
    op.execute("ALTER TABLE content_index_states DROP CONSTRAINT ck_content_index_states_owner_kind")
    op.execute("""
        WITH page_chunks AS (
            SELECT id FROM content_chunks WHERE owner_kind = 'page'
        ),
        page_spans AS (
            SELECT id FROM evidence_spans WHERE owner_kind = 'page'
        )
        DELETE FROM resource_edges edge
        WHERE edge.ordinal IS NULL
          AND (
            (edge.source_scheme = 'content_chunk' AND edge.source_id IN (SELECT id FROM page_chunks))
            OR (edge.target_scheme = 'content_chunk' AND edge.target_id IN (SELECT id FROM page_chunks))
            OR (edge.source_scheme = 'evidence_span' AND edge.source_id IN (SELECT id FROM page_spans))
            OR (edge.target_scheme = 'evidence_span' AND edge.target_id IN (SELECT id FROM page_spans))
          )
    """)
    op.execute("""
        DELETE FROM content_embeddings
        WHERE chunk_id IN (SELECT id FROM content_chunks WHERE owner_kind = 'page')
    """)
    op.execute("""
        DELETE FROM content_chunk_parts
        WHERE chunk_id IN (SELECT id FROM content_chunks WHERE owner_kind = 'page')
    """)
    op.execute("DELETE FROM content_chunks WHERE owner_kind = 'page'")
    op.execute("""
        UPDATE message_retrievals mr
        SET evidence_span_id = NULL
        FROM evidence_spans es
        WHERE mr.evidence_span_id = es.id
          AND es.owner_kind = 'page'
    """)
    op.execute("DELETE FROM evidence_spans WHERE owner_kind = 'page'")
    op.execute("DELETE FROM content_blocks WHERE owner_kind = 'page'")
    op.execute("DELETE FROM content_index_states WHERE owner_kind = 'page'")
    op.execute("""
        ALTER TABLE content_blocks ADD CONSTRAINT ck_content_blocks_owner_kind
        CHECK (owner_kind IN ('media', 'note_block'))
    """)
    op.execute("""
        ALTER TABLE evidence_spans ADD CONSTRAINT ck_evidence_spans_owner_kind
        CHECK (owner_kind IN ('media', 'note_block'))
    """)
    op.execute("""
        ALTER TABLE content_chunks ADD CONSTRAINT ck_content_chunks_owner_kind
        CHECK (owner_kind IN ('media', 'note_block'))
    """)
    op.execute("""
        ALTER TABLE content_index_states ADD CONSTRAINT ck_content_index_states_owner_kind
        CHECK (owner_kind IN ('media', 'note_block'))
    """)
    op.execute("DELETE FROM background_jobs WHERE kind = 'page_reindex_job'")
    op.drop_index("uq_page_reindex_job_inflight", table_name="background_jobs")
    op.create_index(
        "uq_note_reindex_job_inflight",
        "background_jobs",
        [sa.text("(payload->>'note_block_id')")],
        unique=True,
        postgresql_where=sa.text(
            "kind = 'note_reindex_job' AND status NOT IN ('succeeded', 'dead')"
        ),
    )
    op.execute("""
        INSERT INTO background_jobs (kind, payload, max_attempts)
        SELECT
            'note_reindex_job',
            jsonb_build_object(
                'note_block_id', id::text,
                'reason', 'resource_native_note_index'
            ),
            3
        FROM note_blocks
        WHERE NULLIF(trim(body_text), '') IS NOT NULL
    """)

    op.execute("""
        INSERT INTO resource_view_states (
            user_id, surface_scheme, surface_id, edge_id, target_scheme, target_id, state
        )
        SELECT
            state.user_id,
            state.context_source_scheme,
            state.context_source_id,
            edge.id,
            'note_block',
            state.target_block_id,
            jsonb_build_object('collapsed', state.collapsed)
        FROM note_view_states state
        LEFT JOIN resource_edges edge
          ON edge.user_id = state.user_id
         AND edge.origin = 'note_containment'
         AND edge.source_scheme = state.context_source_scheme
         AND edge.source_id = state.context_source_id
         AND edge.target_scheme = 'note_block'
         AND edge.target_id = state.target_block_id
    """)

    op.drop_table("page_document_mutations")
    op.drop_table("note_view_states")

    op.execute("""
        DELETE FROM resource_edges user_edge
        USING resource_edges containment
        WHERE user_edge.origin = 'user'
          AND containment.origin = 'note_containment'
          AND user_edge.ordinal IS NULL
          AND containment.ordinal IS NULL
          AND user_edge.user_id = containment.user_id
          AND user_edge.source_scheme = containment.source_scheme
          AND user_edge.source_id = containment.source_id
          AND user_edge.target_scheme = containment.target_scheme
          AND user_edge.target_id = containment.target_id
          AND user_edge.id <> containment.id
    """)

    op.execute("ALTER TABLE resource_edges DROP CONSTRAINT ck_resource_edges_origin")
    op.execute(
        "ALTER TABLE resource_edges DROP CONSTRAINT ck_resource_edges_source_order_key_shape"
    )
    op.execute("ALTER TABLE resource_edges DROP CONSTRAINT ck_resource_edges_note_body_shape")
    op.execute(
        "ALTER TABLE resource_edges DROP CONSTRAINT ck_resource_edges_note_containment_shape"
    )
    op.drop_index("uq_resource_edges_containment_source_order", table_name="resource_edges")
    op.drop_index("uq_resource_edges_containment_target_once", table_name="resource_edges")

    op.execute("UPDATE resource_edges SET origin = 'user' WHERE origin = 'note_containment'")

    op.execute("""
        ALTER TABLE resource_edges ADD CONSTRAINT ck_resource_edges_origin CHECK (
            origin IN ('user', 'citation', 'system', 'note_body', 'highlight_note', 'synapse')
        )
    """)
    op.execute("""
        ALTER TABLE resource_edges ADD CONSTRAINT ck_resource_edges_source_order_key_shape CHECK (
            source_order_key IS NULL
            OR (
                kind = 'context'
                AND origin = 'user'
                AND ordinal IS NULL
                AND snapshot IS NULL
            )
            OR (
                kind = 'context'
                AND origin IN ('citation', 'system')
                AND source_scheme = 'conversation'
                AND ordinal IS NULL
                AND snapshot IS NULL
            )
        )
    """)
    op.execute("""
        ALTER TABLE resource_edges ADD CONSTRAINT ck_resource_edges_note_body_shape CHECK (
            origin != 'note_body'
            OR (
                kind = 'context'
                AND source_scheme = 'note_block'
                AND source_order_key IS NULL
                AND target_order_key IS NULL
                AND ordinal IS NULL
                AND snapshot IS NULL
            )
        )
    """)
    op.create_index(
        "uq_resource_edges_source_order",
        "resource_edges",
        ["user_id", "source_scheme", "source_id", "source_order_key"],
        unique=True,
        postgresql_where=sa.text("source_order_key IS NOT NULL"),
    )
    op.drop_index("ix_resource_edges_user_source", table_name="resource_edges")
    op.drop_index("ix_resource_edges_user_target", table_name="resource_edges")
    op.create_index(
        "ix_resource_edges_user_source",
        "resource_edges",
        ["user_id", "source_scheme", "source_id", "source_order_key", "id"],
    )
    op.create_index(
        "ix_resource_edges_user_target",
        "resource_edges",
        ["user_id", "target_scheme", "target_id", "created_at", "id"],
    )

    op.drop_constraint("ck_pages_document_version_positive", "pages", type_="check")
    op.drop_column("pages", "document_version")
    op.drop_column("pages", "description")

    op.drop_constraint("ck_note_blocks_kind", "note_blocks", type_="check")
    op.drop_column("note_blocks", "body_markdown")
    op.drop_column("note_blocks", "block_kind")


def downgrade() -> None:
    raise NotImplementedError("Hard cutover: 0160 is not reversible")
