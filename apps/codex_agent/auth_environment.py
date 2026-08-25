"""Shared API-key exclusion for ChatGPT-subscription Codex processes."""

from __future__ import annotations

import os


def reject_subscription_api_key_auth() -> None:
    """Reject API-key modes in every subscription-backed Codex process."""

    for name in ("OPENAI_API_KEY", "CODEX_API_KEY"):
        if name in os.environ:
            raise RuntimeError(f"{name} must not be inherited by a Codex subscription process")


def reject_ambient_codex_home() -> None:
    """Keep long-lived runtime state out of an ambient persistent profile."""

    if "CODEX_HOME" in os.environ:
        raise RuntimeError("CODEX_HOME must not be inherited by the Codex generation host")
