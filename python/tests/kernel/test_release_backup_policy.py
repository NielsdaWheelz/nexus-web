"""A release backup waiver is explicit, durable and cannot attest an archive."""

from __future__ import annotations

from dataclasses import replace

import pytest
from deploy.hetzner.release import (
    BackupEvidence,
    BackupPolicy,
    ReleaseAttempt,
    ReleaseDefect,
    ReleasePaths,
    ReleasePhase,
    ReleaseStore,
    permanent_failure_phase,
)

NOW = "2026-09-15T00:00:00Z"


@pytest.fixture
def legacy_attempt_json() -> dict[str, object]:
    return {
        "schema_version": 1,
        "source_sha": "a" * 40,
        "manifest_sha256": "b" * 64,
        "candidate_api_image_id": "sha256:" + "c" * 64,
        "candidate_worker_image_id": "sha256:" + "d" * 64,
        "predecessor_sha": "e" * 40,
        "forward_fix_of": None,
        "containers": {
            service: {
                "container_id": "f" * 64,
                "image": "sha256:" + "1" * 64,
                "config_sha256": "2" * 64,
            }
            for service in (
                "postgres",
                "caddy",
                "api",
                "worker-interactive",
                "worker-background",
            )
        },
        "config_path": "/etc/nexus/config/" + "3" * 64 + ".env",
        "config_sha256": "3" * 64,
        "vercel_deployment_id": "dpl_candidate",
        "production_host": "nexus.example.invalid",
        "phase": "Prepared",
        "backup": None,
        "failure_code": None,
        "created_at": NOW,
        "updated_at": NOW,
    }


def test_legacy_attempt_keeps_its_exact_representation(
    legacy_attempt_json: dict[str, object],
) -> None:
    attempt = ReleaseAttempt.from_json(legacy_attempt_json)
    assert attempt.backup_policy is BackupPolicy.Required
    assert attempt.as_json() == legacy_attempt_json
    stopped = attempt.advance(ReleasePhase.WritersStopped, now=NOW)
    assert stopped.as_json() == {**legacy_attempt_json, "phase": "WritersStopped"}
    with pytest.raises(ReleaseDefect, match="requires a database backup waiver"):
        stopped.advance(ReleasePhase.DataMutationStarted, now=NOW)


def test_new_attempt_requires_backup_by_default(
    legacy_attempt_json: dict[str, object],
) -> None:
    legacy = ReleaseAttempt.from_json(legacy_attempt_json)
    attempt = ReleaseAttempt.prepared(
        source_sha=legacy.source_sha,
        manifest_sha256=legacy.manifest_sha256,
        candidate_api_image_id=legacy.candidate_api_image_id,
        candidate_worker_image_id=legacy.candidate_worker_image_id,
        predecessor_sha="e" * 40,
        forward_fix_of=None,
        containers=legacy.containers,
        config_path=legacy.config_path,
        config_sha256=legacy.config_sha256,
        vercel_deployment_id=legacy.vercel_deployment_id,
        production_host=legacy.production_host,
        now=NOW,
    )
    assert attempt.as_json() == {
        **legacy_attempt_json,
        "schema_version": 2,
        "backup_policy": "required",
    }
    stopped = attempt.advance(ReleasePhase.WritersStopped, now=NOW)
    with pytest.raises(ReleaseDefect, match="requires a database backup waiver"):
        stopped.advance(ReleasePhase.DataMutationStarted, now=NOW)
    verified = stopped.with_backup(
        path="/var/backups/nexus/candidate.dump",
        sha256="4" * 64,
        byte_count=123,
        database_identity="nexus:123",
        starting_revision="0215",
        now=NOW,
    )
    assert verified.advance(ReleasePhase.DataMutationStarted, now=NOW).backup == verified.backup


def test_waiver_crosses_mutation_boundary_without_claiming_a_backup(
    legacy_attempt_json: dict[str, object],
) -> None:
    value = {**legacy_attempt_json, "schema_version": 2, "backup_policy": "waived"}
    attempt = ReleaseAttempt.from_json(value)
    assert attempt.as_json() == value
    stopped = attempt.advance(ReleasePhase.WritersStopped, now=NOW)
    mutation = stopped.advance(ReleasePhase.DataMutationStarted, now=NOW)
    assert mutation.backup is None
    assert mutation.as_json()["backup_policy"] == "waived"
    assert (
        permanent_failure_phase(stopped.phase, forward_fix=False) is ReleasePhase.RollbackRequired
    )
    assert (
        permanent_failure_phase(mutation.phase, forward_fix=False) is ReleasePhase.ForwardFixPending
    )
    with pytest.raises(ReleaseDefect, match="has no backup evidence"):
        stopped.advance(ReleasePhase.BackupVerified, now=NOW)
    with pytest.raises(ReleaseDefect, match="cannot contain backup evidence"):
        stopped.with_backup(
            path="/var/backups/nexus/candidate.dump",
            sha256="4" * 64,
            byte_count=123,
            database_identity="nexus:123",
            starting_revision="0215",
            now=NOW,
        )


@pytest.mark.parametrize("policy", [None, True, "", "optional", "WAIVED"])
def test_attempt_rejects_undeclared_backup_policy(
    legacy_attempt_json: dict[str, object], policy: object
) -> None:
    with pytest.raises(ReleaseDefect):
        ReleaseAttempt.from_json(
            {**legacy_attempt_json, "schema_version": 2, "backup_policy": policy}
        )


def test_attempt_schema_does_not_infer_or_retrofit_waivers(
    legacy_attempt_json: dict[str, object],
) -> None:
    for value in (
        {**legacy_attempt_json, "backup_policy": "waived"},
        {**legacy_attempt_json, "schema_version": 2},
        {**legacy_attempt_json, "phase": "DataMutationStarted"},
    ):
        with pytest.raises(ReleaseDefect):
            ReleaseAttempt.from_json(value)


def test_stored_attempt_policy_cannot_change(
    legacy_attempt_json: dict[str, object], monkeypatch: pytest.MonkeyPatch
) -> None:
    current = ReleaseAttempt.from_json(
        {**legacy_attempt_json, "schema_version": 2, "backup_policy": "required"}
    )
    store = ReleaseStore(ReleasePaths())
    monkeypatch.setattr(store, "load_attempt", lambda _source_sha: current)
    with pytest.raises(ReleaseDefect, match="immutable attempt evidence"):
        store.replace_attempt(
            replace(current, phase=ReleasePhase.WritersStopped, backup_policy=BackupPolicy.Waived)
        )


def test_store_rejects_skipping_backup_verification_with_attached_evidence(
    legacy_attempt_json: dict[str, object], monkeypatch: pytest.MonkeyPatch
) -> None:
    current = ReleaseAttempt.from_json(legacy_attempt_json).advance(
        ReleasePhase.WritersStopped, now=NOW
    )
    store = ReleaseStore(ReleasePaths())
    monkeypatch.setattr(store, "load_attempt", lambda _source_sha: current)
    with pytest.raises(ReleaseDefect, match="requires a database backup waiver"):
        store.replace_attempt(
            replace(
                current,
                phase=ReleasePhase.DataMutationStarted,
                backup=BackupEvidence(
                    path="/var/backups/nexus/candidate.dump",
                    sha256="4" * 64,
                    byte_count=123,
                    database_identity="nexus:123",
                    starting_revision="0215",
                ),
            )
        )
