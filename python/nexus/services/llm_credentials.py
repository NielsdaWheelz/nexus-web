"""Construct the direct-provider credentials owned by the Nexus deployment."""

from __future__ import annotations

from provider_runtime import Credentials, ProviderCredential
from provider_runtime.errors import CredentialMissing

from nexus.config import Settings


def provider_credentials(settings: Settings) -> Credentials:
    return Credentials(
        openai=settings.openai_api_key,
        anthropic=settings.anthropic_api_key,
        gemini=settings.gemini_api_key,
        moonshot=settings.moonshot_api_key,
        deepseek=settings.deepseek_api_key,
        openrouter=None,
        xai=None,
    )


def embedding_credential(settings: Settings) -> ProviderCredential:
    if settings.openai_api_key is None:
        raise CredentialMissing(message="no openai credential configured")
    return ProviderCredential(provider="openai", key=settings.openai_api_key)
