"""Test utilities for database isolation.

Provides fixtures for running tests in nested transactions (savepoints)
that are rolled back after each test, ensuring test isolation without
requiring full database resets.
"""

from collections.abc import Callable
from typing import Any

from sqlalchemy import Connection, Engine, text
from sqlalchemy.orm import Session


def _delete_owner_content(session: Session, *, owner_kind: str, owner_id: Any) -> None:
    """Delete the unified content rows for one (owner_kind, owner_id) owner.

    Children first (content_embeddings, content_chunk_parts via their chunks), then the
    content_chunks themselves, then evidence_spans and content_blocks. Does NOT touch
    content_index_states — callers delete that explicitly so they control ordering.
    """
    params = {"owner_kind": owner_kind, "owner_id": owner_id}
    session.execute(
        text(
            """
            DELETE FROM content_embeddings ce
            USING content_chunks cc
            WHERE ce.chunk_id = cc.id
              AND cc.owner_kind = :owner_kind
              AND cc.owner_id = :owner_id
            """
        ),
        params,
    )
    session.execute(
        text(
            """
            DELETE FROM content_chunk_parts ccp
            USING content_chunks cc
            WHERE ccp.chunk_id = cc.id
              AND cc.owner_kind = :owner_kind
              AND cc.owner_id = :owner_id
            """
        ),
        params,
    )
    session.execute(
        text("DELETE FROM content_chunks WHERE owner_kind = :owner_kind AND owner_id = :owner_id"),
        params,
    )
    # message_retrievals.evidence_span_id FK is non-cascading: detach before deleting spans.
    session.execute(
        text(
            """
            UPDATE message_retrievals mr
            SET evidence_span_id = NULL
            FROM evidence_spans es
            WHERE mr.evidence_span_id = es.id
              AND es.owner_kind = :owner_kind
              AND es.owner_id = :owner_id
            """
        ),
        params,
    )
    session.execute(
        text("DELETE FROM evidence_spans WHERE owner_kind = :owner_kind AND owner_id = :owner_id"),
        params,
    )
    session.execute(
        text("DELETE FROM content_blocks WHERE owner_kind = :owner_kind AND owner_id = :owner_id"),
        params,
    )


def _delete_page_owned_content(
    session: Session, *, page_filter: str, params: dict[str, Any]
) -> None:
    """Delete page-owned unified content for every page returned by ``page_filter``.

    ``page_filter`` is a SELECT yielding page ids (e.g. the user's pages). Page note
    content is keyed by (owner_kind='page', owner_id=<page id>). Children before parents,
    then content_index_states.
    """
    page_ids = [row[0] for row in session.execute(text(page_filter), params)]
    for page_id in page_ids:
        _delete_owner_content(session, owner_kind="page", owner_id=page_id)
    if page_ids:
        session.execute(
            text(
                "DELETE FROM content_index_states "
                "WHERE owner_kind = 'page' AND owner_id = ANY(:page_ids)"
            ),
            {"page_ids": page_ids},
        )


def _delete_library_intelligence(session: Session, artifact_filter: str, value: Any) -> None:
    """Tear down the LI head + revisions (non-cascading, migration 0141) for cleanup.

    ``artifact_filter`` is a WHERE clause over ``library_intelligence_artifacts``
    (e.g. ``WHERE library_id = :value``). Order: null the circular pointer, drop
    revision children (events), then revisions, then the head.
    """
    revision_filter = (
        "revision_id IN (SELECT r.id FROM library_intelligence_artifact_revisions r "
        f"JOIN library_intelligence_artifacts a ON a.id = r.artifact_id {artifact_filter})"
    )
    session.execute(
        text(
            f"UPDATE library_intelligence_artifacts SET current_revision_id = NULL {artifact_filter}"
        ),
        {"value": value},
    )
    session.execute(
        text(f"DELETE FROM library_intelligence_revision_events WHERE {revision_filter}"),
        {"value": value},
    )
    session.execute(
        text(
            "DELETE FROM library_intelligence_artifact_revisions WHERE artifact_id IN "
            f"(SELECT id FROM library_intelligence_artifacts {artifact_filter})"
        ),
        {"value": value},
    )
    session.execute(
        text(f"DELETE FROM library_intelligence_artifacts {artifact_filter}"),
        {"value": value},
    )


def task_session_factory(fixture_session: Session) -> Callable[[], Session]:
    """Create a session factory for worker job tests.

    Worker job handlers call session_factory() to get a session, then
    `db.close()` in a finally block. This factory creates sessions that share
    the test fixture's
    DB connection (so they see test data and their writes are rolled back with
    the test) but can be safely closed without affecting the fixture session.

    After the task runs, call ``fixture_session.expire_all()`` before asserting
    on ORM objects so the fixture re-reads the task's committed changes.

    Usage::

        with patch(
            "nexus.tasks.foo.get_session_factory",
            return_value=task_session_factory(db_session),
        ):
            result = some_task(str(media_id))

        db_session.expire_all()
        assert db_session.get(Media, mid).status == "done"
    """
    connection = fixture_session.connection()

    def factory() -> Session:
        return Session(bind=connection, join_transaction_mode="create_savepoint")

    return factory


class DirectSessionManager:
    """Manager for tests that need direct DB access without savepoint isolation.

    Use this when a test requires multiple independent connections that must
    see each other's committed data (e.g., testing race conditions,
    connection pooling, or partial state recovery).

    WARNING: Tests using this do NOT auto-rollback. They must register
    cleanup data or manually clean up.

    Usage:
        def test_something(self, direct_db: DirectSessionManager):
            # Register cleanup upfront (deleted in reverse order)
            direct_db.register_cleanup("child_table", "parent_id", some_id)
            direct_db.register_cleanup("parent_table", "id", some_id)

            # Create data with committed transactions
            with direct_db.session() as s:
                s.execute(...)
                s.commit()

            # Verify with separate connection
            with direct_db.session() as s:
                result = s.execute(...)
    """

    def __init__(self, engine: Engine):
        self.engine = engine
        self._cleanup_items: list[tuple[str, str, Any]] = []

    def session(self) -> Session:
        """Create a new independent session.

        Caller is responsible for committing/closing.
        """
        return Session(self.engine)

    def register_cleanup(self, table: str, column: str, value: Any) -> None:
        """Register data to be cleaned up after test.

        Items are deleted in reverse order of registration (LIFO),
        so register parent tables before child tables.

        Args:
            table: Table name to delete from.
            column: Column name to match.
            value: Value to match for deletion.
        """
        self._cleanup_items.append((table, column, value))

    def cleanup(self) -> None:
        """Delete all registered test data in reverse order."""
        if not self._cleanup_items:
            return

        with Session(self.engine) as session:
            for table, column, value in reversed(self._cleanup_items):
                if table == "highlights" and column == "fragment_anchor_fragment_id":
                    session.execute(
                        text(
                            """
                            DELETE FROM highlights
                            WHERE id IN (
                                SELECT highlight_id
                                FROM highlight_fragment_anchors
                                WHERE fragment_id = :value
                            )
                            """
                        ),
                        {"value": value},
                    )
                    continue

                if value is None:
                    session.execute(text(f"DELETE FROM {table} WHERE {column} IS NULL"))
                    continue

                if table == "background_jobs" and column == "id":
                    session.execute(
                        text(
                            "UPDATE media_source_attempts SET job_id = NULL WHERE job_id = :value"
                        ),
                        {"value": value},
                    )

                if table == "media_source_attempts" and column == "id":
                    session.execute(
                        text(
                            """
                            UPDATE external_provider_events
                            SET source_attempt_id = NULL
                            WHERE source_attempt_id = :value
                            """
                        ),
                        {"value": value},
                    )

                if table == "media" and column == "id":
                    session.execute(
                        text(
                            """
                            UPDATE external_provider_events
                            SET source_attempt_id = NULL
                            WHERE source_attempt_id IN (
                                SELECT id
                                FROM media_source_attempts
                                WHERE media_id = :value
                            )
                            """
                        ),
                        {"value": value},
                    )
                    session.execute(
                        text(
                            """
                            UPDATE external_provider_events
                            SET media_id = NULL
                            WHERE media_id = :value
                            """
                        ),
                        {"value": value},
                    )
                    session.execute(
                        text("DELETE FROM media_source_attempts WHERE media_id = :value"),
                        {"value": value},
                    )

                if table == "users" and column == "id":
                    session.execute(
                        text(
                            """
                            DELETE FROM message_retrieval_candidate_ledgers
                            WHERE tool_call_id IN (
                                SELECT mtc.id
                                FROM message_tool_calls mtc
                                JOIN conversations c ON c.id = mtc.conversation_id
                                WHERE c.owner_user_id = :value
                            )
                            """
                        ),
                        {"value": value},
                    )
                    session.execute(
                        text(
                            """
                            DELETE FROM message_rerank_ledgers
                            WHERE tool_call_id IN (
                                SELECT mtc.id
                                FROM message_tool_calls mtc
                                JOIN conversations c ON c.id = mtc.conversation_id
                                WHERE c.owner_user_id = :value
                            )
                            """
                        ),
                        {"value": value},
                    )
                    # Page-owned content lives in the unified content pipeline keyed by
                    # (owner_kind='page', owner_id=<page id>); clear it for the user's pages
                    # before the pages/users cascade. Children (embeddings, chunk parts)
                    # before parents (chunks), then spans/blocks/index states.
                    _delete_page_owned_content(
                        session,
                        page_filter="SELECT id FROM pages WHERE user_id = :value",
                        params={"value": value},
                    )
                    session.execute(
                        text("DELETE FROM user_pinned_objects WHERE user_id = :value"),
                        {"value": value},
                    )
                    session.execute(
                        text("DELETE FROM daily_note_pages WHERE user_id = :value"),
                        {"value": value},
                    )
                    session.execute(
                        text(
                            "DELETE FROM billing_entitlement_override_events WHERE user_id = :value"
                        ),
                        {"value": value},
                    )
                    session.execute(
                        text("DELETE FROM billing_entitlement_overrides WHERE user_id = :value"),
                        {"value": value},
                    )
                    # resource_edges / resource_external_snapshots /
                    # synapse_suppressions FK users.id with no cascade (provenance
                    # graph: cleanup is explicit application code).
                    session.execute(
                        text("DELETE FROM resource_edges WHERE user_id = :value"),
                        {"value": value},
                    )
                    session.execute(
                        text("DELETE FROM resource_external_snapshots WHERE user_id = :value"),
                        {"value": value},
                    )
                    session.execute(
                        text("DELETE FROM synapse_suppressions WHERE user_id = :value"),
                        {"value": value},
                    )
                    session.execute(
                        text(
                            """
                            DELETE FROM chat_run_events
                            WHERE run_id IN (
                                SELECT cr.id
                                FROM chat_runs cr
                                JOIN conversations c ON c.id = cr.conversation_id
                                WHERE c.owner_user_id = :value
                            )
                            """
                        ),
                        {"value": value},
                    )
                    session.execute(
                        text(
                            """
                            DELETE FROM chat_prompt_assemblies
                            WHERE conversation_id IN (
                                SELECT id FROM conversations WHERE owner_user_id = :value
                            )
                            """
                        ),
                        {"value": value},
                    )
                    session.execute(
                        text(
                            """
                            DELETE FROM chat_runs
                            WHERE conversation_id IN (
                                SELECT id FROM conversations WHERE owner_user_id = :value
                            )
                            """
                        ),
                        {"value": value},
                    )
                    session.execute(
                        text(
                            """
                            DELETE FROM message_retrievals
                            WHERE tool_call_id IN (
                                SELECT mtc.id
                                FROM message_tool_calls mtc
                                JOIN conversations c ON c.id = mtc.conversation_id
                                WHERE c.owner_user_id = :value
                            )
                            """
                        ),
                        {"value": value},
                    )
                    session.execute(
                        text(
                            """
                            DELETE FROM message_tool_calls
                            WHERE conversation_id IN (
                                SELECT id FROM conversations WHERE owner_user_id = :value
                            )
                            """
                        ),
                        {"value": value},
                    )
                    session.execute(
                        text(
                            """
                            DELETE FROM conversation_active_paths
                            WHERE conversation_id IN (
                                SELECT id FROM conversations WHERE owner_user_id = :value
                            )
                            """
                        ),
                        {"value": value},
                    )
                    session.execute(
                        text(
                            """
                            DELETE FROM conversation_branches
                            WHERE conversation_id IN (
                                SELECT id FROM conversations WHERE owner_user_id = :value
                            )
                            """
                        ),
                        {"value": value},
                    )
                    session.execute(
                        text(
                            """
                            DELETE FROM messages
                            WHERE conversation_id IN (
                                SELECT id FROM conversations WHERE owner_user_id = :value
                            )
                            """
                        ),
                        {"value": value},
                    )
                    session.execute(
                        text("DELETE FROM conversations WHERE owner_user_id = :value"),
                        {"value": value},
                    )
                    # libraries.owner_user_id cascades on user delete, but
                    # library_entries.library_id is non-cascading (migration 0131): clear
                    # the user's library entries before the user (and thus its libraries).
                    session.execute(
                        text(
                            "DELETE FROM library_entries WHERE library_id IN "
                            "(SELECT id FROM libraries WHERE owner_user_id = :value)"
                        ),
                        {"value": value},
                    )
                    # library_intelligence head/revisions are non-cascading (migration
                    # 0141) and the head FKs both library_id and user_id; tear them down
                    # before the user (and its cascaded libraries).
                    _delete_library_intelligence(
                        session,
                        "WHERE library_id IN (SELECT id FROM libraries WHERE owner_user_id = :value) "
                        "OR user_id = :value",
                        value,
                    )

                if table == "media" and column == "id":
                    session.execute(
                        text(
                            "UPDATE message_retrievals SET media_id = NULL WHERE media_id = :value"
                        ),
                        {"value": value},
                    )
                    # Provenance-graph edges have no FKs; clear both endpoints
                    # explicitly so deleted media leaves no dangling edges behind.
                    session.execute(
                        text(
                            """
                            DELETE FROM resource_edges
                            WHERE (source_scheme = 'media' AND source_id = :value)
                               OR (target_scheme = 'media' AND target_id = :value)
                            """
                        ),
                        {"value": value},
                    )
                    # media_claims/media_summaries are non-cascading (migration 0140);
                    # claims FK evidence_spans + media_summaries, so clear them before
                    # the span/content/media rows they reference (handled below by
                    # _delete_owner_content and the trailing DELETE FROM media).
                    session.execute(
                        text("DELETE FROM media_claims WHERE media_id = :value"),
                        {"value": value},
                    )
                    session.execute(
                        text("DELETE FROM media_summaries WHERE media_id = :value"),
                        {"value": value},
                    )
                    # Content index tables are now keyed by (owner_kind, owner_id);
                    # media-owned content uses owner_kind='media', owner_id=<media id>
                    # (migration 0141 dropped the media_id columns and renamed
                    # media_content_index_states -> content_index_states).
                    session.execute(
                        text(
                            "DELETE FROM content_index_states "
                            "WHERE owner_kind = 'media' AND owner_id = :value"
                        ),
                        {"value": value},
                    )
                    _delete_owner_content(session, owner_kind="media", owner_id=value)
                    session.execute(
                        text("DELETE FROM contributor_credits WHERE media_id = :value"),
                        {"value": value},
                    )
                    # library_entries.media_id lost its ON DELETE CASCADE in migration 0131,
                    # so clear entries explicitly before the media row. (intrinsics + closure
                    # edges still cascade from media.id — the DELETE FROM media handles them.)
                    session.execute(
                        text("DELETE FROM library_entries WHERE media_id = :value"),
                        {"value": value},
                    )

                if table == "content_chunks" and column == "owner_id":
                    # content_chunks is now keyed by (owner_kind, owner_id); media-owned
                    # cleanup passes a media id as owner_id. Clear chunk children
                    # (embeddings, parts) here; the trailing generic DELETE removes the
                    # chunks themselves by owner_id.
                    session.execute(
                        text(
                            """
                            DELETE FROM content_embeddings ce
                            USING content_chunks cc
                            WHERE ce.chunk_id = cc.id
                              AND cc.owner_kind = 'media'
                              AND cc.owner_id = :value
                            """
                        ),
                        {"value": value},
                    )
                    session.execute(
                        text(
                            """
                            DELETE FROM content_chunk_parts ccp
                            USING content_chunks cc
                            WHERE ccp.chunk_id = cc.id
                              AND cc.owner_kind = 'media'
                              AND cc.owner_id = :value
                            """
                        ),
                        {"value": value},
                    )

                if table == "podcasts" and column == "id":
                    session.execute(
                        text("DELETE FROM contributor_credits WHERE podcast_id = :value"),
                        {"value": value},
                    )
                    # library_entries.podcast_id is non-cascading (migration 0131).
                    session.execute(
                        text("DELETE FROM library_entries WHERE podcast_id = :value"),
                        {"value": value},
                    )

                # library_entries.library_id is non-cascading (migration 0131): remove a
                # library's entries before the library row.
                if table == "libraries" and column == "id":
                    session.execute(
                        text("DELETE FROM library_entries WHERE library_id = :value"),
                        {"value": value},
                    )
                    # library_intelligence head/revisions are non-cascading (migration
                    # 0141): null the circular pointer, then drop revision children, then
                    # revisions + the head, before the library row.
                    _delete_library_intelligence(session, "WHERE library_id = :value", value)

                if table == "libraries" and column == "owner_user_id":
                    session.execute(
                        text(
                            "DELETE FROM library_entries WHERE library_id IN "
                            "(SELECT id FROM libraries WHERE owner_user_id = :value)"
                        ),
                        {"value": value},
                    )
                    _delete_library_intelligence(
                        session,
                        "WHERE library_id IN (SELECT id FROM libraries WHERE owner_user_id = :value)",
                        value,
                    )

                if table == "conversations" and column == "id":
                    # Context edges (source conversation:<id>), citation edges
                    # (source message:<one of its messages>), and any edges
                    # targeting the conversation. No FKs — explicit cleanup.
                    session.execute(
                        text(
                            """
                            DELETE FROM resource_edges
                            WHERE (source_scheme = 'conversation' AND source_id = :value)
                               OR (target_scheme = 'conversation' AND target_id = :value)
                               OR (source_scheme = 'message' AND source_id IN (
                                    SELECT id FROM messages WHERE conversation_id = :value
                                  ))
                            """
                        ),
                        {"value": value},
                    )
                    session.execute(
                        text(
                            """
                            DELETE FROM message_retrieval_candidate_ledgers
                            WHERE tool_call_id IN (
                                SELECT mtc.id
                                FROM message_tool_calls mtc
                                WHERE mtc.conversation_id = :value
                            )
                            """
                        ),
                        {"value": value},
                    )
                    session.execute(
                        text(
                            """
                            DELETE FROM message_rerank_ledgers
                            WHERE tool_call_id IN (
                                SELECT mtc.id
                                FROM message_tool_calls mtc
                                WHERE mtc.conversation_id = :value
                            )
                            """
                        ),
                        {"value": value},
                    )
                    session.execute(
                        text(
                            "DELETE FROM conversation_active_paths WHERE conversation_id = :value"
                        ),
                        {"value": value},
                    )
                    session.execute(
                        text("DELETE FROM conversation_branches WHERE conversation_id = :value"),
                        {"value": value},
                    )
                    session.execute(
                        text(
                            """
                            DELETE FROM chat_run_events
                            WHERE run_id IN (
                                SELECT id FROM chat_runs WHERE conversation_id = :value
                            )
                            """
                        ),
                        {"value": value},
                    )
                    session.execute(
                        text("DELETE FROM chat_prompt_assemblies WHERE conversation_id = :value"),
                        {"value": value},
                    )
                    session.execute(
                        text("DELETE FROM chat_runs WHERE conversation_id = :value"),
                        {"value": value},
                    )
                    session.execute(
                        text(
                            """
                            DELETE FROM message_retrievals
                            WHERE tool_call_id IN (
                                SELECT id FROM message_tool_calls WHERE conversation_id = :value
                            )
                            """
                        ),
                        {"value": value},
                    )
                    session.execute(
                        text("DELETE FROM message_tool_calls WHERE conversation_id = :value"),
                        {"value": value},
                    )

                if table == "messages" and column == "id":
                    session.execute(
                        text(
                            """
                            DELETE FROM resource_edges
                            WHERE (source_scheme = 'message' AND source_id = :value)
                               OR (target_scheme = 'message' AND target_id = :value)
                            """
                        ),
                        {"value": value},
                    )
                    session.execute(
                        text(
                            """
                            DELETE FROM message_retrieval_candidate_ledgers
                            WHERE tool_call_id IN (
                                SELECT id
                                FROM message_tool_calls
                                WHERE user_message_id = :value
                                   OR assistant_message_id = :value
                            )
                            """
                        ),
                        {"value": value},
                    )
                    session.execute(
                        text(
                            """
                            DELETE FROM message_rerank_ledgers
                            WHERE tool_call_id IN (
                                SELECT id
                                FROM message_tool_calls
                                WHERE user_message_id = :value
                                   OR assistant_message_id = :value
                            )
                            """
                        ),
                        {"value": value},
                    )
                    session.execute(
                        text(
                            """
                            DELETE FROM chat_run_events
                            WHERE run_id IN (
                                SELECT id
                                FROM chat_runs
                                WHERE user_message_id = :value
                                   OR assistant_message_id = :value
                            )
                            """
                        ),
                        {"value": value},
                    )
                    session.execute(
                        text(
                            """
                            DELETE FROM chat_prompt_assemblies
                            WHERE assistant_message_id = :value
                               OR chat_run_id IN (
                                   SELECT id
                                   FROM chat_runs
                                   WHERE user_message_id = :value
                                      OR assistant_message_id = :value
                               )
                            """
                        ),
                        {"value": value},
                    )
                    session.execute(
                        text(
                            """
                            DELETE FROM message_retrievals
                            WHERE tool_call_id IN (
                                SELECT id
                                FROM message_tool_calls
                                WHERE user_message_id = :value
                                   OR assistant_message_id = :value
                            )
                            """
                        ),
                        {"value": value},
                    )
                    session.execute(
                        text(
                            """
                            DELETE FROM message_tool_calls
                            WHERE user_message_id = :value
                               OR assistant_message_id = :value
                            """
                        ),
                        {"value": value},
                    )
                    session.execute(
                        text(
                            """
                            DELETE FROM chat_runs
                            WHERE user_message_id = :value
                               OR assistant_message_id = :value
                            """
                        ),
                        {"value": value},
                    )
                    session.execute(
                        text(
                            """
                            DELETE FROM conversation_active_paths
                            WHERE active_leaf_message_id = :value
                            """
                        ),
                        {"value": value},
                    )
                    session.execute(
                        text(
                            """
                            DELETE FROM conversation_branches
                            WHERE branch_user_message_id = :value
                            """
                        ),
                        {"value": value},
                    )
                    session.execute(
                        text(
                            """
                            DELETE FROM message_retrieval_candidate_ledgers
                            WHERE tool_call_id IN (
                                SELECT id
                                FROM message_tool_calls
                                WHERE user_message_id = :value
                                   OR assistant_message_id = :value
                            )
                            """
                        ),
                        {"value": value},
                    )
                    session.execute(
                        text(
                            """
                            DELETE FROM message_rerank_ledgers
                            WHERE tool_call_id IN (
                                SELECT id
                                FROM message_tool_calls
                                WHERE user_message_id = :value
                                   OR assistant_message_id = :value
                            )
                            """
                        ),
                        {"value": value},
                    )

                if table == "messages" and column == "conversation_id":
                    session.execute(
                        text(
                            """
                            DELETE FROM resource_edges
                            WHERE source_scheme = 'message' AND source_id IN (
                                SELECT id FROM messages WHERE conversation_id = :value
                            )
                            """
                        ),
                        {"value": value},
                    )
                    session.execute(
                        text(
                            """
                            DELETE FROM message_retrieval_candidate_ledgers
                            WHERE tool_call_id IN (
                                SELECT mtc.id
                                FROM message_tool_calls mtc
                                WHERE mtc.conversation_id = :value
                            )
                            """
                        ),
                        {"value": value},
                    )
                    session.execute(
                        text(
                            """
                            DELETE FROM message_rerank_ledgers
                            WHERE tool_call_id IN (
                                SELECT mtc.id
                                FROM message_tool_calls mtc
                                WHERE mtc.conversation_id = :value
                            )
                            """
                        ),
                        {"value": value},
                    )
                    session.execute(
                        text(
                            """
                            DELETE FROM chat_run_events
                            WHERE run_id IN (
                                SELECT id FROM chat_runs WHERE conversation_id = :value
                            )
                            """
                        ),
                        {"value": value},
                    )
                    session.execute(
                        text("DELETE FROM chat_prompt_assemblies WHERE conversation_id = :value"),
                        {"value": value},
                    )
                    session.execute(
                        text(
                            """
                            DELETE FROM message_retrievals
                            WHERE tool_call_id IN (
                                SELECT id FROM message_tool_calls WHERE conversation_id = :value
                            )
                            """
                        ),
                        {"value": value},
                    )
                    session.execute(
                        text("DELETE FROM message_tool_calls WHERE conversation_id = :value"),
                        {"value": value},
                    )
                    session.execute(
                        text("DELETE FROM chat_runs WHERE conversation_id = :value"),
                        {"value": value},
                    )
                    session.execute(
                        text(
                            "DELETE FROM conversation_active_paths WHERE conversation_id = :value"
                        ),
                        {"value": value},
                    )
                    session.execute(
                        text("DELETE FROM conversation_branches WHERE conversation_id = :value"),
                        {"value": value},
                    )

                if table == "pages" and column == "id":
                    session.execute(
                        text("DELETE FROM daily_note_pages WHERE page_id = :value"),
                        {"value": value},
                    )
                    session.execute(
                        text("DELETE FROM page_document_mutations WHERE page_id = :value"),
                        {"value": value},
                    )
                    session.execute(
                        text(
                            """
                            DELETE FROM user_pinned_objects
                            WHERE (object_type = 'page' AND object_id = :value)
                               OR (object_type = 'note_block' AND object_id IN (
                                    WITH RECURSIVE page_blocks(block_id) AS (
                                        SELECT target_id
                                        FROM resource_edges
                                        WHERE origin = 'note_containment'
                                          AND source_scheme = 'page'
                                          AND source_id = :value
                                          AND target_scheme = 'note_block'
                                        UNION
                                        SELECT child.target_id
                                        FROM resource_edges child
                                        JOIN page_blocks parent
                                          ON child.source_scheme = 'note_block'
                                         AND child.source_id = parent.block_id
                                        WHERE child.origin = 'note_containment'
                                          AND child.target_scheme = 'note_block'
                                    )
                                    SELECT block_id FROM page_blocks
                                  ))
                            """
                        ),
                        {"value": value},
                    )
                    # Page note content now lives in the unified content pipeline keyed by
                    # (owner_kind='page', owner_id=<page id>).
                    _delete_owner_content(session, owner_kind="page", owner_id=value)
                    session.execute(
                        text(
                            "DELETE FROM content_index_states "
                            "WHERE owner_kind = 'page' AND owner_id = :value"
                        ),
                        {"value": value},
                    )
                    session.execute(
                        text(
                            """
                            DELETE FROM note_view_states
                            WHERE (context_source_scheme = 'page' AND context_source_id = :value)
                               OR target_block_id IN (
                                    WITH RECURSIVE page_blocks(block_id) AS (
                                        SELECT target_id
                                        FROM resource_edges
                                        WHERE origin = 'note_containment'
                                          AND source_scheme = 'page'
                                          AND source_id = :value
                                          AND target_scheme = 'note_block'
                                        UNION
                                        SELECT child.target_id
                                        FROM resource_edges child
                                        JOIN page_blocks parent
                                          ON child.source_scheme = 'note_block'
                                         AND child.source_id = parent.block_id
                                        WHERE child.origin = 'note_containment'
                                          AND child.target_scheme = 'note_block'
                                    )
                                    SELECT block_id FROM page_blocks
                                  )
                               OR context_source_id IN (
                                    WITH RECURSIVE page_blocks(block_id) AS (
                                        SELECT target_id
                                        FROM resource_edges
                                        WHERE origin = 'note_containment'
                                          AND source_scheme = 'page'
                                          AND source_id = :value
                                          AND target_scheme = 'note_block'
                                        UNION
                                        SELECT child.target_id
                                        FROM resource_edges child
                                        JOIN page_blocks parent
                                          ON child.source_scheme = 'note_block'
                                         AND child.source_id = parent.block_id
                                        WHERE child.origin = 'note_containment'
                                          AND child.target_scheme = 'note_block'
                                    )
                                    SELECT block_id FROM page_blocks
                                  )
                            """
                        ),
                        {"value": value},
                    )
                    session.execute(
                        text(
                            """
                            DELETE FROM note_blocks
                            WHERE id IN (
                                WITH RECURSIVE page_blocks(block_id) AS (
                                    SELECT target_id
                                    FROM resource_edges
                                    WHERE origin = 'note_containment'
                                      AND source_scheme = 'page'
                                      AND source_id = :value
                                      AND target_scheme = 'note_block'
                                    UNION
                                    SELECT child.target_id
                                    FROM resource_edges child
                                    JOIN page_blocks parent
                                      ON child.source_scheme = 'note_block'
                                     AND child.source_id = parent.block_id
                                    WHERE child.origin = 'note_containment'
                                      AND child.target_scheme = 'note_block'
                                )
                                SELECT block_id FROM page_blocks
                            )
                            """
                        ),
                        {"value": value},
                    )
                    session.execute(
                        text(
                            """
                            DELETE FROM resource_edges
                            WHERE (source_scheme = 'note_block' AND source_id IN (
                                    WITH RECURSIVE page_blocks(block_id) AS (
                                        SELECT target_id
                                        FROM resource_edges
                                        WHERE origin = 'note_containment'
                                          AND source_scheme = 'page'
                                          AND source_id = :value
                                          AND target_scheme = 'note_block'
                                        UNION
                                        SELECT child.target_id
                                        FROM resource_edges child
                                        JOIN page_blocks parent
                                          ON child.source_scheme = 'note_block'
                                         AND child.source_id = parent.block_id
                                        WHERE child.origin = 'note_containment'
                                          AND child.target_scheme = 'note_block'
                                    )
                                    SELECT block_id FROM page_blocks
                                  ))
                               OR (target_scheme = 'note_block' AND target_id IN (
                                    WITH RECURSIVE page_blocks(block_id) AS (
                                        SELECT target_id
                                        FROM resource_edges
                                        WHERE origin = 'note_containment'
                                          AND source_scheme = 'page'
                                          AND source_id = :value
                                          AND target_scheme = 'note_block'
                                        UNION
                                        SELECT child.target_id
                                        FROM resource_edges child
                                        JOIN page_blocks parent
                                          ON child.source_scheme = 'note_block'
                                         AND child.source_id = parent.block_id
                                        WHERE child.origin = 'note_containment'
                                          AND child.target_scheme = 'note_block'
                                    )
                                    SELECT block_id FROM page_blocks
                                  ))
                               OR (source_scheme = 'page' AND source_id = :value)
                               OR (target_scheme = 'page' AND target_id = :value)
                            """
                        ),
                        {"value": value},
                    )

                if table == "pages" and column == "user_id":
                    session.execute(
                        text("DELETE FROM daily_note_pages WHERE user_id = :value"),
                        {"value": value},
                    )
                    session.execute(
                        text(
                            """
                            DELETE FROM page_document_mutations
                            WHERE page_id IN (
                                SELECT id FROM pages WHERE user_id = :value
                            )
                            """
                        ),
                        {"value": value},
                    )
                    session.execute(
                        text(
                            """
                            DELETE FROM user_pinned_objects
                            WHERE user_id = :value
                              AND object_type IN ('page', 'note_block')
                            """
                        ),
                        {"value": value},
                    )
                    # Page note content lives in the unified pipeline keyed by
                    # (owner_kind='page', owner_id=<page id>); clear it for all the
                    # user's pages.
                    _delete_page_owned_content(
                        session,
                        page_filter="SELECT id FROM pages WHERE user_id = :value",
                        params={"value": value},
                    )
                    session.execute(
                        text(
                            """
                            DELETE FROM resource_edges
                            WHERE user_id = :value
                              AND (
                                  source_scheme IN ('page', 'note_block')
                               OR target_scheme IN ('page', 'note_block')
                              )
                            """
                        ),
                        {"value": value},
                    )
                    session.execute(
                        text(
                            """
                            DELETE FROM note_view_states
                            WHERE user_id = :value
                              AND (
                                  target_block_id IN (
                                      SELECT id FROM note_blocks WHERE user_id = :value
                                  )
                               OR context_source_id IN (
                                      SELECT id FROM note_blocks WHERE user_id = :value
                                  )
                              )
                            """
                        ),
                        {"value": value},
                    )
                    session.execute(
                        text("DELETE FROM note_blocks WHERE user_id = :value"),
                        {"value": value},
                    )

                if table == "note_blocks" and column == "id":
                    # Note content is page-owned (owner_kind='page', owner_id=<page id>) in
                    # the unified pipeline, so there are no per-note_block content rows to
                    # clear here — only the pin entry that referenced this note_block.
                    session.execute(
                        text(
                            """
                            DELETE FROM note_view_states
                            WHERE target_block_id = :value
                               OR context_source_id = :value
                            """
                        ),
                        {"value": value},
                    )
                    session.execute(
                        text(
                            """
                            DELETE FROM user_pinned_objects
                            WHERE object_type = 'note_block'
                              AND object_id = :value
                            """
                        ),
                        {"value": value},
                    )

                if table == "note_blocks" and column == "user_id":
                    session.execute(
                        text(
                            """
                            DELETE FROM note_view_states
                            WHERE user_id = :value
                              AND (
                                  target_block_id IN (
                                      SELECT id FROM note_blocks WHERE user_id = :value
                                  )
                               OR context_source_id IN (
                                      SELECT id FROM note_blocks WHERE user_id = :value
                                  )
                              )
                            """
                        ),
                        {"value": value},
                    )
                    session.execute(
                        text(
                            """
                            DELETE FROM user_pinned_objects
                            WHERE user_id = :value
                              AND object_type = 'note_block'
                            """
                        ),
                        {"value": value},
                    )

                session.execute(
                    text(f"DELETE FROM {table} WHERE {column} = :value"), {"value": value}
                )
            session.commit()
        self._cleanup_items.clear()


class TestDatabaseManager:
    """Manager for test database sessions with savepoint isolation.

    Usage in conftest.py:
        @pytest.fixture
        def db_session(engine):
            manager = TestDatabaseManager(engine)
            with manager.session() as session:
                yield session
    """

    def __init__(self, engine: Engine):
        self.engine = engine
        self._connection: Connection | None = None
        self._session: Session | None = None

    def __enter__(self) -> Session:
        """Start a test session with savepoint."""
        self._connection = self.engine.connect()
        self._connection.begin()

        self._session = Session(
            bind=self._connection,
            join_transaction_mode="create_savepoint",
        )
        return self._session

    def __exit__(self, exc_type: Any, exc_val: Any, exc_tb: Any) -> None:
        """Roll back and clean up the test session."""
        if self._session:
            self._session.close()
        if self._connection:
            self._connection.rollback()
            self._connection.close()

    def session(self) -> "TestDatabaseManager":
        """Return self for use as context manager."""
        return self
