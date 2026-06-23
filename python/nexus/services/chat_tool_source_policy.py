"""Source-policy validation for persisted chat tool calls."""

from __future__ import annotations

from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.services.chat_retrieval_plan import (
    source_domain_for_tool,
    validate_source_boundary_policy,
)


def validate_tool_source_policy(
    *, tool_name: str, source_domain: str, source_policy: object
) -> dict[str, object]:
    expected = source_domain_for_tool(tool_name)
    if source_domain != expected:
        raise AssertionError(f"{tool_name} source_domain must be {expected}")
    return validate_source_boundary_policy(
        source_domain=source_domain,
        source_policy=source_policy,
    )


def load_started_tool_source_policy(
    db: Session, *, assistant_message_id: UUID, tool_call_index: int, tool_name: str
) -> tuple[UUID, str, dict[str, object]]:
    row = (
        db.execute(
            text(
                """
                SELECT id, tool_name, source_domain, source_policy, status
                FROM message_tool_calls
                WHERE assistant_message_id = :assistant_message_id
                  AND tool_call_index = :tool_call_index
                FOR UPDATE
                """
            ),
            {
                "assistant_message_id": assistant_message_id,
                "tool_call_index": tool_call_index,
            },
        )
        .mappings()
        .first()
    )
    if row is None:
        raise AssertionError(f"{tool_name} tool call must be started by chat")
    if row["tool_name"] != tool_name:
        raise AssertionError(f"{tool_name} tool call row has wrong tool name")
    if row["status"] != "running":
        raise AssertionError(f"{tool_name} tool call must be running")
    policy = validate_tool_source_policy(
        tool_name=tool_name,
        source_domain=str(row["source_domain"]),
        source_policy=row["source_policy"],
    )
    if policy["decision"] != "allowed":
        raise AssertionError(f"{tool_name} source policy must be allowed")
    return row["id"], str(row["source_domain"]), policy
