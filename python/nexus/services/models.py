"""LLM Models registry service layer."""

from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from nexus.config import get_settings
from nexus.db.models import Model
from nexus.llm_catalog import (
    ModelAvailableVia,
    enabled_provider_names,
    model_catalog_entry,
    platform_provider_names,
    provider_sort_rank,
)
from nexus.logging import get_logger
from nexus.schemas.models import ModelOut
from nexus.services.billing_entitlements import get_effective_entitlements
from nexus.services.user_keys import get_usable_key_providers

logger = get_logger(__name__)


def _tier_sort_rank(model_tier: str) -> int:
    return 0 if model_tier == "sota" else 1


def _available_via(
    provider: str, user_providers: set[str], platform_providers: set[str]
) -> ModelAvailableVia:
    has_byok = provider in user_providers
    has_platform = provider in platform_providers
    if has_byok and has_platform:
        return "both"
    if has_byok:
        return "byok"
    return "platform"


def list_available_models(db: Session, user_id: UUID) -> list[ModelOut]:
    """List curated models available to a specific user."""
    settings = get_settings()

    enabled_providers = set(enabled_provider_names(settings))

    platform_providers: set[str] = set()
    if get_effective_entitlements(db, user_id).can_use_platform_llm:
        platform_providers = set(platform_provider_names(settings))

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

    stmt = (
        select(Model)
        .where(
            Model.is_available.is_(True),
            Model.provider.in_(available_providers),
        )
        .order_by(Model.provider, Model.model_name)
    )
    models = db.scalars(stmt).all()

    curated: list[ModelOut] = []
    for model in models:
        catalog_entry = model_catalog_entry(model.provider, model.model_name)
        if catalog_entry is None:
            continue

        curated.append(
            ModelOut(
                id=model.id,
                provider=model.provider,
                provider_display_name=catalog_entry.provider_display_name,
                model_name=model.model_name,
                model_display_name=catalog_entry.model_display_name,
                model_tier=catalog_entry.model_tier,
                reasoning_modes=list(catalog_entry.reasoning_modes),
                max_context_tokens=model.max_context_tokens,
                available_via=_available_via(
                    model.provider,
                    user_providers=user_providers,
                    platform_providers=platform_providers,
                ),
            )
        )

    logger.info(
        "models_listed",
        user_id=str(user_id),
        model_count=len(curated),
        enabled_providers=sorted(enabled_providers),
        platform_providers=sorted(platform_providers),
        user_providers=sorted(user_providers),
    )

    curated.sort(
        key=lambda model: (
            provider_sort_rank(model.provider),
            _tier_sort_rank(model.model_tier),
            model.model_display_name,
        )
    )
    return curated
