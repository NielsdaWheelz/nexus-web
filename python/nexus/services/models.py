"""LLM Models registry service layer."""

from uuid import UUID

from provider_runtime import ModelCapability
from sqlalchemy import select
from sqlalchemy.orm import Session

from nexus.config import get_settings
from nexus.db.models import Model
from nexus.llm_catalog import (
    LLM_KEY_MODES,
    LLMKeyMode,
    ModelAvailableVia,
    chat_surface_capable,
    enabled_provider_names,
    platform_provider_names,
    provider_sort_rank,
    require_catalog_model,
    require_model_capabilities,
)
from nexus.logging import get_logger
from nexus.schemas.models import (
    ModelCapabilitiesOut,
    ModelOut,
    PromptCacheCapabilityOut,
)
from nexus.services.billing_entitlements import get_effective_entitlements
from nexus.services.user_keys import get_usable_key_providers

logger = get_logger(__name__)


def _tier_sort_rank(model_tier: str) -> int:
    return 0 if model_tier == "light" else 1


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


def _available_key_modes(available_via: ModelAvailableVia) -> list[LLMKeyMode]:
    modes: list[LLMKeyMode] = ["auto"]
    if available_via in {"byok", "both"}:
        modes.append("byok_only")
    if available_via in {"platform", "both"}:
        modes.append("platform_only")
    return modes


def _mark_default_models(models: list[ModelOut]) -> None:
    default_model_ids: set[UUID] = set()
    for key_mode in LLM_KEY_MODES:
        defaulted_providers: set[str] = set()
        for model in models:
            if key_mode not in model.available_key_modes:
                continue
            if model.provider in defaulted_providers:
                continue
            default_model_ids.add(model.id)
            defaulted_providers.add(model.provider)
    for model in models:
        model.is_default = model.id in default_model_ids


def _capabilities_out(capabilities: ModelCapability) -> ModelCapabilitiesOut:
    return ModelCapabilitiesOut(
        prompt_cache=PromptCacheCapabilityOut(
            mode=capabilities.prompt_cache.mode,
            supported=capabilities.prompt_cache.supported,
            key_required=capabilities.prompt_cache.requires_key,
            ttl_options=list(capabilities.prompt_cache.ttl_options),
        ),
        streaming=capabilities.streaming,
        tool_calling=capabilities.tool_calling,
        structured_output=capabilities.structured_output,
        structured_output_streaming=capabilities.structured_output_streaming,
        reasoning_continuation=capabilities.reasoning_continuation,
    )


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
        catalog_entry = require_catalog_model(model.provider, model.model_name)
        capabilities = require_model_capabilities(model.provider, model.model_name)
        if not chat_surface_capable(model.provider, model.model_name):
            continue
        available_via = _available_via(
            model.provider,
            user_providers=user_providers,
            platform_providers=platform_providers,
        )
        provider_rank = provider_sort_rank(model.provider)
        model_rank = _tier_sort_rank(catalog_entry.model_tier)

        curated.append(
            ModelOut(
                id=model.id,
                provider=catalog_entry.provider,
                provider_display_name=catalog_entry.provider_display_name,
                model_name=model.model_name,
                model_display_name=catalog_entry.model_display_name,
                model_tier=catalog_entry.model_tier,
                reasoning_modes=list(catalog_entry.reasoning_modes),
                max_context_tokens=catalog_entry.max_context_tokens,
                available_via=available_via,
                provider_rank=provider_rank,
                model_rank=model_rank,
                is_default=False,
                available_key_modes=_available_key_modes(available_via),
                capabilities=_capabilities_out(capabilities),
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
            model.provider_rank,
            model.model_rank,
            model.model_display_name,
        )
    )
    _mark_default_models(curated)
    return curated
