"""Shared real-Postgres setup for durable chat proof."""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING
from uuid import UUID, uuid4

from sqlalchemy import select, text
from sqlalchemy.orm import Session

from nexus.db.models import ChatRun
from nexus.db.session import create_session_factory
from nexus.schemas.conversation import NewChatDestination
from nexus.services.billing_entitlements import grant_entitlement_override
from nexus.services.bootstrap import ensure_user_and_default_library
from nexus.services.chat_runs import create_chat_run
from nexus.services.rate_limit import RateLimiter, get_rate_limiter, set_rate_limiter

if TYPE_CHECKING:
    from nexus.schemas.chat_reader_selection import ReaderSelectionInput
    from nexus.services.generation_catalog import GenerationCatalogService
    from nexus.services.generation_selection import GenerationSelectionSpec
    from nexus.services.generation_service import ChatToolAuthority
    from nexus.services.tool_runtime.composition import ComposedToolRuntime


@dataclass(frozen=True, slots=True)
class EntitledChat:
    user_id: UUID
    conversation_id: UUID
    run_id: UUID
    job_id: UUID
    idempotency_key: str


async def create_entitled_chat(
    db: Session,
    *,
    content: str,
    catalog_definition_revision: str,
    selection: GenerationSelectionSpec,
    tool_authority: ChatToolAuthority,
    catalog: GenerationCatalogService,
    tool_runtime: ComposedToolRuntime,
    user_id: UUID | None = None,
    idempotency_key: str | None = None,
    reader_selection: ReaderSelectionInput | None = None,
) -> EntitledChat:
    """Create one exactly selected Chat through production admission owners."""
    owner_id = user_id or uuid4()
    ensure_user_and_default_library(
        db,
        owner_id,
        f"durable-chat-proof-{owner_id}@example.invalid",
    )
    grant_entitlement_override(
        db,
        user_id=owner_id,
        plan_tier="ai_pro",
        transcription_quota_mode="unlimited",
        transcription_minutes_limit_monthly=None,
        expires_at=None,
        reason="durable chat proof",
        actor_label="nexus-test",
    )
    prior_run_ids = set(db.scalars(select(ChatRun.id).where(ChatRun.owner_user_id == owner_id)))
    previous_limiter = get_rate_limiter()
    set_rate_limiter(RateLimiter(session_factory=create_session_factory(db.get_bind())))
    exact_idempotency_key = idempotency_key or f"durable-chat-proof-{uuid4()}"
    try:
        await create_chat_run(
            db,
            viewer_id=owner_id,
            destination=NewChatDestination(),
            reader_selection=reader_selection,
            content=content,
            catalog_definition_revision=catalog_definition_revision,
            selection=selection,
            tool_authority=tool_authority,
            idempotency_key=exact_idempotency_key,
            catalog=catalog,
            tool_runtime=tool_runtime,
        )
    finally:
        set_rate_limiter(previous_limiter)
    # Durable-chat fixtures depend on persisted identity, not the admission wire contract.
    new_runs = db.execute(
        select(ChatRun.id, ChatRun.conversation_id).where(
            ChatRun.owner_user_id == owner_id,
            ChatRun.id.not_in(prior_run_ids),
        )
    ).all()
    assert len(new_runs) == 1, (
        "entitled chat setup must persist exactly one new run: "
        f"owner={owner_id}, prior_count={len(prior_run_ids)}, new_runs={new_runs!r}"
    )
    run_id, conversation_id = new_runs[0]
    job_id = db.execute(
        text("SELECT id FROM background_jobs WHERE kind = 'chat_run' AND dedupe_key = :dedupe_key"),
        {"dedupe_key": f"chat_run:{run_id}"},
    ).scalar_one()
    db.commit()
    return EntitledChat(
        user_id=owner_id,
        conversation_id=conversation_id,
        run_id=run_id,
        job_id=job_id,
        idempotency_key=exact_idempotency_key,
    )
