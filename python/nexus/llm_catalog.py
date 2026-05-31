"""Canonical provider and model catalog for LLM-facing services."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, Protocol, cast

type LLMProvider = Literal["openai", "anthropic", "gemini", "deepseek"]
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

PROVIDER_ORDER: tuple[LLMProvider, ...] = ("openai", "anthropic", "gemini", "deepseek")
VALID_PROVIDERS: frozenset[str] = frozenset(PROVIDER_ORDER)
PROVIDER_DISPLAY_NAMES: dict[LLMProvider, str] = {
    "openai": "OpenAI",
    "anthropic": "Anthropic",
    "gemini": "Google",
    "deepseek": "DeepSeek",
}
KEY_TEST_MODELS: dict[LLMProvider, str] = {
    "openai": "gpt-5.4-mini",
    "anthropic": "claude-haiku-4-5-20251001",
    "gemini": "gemini-3-flash-preview",
    "deepseek": "deepseek-v4-flash",
}
OPENAI_REASONING_MODES: tuple[ReasoningMode, ...] = (
    "default",
    "none",
    "low",
    "medium",
    "high",
    "max",
)


class LLMProviderConfig(Protocol):
    enable_openai: bool
    enable_anthropic: bool
    enable_gemini: bool
    enable_deepseek: bool
    openai_api_key: str | None
    anthropic_api_key: str | None
    gemini_api_key: str | None
    deepseek_api_key: str | None
    real_media_provider_fixtures: bool


@dataclass(frozen=True)
class ModelCatalogEntry:
    provider: LLMProvider
    model_name: str
    model_display_name: str
    model_tier: ModelTier
    reasoning_modes: tuple[ReasoningMode, ...]
    max_context_tokens: int

    @property
    def provider_display_name(self) -> str:
        return PROVIDER_DISPLAY_NAMES[self.provider]


MODEL_CATALOG: tuple[ModelCatalogEntry, ...] = (
    ModelCatalogEntry("openai", "gpt-5.5", "GPT-5.5", "sota", OPENAI_REASONING_MODES, 400000),
    ModelCatalogEntry(
        "openai",
        "gpt-5.4-mini",
        "GPT-5.4 Mini",
        "light",
        OPENAI_REASONING_MODES,
        400000,
    ),
    ModelCatalogEntry(
        "anthropic",
        "claude-opus-4-7",
        "Opus 4.7",
        "sota",
        ("none", "low", "medium", "high", "max"),
        1000000,
    ),
    ModelCatalogEntry(
        "anthropic",
        "claude-sonnet-4-6",
        "Sonnet 4.6",
        "sota",
        ("none", "low", "medium", "high", "max"),
        1000000,
    ),
    ModelCatalogEntry(
        "anthropic",
        "claude-haiku-4-5-20251001",
        "Haiku 4.5",
        "light",
        ("none", "low", "medium", "high"),
        200000,
    ),
    ModelCatalogEntry(
        "gemini",
        "gemini-3.1-pro-preview",
        "Gemini 3.1 Pro",
        "sota",
        ("low", "high"),
        1048576,
    ),
    ModelCatalogEntry(
        "gemini",
        "gemini-3-flash-preview",
        "Gemini 3 Flash",
        "light",
        ("minimal", "low", "medium", "high"),
        1048576,
    ),
    ModelCatalogEntry(
        "deepseek",
        "deepseek-v4-pro",
        "DeepSeek V4 Pro",
        "sota",
        ("high",),
        128000,
    ),
    ModelCatalogEntry(
        "deepseek",
        "deepseek-v4-flash",
        "DeepSeek V4 Flash",
        "light",
        ("none", "high"),
        128000,
    ),
)

_MODEL_CATALOG_BY_KEY = {(entry.provider, entry.model_name): entry for entry in MODEL_CATALOG}
_PROVIDER_ENABLE_ATTRS: dict[LLMProvider, str] = {
    "openai": "enable_openai",
    "anthropic": "enable_anthropic",
    "gemini": "enable_gemini",
    "deepseek": "enable_deepseek",
}
_PROVIDER_KEY_ATTRS: dict[LLMProvider, str] = {
    "openai": "openai_api_key",
    "anthropic": "anthropic_api_key",
    "gemini": "gemini_api_key",
    "deepseek": "deepseek_api_key",
}


def provider_display_name(provider: str) -> str | None:
    if provider not in VALID_PROVIDERS:
        return None
    return PROVIDER_DISPLAY_NAMES[cast(LLMProvider, provider)]


def key_test_model(provider: str) -> str | None:
    if provider not in VALID_PROVIDERS:
        return None
    return KEY_TEST_MODELS[cast(LLMProvider, provider)]


def model_catalog_entry(provider: str, model_name: str) -> ModelCatalogEntry | None:
    if provider not in VALID_PROVIDERS:
        return None
    return _MODEL_CATALOG_BY_KEY.get((cast(LLMProvider, provider), model_name))


def provider_sort_rank(provider: str) -> int:
    if provider not in VALID_PROVIDERS:
        return 999
    return PROVIDER_ORDER.index(cast(LLMProvider, provider))


def enabled_provider_names(settings: LLMProviderConfig) -> tuple[LLMProvider, ...]:
    return tuple(provider for provider in PROVIDER_ORDER if is_provider_enabled(provider, settings))


def is_provider_enabled(provider: str, settings: LLMProviderConfig) -> bool:
    if provider not in VALID_PROVIDERS:
        return False
    return bool(getattr(settings, _PROVIDER_ENABLE_ATTRS[cast(LLMProvider, provider)]))


def configured_platform_key(provider: str, settings: LLMProviderConfig) -> str | None:
    if provider not in VALID_PROVIDERS:
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
