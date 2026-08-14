"""Closed ownership and provenance facts for the metadata native operation."""

from __future__ import annotations

import ast
import hashlib
import json
from pathlib import Path
from uuid import UUID

from provider_runtime.agent_runtime import CodexNativeOptions

from nexus.services import native_agent_contract
from nexus.services.native_agent_operations import (
    METADATA_ENRICHMENT_OPERATION_REVISION,
    build_metadata_enrichment_command,
    metadata_enrichment_operation_facts,
    resolve_native_agent_operation,
)

_REPO_ROOT = Path(__file__).resolve().parents[3]


def _canonical_fingerprint(value: object) -> str:
    return hashlib.sha256(
        json.dumps(value, ensure_ascii=True, separators=(",", ":"), sort_keys=True).encode("utf-8")
    ).hexdigest()


def test_metadata_operation_revision_is_owned_by_the_closed_wire_contract() -> None:
    """Risk: two revision literals silently admit incompatible native commands."""

    contract_revision = getattr(
        native_agent_contract, "METADATA_ENRICHMENT_OPERATION_REVISION", None
    )
    assert contract_revision == METADATA_ENRICHMENT_OPERATION_REVISION

    operations_source = (_REPO_ROOT / "python/nexus/services/native_agent_operations.py").read_text(
        encoding="utf-8"
    )
    operations_tree = ast.parse(operations_source)
    contract_imports = [
        node
        for node in ast.walk(operations_tree)
        if isinstance(node, ast.ImportFrom)
        and node.module == "nexus.services.native_agent_contract"
        and any(alias.name == "METADATA_ENRICHMENT_OPERATION_REVISION" for alias in node.names)
    ]
    assert contract_imports
    assert not any(
        isinstance(node, ast.Assign)
        and any(
            isinstance(target, ast.Name) and target.id == "METADATA_ENRICHMENT_OPERATION_REVISION"
            for target in node.targets
        )
        for node in ast.walk(operations_tree)
    ), "metadata operation revision has a duplicate owner"


def test_policy_fingerprint_is_the_resolved_session_policy_facts() -> None:
    """Risk: ledger provenance hashes a hand-maintained policy shadow, not the turn."""

    command = build_metadata_enrichment_command(
        request_id=UUID("755a2de9-2bdc-5c57-a6a0-17a2407f14bb"),
        input="bounded metadata input",
    )
    resolved = resolve_native_agent_operation(
        command,
        working_directory=Path("/var/empty/nexus-codex"),
    )
    policy = resolved.session.policy
    native = resolved.session.native
    assert isinstance(native, CodexNativeOptions)
    expected = _canonical_fingerprint(
        {
            "filesystem": policy.filesystem,
            "network": policy.network,
            "network_allowlist": list(policy.network_allowlist),
            "approval": policy.approval,
            "allowed_tools": list(policy.allowed_tools),
            "denied_tools": list(policy.denied_tools),
            "environment": list(policy.environment),
            "unsafe_confirmation": policy.unsafe_confirmation,
            "additional_dirs": list(resolved.session.additional_dirs),
            "mcp_servers": list(resolved.session.mcp_servers),
            "native": {
                "builtin_tools": native.builtin_tools,
                "web_search": native.web_search,
            },
            "transport_deadline_seconds": resolved.facts.transport_deadline_seconds,
        }
    )
    assert metadata_enrichment_operation_facts().policy_fingerprint == expected

    operations_source = (_REPO_ROOT / "python/nexus/services/native_agent_operations.py").read_text(
        encoding="utf-8"
    )
    operations_tree = ast.parse(operations_source)
    assert not any(
        isinstance(node, ast.FunctionDef) and node.name == "_policy_payload"
        for node in ast.walk(operations_tree)
    )
