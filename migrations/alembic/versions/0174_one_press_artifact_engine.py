"""One Press: generalize the library-intelligence press into a scope-generic
artifact engine keyed by ``(subject_scheme, subject_id, kind)``.

Data-preserving: every step is an ``UPDATE``/``ALTER … RENAME``, never a drop of
a populated table. Row-count assertions guard the blast radius (R-1).

- ``library_intelligence_artifacts``          -> ``artifacts`` (subject columns)
- ``library_intelligence_artifact_revisions`` -> ``artifact_revisions``
- ``library_intelligence_revision_events``     -> ``artifact_revision_events``
- schemes ``library_intelligence_artifact`` -> ``artifact`` and
  ``library_intelligence_revision`` -> ``artifact_revision`` everywhere stored,
  with every enumerating CHECK rebuilt.
- ``llm_calls.owner_kind`` ``li_revision`` -> ``artifact_revision``; the CHECK is
  re-added with the full union INCLUDING ``dawn_write`` so it is order-independent
  vs the dawn-write migration (§5.3/§10, R-2).

Revision ID: 0174
Revises: 0173
Create Date: 2026-07-08
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0174"
down_revision: str | Sequence[str] | None = "0173"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# Full resource-scheme enumeration shared by resource_versions / resource_view_states
# / resource_edges (source+target). The only delta from history is the two renamed
# members; every other scheme is byte-identical.
_FULL_SCHEMES = (
    "'media', 'library', 'evidence_span', 'content_chunk', "
    "'highlight', 'page', 'note_block', 'fragment', "
    "'conversation', 'message', 'oracle_reading', "
    "'oracle_passage_anchor', 'artifact', 'artifact_revision', "
    "'external_snapshot', 'contributor', 'podcast', 'reader_apparatus_item'"
)
# synapse_suppressions omits reader_apparatus_item and the artifact_revision grain.
_SYNAPSE_SCHEMES = (
    "'media', 'library', 'evidence_span', 'content_chunk', "
    "'highlight', 'page', 'note_block', 'fragment', "
    "'conversation', 'message', 'oracle_reading', "
    "'oracle_passage_anchor', 'artifact', "
    "'external_snapshot', 'contributor', 'podcast'"
)
# Reverse forms for downgrade.
_FULL_SCHEMES_OLD = (
    "'media', 'library', 'evidence_span', 'content_chunk', "
    "'highlight', 'page', 'note_block', 'fragment', "
    "'conversation', 'message', 'oracle_reading', "
    "'oracle_passage_anchor', 'library_intelligence_artifact', "
    "'library_intelligence_revision', "
    "'external_snapshot', 'contributor', 'podcast', 'reader_apparatus_item'"
)
_SYNAPSE_SCHEMES_OLD = (
    "'media', 'library', 'evidence_span', 'content_chunk', "
    "'highlight', 'page', 'note_block', 'fragment', "
    "'conversation', 'message', 'oracle_reading', "
    "'oracle_passage_anchor', 'library_intelligence_artifact', "
    "'external_snapshot', 'contributor', 'podcast'"
)


def _count(table: str) -> int:
    return int(op.get_bind().exec_driver_sql(f"SELECT count(*) FROM {table}").scalar_one())


def upgrade() -> None:
    bind = op.get_bind()

    # ---- 1. capture pre-rename row counts (R-1) ----
    artifacts_n = _count("library_intelligence_artifacts")
    revisions_n = _count("library_intelligence_artifact_revisions")
    events_n = _count("library_intelligence_revision_events")

    # ---- 2. table renames ----
    op.execute("ALTER TABLE library_intelligence_artifacts RENAME TO artifacts")
    op.execute("ALTER TABLE library_intelligence_artifact_revisions RENAME TO artifact_revisions")
    op.execute("ALTER TABLE library_intelligence_revision_events RENAME TO artifact_revision_events")

    assert _count("artifacts") == artifacts_n, "artifacts row count changed on rename"
    assert _count("artifact_revisions") == revisions_n, "artifact_revisions row count changed"
    assert _count("artifact_revision_events") == events_n, "artifact_revision_events count changed"

    # ---- 3. artifacts: subject columns + backfill + constraints ----
    op.execute("ALTER TABLE artifacts ADD COLUMN subject_scheme text")
    op.execute("ALTER TABLE artifacts ADD COLUMN subject_id uuid")
    op.execute("ALTER TABLE artifacts ADD COLUMN kind text")
    updated = int(
        bind.exec_driver_sql(
            "UPDATE artifacts SET subject_scheme='library', subject_id=library_id, "
            "kind='library_dossier'"
        ).rowcount
    )
    assert updated == artifacts_n, f"backfill touched {updated} of {artifacts_n} artifacts"
    op.execute("ALTER TABLE artifacts ALTER COLUMN subject_scheme SET NOT NULL")
    op.execute("ALTER TABLE artifacts ALTER COLUMN subject_id SET NOT NULL")
    op.execute("ALTER TABLE artifacts ALTER COLUMN kind SET NOT NULL")

    op.execute("ALTER TABLE artifacts DROP CONSTRAINT uq_library_intelligence_artifacts_library")
    op.execute(
        "ALTER TABLE artifacts ADD CONSTRAINT uq_artifacts_subject_kind "
        "UNIQUE (subject_scheme, subject_id, kind)"
    )
    op.execute(
        "ALTER TABLE artifacts ADD CONSTRAINT ck_artifacts_kind "
        "CHECK (kind IN ('library_dossier', 'conversation_distillate'))"
    )
    op.execute(
        "ALTER TABLE artifacts ADD CONSTRAINT ck_artifacts_subject_scheme "
        "CHECK (subject_scheme IN ('library', 'conversation'))"
    )
    # library_id's FK to libraries.id dies with the column; subject_id is FK-less (D-2).
    op.execute("ALTER TABLE artifacts DROP COLUMN library_id")
    op.execute(
        "ALTER TABLE artifacts RENAME CONSTRAINT fk_li_artifacts_current_revision "
        "TO fk_artifacts_current_revision"
    )

    # ---- 4. artifact_revisions: rename constraints/indexes (no data change) ----
    op.execute(
        "ALTER TABLE artifact_revisions RENAME CONSTRAINT ck_li_revisions_status "
        "TO ck_artifact_revisions_status"
    )
    op.execute(
        "ALTER TABLE artifact_revisions RENAME CONSTRAINT ck_li_revisions_covered_targets_array "
        "TO ck_artifact_revisions_covered_targets_array"
    )
    op.execute(
        "ALTER INDEX ix_li_revisions_artifact_created "
        "RENAME TO ix_artifact_revisions_artifact_created"
    )
    # Partial unique INDEX (postgresql_where) — ALTER INDEX, never RENAME CONSTRAINT (D-11).
    op.execute(
        "ALTER INDEX uq_li_revisions_artifact_idempotency_key "
        "RENAME TO uq_artifact_revisions_idempotency_key"
    )

    # ---- 5. artifact_revision_events: rename constraints ----
    op.execute(
        "ALTER TABLE artifact_revision_events RENAME CONSTRAINT ck_li_revision_events_seq_positive "
        "TO ck_artifact_revision_events_seq_positive"
    )
    op.execute(
        "ALTER TABLE artifact_revision_events RENAME CONSTRAINT ck_li_revision_events_type "
        "TO ck_artifact_revision_events_type"
    )
    op.execute(
        "ALTER TABLE artifact_revision_events RENAME CONSTRAINT uq_li_revision_events_seq "
        "TO uq_artifact_revision_events_seq"
    )

    # ---- 6. stored scheme renames ----
    _rename_schemes(
        "library_intelligence_revision", "artifact_revision", "library_intelligence_artifact",
        "artifact",
    )

    # ---- 7. CHECK rebuilds (values change; names unchanged) ----
    _rebuild_scheme_checks(_FULL_SCHEMES, _SYNAPSE_SCHEMES, citation_source="artifact_revision")

    # ---- 8. owner_kind rename + CHECK (full union incl. dawn_write, R-2/§10) ----
    op.execute("UPDATE llm_calls SET owner_kind='artifact_revision' WHERE owner_kind='li_revision'")
    op.execute("ALTER TABLE llm_calls DROP CONSTRAINT IF EXISTS ck_llm_calls_owner_kind")
    op.execute(
        "ALTER TABLE llm_calls ADD CONSTRAINT ck_llm_calls_owner_kind CHECK ("
        "owner_kind IN ('chat_run', 'oracle_reading', 'artifact_revision', "
        "'media_summary', 'media_enrichment', 'synapse_scan', 'dawn_write'))"
    )


def downgrade() -> None:
    bind = op.get_bind()

    # Reverse owner_kind.
    op.execute("UPDATE llm_calls SET owner_kind='li_revision' WHERE owner_kind='artifact_revision'")
    op.execute("ALTER TABLE llm_calls DROP CONSTRAINT IF EXISTS ck_llm_calls_owner_kind")
    op.execute(
        "ALTER TABLE llm_calls ADD CONSTRAINT ck_llm_calls_owner_kind CHECK ("
        "owner_kind IN ('chat_run', 'oracle_reading', 'li_revision', "
        "'media_summary', 'media_enrichment', 'synapse_scan', 'dawn_write'))"
    )

    # Drop distillate artifacts (no home under the library-only schema).
    op.execute(
        "DELETE FROM resource_edges WHERE (source_scheme='artifact_revision' AND source_id IN "
        "(SELECT id FROM artifact_revisions WHERE artifact_id IN "
        "(SELECT id FROM artifacts WHERE kind='conversation_distillate')))"
    )
    op.execute(
        "DELETE FROM artifact_revision_events WHERE revision_id IN "
        "(SELECT r.id FROM artifact_revisions r JOIN artifacts a ON a.id=r.artifact_id "
        "WHERE a.kind='conversation_distillate')"
    )
    op.execute(
        "UPDATE artifacts SET current_revision_id=NULL WHERE kind='conversation_distillate'"
    )
    op.execute(
        "DELETE FROM artifact_revisions WHERE artifact_id IN "
        "(SELECT id FROM artifacts WHERE kind='conversation_distillate')"
    )
    op.execute("DELETE FROM artifacts WHERE kind='conversation_distillate'")

    # Reverse stored scheme renames FIRST: existing rows must carry the OLD scheme
    # names before the CHECKs (which enumerate only the old names) are re-added.
    # ADD CONSTRAINT validates existing data, so rebuilding the checks while rows
    # still hold 'artifact'/'artifact_revision' would reject the rollback on any
    # database that has generated a dossier/distillate.
    _rename_schemes(
        "artifact_revision", "library_intelligence_revision", "artifact",
        "library_intelligence_artifact",
    )
    # Reverse CHECK rebuilds.
    _rebuild_scheme_checks(
        _FULL_SCHEMES_OLD, _SYNAPSE_SCHEMES_OLD, citation_source="library_intelligence_revision"
    )

    # Reverse event/revision constraint renames.
    op.execute(
        "ALTER TABLE artifact_revision_events RENAME CONSTRAINT uq_artifact_revision_events_seq "
        "TO uq_li_revision_events_seq"
    )
    op.execute(
        "ALTER TABLE artifact_revision_events RENAME CONSTRAINT ck_artifact_revision_events_type "
        "TO ck_li_revision_events_type"
    )
    op.execute(
        "ALTER TABLE artifact_revision_events "
        "RENAME CONSTRAINT ck_artifact_revision_events_seq_positive "
        "TO ck_li_revision_events_seq_positive"
    )
    op.execute(
        "ALTER INDEX uq_artifact_revisions_idempotency_key "
        "RENAME TO uq_li_revisions_artifact_idempotency_key"
    )
    op.execute(
        "ALTER INDEX ix_artifact_revisions_artifact_created "
        "RENAME TO ix_li_revisions_artifact_created"
    )
    op.execute(
        "ALTER TABLE artifact_revisions RENAME CONSTRAINT ck_artifact_revisions_covered_targets_array "
        "TO ck_li_revisions_covered_targets_array"
    )
    op.execute(
        "ALTER TABLE artifact_revisions RENAME CONSTRAINT ck_artifact_revisions_status "
        "TO ck_li_revisions_status"
    )

    # Reverse artifacts columns/constraints.
    op.execute(
        "ALTER TABLE artifacts RENAME CONSTRAINT fk_artifacts_current_revision "
        "TO fk_li_artifacts_current_revision"
    )
    op.execute("ALTER TABLE artifacts ADD COLUMN library_id uuid")
    bind.exec_driver_sql(
        "UPDATE artifacts SET library_id=subject_id WHERE subject_scheme='library'"
    )
    op.execute("ALTER TABLE artifacts ALTER COLUMN library_id SET NOT NULL")
    op.execute(
        "ALTER TABLE artifacts ADD CONSTRAINT library_intelligence_artifacts_library_id_fkey "
        "FOREIGN KEY (library_id) REFERENCES libraries(id)"
    )
    op.execute("ALTER TABLE artifacts DROP CONSTRAINT ck_artifacts_subject_scheme")
    op.execute("ALTER TABLE artifacts DROP CONSTRAINT ck_artifacts_kind")
    op.execute("ALTER TABLE artifacts DROP CONSTRAINT uq_artifacts_subject_kind")
    op.execute(
        "ALTER TABLE artifacts ADD CONSTRAINT uq_library_intelligence_artifacts_library "
        "UNIQUE (library_id)"
    )
    op.execute("ALTER TABLE artifacts DROP COLUMN kind")
    op.execute("ALTER TABLE artifacts DROP COLUMN subject_id")
    op.execute("ALTER TABLE artifacts DROP COLUMN subject_scheme")

    # Reverse table renames.
    op.execute("ALTER TABLE artifact_revision_events RENAME TO library_intelligence_revision_events")
    op.execute("ALTER TABLE artifact_revisions RENAME TO library_intelligence_artifact_revisions")
    op.execute("ALTER TABLE artifacts RENAME TO library_intelligence_artifacts")


def _rename_schemes(rev_from: str, rev_to: str, art_from: str, art_to: str) -> None:
    """Rename the revision + artifact schemes everywhere they are stored."""
    for col in ("source_scheme", "target_scheme"):
        op.execute(
            f"UPDATE resource_edges SET {col}='{rev_to}' WHERE {col}='{rev_from}'"
        )
        op.execute(
            f"UPDATE resource_edges SET {col}='{art_to}' WHERE {col}='{art_from}'"
        )
    op.execute(
        f"UPDATE resource_versions SET resource_scheme='{rev_to}' WHERE resource_scheme='{rev_from}'"
    )
    op.execute(
        f"UPDATE resource_versions SET resource_scheme='{art_to}' WHERE resource_scheme='{art_from}'"
    )
    for col in ("surface_scheme", "target_scheme"):
        op.execute(
            f"UPDATE resource_view_states SET {col}='{rev_to}' WHERE {col}='{rev_from}'"
        )
        op.execute(
            f"UPDATE resource_view_states SET {col}='{art_to}' WHERE {col}='{art_from}'"
        )
    for col in ("subject_scheme", "requested_subject_scheme"):
        op.execute(
            f"UPDATE chat_run_turn_contexts SET {col}='{rev_to}' WHERE {col}='{rev_from}'"
        )
        op.execute(
            f"UPDATE chat_run_turn_contexts SET {col}='{art_to}' WHERE {col}='{art_from}'"
        )
    for col in ("source_scheme", "target_scheme"):
        op.execute(
            f"UPDATE synapse_suppressions SET {col}='{art_to}' WHERE {col}='{art_from}'"
        )


def _rebuild_scheme_checks(full: str, synapse: str, *, citation_source: str) -> None:
    """DROP + ADD each enumerating scheme CHECK with the given member set."""
    op.execute("ALTER TABLE resource_versions DROP CONSTRAINT ck_resource_versions_resource_scheme")
    op.execute(
        f"ALTER TABLE resource_versions ADD CONSTRAINT ck_resource_versions_resource_scheme "
        f"CHECK (resource_scheme IN ({full}))"
    )
    op.execute(
        "ALTER TABLE resource_view_states DROP CONSTRAINT ck_resource_view_states_surface_scheme"
    )
    op.execute(
        f"ALTER TABLE resource_view_states ADD CONSTRAINT ck_resource_view_states_surface_scheme "
        f"CHECK (surface_scheme IN ({full}))"
    )
    op.execute(
        "ALTER TABLE resource_view_states DROP CONSTRAINT ck_resource_view_states_target_scheme"
    )
    op.execute(
        f"ALTER TABLE resource_view_states ADD CONSTRAINT ck_resource_view_states_target_scheme "
        f"CHECK (target_scheme IS NULL OR target_scheme IN ({full}))"
    )
    op.execute("ALTER TABLE resource_edges DROP CONSTRAINT ck_resource_edges_source_scheme")
    op.execute(
        f"ALTER TABLE resource_edges ADD CONSTRAINT ck_resource_edges_source_scheme "
        f"CHECK (source_scheme IN ({full}))"
    )
    op.execute("ALTER TABLE resource_edges DROP CONSTRAINT ck_resource_edges_target_scheme")
    op.execute(
        f"ALTER TABLE resource_edges ADD CONSTRAINT ck_resource_edges_target_scheme "
        f"CHECK (target_scheme IN ({full}))"
    )
    op.execute("ALTER TABLE resource_edges DROP CONSTRAINT ck_resource_edges_citation_shape")
    op.execute(
        "ALTER TABLE resource_edges ADD CONSTRAINT ck_resource_edges_citation_shape CHECK ("
        "origin != 'citation' "
        "OR (ordinal IS NULL AND kind = 'context' AND source_scheme = 'conversation' "
        "AND snapshot IS NULL) "
        f"OR (ordinal IS NOT NULL AND source_scheme IN "
        f"('message', 'oracle_reading', '{citation_source}')))"
    )
    op.execute(
        "ALTER TABLE synapse_suppressions DROP CONSTRAINT ck_synapse_suppressions_source_scheme"
    )
    op.execute(
        f"ALTER TABLE synapse_suppressions ADD CONSTRAINT ck_synapse_suppressions_source_scheme "
        f"CHECK (source_scheme IN ({synapse}))"
    )
    op.execute(
        "ALTER TABLE synapse_suppressions DROP CONSTRAINT ck_synapse_suppressions_target_scheme"
    )
    op.execute(
        f"ALTER TABLE synapse_suppressions ADD CONSTRAINT ck_synapse_suppressions_target_scheme "
        f"CHECK (target_scheme IN ({synapse}))"
    )
    op.execute(
        "ALTER TABLE chat_run_turn_contexts "
        "DROP CONSTRAINT ck_chat_run_turn_contexts_requested_subject_scheme"
    )
    op.execute(
        "ALTER TABLE chat_run_turn_contexts "
        "ADD CONSTRAINT ck_chat_run_turn_contexts_requested_subject_scheme "
        f"CHECK (requested_subject_scheme IS NULL OR requested_subject_scheme IN ({full}))"
    )
    op.execute(
        "ALTER TABLE chat_run_turn_contexts "
        "DROP CONSTRAINT ck_chat_run_turn_contexts_subject_scheme"
    )
    op.execute(
        "ALTER TABLE chat_run_turn_contexts "
        "ADD CONSTRAINT ck_chat_run_turn_contexts_subject_scheme "
        f"CHECK (subject_scheme IS NULL OR subject_scheme IN ({full}))"
    )
