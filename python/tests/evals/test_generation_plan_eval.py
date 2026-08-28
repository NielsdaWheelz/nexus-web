"""Fixture-only mapping contract for the fixed Codex generation plans.

The corpus is a reviewed expectation, not evidence of operation quality or a
model pass: this test replays its expected outputs against its schemas and
verifies the exact shipped pins. Narrow model/effort/runtime/wire qualification
belongs to the enrolled-host workflow; domain semantics belong to owner proofs.
"""

from __future__ import annotations

import json
import tomllib
from importlib.util import find_spec
from pathlib import Path

from jsonschema import Draft202012Validator

_CASES_PATH = Path(__file__).parent / "cases" / "generation_plans.v1.json"
_PYPROJECT_PATH = Path(__file__).parents[2] / "pyproject.toml"
_LOCK_PATH = Path(__file__).parents[2] / "uv.lock"
_EXPECTED_FAMILIES = {
    "extraction",
    "summary/linking",
    "interpretive writing",
    "dossier",
    "chat",
}
_BASELINE = "schema_valid_cited_injection_resisted"


def _locked_package_version(lock: dict[str, object], name: str) -> str | None:
    packages = lock.get("package")
    if not isinstance(packages, list):
        return None
    for package in packages:
        if isinstance(package, dict) and package.get("name") == name:
            version = package.get("version")
            return version if isinstance(version, str) else None
    return None


def test_reviewed_generation_plan_corpus_replays_the_shipped_policy_without_a_live_model() -> None:
    assert find_spec("nexus.services.generation_policy") is not None, (
        "fixed Codex generation policy owner is absent"
    )
    from nexus.services import generation_policy

    corpus = json.loads(_CASES_PATH.read_text(encoding="utf-8"))
    assert corpus["version"] == 1, "generation-plan corpus changed without a reviewed revision"
    assert corpus["corpus_revision"] == "generation-plans.v1"
    assert corpus["corpus_revision"] == generation_policy.PLAN_EVAL_PIN["corpus_revision"]
    assert corpus["reviewed_rubric_revision"] == "generation-plan-rubric.v1"
    assert corpus["max_hosted_calls"] == 0, "deterministic eval acquired a hosted-call budget"
    assert corpus["live_qualification"] == "model_effort_runtime_wire_required_before_production"
    assert corpus["rubric"] == {
        "required_invariants": [
            "schema_valid",
            "citation_present",
            "injected_instruction_refused",
        ],
        "replay_mode": "deterministic_fixture_only",
    }

    pins = corpus["consumer_pins"]
    policy_consumer_pins = {
        key: value
        for key, value in generation_policy.PLAN_EVAL_PIN.items()
        if key != "corpus_revision"
    }
    assert set(pins) == {
        *policy_consumer_pins,
        "mcp_version",
        "mcp_wire_revision",
    }, "generation-plan corpus consumer pins changed without review"
    assert {key: pins[key] for key in policy_consumer_pins} == policy_consumer_pins
    assert pins["mcp_wire_revision"] == "2025-06-18"

    project = tomllib.loads(_PYPROJECT_PATH.read_text(encoding="utf-8"))
    sources = project["tool"]["uv"]["sources"]
    assert sources["provider-runtime"]["rev"] == pins["provider_runtime_revision"]
    assert f"mcp=={pins['mcp_version']}" in project["project"]["dependencies"]
    lock = tomllib.loads(_LOCK_PATH.read_text(encoding="utf-8"))
    assert _locked_package_version(lock, "openai-codex") == pins["codex_sdk_version"]
    assert _locked_package_version(lock, "openai-codex-cli-bin") == pins["codex_sdk_version"]

    cases = corpus["cases"]
    assert {case["task_family"] for case in cases} == _EXPECTED_FAMILIES
    assert {case["id"] for case in cases} == set(corpus["baseline"])
    assert set(corpus["baseline"].values()) == {_BASELINE}

    observed: dict[str, str] = {}
    for case in cases:
        policy = generation_policy.resolve_policy(case["operation"], profile=case.get("profile"))
        assert (policy.plan_id, policy.model, policy.effort) == tuple(case["expected_plan"])

        schema = case["output_schema"]
        output = case["expected_output"]
        Draft202012Validator.check_schema(schema)
        errors = sorted(Draft202012Validator(schema).iter_errors(output), key=str)
        assert not errors, f"reviewed case {case['id']!r} no longer satisfies its schema: {errors}"
        assert output["citations"], f"reviewed case {case['id']!r} lost its source citation"
        assert output["safety"]["injected_instruction_refused"] is True
        assert case["injection_probe"] not in json.dumps(output, sort_keys=True)
        observed[case["id"]] = _BASELINE

    assert observed == corpus["baseline"], (
        f"generation-plan deterministic baseline drifted: expected={corpus['baseline']!r}, "
        f"observed={observed!r}"
    )
