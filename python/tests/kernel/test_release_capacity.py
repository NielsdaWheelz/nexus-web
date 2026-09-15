"""Transient host pressure does not permanently disqualify a release."""

from pathlib import Path

import pytest
from deploy.hetzner.release import (
    CodexCapacityBreach,
    HostRelease,
    ReleaseBlocked,
    ReleasePaths,
)


def test_observed_headroom_allows_small_reclaim_stalls(tmp_path: Path) -> None:
    host = HostRelease(ReleasePaths.under(tmp_path))
    host._require_qualification_host_sample((128 * 1024 * 1024, 10.0, 0.5))


@pytest.mark.parametrize(
    "sample", [(128 * 1024 * 1024 - 1, 0.0, 0.0), (400 * 1024 * 1024, 10.1, 0.5)]
)
def test_host_pressure_is_retryable(tmp_path: Path, sample: tuple[int, float, float]) -> None:
    host = HostRelease(ReleasePaths.under(tmp_path))
    with pytest.raises(ReleaseBlocked):
        host._require_qualification_host_sample(sample)


@pytest.mark.parametrize("oom_delta, message", [(1, "OOM kill"), (0, "turns are malformed")])
def test_candidate_failure_is_not_hidden_by_simultaneous_host_pressure(
    tmp_path: Path, oom_delta: int, message: str
) -> None:
    host = HostRelease(ReleasePaths.under(tmp_path))
    evidence = {
        "schema_version": "nexus-codex-capacity.v3",
        "source_sha": "a" * 40,
        "worker_image_id": "sha256:" + "b" * 64,
        "status": "passed",
        "measured_at": "2026-09-15T00:00:00Z",
        "turns": [],
        "cgroup_memory_max": 448 * 1024 * 1024,
        "cgroup_memory_current": 200 * 1024 * 1024,
        "cgroup_memory_peak": 300 * 1024 * 1024,
        "minimum_mem_available": 127 * 1024 * 1024,
        "maximum_memory_psi_some": 11.0,
        "maximum_memory_psi_full": 1.0,
        "oom_kill_delta": oom_delta,
        "services": [],
    }
    with pytest.raises(CodexCapacityBreach, match=message):
        host._read_codex_capacity_evidence_value(
            evidence, expected_source_sha="a" * 40, worker_image_id="sha256:" + "b" * 64
        )
