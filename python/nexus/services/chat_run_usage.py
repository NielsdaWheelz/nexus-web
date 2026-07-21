"""TokenUsage data-transforms for chat-run persistence and log events.

Operates on the runtime's normalized ``provider_runtime.TokenUsage`` (wrapped
in ``Presence`` — a terminal's ``meta.usage`` is ``Absent`` unless the
provider reported usage). There is no separate "provider_usage" JSON blob on
this type any more: usage is normalized once at codec ingress.
"""

from __future__ import annotations

from provider_runtime import Presence, Present, TokenUsage


def _presence_or_none(presence: Presence[int]) -> int | None:
    return presence.value if isinstance(presence, Present) else None


def usage_tokens(usage: Presence[TokenUsage]) -> dict[str, int | None]:
    """Token breakdown keyed by llm_calls token-column names."""
    if not isinstance(usage, Present):
        return {
            "input_tokens": None,
            "output_tokens": None,
            "total_tokens": None,
            "reasoning_tokens": None,
            "cache_write_input_tokens": None,
            "cache_read_input_tokens": None,
        }
    value = usage.value
    return {
        "input_tokens": value.input_tokens,
        "output_tokens": value.output_tokens,
        "total_tokens": value.total_tokens,
        "reasoning_tokens": _presence_or_none(value.reasoning_tokens),
        "cache_write_input_tokens": _presence_or_none(value.cache_write_input_tokens),
        "cache_read_input_tokens": _presence_or_none(value.cache_read_input_tokens),
    }


def usage_provider_json(usage: Presence[TokenUsage]) -> dict[str, object] | None:
    """The chat-run ``done``/trust-trail usage payload, or ``None`` when absent."""
    if not isinstance(usage, Present):
        return None
    return dict(usage_tokens(usage))
