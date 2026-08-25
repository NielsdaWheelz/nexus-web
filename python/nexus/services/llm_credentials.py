"""Construct the one non-generation credential retained by Nexus."""

from __future__ import annotations

from provider_runtime import ProviderCredential
from provider_runtime.errors import CredentialMissing

from nexus.config import Settings


def embedding_credential(settings: Settings) -> ProviderCredential:
    if settings.openai_api_key is None:
        raise CredentialMissing(message="no openai credential configured")
    return ProviderCredential(provider="openai", key=settings.openai_api_key)
