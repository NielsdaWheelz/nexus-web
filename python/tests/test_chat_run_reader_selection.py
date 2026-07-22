"""Integration tests for ``create_chat_run`` under the reader-quote contract.

One atomic send creates the conversation (``New``) or inserts into an existing
one, derives the immutable reader-quote snapshot from the locked Highlight, adds
the subject/companion context edges, and persists the user message that carries
the snapshot — all in one commit. A stale revision, a geometry-only/forbidden
Highlight, or a raced ``Empty`` insertion fails the whole send, leaving no run
and an unconsumed idempotency key. Replay of the same key returns the original
conversation and its immutable snapshot even after the live source changes.
"""

from __future__ import annotations

from uuid import UUID

import pytest
from sqlalchemy import func, select, text

from nexus.config import clear_settings_cache
from nexus.db.models import ChatRun, ChatRunTurnContext, Conversation, ResourceEdge
from nexus.schemas.chat_reader_selection import ReaderSelectionKey
from nexus.services.billing_entitlements import grant_entitlement_override
from nexus.services.chat_reader_selection import (
    build_reader_selection_snapshot,
    compute_reader_selection_revision,
)
from tests.factories import (
    create_test_fragment,
    create_test_highlight,
    create_test_media_in_library,
    get_user_default_library,
)
from tests.helpers import auth_headers, create_test_user_id
from tests.utils.db import DirectSessionManager

pytestmark = pytest.mark.integration

_BOGUS_REVISION = "0" * 64


@pytest.fixture(autouse=True)
def platform_key(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test-platform-openai")
    clear_settings_cache()
    yield
    clear_settings_cache()


# =============================================================================
# Helpers
# =============================================================================


def _bootstrap_user(auth_client, direct_db: DirectSessionManager) -> UUID:
    user_id = create_test_user_id()
    auth_client.get("/me", headers=auth_headers(user_id))
    _seed_ai_plus_billing(direct_db, user_id)
    return user_id


def _seed_ai_plus_billing(direct_db: DirectSessionManager, user_id: UUID) -> None:
    direct_db.register_cleanup("billing_entitlement_overrides", "user_id", user_id)
    direct_db.register_cleanup("billing_entitlement_override_events", "user_id", user_id)
    with direct_db.session() as session:
        grant_entitlement_override(
            session,
            user_id=user_id,
            plan_tier="ai_plus",
            platform_token_quota_mode="plan",
            platform_token_limit_monthly=None,
            transcription_quota_mode="plan",
            transcription_minutes_limit_monthly=None,
            expires_at=None,
            reason="reader selection test access",
            actor_label="test",
        )


def _seed_quotable_highlight(
    direct_db: DirectSessionManager,
    author_id: UUID,
    *,
    exact: str = "poolpah",
    title: str = "Skinwalkers",
    content: str | None = None,
    with_revision: bool = True,
) -> tuple[UUID, UUID, str | None]:
    """A readable fragment Highlight in the author's default library.

    Returns ``(media_id, highlight_id, revision)``; ``revision`` is the
    compare-on-send digest for the author (``None`` when ``with_revision`` is
    False, e.g. a geometry-only or cross-owner seed whose send fails before the
    revision check). Cleanup is registered so seeded rows are torn down.
    """
    with direct_db.session() as session:
        library_id = get_user_default_library(session, author_id)
        assert library_id is not None
        media_id = create_test_media_in_library(session, author_id, library_id, title=title)
        fragment_id = create_test_fragment(
            session, media_id, content=content or f"{exact} hit the fan"
        )
        highlight_id = create_test_highlight(session, author_id, fragment_id, exact=exact)
        revision: str | None = None
        if with_revision:
            snapshot = build_reader_selection_snapshot(
                session,
                viewer_id=author_id,
                key=ReaderSelectionKey(media_id=media_id, highlight_id=highlight_id),
            )
            revision = compute_reader_selection_revision(snapshot)
    direct_db.register_cleanup("media", "id", media_id)
    direct_db.register_cleanup("library_entries", "media_id", media_id)
    direct_db.register_cleanup("fragments", "id", fragment_id)
    direct_db.register_cleanup("highlights", "fragment_anchor_fragment_id", fragment_id)
    return media_id, highlight_id, revision


def _new_absent_payload(content: str = "Plain question.") -> dict:
    return {
        "destination": {"kind": "New"},
        "content": content,
        "profile_id": "balanced",
        "reasoning_option_id": "medium",
        "reader_selection": {"kind": "Absent"},
    }


def _new_present_payload(
    *, media_id: UUID, highlight_id: UUID, revision: str, content: str = "Explain this quote."
) -> dict:
    return {
        "destination": {"kind": "New"},
        "content": content,
        "profile_id": "balanced",
        "reasoning_option_id": "medium",
        "reader_selection": {
            "kind": "Present",
            "value": {
                "key": {"media_id": str(media_id), "highlight_id": str(highlight_id)},
                "revision": revision,
            },
        },
    }


def _existing_empty_payload(conversation_id: UUID, content: str = "First message.") -> dict:
    return {
        "destination": {
            "kind": "Existing",
            "conversation_id": str(conversation_id),
            "insertion": {"kind": "Empty"},
        },
        "content": content,
        "profile_id": "balanced",
        "reasoning_option_id": "medium",
        "reader_selection": {"kind": "Absent"},
    }


def _post_chat_run(auth_client, user_id: UUID, payload: dict, idempotency_key: str):
    return auth_client.post(
        "/chat-runs",
        headers={**auth_headers(user_id), "Idempotency-Key": idempotency_key},
        json=payload,
    )


def _register_run(direct_db: DirectSessionManager, user_id: UUID, run_id: UUID, conversation_id):
    direct_db.register_cleanup("resource_edges", "user_id", user_id)
    direct_db.register_cleanup("conversations", "id", conversation_id)
    direct_db.register_cleanup("messages", "conversation_id", conversation_id)
    direct_db.register_cleanup("chat_runs", "id", run_id)
    direct_db.register_cleanup("chat_run_events", "run_id", run_id)
    with direct_db.session() as session:
        for job_id in session.execute(
            text("SELECT id FROM background_jobs WHERE payload->>'run_id' = :run_id"),
            {"run_id": str(run_id)},
        ).scalars():
            direct_db.register_cleanup("background_jobs", "id", job_id)


def _conversation_count(direct_db: DirectSessionManager, user_id: UUID) -> int:
    with direct_db.session() as session:
        return session.scalar(
            select(func.count()).select_from(Conversation).where(
                Conversation.owner_user_id == user_id
            )
        )


def _run_exists_for_key(direct_db: DirectSessionManager, user_id: UUID, key: str) -> bool:
    with direct_db.session() as session:
        return (
            session.scalar(
                select(func.count())
                .select_from(ChatRun)
                .where(ChatRun.owner_user_id == user_id, ChatRun.idempotency_key == key)
            )
            > 0
        )


# =============================================================================
# New destination
# =============================================================================


def test_new_absent_creates_conversation_atomically_without_pre_create(
    auth_client, direct_db: DirectSessionManager
):
    user_id = _bootstrap_user(auth_client, direct_db)

    # No POST /conversations first: New is the atomic launcher for a plain send.
    response = _post_chat_run(auth_client, user_id, _new_absent_payload(), "new-absent")

    assert response.status_code == 200, response.text
    data = response.json()["data"]
    run_id = UUID(data["run"]["id"])
    conversation_id = UUID(data["conversation"]["id"])
    _register_run(direct_db, user_id, run_id, conversation_id)

    assert data["user_message"]["role"] == "user"
    assert data["assistant_message"]["status"] == "pending"
    # A plain send has no reader quote.
    assert data["user_message"]["reader_selection"] == {"kind": "Absent"}
    assert _conversation_count(direct_db, user_id) == 1

    with direct_db.session() as session:
        job_count = session.execute(
            text(
                "SELECT COUNT(*) FROM background_jobs WHERE kind = 'chat_run' "
                "AND payload->>'run_id' = :run_id"
            ),
            {"run_id": str(run_id)},
        ).scalar_one()
        meta_count = session.execute(
            text(
                "SELECT COUNT(*) FROM chat_run_events WHERE run_id = :run_id "
                "AND event_type = 'meta'"
            ),
            {"run_id": run_id},
        ).scalar_one()
    assert job_count == 1, "one chat_run background job is enqueued in the same commit"
    assert meta_count == 1


def test_new_present_carries_snapshot_subject_and_companion(
    auth_client, direct_db: DirectSessionManager
):
    user_id = _bootstrap_user(auth_client, direct_db)
    media_id, highlight_id, revision = _seed_quotable_highlight(direct_db, user_id)

    response = _post_chat_run(
        auth_client,
        user_id,
        _new_present_payload(media_id=media_id, highlight_id=highlight_id, revision=revision),
        "new-present",
    )

    assert response.status_code == 200, response.text
    data = response.json()["data"]
    run_id = UUID(data["run"]["id"])
    conversation_id = UUID(data["conversation"]["id"])
    _register_run(direct_db, user_id, run_id, conversation_id)

    # The user message carries the immutable server-canonical snapshot.
    reader_selection = data["user_message"]["reader_selection"]
    assert reader_selection["kind"] == "Present"
    value = reader_selection["value"]
    assert value["key"] == {"media_id": str(media_id), "highlight_id": str(highlight_id)}
    assert value["exact"] == "poolpah"
    assert value["source_label"] == "“Skinwalkers”"
    assert value["activation"]["kind"] == "route"

    with direct_db.session() as session:
        turn_context = session.get(ChatRunTurnContext, run_id)
        subject_edges = session.execute(
            select(func.count())
            .select_from(ResourceEdge)
            .where(
                ResourceEdge.source_scheme == "conversation",
                ResourceEdge.source_id == conversation_id,
                ResourceEdge.target_scheme == "highlight",
                ResourceEdge.target_id == highlight_id,
                ResourceEdge.kind == "context",
                ResourceEdge.origin == "user",
            )
        ).scalar_one()
        companion_edges = session.execute(
            select(func.count())
            .select_from(ResourceEdge)
            .where(
                ResourceEdge.source_scheme == "conversation",
                ResourceEdge.source_id == conversation_id,
                ResourceEdge.target_scheme == "media",
                ResourceEdge.target_id == media_id,
                ResourceEdge.kind == "context",
                ResourceEdge.origin == "system",
            )
        ).scalar_one()

    # Subject is the derived Highlight; companion is its parent media — both
    # server-derived under the row lock, never client input.
    assert turn_context is not None
    assert turn_context.subject_scheme == "highlight"
    assert turn_context.subject_id == highlight_id
    assert turn_context.requested_subject_scheme == "highlight"
    assert turn_context.subject_context_edge_id is not None
    assert subject_edges == 1
    assert companion_edges == 1


def test_stale_revision_is_rejected_and_leaves_no_run(
    auth_client, direct_db: DirectSessionManager
):
    user_id = _bootstrap_user(auth_client, direct_db)
    media_id, highlight_id, revision = _seed_quotable_highlight(direct_db, user_id)

    response = _post_chat_run(
        auth_client,
        user_id,
        _new_present_payload(
            media_id=media_id, highlight_id=highlight_id, revision=_BOGUS_REVISION
        ),
        "new-present-stale",
    )

    assert response.status_code == 409, response.text
    error = response.json()["error"]
    assert error["code"] == "E_READER_SELECTION_STALE"
    # The conflict carries a fresh preview so the UI can replace the card; the
    # preview's revision is the true current digest, not the bogus one sent.
    assert error["details"]["preview"]["revision"] == revision
    assert error["details"]["preview"]["exact"] == "poolpah"

    # No run row, no conversation: the key stays unconsumed for an explicit resend.
    assert not _run_exists_for_key(direct_db, user_id, "new-present-stale")
    assert _conversation_count(direct_db, user_id) == 0


def test_replay_returns_original_conversation_after_source_mutation(
    auth_client, direct_db: DirectSessionManager
):
    user_id = _bootstrap_user(auth_client, direct_db)
    media_id, highlight_id, revision = _seed_quotable_highlight(direct_db, user_id)

    first = _post_chat_run(
        auth_client,
        user_id,
        _new_present_payload(media_id=media_id, highlight_id=highlight_id, revision=revision),
        "new-present-replay",
    )
    assert first.status_code == 200, first.text
    first_data = first.json()["data"]
    run_id = UUID(first_data["run"]["id"])
    conversation_id = UUID(first_data["conversation"]["id"])
    _register_run(direct_db, user_id, run_id, conversation_id)

    # Mutate the live source: the immutable snapshot must not follow it.
    with direct_db.session() as session:
        session.execute(
            text("UPDATE highlights SET exact = 'mutated' WHERE id = :id"), {"id": highlight_id}
        )
        session.commit()

    # Same idempotency key + same payload identity (revision is not hashed) →
    # replay returns the original run/conversation before any live re-resolution.
    second = _post_chat_run(
        auth_client,
        user_id,
        _new_present_payload(media_id=media_id, highlight_id=highlight_id, revision=revision),
        "new-present-replay",
    )
    assert second.status_code == 200, second.text
    second_data = second.json()["data"]
    assert second_data["run"]["id"] == str(run_id)
    assert second_data["conversation"]["id"] == str(conversation_id)
    # The replayed user message shows the original immutable quote text.
    assert second_data["user_message"]["reader_selection"]["value"]["exact"] == "poolpah"
    assert _conversation_count(direct_db, user_id) == 1, "replay never duplicates the conversation"


# =============================================================================
# Existing.Empty destination
# =============================================================================


def test_existing_empty_creates_root_then_conflicts_when_no_longer_empty(
    auth_client, direct_db: DirectSessionManager
):
    user_id = _bootstrap_user(auth_client, direct_db)
    # The generic resource-context launcher creates the empty conversation.
    create_resp = auth_client.post("/conversations", headers=auth_headers(user_id))
    conversation_id = UUID(create_resp.json()["data"]["id"])

    root = _post_chat_run(
        auth_client, user_id, _existing_empty_payload(conversation_id), "empty-root"
    )
    assert root.status_code == 200, root.text
    root_data = root.json()["data"]
    run_id = UUID(root_data["run"]["id"])
    _register_run(direct_db, user_id, run_id, conversation_id)
    assert root_data["user_message"]["parent_message_id"] is None

    # A second Empty into the now-populated conversation races a real head; the
    # server refuses to silently reply and reports the current active leaf.
    raced = _post_chat_run(
        auth_client, user_id, _existing_empty_payload(conversation_id), "empty-raced"
    )
    assert raced.status_code == 409, raced.text
    error = raced.json()["error"]
    assert error["code"] == "E_CONVERSATION_NO_LONGER_EMPTY"
    assert error["details"]["active_leaf_message_id"] is not None
    assert not _run_exists_for_key(direct_db, user_id, "empty-raced")


# =============================================================================
# NonSendable Highlights never enter the send contract
# =============================================================================


def test_geometry_only_present_send_is_nonsendable_and_leaves_no_run(
    auth_client, direct_db: DirectSessionManager
):
    user_id = _bootstrap_user(auth_client, direct_db)
    # A geometry-only Highlight has a blank resolved quote; the send never
    # reaches the revision check.
    media_id, highlight_id, _ = _seed_quotable_highlight(
        direct_db, user_id, exact="   ", content="    tail", with_revision=False
    )

    response = _post_chat_run(
        auth_client,
        user_id,
        _new_present_payload(
            media_id=media_id, highlight_id=highlight_id, revision=_BOGUS_REVISION
        ),
        "new-present-geometry",
    )

    assert response.status_code == 400, response.text
    assert response.json()["error"]["code"] == "E_READER_SELECTION_GEOMETRY_ONLY"
    assert not _run_exists_for_key(direct_db, user_id, "new-present-geometry")
    assert _conversation_count(direct_db, user_id) == 0


def test_forbidden_present_send_is_nonsendable_and_leaves_no_run(
    auth_client, direct_db: DirectSessionManager
):
    author_id = _bootstrap_user(auth_client, direct_db)
    sender_id = _bootstrap_user(auth_client, direct_db)
    # The Highlight lives only in the author's library; the sender cannot read it.
    media_id, highlight_id, _ = _seed_quotable_highlight(
        direct_db, author_id, with_revision=False
    )

    response = _post_chat_run(
        auth_client,
        sender_id,
        _new_present_payload(
            media_id=media_id, highlight_id=highlight_id, revision=_BOGUS_REVISION
        ),
        "new-present-forbidden",
    )

    assert response.status_code == 403, response.text
    assert response.json()["error"]["code"] == "E_READER_SELECTION_FORBIDDEN"
    assert not _run_exists_for_key(direct_db, sender_id, "new-present-forbidden")
    assert _conversation_count(direct_db, sender_id) == 0
