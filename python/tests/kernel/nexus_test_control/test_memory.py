import os
from pathlib import Path

from nexus_test_control.memory import _memory_bytes, _process_tree_rss, available_memory_mib


def test_memory_units_are_parsed_without_decimal_binary_confusion() -> None:
    assert _memory_bytes("512B") == 512
    assert _memory_bytes("1.5kB") == 1500
    assert _memory_bytes("1.5KiB") == 1536
    assert _memory_bytes("2MiB") == 2 * 1024 * 1024
    assert _memory_bytes("bad") == 0


def test_process_sampler_includes_the_controller() -> None:
    assert _process_tree_rss(os.getpid()) > 0


def test_available_memory_reads_the_kernel_admission_owner(tmp_path: Path) -> None:
    meminfo = tmp_path / "meminfo"
    meminfo.write_text("MemTotal: 8192000 kB\nMemAvailable: 2097152 kB\n", encoding="utf-8")

    assert available_memory_mib(meminfo) == 2048
