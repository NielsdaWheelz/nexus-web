import os
import sys
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


def test_available_memory_floors_partial_mib_for_strict_admission(tmp_path: Path) -> None:
    meminfo = tmp_path / "meminfo"
    meminfo.write_text("MemAvailable: 2097151 kB\n", encoding="utf-8")

    assert available_memory_mib(meminfo) == 2047


def test_darwin_memory_probes_have_fixed_system_owners() -> None:
    expected = (
        Path("/usr/bin/vm_stat"),
        Path("/usr/sbin/sysctl"),
        Path("/bin/ps"),
    )

    assert memory.required_platform_memory_tools() == (expected if sys.platform == "darwin" else ())


def test_available_memory_parses_darwin_kernel_vm_statistics() -> None:
    vm_stat = (
        "Mach Virtual Memory Statistics: (page size of 4096 bytes)\n"
        "Pages free: 262144.\n"
        "Pages active: 1048576.\n"
        "Pages inactive: 524288.\n"
        "Pages speculative: 262144.\n"
        "Pages purgeable: 262144.\n"
        "File-backed pages: 262144.\n"
    )

    assert memory._darwin_available_memory_mib(vm_stat, pressure_level=1) == 2048


@pytest.mark.parametrize("pressure_level", [2, 4])
def test_available_memory_rejects_darwin_memory_pressure(pressure_level: int) -> None:
    vm_stat = (
        "Mach Virtual Memory Statistics: (page size of 4096 bytes)\n"
        "Pages free: 262144.\n"
        "File-backed pages: 262144.\n"
    )

    assert memory._darwin_available_memory_mib(vm_stat, pressure_level=pressure_level) is None


def test_darwin_memory_pressure_parser_is_closed() -> None:
    assert memory._parse_darwin_pressure_level("1\n") == 1
    assert memory._parse_darwin_pressure_level("warn\n") is None
    assert memory._parse_darwin_pressure_level("1\n2\n") is None


def test_available_memory_rejects_incomplete_darwin_kernel_statistics() -> None:
    vm_stat = (
        "Mach Virtual Memory Statistics: (page size of 4096 bytes)\n"
        "Pages free: 262144.\n"
        "Pages inactive: 524288.\n"
    )

    assert memory._darwin_available_memory_mib(vm_stat, pressure_level=1) is None


def test_process_sampler_reads_the_darwin_process_tree() -> None:
    process_table = "100 1 1024\n101 100 2048\n102 101 4096\n200 1 8192\n"

    assert memory._darwin_process_tree_rss(100, process_table) == 7 * 1024 * 1024


def test_process_sampler_rejects_a_missing_darwin_controller() -> None:
    with pytest.raises(RuntimeContractError, match="controller process"):
        memory._darwin_process_tree_rss(100, "200 1 8192\n")


def test_process_sampler_rejects_malformed_or_duplicate_darwin_rows() -> None:
    with pytest.raises(RuntimeContractError, match="invalid row"):
        memory._darwin_process_tree_rss(100, "100 1 1024\nmalformed\n")
    with pytest.raises(RuntimeContractError, match="duplicate PID"):
        memory._darwin_process_tree_rss(100, "100 1 1024\n100 1 2048\n")


def test_process_probe_failure_invalidates_owned_memory_evidence(tmp_path: Path) -> None:
    def failed_process_probe(_pid: int) -> int:
        raise RuntimeContractError("synthetic process probe failure")

    sampler = memory.OwnedMemorySampler(
        tmp_path,
        include_containers=False,
        process_reader=failed_process_probe,
    )

    sampler.start()
    evidence = sampler.stop()

    assert evidence.measurement_complete is False
    assert sampler.failure_detail == "synthetic process probe failure"


def test_zero_process_probe_invalidates_owned_memory_evidence(tmp_path: Path) -> None:
    sampler = memory.OwnedMemorySampler(
        tmp_path,
        include_containers=False,
        process_reader=lambda _pid: 0,
    )

    sampler.start()
    evidence = sampler.stop()

    assert evidence.measurement_complete is False
    assert sampler.failure_detail == "owned process probe returned invalid memory"


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


def test_active_owner_recovers_one_transient_container_sample_without_losing_evidence(
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
    assert sampler.snapshot().measurement_complete is False
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
    assert sampler.snapshot().measurement_complete is True
    sampler._sample(include_containers=True)
    evidence = sampler.stop()

    assert samples == 3
    assert evidence.measurement_complete is False
    assert sampler.failure_detail == (
        "owned container probe failed 2 consecutive samples: "
        "synthetic Docker failure for active owner"
    )
    assert (evidence.process_tree_rss, evidence.container_working_set, evidence.total) == (2, 4, 6)
