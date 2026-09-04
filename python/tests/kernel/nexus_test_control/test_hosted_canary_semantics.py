import asyncio
import importlib.metadata
import json
from datetime import UTC, datetime
from importlib.util import find_spec
from pathlib import Path

_SOURCE_SHA = "a" * 40
# BASE sensitivity overlays this proof without candidate dependencies or owners.
_CUTOVER_PRESENT = find_spec("nexus.services.generation_catalog") is not None


def _evidence() -> dict[str, object]:
    from tests.testkit.codex_hosted_evidence import codex_hosted_evidence_fixture

    return codex_hosted_evidence_fixture(
        run_id="0123456789abcdef",
        source_sha=_SOURCE_SHA,
    )


def test_hosted_canary_accepts_bounded_target_set_v4_receipt(tmp_path: Path) -> None:
    assert _CUTOVER_PRESENT, "the final generation-catalog owner is absent"
    from nexus.ops.codex_hosted_evidence import codex_hosted_evidence_is_valid

    path = tmp_path / "hosted.json"
    evidence = _evidence()
    path.write_text(json.dumps(evidence), encoding="utf-8")
    assert codex_hosted_evidence_is_valid(path, run_id="0123456789abcdef", source_sha=_SOURCE_SHA)
    results = evidence["results"]
    assert isinstance(results, list)
    results[3]["permission_requests"] = 1
    path = tmp_path / "hosted.json"
    path.write_text(json.dumps(evidence), encoding="utf-8")
    assert not codex_hosted_evidence_is_valid(
        path,
        run_id="0123456789abcdef",
        source_sha=_SOURCE_SHA,
    ), "permission-request evidence turned an unsafe semantic result green"

    for field, value in (
        ("source_sha", "b" * 40),
        ("policy_revision", "other-policy"),
        ("policy_fingerprint", "0" * 64),
        ("catalog_definition_revision", "not-a-sha256"),
        ("backend_contract_revision", "other-contract"),
        ("codex_sdk_version", "0.0.0"),
        ("codex_cli_version", "0.0.0"),
        ("qualification_scope", "all_operation_semantics"),
        ("tool_authority_revisions", {}),
    ):
        evidence = _evidence()
        evidence[field] = value
        path.write_text(json.dumps(evidence), encoding="utf-8")
        assert not codex_hosted_evidence_is_valid(
            path, run_id="0123456789abcdef", source_sha=_SOURCE_SHA
        ), f"hosted receipt accepted a drifted {field}"

    for field in ("sdk_version", "runtime_version"):
        evidence = _evidence()
        results = evidence["results"]
        assert isinstance(results, list)
        results[0][field] = "0.0.0"
        path.write_text(json.dumps(evidence), encoding="utf-8")
        assert not codex_hosted_evidence_is_valid(
            path, run_id="0123456789abcdef", source_sha=_SOURCE_SHA
        ), f"hosted receipt accepted a per-result drifted {field}"


def test_hosted_canary_dependency_free_pins_match_all_source_owners() -> None:
    """Risk: the isolated staging gate silently validates an obsolete capability set."""

    from provider_runtime.agent_runtime import AGENT_BACKEND_CONTRACT_REVISION

    from nexus.ops.codex_hosted_evidence import codex_hosted_contract_facts
    from nexus.services import generation_policy
    from nexus.services.generation_catalog import source_controlled_qualification_snapshot
    from nexus.services.generation_selection import CodexPersonalSelection
    from nexus.services.tool_runtime.profiles import TOOL_PLAN_DEFINITIONS_BY_ID

    facts = codex_hosted_contract_facts()
    assert facts["policy_revision"] == generation_policy.POLICY_REVISION
    assert facts["policy_fingerprint"] == generation_policy.POLICY_FINGERPRINT
    assert facts["backend_contract_revision"] == AGENT_BACKEND_CONTRACT_REVISION
    assert facts["codex_sdk_version"] == importlib.metadata.version("openai-codex")
    assert facts["codex_cli_version"] == importlib.metadata.version("openai-codex-cli-bin")

    snapshot = source_controlled_qualification_snapshot()
    expected_targets = facts["targets"]
    assert isinstance(expected_targets, dict)
    source_targets = {
        receipt.target_key: receipt.source_row_fingerprint
        for receipt in snapshot.targets
        if receipt.target_key.startswith("CodexPersonal:")
    }
    assert {
        key: row["source_row_fingerprint"] for key, row in expected_targets.items()
    } == source_targets
    expected_reasoning_fingerprints: set[str] = set()
    for target_key, row in expected_targets.items():
        assert isinstance(target_key, str)
        assert isinstance(row, dict)
        model = target_key.removeprefix("CodexPersonal:")
        reasoning = row["reasoning"]
        assert isinstance(reasoning, list)
        for effort in reasoning:
            assert isinstance(effort, str)
            receipt = snapshot.reasoning_for(
                CodexPersonalSelection(
                    route="CodexPersonal",
                    model=model,
                    reasoning=effort,
                )
            )
            assert receipt is not None
            expected_reasoning_fingerprints.add(receipt.selection_fingerprint)
    codex_row_fingerprints = set(source_targets.values())
    assert expected_reasoning_fingerprints == {
        receipt.selection_fingerprint
        for receipt in snapshot.reasoning
        if receipt.source_row_fingerprint in codex_row_fingerprints
    }

    expected_tools = facts["tools"]
    assert isinstance(expected_tools, dict)
    assert expected_tools == {
        plan_id: {
            "authority_revision": TOOL_PLAN_DEFINITIONS_BY_ID[plan_id].authority_revision,
            "declared_tool_count": len(TOOL_PLAN_DEFINITIONS_BY_ID[plan_id].profile.grants),
        }
        for plan_id in ("ChatReadAdditiveWrite", "IdeaDossierRead", "LibraryDossierRead")
    }


def test_hosted_canary_freezes_one_real_spec_per_target_plus_background_boundary() -> None:
    """Risk: the live canary advertises v4 evidence it cannot admit through product code."""

    from provider_runtime.agent_runtime import (
        AGENT_BACKEND_CONTRACT_REVISION,
        AgentModelCatalog,
        AgentModelFacts,
        AgentReasoningFacts,
    )
    from provider_runtime.types import Absent as RuntimeAbsent
    from provider_runtime.types import Present as RuntimePresent

    from nexus.ops.codex_hosted_evidence import codex_hosted_contract_facts
    from tests.hosted.nightly.test_codex_personal_generation import _freeze_canary

    facts = codex_hosted_contract_facts()
    targets = facts["targets"]
    assert isinstance(targets, dict)
    observed_at = datetime.now(UTC)
    catalog = AgentModelCatalog(
        backend_contract_revision=AGENT_BACKEND_CONTRACT_REVISION,
        definition_revision="a" * 64,
        native_revision=RuntimeAbsent(),
        observed_at=observed_at,
        models=tuple(
            AgentModelFacts(
                key=target_key.removeprefix("CodexPersonal:"),
                dispatch_model=target_key.removeprefix("CodexPersonal:"),
                label=target_key,
                source_context_window=RuntimeAbsent(),
                source_max_output_tokens=RuntimeAbsent(),
                input_modalities=("text",),
                reasoning=tuple(
                    AgentReasoningFacts(key=effort, label=effort.title(), native_wire_value=effort)
                    for effort in row["reasoning"]
                ),
                source_default_reasoning=RuntimePresent(row["reasoning"][0]),
                upgrade=RuntimeAbsent(),
                retirement=RuntimeAbsent(),
                row_fingerprint=row["source_row_fingerprint"],
            )
            for target_key, row in sorted(targets.items())
        ),
        diagnostics=(),
    )

    frozen = asyncio.run(_freeze_canary(catalog))

    assert len(frozen.target_set) == 7
    assert len(frozen.cases) == 9
    assert {case.receipt_kind for case in frozen.cases} == {"chat_target", "background"}
    assert all(case.command.spec.fingerprint for case in frozen.cases)
    assert {case.operation for case in frozen.cases if case.receipt_kind == "background"} == {
        "dossier_library",
        "dossier_idea",
    }
