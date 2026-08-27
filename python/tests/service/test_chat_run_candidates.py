"""Priority proof: completed-answer regeneration creates a faithful, eligibility-
gated sibling candidate exactly once.

Risk (costly + destructive effects, §4): a regeneration enqueues one new billable
durable `ChatRun` and mutates the conversation branch tree. It must never (a)
overwrite or lose the original user/assistant turn, (b) dispatch for an
ineligible source (write-tool attempt, profile-target drift, or a non-completed
turn — spec §3 non-goals, AC-11), (c) duplicate on exact idempotent replay or
silently reuse a key across a different source/operation (AC-12), or (d) act on
another viewer's message (privacy). The independent oracle is the governing
cutover contract's §5.4/§8 precondition list, never the implementation output.

Real stack: real PostgreSQL, the production bootstrap/billing/queue owners via
`create_entitled_chat`, and the real terminal fold (`mark_running` +
`finalize_run`) to reach a genuinely completed run. Isolation is by a unique
per-scenario user id; each owner API commits on its own connection. Exact
synthetic queue rows are removed after each proof because Chat priority is a
deliberately global single-host admission rule.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal
from uuid import UUID, uuid4

import pytest
from fastapi.testclient import TestClient
from pydantic import SecretStr
from sqlalchemy import Engine, text
from sqlalchemy.orm import Session

from nexus.db.models import ChatRun, ChatRunTurnContext, Message
from nexus.errors import ApiError, ApiErrorCode, NotFoundError
from nexus.services import generation_policy
from nexus.services.chat_run_candidates import regenerate_assistant_response
from nexus.services.chat_run_event_store import mark_running
from nexus.services.chat_run_finalize import finalize_cancelled, finalize_run
from nexus.services.chat_run_idempotency import (
    compute_regeneration_payload_hash,
    compute_rerun_payload_hash,
)
from nexus.services.chat_run_response import build_chat_run_response
from nexus.services.chat_run_tools import (
    current_tool_record_identity,
    persist_current_tool_record,
)
from nexus.services.codex_generation_contract import (
    ChatOperation,
    GenerationCommand,
    GenerationSessionRef,
    GenerationTerminal,
)
from nexus.services.conversations import regeneratable_assistant_message_ids
from nexus.services.generation_intent import BearerToolGrant, GenerationIntent, TextOutput
from nexus.services.llm_ledger import (
    GenerationStart,
    LlmCallOwner,
    complete_generation_in_current_transaction,
    start_generation_in_current_transaction,
)
from nexus.services.tool_runtime.declarations import BROWSER_TOOL_PROJECTION_REVISION
from tests.testkit.auth import UserRecord
from tests.testkit.chat import create_entitled_chat

pytestmark = pytest.mark.usefixtures("committed_chat_state_isolation")


@dataclass(frozen=True, slots=True)
class CompletedChat:
    user_id: UUID
    conversation_id: UUID
    run_id: UUID
    user_message_id: UUID
    assistant_message_id: UUID


def _stage_generation(
    db: Session,
    run_id: UUID,
    assistant_content: str,
    *,
    profile_id: Literal["fast", "balanced", "deep"],
    status: Literal["succeeded", "cancelled"] = "succeeded",
) -> None:
    """Create the exact terminal ledger facts a completed production run owns."""

    policy = generation_policy.chat_policy(profile_id)
    command = GenerationCommand(
        request_id=uuid4(),
        operation=ChatOperation(revision=policy.revision, profile=profile_id),
        policy_revision=generation_policy.POLICY_REVISION,
        policy_fingerprint=generation_policy.POLICY_FINGERPRINT,
        intent=GenerationIntent(
            instructions="Answer the user's question.",
            input="Regeneration eligibility proof.",
            output=TextOutput(),
        ),
        tool_grant=BearerToolGrant(token=SecretStr("test-only-grant")),
    )
    owner = LlmCallOwner(kind="chat_run", id=run_id)
    start_generation_in_current_transaction(
        db,
        GenerationStart(owner=owner, command=command, streaming=True),
    )
    complete_generation_in_current_transaction(
        db,
        owner=owner,
        generation_id=command.request_id,
        terminal=GenerationTerminal(
            status=status,
            failure=None,
            final_text=assistant_content,
            structured_output=None,
            session_ref=(
                GenerationSessionRef(
                    schema_version="agent-session-ref.v1",
                    backend="codex",
                    transport="sdk",
                    native_session_id=f"thread-{command.request_id}",
                    profile_key="codex-personal",
                    state_root_fingerprint="1" * 64,
                    cwd_fingerprint="2" * 64,
                )
                if status == "succeeded"
                else None
            ),
            usage=None,
            diagnostics=() if status == "succeeded" else ("cancelled by candidate proof",),
            accepted_at="2026-08-25T12:34:56.123456Z",
            sdk_version="0.144.4",
            runtime_version="0.144.4",
        ),
        latency_ms=1,
    )


def _complete_chat(
    db: Session,
    *,
    content: str,
    user_id: UUID | None = None,
    assistant_content: str = "The original answer.",
    profile_id: Literal["fast", "balanced", "deep"] = "balanced",
    snapshot_model: str | None = None,
) -> CompletedChat:
    """Drive one admitted chat all the way to a real completed terminal state."""
    policy = generation_policy.chat_policy(profile_id)
    chat = create_entitled_chat(db, content=content, user_id=user_id, profile_id=profile_id)
    mark_running(
        db,
        chat.run_id,
        model_name=snapshot_model or policy.model,
        reasoning_effort=policy.effort,
    )
    _stage_generation(
        db,
        chat.run_id,
        assistant_content,
        profile_id=profile_id,
    )
    finalize_run(
        db,
        run_id=chat.run_id,
        assistant_content=assistant_content,
        assistant_status="complete",
        run_status="complete",
        done_status="complete",
        error_code=None,
        commit=True,
    )
    run = db.get(ChatRun, chat.run_id)
    assert run is not None and run.status == "complete"
    return CompletedChat(
        user_id=chat.user_id,
        conversation_id=chat.conversation_id,
        run_id=chat.run_id,
        user_message_id=run.user_message_id,
        assistant_message_id=run.assistant_message_id,
    )


def _cancelled_chat(
    db: Session,
    *,
    content: str,
    user_id: UUID,
    profile_id: Literal["fast", "balanced", "deep"],
) -> CompletedChat:
    """Drive one admitted chat through a real cancelled terminal fold."""
    policy = generation_policy.chat_policy(profile_id)
    chat = create_entitled_chat(db, content=content, user_id=user_id, profile_id=profile_id)
    mark_running(
        db,
        chat.run_id,
        model_name=policy.model,
        reasoning_effort=policy.effort,
    )
    _stage_generation(db, chat.run_id, "", profile_id=profile_id, status="cancelled")
    run = db.get(ChatRun, chat.run_id)
    assert run is not None
    finalize_cancelled(db, run)
    run = db.get(ChatRun, chat.run_id)
    assert run is not None and run.status == "cancelled"
    return CompletedChat(
        user_id=chat.user_id,
        conversation_id=chat.conversation_id,
        run_id=chat.run_id,
        user_message_id=run.user_message_id,
        assistant_message_id=run.assistant_message_id,
    )


def _active_leaf(db: Session, *, viewer_id: UUID, conversation_id: UUID) -> UUID | None:
    return db.execute(
        text(
            "SELECT active_leaf_message_id FROM conversation_active_paths "
            "WHERE conversation_id = :c AND viewer_user_id = :v"
        ),
        {"c": conversation_id, "v": viewer_id},
    ).scalar_one_or_none()


def _job_count(db: Session, *, run_id: UUID) -> int:
    return db.execute(
        text("SELECT count(*) FROM background_jobs WHERE dedupe_key = :k"),
        {"k": f"chat_run:{run_id}"},
    ).scalar_one()


def _assistant_can_regenerate(db: Session, completed: CompletedChat) -> bool:
    response = build_chat_run_response(db, completed.user_id, db.get(ChatRun, completed.run_id))
    assert response.assistant_message.id == completed.assistant_message_id
    return response.assistant_message.can_regenerate


def test_rerun_and_regenerate_routes_are_bodyless_and_inherit_the_exact_profile(
    authenticated_client: TestClient,
    db_session: Session,
    test_user: UserRecord,
) -> None:
    """The command routes accept no selector surface: a body is rejected before
    candidate creation, while each bodyless command copies its source profile."""
    cancelled = _cancelled_chat(
        db_session,
        content="Please try this deep answer again.",
        user_id=test_user.id,
        profile_id="deep",
    )
    completed = _complete_chat(
        db_session,
        content="Give me another fast answer.",
        user_id=test_user.id,
        profile_id="fast",
    )
    source_count = db_session.execute(
        text("SELECT count(*) FROM chat_runs WHERE owner_user_id = :owner_id"),
        {"owner_id": test_user.id},
    ).scalar_one()
    assert source_count == 2

    boundaries = (
        ("rerun", cancelled.assistant_message_id),
        ("regenerate", completed.assistant_message_id),
    )
    for operation, assistant_message_id in boundaries:
        rejected = authenticated_client.post(
            f"/messages/{assistant_message_id}/{operation}",
            headers={
                "X-Nexus-Tool-Projection": BROWSER_TOOL_PROJECTION_REVISION,
                "Idempotency-Key": f"body-rejected-{operation}-{uuid4()}",
            },
            json={"profile_id": "balanced", "reasoning_option_id": "high"},
        )
        assert rejected.status_code == 400
        assert rejected.json()["error"]["code"] == "E_INVALID_REQUEST"
    assert (
        db_session.execute(
            text("SELECT count(*) FROM chat_runs WHERE owner_user_id = :owner_id"),
            {"owner_id": test_user.id},
        ).scalar_one()
        == source_count
    ), "a rejected selector body still created a candidate"

    rerun = authenticated_client.post(
        f"/messages/{cancelled.assistant_message_id}/rerun",
        headers={
            "X-Nexus-Tool-Projection": BROWSER_TOOL_PROJECTION_REVISION,
            "Idempotency-Key": f"bodyless-rerun-{uuid4()}",
        },
    )
    assert rerun.status_code == 200, rerun.text
    rerun_data = rerun.json()["data"]
    assert rerun_data["run"]["id"] != str(cancelled.run_id)
    assert rerun_data["run"]["profile_id"] == "deep"
    assert "reasoning_option_id" not in rerun.text

    regenerate = authenticated_client.post(
        f"/messages/{completed.assistant_message_id}/regenerate",
        headers={
            "X-Nexus-Tool-Projection": BROWSER_TOOL_PROJECTION_REVISION,
            "Idempotency-Key": f"bodyless-regenerate-{uuid4()}",
        },
    )
    assert regenerate.status_code == 200, regenerate.text
    regenerate_data = regenerate.json()["data"]
    assert regenerate_data["run"]["id"] != str(completed.run_id)
    assert regenerate_data["run"]["profile_id"] == "fast"
    assert "reasoning_option_id" not in regenerate.text


def test_completed_answer_regenerates_a_selected_sibling_copying_prompt_snapshot_and_turn_context(
    engine: Engine,
) -> None:
    """Risk: regeneration must produce a preserved, navigable new sibling (AC-9,
    §5.4) — a faithful clone of the prompt turn with a fresh pending assistant as
    the active leaf — without touching the original turn."""
    with Session(engine) as db:
        completed = _complete_chat(db, content="Explain entropy simply.")

        # A durable reader-quote snapshot and turn context the constructor must
        # clone verbatim onto the sibling (§5.4).
        media_id, highlight_id, fragment_id = uuid4(), uuid4(), uuid4()
        snapshot = {
            "key": {"media_id": str(media_id), "highlight_id": str(highlight_id)},
            "source_label": "Chapter 3",
            "exact": "a quoted passage",
            "prefix": "",
            "suffix": "",
            "locator": {
                "type": "web_text_offsets",
                "media_id": str(media_id),
                "fragment_id": str(fragment_id),
                "start_offset": 0,
                "end_offset": 8,
            },
        }
        source_user = db.get(Message, completed.user_message_id)
        source_user.reader_selection_snapshot = snapshot
        subject_id = uuid4()
        db.add(
            ChatRunTurnContext(
                chat_run_id=completed.run_id,
                requested_subject_scheme="media",
                requested_subject_id=subject_id,
                subject_scheme="media",
                subject_id=subject_id,
                subject_context_edge_id=None,
            )
        )
        db.commit()

        # Independent oracle: an eligible completed assistant projects True.
        assert _assistant_can_regenerate(db, completed) is True

        response = regenerate_assistant_response(
            db,
            viewer_id=completed.user_id,
            assistant_message_id=completed.assistant_message_id,
            idempotency_key=f"regen-{uuid4()}",
        )

        new_run_id = response.run.id
        assert new_run_id != completed.run_id, "regeneration reused the source run"
        assert response.run.status == "queued"
        assert response.assistant_message.id != completed.assistant_message_id
        assert response.assistant_message.status == "pending"
        assert response.user_message.id != completed.user_message_id

        new_run = db.get(ChatRun, new_run_id)
        new_user = db.get(Message, new_run.user_message_id)
        new_assistant = db.get(Message, new_run.assistant_message_id)

        # Faithful clone of the prompt turn.
        assert new_user.content == "Explain entropy simply."
        assert new_user.parent_message_id == source_user.parent_message_id
        assert new_user.branch_root_message_id == source_user.branch_root_message_id
        assert new_user.reader_selection_snapshot == snapshot, "sibling lost the quote snapshot"
        assert new_run.profile_id == "balanced"
        assert (new_run.model_name, new_run.reasoning_effort) == (None, None)

        # Cloned turn context.
        new_context = db.get(ChatRunTurnContext, new_run_id)
        assert new_context is not None
        assert (new_context.subject_scheme, new_context.subject_id) == ("media", subject_id)

        # New assistant is the selected active leaf; one durable job enqueued.
        assert new_assistant.status == "pending"
        assert _active_leaf(
            db, viewer_id=completed.user_id, conversation_id=completed.conversation_id
        ) == (new_assistant.id)
        assert _job_count(db, run_id=new_run_id) == 1

        # The original turn is preserved and unchanged.
        original_assistant = db.get(Message, completed.assistant_message_id)
        original_user = db.get(Message, completed.user_message_id)
        assert original_assistant.status == "complete"
        assert original_assistant.content == "The original answer."
        assert original_user.content == "Explain entropy simply."


def test_regeneration_is_blocked_and_unprojected_after_an_assistant_write_tool_attempt(
    engine: Engine,
) -> None:
    """Risk (AC-11, §3 non-goal): a source that attempted an assistant-write tool
    must be neither projected regeneratable nor mutation-permitted."""
    with Session(engine) as db:
        completed = _complete_chat(db, content="Add a note for me.")
        run = db.get(ChatRun, completed.run_id)
        assert run is not None
        persist_current_tool_record(
            db,
            conversation_id=run.conversation_id,
            user_message_id=run.user_message_id,
            assistant_message_id=run.assistant_message_id,
            tool_call_index=1,
            identity=current_tool_record_identity(
                canonical_tool_id="nexus.note.create",
                canonical_input_sha256="a" * 64,
                binding_policy_revision="b" * 64,
            ),
            search_query_fingerprint=None,
            scope="assistant_write",
            requested_types=[],
            result_refs=[],
            selected_context_refs=[],
            provider_request_ids=[],
            latency_ms=None,
            status="complete",
            error_code=None,
            clear_reverted=True,
        )
        db.commit()

        assert _assistant_can_regenerate(db, completed) is False

        with pytest.raises(ApiError) as excinfo:
            regenerate_assistant_response(
                db,
                viewer_id=completed.user_id,
                assistant_message_id=completed.assistant_message_id,
                idempotency_key=f"regen-{uuid4()}",
            )
        assert excinfo.value.code is ApiErrorCode.E_REGENERATION_NOT_ALLOWED
        assert excinfo.value.status_code == 409
        # No sibling run was created for this source's user turn.
        sibling_runs = db.execute(
            text("SELECT count(*) FROM chat_runs WHERE conversation_id = :c"),
            {"c": completed.conversation_id},
        ).scalar_one()
        assert sibling_runs == 1, "a blocked regeneration still created a sibling run"


def test_regeneration_is_blocked_and_unprojected_after_profile_plan_drift(
    engine: Engine,
) -> None:
    """Risk (AC-11, §10 "never remaps a historical target"): once the run's
    resolved target no longer matches its profile, regeneration is unavailable
    and rejected."""
    with Session(engine) as db:
        # Complete against a target that no longer matches what "balanced"
        # resolves to today — a stand-in for a drifted profile whose historical
        # execution snapshot diverges from the live plan.
        completed = _complete_chat(db, content="Summarize the argument.", snapshot_model="retired")

        assert _assistant_can_regenerate(db, completed) is False

        with pytest.raises(ApiError) as excinfo:
            regenerate_assistant_response(
                db,
                viewer_id=completed.user_id,
                assistant_message_id=completed.assistant_message_id,
                idempotency_key=f"regen-{uuid4()}",
            )
        assert excinfo.value.code is ApiErrorCode.E_REGENERATION_NOT_ALLOWED


def test_pending_and_failed_and_user_turns_are_never_regeneratable(
    engine: Engine,
) -> None:
    """Risk (§3 non-goals, AC): only a completed assistant turn is regeneratable —
    never a pending/failed run, and never a user turn (projected or mutated)."""
    with Session(engine) as db:
        # (a) A pending, still-queued turn.
        pending = create_entitled_chat(db, content="Still thinking?")
        pending_run = db.get(ChatRun, pending.run_id)
        assert (
            regeneratable_assistant_message_ids(
                db,
                viewer_id=pending.user_id,
                assistant_message_ids=[pending_run.assistant_message_id],
            )
            == set()
        )
        with pytest.raises(ApiError) as pending_error:
            regenerate_assistant_response(
                db,
                viewer_id=pending.user_id,
                assistant_message_id=pending_run.assistant_message_id,
                idempotency_key=f"regen-{uuid4()}",
            )
        assert pending_error.value.code is ApiErrorCode.E_REGENERATION_NOT_ALLOWED

        # (b) A terminally failed turn.
        failed = create_entitled_chat(db, content="This will fail.", user_id=uuid4())
        finalize_run(
            db,
            run_id=failed.run_id,
            assistant_content="",
            assistant_status="error",
            run_status="error",
            done_status="error",
            error_code="timeout",
            commit=True,
        )
        failed_run = db.get(ChatRun, failed.run_id)
        assert (
            regeneratable_assistant_message_ids(
                db,
                viewer_id=failed.user_id,
                assistant_message_ids=[failed_run.assistant_message_id],
            )
            == set()
        )
        with pytest.raises(ApiError) as failed_error:
            regenerate_assistant_response(
                db,
                viewer_id=failed.user_id,
                assistant_message_id=failed_run.assistant_message_id,
                idempotency_key=f"regen-{uuid4()}",
            )
        assert failed_error.value.code is ApiErrorCode.E_REGENERATION_NOT_ALLOWED

        # (c) The user turn of a completed chat: never regeneratable, and the
        # mutation masks it as message-not-found (non-assistant target).
        completed = _complete_chat(db, content="A real question.", user_id=uuid4())
        response = build_chat_run_response(db, completed.user_id, db.get(ChatRun, completed.run_id))
        assert response.user_message.can_regenerate is False
        with pytest.raises(NotFoundError) as user_error:
            regenerate_assistant_response(
                db,
                viewer_id=completed.user_id,
                assistant_message_id=completed.user_message_id,
                idempotency_key=f"regen-{uuid4()}",
            )
        assert user_error.value.code is ApiErrorCode.E_MESSAGE_NOT_FOUND


def test_exact_regeneration_replay_returns_one_run_and_a_changed_source_key_conflicts(
    engine: Engine,
) -> None:
    """Risk (AC-12): the same key + same source replays the one generated run;
    the same key against a different source (or the rerun operation) is a replay
    mismatch, never a second billable dispatch."""
    with Session(engine) as db:
        chat_a = _complete_chat(db, content="Question A.")
        chat_b = _complete_chat(db, content="Question B.", user_id=chat_a.user_id)
        key = f"regen-shared-{uuid4()}"

        first = regenerate_assistant_response(
            db,
            viewer_id=chat_a.user_id,
            assistant_message_id=chat_a.assistant_message_id,
            idempotency_key=key,
        )
        replay = regenerate_assistant_response(
            db,
            viewer_id=chat_a.user_id,
            assistant_message_id=chat_a.assistant_message_id,
            idempotency_key=key,
        )
        assert replay.run.id == first.run.id, "exact replay minted a second run"
        assert _job_count(db, run_id=first.run.id) == 1

        # Same key, different source ⇒ replay mismatch (409), no new run.
        with pytest.raises(ApiError) as mismatch:
            regenerate_assistant_response(
                db,
                viewer_id=chat_a.user_id,
                assistant_message_id=chat_b.assistant_message_id,
                idempotency_key=key,
            )
        assert mismatch.value.code is ApiErrorCode.E_IDEMPOTENCY_KEY_REPLAY_MISMATCH

        # The operation tag alone distinguishes a rerun key from a regeneration
        # key for identical source facts, so one key can never denote both.
        source_run = db.get(ChatRun, chat_a.run_id)
        source_user = db.get(Message, chat_a.user_message_id)
        rerun_hash = compute_rerun_payload_hash(
            source_assistant_message_id=chat_a.assistant_message_id,
            source_run=source_run,
            source_user_message=source_user,
        )
        regen_hash = compute_regeneration_payload_hash(
            source_assistant_message_id=chat_a.assistant_message_id,
            source_run=source_run,
            source_user_message=source_user,
        )
        assert rerun_hash != regen_hash


def test_two_fresh_keys_create_two_distinct_serialized_regeneration_siblings(
    engine: Engine,
) -> None:
    """Risk (AC-12): two distinct fresh keys against one eligible completed source
    create two distinct siblings — the source stays regeneratable after the first."""
    with Session(engine) as db:
        completed = _complete_chat(db, content="Regenerate me twice.")

        first = regenerate_assistant_response(
            db,
            viewer_id=completed.user_id,
            assistant_message_id=completed.assistant_message_id,
            idempotency_key=f"regen-1-{uuid4()}",
        )
        second = regenerate_assistant_response(
            db,
            viewer_id=completed.user_id,
            assistant_message_id=completed.assistant_message_id,
            idempotency_key=f"regen-2-{uuid4()}",
        )

        assert first.run.id != second.run.id
        assert first.assistant_message.id != second.assistant_message.id
        assert first.user_message.id != second.user_message.id
        assert _job_count(db, run_id=first.run.id) == 1
        assert _job_count(db, run_id=second.run.id) == 1
        # The most recent sibling is the selected active leaf.
        assert (
            _active_leaf(db, viewer_id=completed.user_id, conversation_id=completed.conversation_id)
            == second.assistant_message.id
        )


def test_regenerating_another_viewers_completed_answer_is_masked_as_message_not_found(
    engine: Engine,
) -> None:
    """Risk (privacy, §8): a non-owner regeneration attempt leaks nothing — it is
    masked as the existing message-not-found error, not a distinct rejection."""
    with Session(engine) as db:
        completed = _complete_chat(db, content="Owner-only answer.")
        stranger = uuid4()

        with pytest.raises(NotFoundError) as excinfo:
            regenerate_assistant_response(
                db,
                viewer_id=stranger,
                assistant_message_id=completed.assistant_message_id,
                idempotency_key=f"regen-{uuid4()}",
            )
        assert excinfo.value.code is ApiErrorCode.E_MESSAGE_NOT_FOUND
        # No sibling run appeared for the foreign attempt.
        assert (
            db.execute(
                text("SELECT count(*) FROM chat_runs WHERE conversation_id = :c"),
                {"c": completed.conversation_id},
            ).scalar_one()
            == 1
        )
