"""Kernel proof for immutable backend publication artifacts.

Risk: production must not infer release identity from tags, ambient variables, or
the publisher run.  One canonical source-CI manifest and matching read-only image
identities are the only admitted release inputs.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
from pathlib import Path

import pytest

from nexus.release_artifact import (
    BackendArtifactDefect,
    CandidateImages,
    CandidateManifest,
    RuntimeIdentity,
    load_candidate_manifest,
    load_runtime_identity,
    write_candidate_manifest,
    write_runtime_identity_value,
)

REPO_ROOT = Path(__file__).parents[3]
SOURCE_SHA = "0123456789abcdef0123456789abcdef01234567"
ORACLE_DIGEST = "sha256:" + "a" * 64
API_DIGEST = "ghcr.io/nielsdawheelz/nexus-api@sha256:" + "b" * 64
WORKER_DIGEST = "ghcr.io/nielsdawheelz/nexus-worker@sha256:" + "c" * 64


def _identity() -> RuntimeIdentity:
    return RuntimeIdentity(
        source_sha=SOURCE_SHA,
        expected_database_revision="0210",
        expected_oracle_manifest_digest=ORACLE_DIGEST,
    )


def test_runtime_identity_is_closed_canonical_and_duplicate_intolerant(tmp_path: Path) -> None:
    path = tmp_path / "runtime-identity.json"
    write_runtime_identity_value(_identity(), path)

    expected = (
        '{"expected_database_revision":"0210",'
        f'"expected_oracle_manifest_digest":"{ORACLE_DIGEST}",'
        f'"source_sha":"{SOURCE_SHA}"}}\n'
    ).encode()
    assert path.read_bytes() == expected
    assert load_runtime_identity(path) == _identity()

    path.write_text(
        f'{{"source_sha":"{SOURCE_SHA}","source_sha":"{SOURCE_SHA}",'
        '"expected_database_revision":"0210",'
        f'"expected_oracle_manifest_digest":"{ORACLE_DIGEST}"}}\n',
        encoding="utf-8",
    )
    with pytest.raises(BackendArtifactDefect, match="duplicate"):
        load_runtime_identity(path)


def test_candidate_manifest_binds_source_ci_and_matching_image_identities(
    tmp_path: Path,
) -> None:
    api_identity = tmp_path / "api.json"
    worker_identity = tmp_path / "worker.json"
    output = tmp_path / "candidate-manifest.json"
    write_runtime_identity_value(_identity(), api_identity)
    write_runtime_identity_value(_identity(), worker_identity)

    write_candidate_manifest(
        source_sha=SOURCE_SHA,
        source_ci_run_id=123,
        source_ci_run_attempt=1,
        source_ci_workflow_id=321,
        publisher_run_id=456,
        publisher_run_attempt=1,
        api_image=API_DIGEST,
        worker_image=WORKER_DIGEST,
        api_runtime_identity_path=api_identity,
        worker_runtime_identity_path=worker_identity,
        output_path=output,
    )

    manifest = json.loads(output.read_bytes())
    assert manifest == {
        "schema_version": 1,
        "source_sha": SOURCE_SHA,
        "repository": "NielsdaWheelz/nexus-web",
        "source_ci_run_id": 123,
        "source_ci_run_attempt": 1,
        "source_ci_workflow_id": 321,
        "publisher_run_id": 456,
        "publisher_run_attempt": 1,
        "images": {"api": API_DIGEST, "worker": WORKER_DIGEST},
        "expected_database_revision": "0210",
        "expected_oracle_manifest_digest": ORACLE_DIGEST,
    }
    assert (
        output.read_bytes()
        == (
            json.dumps(manifest, ensure_ascii=True, separators=(",", ":"), sort_keys=True) + "\n"
        ).encode()
    )
    assert load_candidate_manifest(output) == CandidateManifest(
        schema_version=1,
        source_sha=SOURCE_SHA,
        repository="NielsdaWheelz/nexus-web",
        source_ci_run_id=123,
        source_ci_run_attempt=1,
        source_ci_workflow_id=321,
        publisher_run_id=456,
        publisher_run_attempt=1,
        images=CandidateImages(api=API_DIGEST, worker=WORKER_DIGEST),
        expected_database_revision="0210",
        expected_oracle_manifest_digest=ORACLE_DIGEST,
    )


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("source_sha", "A" * 40),
        ("source_ci_run_id", 0),
        ("source_ci_run_attempt", 2),
        ("source_ci_workflow_id", 0),
        ("publisher_run_id", 0),
        ("publisher_run_id", 123),
        ("publisher_run_attempt", 2),
        ("api_image", "ghcr.io/nielsdawheelz/nexus-api:latest"),
        (
            "worker_image",
            "ghcr.io/someone-else/nexus-worker@sha256:" + "c" * 64,
        ),
    ],
)
def test_candidate_manifest_rejects_noncanonical_identity_inputs(
    tmp_path: Path, field: str, value: str | int
) -> None:
    api_identity = tmp_path / "api.json"
    worker_identity = tmp_path / "worker.json"
    write_runtime_identity_value(_identity(), api_identity)
    write_runtime_identity_value(_identity(), worker_identity)
    arguments: dict[str, object] = {
        "source_sha": SOURCE_SHA,
        "source_ci_run_id": 123,
        "source_ci_run_attempt": 1,
        "source_ci_workflow_id": 321,
        "publisher_run_id": 456,
        "publisher_run_attempt": 1,
        "api_image": API_DIGEST,
        "worker_image": WORKER_DIGEST,
        "api_runtime_identity_path": api_identity,
        "worker_runtime_identity_path": worker_identity,
        "output_path": tmp_path / "manifest.json",
    }
    arguments[field] = value

    with pytest.raises(BackendArtifactDefect):
        write_candidate_manifest(**arguments)  # type: ignore[arg-type]


def test_candidate_manifest_rejects_different_image_identity(tmp_path: Path) -> None:
    api_identity = tmp_path / "api.json"
    worker_identity = tmp_path / "worker.json"
    write_runtime_identity_value(_identity(), api_identity)
    write_runtime_identity_value(
        RuntimeIdentity(
            source_sha="f" * 40,
            expected_database_revision="0210",
            expected_oracle_manifest_digest=ORACLE_DIGEST,
        ),
        worker_identity,
    )

    with pytest.raises(BackendArtifactDefect, match="identical"):
        write_candidate_manifest(
            source_sha=SOURCE_SHA,
            source_ci_run_id=123,
            source_ci_run_attempt=1,
            source_ci_workflow_id=321,
            publisher_run_id=456,
            publisher_run_attempt=1,
            api_image=API_DIGEST,
            worker_image=WORKER_DIGEST,
            api_runtime_identity_path=api_identity,
            worker_runtime_identity_path=worker_identity,
            output_path=tmp_path / "manifest.json",
        )


def test_candidate_manifest_loader_rejects_unknown_duplicate_and_noncanonical_json(
    tmp_path: Path,
) -> None:
    path = tmp_path / "candidate-manifest.json"
    manifest = {
        "schema_version": 1,
        "source_sha": SOURCE_SHA,
        "repository": "NielsdaWheelz/nexus-web",
        "source_ci_run_id": 123,
        "source_ci_run_attempt": 1,
        "source_ci_workflow_id": 321,
        "publisher_run_id": 456,
        "publisher_run_attempt": 1,
        "images": {"api": API_DIGEST, "worker": WORKER_DIGEST},
        "expected_database_revision": "0210",
        "expected_oracle_manifest_digest": ORACLE_DIGEST,
    }

    path.write_text(json.dumps({**manifest, "extra": True}, sort_keys=True) + "\n")
    with pytest.raises(BackendArtifactDefect, match="candidate manifest fields"):
        load_candidate_manifest(path)

    canonical = json.dumps(manifest, ensure_ascii=True, separators=(",", ":"), sort_keys=True)
    path.write_text(
        canonical.replace(
            '"source_ci_run_id":123',
            '"source_ci_run_id":123,"source_ci_run_id":123',
        )
        + "\n"
    )
    with pytest.raises(BackendArtifactDefect, match="duplicate"):
        load_candidate_manifest(path)

    path.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
    with pytest.raises(BackendArtifactDefect, match="not canonical"):
        load_candidate_manifest(path)


def test_backend_publisher_is_exact_main_source_ci_and_builds_each_target_once() -> None:
    workflow = (REPO_ROOT / ".github/workflows/backend-images.yml").read_text()

    assert "workflow_run:" in workflow
    assert 'workflows: ["CI"]' in workflow
    for predicate in (
        "github.event.workflow_run.run_attempt == 1",
        "github.event.workflow_run.conclusion == 'success'",
        "github.event.workflow_run.event == 'push'",
        "github.event.workflow_run.path == '.github/workflows/ci.yml'",
        "github.event.workflow_run.head_branch == 'main'",
        "github.event.workflow_run.head_repository.full_name == github.repository",
    ):
        assert predicate in workflow
    assert "pull_request:" not in workflow
    assert "permissions: {}" in workflow
    assert "packages: write" in workflow
    assert "actions: read" in workflow
    assert "source-ci-run-id" in workflow
    assert "source-ci-run-attempt" in workflow
    assert "source-ci-workflow-id" in workflow
    assert "github.event.workflow_run.id" in workflow
    assert "publisher-run-id" in workflow
    assert "publisher-run-attempt" in workflow
    assert "github.run_attempt == 1" in workflow
    assert "github.run_attempt != 1" in workflow
    assert "github.run_id" in workflow
    assert "Preserve immutable backend candidate on rerun" in workflow
    assert ".workflow_run.id == $run_id" in workflow
    source_claim = workflow.index("Claim the first exact source CI run")
    assert "actions/workflows/${SOURCE_CI_WORKFLOW_ID}/runs" in workflow
    assert '.path == ".github/workflows/ci.yml"' in workflow
    assert "min_by(.run_number).id" in workflow
    assert workflow.count("docker/build-push-action@") == 2
    assert re.search(r"target:\s*api\b", workflow)
    assert re.search(r"target:\s*worker\b", workflow)
    assert "steps.api.outputs.digest" in workflow
    assert "steps.worker.outputs.digest" in workflow
    api_pull = workflow.index('docker pull "$API_IMAGE"')
    worker_pull = workflow.index('docker pull "$WORKER_IMAGE"')
    api_label_proof = workflow.index('require_revision_label "$API_IMAGE" "API"')
    worker_label_proof = workflow.index('require_revision_label "$WORKER_IMAGE" "worker"')
    manifest_write = workflow.index("write-candidate-manifest")
    artifact_upload = workflow.index("Upload the immutable release bundle")
    local_image_cleanup = workflow.index("Remove locally pulled backend images")
    workspace_cleanup = workflow.index("Remove the release workspace")
    assert source_claim < api_pull < api_label_proof < manifest_write < artifact_upload
    assert source_claim < worker_pull < worker_label_proof < manifest_write < artifact_upload
    assert artifact_upload < local_image_cleanup < workspace_cleanup
    assert 'docker image rm "${local_images[@]}"' in workflow
    assert "backend image cleanup received a malformed digest reference" in workflow
    assert "org.opencontainers.image.revision" in workflow
    assert 'if [ "$revision" != "$SOURCE_SHA" ]; then' in workflow
    assert "Prove digest references are public" in workflow
    assert "nexus-backend-release-${{ github.event.workflow_run.head_sha }}" in workflow
    for bundled in (
        "candidate-manifest.json",
        "deploy/hetzner/release.py",
        "deploy/hetzner/docker-compose.yml",
        "deploy/hetzner/Caddyfile",
        "python/nexus/__init__.py",
        "python/nexus/release_artifact.py",
    ):
        assert bundled in workflow


def _initialize_publisher_checkout(path: Path) -> None:
    path.mkdir()
    (path / ".gitignore").write_text("/.nexus-test/\n", encoding="utf-8")
    (path / "tracked.txt").write_text("owned source\n", encoding="utf-8")
    subprocess.run(("git", "init", "--quiet"), cwd=path, check=True)
    subprocess.run(("git", "add", ".gitignore", "tracked.txt"), cwd=path, check=True)
    subprocess.run(
        (
            "git",
            "-c",
            "user.name=Nexus test",
            "-c",
            "user.email=nexus-test@example.invalid",
            "commit",
            "--quiet",
            "--message=fixture",
        ),
        cwd=path,
        check=True,
    )


def test_backend_publisher_owns_a_fresh_external_artifact_workspace(tmp_path: Path) -> None:
    workflow = (REPO_ROOT / ".github/workflows/backend-images.yml").read_text(encoding="utf-8")
    owner = REPO_ROOT / "deploy/hetzner/backend-publisher-workspace.sh"

    assert "runs-on: [self-hosted, linux, x64]" in workflow
    assert "clean: ${{ runner.environment == 'github-hosted' }}" in workflow
    assert "deploy/hetzner/backend-publisher-workspace.sh prepare" in workflow
    assert (
        workflow.count('deploy/hetzner/backend-publisher-workspace.sh require "$RELEASE_WORKSPACE"')
        == 2
    )
    assert "path: ${{ steps.release_workspace.outputs.path }}/bundle/" in workflow
    assert 'deploy/hetzner/backend-publisher-workspace.sh cleanup "$RELEASE_WORKSPACE"' in workflow
    assert owner.is_file() and os.access(owner, os.X_OK)

    checkout = tmp_path / "checkout"
    runner_temp = tmp_path / "runner-temp"
    github_output = runner_temp / "github-output"
    _initialize_publisher_checkout(checkout)
    runner_temp.mkdir()
    github_output.touch()
    runtime_state = checkout / ".nexus-test"
    runtime_state.mkdir()
    (runtime_state / "runtime.json").write_text("owned runtime\n", encoding="utf-8")
    stale_bundle = checkout / "release-bundle"
    stale_bundle.mkdir()
    (stale_bundle / "stale").write_text("unowned\n", encoding="utf-8")
    environment = {
        **os.environ,
        "GITHUB_OUTPUT": str(github_output),
        "GITHUB_WORKSPACE": str(checkout),
        "RUNNER_TEMP": str(runner_temp),
    }

    prepared = subprocess.run(
        (str(owner), "prepare"),
        cwd=checkout,
        env=environment,
        check=False,
        capture_output=True,
        text=True,
    )

    assert prepared.returncode == 0, prepared.stderr
    release_workspace = Path(
        github_output.read_text(encoding="utf-8").removeprefix("path=").strip()
    )
    assert release_workspace.parent == runner_temp
    assert release_workspace.stat().st_mode & 0o777 == 0o700
    assert (runtime_state / "runtime.json").read_text(encoding="utf-8") == "owned runtime\n"
    assert not stale_bundle.exists()
    rejected = subprocess.run(
        (str(owner), "cleanup", str(checkout)),
        cwd=checkout,
        env=environment,
        check=False,
        capture_output=True,
        text=True,
    )
    assert rejected.returncode != 0
    assert (checkout / "tracked.txt").read_text(encoding="utf-8") == "owned source\n"

    cleaned = subprocess.run(
        (str(owner), "cleanup", str(release_workspace)),
        cwd=checkout,
        env=environment,
        check=False,
        capture_output=True,
        text=True,
    )
    assert cleaned.returncode == 0, cleaned.stderr
    assert not release_workspace.exists()


def test_backend_dockerfile_has_only_immutable_upstreams_and_baked_identity() -> None:
    dockerfile = (REPO_ROOT / "docker/Dockerfile.backend").read_text()
    internal_stages = set(re.findall(r"^FROM\s+\S+\s+AS\s+(\S+)$", dockerfile, re.MULTILINE))
    for line in dockerfile.splitlines():
        match = re.match(r"FROM\s+(\S+)", line)
        if match and match.group(1) not in internal_stages:
            assert re.fullmatch(r"[^\s@]+:[^\s@]+@sha256:[0-9a-f]{64}", match.group(1))

    assert dockerfile.count(" AS api") == 1
    assert dockerfile.count(" AS worker") == 1
    assert "/app/runtime-identity.json" in dockerfile
    assert "org.opencontainers.image.revision=$SOURCE_SHA" in dockerfile
    assert dockerfile.count("USER nexus:nexus") == 2
