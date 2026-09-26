"""Delete retired chat and generation history; retain independent write provenance.

Revision ID: 0242
Revises: 0241

Deployment must stop writers and native processes, archive uncertain paid calls,
and verify a backup before this irreversible migration. Only the enumerated
chat, generation, and conversation-derived rows below are deleted.
"""

from collections.abc import Sequence
from urllib.parse import urlsplit
from uuid import UUID

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "0242"
down_revision: str | Sequence[str] | None = "0241"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _reset_workspace_chat_visits(state: object) -> dict[str, object] | None:
    if not isinstance(state, dict):
        raise ValueError("workspace session state is not an object")
    panes = state.get("primaryPanesById")
    secondaries = state.get("secondaryPanesById")
    if not isinstance(panes, dict) or not isinstance(secondaries, dict):
        raise ValueError("workspace session pane maps are invalid")

    def reset_visit(visit: object) -> bool:
        if not isinstance(visit, dict) or not isinstance(visit.get("href"), str):
            raise ValueError("workspace pane visit is invalid")
        parts = urlsplit(visit["href"])
        segments = parts.path.split("/")
        if len(segments) != 3 or segments[:2] != ["", "conversations"]:
            return False
        try:
            UUID(segments[2])
        except ValueError:
            return False
        visit["href"] = "/conversations/new"
        return True

    changed = False
    for pane in panes.values():
        if not isinstance(pane, dict):
            raise ValueError("workspace primary pane is invalid")
        current_changed = reset_visit(pane.get("currentVisit"))
        history = pane.get("history")
        if not isinstance(history, dict):
            raise ValueError("workspace pane history is invalid")
        for direction in ("back", "forward"):
            visits = history.get(direction)
            if not isinstance(visits, list):
                raise ValueError("workspace pane history direction is invalid")
            for visit in visits:
                changed = reset_visit(visit) or changed
        if current_changed:
            changed = True
            attached = pane.get("attachedSecondaryPaneId")
            if attached is not None:
                if not isinstance(attached, str) or attached not in secondaries:
                    raise ValueError("workspace pane attachment is invalid")
                pane["attachedSecondaryPaneId"] = None
                del secondaries[attached]
    return state if changed else None


def upgrade() -> None:
    # The old conversation ids disappear below. Rewrite only pre-cutover
    # persisted visits; a permanent restore rule would break new chats.
    connection = op.get_bind()
    for session_id, state in connection.execute(
        sa.text("SELECT id, state FROM workspace_sessions FOR UPDATE")
    ):
        try:
            rewritten = _reset_workspace_chat_visits(state)
        except ValueError as error:
            raise ValueError(
                f"workspace session {session_id} blocks model history cutover: {error}"
            ) from error
        if rewritten is not None:
            connection.execute(
                sa.text(
                    "UPDATE workspace_sessions SET state = :state WHERE id = :id"
                ).bindparams(sa.bindparam("state", type_=JSONB)),
                {"id": session_id, "state": rewritten},
            )

    # Domain authorship must survive removal of the generation position FK.
    op.add_column(
        "assistant_write_authorships",
        sa.Column("generation_id", sa.UUID(), nullable=True),
    )
    op.add_column(
        "assistant_write_authorships",
        sa.Column("generation_seq", sa.Integer(), nullable=True),
    )
    op.add_column(
        "assistant_write_authorships",
        sa.Column("tool_position", sa.Integer(), nullable=True),
    )
    op.add_column(
        "assistant_write_authorships",
        sa.Column("canonical_tool_id", sa.Text(), nullable=True),
    )
    op.add_column(
        "assistant_write_authorships",
        sa.Column("reverted_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.execute(
        """
        UPDATE assistant_write_authorships AS a
        SET generation_id = p.generation_id,
            generation_seq = c.generation_seq,
            tool_position = p.position,
            canonical_tool_id = p.canonical_tool_id,
            reverted_at = (
                SELECT m.reverted_at FROM message_tool_calls AS m
                WHERE m.tool_position_id = p.id AND m.record_kind = 'current_execution'
            )
        FROM llm_tool_positions AS p
        JOIN llm_calls AS c ON c.id = p.generation_id
        WHERE p.id = a.tool_position_id
        """
    )
    for column in (
        "generation_id",
        "generation_seq",
        "tool_position",
        "canonical_tool_id",
    ):
        op.alter_column("assistant_write_authorships", column, nullable=False)
    op.drop_constraint(
        "fk_assistant_write_authorships_tool_position",
        "assistant_write_authorships",
        type_="foreignkey",
    )

    # Freeze the exact set of removed polymorphic resources before deleting
    # their owners. No library, note, media, or other domain resource enters it.
    op.execute(
        """
        CREATE TEMP TABLE _latest_model_removed_resources ON COMMIT DROP AS
        SELECT 'conversation'::text AS scheme, id FROM conversations
        UNION ALL SELECT 'message', id FROM messages
        UNION ALL SELECT 'artifact', id FROM artifacts WHERE subject_scheme = 'conversation'
        UNION ALL
        SELECT 'artifact_revision', r.id
        FROM artifact_revisions AS r
        JOIN artifact_builds AS b ON b.id = r.build_id
        JOIN artifacts AS a ON a.id = b.artifact_id
        WHERE a.subject_scheme = 'conversation'
        """
    )
    # Match the resource graph's deletion contract: cited edges retain their
    # snapshot when only their target dies. A link-note attachment is a motif;
    # deleting one endpoint removes both of that note block's attachment edges.
    op.execute(
        """
        CREATE TEMP TABLE _latest_model_removed_edges ON COMMIT DROP AS
        WITH dying AS (
            SELECT e.id, e.source_scheme, e.source_id, e.origin
            FROM resource_edges AS e
            WHERE EXISTS (
                SELECT 1 FROM _latest_model_removed_resources AS r
                WHERE (e.source_scheme = r.scheme AND e.source_id = r.id)
                   OR (
                       e.ordinal IS NULL
                       AND e.target_scheme = r.scheme AND e.target_id = r.id
                   )
            )
        ), dying_link_notes AS (
            SELECT DISTINCT e.source_id
            FROM resource_edges AS e
            JOIN _latest_model_removed_resources AS r
              ON e.target_scheme = r.scheme AND e.target_id = r.id
            WHERE e.origin = 'link_note' AND e.source_scheme = 'note_block'
        )
        SELECT id FROM dying
        UNION
        SELECT e.id FROM resource_edges AS e
        JOIN dying_link_notes AS n ON e.source_id = n.source_id
        WHERE e.origin = 'link_note' AND e.source_scheme = 'note_block'
        """
    )
    op.execute(
        """
        CREATE TEMP TABLE _latest_model_chat_snapshots ON COMMIT DROP AS
        SELECT source_id::uuid AS id FROM message_retrievals
        WHERE result_type = 'web_result'
        UNION
        SELECT e.target_id FROM resource_edges AS e
        JOIN _latest_model_removed_edges AS d ON d.id = e.id
        WHERE e.target_scheme = 'external_snapshot'
        """
    )
    # A conversation dossier cannot be an independent learn result, and an
    # oracle folio is domain data. Stop if an unexpected cross-owner link exists.
    op.execute(
        """
        DO $$ BEGIN
            IF EXISTS (
                SELECT 1 FROM artifact_learn_successes AS s
                JOIN artifacts AS a ON a.id = s.artifact_id
                WHERE a.subject_scheme = 'conversation'
            ) OR EXISTS (
                SELECT 1 FROM oracle_reading_folios AS f
                JOIN _latest_model_removed_edges AS e ON e.id = f.edge_id
            ) THEN
                RAISE EXCEPTION 'chat purge crosses a retained domain owner';
            END IF;
        END $$
        """
    )

    # Chat runs and conversation-dossier builds own distinct queue entries.
    # Retained domain-dossier jobs remain runnable.
    op.execute(
        """
        CREATE TEMP TABLE _latest_model_removed_jobs ON COMMIT DROP AS
        SELECT id FROM background_jobs WHERE kind = 'chat_run'
        UNION
        SELECT j.id FROM background_jobs AS j
        JOIN artifact_builds AS b ON j.dedupe_key = 'dossier_build:' || b.id::text
        JOIN artifacts AS a ON a.id = b.artifact_id
        WHERE j.kind = 'dossier_build' AND a.subject_scheme = 'conversation'
        """
    )
    # Frozen domain admissions can replay retired models even after their
    # ledger parent is removed. Quiescence alone is insufficient: failed and
    # dead jobs are replayable. Their owner must settle/archive them first.
    op.execute(
        """
        DO $$ BEGIN
            IF EXISTS (
                SELECT 1 FROM background_jobs AS j
                WHERE j.id NOT IN (SELECT id FROM _latest_model_removed_jobs)
                  AND j.status <> 'succeeded'
                  AND j.payload ? 'generation_admissions'
            ) OR EXISTS (
                SELECT 1 FROM llm_calls AS c
                WHERE c.owner_kind <> 'chat_run' AND c.outcome IS NULL
            ) THEN
                RAISE EXCEPTION 'unsettled domain generation blocks model history cutover';
            END IF;
        END $$
        """
    )
    op.execute(
        "DELETE FROM background_job_capacity_leases WHERE job_id IN "
        "(SELECT id FROM _latest_model_removed_jobs)"
    )
    op.execute(
        "DELETE FROM background_jobs WHERE id IN (SELECT id FROM _latest_model_removed_jobs)"
    )
    op.execute("DELETE FROM chat_prompt_assemblies")
    op.execute("DELETE FROM chat_run_events")
    op.execute("DELETE FROM chat_run_turn_contexts")
    op.execute("DELETE FROM message_retrievals")
    op.execute("DELETE FROM message_tool_calls")
    op.execute("DELETE FROM chat_runs")
    op.execute("DELETE FROM conversation_active_paths")
    op.execute("DELETE FROM conversation_branches")

    # Remove graph and sharing records only when their exact resource identity
    # belongs to the set above. Retained resources and their other edges remain.
    op.execute(
        """
        DELETE FROM resource_view_states AS v
        WHERE v.edge_id IN (SELECT id FROM _latest_model_removed_edges)
           OR EXISTS (
                SELECT 1 FROM _latest_model_removed_resources AS r
                WHERE (v.surface_scheme = r.scheme AND v.surface_id = r.id)
                   OR (v.target_scheme = r.scheme AND v.target_id = r.id)
           )
        """
    )
    op.execute(
        """
        DELETE FROM resource_grants AS g
        WHERE EXISTS (
            SELECT 1 FROM _latest_model_removed_resources AS r
            WHERE g.subject_scheme = r.scheme AND g.subject_id = r.id
        )
        """
    )
    op.execute(
        """
        DELETE FROM resource_versions AS v
        WHERE EXISTS (
            SELECT 1 FROM _latest_model_removed_resources AS r
            WHERE v.resource_scheme = r.scheme AND v.resource_id = r.id
        )
        """
    )
    op.execute(
        """
        DELETE FROM resource_mutations AS m
        WHERE EXISTS (
            SELECT 1 FROM _latest_model_removed_resources AS r
            WHERE left(
                m.mutation_scope,
                length('resource:' || r.scheme || ':' || r.id::text || ':')
            ) = 'resource:' || r.scheme || ':' || r.id::text || ':'
        )
        """
    )
    # Admission replay receipts name chat identities that no longer exist.
    # Current catalog validation rejects the retired revision before a new run.
    op.execute("DELETE FROM resource_mutations WHERE mutation_scope = 'chat:admission'")
    op.execute(
        "DELETE FROM resource_edges WHERE id IN (SELECT id FROM _latest_model_removed_edges)"
    )
    op.execute(
        """
        DELETE FROM resource_external_snapshots AS s
        WHERE s.id IN (SELECT id FROM _latest_model_chat_snapshots)
          AND NOT EXISTS (
              SELECT 1 FROM resource_edges AS e
              WHERE e.target_scheme = 'external_snapshot' AND e.target_id = s.id
          )
          AND NOT EXISTS (
              SELECT 1 FROM message_retrievals AS r
              WHERE r.result_type = 'web_result' AND r.source_id = s.id::text
          )
        """
    )

    # Only conversation-subject dossiers and their owned revisions are removed.
    op.execute(
        "UPDATE artifacts SET current_revision_id = NULL WHERE subject_scheme = 'conversation'"
    )
    op.execute(
        "DELETE FROM artifact_idea_seeds WHERE artifact_id IN "
        "(SELECT id FROM artifacts WHERE subject_scheme = 'conversation')"
    )
    for table in (
        "artifact_build_cancellations",
        "artifact_build_events",
        "artifact_build_failures",
    ):
        op.execute(
            f"DELETE FROM {table} WHERE build_id IN ("
            "SELECT b.id FROM artifact_builds AS b "
            "JOIN artifacts AS a ON a.id = b.artifact_id "
            "WHERE a.subject_scheme = 'conversation')"
        )
    op.execute(
        "DELETE FROM artifact_revisions WHERE build_id IN "
        "(SELECT b.id FROM artifact_builds AS b JOIN artifacts AS a ON a.id = b.artifact_id "
        "WHERE a.subject_scheme = 'conversation')"
    )
    op.execute(
        "DELETE FROM artifact_builds WHERE artifact_id IN "
        "(SELECT id FROM artifacts WHERE subject_scheme = 'conversation')"
    )
    op.execute("DELETE FROM artifacts WHERE subject_scheme = 'conversation'")

    op.execute("DELETE FROM messages")
    op.execute("DELETE FROM conversations")
    op.execute("DELETE FROM llm_model_turn_continuations")
    op.execute("DELETE FROM llm_model_turns")
    op.execute("DELETE FROM llm_tool_positions")
    op.execute("DELETE FROM llm_calls")


def downgrade() -> None:
    raise NotImplementedError("0242 is an irreversible history cutover")
