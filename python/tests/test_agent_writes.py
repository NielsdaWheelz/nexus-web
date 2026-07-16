"""Integration + unit tests for the Amanuensis assistant write tools.

Service-level tests seed committed users/media/libraries via ``direct_db`` and
drive the write tools through ``writes.execute_write_tool`` with a lightweight
run stand-in (the loop's ``persist_tool_call_start`` is not needed — the write
persister inserts its own row). Undo, cap, and quote-ambiguity are covered here;
``text_quote`` + policy shape are pinned as pure units.
"""

from __future__ import annotations

from types import SimpleNamespace
from uuid import UUID, uuid4

import pytest
from sqlalchemy import text

from nexus.errors import ApiError, InvalidRequestError
from nexus.services import text_quote
from nexus.services.agent_tools import writes
from nexus.services.resource_graph.policy import validate_edge_shape
from nexus.services.resource_graph.refs import ResourceRef
from nexus.services.resource_graph.schemas import CitationSnapshot, EdgeCreate
from tests import factories
from tests.utils.db import DirectSessionManager

pytestmark = pytest.mark.integration


def _seed_user(direct_db: DirectSessionManager) -> UUID:
    user_id = uuid4()
    with direct_db.session() as session:
        session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
        session.commit()
    direct_db.register_cleanup("users", "id", user_id)
    return user_id


def _seed_run(direct_db: DirectSessionManager, user_id: UUID) -> SimpleNamespace:
    conversation_id = uuid4()
    user_message_id = uuid4()
    assistant_message_id = uuid4()
    with direct_db.session() as session:
        session.execute(
            text(
                "INSERT INTO conversations (id, owner_user_id, sharing, next_seq)"
                " VALUES (:id, :owner, 'private', 3)"
            ),
            {"id": conversation_id, "owner": user_id},
        )
        session.execute(
            text(
                """
                INSERT INTO messages (id, conversation_id, seq, role, content, status,
                                      parent_message_id)
                VALUES
                  (:um, :conv, 1, 'user', 'hi', 'complete', null),
                  (:am, :conv, 2, 'assistant', '', 'pending', :um)
                """
            ),
            {"um": user_message_id, "am": assistant_message_id, "conv": conversation_id},
        )
        session.commit()
    direct_db.register_cleanup("message_tool_calls", "conversation_id", conversation_id)
    direct_db.register_cleanup("conversations", "id", conversation_id)
    direct_db.register_cleanup("messages", "conversation_id", conversation_id)
    return SimpleNamespace(
        owner_user_id=user_id,
        conversation_id=conversation_id,
        user_message_id=user_message_id,
        assistant_message_id=assistant_message_id,
    )


def _seed_readable_media(
    direct_db: DirectSessionManager, user_id: UUID, *, title: str, canonical_text: str
) -> tuple[UUID, UUID]:
    with direct_db.session() as session:
        library_id = factories.create_test_library(session, user_id, name=f"Lib {title}")
        media_id = factories.create_test_media_in_library(session, user_id, library_id, title=title)
        fragment_id = factories.create_test_fragment(session, media_id, content=canonical_text)
    direct_db.register_cleanup("resource_edges", "user_id", user_id)
    direct_db.register_cleanup("highlights", "user_id", user_id)
    direct_db.register_cleanup("library_entries", "media_id", media_id)
    direct_db.register_cleanup("fragments", "id", fragment_id)
    direct_db.register_cleanup("media", "id", media_id)
    direct_db.register_cleanup("memberships", "library_id", library_id)
    direct_db.register_cleanup("libraries", "id", library_id)
    # Registered LAST so LIFO teardown deletes the Lectern rows BEFORE their media:
    # migration 0181 made the consumption_queue_items -> media FK non-cascading, so
    # the row no longer disappears with its media.
    direct_db.register_cleanup("consumption_queue_items", "media_id", media_id)
    return media_id, library_id


# ---------------------------------------------------------------------------
# Pure units
# ---------------------------------------------------------------------------


def test_validate_assistant_rejects_bad_shape():
    good = EdgeCreate(
        source=ResourceRef(scheme="media", id=uuid4()),
        target=ResourceRef(scheme="page", id=uuid4()),
        kind="context",
        origin="assistant",
        snapshot=CitationSnapshot(excerpt="because"),
    )
    validate_edge_shape(good)  # no raise

    with pytest.raises(InvalidRequestError):
        validate_edge_shape(
            EdgeCreate(
                source=ResourceRef(scheme="media", id=uuid4()),
                target=ResourceRef(scheme="page", id=uuid4()),
                kind="context",
                origin="assistant",
                snapshot=CitationSnapshot(excerpt="   "),
            )
        )
    with pytest.raises(InvalidRequestError):
        validate_edge_shape(
            EdgeCreate(
                source=ResourceRef(scheme="media", id=uuid4()),
                target=ResourceRef(scheme="page", id=uuid4()),
                kind="context",
                origin="assistant",
                snapshot=None,
            )
        )
    with pytest.raises(InvalidRequestError):
        validate_edge_shape(
            EdgeCreate(
                source=ResourceRef(scheme="media", id=uuid4()),
                target=ResourceRef(scheme="evidence_span", id=uuid4()),
                kind="context",
                origin="assistant",
                snapshot=CitationSnapshot(excerpt="x"),
            )
        )
    with pytest.raises(InvalidRequestError):
        validate_edge_shape(
            EdgeCreate(
                source=ResourceRef(scheme="media", id=uuid4()),
                target=ResourceRef(scheme="page", id=uuid4()),
                kind="context",
                origin="assistant",
                ordinal=3,
                snapshot=CitationSnapshot(excerpt="x"),
            )
        )


def test_flag_off_omits_write_tools(monkeypatch):
    from nexus import config

    monkeypatch.setattr(
        config.get_settings(), "assistant_write_tools_enabled", False, raising=False
    )
    assert writes.assistant_write_tool_definitions() == ()


def test_text_quote_resolution_paths(direct_db):
    user_id = _seed_user(direct_db)
    canonical = "The cat sat. The entropy of the system rose. The cat sat again."
    media_id, _ = _seed_readable_media(direct_db, user_id, title="Quote", canonical_text=canonical)
    with direct_db.session() as session:
        unique = text_quote.resolve(session, media_id=media_id, exact="entropy of the system")
        assert unique.status is text_quote.QuoteStatus.unique
        assert unique.fragment_id is not None
        assert canonical[unique.start_offset : unique.end_offset] == "entropy of the system"

        ambiguous = text_quote.resolve(session, media_id=media_id, exact="The cat sat")
        assert ambiguous.status is text_quote.QuoteStatus.ambiguous
        assert ambiguous.fragment_id is None

        disambiguated = text_quote.resolve(
            session, media_id=media_id, exact="The cat sat", suffix=" again"
        )
        assert disambiguated.status is text_quote.QuoteStatus.unique

        missing = text_quote.resolve(session, media_id=media_id, exact="no such phrase")
        assert missing.status is text_quote.QuoteStatus.no_match


# ---------------------------------------------------------------------------
# Tool round-trips
# ---------------------------------------------------------------------------


def test_mint_edge_creates_assistant_origin_edge(direct_db):
    user_id = _seed_user(direct_db)
    run = _seed_run(direct_db, user_id)
    media_a, _ = _seed_readable_media(direct_db, user_id, title="A", canonical_text="alpha text")
    media_b, _ = _seed_readable_media(direct_db, user_id, title="B", canonical_text="beta text")

    with direct_db.session() as session:
        outcome = writes.execute_write_tool(
            session,
            run=run,
            tool_call_index=0,
            tool_name=writes.MINT_EDGE_TOOL_NAME,
            args={
                "source_uri": f"media:{media_a}",
                "target_uri": f"media:{media_b}",
                "rationale": "these rhyme",
            },
        )
        assert not outcome.is_error
        edge = (
            session.execute(
                text(
                    "SELECT origin, snapshot->>'excerpt' AS excerpt, ordinal"
                    " FROM resource_edges WHERE user_id = :u AND origin = 'assistant'"
                ),
                {"u": user_id},
            )
            .mappings()
            .one()
        )
        assert edge["origin"] == "assistant"
        assert edge["excerpt"] == "these rhyme"
        assert edge["ordinal"] is None
        refs = session.execute(
            text("SELECT result_refs FROM message_tool_calls WHERE id = :id"),
            {"id": outcome.tool_call_id},
        ).scalar_one()
        assert refs[0]["kind"] == "edge"
        # §2/§7 trail row needs endpoint labels, not just the rationale.
        assert isinstance(refs[0].get("source_label"), str) and refs[0]["source_label"]
        assert isinstance(refs[0].get("target_label"), str) and refs[0]["target_label"]


def test_add_to_library_files_entry(direct_db):
    user_id = _seed_user(direct_db)
    run = _seed_run(direct_db, user_id)
    media_id, _ = _seed_readable_media(direct_db, user_id, title="Doc", canonical_text="content")
    with direct_db.session() as session:
        target_library = factories.create_test_library(session, user_id, name="Criticism")
    direct_db.register_cleanup("library_entries", "library_id", target_library)
    direct_db.register_cleanup("memberships", "library_id", target_library)
    direct_db.register_cleanup("libraries", "id", target_library)

    with direct_db.session() as session:
        outcome = writes.execute_write_tool(
            session,
            run=run,
            tool_call_index=0,
            tool_name=writes.ADD_TO_LIBRARY_TOOL_NAME,
            args={"resource_uri": f"media:{media_id}", "library_name": "Criticism"},
        )
        assert not outcome.is_error
        count = session.execute(
            text(
                "SELECT count(*) FROM library_entries WHERE library_id = :lib AND media_id = :media"
            ),
            {"lib": target_library, "media": media_id},
        ).scalar_one()
        assert count == 1


def test_create_highlight_unique_and_ambiguous(direct_db):
    user_id = _seed_user(direct_db)
    run = _seed_run(direct_db, user_id)
    canonical = "The cat sat. The entropy of the system rose. The cat sat again."
    media_id, _ = _seed_readable_media(direct_db, user_id, title="H", canonical_text=canonical)

    with direct_db.session() as session:
        ok = writes.execute_write_tool(
            session,
            run=run,
            tool_call_index=0,
            tool_name=writes.CREATE_HIGHLIGHT_TOOL_NAME,
            args={"media_uri": f"media:{media_id}", "exact": "entropy of the system"},
        )
        assert not ok.is_error
        highlight_count = session.execute(
            text("SELECT count(*) FROM highlights WHERE user_id = :u"), {"u": user_id}
        ).scalar_one()
        assert highlight_count == 1

        refused = writes.execute_write_tool(
            session,
            run=run,
            tool_call_index=1,
            tool_name=writes.CREATE_HIGHLIGHT_TOOL_NAME,
            args={"media_uri": f"media:{media_id}", "exact": "The cat sat"},
        )
        assert refused.is_error
        assert refused.error_code == "quote_not_unique"
        still_one = session.execute(
            text("SELECT count(*) FROM highlights WHERE user_id = :u"), {"u": user_id}
        ).scalar_one()
        assert still_one == 1


def test_jot_note_appends_to_daily(direct_db):
    user_id = _seed_user(direct_db)
    run = _seed_run(direct_db, user_id)
    direct_db.register_cleanup("note_blocks", "user_id", user_id)
    direct_db.register_cleanup("pages", "user_id", user_id)
    with direct_db.session() as session:
        outcome = writes.execute_write_tool(
            session,
            run=run,
            tool_call_index=0,
            tool_name=writes.JOT_NOTE_TOOL_NAME,
            args={"markdown": "remember this"},
        )
        assert not outcome.is_error
        blocks = session.execute(
            text("SELECT count(*) FROM note_blocks WHERE user_id = :u"), {"u": user_id}
        ).scalar_one()
        assert blocks == 1


def test_queue_add_marks_assistant_source(direct_db):
    user_id = _seed_user(direct_db)
    run = _seed_run(direct_db, user_id)
    media_id, _ = _seed_readable_media(direct_db, user_id, title="Q", canonical_text="queue me")
    with direct_db.session() as session:
        outcome = writes.execute_write_tool(
            session,
            run=run,
            tool_call_index=0,
            tool_name=writes.QUEUE_ADD_TOOL_NAME,
            args={"media_uri": f"media:{media_id}"},
        )
        assert not outcome.is_error
        source = session.execute(
            text("SELECT source FROM consumption_queue_items WHERE user_id = :u AND media_id = :m"),
            {"u": user_id, "m": media_id},
        ).scalar_one()
        assert source == "assistant"


def test_undo_reverts_edge_and_is_idempotent(direct_db):
    user_id = _seed_user(direct_db)
    run = _seed_run(direct_db, user_id)
    media_a, _ = _seed_readable_media(direct_db, user_id, title="UA", canonical_text="a")
    media_b, _ = _seed_readable_media(direct_db, user_id, title="UB", canonical_text="b")

    with direct_db.session() as session:
        outcome = writes.execute_write_tool(
            session,
            run=run,
            tool_call_index=0,
            tool_name=writes.MINT_EDGE_TOOL_NAME,
            args={
                "source_uri": f"media:{media_a}",
                "target_uri": f"media:{media_b}",
                "rationale": "temp",
            },
        )
        tool_call_id = outcome.tool_call_id

    with direct_db.session() as session:
        writes.undo_tool_call(
            session,
            viewer_id=user_id,
            conversation_id=run.conversation_id,
            tool_call_id=tool_call_id,
        )
        remaining = session.execute(
            text("SELECT count(*) FROM resource_edges WHERE user_id = :u AND origin = 'assistant'"),
            {"u": user_id},
        ).scalar_one()
        assert remaining == 0
        reverted_at = session.execute(
            text("SELECT reverted_at FROM message_tool_calls WHERE id = :id"),
            {"id": tool_call_id},
        ).scalar_one()
        assert reverted_at is not None

    # Second undo is a no-op success.
    with direct_db.session() as session:
        writes.undo_tool_call(
            session,
            viewer_id=user_id,
            conversation_id=run.conversation_id,
            tool_call_id=tool_call_id,
        )


def test_cap_enforced_and_reclaimed_by_undo(direct_db):
    user_id = _seed_user(direct_db)
    run = _seed_run(direct_db, user_id)
    direct_db.register_cleanup("note_blocks", "user_id", user_id)
    direct_db.register_cleanup("pages", "user_id", user_id)

    last_tool_call_id = None
    with direct_db.session() as session:
        for index in range(writes.ASSISTANT_MAX_WRITES_PER_RUN):
            outcome = writes.execute_write_tool(
                session,
                run=run,
                tool_call_index=index,
                tool_name=writes.JOT_NOTE_TOOL_NAME,
                args={"markdown": f"note {index}"},
            )
            assert not outcome.is_error
            last_tool_call_id = outcome.tool_call_id

        # The ninth write refuses.
        capped = writes.execute_write_tool(
            session,
            run=run,
            tool_call_index=99,
            tool_name=writes.JOT_NOTE_TOOL_NAME,
            args={"markdown": "over the line"},
        )
        assert capped.is_error
        assert capped.error_code == "write_cap_reached"

    # Undo one committed write; the ninth now succeeds (budget reclaimed).
    with direct_db.session() as session:
        writes.undo_tool_call(
            session,
            viewer_id=user_id,
            conversation_id=run.conversation_id,
            tool_call_id=last_tool_call_id,
        )
    with direct_db.session() as session:
        after = writes.execute_write_tool(
            session,
            run=run,
            tool_call_index=100,
            tool_name=writes.JOT_NOTE_TOOL_NAME,
            args={"markdown": "now allowed"},
        )
        assert not after.is_error


def _file_to_library(direct_db, run, media_id, library_id) -> object:
    with direct_db.session() as session:
        return writes.execute_write_tool(
            session,
            run=run,
            tool_call_index=0,
            tool_name=writes.ADD_TO_LIBRARY_TOOL_NAME,
            args={"resource_uri": f"media:{media_id}", "library_id": str(library_id)},
        )


def test_undo_removes_assistant_entry(direct_db):
    user_id = _seed_user(direct_db)
    run = _seed_run(direct_db, user_id)
    media_id, _ = _seed_readable_media(direct_db, user_id, title="Doc", canonical_text="content")
    with direct_db.session() as session:
        target_library = factories.create_test_library(session, user_id, name="Criticism")
    direct_db.register_cleanup("library_entries", "library_id", target_library)
    direct_db.register_cleanup("memberships", "library_id", target_library)
    direct_db.register_cleanup("libraries", "id", target_library)

    outcome = _file_to_library(direct_db, run, media_id, target_library)
    assert not outcome.is_error
    assert [ref["kind"] for ref in outcome.created_refs] == ["entry"]

    with direct_db.session() as session:
        writes.undo_tool_call(
            session,
            viewer_id=user_id,
            conversation_id=run.conversation_id,
            tool_call_id=outcome.tool_call_id,
        )
        count = session.execute(
            text(
                "SELECT count(*) FROM library_entries WHERE library_id = :lib AND media_id = :media"
            ),
            {"lib": target_library, "media": media_id},
        ).scalar_one()
        assert count == 0


def test_add_to_library_preexisting_entry_survives_undo(direct_db):
    """R-5: filing an already-present media records no ref, so Undo cannot delete
    the user's own manual filing."""
    user_id = _seed_user(direct_db)
    run = _seed_run(direct_db, user_id)
    media_id, _ = _seed_readable_media(direct_db, user_id, title="Doc", canonical_text="content")
    with direct_db.session() as session:
        target_library = factories.create_test_library(session, user_id, name="Criticism")
        factories.add_library_entry_only(session, target_library, media_id)  # user's own filing
        session.commit()
    direct_db.register_cleanup("library_entries", "library_id", target_library)
    direct_db.register_cleanup("memberships", "library_id", target_library)
    direct_db.register_cleanup("libraries", "id", target_library)

    outcome = _file_to_library(direct_db, run, media_id, target_library)
    assert not outcome.is_error
    assert outcome.created_refs == []  # nothing to undo — the entry pre-existed

    with direct_db.session() as session:
        writes.undo_tool_call(
            session,
            viewer_id=user_id,
            conversation_id=run.conversation_id,
            tool_call_id=outcome.tool_call_id,
        )
        count = session.execute(
            text(
                "SELECT count(*) FROM library_entries WHERE library_id = :lib AND media_id = :media"
            ),
            {"lib": target_library, "media": media_id},
        ).scalar_one()
        assert count == 1  # the user's manual filing is preserved


def test_undo_reverts_highlight_and_attached_note(direct_db):
    user_id = _seed_user(direct_db)
    run = _seed_run(direct_db, user_id)
    direct_db.register_cleanup("note_blocks", "user_id", user_id)
    direct_db.register_cleanup("pages", "user_id", user_id)
    canonical = "The entropy of the system rose."
    media_id, _ = _seed_readable_media(direct_db, user_id, title="H", canonical_text=canonical)

    with direct_db.session() as session:
        outcome = writes.execute_write_tool(
            session,
            run=run,
            tool_call_index=0,
            tool_name=writes.CREATE_HIGHLIGHT_TOOL_NAME,
            args={
                "media_uri": f"media:{media_id}",
                "exact": "entropy of the system",
                "note": "worth revisiting",
            },
        )
        assert not outcome.is_error
        assert {ref["kind"] for ref in outcome.created_refs} == {"highlight", "note_block"}

    with direct_db.session() as session:
        writes.undo_tool_call(
            session,
            viewer_id=user_id,
            conversation_id=run.conversation_id,
            tool_call_id=outcome.tool_call_id,
        )
        highlights_left = session.execute(
            text("SELECT count(*) FROM highlights WHERE user_id = :u"), {"u": user_id}
        ).scalar_one()
        notes_left = session.execute(
            text("SELECT count(*) FROM note_blocks WHERE user_id = :u"), {"u": user_id}
        ).scalar_one()
        assert highlights_left == 0
        assert notes_left == 0


def test_undo_reverts_queue_item(direct_db):
    user_id = _seed_user(direct_db)
    run = _seed_run(direct_db, user_id)
    media_id, _ = _seed_readable_media(direct_db, user_id, title="Q", canonical_text="queue me")

    with direct_db.session() as session:
        outcome = writes.execute_write_tool(
            session,
            run=run,
            tool_call_index=0,
            tool_name=writes.QUEUE_ADD_TOOL_NAME,
            args={"media_uri": f"media:{media_id}"},
        )
        assert not outcome.is_error

    with direct_db.session() as session:
        writes.undo_tool_call(
            session,
            viewer_id=user_id,
            conversation_id=run.conversation_id,
            tool_call_id=outcome.tool_call_id,
        )
        left = session.execute(
            text(
                "SELECT count(*) FROM consumption_queue_items WHERE user_id = :u AND media_id = :m"
            ),
            {"u": user_id, "m": media_id},
        ).scalar_one()
        assert left == 0


def test_undo_rejects_tool_call_of_another_conversation(direct_db):
    """§6: undo is scoped to the path conversation; a mismatched id is a 404."""
    user_id = _seed_user(direct_db)
    run = _seed_run(direct_db, user_id)
    media_a, _ = _seed_readable_media(direct_db, user_id, title="WA", canonical_text="a")
    media_b, _ = _seed_readable_media(direct_db, user_id, title="WB", canonical_text="b")

    with direct_db.session() as session:
        outcome = writes.execute_write_tool(
            session,
            run=run,
            tool_call_index=0,
            tool_name=writes.MINT_EDGE_TOOL_NAME,
            args={
                "source_uri": f"media:{media_a}",
                "target_uri": f"media:{media_b}",
                "rationale": "linked",
            },
        )

    with direct_db.session() as session:
        with pytest.raises(ApiError):
            writes.undo_tool_call(
                session,
                viewer_id=user_id,
                conversation_id=uuid4(),  # not this tool call's conversation
                tool_call_id=outcome.tool_call_id,
            )
        remaining = session.execute(
            text("SELECT count(*) FROM resource_edges WHERE user_id = :u AND origin = 'assistant'"),
            {"u": user_id},
        ).scalar_one()
        assert remaining == 1  # untouched — the mismatched undo did not revert it
