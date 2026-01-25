"""LLM Models registry service layer.

Handles model availability and filtering:
- List models available to a specific user
- Model availability rules based on key status

Per PR-03 spec, a model is available to a user iff:
- model.is_available = true AND (
    platform key exists for model.provider
    OR user has API key with status ∈ {'untested', 'valid'}
  )

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


def get_platform_key_providers() -> set[str]:
    """Get providers for which platform keys are configured.

    Reads from environment variables:
    - OPENAI_API_KEY
    - ANTHROPIC_API_KEY
    - GEMINI_API_KEY

    Returns:
        Set of provider names with platform keys configured.
    """
    settings = get_settings()
    providers = set()

    if settings.openai_api_key:
        providers.add("openai")
    if settings.anthropic_api_key:
        providers.add("anthropic")
    if settings.gemini_api_key:
        providers.add("gemini")

    return providers


def list_available_models(db: Session, user_id: UUID) -> list[ModelOut]:
    """List models available to a specific user.

    A model is available iff:
    - model.is_available = true
    - AND (platform key exists for provider OR user has usable BYOK)

    Args:
        db: Database session.
        user_id: The user's ID.

    Returns:
        List of ModelOut for available models.
    """
    # Get providers with usable keys
    platform_providers = get_platform_key_providers()
    user_providers = get_usable_key_providers(db, user_id)

    # Union of providers with any valid key
    available_providers = platform_providers | user_providers

    if not available_providers:
        logger.info(
            "no_models_available",
            user_id=str(user_id),
            reason="no_keys",
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
        platform_providers=list(platform_providers),
        user_providers=list(user_providers),
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
