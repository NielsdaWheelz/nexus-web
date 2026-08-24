"""Shared API-key exclusion for ChatGPT-subscription Codex processes."""

from __future__ import annotations

import os


def reject_api_key_auth() -> None:
    if "OPENAI_API_KEY" in os.environ:
        raise RuntimeError("OPENAI_API_KEY must not be inherited by a Codex subscription process")
