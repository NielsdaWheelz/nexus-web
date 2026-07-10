"""Integration tests for build_assistant_trust_trails — cost field (S0).

Seeds a committed user + conversation + messages + chat_run + llm_calls row via
direct_db, then calls build_assistant_trust_trail and asserts the
total_cost_usd_micros field is populated.  Uses the direct_db pattern throughout
(no authenticated client needed here — service-layer tests).
"""

from uuid import UUID, uuid4

import pytest
from sqlalchemy import text

from nexus.db.models import ChatRun
from nexus.services.message_trust_trails import build_assistant_trust_trail
from tests.factories import (
    create_test_conversation,
    create_test_message,
    create_test_model,
)
from tests.utils.db import DirectSessionManager

pytestmark = pytest.mark.integration


def _seed_user(direct_db: DirectSessionManager) -> UUID:
    user_id = uuid4()
    with direct_db.session() as session:
        session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
        session.commit()
    direct_db.register_cleanup("users", "id", user_id)
    return user_id


def _seed_conversation(
    direct_db: DirectSessionManager,
) -> tuple[UUID, UUID, UUID, UUID, UUID]:
    """Seed user, model, conversation, user-message, assistant-message; return IDs."""
    user_id = _seed_user(direct_db)

    with direct_db.session() as session:
        model_id = create_test_model(session)
        conversation_id = create_test_conversation(session, user_id)
        user_message_id = create_test_message(
            session, conversation_id, seq=1, role="user", content="Hello"
        )
        assistant_message_id = create_test_message(
            session,
            conversation_id,
            seq=2,
            role="assistant",
            content="Hi",
            status="complete",
        )

    direct_db.register_cleanup("messages", "conversation_id", conversation_id)
    direct_db.register_cleanup("conversations", "id", conversation_id)

    return user_id, model_id, conversation_id, user_message_id, assistant_message_id


def _seed_chat_run(
    direct_db: DirectSessionManager,
    *,
    user_id: UUID,
    model_id: UUID,
    conversation_id: UUID,
    user_message_id: UUID,
    assistant_message_id: UUID,
) -> UUID:
    run_id = uuid4()
    with direct_db.session() as session:
        session.add(
            ChatRun(
                id=run_id,
                owner_user_id=user_id,
                conversation_id=conversation_id,
                user_message_id=user_message_id,
                assistant_message_id=assistant_message_id,
                idempotency_key=f"trust-trail-test-{run_id}",
                payload_hash="hash",
                status="complete",
                model_id=model_id,
                reasoning="none",
                key_mode="auto",
            )
        )
        session.commit()
    direct_db.register_cleanup("chat_runs", "id", run_id)
    return run_id


def _seed_llm_call(
    direct_db: DirectSessionManager,
    *,
    run_id: UUID,
    total_cost_usd_micros: int | None,
    call_seq: int = 1,
) -> UUID:
    call_id = uuid4()
    with direct_db.session() as session:
        session.execute(
            text("""
                INSERT INTO llm_calls (
                    id, owner_kind, owner_id, call_seq, provider, provider_route,
                    model_name, llm_operation, streaming, reasoning_effort,
                    key_mode_requested, key_mode_used, cost_status,
                    total_cost_usd_micros
                ) VALUES (
                    :id, 'chat_run', :owner_id, :call_seq, 'openai', 'openai',
                    'gpt-5-mini', 'chat', false, 'none',
                    'auto', 'auto', 'estimated',
                    :total_cost
                )
            """),
            {
                "id": call_id,
                "owner_id": run_id,
                "call_seq": call_seq,
                "total_cost": total_cost_usd_micros,
            },
        )
        session.commit()
    direct_db.register_cleanup("llm_calls", "id", call_id)
    return call_id


class TestTrustTrailCostField:
    def test_total_cost_populated_when_llm_calls_exist(
        self, direct_db: DirectSessionManager
    ) -> None:
        """AC-12: total_cost_usd_micros is the SUM of llm_calls rows for the run."""
        (
            user_id,
            model_id,
            conversation_id,
            user_message_id,
            assistant_message_id,
        ) = _seed_conversation(direct_db)

        run_id = _seed_chat_run(
            direct_db,
            user_id=user_id,
            model_id=model_id,
            conversation_id=conversation_id,
            user_message_id=user_message_id,
            assistant_message_id=assistant_message_id,
        )
        # Two llm_calls rows (e.g. retry scenario) — cost is the sum.
        _seed_llm_call(direct_db, run_id=run_id, total_cost_usd_micros=14_000, call_seq=1)
        _seed_llm_call(direct_db, run_id=run_id, total_cost_usd_micros=1_000, call_seq=2)

        with direct_db.session() as session:
            trail = build_assistant_trust_trail(
                session,
                viewer_id=user_id,
                assistant_message_id=assistant_message_id,
            )

        assert trail.run is not None
        assert trail.run.total_cost_usd_micros == 15_000

    def test_total_cost_null_when_no_llm_calls(
        self, direct_db: DirectSessionManager
    ) -> None:
        """total_cost_usd_micros is null for runs with no llm_calls."""
        (
            user_id,
            model_id,
            conversation_id,
            user_message_id,
            assistant_message_id,
        ) = _seed_conversation(direct_db)

        _seed_chat_run(
            direct_db,
            user_id=user_id,
            model_id=model_id,
            conversation_id=conversation_id,
            user_message_id=user_message_id,
            assistant_message_id=assistant_message_id,
        )
        # No llm_calls rows seeded.

        with direct_db.session() as session:
            trail = build_assistant_trust_trail(
                session,
                viewer_id=user_id,
                assistant_message_id=assistant_message_id,
            )

        assert trail.run is not None
        assert trail.run.total_cost_usd_micros is None

    def test_total_cost_absent_when_no_run(
        self, direct_db: DirectSessionManager
    ) -> None:
        """trail.run is None when there is no chat_run, so cost is implicitly absent."""
        user_id = _seed_user(direct_db)

        with direct_db.session() as session:
            conversation_id = create_test_conversation(session, user_id)
            create_test_message(
                session, conversation_id, seq=1, role="user", content="Hi"
            )
            assistant_message_id = create_test_message(
                session,
                conversation_id,
                seq=2,
                role="assistant",
                content="",
                status="complete",
            )

        direct_db.register_cleanup("messages", "conversation_id", conversation_id)
        direct_db.register_cleanup("conversations", "id", conversation_id)

        with direct_db.session() as session:
            trail = build_assistant_trust_trail(
                session,
                viewer_id=user_id,
                assistant_message_id=assistant_message_id,
            )

        assert trail.run is None
