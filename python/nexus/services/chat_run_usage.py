"""LLMUsage data-transforms for chat-run persistence and log events."""

from __future__ import annotations

from llm_calling.types import LLMUsage


def usage_tokens(usage: LLMUsage | None) -> dict[str, int | None]:
    """Token breakdown keyed by MessageLLM column names.

    Cache fields default to 0 when usage is present; None when usage is None.
    Total falls back to input + output + reasoning when the provider omits it.
    """

    def _int(name: str) -> int | None:
        if usage is None:
            return None
        value = getattr(usage, name, None)
        return value if isinstance(value, int) else None

    input_t = _int("input_tokens")
    output_t = _int("output_tokens")
    reasoning_t = _int("reasoning_tokens")
    total_t = _int("total_tokens")
    if total_t is None and input_t is not None and output_t is not None:
        total_t = input_t + output_t + (reasoning_t or 0)
    cache_default = None if usage is None else 0
    return {
        "input_tokens": input_t,
        "output_tokens": output_t,
        "total_tokens": total_t,
        "reasoning_tokens": reasoning_t,
        "cache_write_input_tokens": _int("cache_write_input_tokens") or cache_default,
        "cache_read_input_tokens": _int("cache_read_input_tokens") or cache_default,
        "cached_input_tokens": _int("cached_input_tokens") or cache_default,
    }


def usage_log_fields(usage: LLMUsage | None) -> dict[str, int | None]:
    """Token breakdown for log events (uses `tokens_*` keys for the basic counts)."""
    tokens = usage_tokens(usage)
    return {
        "tokens_input": tokens["input_tokens"],
        "tokens_output": tokens["output_tokens"],
        "tokens_total": tokens["total_tokens"],
        "tokens_reasoning": tokens["reasoning_tokens"],
        "cache_write_input_tokens": tokens["cache_write_input_tokens"],
        "cache_read_input_tokens": tokens["cache_read_input_tokens"],
        "cached_input_tokens": tokens["cached_input_tokens"],
    }


def usage_provider_json(usage: LLMUsage | None) -> dict[str, object] | None:
    if usage is None:
        return None
    provider_usage = getattr(usage, "provider_usage", None)
    if isinstance(provider_usage, dict):
        return provider_usage
    return dict(usage_tokens(usage))
