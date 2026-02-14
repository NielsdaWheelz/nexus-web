"""Redaction, hashing, and log guard utilities.

Per PR-09 spec §6:
- hash_text: stable SHA-256 hex digest for log correlation
- redact_text: partial or full masking for display
- safe_kv: log guard that blocks forbidden keys at call site

Never-log policy:
- API keys (plaintext or decrypted)
- Bearer tokens
- Rendered prompts
- Message content
- Transcript text
- Raw search queries
- Context block text

Allowed (with suffix):
- _chars, _length: length of text
- _sha256, _hash: hash of text
- Token counts, cost, provider request ID
"""

import hashlib
import os

FORBIDDEN_KEYS = frozenset(
    {
        "prompt",
        "content",
        "query",
        "api_key",
        "bearer",
        "token",
        "secret",
        "password",
        "message_text",
        "transcript",
        "context_text",
        "raw_body",
    }
)

REDACTED_SUFFIXES = ("_sha256", "_hash", "_length", "_chars")


def hash_text(value: str) -> str:
    """SHA-256 hex digest of a string.

    Stable: same input always produces same output.
    Used for log correlation without exposing content.

    Args:
        value: Text to hash.

    Returns:
        Hex-encoded SHA-256 digest.
    """
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def redact_text(value: str, keep: int = 0) -> str:
    """Return masked version of text.

    Args:
        value: Text to redact.
        keep: Number of leading characters to preserve (0 = full redact).

    Returns:
        Redacted string: prefix + '***' or just '***'.
    """
    if not value:
        return "***"
    if keep <= 0 or keep >= len(value):
        return "***"
    return value[:keep] + "***"


def _has_redacted_suffix(key: str) -> bool:
    """Check if key ends with a recognized redacted suffix."""
    return any(key.endswith(suffix) for suffix in REDACTED_SUFFIXES)


def safe_kv(*, _env: str | None = None, **kwargs) -> dict:
    """Validate that no forbidden keys are present unless already redacted.

    Raises ValueError in dev/test environments if a forbidden key is used
    without a redacted suffix. In production, logs a warning instead.

    Usage:
        logger.info("llm.request.started", **safe_kv(
            provider="openai",
            model_name="gpt-4",
            message_chars=1234,       # OK: _chars suffix
            prompt_sha256="abc123",   # OK: _sha256 suffix
            # prompt="hello world",   # BLOCKED: forbidden key
        ))

    Args:
        _env: Override for NEXUS_ENV (test-only). If None, reads from env.
        **kwargs: Keyword arguments to validate and return.

    Returns:
        The same kwargs dict, after validation.

    Raises:
        ValueError: In dev/test, if a forbidden key is used without redacted suffix.
    """
    violations = []
    for key in kwargs:
        if key in FORBIDDEN_KEYS and not _has_redacted_suffix(key):
            violations.append(key)

    if violations:
        msg = f"Forbidden log keys without redacted suffix: {violations}"
        env = _env or os.environ.get("NEXUS_ENV", "local")
        if env in ("local", "test"):
            raise ValueError(msg)
        else:
            # In prod/staging: warn but don't crash
            import structlog

            _logger = structlog.get_logger("nexus.services.redact")
            _logger.warning("safe_kv_violation", forbidden_keys=violations)

    return kwargs
