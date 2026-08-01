#!/usr/bin/env python
"""Seed conversation tree fixtures for Playwright conversation specs."""

from __future__ import annotations

import json
import os
import sys
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

from sqlalchemy import select, text

from nexus.db.models import (
    ChatRun,
    Conversation,
    ConversationActivePath,
    ConversationBranch,
    Message,
)
from nexus.db.session import create_session_factory
from nexus.jobs.queue import enqueue_job
from nexus.services.conversations import delete_conversation_rows_without_commit


def require_env(name: str) -> str:
    value = os.getenv(name)
    if not value:
        raise RuntimeError(f"{name} is required")
    return value


def add_message(
    db,
    conversation_id: UUID,
    seq: int,
    role: str,
    content: str,
    *,
    parent_message_id: UUID | None = None,
    branch_anchor_kind: str = "none",
    branch_anchor: dict[str, object] | None = None,
    status: str = "complete",
) -> Message:
    branch_root_message_id = None
    if role == "user" and parent_message_id is not None:
        branch_root_message_id = parent_message_id
    elif role == "assistant" and parent_message_id is not None:
        parent = db.get(Message, parent_message_id)
        branch_root_message_id = parent.branch_root_message_id if parent else None

    message = Message(
        id=uuid4(),
        conversation_id=conversation_id,
        seq=seq,
        role=role,
        content=content,
        message_document={
            "type": "message_document",
            "blocks": (
                [
                    {
                        "type": "text",
                        "format": "markdown" if role == "assistant" else "plain",
                        "text": content,
                    }
                ]
                if content.strip()
                else []
            ),
        },
        status=status,
        parent_message_id=parent_message_id,
        branch_root_message_id=branch_root_message_id,
        branch_anchor_kind=branch_anchor_kind,
        branch_anchor=branch_anchor or {},
    )
    db.add(message)
    db.flush()
    return message


def add_branch(
    db,
    conversation_id: UUID,
    user_message: Message,
    title: str,
) -> None:
    db.add(
        ConversationBranch(
            id=user_message.id,
            conversation_id=conversation_id,
            branch_user_message_id=user_message.id,
            title=title,
        )
    )


def add_completed_run(
    db,
    owner_user_id: UUID,
    conversation_id: UUID,
    user_message: Message,
    assistant_message: Message,
    profile_id: str,
    reasoning_option_id: str,
) -> None:
    completed_at = datetime.now(UTC)
    db.add(
        ChatRun(
            id=uuid4(),
            owner_user_id=owner_user_id,
            conversation_id=conversation_id,
            user_message_id=user_message.id,
            assistant_message_id=assistant_message.id,
            idempotency_key=f"e2e-complete-{assistant_message.id}",
            payload_hash=f"e2e-complete-{assistant_message.id}",
            status="complete",
            profile_id=profile_id,
            reasoning_option_id=reasoning_option_id,
            started_at=completed_at,
            completed_at=completed_at,
        )
    )


def seed_scroll(
    owner_user_id: UUID,
    message_count: int,
    extra_conversation_count: int,
) -> dict[str, object]:
    if message_count < 2:
        raise RuntimeError("NEXUS_E2E_MESSAGE_COUNT must be at least 2")
    if extra_conversation_count < 0:
        raise RuntimeError("NEXUS_E2E_EXTRA_CONVERSATION_COUNT cannot be negative")

    session_factory = create_session_factory()
    with session_factory() as db:
        seeded_at = datetime.now(UTC)
        conversation = Conversation(
            id=uuid4(),
            owner_user_id=owner_user_id,
            title="E2E scroll tree conversation",
            sharing="private",
            next_seq=1,
            created_at=seeded_at,
            updated_at=seeded_at,
        )
        db.add(conversation)
        db.flush()

        parent_id = None
        leaf_id = None
        for seq in range(1, message_count + 1):
            role = "user" if seq % 2 else "assistant"
            branch_anchor = None
            branch_anchor_kind = "none"
            if role == "user" and parent_id is not None:
                branch_anchor_kind = "assistant_message"
                branch_anchor = {"message_id": str(parent_id)}
            message = add_message(
                db,
                conversation.id,
                seq,
                role,
                (
                    f"Scroll fixture message {seq}: "
                    + ("bounded chat scroll ownership " * 8)
                ),
                parent_message_id=parent_id,
                branch_anchor_kind=branch_anchor_kind,
                branch_anchor=branch_anchor,
            )
            if role == "user" and parent_id is not None:
                add_branch(db, conversation.id, message, f"Scroll branch {seq}")
            parent_id = message.id
            leaf_id = message.id

        conversation.next_seq = message_count + 1
        db.add(
            ConversationActivePath(
                conversation_id=conversation.id,
                viewer_user_id=owner_user_id,
                active_leaf_message_id=leaf_id,
            )
        )

        extra_conversation_ids: list[UUID] = []
        for index in range(extra_conversation_count):
            filler_timestamp = seeded_at + timedelta(microseconds=index + 1)
            filler = Conversation(
                id=uuid4(),
                owner_user_id=owner_user_id,
                title=f"E2E pane-return filler {index + 1:03d}",
                sharing="private",
                next_seq=1,
                created_at=filler_timestamp,
                updated_at=filler_timestamp,
            )
            db.add(filler)
            extra_conversation_ids.append(filler.id)
        db.commit()

        return {
            "owner_user_id": str(owner_user_id),
            "conversation_id": str(conversation.id),
            "active_leaf_message_id": str(leaf_id),
            "message_count": message_count,
            "extra_conversation_ids": [
                str(conversation_id)
                for conversation_id in reversed(extra_conversation_ids)
            ],
        }


def cleanup_conversations(
    owner_user_id: UUID,
    conversation_ids: list[UUID],
) -> dict[str, object]:
    session_factory = create_session_factory()
    with session_factory() as db:
        owned_ids = set(
            db.scalars(
                select(Conversation.id).where(
                    Conversation.id.in_(conversation_ids),
                    Conversation.owner_user_id == owner_user_id,
                )
            ).all()
        )
        for conversation_id in conversation_ids:
            if conversation_id in owned_ids:
                delete_conversation_rows_without_commit(db, conversation_id)
        db.commit()

    return {
        "deleted_conversation_ids": [
            str(conversation_id)
            for conversation_id in conversation_ids
            if conversation_id in owned_ids
        ]
    }


def seed_branching(owner_user_id: UUID) -> dict[str, object]:
    session_factory = create_session_factory()
    with session_factory() as db:
        conversation = Conversation(
            id=uuid4(),
            owner_user_id=owner_user_id,
            title="E2E branching tree conversation",
            sharing="private",
            next_seq=1,
        )
        db.add(conversation)
        db.flush()

        root_user = add_message(
            db,
            conversation.id,
            1,
            "user",
            "Map the options before we choose a direction.",
        )
        root_assistant_content = (
            "Pick one direction after comparing the selected source phrase, "
            "then keep the branch evidence easy to scan."
        )
        root_assistant = add_message(
            db,
            conversation.id,
            2,
            "assistant",
            root_assistant_content,
            parent_message_id=root_user.id,
        )
        add_completed_run(
            db,
            owner_user_id,
            conversation.id,
            root_user,
            root_assistant,
            "balanced",
            "medium",
        )

        linear_user = add_message(
            db,
            conversation.id,
            3,
            "user",
            "Continue with the linear baseline plan.",
            parent_message_id=root_assistant.id,
            branch_anchor_kind="assistant_message",
            branch_anchor={"message_id": str(root_assistant.id)},
        )
        linear_assistant = add_message(
            db,
            conversation.id,
            4,
            "assistant",
            "Linear branch answer keeps the original path active.",
            parent_message_id=linear_user.id,
        )
        add_completed_run(
            db,
            owner_user_id,
            conversation.id,
            linear_user,
            linear_assistant,
            "deep",
            "high",
        )
        add_branch(db, conversation.id, linear_user, "Linear branch")

        quote_exact = "selected source phrase"
        quote_start = root_assistant_content.index(quote_exact)
        quote_user = add_message(
            db,
            conversation.id,
            5,
            "user",
            "Fork from the selected quote and summarize it.",
            parent_message_id=root_assistant.id,
            branch_anchor_kind="assistant_selection",
            branch_anchor={
                "message_id": str(root_assistant.id),
                "exact": quote_exact,
                "prefix": root_assistant_content[:quote_start],
                "suffix": root_assistant_content[quote_start + len(quote_exact) :],
                "offset_status": "mapped",
                "start_offset": quote_start,
                "end_offset": quote_start + len(quote_exact),
                "client_selection_id": "e2e-seeded-selection",
            },
        )
        quote_assistant = add_message(
            db,
            conversation.id,
            6,
            "assistant",
            "Quote branch answer highlights the selected source phrase.",
            parent_message_id=quote_user.id,
        )
        add_completed_run(
            db,
            owner_user_id,
            conversation.id,
            quote_user,
            quote_assistant,
            "fast",
            "low",
        )
        add_branch(db, conversation.id, quote_user, "Quote branch")

        running_user = add_message(
            db,
            conversation.id,
            7,
            "user",
            "Keep this running fork around for delete blocking.",
            parent_message_id=root_assistant.id,
            branch_anchor_kind="assistant_message",
            branch_anchor={"message_id": str(root_assistant.id)},
        )
        running_assistant = add_message(
            db,
            conversation.id,
            8,
            "assistant",
            "",
            parent_message_id=running_user.id,
            status="pending",
        )
        add_branch(db, conversation.id, running_user, "Running branch")
        running_run = ChatRun(
            id=uuid4(),
            owner_user_id=owner_user_id,
            conversation_id=conversation.id,
            user_message_id=running_user.id,
            assistant_message_id=running_assistant.id,
            idempotency_key=f"e2e-running-{conversation.id}",
            payload_hash="e2e-running-branch",
            status="running",
            profile_id="balanced",
            reasoning_option_id="medium",
            started_at=datetime.now(UTC),
        )
        db.add(running_run)
        db.flush()
        running_job = enqueue_job(
            db,
            kind="chat_run",
            payload={"run_id": str(running_run.id)},
            priority=50,
            max_attempts=3,
            dedupe_key=f"chat_run:{running_run.id}",
        )
        # The fixture deliberately models a live branch without starting a real
        # provider dispatch. Keep the queue row structurally equivalent to a
        # production claim so trust-trail projection observes one valid owner.
        db.execute(
            text(
                """
                UPDATE background_jobs
                SET
                    status = 'running',
                    attempts = 1,
                    claimed_by = 'e2e-conversation-tree',
                    started_at = now(),
                    lease_expires_at = now() + interval '1 hour',
                    updated_at = now()
                WHERE id = :job_id
                """
            ),
            {"job_id": running_job.id},
        )

        disposable_user = add_message(
            db,
            conversation.id,
            9,
            "user",
            "Create a disposable fork for allowed deletion.",
            parent_message_id=root_assistant.id,
            branch_anchor_kind="assistant_message",
            branch_anchor={"message_id": str(root_assistant.id)},
        )
        disposable_assistant = add_message(
            db,
            conversation.id,
            10,
            "assistant",
            "Disposable branch answer can be switched to from the graph.",
            parent_message_id=disposable_user.id,
        )
        add_completed_run(
            db,
            owner_user_id,
            conversation.id,
            disposable_user,
            disposable_assistant,
            "claude",
            "medium",
        )
        add_branch(db, conversation.id, disposable_user, "Disposable branch")

        conversation.next_seq = 11
        db.add(
            ConversationActivePath(
                conversation_id=conversation.id,
                viewer_user_id=owner_user_id,
                active_leaf_message_id=linear_assistant.id,
            )
        )
        db.commit()

        return {
            "conversation_id": str(conversation.id),
            "root_assistant_id": str(root_assistant.id),
            "root_assistant_content": root_assistant_content,
            "quote_exact": quote_exact,
            "active_leaf_message_id": str(linear_assistant.id),
            "quote_leaf_message_id": str(quote_assistant.id),
            "running_branch_id": str(running_user.id),
            "disposable_branch_id": str(disposable_user.id),
            "disposable_leaf_message_id": str(disposable_assistant.id),
        }


def main() -> None:
    owner_user_id = UUID(require_env("NEXUS_E2E_OWNER_USER_ID"))
    scenario = require_env("NEXUS_E2E_CONVERSATION_SCENARIO")
    if scenario == "scroll":
        message_count = int(require_env("NEXUS_E2E_MESSAGE_COUNT"))
        extra_conversation_count = int(
            os.getenv("NEXUS_E2E_EXTRA_CONVERSATION_COUNT", "0")
        )
        result = seed_scroll(owner_user_id, message_count, extra_conversation_count)
    elif scenario == "branching":
        result = seed_branching(owner_user_id)
    elif scenario == "cleanup":
        raw_conversation_ids = json.loads(require_env("NEXUS_E2E_CONVERSATION_IDS"))
        if not isinstance(raw_conversation_ids, list) or not all(
            isinstance(value, str) for value in raw_conversation_ids
        ):
            raise RuntimeError("NEXUS_E2E_CONVERSATION_IDS must be a JSON string list")
        result = cleanup_conversations(
            owner_user_id,
            [UUID(value) for value in raw_conversation_ids],
        )
    else:
        raise RuntimeError(f"Unknown scenario: {scenario}")

    print(json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        raise
