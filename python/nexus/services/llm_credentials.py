"""Construct isolated embedding, generation, and continuation credentials."""

from __future__ import annotations

import base64
import binascii
from collections.abc import Mapping
from types import MappingProxyType
from typing import TYPE_CHECKING

from provider_runtime.errors import CredentialMissing
from pydantic import SecretStr

from nexus.config import GenerationApiProvider, Settings
from nexus.services.generation_continuations import GenerationContinuationCipher

if TYPE_CHECKING:
    from provider_runtime import ProviderCredential


def provider_generation_credentials(
    settings: Settings,
) -> Mapping[GenerationApiProvider, SecretStr]:
    """Validate configured generation keys without importing provider engines."""

    candidates: dict[GenerationApiProvider, SecretStr | None] = {
        "openai": settings.openai_generation_api_key,
        "anthropic": settings.anthropic_generation_api_key,
        "gemini": settings.gemini_generation_api_key,
        "moonshot": settings.moonshot_generation_api_key,
        "openrouter": settings.openrouter_generation_api_key,
        "deepseek": settings.deepseek_generation_api_key,
        "xai": settings.xai_generation_api_key,
    }
    credentials: dict[GenerationApiProvider, SecretStr] = {}
    for provider in settings.generation_api_provider_list:
        value = candidates[provider]
        if value is None or not value.get_secret_value().strip():
            raise CredentialMissing(message=f"no {provider} generation credential configured")
        credentials[provider] = value
    return MappingProxyType(credentials)


def generation_continuation_cipher(settings: Settings) -> GenerationContinuationCipher:
    """Decode the one deployment-owned AES-256 continuation key."""

    encoded = settings.effective_generation_continuation_encryption_key.get_secret_value()
    try:
        key = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError) as error:
        raise ValueError(
            "generation continuation encryption key is not canonical base64"
        ) from error
    if len(key) != 32 or base64.b64encode(key).decode("ascii") != encoded:
        raise ValueError("generation continuation encryption key must encode exactly 32 bytes")
    return GenerationContinuationCipher(key)


def embedding_credential(settings: Settings) -> ProviderCredential:
    from provider_runtime import ProviderCredential

    if settings.openai_api_key is None:
        raise CredentialMissing(message="no openai credential configured")
    return ProviderCredential(provider="openai", key=settings.openai_api_key)
