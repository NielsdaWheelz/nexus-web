"""Installed db0215 releases retain their exact historical artifact contract."""

from __future__ import annotations

from dataclasses import replace

import pytest

from deploy.hetzner.release import (
    ReleaseDefect,
    ReleaseRecord,
    _validate_installed_bundle_shape,
)
from nexus.release_artifact import CandidateImages, CandidateManifest

LEGACY_FILES = frozenset(
    {
        "Caddyfile",
        "candidate-manifest.json",
        "docker-compose.yml",
        "release.py",
        "python/nexus/__init__.py",
        "python/nexus/release_artifact.py",
    }
)
RESTORED_FILES = LEGACY_FILES | {
    "nexus-codex-agent-host.apparmor",
    "prove-codex-capacity.sh",
    "testdata/android/player-protocol.json",
}


@pytest.fixture
def publication() -> tuple[CandidateManifest, ReleaseRecord]:
    candidate = CandidateManifest(
        schema_version=2,
        source_sha="a" * 40,
        repository="NielsdaWheelz/nexus-web",
        images=CandidateImages(
            api="ghcr.io/nielsdawheelz/nexus-api@sha256:" + "b" * 64,
            worker="ghcr.io/nielsdawheelz/nexus-worker@sha256:" + "c" * 64,
        ),
        expected_database_revision="0215",
        expected_oracle_manifest_digest="sha256:" + "d" * 64,
    )
    record = ReleaseRecord(
        schema_version=1,
        source_sha=candidate.source_sha,
        manifest_sha256="e" * 64,
        api_image=candidate.images.api,
        worker_image=candidate.images.worker,
        api_image_id="sha256:" + "f" * 64,
        worker_image_id="sha256:" + "1" * 64,
        predecessor_sha=None,
        config_path="/etc/nexus/config/" + "2" * 64 + ".env",
        config_sha256="2" * 64,
        database_revision="0215",
        expected_oracle_manifest_digest=candidate.expected_oracle_manifest_digest,
        vercel_deployment_id="dpl_recorded",
        production_host="nexus.example.invalid",
        verified_at="2026-09-14T00:00:00Z",
    )
    return candidate, record


def test_only_recorded_db0215_can_use_the_six_file_bundle(
    publication: tuple[CandidateManifest, ReleaseRecord],
) -> None:
    candidate, record = publication
    _validate_installed_bundle_shape(
        LEGACY_FILES, candidate, current_record=record, manifest_sha256=record.manifest_sha256
    )
    with pytest.raises(ReleaseDefect, match="recorded contract"):
        _validate_installed_bundle_shape(
            LEGACY_FILES, candidate, current_record=None, manifest_sha256=record.manifest_sha256
        )
    with pytest.raises(ReleaseDefect, match="recorded contract"):
        _validate_installed_bundle_shape(
            LEGACY_FILES,
            replace(candidate, expected_database_revision="0229"),
            current_record=replace(record, database_revision="0229"),
            manifest_sha256=record.manifest_sha256,
        )
    _validate_installed_bundle_shape(
        RESTORED_FILES,
        replace(candidate, expected_database_revision="0229"),
        current_record=None,
        manifest_sha256=record.manifest_sha256,
    )


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("source_sha", "0" * 40),
        ("database_revision", "0229"),
        ("manifest_sha256", "0" * 64),
        ("api_image", "ghcr.io/nielsdawheelz/nexus-api@sha256:" + "0" * 64),
        ("worker_image", "ghcr.io/nielsdawheelz/nexus-worker@sha256:" + "0" * 64),
        ("expected_oracle_manifest_digest", "sha256:" + "0" * 64),
    ],
)
def test_legacy_bundle_must_match_the_current_publication(
    publication: tuple[CandidateManifest, ReleaseRecord], field: str, value: str
) -> None:
    candidate, record = publication
    with pytest.raises(ReleaseDefect, match="recorded contract"):
        _validate_installed_bundle_shape(
            LEGACY_FILES,
            candidate,
            current_record=replace(record, **{field: value}),
            manifest_sha256=record.manifest_sha256,
        )


@pytest.mark.parametrize("files", [LEGACY_FILES - {"Caddyfile"}, LEGACY_FILES | {"unexpected"}])
def test_legacy_bundle_has_no_optional_or_extra_files(
    publication: tuple[CandidateManifest, ReleaseRecord], files: frozenset[str]
) -> None:
    candidate, record = publication
    with pytest.raises(ReleaseDefect, match="recorded contract"):
        _validate_installed_bundle_shape(
            files, candidate, current_record=record, manifest_sha256=record.manifest_sha256
        )
