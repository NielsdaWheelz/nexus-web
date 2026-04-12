"""LLM Models registry service layer.

Handles model availability and filtering:
- List models available to a specific user
- Model availability rules based on key status

Per PR-03 spec, a model is available to a user iff:
- model.is_available = true
- model.provider is enabled by feature flag
- provider has usable credentials:
  - platform key exists for model.provider
  - OR user has API key with status ∈ {'untested', 'valid'}

Notes:
- Keys with status='invalid' or status='revoked' do NOT enable models
- Empty model list is valid if no models are available
"""

from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from nexus.config import get_settings
from nexus.db.models import Model
from nexus.logging import get_logger
from nexus.schemas.keys import ModelOut
from nexus.services.user_keys import get_usable_key_providers

logger = get_logger(__name__)


def list_available_models(db: Session, user_id: UUID) -> list[ModelOut]:
    """List models available to a specific user.

    A model is available iff:
    - model.is_available = true
    - provider is enabled by feature flag
    - AND (platform key exists for provider OR user has usable BYOK)

    Args:
        db: Database session.
        user_id: The user's ID.

    Returns:
        List of ModelOut for available models.
    """
    settings = get_settings()

    enabled_providers: set[str] = set()
    if settings.enable_openai:
        enabled_providers.add("openai")
    if settings.enable_anthropic:
        enabled_providers.add("anthropic")
    if settings.enable_gemini:
        enabled_providers.add("gemini")
    if settings.enable_deepseek:
        enabled_providers.add("deepseek")

    platform_providers: set[str] = set()
    if settings.openai_api_key:
        platform_providers.add("openai")
    if settings.anthropic_api_key:
        platform_providers.add("anthropic")
    if settings.gemini_api_key:
        platform_providers.add("gemini")
    if settings.deepseek_api_key:
        platform_providers.add("deepseek")

    user_providers = get_usable_key_providers(db, user_id)

    key_enabled_providers = platform_providers | user_providers
    available_providers = enabled_providers & key_enabled_providers

    if not available_providers:
        logger.info(
            "no_models_available",
            user_id=str(user_id),
            reason="no_enabled_provider_with_key",
            enabled_providers=sorted(enabled_providers),
            platform_providers=sorted(platform_providers),
            user_providers=sorted(user_providers),
        )
        return []

    # Query models that are available and have an available provider
    stmt = (
        select(Model)
        .where(
            Model.is_available == True,  # noqa: E712
            Model.provider.in_(available_providers),
        )
        .order_by(Model.provider, Model.model_name)
    )
    models = db.scalars(stmt).all()

    logger.info(
        "models_listed",
        user_id=str(user_id),
        model_count=len(models),
        enabled_providers=sorted(enabled_providers),
        platform_providers=sorted(platform_providers),
        user_providers=sorted(user_providers),
    )

    return [
        ModelOut(
            id=model.id,
            provider=model.provider,
            model_name=model.model_name,
            max_context_tokens=model.max_context_tokens,
        )
        for model in models
    ]
