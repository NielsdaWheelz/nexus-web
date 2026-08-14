"""Executable artifact-boundary contract for the protected Codex nightly workflow."""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path
from typing import cast

import pytest
import yaml

_RUN_ID = "1234567890"
_EVIDENCE_NAME = "hosted-codex-personal-metadata.json"
_ARTIFACT_NAME = f"nexus-codex-nightly-{_RUN_ID}.json"
_VALID_EVIDENCE_RUN_ID = "0123456789abcdef"
_SECOND_EVIDENCE_RUN_ID = "fedcba9876543210"


def _valid_evidence(run_id: str) -> bytes:
    return (
        json.dumps(
            {
                "schema_version": "nexus-hosted-codex-canary.v1",
                "run_id": run_id,
                "subscription_turns": 1,
                "results": [
                    {
                        "backend": "codex",
                        "transport": "sdk",
                        "auth_profile": "codex-personal",
                        "model": "gpt-5.6-luna",
                        "reasoning": "low",
                        "structured_output_valid": True,
                        "session_ref_schema_version": "agent-session-ref.v1",
                        "usage": {
                            "input_tokens": 1,
                            "output_tokens": 2,
                            "total_tokens": 3,
                        },
                        "sdk_version": "0.144.4",
                        "runtime_version": "1.0.0",
                        "tool_events": 0,
                        "permission_requests": 0,
                    }
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
    return cast(dict[str, object], workflow["jobs"]["codex-personal-metadata"])


def _assert_runner_security_contract() -> None:
    """The subscription credential runner receives only its minimal toolchain."""

    job = _workflow_job()
    _require(
        job.get("runs-on") == ["self-hosted", "linux", "nexus-codex-nightly"],
        "Codex nightly no longer targets only its dedicated runner label",
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


def _staging_command(stage: dict[str, object]) -> str:
    run = stage.get("run")
    if isinstance(run, str):
        return run
    raise AssertionError("Codex nightly workflow staging command is absent")


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


def _require(condition: bool, message: str) -> None:
    if not condition:
        pytest.fail(message, pytrace=False)
