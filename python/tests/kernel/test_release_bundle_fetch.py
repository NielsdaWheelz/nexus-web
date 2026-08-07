from __future__ import annotations

import json
from pathlib import Path

import pytest

from tests.testkit.release_bundle import PUBLISHER_RUN_ID, ReleaseBundleHarness

REPO_ROOT = Path(__file__).parents[3]
SOURCE_SHA = "1" * 40


@pytest.fixture
def release_bundle_harness(tmp_path: Path) -> ReleaseBundleHarness:
    return ReleaseBundleHarness.create(
        tmp_path,
        repo_root=REPO_ROOT,
        source_sha=SOURCE_SHA,
    )


def test_release_bundle_fetch_binds_unique_artifact_owner_and_source_ci(
    release_bundle_harness: ReleaseBundleHarness,
    tmp_path: Path,
) -> None:
    harness = release_bundle_harness
    output = tmp_path / "bundle"

    completed = harness.run(output)

    assert completed.returncode == 0, completed.stderr
    assert json.loads(completed.stdout) == {
        "publisher_run_id": PUBLISHER_RUN_ID,
        "source_ci_run_id": 6001,
        "source_sha": SOURCE_SHA,
    }
    assert sorted(
        path.relative_to(output).as_posix() for path in output.rglob("*") if path.is_file()
    ) == [
        "Caddyfile",
        "candidate-manifest.json",
        "docker-compose.yml",
        "python/nexus/__init__.py",
        "python/nexus/release_artifact.py",
        "release.py",
    ]
    events = harness.state()["events"]
    assert any("actions/artifacts?name=" in " ".join(event["arguments"]) for event in events)
    assert any("actions/runs/7001/attempts/1" in " ".join(event["arguments"]) for event in events)
    assert any("actions/runs/6001/attempts/1" in " ".join(event["arguments"]) for event in events)
    assert not any(
        "actions/workflows/backend-images.yml/runs" in " ".join(event["arguments"])
        for event in events
    )


def test_release_bundle_fetch_rejects_any_duplicate_artifact_before_download(
    release_bundle_harness: ReleaseBundleHarness,
    tmp_path: Path,
) -> None:
    harness = release_bundle_harness
    harness.update_state(duplicate_artifact=True)

    completed = harness.run(tmp_path / "bundle")

    assert completed.returncode != 0
    assert "one unexpired immutable backend artifact" in completed.stderr
    assert not any(
        event["arguments"][:2] == ["run", "download"] for event in harness.state()["events"]
    )


@pytest.mark.parametrize(
    ("change", "message"),
    (
        ({"source_ci_path": ".github/workflows/ci.yml@main"}, "source CI"),
        ({"source_ci_run_attempt": 2}, "source CI"),
        ({"source_ci_workflow_id": 5002}, "source CI"),
        ({"publisher_path": ".github/workflows/other.yml"}, "publisher"),
        ({"publisher_run_attempt": 2}, "publisher"),
        ({"manifest_publisher_run_id": 7002}, "artifact owner"),
    ),
)
def test_release_bundle_fetch_rejects_lineage_drift(
    release_bundle_harness: ReleaseBundleHarness,
    tmp_path: Path,
    change: dict[str, object],
    message: str,
) -> None:
    harness = release_bundle_harness
    harness.update_state(**change)

    completed = harness.run(tmp_path / "bundle")

    assert completed.returncode != 0
    assert message in completed.stderr
