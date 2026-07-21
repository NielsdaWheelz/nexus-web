"""Sole platform-key reader for LLM provider calls.

Reads platform API keys straight off ``Settings`` and returns runtime
``ProviderCredential`` values for the three call shapes (generation,
embedding, transcription). Replaces ``api_key_resolver.py`` / ``user_keys.py``
/ ``crypto.py`` — no BYOK, no DB lookup, no encryption; platform keys are the
only key source (see docs/cutovers/llm-provider-runtime-hard-cutover.md).

Whether a platform key is *required* is config.py's call
(``validate_required_settings`` requires the four platform keys in
staging/prod). This module is the read side: a provider missing its key at
call time is a broken runtime invariant, not a product-facing failure, so it
raises ``RuntimeDefect`` rather than returning an empty credential.
"""

from __future__ import annotations

from provider_runtime import ProviderCredential, ProviderName, RuntimeDefect

from nexus.config import Settings

_PLATFORM_KEY_ATTRS: dict[ProviderName, str] = {
    "openai": "openai_api_key",
    "anthropic": "anthropic_api_key",
    "gemini": "gemini_api_key",
    "moonshot": "moonshot_api_key",
    "openrouter": "openrouter_api_key",
}


def _platform_credential(settings: Settings, provider: ProviderName) -> ProviderCredential:
    key = getattr(settings, _PLATFORM_KEY_ATTRS[provider])
    if not key:
        # justify-defect: platform key presence for staging/prod is enforced at
        # startup by config.validate_required_settings; a missing key here is a
        # broken deployment invariant, never a product-facing failure.
        raise RuntimeDefect(
            origin="provider_http",
            code="credential_missing",
            message=f"No platform API key configured for provider={provider}",
        )
    return ProviderCredential(provider=provider, key=key)


def generation_credential(settings: Settings, provider: ProviderName) -> ProviderCredential:
    """Platform credential for a generation (chat/completion) call."""
    return _platform_credential(settings, provider)


def embedding_credential(settings: Settings, provider: ProviderName) -> ProviderCredential:
    """Platform credential for an embedding call."""
    return _platform_credential(settings, provider)


def transcription_credential(settings: Settings, provider: ProviderName) -> ProviderCredential:
    """Platform credential for a transcription call."""
    return _platform_credential(settings, provider)
