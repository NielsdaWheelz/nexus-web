"""API key resolution service for LLM requests.

Handles resolution of API keys for LLM provider calls, supporting both
platform keys and BYOK (bring your own key).

Resolution behavior:
- key_mode="auto": Try BYOK first, fall back to platform
- key_mode="byok_only": Use only user's key
- key_mode="platform_only": Use only platform key

This module owns DB-backed key lookup. The LLM adapter layer remains DB-free.
"""

from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Literal
from uuid import UUID

from llm_calling.errors import LLMError, LLMErrorCode
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from nexus.config import get_settings
from nexus.db.models import Model, UserApiKey
from nexus.errors import ApiError, ApiErrorCode
from nexus.llm_catalog import is_provider_enabled, platform_key_for_provider
from nexus.logging import get_logger
from nexus.services.billing_entitlements import get_effective_entitlements
from nexus.services.user_keys import decrypt_user_api_key_material

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

    Resolution behavior:
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

    if not is_provider_enabled(provider, settings):
        raise ApiError(
            ApiErrorCode.E_MODEL_NOT_AVAILABLE,
            f"Provider is disabled: {provider}",
        )

    platform_key = platform_key_for_provider(provider, settings)

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

    if user_key_row:
        user_key = decrypt_user_api_key_material(user_key_row)
        if user_key:
            user_key_id = str(user_key_row.id)

    can_use_platform_key = get_effective_entitlements(db, user_id).can_use_platform_llm

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
            error_code=LLMErrorCode.INVALID_KEY,
            message=f"No BYOK key available for {provider}",
        )

    elif key_mode == "platform_only":
        if not can_use_platform_key:
            raise ApiError(
                ApiErrorCode.E_BILLING_REQUIRED,
                "Platform LLM access requires an AI tier.",
            )
        if platform_key:
            return ResolvedKey(
                api_key=platform_key,
                mode="platform",
                provider=provider,
            )
        raise LLMError(
            error_code=LLMErrorCode.INVALID_KEY,
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
        if not can_use_platform_key:
            raise ApiError(
                ApiErrorCode.E_BILLING_REQUIRED,
                "Platform LLM access requires an AI tier.",
            )
        if platform_key:
            return ResolvedKey(
                api_key=platform_key,
                mode="platform",
                provider=provider,
            )
        raise LLMError(
            error_code=LLMErrorCode.INVALID_KEY,
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
        key = db.get(UserApiKey, UUID(user_key_id))
        if key and key.status not in ("revoked",):
            now = datetime.now(UTC)
            key.status = status
            key.last_tested_at = now
            key.last_used_at = now
            db.flush()
    except (SQLAlchemyError, ValueError) as e:
        logger.warning(
            "key_status_update_failed",
            user_key_id=user_key_id,
            status=status,
            error=str(e),
        )
