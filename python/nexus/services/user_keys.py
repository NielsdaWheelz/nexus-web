"""User API Key service layer.

Handles BYOK (Bring Your Own Key) API key management:
- List user's API keys (safe fields only)
- Upsert (add/update) keys with encryption
- Revoke keys (wipe ciphertext, retain fingerprint)

Per PR-03 spec:
- Keys are encrypted at rest using XChaCha20-Poly1305
- Fingerprint is last 4 chars (retained on revoke for audit)
- Upsert by (user_id, provider) - same provider = same row
- Revoke wipes encrypted_key, key_nonce, master_key_version to NULL
- Status transitions: untested → valid/invalid (via LLM calls in PR-04)
- Revoked keys have status='revoked' and revoked_at set

Security invariants:
- Plaintext keys never persist beyond request scope
- Never log plaintext keys
- encrypted_key, key_nonce, master_key_version never returned to clients
"""

from datetime import UTC, datetime
from typing import cast
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from nexus.config import get_settings
from nexus.db.models import UserApiKey
from nexus.errors import ApiError, ApiErrorCode
from nexus.logging import get_logger
from nexus.schemas.keys import KeyProviderStateStatus, UserApiKeyOut
from nexus.services.crypto import decrypt_api_key, encrypt_api_key
from nexus.services.llm import LLMRouter
from nexus.services.llm.errors import LLMError, LLMErrorClass
from nexus.services.llm.types import LLMCallContext, LLMOperation, LLMRequest, Turn

logger = get_logger(__name__)

# Valid providers (lowercase only)
VALID_PROVIDERS = frozenset({"openai", "anthropic", "gemini", "deepseek"})
PROVIDER_ORDER = ("openai", "anthropic", "gemini", "deepseek")
PROVIDER_DISPLAY_NAMES = {
    "openai": "OpenAI",
    "anthropic": "Anthropic",
    "gemini": "Google",
    "deepseek": "DeepSeek",
}
KEY_TEST_MODELS = {
    "openai": "gpt-5.4-mini",
    "anthropic": "claude-haiku-4-5-20251001",
    "gemini": "gemini-3-flash-preview",
    "deepseek": "deepseek-v4-flash",
}


def _enabled_providers() -> tuple[str, ...]:
    settings = get_settings()
    enabled: list[str] = []
    if settings.enable_openai:
        enabled.append("openai")
    if settings.enable_anthropic:
        enabled.append("anthropic")
    if settings.enable_gemini:
        enabled.append("gemini")
    if settings.enable_deepseek:
        enabled.append("deepseek")
    return tuple(enabled)


def _key_to_out(key: UserApiKey) -> UserApiKeyOut:
    fingerprint = key.key_fingerprint
    return UserApiKeyOut(
        id=key.id,
        provider=key.provider,
        provider_display_name=PROVIDER_DISPLAY_NAMES[key.provider],
        fingerprint=fingerprint,
        key_fingerprint=fingerprint,
        status=cast(KeyProviderStateStatus, key.status),
        created_at=key.created_at,
        last_tested_at=key.last_tested_at,
        last_used_at=key.last_used_at,
    )


def _missing_provider_out(provider: str) -> UserApiKeyOut:
    return UserApiKeyOut(
        provider=provider,
        provider_display_name=PROVIDER_DISPLAY_NAMES[provider],
        status="missing",
    )


def list_user_keys(db: Session, user_id: UUID) -> list[UserApiKeyOut]:
    """List enabled provider states for a user.

    Returns only safe fields - never includes encrypted_key, nonce, or version.

    Args:
        db: Database session.
        user_id: The user's ID.

    Returns:
        List of provider states with safe fields only.
    """
    enabled_providers = _enabled_providers()
    stmt = (
        select(UserApiKey)
        .where(UserApiKey.user_id == user_id)
        .where(UserApiKey.provider.in_(enabled_providers))
    )
    keys = db.scalars(stmt).all()
    keys_by_provider = {key.provider: key for key in keys}

    return [
        _key_to_out(keys_by_provider[provider])
        if provider in keys_by_provider
        else _missing_provider_out(provider)
        for provider in PROVIDER_ORDER
        if provider in enabled_providers
    ]


def upsert_user_key(
    db: Session,
    user_id: UUID,
    provider: str,
    api_key: str,
) -> tuple[UserApiKeyOut, bool]:
    """Add or update an API key for a provider.

    This is an upsert operation: if a key already exists for (user_id, provider),
    it is overwritten with new encryption.

    Per PR-03 spec, on upsert:
    - Generate new nonce
    - Re-encrypt with new ciphertext
    - Set status = 'untested'
    - Update key_fingerprint (last 4 chars)
    - Clear last_tested_at
    - Clear revoked_at

    Args:
        db: Database session.
        user_id: The user's ID.
        provider: The LLM provider (openai, anthropic, gemini, deepseek).
        api_key: The plaintext API key (already validated by schema).

    Returns:
        Tuple of (UserApiKeyOut, is_created) where is_created is True for new key.

    Raises:
        ApiError: E_KEY_PROVIDER_INVALID if provider is invalid.
        ApiError: E_KEY_INVALID_FORMAT if key format is invalid.
    """
    # Normalize provider to lowercase
    provider = provider.lower()

    # Validate provider
    if provider not in VALID_PROVIDERS:
        raise ApiError(
            ApiErrorCode.E_KEY_PROVIDER_INVALID,
            f"Unknown provider: {provider}. Must be one of: {', '.join(sorted(VALID_PROVIDERS))}",
        )

    # Validate key format (defensive - schema should have already validated)
    api_key = api_key.strip()
    if len(api_key) < 20:
        raise ApiError(ApiErrorCode.E_KEY_INVALID_FORMAT, "API key too short")
    if any(c.isspace() for c in api_key):
        raise ApiError(ApiErrorCode.E_KEY_INVALID_FORMAT, "API key contains whitespace")

    # Encrypt the key
    ciphertext, nonce, version, fingerprint = encrypt_api_key(api_key)

    # Check if key already exists for this user/provider
    stmt = select(UserApiKey).where(
        UserApiKey.user_id == user_id,
        UserApiKey.provider == provider,
    )
    existing_key = db.scalars(stmt).first()

    if existing_key:
        # Update existing key
        existing_key.encrypted_key = ciphertext
        existing_key.key_nonce = nonce
        existing_key.master_key_version = version
        existing_key.key_fingerprint = fingerprint
        existing_key.status = "untested"
        existing_key.last_tested_at = None
        existing_key.last_used_at = None
        existing_key.revoked_at = None

        db.flush()
        db.commit()

        logger.info(
            "user_key_updated",
            user_id=str(user_id),
            provider=provider,
            fingerprint=fingerprint,
        )

        return (
            _key_to_out(existing_key),
            False,  # Not created (updated)
        )

    # Create new key
    new_key = UserApiKey(
        user_id=user_id,
        provider=provider,
        encrypted_key=ciphertext,
        key_nonce=nonce,
        master_key_version=version,
        key_fingerprint=fingerprint,
        status="untested",
    )
    db.add(new_key)
    db.flush()
    db.commit()

    logger.info(
        "user_key_created",
        user_id=str(user_id),
        provider=provider,
        fingerprint=fingerprint,
    )

    return (
        _key_to_out(new_key),
        True,  # Created
    )


async def test_user_key(
    db: Session,
    user_id: UUID,
    key_id: UUID,
    router: LLMRouter,
) -> UserApiKeyOut:
    """Validate a saved BYOK key and update its status.

    The plaintext key is decrypted only for the outbound provider validation call
    and is never logged or returned.
    """
    stmt = select(UserApiKey).where(
        UserApiKey.id == key_id,
        UserApiKey.user_id == user_id,
    )
    key = db.scalars(stmt).first()
    if not key or key.status == "revoked" or not key.encrypted_key or not key.key_nonce:
        raise ApiError(ApiErrorCode.E_KEY_NOT_FOUND, "API key not found")

    try:
        api_key = decrypt_api_key(
            key.encrypted_key,
            key.key_nonce,
            key.master_key_version or 1,
        )
    except Exception as e:
        logger.warning(
            "user_key_decrypt_failed",
            user_id=str(user_id),
            key_id=str(key_id),
            provider=key.provider,
            error=type(e).__name__,
        )
        key.status = "invalid"
        key.last_tested_at = datetime.now(UTC)
        db.commit()
        return _key_to_out(key)

    req = LLMRequest(
        model_name=KEY_TEST_MODELS[key.provider],
        messages=[Turn(role="user", content="Reply with ok.")],
        max_tokens=8,
        reasoning_effort="none",
    )

    try:
        await router.generate(
            key.provider,
            req,
            api_key,
            timeout_s=15,
            key_mode="byok",
            call_context=LLMCallContext(operation=LLMOperation.KEY_TEST),
        )
    except LLMError as e:
        if e.error_class == LLMErrorClass.INVALID_KEY:
            key.status = "invalid"
            key.last_tested_at = datetime.now(UTC)
            db.commit()
            return _key_to_out(key)

        try:
            code = ApiErrorCode(e.error_class.value)
        except ValueError:
            code = ApiErrorCode.E_LLM_PROVIDER_DOWN
        raise ApiError(code, e.message) from e
    finally:
        api_key = ""

    key.status = "valid"
    key.last_tested_at = datetime.now(UTC)
    db.commit()

    logger.info(
        "user_key_tested",
        user_id=str(user_id),
        key_id=str(key_id),
        provider=key.provider,
        status=key.status,
        fingerprint=key.key_fingerprint,
    )

    return _key_to_out(key)


def revoke_user_key(db: Session, user_id: UUID, key_id: UUID) -> None:
    """Revoke a user's API key.

    Per PR-03 spec, secure revocation wipes ciphertext:
    - Set status = 'revoked'
    - Set revoked_at = now()
    - Set encrypted_key = NULL
    - Set key_nonce = NULL
    - Set master_key_version = NULL
    - Retain key_fingerprint for audit trail

    Idempotent: revoking an already-revoked key is a no-op (returns success).

    Args:
        db: Database session.
        user_id: The user's ID.
        key_id: The key's ID.

    Raises:
        ApiError: E_KEY_NOT_FOUND if key doesn't exist or not owned by user.
    """
    # Find the key and verify ownership
    stmt = select(UserApiKey).where(
        UserApiKey.id == key_id,
        UserApiKey.user_id == user_id,
    )
    key = db.scalars(stmt).first()

    if not key:
        raise ApiError(
            ApiErrorCode.E_KEY_NOT_FOUND,
            "API key not found",
        )

    # Idempotent: if already revoked, do nothing
    if key.status == "revoked":
        logger.info(
            "user_key_revoke_idempotent",
            user_id=str(user_id),
            key_id=str(key_id),
            fingerprint=key.key_fingerprint,
        )
        return

    # Wipe ciphertext and mark as revoked
    key.encrypted_key = None  # type: ignore[assignment]
    key.key_nonce = None  # type: ignore[assignment]
    key.master_key_version = None  # type: ignore[assignment]
    key.status = "revoked"
    key.revoked_at = datetime.now(UTC)
    # key_fingerprint is retained for audit trail

    db.flush()
    db.commit()

    logger.info(
        "user_key_revoked",
        user_id=str(user_id),
        key_id=str(key_id),
        fingerprint=key.key_fingerprint,
    )


def get_usable_key_providers(db: Session, user_id: UUID) -> set[str]:
    """Get providers for which the user has a usable API key.

    A key is "usable" iff:
    - status ∈ {'untested', 'valid'} (not 'invalid' or 'revoked')

    Args:
        db: Database session.
        user_id: The user's ID.

    Returns:
        Set of provider names with usable keys.
    """
    stmt = select(UserApiKey.provider).where(
        UserApiKey.user_id == user_id,
        UserApiKey.status.in_(["untested", "valid"]),
        UserApiKey.encrypted_key.is_not(None),
        UserApiKey.key_nonce.is_not(None),
    )
    providers = db.scalars(stmt).all()
    return set(providers)
