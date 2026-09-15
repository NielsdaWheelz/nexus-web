"""Unit tests for immutable backend release identities."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from nexus.release_artifact import (
    AndroidPlayerProtocolIdentity,
    BackendArtifactDefect,
    CandidateImages,
    CandidateManifest,
    RuntimeIdentity,
    is_exact_https_origin,
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


def test_android_player_protocol_identity_is_the_raw_corpus_digest_and_admits_only_exact_v2(
    tmp_path: Path,
) -> None:
    corpus = REPO_ROOT / "testdata/android/player-protocol.json"
    identity = AndroidPlayerProtocolIdentity.of_corpus(corpus)

    assert identity == AndroidPlayerProtocolIdentity(
        version=2,
        contract_sha256=hashlib.sha256(corpus.read_bytes()).hexdigest(),
    )
    assert AndroidPlayerProtocolIdentity.from_json(identity.as_json()) == identity
    reserialized = tmp_path / "player-protocol.json"
    reserialized.write_text(
        json.dumps(json.loads(corpus.read_text(encoding="utf-8")), indent=1),
        encoding="utf-8",
    )
    assert AndroidPlayerProtocolIdentity.of_corpus(reserialized) != identity

    for malformed in (
        {"version": 1, "contract_sha256": "a" * 64},
        {"version": 2.0, "contract_sha256": "a" * 64},
        {"version": True, "contract_sha256": "a" * 64},
        {"version": 2, "contract_sha256": "A" * 64},
        {"version": 2, "contract_sha256": "a" * 63},
        {"version": 2},
        {"version": 2, "contract_sha256": "a" * 64, "extra": 1},
        ["2", "a" * 64],
    ):
        with pytest.raises(BackendArtifactDefect):
            AndroidPlayerProtocolIdentity.from_json(malformed)
    with pytest.raises(BackendArtifactDefect):
        AndroidPlayerProtocolIdentity.of_corpus(tmp_path / "absent.json")


def test_release_api_origin_is_one_canonical_https_origin() -> None:
    assert is_exact_https_origin("https://api.nielseriknandal.com")
    assert is_exact_https_origin("https://api.example.test:8443")

    for malformed in (
        None,
        "http://api.example.test",
        "HTTPS://api.example.test",
        "https://API.example.test",
        "https://user@api.example.test",
        "https://api_example.test",
        "https://api.example.test/",
        "https://api.example.test/path",
        "https://api.example.test?",
        "https://api.example.test#",
        "https://api.example.test?#",
        "https://api.example.test?channel=stable",
        "https://api.example.test#latest",
        "https://api.example.test:garbage",
        "https://api.example.test:0",
        "https://api.example%20",
        "https://api.example.test\t",
    ):
        assert not is_exact_https_origin(malformed)


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


@pytest.mark.parametrize("schema_version", [True, False, 1.0, 2.0])
def test_candidate_manifest_loader_rejects_noninteger_legacy_versions(
    tmp_path: Path, schema_version: object
) -> None:
    path = tmp_path / "candidate-manifest.json"
    legacy = {
        **_candidate().as_json(),
        "schema_version": schema_version,
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

    with pytest.raises(BackendArtifactDefect):
        load_candidate_manifest(path)


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
