"""Unit tests for immutable backend release identities."""

from __future__ import annotations

import json
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


def _candidate() -> CandidateManifest:
    return CandidateManifest(
        schema_version=2,
        source_sha=SOURCE_SHA,
        repository="NielsdaWheelz/nexus-web",
        images=CandidateImages(api=API_DIGEST, worker=WORKER_DIGEST),
        expected_database_revision="0210",
        expected_oracle_manifest_digest=ORACLE_DIGEST,
    )


def _write_identities(tmp_path: Path) -> tuple[Path, Path]:
    api_identity = tmp_path / "api.json"
    worker_identity = tmp_path / "worker.json"
    write_runtime_identity_value(_identity(), api_identity)
    write_runtime_identity_value(_identity(), worker_identity)
    return api_identity, worker_identity


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


def test_candidate_manifest_binds_matching_image_identities(tmp_path: Path) -> None:
    api_identity, worker_identity = _write_identities(tmp_path)
    output = tmp_path / "candidate-manifest.json"

    write_candidate_manifest(
        source_sha=SOURCE_SHA,
        api_image=API_DIGEST,
        worker_image=WORKER_DIGEST,
        api_runtime_identity_path=api_identity,
        worker_runtime_identity_path=worker_identity,
        output_path=output,
    )

    assert json.loads(output.read_bytes()) == _candidate().as_json()
    assert (
        output.read_bytes()
        == (
            json.dumps(
                _candidate().as_json(),
                ensure_ascii=True,
                separators=(",", ":"),
                sort_keys=True,
            )
            + "\n"
        ).encode()
    )
    assert load_candidate_manifest(output) == _candidate()


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("source_sha", "A" * 40),
        ("api_image", "ghcr.io/nielsdawheelz/nexus-api:latest"),
        (
            "worker_image",
            "ghcr.io/someone-else/nexus-worker@sha256:" + "c" * 64,
        ),
    ],
)
def test_candidate_manifest_rejects_noncanonical_identity_inputs(
    tmp_path: Path, field: str, value: str
) -> None:
    api_identity, worker_identity = _write_identities(tmp_path)
    arguments: dict[str, object] = {
        "source_sha": SOURCE_SHA,
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
    api_identity, worker_identity = _write_identities(tmp_path)
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
            api_image=API_DIGEST,
            worker_image=WORKER_DIGEST,
            api_runtime_identity_path=api_identity,
            worker_runtime_identity_path=worker_identity,
            output_path=tmp_path / "manifest.json",
        )


def test_candidate_manifest_loader_reads_canonical_legacy_manifests(tmp_path: Path) -> None:
    path = tmp_path / "candidate-manifest.json"
    legacy = {
        **_candidate().as_json(),
        "schema_version": 1,
        "source_ci_run_id": 123,
        "source_ci_run_attempt": 1,
        "source_ci_workflow_id": 321,
        "publisher_run_id": 456,
        "publisher_run_attempt": 1,
    }
    path.write_text(
        json.dumps(legacy, ensure_ascii=True, separators=(",", ":"), sort_keys=True) + "\n",
        encoding="utf-8",
    )

    assert load_candidate_manifest(path) == _candidate()


def test_candidate_manifest_loader_rejects_unknown_duplicate_and_noncanonical_json(
    tmp_path: Path,
) -> None:
    path = tmp_path / "candidate-manifest.json"
    manifest = _candidate().as_json()

    path.write_text(json.dumps({**manifest, "extra": True}, sort_keys=True) + "\n")
    with pytest.raises(BackendArtifactDefect, match="candidate manifest fields"):
        load_candidate_manifest(path)

    canonical = json.dumps(manifest, ensure_ascii=True, separators=(",", ":"), sort_keys=True)
    path.write_text(
        canonical.replace(
            f'"source_sha":"{SOURCE_SHA}"',
            f'"source_sha":"{SOURCE_SHA}","source_sha":"{SOURCE_SHA}"',
        )
        + "\n"
    )
    with pytest.raises(BackendArtifactDefect, match="duplicate"):
        load_candidate_manifest(path)

    path.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
    with pytest.raises(BackendArtifactDefect, match="not canonical"):
        load_candidate_manifest(path)
