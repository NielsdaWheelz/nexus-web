"""Identity of the installed stock-server callback topology."""

from __future__ import annotations

from provider_runtime.agent_runtime import AGENT_BACKEND_CONTRACT_REVISION

from nexus.services.native_catalog_contract import EXECUTION_POLICY_REVISION

PINNED_CODEX_VERSION = "0.160.0"


def expected_health_identity() -> dict[str, str]:
    return {
        "schema_version": "nexus-native-health.v1",
        "status": "ready",
        "backend": "codex",
        "transport": "sdk",
        "auth_profile": "codex-personal",
        "native_version": PINNED_CODEX_VERSION,
        "library_contract_revision": AGENT_BACKEND_CONTRACT_REVISION,
        "execution_policy_revision": EXECUTION_POLICY_REVISION,
    }
