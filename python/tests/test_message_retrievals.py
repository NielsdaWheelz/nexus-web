"""Tests for the message retrieval/rerank ledger service.

These exercise the read surface moved out of ``services/conversations`` into
``services/message_retrievals``: visibility masking via the conversation read
predicate and the empty-ledger happy path. Heavy ledger-population coverage
lives in ``test_agent_app_search`` / ``test_chat_runs``.
"""

from uuid import uuid4

import pytest
from sqlalchemy.orm import Session

from nexus.errors import ApiErrorCode, NotFoundError
from nexus.services import message_retrievals as message_retrievals_service
from tests.factories import create_test_conversation, create_test_message
from tests.helpers import create_test_user_id

pytestmark = pytest.mark.integration


def _owned_assistant_message(db_session: Session, viewer_id) -> tuple:
    conversation_id = create_test_conversation(db_session, viewer_id)
    create_test_message(db_session, conversation_id, seq=1, role="user", content="hi")
    assistant_message_id = create_test_message(
        db_session, conversation_id, seq=2, role="assistant", content="", status="complete"
    )
    return conversation_id, assistant_message_id


class TestRetrievalCandidateLedgers:
    """Tests for list_message_retrieval_candidate_ledgers."""

    def test_returns_empty_for_owned_message_without_ledgers(
        self, db_session: Session, bootstrapped_user
    ):
        """An owned assistant message with no ledgers yields an empty list."""
        _, assistant_message_id = _owned_assistant_message(db_session, bootstrapped_user)

        result = message_retrievals_service.list_message_retrieval_candidate_ledgers(
            db_session,
            viewer_id=bootstrapped_user,
            message_id=assistant_message_id,
        )

        assert result == []

    def test_unknown_message_raises_message_not_found(
        self, db_session: Session, bootstrapped_user
    ):
        """An unknown message id is masked as E_MESSAGE_NOT_FOUND."""
        with pytest.raises(NotFoundError) as exc_info:
            message_retrievals_service.list_message_retrieval_candidate_ledgers(
                db_session,
                viewer_id=bootstrapped_user,
                message_id=uuid4(),
            )
        assert exc_info.value.code == ApiErrorCode.E_MESSAGE_NOT_FOUND

    def test_non_owner_is_masked_as_message_not_found(
        self, db_session: Session, bootstrapped_user
    ):
        """A non-owner viewer cannot read another user's message ledgers."""
        _, assistant_message_id = _owned_assistant_message(db_session, bootstrapped_user)
        other_viewer = create_test_user_id()

        with pytest.raises(NotFoundError) as exc_info:
            message_retrievals_service.list_message_retrieval_candidate_ledgers(
                db_session,
                viewer_id=other_viewer,
                message_id=assistant_message_id,
            )
        assert exc_info.value.code == ApiErrorCode.E_MESSAGE_NOT_FOUND


class TestRerankLedgers:
    """Tests for list_message_rerank_ledgers."""

    def test_returns_empty_for_owned_message_without_ledgers(
        self, db_session: Session, bootstrapped_user
    ):
        """An owned assistant message with no rerank ledgers yields an empty list."""
        _, assistant_message_id = _owned_assistant_message(db_session, bootstrapped_user)

        result = message_retrievals_service.list_message_rerank_ledgers(
            db_session,
            viewer_id=bootstrapped_user,
            message_id=assistant_message_id,
        )

        assert result == []

    def test_non_owner_is_masked_as_message_not_found(
        self, db_session: Session, bootstrapped_user
    ):
        """A non-owner viewer cannot read another user's rerank ledgers."""
        _, assistant_message_id = _owned_assistant_message(db_session, bootstrapped_user)
        other_viewer = create_test_user_id()

        with pytest.raises(NotFoundError) as exc_info:
            message_retrievals_service.list_message_rerank_ledgers(
                db_session,
                viewer_id=other_viewer,
                message_id=assistant_message_id,
            )
        assert exc_info.value.code == ApiErrorCode.E_MESSAGE_NOT_FOUND
