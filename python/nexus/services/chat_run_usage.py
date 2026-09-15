"""Token usage data transforms for chat-run persistence and log events."""

from __future__ import annotations

from nexus.services.codex_generation_contract import GenerationUsage


def usage_tokens(usage: GenerationUsage | None) -> dict[str, int | None]:
    """Token breakdown keyed by llm_calls token-column names."""
    if usage is None:
        return {
            "input_tokens": None,
            "output_tokens": None,
            "total_tokens": None,
            "reasoning_tokens": None,
            "cache_write_input_tokens": None,
            "cache_read_input_tokens": None,
        }
    return usage.model_dump(mode="json")


def usage_json(usage: GenerationUsage | None) -> dict[str, object] | None:
    """The chat-run ``done``/trust-trail usage payload, or ``None``."""
    return None if usage is None else dict(usage_tokens(usage))
