"""API key resolution service for LLM requests.

Handles resolution of API keys for LLM provider calls, supporting both
platform keys and BYOK (bring your own key).

Per PR-05 spec:
- key_mode="auto": Try BYOK first, fall back to platform
- key_mode="byok_only": Use only user's key
- key_mode="platform_only": Use only platform key

Note: This module has DB access and is intentionally kept outside the LLM
adapter layer (which must be DB-free per PR-04 spec).
"""

from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Literal
from uuid import UUID

from sqlalchemy.orm import Session

from nexus.config import get_settings
from nexus.db.models import Model, UserApiKey
from nexus.logging import get_logger
from nexus.services.crypto import decrypt_api_key
from nexus.services.llm.errors import LLMError, LLMErrorClass

logger = get_logger(__name__)


@dataclass
class ResolvedKey:
    """Result of API key resolution."""

    api_key: str
    mode: Literal["platform", "byok"]
    provider: str
    user_key_id: str | None = None  # Set if BYOK


def resolve_api_key(
    db: Session,
    user_id: UUID,
    provider: str,
    key_mode: str,
) -> ResolvedKey:
    """Resolve the API key to use for a request.

    Per PR-05 spec:
    - key_mode="auto": Try BYOK first, fall back to platform
    - key_mode="byok_only": Use only user's key
    - key_mode="platform_only": Use only platform key

    Args:
        db: Database session.
        user_id: User making the request.
        provider: LLM provider.
        key_mode: Requested key mode.

    Returns:
        ResolvedKey with the API key and metadata.

    Raises:
        LLMError: If no key is available.
    """
    settings = get_settings()

    # Get platform key if exists
    platform_key = None
    if provider == "openai":
        platform_key = settings.openai_api_key
    elif provider == "anthropic":
        platform_key = settings.anthropic_api_key
    elif provider == "gemini":
        platform_key = settings.gemini_api_key

    # Get user BYOK if exists and usable
    user_key = None
    user_key_id = None
    user_key_row = (
        db.query(UserApiKey)
        .filter(
            UserApiKey.user_id == user_id,
            UserApiKey.provider == provider,
            UserApiKey.status.in_(["untested", "valid"]),
        )
        .first()
    )

    if user_key_row and user_key_row.encrypted_key and user_key_row.key_nonce:
        try:
            user_key = decrypt_api_key(
                user_key_row.encrypted_key,
                user_key_row.key_nonce,
                user_key_row.master_key_version or 1,
            )
            user_key_id = str(user_key_row.id)
        except Exception as e:
            logger.warning(
                "user_key_decrypt_failed",
                user_id=str(user_id),
                provider=provider,
                error=str(e),
            )
            user_key = None

    # Resolve based on mode
    if key_mode == "byok_only":
        if user_key:
            return ResolvedKey(
                api_key=user_key,
                mode="byok",
                provider=provider,
                user_key_id=user_key_id,
            )
        raise LLMError(
            error_class=LLMErrorClass.INVALID_KEY,
            message=f"No BYOK key available for {provider}",
        )

    elif key_mode == "platform_only":
        if platform_key:
            return ResolvedKey(
                api_key=platform_key,
                mode="platform",
                provider=provider,
            )
        raise LLMError(
            error_class=LLMErrorClass.INVALID_KEY,
            message=f"No platform key configured for {provider}",
        )

    else:  # auto
        # Try BYOK first
        if user_key:
            return ResolvedKey(
                api_key=user_key,
                mode="byok",
                provider=provider,
                user_key_id=user_key_id,
            )
        # Fall back to platform
        if platform_key:
            return ResolvedKey(
                api_key=platform_key,
                mode="platform",
                provider=provider,
            )
        raise LLMError(
            error_class=LLMErrorClass.INVALID_KEY,
            message=f"No API key available for {provider}",
        )


def get_model_by_id(db: Session, model_id: UUID) -> Model | None:
    """Get a model by ID from the registry."""
    return db.get(Model, model_id)


def update_user_key_status(
    db: Session,
    user_key_id: str | None,
    status: str,
) -> None:
    """Update user API key status after a provider call.

    Args:
        db: Database session.
        user_key_id: The user key ID (if BYOK was used).
        status: New status ("valid" or "invalid").
    """
    if not user_key_id:
        return

    try:
        from uuid import UUID as UUIDType

        key = db.get(UserApiKey, UUIDType(user_key_id))
        if key and key.status not in ("revoked",):
            key.status = status
            key.last_tested_at = datetime.now(UTC)
            db.flush()
    except Exception as e:
        logger.warning(
            "key_status_update_failed",
            user_key_id=user_key_id,
            status=status,
            error=str(e),
        )
