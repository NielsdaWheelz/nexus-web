"""Integration tests for S4 citation unification of attached ``<resources>``.

Covers the new behavior added in S4:

- ``context_assembler._build_resources_block`` numbers an attached resource with
  ``n="…"`` only when ``_materialize_attached_citation`` resolves a durable
  retrieval row via ``search.get_search_result``; un-anchored highlights stay in
  the prompt but are never numbered.
- The dense ordinal (``n``) has no holes: only citable resources consume an ``n``.
- ``chat_runs._persist_attached_citations`` writes ONE synthetic
  ``attached_resources`` parent tool-call plus one ``message_retrievals`` row per
  citation (``citation_ordinal`` = 1..k, ``selected=true``,
  ``retrieval_status='attached_context'``).
- ``chat_runs._persist_read_evidence_citation`` writes no row (returns None) when
  the read result has no materializable retrieval.

Assertions go through the public service surface plus raw SQL reads of the two
persisted tables, mirroring the style of ``test_read_resource_tool.py``.

Isolation: the searchable-index setup and ``chat_runs._persist_attached_citations``
both ``commit()``, so a function-scoped savepoint rollback (the ``db_session``
fixture) cannot undo them — the committed rows would leak into later tests in the
same session. These tests therefore run on the ``direct_db`` manager (real
committing sessions) and register explicit row cleanups, mirroring
``test_agent_app_search.py``. A bootstrapped user is created inline via
``bootstrap_user_account`` so its default library is committed and visible.
"""

from __future__ import annotations

from uuid import UUID, uuid4

import pytest
from sqlalchemy import text as sql_text
from sqlalchemy.orm import Session

from nexus.db.models import ChatRun, Fragment
from nexus.errors import NotFoundError
from nexus.services import chat_runs, context_assembler, search
from nexus.services.agent_tools.read_resource import execute_read_resource
from nexus.services.bootstrap import ensure_user_and_default_library
from nexus.services.conversation_references import insert_reference_if_absent
from tests.factories import (
    create_searchable_media,
    create_test_conversation,
    create_test_highlight,
    create_test_media_in_library,
    create_test_message,
    create_test_model,
    get_user_default_library,
)
from tests.helpers import create_test_user_id
from tests.test_resource_resolver import _make_highlight_with_anchor, _make_pdf
from tests.utils.db import DirectSessionManager

pytestmark = pytest.mark.integration


# =============================================================================
# Helpers
# =============================================================================


def _bootstrap_user(session: Session) -> UUID:
    """Create a committed user + default library (mirrors the ``bootstrapped_user`` fixture)."""
    user_id = create_test_user_id()
    ensure_user_and_default_library(session, user_id)
    session.commit()
    return user_id


def _register_user_cleanup(direct_db: DirectSessionManager, user_id: UUID) -> None:
    """Schedule teardown of the bootstrapped user and its dependent rows.

    Cleanups run in REVERSE registration order (LIFO), so this is registered
    FIRST in each test — that makes the ``users`` row (and its big cascade of
    conversations / messages / tool-calls / retrievals / chat-runs / references /
    content index inside ``DirectSessionManager``) delete LAST, after every
    per-test child row. The ``bootstrapped_user`` fixture and
    ``test_agent_app_search.py`` rely on this same ``users``-handler cascade, plus
    the default library + page/note-block rows the highlight factories create.
    """
    direct_db.register_cleanup("users", "id", user_id)
    direct_db.register_cleanup("pages", "user_id", user_id)
    direct_db.register_cleanup("note_blocks", "user_id", user_id)
    direct_db.register_cleanup("object_links", "user_id", user_id)


def _register_media_cleanup(direct_db: DirectSessionManager, media_id: UUID) -> None:
    """Schedule teardown of a media row and its library entry.

    The ``media`` handler in ``DirectSessionManager`` cascades the searchable
    content-index rows (snapshots, index runs, chunks, parts, embeddings, …), so
    only ``library_entries`` + ``fragments`` need adding here.
    """
    direct_db.register_cleanup("media", "id", media_id)
    direct_db.register_cleanup("library_entries", "media_id", media_id)
    direct_db.register_cleanup("fragments", "media_id", media_id)


def _register_highlight_cleanup(direct_db: DirectSessionManager, highlight_id: UUID) -> None:
    """Schedule teardown of a highlight and its fragment anchor."""
    direct_db.register_cleanup("highlights", "id", highlight_id)
    direct_db.register_cleanup("highlight_fragment_anchors", "highlight_id", highlight_id)


def _attach(db: Session, conversation_id: UUID, uri: str) -> None:
    """Admit a reference row directly (mirrors the citation write-through path)."""
    insert_reference_if_absent(db, conversation_id, uri)
    db.commit()


def _make_searchable_highlight(db: Session, user_id: UUID, *, title: str) -> tuple[UUID, UUID]:
    """A highlight whose ``get_search_result(..., "highlight", id)`` SUCCEEDS.

    ``create_searchable_media`` builds a fragment AND an active content index;
    anchoring a highlight to that fragment gives it a resolvable locator, which
    is what makes the search lookup return a result.

    Returns ``(media_id, highlight_id)`` so the caller can register cleanups.
    """
    media_id = create_searchable_media(db, user_id, title=title)
    fragment = db.query(Fragment).filter(Fragment.media_id == media_id).first()
    assert fragment is not None, "create_searchable_media should produce a fragment"
    highlight_id = create_test_highlight(db, user_id, fragment.id, exact="highlighted text")
    return media_id, highlight_id


def _make_chat_run(db: Session, conversation_id: UUID, user_id: UUID) -> ChatRun:
    """A minimal ChatRun row wired to a user/assistant message pair.

    ``_persist_attached_citations`` reads conversation_id / user_message_id /
    assistant_message_id off the run, so a queued shell run is enough. Mirrors the
    canonical ``ChatRun(...)`` construction in ``test_chat_runs._create_failed_chat_run``
    so every NOT-NULL column the rebuilt schema enforces is populated — notably
    ``payload_hash`` (NOT NULL, no default) and ``model_id``.
    """
    user_message_id = create_test_message(
        db, conversation_id, seq=1, role="user", content="What does the source say?"
    )
    assistant_message_id = create_test_message(
        db,
        conversation_id,
        seq=2,
        role="assistant",
        content="",
        status="pending",
        parent_message_id=user_message_id,
    )
    idempotency_key = f"test-key-{uuid4()}"
    model_id = create_test_model(db)
    run = ChatRun(
        id=uuid4(),
        conversation_id=conversation_id,
        user_message_id=user_message_id,
        assistant_message_id=assistant_message_id,
        owner_user_id=user_id,
        model_id=model_id,
        key_mode="byok",
        status="queued",
        idempotency_key=idempotency_key,
        payload_hash=f"{idempotency_key}-payload",
        reasoning="medium",
    )
    db.add(run)
    db.commit()
    return run


def _tool_calls(db: Session, assistant_message_id: UUID) -> list[tuple]:
    return db.execute(
        sql_text(
            "SELECT id, tool_name, tool_call_index FROM message_tool_calls "
            "WHERE assistant_message_id = :amid ORDER BY tool_call_index"
        ),
        {"amid": assistant_message_id},
    ).fetchall()


def _retrievals_under(db: Session, tool_call_id: UUID) -> list:
    return (
        db.execute(
            sql_text(
                "SELECT citation_ordinal, selected, retrieval_status, result_ref, "
                "media_id, locator, result_type "
                "FROM message_retrievals WHERE tool_call_id = :tcid ORDER BY ordinal"
            ),
            {"tcid": tool_call_id},
        )
        .mappings()
        .all()
    )


def _insert_read_tool_call(
    db: Session,
    *,
    conversation_id: UUID,
    user_message_id: UUID,
    assistant_message_id: UUID,
    tool_call_index: int,
) -> UUID:
    return db.execute(
        sql_text(
            """
            INSERT INTO message_tool_calls (
                conversation_id, user_message_id, assistant_message_id,
                tool_name, tool_call_index,
                scope, requested_types, result_refs, selected_context_refs,
                provider_request_ids, status
            )
            VALUES (
                :conversation_id, :user_message_id, :assistant_message_id,
                'read_resource', :tool_call_index,
                'read_resource', '[]'::jsonb, '[]'::jsonb, '[]'::jsonb,
                '[]'::jsonb, 'complete'
            )
            RETURNING id
            """
        ),
        {
            "conversation_id": conversation_id,
            "user_message_id": user_message_id,
            "assistant_message_id": assistant_message_id,
            "tool_call_index": tool_call_index,
        },
    ).scalar_one()


# =============================================================================
# A. Anchored highlight is numbered + materializes a valid row.
# =============================================================================


def test_anchored_highlight_is_numbered_and_persists_valid_row(direct_db: DirectSessionManager):
    with direct_db.session() as session:
        user_id = _bootstrap_user(session)
        conversation_id = create_test_conversation(session, user_id)
        media_id, highlight_id = _make_searchable_highlight(
            session, user_id, title="Anchored Source"
        )
        uri = f"highlight:{highlight_id}"

        # Precondition: the highlight is genuinely searchable.
        result = search.get_search_result(session, user_id, "highlight", str(highlight_id))
        assert result.type == "highlight"

        _attach(session, conversation_id, uri)

        block, _metadata, citations = context_assembler._build_resources_block(
            session, conversation_id=conversation_id, viewer_id=user_id
        )
        assert block is not None
        assert f'uri="{uri}" n="1"' in block.text, (
            f"Anchored highlight should render n=1 on its <resource>; got:\n{block.text}"
        )
        assert len(citations) == 1, f"Exactly one citation should materialize; got {len(citations)}"
        assert citations[0].result_type == "highlight"

        run = _make_chat_run(session, conversation_id, user_id)
        chat_runs._persist_attached_citations(session, run, citations)

        calls = _tool_calls(session, run.assistant_message_id)
        assert len(calls) == 1, f"Expected one synthetic tool-call; got {calls}"
        tool_call_id, tool_name, tool_call_index = calls[0]
        assert tool_name == "attached_resources"
        assert tool_call_index == 0

        rows = _retrievals_under(session, tool_call_id)
        assert len(rows) == 1, f"Expected one retrieval under the synthetic call; got {rows}"
        row = rows[0]
        assert row["citation_ordinal"] == 1
        assert row["selected"] is True
        assert row["retrieval_status"] == "attached_context"
        assert row["result_type"] == "highlight"
        assert row["result_ref"] is not None
        # A clickable highlight target carries a locator + media_id.
        assert row["media_id"] is not None
        assert row["locator"] is not None

        chat_runs._persist_attached_citations(session, run, ())
        assert _tool_calls(session, run.assistant_message_id) == []

    # Cleanups run LIFO. Register the durable parents (user, conversation, media,
    # highlight) FIRST so they delete LAST, then the chat-run + synthetic citation
    # rows LAST so they delete FIRST. The synthetic ``message_retrievals`` row FKs to
    # ``media`` and ``message_tool_calls`` with ON DELETE NO ACTION, and ``chat_runs``
    # FKs to messages/conversations/users with NO ACTION, so all three must be torn
    # down before those parents.
    _register_user_cleanup(direct_db, user_id)
    direct_db.register_cleanup("conversations", "id", conversation_id)
    direct_db.register_cleanup("conversation_media", "conversation_id", conversation_id)
    _register_media_cleanup(direct_db, media_id)
    _register_highlight_cleanup(direct_db, highlight_id)
    direct_db.register_cleanup("chat_runs", "id", run.id)
    direct_db.register_cleanup("message_retrievals", "tool_call_id", tool_call_id)
    direct_db.register_cleanup("message_tool_calls", "id", tool_call_id)


# =============================================================================
# B. Un-anchored highlight is NOT numbered.
# =============================================================================


def test_unanchored_highlight_is_not_numbered(direct_db: DirectSessionManager):
    with direct_db.session() as session:
        user_id = _bootstrap_user(session)
        conversation_id = create_test_conversation(session, user_id)
        library_id = get_user_default_library(session, user_id)
        assert library_id is not None
        media_id = create_test_media_in_library(
            session, user_id, library_id, title="Unanchored Source"
        )
        highlight_id = _make_highlight_with_anchor(session, user_id, media_id)
        uri = f"highlight:{highlight_id}"

        # Precondition: this highlight has no active content index → not searchable.
        with pytest.raises(NotFoundError):
            search.get_search_result(session, user_id, "highlight", str(highlight_id))

        _attach(session, conversation_id, uri)

        block, _metadata, citations = context_assembler._build_resources_block(
            session, conversation_id=conversation_id, viewer_id=user_id
        )
        assert block is not None
        assert f'uri="{uri}"' in block.text, (
            "The un-anchored highlight should still be in the prompt"
        )
        assert ' n="' not in block.text, (
            f"An un-citable highlight must render WITHOUT an n attribute; got:\n{block.text}"
        )
        assert citations == (), (
            f"No citation should materialize for an un-anchored highlight; got {citations}"
        )

    _register_user_cleanup(direct_db, user_id)
    direct_db.register_cleanup("conversations", "id", conversation_id)
    direct_db.register_cleanup("conversation_media", "conversation_id", conversation_id)
    _register_media_cleanup(direct_db, media_id)
    _register_highlight_cleanup(direct_db, highlight_id)


# =============================================================================
# C. Dense ordinals, no holes.
# =============================================================================


def test_dense_ordinals_skip_uncitable_resources(direct_db: DirectSessionManager):
    with direct_db.session() as session:
        user_id = _bootstrap_user(session)
        conversation_id = create_test_conversation(session, user_id)
        library_id = get_user_default_library(session, user_id)
        assert library_id is not None

        first_media, first_id = _make_searchable_highlight(
            session, user_id, title="First Searchable"
        )
        unanchored_media = create_test_media_in_library(
            session, user_id, library_id, title="Middle Unanchored"
        )
        unanchored_id = _make_highlight_with_anchor(session, user_id, unanchored_media)
        second_media, second_id = _make_searchable_highlight(
            session, user_id, title="Second Searchable"
        )

        # Attach in the order: searchable, un-anchored, searchable.
        _attach(session, conversation_id, f"highlight:{first_id}")
        _attach(session, conversation_id, f"highlight:{unanchored_id}")
        _attach(session, conversation_id, f"highlight:{second_id}")

        block, _metadata, citations = context_assembler._build_resources_block(
            session, conversation_id=conversation_id, viewer_id=user_id
        )
        assert block is not None
        text_out = block.text
        assert f'uri="highlight:{first_id}" n="1"' in text_out, (
            f"First searchable highlight should be n=1; got:\n{text_out}"
        )
        assert f'uri="highlight:{second_id}" n="2"' in text_out, (
            f"Second searchable highlight should be n=2 (not 3); got:\n{text_out}"
        )
        assert ' n="3"' not in text_out, f"Ordinals must be dense (no n=3); got:\n{text_out}"
        # The un-anchored highlight in the middle carries no n.
        assert f'uri="highlight:{unanchored_id}"' in text_out
        assert f'uri="highlight:{unanchored_id}" n="' not in text_out
        assert len(citations) == 2, (
            f"Only the two searchable highlights should be citable; got {citations}"
        )

    _register_user_cleanup(direct_db, user_id)
    direct_db.register_cleanup("conversations", "id", conversation_id)
    direct_db.register_cleanup("conversation_media", "conversation_id", conversation_id)
    for media_id in (first_media, unanchored_media, second_media):
        _register_media_cleanup(direct_db, media_id)
    for highlight_id in (first_id, unanchored_id, second_id):
        _register_highlight_cleanup(direct_db, highlight_id)


# =============================================================================
# D. read_resource highlight with materializable retrieval → next n.
# =============================================================================


def test_read_evidence_with_materializable_retrieval_persists_next_ordinal(
    direct_db: DirectSessionManager,
):
    with direct_db.session() as session:
        user_id = _bootstrap_user(session)
        conversation_id = create_test_conversation(session, user_id)
        media_id, highlight_id = _make_searchable_highlight(
            session, user_id, title="Readable Anchored Source"
        )
        uri = f"highlight:{highlight_id}"
        _attach(session, conversation_id, uri)

        result = execute_read_resource(
            session, viewer_id=user_id, conversation_id=conversation_id, uri=uri
        )
        assert not result.is_error, f"The read should succeed; got {result}"
        assert result.kind == "quote"
        assert result.citation_result_type == "highlight"

        user_message_id = create_test_message(
            session, conversation_id, seq=1, role="user", content="Read the source"
        )
        assistant_message_id = create_test_message(
            session,
            conversation_id,
            seq=2,
            role="assistant",
            content="",
            status="pending",
            parent_message_id=user_message_id,
        )
        tool_call_id = session.execute(
            sql_text(
                """
                INSERT INTO message_tool_calls (
                    conversation_id, user_message_id, assistant_message_id,
                    tool_name, tool_call_index,
                    scope, requested_types, result_refs, selected_context_refs,
                    provider_request_ids, status
                )
                VALUES (
                    :conversation_id, :user_message_id, :assistant_message_id,
                    'read_resource', 1,
                    'read_resource', '[]'::jsonb, '[]'::jsonb, '[]'::jsonb,
                    '[]'::jsonb, 'complete'
                )
                RETURNING id
                """
            ),
            {
                "conversation_id": conversation_id,
                "user_message_id": user_message_id,
                "assistant_message_id": assistant_message_id,
            },
        ).scalar_one()
        session.commit()

        n = chat_runs._persist_read_evidence_citation(
            session,
            viewer_id=user_id,
            tool_call_id=tool_call_id,
            result=result,
            start_ordinal=5,
        )
        assert n == 5
        rows = _retrievals_under(session, tool_call_id)
        assert len(rows) == 1, f"Expected one read retrieval row; got {rows}"
        assert rows[0]["citation_ordinal"] == 5
        assert rows[0]["result_type"] == "highlight"
        assert rows[0]["locator"] is not None

    _register_user_cleanup(direct_db, user_id)
    direct_db.register_cleanup("conversations", "id", conversation_id)
    direct_db.register_cleanup("conversation_media", "conversation_id", conversation_id)
    _register_media_cleanup(direct_db, media_id)
    _register_highlight_cleanup(direct_db, highlight_id)


def test_read_evidence_section_full_and_page_range_persist_citations(
    direct_db: DirectSessionManager,
):
    with direct_db.session() as session:
        user_id = _bootstrap_user(session)
        conversation_id = create_test_conversation(session, user_id)
        library_id = get_user_default_library(session, user_id)
        assert library_id is not None
        media_id = create_searchable_media(session, user_id, title="Readable Article")
        fragment = (
            session.query(Fragment)
            .filter(Fragment.media_id == media_id)
            .order_by(Fragment.idx.asc(), Fragment.id.asc())
            .first()
        )
        assert fragment is not None, "create_searchable_media should produce a fragment"
        fragment_id = fragment.id
        pdf_media_id = _make_pdf(session, library_id, pages=["PDF page one. "])
        _attach(session, conversation_id, f"media:{media_id}")
        _attach(session, conversation_id, f"media:{pdf_media_id}")

        reads = [
            execute_read_resource(
                session,
                viewer_id=user_id,
                conversation_id=conversation_id,
                uri=f"fragment:{fragment_id}",
            ),
            execute_read_resource(
                session,
                viewer_id=user_id,
                conversation_id=conversation_id,
                uri=f"media:{media_id}",
            ),
            execute_read_resource(
                session,
                viewer_id=user_id,
                conversation_id=conversation_id,
                uri=f"page_range:{pdf_media_id}:1-1",
            ),
        ]
        assert [read.kind for read in reads] == ["section", "full", "page_range"]
        assert [read.citation_result_type for read in reads] == ["fragment", "media", "media"]

        user_message_id = create_test_message(
            session, conversation_id, seq=1, role="user", content="Read these"
        )
        assistant_message_id = create_test_message(
            session,
            conversation_id,
            seq=2,
            role="assistant",
            content="",
            status="pending",
            parent_message_id=user_message_id,
        )
        tool_call_ids: list[UUID] = []
        for offset, read in enumerate(reads):
            tool_call_id = _insert_read_tool_call(
                session,
                conversation_id=conversation_id,
                user_message_id=user_message_id,
                assistant_message_id=assistant_message_id,
                tool_call_index=offset + 1,
            )
            tool_call_ids.append(tool_call_id)
            n = chat_runs._persist_read_evidence_citation(
                session,
                viewer_id=user_id,
                tool_call_id=tool_call_id,
                result=read,
                start_ordinal=10 + offset,
            )
            assert n == 10 + offset
            rows = _retrievals_under(session, tool_call_id)
            assert len(rows) == 1
            assert rows[0]["citation_ordinal"] == 10 + offset
            assert rows[0]["result_type"] == read.citation_result_type
            assert rows[0]["locator"] is not None or read.citation_result_type == "media"

    _register_user_cleanup(direct_db, user_id)
    direct_db.register_cleanup("conversations", "id", conversation_id)
    direct_db.register_cleanup("conversation_media", "conversation_id", conversation_id)
    _register_media_cleanup(direct_db, media_id)
    _register_media_cleanup(direct_db, pdf_media_id)
    for tool_call_id in tool_call_ids:
        direct_db.register_cleanup("message_retrievals", "tool_call_id", tool_call_id)
        direct_db.register_cleanup("message_tool_calls", "id", tool_call_id)


# =============================================================================
# E. read_resource highlight without materializable retrieval → no n.
# =============================================================================


def test_read_evidence_without_materializable_retrieval_persists_nothing(
    direct_db: DirectSessionManager,
):
    with direct_db.session() as session:
        user_id = _bootstrap_user(session)
        conversation_id = create_test_conversation(session, user_id)
        library_id = get_user_default_library(session, user_id)
        assert library_id is not None
        media_id = create_test_media_in_library(
            session, user_id, library_id, title="Unanchored Read Source"
        )
        highlight_id = _make_highlight_with_anchor(session, user_id, media_id)
        uri = f"highlight:{highlight_id}"
        _attach(session, conversation_id, uri)

        result = execute_read_resource(
            session, viewer_id=user_id, conversation_id=conversation_id, uri=uri
        )
        assert not result.is_error, f"The read itself should still succeed; got {result}"
        assert result.kind == "quote"
        assert result.citation_result_type == "highlight"

        # A read tool-call to host any retrieval rows the evidence-citation would write.
        # The assistant message needs a user parent to satisfy
        # ``ck_messages_parent_role_shape`` (assistant rows require parent_message_id).
        user_message_id = create_test_message(
            session, conversation_id, seq=1, role="user", content="Read the source"
        )
        assistant_message_id = create_test_message(
            session,
            conversation_id,
            seq=2,
            role="assistant",
            content="",
            status="pending",
            parent_message_id=user_message_id,
        )
        tool_call_id = session.execute(
            sql_text(
                """
                INSERT INTO message_tool_calls (
                    conversation_id, user_message_id, assistant_message_id,
                    tool_name, tool_call_index,
                    scope, requested_types, result_refs, selected_context_refs,
                    provider_request_ids, status
                )
                VALUES (
                    :conversation_id, :user_message_id, :assistant_message_id,
                    'read_resource', 1,
                    'read_resource', '[]'::jsonb, '[]'::jsonb, '[]'::jsonb,
                    '[]'::jsonb, 'complete'
                )
                RETURNING id
                """
            ),
            {
                "conversation_id": conversation_id,
                "user_message_id": user_message_id,
                "assistant_message_id": assistant_message_id,
            },
        ).scalar_one()
        session.commit()

        n = chat_runs._persist_read_evidence_citation(
            session,
            viewer_id=user_id,
            tool_call_id=tool_call_id,
            result=result,
            start_ordinal=5,
        )
        assert n is None, "An un-materializable read evidence must not be assigned an ordinal"

        rows = _retrievals_under(session, tool_call_id)
        assert rows == [], f"No retrieval row should be written for an un-anchored read; got {rows}"

    _register_user_cleanup(direct_db, user_id)
    direct_db.register_cleanup("conversations", "id", conversation_id)
    direct_db.register_cleanup("conversation_media", "conversation_id", conversation_id)
    _register_media_cleanup(direct_db, media_id)
    _register_highlight_cleanup(direct_db, highlight_id)
