"""Integration coverage for deterministic conversation memory refresh."""

from uuid import UUID

import pytest
from sqlalchemy.orm import Session

from nexus.services.context_rendering import PROMPT_VERSION
from nexus.services.conversation_memory import (
    conversation_memory_inspection,
    load_active_memory_items,
    load_active_state_snapshot,
    refresh_conversation_memory,
)
from tests.factories import create_test_conversation, create_test_message

pytestmark = pytest.mark.integration


def test_refresh_conversation_memory_snapshots_older_turns(
    db_session: Session,
    bootstrapped_user: UUID,
):
    conversation_id = create_test_conversation(db_session, bootstrapped_user)
    for seq in range(1, 15):
        create_test_message(
            db_session,
            conversation_id=conversation_id,
            seq=seq,
            role="user" if seq % 2 else "assistant",
            content="I prefer linear explicit code." if seq == 1 else f"Message {seq}",
        )

    refresh_conversation_memory(
        db_session,
        conversation_id=conversation_id,
        prompt_version=PROMPT_VERSION,
    )
    db_session.commit()

    snapshot = load_active_state_snapshot(
        db_session,
        conversation_id=conversation_id,
        prompt_version=PROMPT_VERSION,
    )
    assert snapshot is not None
    assert snapshot.covered_through_seq == 2
    assert snapshot.source_refs
    assert (
        load_active_memory_items(
            db_session,
            conversation_id=conversation_id,
            after_seq=snapshot.covered_through_seq,
            prompt_version=PROMPT_VERSION,
        )
        == []
    )

    inspection = conversation_memory_inspection(db_session, conversation_id=conversation_id)
    assert inspection.state_snapshot is not None
    assert inspection.state_snapshot.covered_through_seq == 2
    assert [item.kind for item in inspection.memory_items] == ["user_preference"]
    assert inspection.memory_items[0].sources[0].source_ref.message_seq == 1
