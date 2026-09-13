"""Shared real-Postgres setup for durable chat proof."""

from __future__ import annotations

from dataclasses import dataclass
from uuid import UUID, uuid4

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.db.session import create_session_factory
from nexus.schemas.conversation import NewChatDestination
from nexus.services.billing_entitlements import grant_entitlement_override
from nexus.services.bootstrap import ensure_user_and_default_library
from nexus.services.chat_runs import create_chat_run
from nexus.services.rate_limit import RateLimiter, get_rate_limiter, set_rate_limiter


@dataclass(frozen=True, slots=True)
class EntitledChat:
    user_id: UUID
    conversation_id: UUID
    run_id: UUID
    job_id: UUID


def create_entitled_chat(
    db: Session,
    *,
    content: str,
    user_id: UUID | None = None,
    profile_id: str = "balanced",
    reasoning_option_id: str = "medium",
) -> EntitledChat:
    """Create one admitted chat using production bootstrap, billing, and queue owners."""
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
        platform_token_quota_mode="unlimited",
        platform_token_limit_monthly=None,
        transcription_quota_mode="unlimited",
        transcription_minutes_limit_monthly=None,
        expires_at=None,
        reason="durable chat proof",
        actor_label="nexus-test",
    )
    previous_limiter = get_rate_limiter()
    set_rate_limiter(RateLimiter(session_factory=create_session_factory(db.get_bind())))
    try:
        response = create_chat_run(
            db,
            viewer_id=owner_id,
            destination=NewChatDestination(),
            reader_selection=None,
            content=content,
            profile_id=profile_id,
            reasoning_option_id=reasoning_option_id,
            idempotency_key=f"durable-chat-proof-{uuid4()}",
        )
    finally:
        set_rate_limiter(previous_limiter)
    run_id = response.run.id
    job_id = db.execute(
        text("SELECT id FROM background_jobs WHERE kind = 'chat_run' AND dedupe_key = :dedupe_key"),
        {"dedupe_key": f"chat_run:{run_id}"},
    ).scalar_one()
    db.commit()
    return EntitledChat(
        user_id=owner_id,
        conversation_id=response.conversation.id,
        run_id=run_id,
        job_id=job_id,
    )
