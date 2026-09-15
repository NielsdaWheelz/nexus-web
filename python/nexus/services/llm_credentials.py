"""Construct isolated embedding, generation, and continuation credentials."""

from __future__ import annotations

import base64
import binascii

from provider_runtime import Credentials, ProviderCredential
from provider_runtime.errors import CredentialMissing
from pydantic import SecretStr

from nexus.config import GenerationApiProvider, Settings
from nexus.services.generation_continuations import GenerationContinuationCipher


def provider_generation_credentials(settings: Settings) -> Credentials:
    """Project only configured generation secrets into ProviderRuntime."""

    configured = set(settings.generation_api_provider_list)

    def credential(provider: GenerationApiProvider, value: SecretStr | None) -> str | None:
        if provider not in configured:
            return None
        if value is None:
            raise CredentialMissing(message=f"no {provider} generation credential configured")
        secret = value.get_secret_value()
        if not secret.strip():
            raise CredentialMissing(message=f"no {provider} generation credential configured")
        return secret

    return Credentials(
        openai=credential("openai", settings.openai_generation_api_key),
        anthropic=credential("anthropic", settings.anthropic_generation_api_key),
        gemini=credential("gemini", settings.gemini_generation_api_key),
        moonshot=credential("moonshot", settings.moonshot_generation_api_key),
        openrouter=credential("openrouter", settings.openrouter_generation_api_key),
        deepseek=credential("deepseek", settings.deepseek_generation_api_key),
        xai=credential("xai", settings.xai_generation_api_key),
    )


def generation_continuation_cipher(settings: Settings) -> GenerationContinuationCipher:
    """Decode the one deployment-owned AES-256 continuation key."""

    value = settings.effective_generation_continuation_encryption_key
    encoded = value.get_secret_value()
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
    if settings.openai_api_key is None:
        raise CredentialMissing(message="no openai credential configured")
    return ProviderCredential(provider="openai", key=settings.openai_api_key)


__all__ = [
    "embedding_credential",
    "generation_continuation_cipher",
    "provider_generation_credentials",
]
