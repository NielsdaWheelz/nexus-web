"""Shared API-key exclusion for ChatGPT-subscription Codex processes."""

from __future__ import annotations

import os


def reject_subscription_api_key_auth() -> None:
    """Reject every API credential in a subscription-backed Codex process."""

    for name in sorted(os.environ):
        if name.endswith("_API_KEY"):
            raise RuntimeError(f"{name} must not be inherited by a Codex subscription process")


def reject_ambient_codex_home() -> None:
    """Keep long-lived runtime state out of an ambient persistent profile."""

    if "CODEX_HOME" in os.environ:
        raise RuntimeError("CODEX_HOME must not be inherited by the Codex generation host")
