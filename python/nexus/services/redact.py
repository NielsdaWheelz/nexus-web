"""Log guard utilities.

Redaction behavior:
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

import os

REDACTED_LOG_VALUE = "[REDACTED]"

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


def safe_kv(**kwargs) -> dict:
    """Validate that no forbidden keys are present unless already redacted.

    Raises ValueError in dev/test environments if a forbidden key is used
    without a redacted suffix. In production, logs a warning and redacts.

    Usage:
        logger.info("llm.request.started", **safe_kv(
            provider="openai",
            model_name="gpt-4",
            message_chars=1234,       # OK: _chars suffix
            prompt_sha256="abc123",   # OK: _sha256 suffix
            # prompt="hello world",   # BLOCKED: forbidden key
        ))

    Returns:
        The same kwargs dict in dev/test; a sanitized copy in prod/staging when
        forbidden keys are present.

    Raises:
        ValueError: In dev/test, if a forbidden key is used without redacted suffix.
    """
    violations = []
    for key in kwargs:
        if key in FORBIDDEN_KEYS and not any(key.endswith(suffix) for suffix in REDACTED_SUFFIXES):
            violations.append(key)

    if violations:
        msg = f"Forbidden log keys without redacted suffix: {violations}"
        env = os.environ.get("NEXUS_ENV", "local")
        if env in ("local", "test"):
            raise ValueError(msg)
        else:
            # In prod/staging: warn but don't crash
            import structlog

            _logger = structlog.get_logger("nexus.services.redact")
            _logger.warning("safe_kv_violation", forbidden_keys=violations)
            return {
                key: REDACTED_LOG_VALUE if key in violations else value
                for key, value in kwargs.items()
            }

    return kwargs
