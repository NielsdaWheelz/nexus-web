"""synapse resonance: agent origin + scan ledger owner + suppression memory

Revision ID: 0149
Revises: 0148
Create Date: 2026-06-10

The synapse resonance engine (synapse-resonance-engine §4) is the graph's first
agent co-author: a background scan that proposes stance-typed connections into
``resource_edges``. An agent is an origin, not a schema — so this migration adds
no connection store. Three additive changes:

- widen ``ck_resource_edges_origin`` with ``'synapse'`` (the engine's sole
  writer is ``services/synapse.py``, per the provenance graph's N9 extension
  point), keeping 0148's ``'note_containment'``
- carve ``'synapse'`` out of 0148's two snapshot CHECKs: a synapse edge is the
  only bare edge (no ordinal) that carries a ``snapshot`` — its rationale rides
  the snapshot ``excerpt`` (spec §8/§13.3). ``ck_resource_edges_snapshot_has_ordinal``
  and ``ck_resource_edges_snapshot_origin`` otherwise reject every synapse edge.
- widen ``ck_llm_calls_owner_kind`` with ``'synapse_scan'`` so scan calls are
  attributed in the ledger (``owner_id`` = the scanned source object)
- create ``synapse_suppressions`` — the dismissal memory, the only thing edges
  cannot hold: a negative assertion. One row per dismissed (source, target)
  pair per user; the miner checks both directions at read time (service-level
  undirectedness, the house pattern), so rows are stored as-dismissed.

Rebased onto 0148 (notes-pages object-graph cutover; spec §13): ``down_revision``
is ``"0148"``, the origin CHECK keeps ``'note_containment'``, and the two
snapshot CHECKs gain the ``origin = 'synapse'`` carve-out. The model twins live
in ``db/models.py``.

Additive; reversible. ``downgrade`` deletes synapse edges + ledger rows (they
would violate 0148's strict CHECKs), drops the table, and restores 0148's
narrowed CHECKs. 0148 itself is a hard cutover with no downgrade, so this
reverses exactly one step.
"""

from collections.abc import Sequence

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0149"
down_revision: str | Sequence[str] | None = "0148"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # (A) The agent origin. Postgres has no ALTER CONSTRAINT for CHECKs:
    # drop + recreate under the same name. Keeps 0148's 'note_containment'.
    op.execute("ALTER TABLE resource_edges DROP CONSTRAINT ck_resource_edges_origin")
    op.execute("""
        ALTER TABLE resource_edges ADD CONSTRAINT ck_resource_edges_origin CHECK (
            origin IN (
                'user', 'citation', 'system', 'note_body', 'highlight_note',
                'note_containment', 'synapse'
            )
        )
    """)

    # (A2) A synapse edge is the only bare edge (no ordinal) that carries a
    # snapshot — its rationale rides the snapshot 'excerpt' (spec §8). 0148's two
    # snapshot CHECKs (snapshot-implies-ordinal, snapshot-implies-citation-origin)
    # otherwise reject every synapse edge, so carve 'synapse' out of both.
    op.execute(
        "ALTER TABLE resource_edges DROP CONSTRAINT ck_resource_edges_snapshot_has_ordinal"
    )
    op.execute("""
        ALTER TABLE resource_edges ADD CONSTRAINT ck_resource_edges_snapshot_has_ordinal CHECK (
            snapshot IS NULL OR ordinal IS NOT NULL OR origin = 'synapse'
        )
    """)
    op.execute(
        "ALTER TABLE resource_edges DROP CONSTRAINT ck_resource_edges_snapshot_origin"
    )
    op.execute("""
        ALTER TABLE resource_edges ADD CONSTRAINT ck_resource_edges_snapshot_origin CHECK (
            snapshot IS NULL OR origin IN ('citation', 'synapse')
        )
    """)

    # (B) Scan calls join the polymorphic LLM ledger.
    op.execute("ALTER TABLE llm_calls DROP CONSTRAINT ck_llm_calls_owner_kind")
    op.execute("""
        ALTER TABLE llm_calls ADD CONSTRAINT ck_llm_calls_owner_kind CHECK (
            owner_kind IN (
                'chat_run', 'oracle_reading', 'li_revision',
                'media_summary', 'media_enrichment', 'synapse_scan'
            )
        )
    """)

    # (C) The dismissal memory. Endpoints are polymorphic refs like
    # resource_edges (no endpoint FKs; rows are permanent — harmless after
    # endpoint deletion at single-user scale). Scheme CHECKs admit the scannable
    # subset of the resource-graph schemes (the 16 as of 0147) — deliberately NOT
    # 0148's 17th scheme 'tag', since synapse never proposes a tag connection.
    op.execute("""
        CREATE TABLE synapse_suppressions (
            user_id uuid NOT NULL REFERENCES users(id),
            source_scheme text NOT NULL,
            source_id uuid NOT NULL,
            target_scheme text NOT NULL,
            target_id uuid NOT NULL,
            created_at timestamptz NOT NULL DEFAULT now(),
            CONSTRAINT ck_synapse_suppressions_source_scheme CHECK (
                source_scheme IN (
                    'media', 'library', 'evidence_span', 'content_chunk',
                    'highlight', 'page', 'note_block', 'fragment',
                    'conversation', 'message', 'oracle_reading',
                    'oracle_corpus_passage', 'library_intelligence_artifact',
                    'external_snapshot', 'contributor', 'podcast'
                )
            ),
            CONSTRAINT ck_synapse_suppressions_target_scheme CHECK (
                target_scheme IN (
                    'media', 'library', 'evidence_span', 'content_chunk',
                    'highlight', 'page', 'note_block', 'fragment',
                    'conversation', 'message', 'oracle_reading',
                    'oracle_corpus_passage', 'library_intelligence_artifact',
                    'external_snapshot', 'contributor', 'podcast'
                )
            ),
            PRIMARY KEY (user_id, source_scheme, source_id, target_scheme, target_id)
        )
    """)
    # Reverse-direction filtering (the PK covers the forward direction).
    op.execute("""
        CREATE INDEX ix_synapse_suppressions_user_target
        ON synapse_suppressions (user_id, target_scheme, target_id)
    """)


def downgrade() -> None:
    # Synapse edges + scan ledger rows carry vocabulary the narrowed 0148 CHECKs
    # forbid (origin='synapse', owner_kind='synapse_scan', and bare snapshots);
    # remove them before restoring the constraints, else the recreate aborts.
    op.execute("DELETE FROM resource_edges WHERE origin = 'synapse'")
    op.execute("DELETE FROM llm_calls WHERE owner_kind = 'synapse_scan'")

    op.execute("DROP TABLE synapse_suppressions")

    op.execute("ALTER TABLE llm_calls DROP CONSTRAINT ck_llm_calls_owner_kind")
    op.execute("""
        ALTER TABLE llm_calls ADD CONSTRAINT ck_llm_calls_owner_kind CHECK (
            owner_kind IN (
                'chat_run', 'oracle_reading', 'li_revision',
                'media_summary', 'media_enrichment'
            )
        )
    """)

    # Restore 0148's strict snapshot CHECKs (synapse was their only carve-out).
    op.execute(
        "ALTER TABLE resource_edges DROP CONSTRAINT ck_resource_edges_snapshot_has_ordinal"
    )
    op.execute("""
        ALTER TABLE resource_edges ADD CONSTRAINT ck_resource_edges_snapshot_has_ordinal CHECK (
            snapshot IS NULL OR ordinal IS NOT NULL
        )
    """)
    op.execute(
        "ALTER TABLE resource_edges DROP CONSTRAINT ck_resource_edges_snapshot_origin"
    )
    op.execute("""
        ALTER TABLE resource_edges ADD CONSTRAINT ck_resource_edges_snapshot_origin CHECK (
            snapshot IS NULL OR origin = 'citation'
        )
    """)

    # Restore 0148's origin vocabulary (keeps 'note_containment', drops 'synapse').
    op.execute("ALTER TABLE resource_edges DROP CONSTRAINT ck_resource_edges_origin")
    op.execute("""
        ALTER TABLE resource_edges ADD CONSTRAINT ck_resource_edges_origin CHECK (
            origin IN (
                'user', 'citation', 'system', 'note_body', 'highlight_note',
                'note_containment'
            )
        )
    """)
