"""resource provenance graph: one flat edge table replaces the per-feature link stores

Revision ID: 0145
Revises: 0144
Create Date: 2026-06-09

Hard cutover (resource-provenance-graph §13). Creates the graph owner's tables:

- ``resource_edges`` — one directed connection per row: stance ``kind``, writer
  ``origin``, polymorphic ``scheme``+``id`` endpoints (no endpoint FKs; cleanup
  is the graph service's job), and one optional citation pair
  (``ordinal``+``snapshot``)
- ``resource_external_snapshots`` — stable targets for public web citations, so
  they never become JSON-only pseudo-resources (D7)
- ``oracle_reading_folios`` — oracle-owned generated folio content (phase,
  attribution, marginalia), referencing its citation edge (D8)

Alters ``message_retrievals`` (chat telemetry stays chat-owned, §8.4): drops the
citation-numbering job (``citation_ordinal``) and adds ``cited_edge_id`` — a
one-way provenance pointer with deliberately NO foreign key, because edge and
telemetry rows are cleaned up by different owners (D6).

Drops the four superseded link/reference/citation stores (§13.2):
``conversation_references``, ``object_links``, ``oracle_reading_passages``,
``library_intelligence_citations``. None has incoming FKs; their indexes drop
with the tables. Greenfield: no data copy, no backfill, no compatibility
views/triggers (§13.4).

Deviation from §13.1: ``oracle_corpus_passages`` is NOT created here. A live
table with that name already exists (0072) — seeded, embedding-backed, and read
by oracle retrieval — and its uuid ``id`` already serves as the stable
``oracle_corpus_passage:<id>`` citation target §8.5 wants. Creating the §8.5
shape would collide with it, and dropping the live corpus would destroy oracle
retrieval. It stays untouched.

Irreversible.
"""

from collections.abc import Sequence

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0147"
down_revision: str | Sequence[str] | None = "0146"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # (A) The one edge table. Endpoints are polymorphic (scheme + id), so
    # source_id/target_id deliberately carry no FKs (database.md: explicit
    # cleanup, no cascades).
    op.execute("""
        CREATE TABLE resource_edges (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id uuid NOT NULL REFERENCES users(id),
            kind text NOT NULL,
            origin text NOT NULL,
            source_scheme text NOT NULL,
            source_id uuid NOT NULL,
            target_scheme text NOT NULL,
            target_id uuid NOT NULL,
            ordinal integer NULL,
            snapshot jsonb NULL,
            created_at timestamptz NOT NULL DEFAULT now(),
            CONSTRAINT ck_resource_edges_kind CHECK (
                kind IN ('context', 'supports', 'contradicts')
            ),
            CONSTRAINT ck_resource_edges_origin CHECK (
                origin IN ('user', 'citation', 'system', 'note_body', 'highlight_note')
            ),
            CONSTRAINT ck_resource_edges_source_scheme CHECK (
                source_scheme IN (
                    'media', 'library', 'evidence_span', 'content_chunk',
                    'highlight', 'page', 'note_block', 'fragment',
                    'conversation', 'message', 'oracle_reading',
                    'oracle_corpus_passage', 'library_intelligence_artifact',
                    'external_snapshot', 'contributor', 'podcast'
                )
            ),
            CONSTRAINT ck_resource_edges_target_scheme CHECK (
                target_scheme IN (
                    'media', 'library', 'evidence_span', 'content_chunk',
                    'highlight', 'page', 'note_block', 'fragment',
                    'conversation', 'message', 'oracle_reading',
                    'oracle_corpus_passage', 'library_intelligence_artifact',
                    'external_snapshot', 'contributor', 'podcast'
                )
            ),
            CONSTRAINT ck_resource_edges_ordinal_positive CHECK (ordinal >= 1),
            CONSTRAINT ck_resource_edges_citation_has_snapshot CHECK (
                ordinal IS NULL OR snapshot IS NOT NULL
            ),
            CONSTRAINT ck_resource_edges_snapshot_object CHECK (
                snapshot IS NULL OR jsonb_typeof(snapshot) = 'object'
            )
        )
    """)
    # Dense citation numbering per output (an ordinal marks a citation, D5).
    op.execute("""
        CREATE UNIQUE INDEX uq_resource_edges_citation_ordinal
        ON resource_edges (source_scheme, source_id, ordinal)
        WHERE ordinal IS NOT NULL
    """)
    # Context/link dedup (directed; undirected user dedup is the service's
    # both-direction check, as today).
    op.execute("""
        CREATE UNIQUE INDEX uq_resource_edges_context_pair
        ON resource_edges (source_scheme, source_id, target_scheme, target_id)
        WHERE ordinal IS NULL
    """)
    # The two halves of every connections/backlink/reverse-lookup query.
    op.execute("""
        CREATE INDEX ix_resource_edges_user_source
        ON resource_edges (user_id, source_scheme, source_id, created_at, id)
    """)
    op.execute("""
        CREATE INDEX ix_resource_edges_user_target
        ON resource_edges (user_id, target_scheme, target_id, created_at, id)
    """)

    # (B) Stable targets for public web results (D7).
    op.execute("""
        CREATE TABLE resource_external_snapshots (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id uuid NOT NULL REFERENCES users(id),
            provider text NOT NULL,
            url text NOT NULL,
            title text NOT NULL,
            snippet text NOT NULL,
            source_snapshot jsonb NOT NULL,
            created_at timestamptz NOT NULL DEFAULT now(),
            CONSTRAINT ck_resource_external_snapshots_source_object CHECK (
                jsonb_typeof(source_snapshot) = 'object'
            )
        )
    """)

    # (C) Oracle-owned generated folio content, referencing its citation edge
    # (D8). Snippet and deep link live on the edge snapshot, not here.
    op.execute("""
        CREATE TABLE oracle_reading_folios (
            reading_id uuid NOT NULL REFERENCES oracle_readings(id),
            phase text NOT NULL,
            edge_id uuid NOT NULL REFERENCES resource_edges(id),
            source_kind text NOT NULL,
            locator_label text NOT NULL,
            attribution_text text NOT NULL,
            marginalia_text text NOT NULL,
            created_at timestamptz NOT NULL DEFAULT now(),
            CONSTRAINT ck_oracle_reading_folios_phase CHECK (
                phase IN ('descent', 'ordeal', 'ascent')
            ),
            CONSTRAINT ck_oracle_reading_folios_source_kind CHECK (
                source_kind IN ('user_media', 'public_domain')
            ),
            PRIMARY KEY (reading_id, phase)
        )
    """)

    # (D) Chat telemetry keeps its owner and loses only its citation-numbering
    # job (§8.4). cited_edge_id is a one-way provenance pointer: NO FK (D6).
    op.execute(
        "ALTER TABLE message_retrievals "
        "DROP CONSTRAINT ck_message_retrievals_citation_ordinal_positive"
    )
    op.execute("ALTER TABLE message_retrievals DROP COLUMN citation_ordinal")
    op.execute("ALTER TABLE message_retrievals ADD COLUMN cited_edge_id uuid NULL")

    # (E) Drop the superseded per-feature stores (§13.2). No incoming FKs.
    op.execute("DROP TABLE conversation_references")
    op.execute("DROP TABLE object_links")
    op.execute("DROP TABLE oracle_reading_passages")
    op.execute("DROP TABLE library_intelligence_citations")


def downgrade() -> None:
    raise NotImplementedError("Hard cutover: 0145 is not reversible")
