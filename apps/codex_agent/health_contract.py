"""Dependency-light identity shared by the Codex host and its health probe."""

from __future__ import annotations

from typing import Final

PINNED_CODEX_VERSION: Final = "0.144.4"
_HEALTH_IDENTITY_ITEMS: Final = (
    ("schema_version", "nexus-generation-health.v2"),
    ("status", "ready"),
    ("backend", "codex"),
    ("transport", "sdk"),
    ("auth_profile", "codex-personal"),
    ("command_schema_version", "nexus-generation-command.v3"),
    ("sdk_version", PINNED_CODEX_VERSION),
    ("runtime_version", PINNED_CODEX_VERSION),
)


def expected_health_identity() -> dict[str, str]:
    """Return a fresh exact response map so callers cannot mutate the contract."""

    return dict(_HEALTH_IDENTITY_ITEMS)


__all__ = ["PINNED_CODEX_VERSION", "expected_health_identity"]
