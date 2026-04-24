"""LLM Models registry service layer."""

from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from nexus.config import get_settings
from nexus.db.models import Model
from nexus.logging import get_logger
from nexus.schemas.keys import ModelOut
from nexus.services.billing import get_entitlements
from nexus.services.user_keys import get_usable_key_providers

logger = get_logger(__name__)


def get_model_catalog_metadata(
    provider: str,
    model_name: str,
) -> tuple[str, str, str, list[str]] | None:
    """Return curated catalog metadata for supported models.

    Returns:
        (provider_display_name, model_display_name, model_tier, reasoning_modes)
        or None if model is outside the curated catalog.
    """
    if provider == "openai":
        if model_name == "gpt-5.5":
            return (
                "OpenAI",
                "GPT-5.5",
                "sota",
                ["none", "low", "medium", "high", "max"],
            )
        if model_name == "gpt-5.4-mini":
            return (
                "OpenAI",
                "GPT-5.4 Mini",
                "light",
                ["none", "low", "medium", "high", "max"],
            )
        return None

    if provider == "anthropic":
        if model_name == "claude-opus-4-7":
            return (
                "Anthropic",
                "Opus 4.7",
                "sota",
                ["none", "low", "medium", "high", "max"],
            )
        if model_name == "claude-sonnet-4-6":
            return (
                "Anthropic",
                "Sonnet 4.6",
                "sota",
                ["none", "low", "medium", "high", "max"],
            )
        if model_name == "claude-haiku-4-5-20251001":
            return (
                "Anthropic",
                "Haiku 4.5",
                "light",
                ["none", "low", "medium", "high"],
            )
        return None

    if provider == "gemini":
        if model_name == "gemini-3.1-pro-preview":
            return (
                "Google",
                "Gemini 3.1 Pro",
                "sota",
                ["low", "high"],
            )
        if model_name == "gemini-3-flash-preview":
            return (
                "Google",
                "Gemini 3 Flash",
                "light",
                ["minimal", "low", "medium", "high"],
            )
        return None

    if provider == "deepseek":
        if model_name == "deepseek-v4-pro":
            return (
                "DeepSeek",
                "DeepSeek V4 Pro",
                "sota",
                ["high"],
            )
        if model_name == "deepseek-v4-flash":
            return (
                "DeepSeek",
                "DeepSeek V4 Flash",
                "light",
                ["none", "high"],
            )
        return None

    return None


def _provider_sort_rank(provider: str) -> int:
    if provider == "openai":
        return 0
    if provider == "anthropic":
        return 1
    if provider == "gemini":
        return 2
    if provider == "deepseek":
        return 3
    return 999


def _tier_sort_rank(model_tier: str) -> int:
    return 0 if model_tier == "sota" else 1


def _available_via(provider: str, user_providers: set[str], platform_providers: set[str]) -> str:
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
    if get_entitlements(db, user_id).can_use_platform_llm:
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

    stmt = (
        select(Model)
        .where(
            Model.is_available == True,  # noqa: E712
            Model.provider.in_(available_providers),
        )
        .order_by(Model.provider, Model.model_name)
    )
    models = db.scalars(stmt).all()

    curated: list[ModelOut] = []
    for model in models:
        metadata = get_model_catalog_metadata(model.provider, model.model_name)
        if metadata is None:
            continue

        provider_display_name, model_display_name, model_tier, reasoning_modes = metadata
        curated.append(
            ModelOut(
                id=model.id,
                provider=model.provider,
                provider_display_name=provider_display_name,
                model_name=model.model_name,
                model_display_name=model_display_name,
                model_tier=model_tier,
                reasoning_modes=reasoning_modes,
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
            _provider_sort_rank(model.provider),
            _tier_sort_rank(model.model_tier),
            model.model_display_name,
        )
    )
    return curated
