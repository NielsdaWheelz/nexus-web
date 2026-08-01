import os
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
