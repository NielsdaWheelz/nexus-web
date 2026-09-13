import os
import threading
from pathlib import Path

import pytest

from nexus_test_control import memory
from nexus_test_control.memory import _memory_bytes, _process_tree_rss, available_memory_mib
from nexus_test_control.runtime import RuntimeContractError


def test_memory_units_are_parsed_without_decimal_binary_confusion() -> None:
    assert _memory_bytes("512B") == 512
    assert _memory_bytes("1.5kB") == 1500
    assert _memory_bytes("1.5KiB") == 1536
    assert _memory_bytes("2MiB") == 2 * 1024 * 1024
    with pytest.raises(RuntimeContractError, match="invalid Docker memory"):
        _memory_bytes("bad")


def test_process_sampler_includes_the_controller() -> None:
    assert _process_tree_rss(os.getpid()) > 0


def test_available_memory_reads_the_kernel_admission_owner(tmp_path: Path) -> None:
    meminfo = tmp_path / "meminfo"
    meminfo.write_text("MemTotal: 8192000 kB\nMemAvailable: 2097152 kB\n", encoding="utf-8")

    assert available_memory_mib(meminfo) == 2048


def test_container_sampling_starts_only_after_heavy_lock_enablement(
    tmp_path: Path,
) -> None:
    container_samples: list[Path] = []
    sampler = memory.OwnedMemorySampler(
        tmp_path,
        include_containers=False,
        process_reader=lambda _pid: 2 * 1024 * 1024,
        container_reader=lambda repo_root: container_samples.append(repo_root) or 3 * 1024 * 1024,
    )

    sampler.start()
    assert container_samples == []
    sampler.enable_containers()
    evidence = sampler.stop()

    assert container_samples == [tmp_path]
    assert evidence.measurement_complete is True
    assert (evidence.process_tree_rss, evidence.container_working_set, evidence.total) == (2, 3, 5)


def test_one_sampler_tracks_main_and_isolated_container_owners_without_double_counting(
    tmp_path: Path,
) -> None:
    isolated = tmp_path / "isolated"
    isolated.mkdir()
    container_samples: list[Path] = []
    sampler = memory.OwnedMemorySampler(
        tmp_path,
        include_containers=False,
        process_reader=lambda _pid: 2 * 1024 * 1024,
        container_reader=lambda repo_root: container_samples.append(repo_root) or 3 * 1024 * 1024,
    )

    sampler.start()
    sampler.enable_containers(tmp_path)
    sampler.enable_containers(isolated)
    sampler.disable_containers(isolated)
    evidence = sampler.stop()

    assert set(container_samples) == {tmp_path, isolated}
    assert evidence.measurement_complete is True
    assert (evidence.process_tree_rss, evidence.container_working_set, evidence.total) == (2, 6, 8)


def test_inflight_sample_ignores_only_an_owner_disabled_for_exact_teardown(
    tmp_path: Path,
) -> None:
    sample_started = threading.Event()
    teardown_started = threading.Event()
    samples = 0

    def read_container(_repo_root: Path) -> int:
        nonlocal samples
        samples += 1
        if samples == 1:
            return 4 * 1024 * 1024
        sample_started.set()
        assert teardown_started.wait(timeout=1), "synthetic teardown never started"
        raise RuntimeContractError("container disappeared during exact teardown")

    sampler = memory.OwnedMemorySampler(
        tmp_path,
        include_containers=True,
        process_reader=lambda _pid: 2 * 1024 * 1024,
        container_reader=read_container,
    )
    sampler.start()
    inflight = threading.Thread(target=sampler._sample, kwargs={"include_containers": True})
    inflight.start()
    assert sample_started.wait(timeout=1), "synthetic Docker sample never became in-flight"

    sampler.disable_containers(tmp_path)
    teardown_started.set()
    inflight.join(timeout=1)
    assert not inflight.is_alive(), "synthetic Docker sample did not finish"
    evidence = sampler.stop()

    assert evidence.measurement_complete is True
    assert (evidence.process_tree_rss, evidence.container_working_set, evidence.total) == (2, 4, 6)


def test_active_owner_recovers_one_transient_container_probe_without_losing_evidence(
    tmp_path: Path,
) -> None:
    samples = 0

    def read_container(_repo_root: Path) -> int:
        nonlocal samples
        samples += 1
        if samples == 1:
            raise RuntimeContractError("synthetic transient Docker failure")
        return 4 * 1024 * 1024

    sampler = memory.OwnedMemorySampler(
        tmp_path,
        include_containers=True,
        process_reader=lambda _pid: 2 * 1024 * 1024,
        container_reader=read_container,
    )
    sampler._sample(include_containers=True)
    evidence = sampler.snapshot()

    assert samples == 2
    assert evidence.measurement_complete is True
    assert (evidence.process_tree_rss, evidence.container_working_set, evidence.total) == (2, 4, 6)


def test_active_owner_docker_error_remains_a_fail_closed_measurement(
    tmp_path: Path,
) -> None:
    samples = 0

    def read_container(_repo_root: Path) -> int:
        nonlocal samples
        samples += 1
        if samples == 1:
            return 4 * 1024 * 1024
        raise RuntimeContractError("synthetic Docker failure for active owner")

    sampler = memory.OwnedMemorySampler(
        tmp_path,
        include_containers=True,
        process_reader=lambda _pid: 2 * 1024 * 1024,
        container_reader=read_container,
    )
    sampler.start()
    sampler._sample(include_containers=True)
    evidence = sampler.stop()

    assert evidence.measurement_complete is False
    assert sampler.failure_detail == (
        "owned container probe failed 2 consecutive reads: "
        "synthetic Docker failure for active owner"
    )
    assert (evidence.process_tree_rss, evidence.container_working_set, evidence.total) == (2, 4, 6)
