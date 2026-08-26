"""Executable artifact-boundary contract for the protected Codex nightly workflow."""

from __future__ import annotations

import ast
import json
import os
import subprocess
import sys
from pathlib import Path
from typing import cast

import pytest
import yaml

from nexus.services import generation_policy

_RUN_ID = "1234567890"
_EVIDENCE_NAME = "hosted-codex-personal-generation.json"
_READINESS_NAME = "hosted-codex-personal-readiness.json"
_ARTIFACT_NAME = f"nexus-codex-nightly-{_RUN_ID}.json"
_VALID_EVIDENCE_RUN_ID = "0123456789abcdef"
_SECOND_EVIDENCE_RUN_ID = "fedcba9876543210"
_SOURCE_SHA = "a" * 40


def _valid_evidence(run_id: str) -> bytes:
    return (
        json.dumps(
            {
                "schema_version": "nexus-hosted-codex-canary.v3",
                "run_id": run_id,
                "source_sha": _SOURCE_SHA,
                "policy_revision": generation_policy.POLICY_REVISION,
                "policy_fingerprint": generation_policy.POLICY_FINGERPRINT,
                "policy_facts_fingerprint": generation_policy.POLICY_FACTS_FINGERPRINT,
                "provider_runtime_revision": generation_policy.PLAN_EVAL_PIN[
                    "provider_runtime_revision"
                ],
                "codex_sdk_version": generation_policy.PLAN_EVAL_PIN["codex_sdk_version"],
                "codex_cli_version": generation_policy.PLAN_EVAL_PIN["codex_sdk_version"],
                "qualification_scope": "model_effort_runtime_wire",
                "qualified_plan_ids": ["routine", "standard", "thorough", "deep"],
                "subscription_turns": 4,
                "results": [
                    *[
                        {
                            "backend": "codex",
                            "transport": "sdk",
                            "auth_profile": "codex-personal",
                            "terminal_status": "succeeded",
                            "plan_id": plan_id,
                            "operation": operation,
                            "profile": profile,
                            "operation_revision": generation_policy.operation_revision(
                                operation, profile=profile
                            ),
                            "case_shape": case_shape,
                            "model": model,
                            "reasoning": reasoning,
                            "structured_output_valid": case_shape == "structured",
                            "session_ref_schema_version": "agent-session-ref.v1",
                            "usage": {
                                "input_tokens": 1,
                                "output_tokens": 2,
                                "total_tokens": 3,
                            },
                            "sdk_version": generation_policy.PLAN_EVAL_PIN["codex_sdk_version"],
                            "runtime_version": generation_policy.PLAN_EVAL_PIN["codex_sdk_version"],
                            "tool_events": tool_events,
                            "elapsed_ms": 1,
                            "permission_requests": 0,
                        }
                        for plan_id, operation, profile, case_shape, model, reasoning, tool_events in (
                            (
                                "routine",
                                "metadata_enrichment",
                                None,
                                "structured",
                                "gpt-5.6-luna",
                                "low",
                                0,
                            ),
                            (
                                "standard",
                                "dawn_write",
                                None,
                                "text",
                                "gpt-5.6-terra",
                                "medium",
                                0,
                            ),
                            (
                                "thorough",
                                "dossier_library",
                                None,
                                "structured",
                                "gpt-5.6-terra",
                                "high",
                                0,
                            ),
                            ("deep", "chat", "deep", "mcp_read", "gpt-5.6-sol", "high", 1),
                        )
                    ]
                ],
            },
            separators=(",", ":"),
        ).encode()
        + b"\n"
    )


_VALID_EVIDENCE = _valid_evidence(_VALID_EVIDENCE_RUN_ID)


def _failure_marker() -> bytes:
    return (
        json.dumps(
            {
                "schema_version": "nexus-hosted-codex-canary-failure.v1",
                "github_run_id": int(_RUN_ID),
                "status": "failed",
            },
            separators=(",", ":"),
        ).encode()
        + b"\n"
    )


@pytest.mark.parametrize(
    ("case", "canary_outcome", "evidence", "expected_returncode", "expected_artifact"),
    (
        (
            "valid-success",
            "success",
            ((_VALID_EVIDENCE_RUN_ID, _VALID_EVIDENCE),),
            0,
            _VALID_EVIDENCE,
        ),
        (
            "failed-canary",
            "failure",
            ((_VALID_EVIDENCE_RUN_ID, _VALID_EVIDENCE),),
            0,
            _failure_marker(),
        ),
        (
            "sibling-exclusion",
            "success",
            ((_VALID_EVIDENCE_RUN_ID, _VALID_EVIDENCE),),
            0,
            _VALID_EVIDENCE,
        ),
        (
            "malformed-success",
            "success",
            ((_VALID_EVIDENCE_RUN_ID, b"{not-json\n"),),
            1,
            _failure_marker(),
        ),
        (
            "oversized-success",
            "success",
            ((_VALID_EVIDENCE_RUN_ID, b"x" * (16 * 1024 + 1)),),
            1,
            _failure_marker(),
        ),
        ("missing-success", "success", (), 1, _failure_marker()),
        (
            "multiple-success",
            "success",
            (
                (_VALID_EVIDENCE_RUN_ID, _VALID_EVIDENCE),
                (_SECOND_EVIDENCE_RUN_ID, _valid_evidence(_SECOND_EVIDENCE_RUN_ID)),
            ),
            1,
            _failure_marker(),
        ),
    ),
    ids=(
        "valid",
        "canary-failed",
        "sibling",
        "malformed",
        "oversized",
        "missing",
        "multiple",
    ),
)
def test_codex_nightly_stages_only_one_run_bound_bounded_json_artifact(
    tmp_path: Path,
    case: str,
    canary_outcome: str,
    evidence: tuple[tuple[str, bytes], ...],
    expected_returncode: int,
    expected_artifact: bytes,
) -> None:
    """Risk: the live workflow stages malformed or excess hosted output."""

    _assert_runner_security_contract()
    stage = _workflow_step("Stage bounded Codex nightly artifact")
    _assert_artifact_delivery_contract(
        stage, _workflow_step("Upload bounded Codex nightly artifact")
    )
    for source_run_id, payload in evidence:
        evidence_path = tmp_path / "test-results/runs" / source_run_id / _EVIDENCE_NAME
        evidence_path.parent.mkdir(parents=True, exist_ok=True)
        evidence_path.write_bytes(payload)
    sentinel = b"unrelated-hosted-sentinel-65c8e80d"
    if case == "sibling-exclusion":
        sibling = tmp_path / "test-results/runs/sibling/unrelated.json"
        sibling.parent.mkdir(parents=True, exist_ok=True)
        sibling.write_bytes(sentinel)

    runner_temp = tmp_path / "runner-temp"
    runner_temp.mkdir()
    workflow_python = tmp_path / "python/.venv/bin/python"
    workflow_python.parent.mkdir(parents=True)
    workflow_python.symlink_to(Path(sys.executable))
    result = subprocess.run(
        ("bash", "-c", _staging_command(stage)),
        cwd=tmp_path,
        env={
            "CANARY_OUTCOME": canary_outcome,
            "GITHUB_RUN_ID": _RUN_ID,
            "GITHUB_SHA": _SOURCE_SHA,
            "PATH": os.environ["PATH"],
            "PYTHONPATH": str(Path(__file__).parents[2]),
            "RUNNER_TEMP": str(runner_temp),
        },
        check=False,
        capture_output=True,
    )

    _require(
        result.returncode == expected_returncode,
        "nightly artifact staging did not use its required fail-closed outcome",
    )
    artifacts = tuple(runner_temp.iterdir())
    _require(
        tuple(path.name for path in artifacts) == (_ARTIFACT_NAME,),
        "nightly artifact staging did not produce exactly its fixed filename",
    )
    artifact = artifacts[0].read_bytes()
    _require(
        artifact == expected_artifact,
        "nightly artifact staging did not produce its bounded exact artifact",
    )
    _require(sentinel not in artifact, "nightly artifact staging retained a sibling sentinel")


def test_codex_nightly_stages_a_bounded_not_run_receipt_for_unavailable_subscription_auth(
    tmp_path: Path,
) -> None:
    stage = _workflow_step("Stage bounded Codex nightly artifact")
    readiness = tmp_path / "test-results/runs" / _VALID_EVIDENCE_RUN_ID / _READINESS_NAME
    readiness.parent.mkdir(parents=True)
    readiness.write_text(
        json.dumps(
            {
                "schema_version": "nexus-hosted-codex-readiness.v1",
                "run_id": _VALID_EVIDENCE_RUN_ID,
                "status": "subscription_unavailable",
            },
            separators=(",", ":"),
        )
        + "\n",
        encoding="utf-8",
    )
    runner_temp = tmp_path / "runner-temp"
    runner_temp.mkdir()
    workflow_python = tmp_path / "python/.venv/bin/python"
    workflow_python.parent.mkdir(parents=True)
    workflow_python.symlink_to(Path(sys.executable))

    result = subprocess.run(
        ("bash", "-c", _staging_command(stage)),
        cwd=tmp_path,
        env={
            "CANARY_OUTCOME": "failure",
            "GITHUB_RUN_ID": _RUN_ID,
            "GITHUB_SHA": _SOURCE_SHA,
            "PATH": os.environ["PATH"],
            "PYTHONPATH": str(Path(__file__).parents[2]),
            "RUNNER_TEMP": str(runner_temp),
        },
        check=False,
        capture_output=True,
    )

    assert result.returncode == 0
    assert (runner_temp / _ARTIFACT_NAME).read_bytes() == (
        b'{"schema_version":"nexus-hosted-codex-canary-not-run.v1",'
        b'"github_run_id":1234567890,"status":"subscription_unavailable"}\n'
    )
    gate = subprocess.run(
        ("bash", "-c", _gate_command()),
        cwd=tmp_path,
        env={
            "CANARY_OUTCOME": "failure",
            "GITHUB_RUN_ID": _RUN_ID,
            "GITHUB_SHA": _SOURCE_SHA,
            "PATH": os.environ["PATH"],
            "PYTHONPATH": str(Path(__file__).parents[2]),
            "RUNNER_TEMP": str(runner_temp),
        },
        check=False,
        capture_output=True,
    )
    assert gate.returncode != 0, "an uploaded not-run receipt turned the nightly green"


@pytest.mark.parametrize(
    ("canary_outcome", "artifact", "expected_returncode"),
    (
        ("success", _VALID_EVIDENCE, 0),
        ("failure", _VALID_EVIDENCE, 1),
        ("success", _failure_marker(), 1),
        (
            "success",
            b'{"schema_version":"nexus-hosted-codex-canary-not-run.v1",'
            b'"github_run_id":1234567890,"status":"subscription_unavailable"}\n',
            1,
        ),
    ),
    ids=("qualified", "controller-failed", "failed-receipt", "not-run-receipt"),
)
def test_codex_nightly_final_gate_accepts_only_a_successful_qualification(
    tmp_path: Path,
    canary_outcome: str,
    artifact: bytes,
    expected_returncode: int,
) -> None:
    runner_temp = tmp_path / "runner-temp"
    runner_temp.mkdir()
    (runner_temp / _ARTIFACT_NAME).write_bytes(artifact)
    workflow_python = tmp_path / "python/.venv/bin/python"
    workflow_python.parent.mkdir(parents=True)
    workflow_python.symlink_to(Path(sys.executable))

    result = subprocess.run(
        ("bash", "-c", _gate_command()),
        cwd=tmp_path,
        env={
            "CANARY_OUTCOME": canary_outcome,
            "GITHUB_RUN_ID": _RUN_ID,
            "GITHUB_SHA": _SOURCE_SHA,
            "PATH": os.environ["PATH"],
            "PYTHONPATH": str(Path(__file__).parents[2]),
            "RUNNER_TEMP": str(runner_temp),
        },
        check=False,
        capture_output=True,
    )

    assert result.returncode == expected_returncode
    assert result.stdout == b""
    assert result.stderr == b""


def test_codex_nightly_enforces_the_exact_per_plan_live_turn_ceiling() -> None:
    hosted_proof = Path(__file__).parents[1] / "hosted/nightly/test_codex_personal_generation.py"
    tree = ast.parse(hosted_proof.read_text(encoding="utf-8"), filename=str(hosted_proof))
    constants = {
        target.id: node.value.value
        for node in tree.body
        if isinstance(node, ast.Assign)
        and len(node.targets) == 1
        and isinstance((target := node.targets[0]), ast.Name)
        and isinstance(node.value, ast.Constant)
    }
    assert constants.get("_MAX_PLAN_ELAPSED_SECONDS") == 600
    enforced_turns = [
        node
        for node in ast.walk(tree)
        if isinstance(node, ast.AsyncWith)
        and len(node.items) == 1
        and isinstance((timeout_call := node.items[0].context_expr), ast.Call)
        and isinstance(timeout_call.func, ast.Attribute)
        and isinstance(timeout_call.func.value, ast.Name)
        and timeout_call.func.value.id == "asyncio"
        and timeout_call.func.attr == "timeout"
        and len(timeout_call.args) == 1
        and isinstance(timeout_call.args[0], ast.Name)
        and timeout_call.args[0].id == "_MAX_PLAN_ELAPSED_SECONDS"
        and any(
            isinstance(candidate, ast.Attribute) and candidate.attr == "stream_turn"
            for statement in node.body
            for candidate in ast.walk(statement)
        )
    ]
    assert len(enforced_turns) == 1, "the hosted turn ceiling is only observed after the effect"


def test_codex_nightly_readiness_is_emitted_only_by_zero_turn_preflight() -> None:
    hosted_proof = Path(__file__).parents[1] / "hosted/nightly/test_codex_personal_generation.py"
    tree = ast.parse(hosted_proof.read_text(encoding="utf-8"), filename=str(hosted_proof))
    parents = {child: parent for parent in ast.walk(tree) for child in ast.iter_child_nodes(parent)}
    readiness_calls = [
        node
        for node in ast.walk(tree)
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Name)
        and node.func.id == "_write_readiness"
    ]
    assert len(readiness_calls) == 1, "readiness gained a post-preflight emission path"
    readiness_call = readiness_calls[0]
    ancestors: list[ast.AST] = []
    ancestor = parents.get(readiness_call)
    while ancestor is not None:
        ancestors.append(ancestor)
        ancestor = parents.get(ancestor)
    handlers = [node for node in ancestors if isinstance(node, ast.ExceptHandler)]
    assert len(handlers) == 1
    preflight_try = parents.get(handlers[0])
    assert isinstance(preflight_try, ast.Try)
    assert any(
        isinstance(node, ast.Call)
        and isinstance(node.func, ast.Name)
        and node.func.id == "_probe_subscription_auth"
        for statement in preflight_try.body
        for node in ast.walk(statement)
    ), "readiness is no longer owned by subscription preflight"
    paid_loops = [
        node
        for node in ast.walk(tree)
        if isinstance(node, ast.For)
        and any(
            isinstance(candidate, ast.Name) and candidate.id == "_PLANS"
            for candidate in ast.walk(node.iter)
        )
    ]
    assert len(paid_loops) == 1
    assert readiness_call.lineno < paid_loops[0].lineno
    assert not any(isinstance(node, (ast.For, ast.AsyncFor)) for node in ancestors)


def _workflow_step(name: str) -> dict[str, object]:
    steps = _workflow_job()["steps"]
    if not isinstance(steps, list):
        raise AssertionError("Codex nightly workflow steps are absent")
    for step in steps:
        if isinstance(step, dict) and step.get("name") == name:
            return cast(dict[str, object], step)
    raise AssertionError(f"Codex nightly workflow has no {name!r} step")


def _workflow_job() -> dict[str, object]:
    workflow_path = Path(__file__).parents[3] / ".github/workflows/codex-personal-nightly.yml"
    workflow = yaml.safe_load(workflow_path.read_text(encoding="utf-8"))
    return cast(dict[str, object], workflow["jobs"]["codex-personal-generation"])


def _assert_runner_security_contract() -> None:
    """The subscription credential runner receives only its minimal toolchain."""

    job = _workflow_job()
    _require(
        job.get("runs-on") == ["self-hosted", "linux", "nexus-codex-nightly"],
        "Codex nightly no longer targets only its dedicated runner label",
    )
    environment = job.get("env")
    _require(
        isinstance(environment, dict)
        and environment.get("NEXUS_CODEX_HOSTED_SOURCE_SHA") == "${{ github.sha }}",
        "Codex nightly no longer binds hosted evidence to the checked-out source SHA",
    )
    _require(
        environment.get("NEXUS_CODEX_HOSTED_TEMPORARY_DIRECTORY")
        == "/var/lib/nexus-codex-nightly/tmp",
        "Codex nightly no longer owns its exact confined temporary directory",
    )
    steps = job.get("steps")
    _require(isinstance(steps, list), "Codex nightly workflow steps are absent")
    action_uses = tuple(
        step["uses"]
        for step in steps
        if isinstance(step, dict) and isinstance(step.get("uses"), str)
    )
    _require(
        action_uses
        == (
            "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
            "actions/setup-python@5fda3b95a4ea91299a34e894583c3862153e4b97",
            "astral-sh/setup-uv@c771a70e6277c0a99b617c7a806ffedaca235ff9",
            "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
        ),
        "Codex nightly gained an unreviewed action or broad shared setup",
    )
    install = _workflow_step("Install locked Codex canary environment")
    _require(
        install.get("run")
        == "uv sync --frozen --no-editable --extra codex-agent --extra dev --directory python",
        "Codex nightly dependency installation is not the exact locked minimal environment",
    )
    commands = "\n".join(str(step.get("run", "")) for step in steps if isinstance(step, dict))
    for forbidden in ("sudo", "apt-get", "docker", "playwright", "setup-test"):
        _require(
            forbidden not in commands and forbidden not in "\n".join(action_uses),
            f"Codex nightly retained forbidden job-time authority: {forbidden}",
        )
    _require(
        "/sys/kernel/security/apparmor/profiles" not in commands,
        "Codex nightly requires privileged securityfs inspection from the runner account",
    )
    cleanup = _workflow_step("Scrub disposable Codex nightly state")
    cleanup_command = cleanup.get("run")
    _require(
        cleanup.get("if") == "always()"
        and isinstance(cleanup_command, str)
        and 'test "$NEXUS_CODEX_HOSTED_TEMPORARY_DIRECTORY" = /var/lib/nexus-codex-nightly/tmp'
        in cleanup_command
        and 'find "$NEXUS_CODEX_HOSTED_TEMPORARY_DIRECTORY" -mindepth 1 -delete' in cleanup_command
        and 'find "$NEXUS_CODEX_HOSTED_WORKING_DIRECTORY" -mindepth 1 -delete' in cleanup_command,
        "Codex nightly no longer always scrubs its exact disposable runtime directories",
    )
    boundary = _workflow_step("Verify dedicated subscription state boundary")
    boundary_command = boundary.get("run")
    _require(
        isinstance(boundary_command, str)
        and 'test "$(stat -c \'%d\' "$NEXUS_CODEX_HOSTED_STATE_ROOT")" = '
        '"$(stat -c \'%d\' "$NEXUS_CODEX_HOSTED_TEMPORARY_DIRECTORY")"'
        in boundary_command
        and 'test "$(stat -c \'%d\' "$NEXUS_CODEX_HOSTED_STATE_ROOT")" = '
        '"$(stat -c \'%d\' "$NEXUS_CODEX_HOSTED_WORKING_DIRECTORY")"'
        in boundary_command,
        "Codex nightly no longer binds state, temporary, and workspace to one filesystem",
    )


def _staging_command(stage: dict[str, object]) -> str:
    run = stage.get("run")
    if isinstance(run, str):
        return run
    raise AssertionError("Codex nightly workflow staging command is absent")


def _gate_command() -> str:
    return _staging_command(_workflow_step("Enforce successful Codex nightly qualification"))


def _assert_artifact_delivery_contract(stage: dict[str, object], upload: dict[str, object]) -> None:
    """The parsed workflow must always upload exactly its bounded run artifact."""

    _require(stage.get("if") == "always()", "nightly staging no longer always runs")
    _require(upload.get("if") == "always()", "nightly upload no longer always runs")
    _require(
        upload.get("uses") == "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
        "nightly upload action is no longer the exact pinned action",
    )
    upload_with = upload.get("with")
    _require(isinstance(upload_with, dict), "nightly upload inputs are absent")
    _require(
        set(upload_with) == {"name", "path", "if-no-files-found", "retention-days"},
        "nightly upload inputs no longer have the exact bounded shape",
    )
    _require(
        upload_with.get("name") == "nexus-codex-nightly-${{ github.run_id }}",
        "nightly upload name is not run-bound",
    )
    _require(
        upload_with.get("path")
        == "${{ runner.temp }}/nexus-codex-nightly-${{ github.run_id }}.json",
        "nightly upload path is not the fixed bounded artifact",
    )
    _require(
        upload_with.get("if-no-files-found") == "error",
        "nightly upload must fail closed for a missing artifact",
    )
    _require(upload_with.get("retention-days") == 14, "nightly artifact retention changed")
    gate = _workflow_step("Enforce successful Codex nightly qualification")
    _require(gate.get("if") == "always()", "nightly final qualification gate no longer runs")
    steps = cast(list[object], _workflow_job()["steps"])
    _require(
        steps.index(upload) < steps.index(gate),
        "nightly final gate can prevent the truthful artifact upload",
    )


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)
