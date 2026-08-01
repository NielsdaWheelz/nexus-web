from sqlalchemy import func, select
from sqlalchemy.orm import Session

from nexus.db.models import (
    ConsumptionQueueItem,
    Highlight,
    NoteBlock,
    ResourceEdge,
    ResourceMutation,
)
from nexus.services.agent_tools.read_resource import execute_read_resource
from nexus.services.conversations import create_conversation
from tests.testkit.auth import UserRecord

_MUTATION_MODELS = (
    ResourceMutation,
    ResourceEdge,
    NoteBlock,
    Highlight,
    ConsumptionQueueItem,
)


def _mutation_counts(db: Session) -> tuple[int, ...]:
    return tuple(
        int(db.scalar(select(func.count()).select_from(model)) or 0) for model in _MUTATION_MODELS
    )


def test_foreign_resource_reads_are_refused_without_side_effects(
    db_session: Session,
    test_user: UserRecord,
) -> None:
    conversation = create_conversation(db_session, test_user.id)
    before = _mutation_counts(db_session)
    uris = (
        "media:00000000-0000-4000-8000-000000000001",
        "page:00000000-0000-4000-8000-000000000002",
        "highlight:00000000-0000-4000-8000-000000000003",
    )

    results = tuple(
        execute_read_resource(
            db_session,
            viewer_id=test_user.id,
            conversation_id=conversation.id,
            uri=uri,
        )
        for uri in uris
    )

    assert all(
        result.status == "error" and result.error_code == "not_in_context_refs"
        for result in results
    ), "foreign resource authorization did not fail closed"
    assert _mutation_counts(db_session) == before, (
        "refused resource reads changed a user-owned mutation table"
    )
