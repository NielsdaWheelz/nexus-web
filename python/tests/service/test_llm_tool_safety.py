"""Priority proof: every mutating LLM tool is owner-gated and reversible."""

from __future__ import annotations

from uuid import UUID, uuid4

import pytest
from sqlalchemy import Engine, text
from sqlalchemy.orm import Session

from nexus.db.models import (
    ChatRun,
    Conversation,
    Fragment,
    Media,
    MediaKind,
    Message,
    ProcessingStatus,
)
from nexus.errors import ApiError, ApiErrorCode
from nexus.schemas.library import CreateLibraryRequest
from nexus.schemas.notes import CreatePageRequest
from nexus.services import bootstrap, library_entries, library_governance, notes
from nexus.services.agent_tools import writes


def _create_chat_run(db: Session, user_id: UUID) -> ChatRun:
    conversation = Conversation(
        id=uuid4(),
        owner_user_id=user_id,
        title="Tool safety proof",
        sharing="private",
        next_seq=3,
    )
    db.add(conversation)
    db.flush()
    user_message = Message(
        id=uuid4(),
        conversation_id=conversation.id,
        seq=1,
        role="user",
        content="Please make these changes.",
        status="complete",
    )
    db.add(user_message)
    db.flush()
    assistant_message = Message(
        id=uuid4(),
        conversation_id=conversation.id,
        seq=2,
        role="assistant",
        content="",
        status="pending",
        parent_message_id=user_message.id,
    )
    db.add(assistant_message)
    db.flush()
    run = ChatRun(
        id=uuid4(),
        owner_user_id=user_id,
        conversation_id=conversation.id,
        user_message_id=user_message.id,
        assistant_message_id=assistant_message.id,
        idempotency_key=f"tool-safety-{uuid4()}",
        payload_hash=uuid4().hex,
        status="running",
    )
    db.add(run)
    db.commit()
    return run


def _create_readable_media(
    db: Session,
    *,
    user_id: UUID,
    default_library_id: UUID,
    title: str,
    canonical_text: str,
) -> UUID:
    media = Media(
        id=uuid4(),
        kind=MediaKind.web_article.value,
        title=title,
        canonical_source_url=f"https://example.invalid/{uuid4()}",
        processing_status=ProcessingStatus.ready_for_reading,
        created_by_user_id=user_id,
    )
    db.add(media)
    db.flush()
    db.add(
        Fragment(
            id=uuid4(),
            media_id=media.id,
            idx=0,
            canonical_text=canonical_text,
            html_sanitized=f"<p>{canonical_text}</p>",
        )
    )
    db.flush()
    assert library_entries.ensure_media_in_default_library(db, user_id, media.id)
    db.commit()
    assert default_library_id == bootstrap.ensure_user_and_default_library(db, user_id)
    return media.id


def _unauthorized_domain_counts(
    db: Session,
    *,
    owner_id: UUID,
    foreign_library_id: UUID,
    owner_media_id: UUID,
) -> tuple[int, ...]:
    return (
        int(
            db.scalar(
                text(
                    "SELECT COUNT(*) FROM library_entries "
                    "WHERE library_id = :library_id AND media_id = :media_id"
                ),
                {"library_id": foreign_library_id, "media_id": owner_media_id},
            )
            or 0
        ),
        int(
            db.scalar(
                text("SELECT COUNT(*) FROM note_blocks WHERE user_id = :user_id"),
                {"user_id": owner_id},
            )
            or 0
        ),
        int(
            db.scalar(
                text("SELECT COUNT(*) FROM highlights WHERE user_id = :user_id"),
                {"user_id": owner_id},
            )
            or 0
        ),
        int(
            db.scalar(
                text(
                    "SELECT COUNT(*) FROM resource_edges "
                    "WHERE user_id = :user_id AND origin = 'assistant'"
                ),
                {"user_id": owner_id},
            )
            or 0
        ),
        int(
            db.scalar(
                text("SELECT COUNT(*) FROM consumption_queue_items WHERE user_id = :user_id"),
                {"user_id": owner_id},
            )
            or 0
        ),
        int(
            db.scalar(
                text("SELECT COUNT(*) FROM resource_mutations WHERE user_id = :user_id"),
                {"user_id": owner_id},
            )
            or 0
        ),
    )


def test_all_mutating_tools_enforce_owner_persistence_and_idempotent_undo(
    engine: Engine,
) -> None:
    owner_id = uuid4()
    foreign_id = uuid4()
    with Session(engine, expire_on_commit=False) as db:
        owner_default = bootstrap.ensure_user_and_default_library(
            db,
            owner_id,
            f"tool-owner-{owner_id}@example.invalid",
        )
        foreign_default = bootstrap.ensure_user_and_default_library(
            db,
            foreign_id,
            f"tool-foreign-{foreign_id}@example.invalid",
        )
        target_library_id = uuid4()
        library_governance.create_library(
            db,
            owner_id,
            CreateLibraryRequest(library_id=target_library_id, name="Filed by assistant"),
        )
        foreign_library_id = uuid4()
        library_governance.create_library(
            db,
            foreign_id,
            CreateLibraryRequest(library_id=foreign_library_id, name="Foreign library"),
        )
        owner_page_id = uuid4()
        notes.create_page(
            db,
            owner_id,
            CreatePageRequest(page_id=owner_page_id, title="Owned page"),
        )
        foreign_page_id = uuid4()
        notes.create_page(
            db,
            foreign_id,
            CreatePageRequest(page_id=foreign_page_id, title="Foreign page"),
        )
        quote_media_id = _create_readable_media(
            db,
            user_id=owner_id,
            default_library_id=owner_default,
            title="Owned quote source",
            canonical_text="Alpha. The unique passage belongs here. Omega.",
        )
        edge_media_id = _create_readable_media(
            db,
            user_id=owner_id,
            default_library_id=owner_default,
            title="Owned edge target",
            canonical_text="A second owned document.",
        )
        queue_media_id = _create_readable_media(
            db,
            user_id=owner_id,
            default_library_id=owner_default,
            title="Owned queue target",
            canonical_text="An owned item to read later.",
        )
        foreign_media_id = _create_readable_media(
            db,
            user_id=foreign_id,
            default_library_id=foreign_default,
            title="Foreign resource",
            canonical_text="This content belongs to another account.",
        )
        run = _create_chat_run(db, owner_id)

        successful_cases = (
            (
                writes.ADD_TO_LIBRARY_TOOL_NAME,
                {
                    "resource_uri": f"media:{quote_media_id}",
                    "library_id": str(target_library_id),
                    "library_name": None,
                },
                "entry",
            ),
            (
                writes.JOT_NOTE_TOOL_NAME,
                {"markdown": "Remember this connection.", "page_uri": f"page:{owner_page_id}"},
                "note_block",
            ),
            (
                writes.CREATE_HIGHLIGHT_TOOL_NAME,
                {
                    "media_uri": f"media:{quote_media_id}",
                    "exact": "The unique passage belongs here.",
                    "prefix": None,
                    "suffix": None,
                    "color": "yellow",
                    "note": None,
                },
                "highlight",
            ),
            (
                writes.MINT_EDGE_TOOL_NAME,
                {
                    "source_uri": f"media:{quote_media_id}",
                    "target_uri": f"media:{edge_media_id}",
                    "kind": "context",
                    "rationale": "The reader asked to connect them.",
                },
                "edge",
            ),
            (
                writes.QUEUE_ADD_TOOL_NAME,
                {"media_uri": f"media:{queue_media_id}"},
                "queue",
            ),
        )
        successful = tuple(
            writes.execute_write_tool(
                db,
                run=run,
                tool_call_index=index,
                tool_name=tool_name,
                args=args,
            )
            for index, (tool_name, args, _kind) in enumerate(successful_cases)
        )

        assert tuple(outcome.status for outcome in successful) == ("complete",) * 5
        assert tuple(
            tuple(ref["kind"] for ref in outcome.created_refs) for outcome in successful
        ) == tuple((kind,) for _name, _args, kind in successful_cases), (
            "the five write classes did not persist their exact reversible resource identity"
        )
        persisted_success = db.execute(
            text(
                """
                SELECT tool_name, tool_call_index, status, error_code, result_refs
                FROM message_tool_calls
                WHERE assistant_message_id = :assistant_message_id
                  AND tool_call_index < 5
                ORDER BY tool_call_index
                """
            ),
            {"assistant_message_id": run.assistant_message_id},
        ).all()
        assert tuple(
            (row.tool_name, row.tool_call_index, row.status, row.error_code, row.result_refs)
            for row in persisted_success
        ) == tuple(
            (name, index, "complete", None, outcome.created_refs)
            for index, ((name, _args, _kind), outcome) in enumerate(
                zip(successful_cases, successful, strict=True)
            )
        ), "write-tool trust records diverged from their committed domain effects"

        for outcome in successful:
            with pytest.raises(ApiError) as denied:
                writes.undo_tool_call(
                    db,
                    viewer_id=foreign_id,
                    conversation_id=run.conversation_id,
                    tool_call_id=outcome.tool_call_id,
                )
            assert denied.value.code == ApiErrorCode.E_NOT_FOUND

        for outcome in successful:
            first_undo = writes.undo_tool_call(
                db,
                viewer_id=owner_id,
                conversation_id=run.conversation_id,
                tool_call_id=outcome.tool_call_id,
            )
            second_undo = writes.undo_tool_call(
                db,
                viewer_id=owner_id,
                conversation_id=run.conversation_id,
                tool_call_id=outcome.tool_call_id,
            )
            assert first_undo == second_undo == run.assistant_message_id

        created = tuple(outcome.created_refs[0] for outcome in successful)
        assert (
            db.scalar(
                text(
                    "SELECT COUNT(*) FROM library_entries "
                    "WHERE library_id = :library_id AND media_id = :media_id"
                ),
                {"library_id": target_library_id, "media_id": quote_media_id},
            )
            == 0
        )
        assert (
            db.scalar(
                text("SELECT COUNT(*) FROM note_blocks WHERE id = :id"),
                {"id": UUID(str(created[1]["id"]))},
            )
            == 0
        )
        assert (
            db.scalar(
                text("SELECT COUNT(*) FROM highlights WHERE id = :id"),
                {"id": UUID(str(created[2]["id"]))},
            )
            == 0
        )
        assert (
            db.scalar(
                text("SELECT COUNT(*) FROM resource_edges WHERE id = :id"),
                {"id": UUID(str(created[3]["id"]))},
            )
            == 0
        )
        assert (
            db.scalar(
                text("SELECT COUNT(*) FROM consumption_queue_items WHERE id = :id"),
                {"id": UUID(str(created[4]["id"]))},
            )
            == 0
        )
        assert db.execute(
            text(
                """
                SELECT COUNT(*), COUNT(reverted_at)
                FROM message_tool_calls
                WHERE assistant_message_id = :assistant_message_id
                  AND tool_call_index < 5
                """
            ),
            {"assistant_message_id": run.assistant_message_id},
        ).one() == (5, 5), "undo did not durably mark every write class as reverted"

        before_denials = _unauthorized_domain_counts(
            db,
            owner_id=owner_id,
            foreign_library_id=foreign_library_id,
            owner_media_id=quote_media_id,
        )
        foreign_cases = (
            (
                writes.ADD_TO_LIBRARY_TOOL_NAME,
                {
                    "resource_uri": f"media:{quote_media_id}",
                    "library_id": str(foreign_library_id),
                    "library_name": None,
                },
                ApiErrorCode.E_LIBRARY_NOT_FOUND.value,
            ),
            (
                writes.JOT_NOTE_TOOL_NAME,
                {"markdown": "Do not write this.", "page_uri": f"page:{foreign_page_id}"},
                ApiErrorCode.E_NOT_FOUND.value,
            ),
            (
                writes.CREATE_HIGHLIGHT_TOOL_NAME,
                {
                    "media_uri": f"media:{foreign_media_id}",
                    "exact": "This content belongs to another account.",
                    "prefix": None,
                    "suffix": None,
                    "color": None,
                    "note": None,
                },
                ApiErrorCode.E_NOT_FOUND.value,
            ),
            (
                writes.MINT_EDGE_TOOL_NAME,
                {
                    "source_uri": f"media:{quote_media_id}",
                    "target_uri": f"media:{foreign_media_id}",
                    "kind": "context",
                    "rationale": "This must remain private.",
                },
                ApiErrorCode.E_NOT_FOUND.value,
            ),
            (
                writes.QUEUE_ADD_TOOL_NAME,
                {"media_uri": f"media:{foreign_media_id}"},
                ApiErrorCode.E_NOT_FOUND.value,
            ),
        )
        denied_outcomes = tuple(
            writes.execute_write_tool(
                db,
                run=run,
                tool_call_index=10 + index,
                tool_name=tool_name,
                args=args,
            )
            for index, (tool_name, args, _error_code) in enumerate(foreign_cases)
        )

        assert tuple(
            (outcome.status, outcome.error_code, outcome.created_refs)
            for outcome in denied_outcomes
        ) == tuple(("error", error_code, []) for _name, _args, error_code in foreign_cases), (
            "one or more mutating tool classes did not fail closed on a foreign target"
        )
        assert (
            _unauthorized_domain_counts(
                db,
                owner_id=owner_id,
                foreign_library_id=foreign_library_id,
                owner_media_id=quote_media_id,
            )
            == before_denials
        ), "a refused mutating tool changed durable product state"
        persisted_denials = db.execute(
            text(
                """
                SELECT tool_name, tool_call_index, status, error_code, result_refs
                FROM message_tool_calls
                WHERE assistant_message_id = :assistant_message_id
                  AND tool_call_index >= 10
                ORDER BY tool_call_index
                """
            ),
            {"assistant_message_id": run.assistant_message_id},
        ).all()
        assert tuple(
            (row.tool_name, row.tool_call_index, row.status, row.error_code, row.result_refs)
            for row in persisted_denials
        ) == tuple(
            (name, 10 + index, "error", error_code, [])
            for index, (name, _args, error_code) in enumerate(foreign_cases)
        ), "authorization refusals were not persisted as exact trust-trail records"
