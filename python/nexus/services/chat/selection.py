"""Read and atomically remember the account's last accepted chat selection."""

import json
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from nexus.db.models import ChatSelection
from nexus.schemas.chat_selection import (
    ChatSelectionChoice,
    ChatSelectionOut,
    RememberedChatSelection,
)
from nexus.schemas.llm import CodexPersonalRoute, ProviderApiRoute
from nexus.services.generation.catalog import ProviderTarget, Row


def _decode(row: ChatSelection) -> RememberedChatSelection:
    choice = ChatSelectionChoice.model_validate_json(json.dumps(row.choice))
    return RememberedChatSelection(
        route=choice.route, selection=choice.selection, revision=str(row.revision)
    )


def read(db: Session, *, user_id: UUID) -> ChatSelectionOut:
    row = db.scalar(select(ChatSelection).where(ChatSelection.user_id == user_id))
    return ChatSelectionOut(last_used=None if row is None else _decode(row))


def remember(db: Session, *, user_id: UUID, admitted: Row) -> None:
    route = (
        ProviderApiRoute(provider=admitted.target.provider)
        if isinstance(admitted.target, ProviderTarget)
        else CodexPersonalRoute()
    )
    choice = ChatSelectionChoice(route=route, selection=admitted.selection)
    row = db.scalar(select(ChatSelection).where(ChatSelection.user_id == user_id).with_for_update())
    if row is None:
        db.add(ChatSelection(user_id=user_id, revision=1, choice=choice.model_dump(mode="json")))
    else:
        _decode(row)
        row.revision += 1
        row.choice = choice.model_dump(mode="json")
    db.flush()
