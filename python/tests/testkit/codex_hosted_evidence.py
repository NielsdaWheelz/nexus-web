"""Canonical bounded Codex hosted-receipt fixture."""

from __future__ import annotations

import importlib.metadata

from provider_runtime.agent_runtime import AGENT_BACKEND_CONTRACT_REVISION

from nexus.ops.codex_hosted_evidence import codex_hosted_contract_facts
from nexus.services import generation_policy
from nexus.services.generation_catalog import source_controlled_qualification_snapshot
from nexus.services.generation_selection import CodexPersonalSelection
from nexus.services.tool_runtime.profiles import TOOL_PLAN_DEFINITIONS_BY_ID


def codex_hosted_evidence_fixture(
    *,
    run_id: str,
    source_sha: str,
) -> dict[str, object]:
    """Return one exact target-set receipt accepted by the production validator."""

    targets = {
        receipt.target_key: receipt.source_row_fingerprint
        for receipt in source_controlled_qualification_snapshot().targets
        if receipt.target_key.startswith("CodexPersonal:")
    }
    contract_targets = codex_hosted_contract_facts()["targets"]
    if not isinstance(contract_targets, dict):
        raise AssertionError("hosted contract target facts are invalid")
    reasoning_by_target = {
        target_key: list(contract_targets[target_key]["reasoning"]) for target_key in targets
    }
    tool_revisions = {
        plan_id: TOOL_PLAN_DEFINITIONS_BY_ID[plan_id].authority_revision
        for plan_id in (
            "ChatReadAdditiveWrite",
            "LibraryDossierRead",
            "IdeaDossierRead",
        )
    }
    sdk_version = importlib.metadata.version("openai-codex")
    runtime_version = importlib.metadata.version("openai-codex-cli-bin")
    results: list[dict[str, object]] = [
        _result(
            receipt_kind="chat_target",
            target_key=target_key,
            source_row_fingerprint=targets[target_key],
            operation="chat",
            reasoning="low",
            capability_classes=["text", "tools-continuation"],
            plan_id="ChatReadAdditiveWrite",
            structured_output_valid=False,
            sdk_version=sdk_version,
            runtime_version=runtime_version,
        )
        for target_key in sorted(targets)
    ]
    for operation, plan_id in (
        ("dossier_library", "LibraryDossierRead"),
        ("dossier_idea", "IdeaDossierRead"),
    ):
        selection = generation_policy.background_operation_policy(operation).selection
        if not isinstance(selection, CodexPersonalSelection):
            raise AssertionError("Codex hosted background fixture selected an API route")
        target_key = f"CodexPersonal:{selection.model}"
        results.append(
            _result(
                receipt_kind="background",
                target_key=target_key,
                source_row_fingerprint=targets[target_key],
                operation=operation,
                reasoning=selection.reasoning,
                capability_classes=["strict-structured", "tools-continuation"],
                plan_id=plan_id,
                structured_output_valid=True,
                sdk_version=sdk_version,
                runtime_version=runtime_version,
            )
        )
    return {
        "schema_version": "nexus-hosted-codex-canary.v4",
        "run_id": run_id,
        "source_sha": source_sha,
        "policy_revision": generation_policy.POLICY_REVISION,
        "policy_fingerprint": generation_policy.POLICY_FINGERPRINT,
        "catalog_definition_revision": "c" * 64,
        "backend_contract_revision": AGENT_BACKEND_CONTRACT_REVISION,
        "codex_sdk_version": sdk_version,
        "codex_cli_version": runtime_version,
        "qualification_scope": "codex_target_capability_set",
        "target_set": [
            {
                "target_key": target_key,
                "source_row_fingerprint": targets[target_key],
                "reasoning": reasoning_by_target[target_key],
            }
            for target_key in sorted(targets)
        ],
        "tool_authority_revisions": tool_revisions,
        "subscription_turns": len(results),
        "results": results,
    }


def _result(
    *,
    receipt_kind: str,
    target_key: str,
    source_row_fingerprint: str,
    operation: str,
    reasoning: str,
    capability_classes: list[str],
    plan_id: str,
    structured_output_valid: bool,
    sdk_version: str,
    runtime_version: str,
) -> dict[str, object]:
    definition = TOOL_PLAN_DEFINITIONS_BY_ID[plan_id]
    return {
        "receipt_kind": receipt_kind,
        "target_key": target_key,
        "source_row_fingerprint": source_row_fingerprint,
        "operation": operation,
        "reasoning": reasoning,
        "capability_classes": capability_classes,
        "tool_plan_id": plan_id,
        "tool_authority_revision": definition.authority_revision,
        "terminal_status": "succeeded",
        "structured_output_valid": structured_output_valid,
        "usage_present": True,
        "sdk_version": sdk_version,
        "runtime_version": runtime_version,
        "declared_tool_count": len(definition.profile.grants),
        "tool_events": 1,
        "elapsed_ms": 1,
        "permission_requests": 0,
    }


__all__ = ["codex_hosted_evidence_fixture"]
