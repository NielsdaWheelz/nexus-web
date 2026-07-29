"""Transaction-local ConversationIndex revision writer boundaries."""

from uuid import uuid4

import pytest
from sqlalchemy.orm import Session

from nexus.db.models import Conversation, User
from nexus.services.collection_revisions import (
    CollectionFamily,
    read_collection_revision,
)
from nexus.services.seq import assign_next_message_seq

pytestmark = pytest.mark.integration


def test_sequence_assignment_bumps_the_index_in_the_callers_transaction(
    db_session: Session,
) -> None:
    user = User(id=uuid4())
    conversation = Conversation(
        owner_user_id=user.id,
        title="Chat",
        sharing="private",
        next_seq=1,
    )
    db_session.add_all((user, conversation))
    db_session.flush()

    assert (
        read_collection_revision(
            db_session,
            viewer_id=user.id,
            family=CollectionFamily.ConversationIndex,
        )
        == 0
    )
    assert assign_next_message_seq(db_session, conversation.id) == 1
    assert (
        read_collection_revision(
            db_session,
            viewer_id=user.id,
            family=CollectionFamily.ConversationIndex,
        )
        == 1
    )
