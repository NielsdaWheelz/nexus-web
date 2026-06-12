"""Canonical provider and model catalog for LLM-facing services."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, Protocol, cast

from provider_runtime import (
    DEFAULT_CATALOG,
    ModelCapability,
    ModelRef,
    ReasoningEffort,
)
from provider_runtime import (
    PromptCacheMode as RuntimePromptCacheMode,
)
from provider_runtime import (
    PromptCacheTTL as RuntimePromptCacheTTL,
)

type LLMProvider = Literal["openai", "anthropic", "gemini", "openrouter", "cloudflare"]
type LLMKeyProvider = Literal["openai", "anthropic", "gemini", "openrouter"]
type LLMKeyMode = Literal["auto", "byok_only", "platform_only"]
type ModelTier = Literal["sota", "light"]
type ReasoningMode = Literal[
    "default",
    "none",
    "minimal",
    "low",
    "medium",
    "high",
    "max",
]
type ModelAvailableVia = Literal["byok", "platform", "both"]
type PromptCacheMode = RuntimePromptCacheMode
type PromptCacheTTL = RuntimePromptCacheTTL

PROVIDER_ORDER: tuple[LLMProvider, ...] = (
    "openai",
    "anthropic",
    "gemini",
    "openrouter",
    "cloudflare",
)
KEY_PROVIDER_ORDER: tuple[LLMKeyProvider, ...] = (
    "openai",
    "anthropic",
    "gemini",
    "openrouter",
)
VALID_PROVIDERS: frozenset[str] = frozenset(PROVIDER_ORDER)
VALID_KEY_PROVIDERS: frozenset[str] = frozenset(KEY_PROVIDER_ORDER)
LLM_KEY_MODES: tuple[LLMKeyMode, ...] = ("auto", "byok_only", "platform_only")
VALID_KEY_MODES: frozenset[str] = frozenset(LLM_KEY_MODES)
PROVIDER_DISPLAY_NAMES: dict[LLMProvider, str] = {
    "openai": "OpenAI",
    "anthropic": "Anthropic",
    "gemini": "Google",
    "openrouter": "OpenRouter",
    "cloudflare": "Cloudflare",
}


class LLMProviderConfig(Protocol):
    enable_openai: bool
    enable_anthropic: bool
    enable_gemini: bool
    enable_openrouter: bool
    enable_cloudflare: bool
    openai_api_key: str | None
    anthropic_api_key: str | None
    gemini_api_key: str | None
    openrouter_api_key: str | None
    cloudflare_ai_api_token: str | None
    cloudflare_ai_account_id: str | None
    real_media_provider_fixtures: bool


@dataclass(frozen=True)
class ModelCatalogEntry:
    provider: LLMProvider
    model_name: str
    model_display_name: str
    model_tier: ModelTier

    @property
    def provider_display_name(self) -> str:
        return PROVIDER_DISPLAY_NAMES[self.provider]

    @property
    def reasoning_modes(self) -> tuple[ReasoningMode, ...]:
        return cast(
            tuple[ReasoningMode, ...],
            require_model_capabilities(
                self.provider,
                self.model_name,
            ).reasoning_modes,
        )

    @property
    def max_context_tokens(self) -> int:
        context_tokens = require_model_capabilities(
            self.provider, self.model_name
        ).max_context_tokens
        if context_tokens is None:
            raise AssertionError(f"{self.provider}/{self.model_name} lacks max_context_tokens")
        return context_tokens


MODEL_CATALOG: tuple[ModelCatalogEntry, ...] = (
    ModelCatalogEntry("openai", "gpt-5.5", "GPT-5.5", "sota"),
    ModelCatalogEntry("openai", "gpt-5.4-mini", "GPT-5.4 Mini", "light"),
    ModelCatalogEntry("anthropic", "claude-opus-4-8", "Opus 4.8", "sota"),
    ModelCatalogEntry("anthropic", "claude-sonnet-4-6", "Sonnet 4.6", "sota"),
    ModelCatalogEntry("anthropic", "claude-haiku-4-5-20251001", "Haiku 4.5", "light"),
    ModelCatalogEntry("gemini", "gemini-3.1-pro-preview", "Gemini 3.1 Pro", "sota"),
    ModelCatalogEntry("gemini", "gemini-3-flash-preview", "Gemini 3 Flash", "light"),
    ModelCatalogEntry("openrouter", "moonshotai/kimi-k2.6", "Kimi K2.6 via OpenRouter", "sota"),
    ModelCatalogEntry("openrouter", "openai/gpt-5.5", "GPT-5.5 via OpenRouter", "sota"),
    ModelCatalogEntry("openrouter", "openai/gpt-5.4-mini", "GPT-5.4 Mini via OpenRouter", "light"),
    ModelCatalogEntry("cloudflare", "@cf/openai/gpt-oss-20b", "GPT-OSS 20B", "light"),
)

_MODEL_CATALOG_BY_KEY = {(entry.provider, entry.model_name): entry for entry in MODEL_CATALOG}
_PROVIDER_ENABLE_ATTRS: dict[LLMProvider, str] = {
    "openai": "enable_openai",
    "anthropic": "enable_anthropic",
    "gemini": "enable_gemini",
    "openrouter": "enable_openrouter",
    "cloudflare": "enable_cloudflare",
}
_PROVIDER_KEY_ATTRS: dict[LLMProvider, str] = {
    "openai": "openai_api_key",
    "anthropic": "anthropic_api_key",
    "gemini": "gemini_api_key",
    "openrouter": "openrouter_api_key",
    "cloudflare": "cloudflare_ai_api_token",
}


def provider_display_name(provider: str) -> str | None:
    if provider not in VALID_PROVIDERS:
        return None
    return PROVIDER_DISPLAY_NAMES[cast(LLMProvider, provider)]


def model_catalog_entry(provider: str, model_name: str) -> ModelCatalogEntry | None:
    if provider not in VALID_PROVIDERS:
        return None
    return _MODEL_CATALOG_BY_KEY.get((cast(LLMProvider, provider), model_name))


def model_max_context_tokens(provider: str, model_name: str) -> int:
    """Shared catalog context window for runtime budgeting."""

    return require_catalog_model(provider, model_name).max_context_tokens


def model_reasoning_reserve_tokens(provider: str, model_name: str, reasoning: str) -> int:
    """Shared catalog reserve for hidden/provider-side reasoning budget."""

    capabilities = require_model_capabilities(provider, model_name)
    if reasoning not in capabilities.reasoning_modes:
        raise ValueError(f"Unknown reasoning mode for {provider}/{model_name}: {reasoning}")
    return capabilities.reasoning_reserve_tokens.get(cast(ReasoningEffort, reasoning), 0)


def model_capabilities(provider: str, model_name: str) -> ModelCapability | None:
    if provider not in VALID_PROVIDERS:
        return None
    return DEFAULT_CATALOG.capabilities(
        ModelRef(provider=cast(LLMProvider, provider), model=model_name)
    )


def require_catalog_model(provider: str, model_name: str) -> ModelCatalogEntry:
    """The catalog entry for a surface's pinned model; absence is a defect."""
    entry = model_catalog_entry(provider, model_name)
    if entry is None:
        # justify-defect: a surface pinned a provider/model pair that is not in
        # MODEL_CATALOG — code/catalog mismatch, caught at import/test time.
        raise AssertionError(f"{provider}/{model_name} is not in MODEL_CATALOG")
    return entry


def require_model_capabilities(provider: str, model_name: str) -> ModelCapability:
    capabilities = model_capabilities(provider, model_name)
    if capabilities is None:
        # justify-defect: provider/model capabilities are shared runtime catalog truth.
        raise AssertionError(f"{provider}/{model_name} is not in MODEL_CATALOG")
    return capabilities


def chat_surface_capable(provider: str, model_name: str) -> bool:
    capabilities = require_model_capabilities(provider, model_name)
    return capabilities.generation and capabilities.streaming and capabilities.tool_calling


def provider_sort_rank(provider: str) -> int:
    if provider not in VALID_PROVIDERS:
        return 999
    return PROVIDER_ORDER.index(cast(LLMProvider, provider))


def enabled_provider_names(settings: LLMProviderConfig) -> tuple[LLMProvider, ...]:
    return tuple(provider for provider in PROVIDER_ORDER if is_provider_enabled(provider, settings))


def enabled_key_provider_names(settings: LLMProviderConfig) -> tuple[LLMKeyProvider, ...]:
    return tuple(
        provider for provider in KEY_PROVIDER_ORDER if is_provider_enabled(provider, settings)
    )


def is_provider_enabled(provider: str, settings: LLMProviderConfig) -> bool:
    if provider not in VALID_PROVIDERS:
        return False
    return bool(getattr(settings, _PROVIDER_ENABLE_ATTRS[cast(LLMProvider, provider)]))


def configured_platform_key(provider: str, settings: LLMProviderConfig) -> str | None:
    if provider not in VALID_PROVIDERS:
        return None
    if provider == "cloudflare" and not settings.cloudflare_ai_account_id:
        return None
    return getattr(settings, _PROVIDER_KEY_ATTRS[cast(LLMProvider, provider)])


def platform_key_for_provider(provider: str, settings: LLMProviderConfig) -> str | None:
    if settings.real_media_provider_fixtures and is_provider_enabled(provider, settings):
        return "real-media-fixture"
    return configured_platform_key(provider, settings)


def platform_provider_names(settings: LLMProviderConfig) -> set[LLMProvider]:
    if settings.real_media_provider_fixtures:
        return set(enabled_provider_names(settings))
    return {
        provider
        for provider in PROVIDER_ORDER
        if is_provider_enabled(provider, settings) and configured_platform_key(provider, settings)
    }
