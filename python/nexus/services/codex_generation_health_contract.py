"""Dependency-light identity shared by the Codex host and its health probe."""

from __future__ import annotations

from typing import Final

PINNED_CODEX_VERSION: Final = "0.157.1"
LIBRARY_CONTRACT_REVISION: Final = "provider-runtime.agent-model-catalog.v5"
EXECUTION_POLICY_REVISION: Final = "codex-shell-bwrap-public-egress.v1"
_HEALTH_IDENTITY_ITEMS: Final = (
    ("schema_version", "nexus-generation-health.v4"),
    ("status", "ready"),
    ("backend", "codex"),
    ("transport", "app_server"),
    ("auth_profile", "codex-personal"),
    ("command_schema_version", "nexus-generation-command.v5"),
    ("native_version", PINNED_CODEX_VERSION),
    ("library_contract_revision", LIBRARY_CONTRACT_REVISION),
    ("execution_policy_revision", EXECUTION_POLICY_REVISION),
)


def expected_health_identity() -> dict[str, str]:
    """Return a fresh exact response map so callers cannot mutate the contract."""

    return dict(_HEALTH_IDENTITY_ITEMS)


__all__ = [
    "PINNED_CODEX_VERSION",
    "LIBRARY_CONTRACT_REVISION",
    "EXECUTION_POLICY_REVISION",
    "expected_health_identity",
]
