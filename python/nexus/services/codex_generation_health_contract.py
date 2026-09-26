"""Dependency-light identity shared by the Codex host and its health probe."""

from __future__ import annotations

from typing import Final

PINNED_CODEX_VERSION: Final = "0.157.1"
LIBRARY_CONTRACT_REVISION: Final = "provider-runtime.agent-model-catalog.v2"
_HEALTH_IDENTITY_ITEMS: Final = (
    ("schema_version", "nexus-generation-health.v3"),
    ("status", "ready"),
    ("backend", "codex"),
    ("transport", "app_server"),
    ("auth_profile", "codex-personal"),
    ("command_schema_version", "nexus-generation-command.v3"),
    ("native_version", PINNED_CODEX_VERSION),
    ("library_contract_revision", LIBRARY_CONTRACT_REVISION),
)


def expected_health_identity() -> dict[str, str]:
    """Return a fresh exact response map so callers cannot mutate the contract."""

    return dict(_HEALTH_IDENTITY_ITEMS)


__all__ = [
    "PINNED_CODEX_VERSION",
    "LIBRARY_CONTRACT_REVISION",
    "expected_health_identity",
]
