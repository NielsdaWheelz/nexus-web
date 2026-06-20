"""Shared same-turn handoffs between agent tools."""

from __future__ import annotations

from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session


def selected_by_app_search(db: Session, *, assistant_message_id: UUID, uri: str) -> bool:
    return bool(
        db.execute(
            text(
                """
                SELECT 1
                FROM message_retrievals mr
                JOIN message_tool_calls mtc ON mtc.id = mr.tool_call_id
                WHERE mtc.assistant_message_id = :assistant_message_id
                  AND mtc.tool_name = 'app_search'
                  AND mr.selected = true
                  AND mr.result_ref->>'citation_target' = :uri
                LIMIT 1
                """
            ),
            {"assistant_message_id": assistant_message_id, "uri": uri},
        ).first()
    )
