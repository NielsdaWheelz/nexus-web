"""Independent oracle for the exact developer-owned generation policy."""

from __future__ import annotations

import hashlib
import json
from dataclasses import replace

import pytest

from nexus.services import generation_policy
from nexus.services.generation_selection import CodexPersonalSelection
from nexus.services.tool_runtime.profiles import TOOL_PLAN_DEFINITIONS_BY_ID

_EXPECTED_SELECTIONS = {
    "metadata_enrichment": ("gpt-5.6-luna", "low"),
    "media_summary": ("gpt-5.6-luna", "low"),
    "synapse": ("gpt-5.6-luna", "low"),
    "dawn_write": ("gpt-5.6-terra", "medium"),
    "oracle": ("gpt-5.6-terra", "medium"),
    "dossier_page": ("gpt-5.6-luna", "low"),
    "dossier_note": ("gpt-5.6-luna", "low"),
    "dossier_media": ("gpt-5.6-terra", "medium"),
    "dossier_conversation": ("gpt-5.6-terra", "medium"),
    "dossier_library": ("gpt-5.6-terra", "high"),
    "dossier_podcast": ("gpt-5.6-terra", "high"),
    "dossier_contributor": ("gpt-5.6-terra", "high"),
    "dossier_idea": ("gpt-5.6-terra", "high"),
    "dossier_idea_resolve": ("gpt-5.6-luna", "low"),
}

_EXPECTED_WORKFLOW = {
    "metadata_enrichment": (300, 32 * 1024, 64_000, 8_000, "StrictJson"),
    "media_summary": (120, 256 * 1024, 128_000, 16_000, "StrictJson"),
    "synapse": (120, 256 * 1024, 128_000, 16_000, "StrictJson"),
    "dawn_write": (180, 256 * 1024, 128_000, 16_000, "Text"),
    "oracle": (180, 256 * 1024, 128_000, 16_000, "StrictJson"),
    "dossier_page": (120, 1024 * 1024, 400_000, 32_000, "StrictJson"),
    "dossier_note": (120, 1024 * 1024, 400_000, 32_000, "StrictJson"),
    "dossier_media": (180, 1024 * 1024, 400_000, 32_000, "StrictJson"),
    "dossier_conversation": (180, 1024 * 1024, 400_000, 32_000, "StrictJson"),
    "dossier_library": (300, 1024 * 1024, 400_000, 32_000, "StrictJson"),
    "dossier_podcast": (300, 1024 * 1024, 400_000, 32_000, "StrictJson"),
    "dossier_contributor": (300, 1024 * 1024, 400_000, 32_000, "StrictJson"),
    "dossier_idea": (300, 1024 * 1024, 400_000, 32_000, "StrictJson"),
    "dossier_idea_resolve": (60, 256 * 1024, 128_000, 16_000, "StrictJson"),
}


def _selection_facts(selection: CodexPersonalSelection) -> tuple[str, str]:
    assert selection.route == "CodexPersonal"
    return selection.model, selection.reasoning


def test_exact_generation_policy_is_total_content_derived_and_profile_free() -> None:
    policy = generation_policy.GENERATION_POLICY

    assert tuple(policy.background_operations) == tuple(_EXPECTED_SELECTIONS)
    assert _selection_facts(policy.chat.seed) == ("gpt-5.6-terra", "medium")
    assert policy.chat.workflow.operation == "chat"
    assert policy.chat.workflow.output_contract.kind == "Text"
    assert policy.chat.workflow.request_budget.max_context_tokens == 400_000
    assert policy.chat.workflow.request_budget.max_output_tokens == 32_000
    assert policy.chat.workflow.model_tool_policy.kind == "ChatPerRunTools"
    assert policy.chat.workflow.model_tool_policy.read_plan_id == "ChatRead"
    assert policy.chat.workflow.model_tool_policy.additive_write_plan_id == "ChatReadAdditiveWrite"

    for operation, expected_selection in _EXPECTED_SELECTIONS.items():
        entry = generation_policy.background_operation_policy(operation)
        workflow = entry.workflow
        assert _selection_facts(entry.selection) == expected_selection
        timeout, input_bytes, context_tokens, output_tokens, output_kind = _EXPECTED_WORKFLOW[
            operation
        ]
        assert workflow.operation == operation
        assert workflow.bounds.turn_timeout_seconds == timeout
        assert workflow.bounds.input_max_bytes == input_bytes
        assert workflow.request_budget.max_context_tokens == context_tokens
        assert workflow.request_budget.max_output_tokens == output_tokens
        assert workflow.output_contract.kind == output_kind

    assert policy.background_operations["dossier_library"].workflow.model_tool_policy == (
        generation_policy.ExactModelTools(
            plan_id="LibraryDossierRead",
            authority_revision=TOOL_PLAN_DEFINITIONS_BY_ID["LibraryDossierRead"].authority_revision,
            effect_mode="ReadOnly",
            scope_derivation="LibraryDossierManifest",
        )
    )
    assert policy.background_operations["dossier_idea"].workflow.model_tool_policy == (
        generation_policy.ExactModelTools(
            plan_id="IdeaDossierRead",
            authority_revision=TOOL_PLAN_DEFINITIONS_BY_ID["IdeaDossierRead"].authority_revision,
            effect_mode="ReadOnly",
            scope_derivation="IdeaDossierEvidenceLedger",
        )
    )
    assert policy.background_operations["dossier_idea"].workflow.host_tool_plan.kind == (
        "ExactHostToolPlan"
    )
    for operation, entry in policy.background_operations.items():
        if operation not in {"dossier_library", "dossier_idea", "metadata_enrichment"}:
            assert entry.workflow.model_tool_policy.kind == "NoModelTools"
        if operation != "dossier_idea":
            assert entry.workflow.host_tool_plan.kind == "NoHostToolPlan"

    assert policy.revision == generation_policy.policy_revision_from_facts(
        generation_policy.policy_facts()
    )
    assert generation_policy.validate_policy() is None

    removed = {
        "PlanId",
        "Plan",
        "PLANS",
        "MODEL_BOUNDS",
        "ChatProfile",
        "CHAT_PROFILES",
        "_CHAT_PLAN",
        "_CHAT_POLICIES",
        "chat_policy",
    }
    assert removed.isdisjoint(vars(generation_policy))
    encoded = json.dumps(generation_policy.policy_facts(), sort_keys=True)
    for legacy in ("routine", "standard", "thorough", "balanced", '"fast"'):
        assert legacy not in encoded


def test_policy_revision_changes_for_any_exact_selection_or_workflow_fact() -> None:
    facts = generation_policy.policy_facts()
    changed = json.loads(json.dumps(facts))
    changed["background_operations"]["oracle"]["selection"]["model"] = "gpt-5.6-luna"
    assert generation_policy.policy_revision_from_facts(changed) != (
        generation_policy.GENERATION_POLICY.revision
    )

    changed = json.loads(json.dumps(facts))
    changed["chat"]["workflow"]["request_budget"]["max_output_tokens"] += 1
    assert generation_policy.policy_revision_from_facts(changed) != (
        generation_policy.GENERATION_POLICY.revision
    )


def test_policy_catalog_rejects_drift_and_unknown_operations() -> None:
    oracle = generation_policy.background_operation_policy("oracle")
    wrong = replace(
        oracle,
        selection=CodexPersonalSelection(
            route="CodexPersonal", model="gpt-5.6-luna", reasoning="low"
        ),
    )
    assert wrong != generation_policy.background_operation_policy("oracle")
    with pytest.raises(ValueError, match="unknown background generation operation"):
        generation_policy.background_operation_policy("unknown")


def test_codex_ephemeral_limits_are_operation_owned_not_model_name_bounds() -> None:
    policies = (
        generation_policy.GENERATION_POLICY.chat.workflow,
        *(
            entry.workflow
            for entry in generation_policy.GENERATION_POLICY.background_operations.values()
        ),
    )
    largest_admitted_serialized_turn = (
        generation_policy.CODEX_RUNTIME_STATE_OUTPUT_LIMIT_BYTES
        + max(entry.bounds.input_max_bytes for entry in policies)
        + max(entry.bounds.instructions_max_bytes for entry in policies)
    )
    assert generation_policy.CODEX_EPHEMERAL_FILE_LIMIT_BYTES == 74 * 1024 * 1024
    assert (
        generation_policy.CODEX_EPHEMERAL_FILE_LIMIT_BYTES - largest_admitted_serialized_turn
        >= (8 * 1024 * 1024)
    )
    assert generation_policy.CODEX_EPHEMERAL_ROOT_BYTES == 180 * 1024 * 1024


def test_policy_revision_hash_is_domain_separated_and_canonical() -> None:
    facts = generation_policy.policy_facts()
    canonical = json.dumps(
        facts,
        ensure_ascii=True,
        allow_nan=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode()
    raw = hashlib.sha256(b"nexus.generation-policy.v2\0" + canonical).hexdigest()
    assert generation_policy.GENERATION_POLICY.revision == f"generation-policy.v2.{raw}"
