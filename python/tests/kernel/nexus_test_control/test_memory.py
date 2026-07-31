import os

from nexus_test_control.memory import _memory_bytes, _process_tree_rss


def test_memory_units_are_parsed_without_decimal_binary_confusion() -> None:
    assert _memory_bytes("512B") == 512
    assert _memory_bytes("1.5kB") == 1500
    assert _memory_bytes("1.5KiB") == 1536
    assert _memory_bytes("2MiB") == 2 * 1024 * 1024
    assert _memory_bytes("bad") == 0


def test_process_sampler_includes_the_controller() -> None:
    assert _process_tree_rss(os.getpid()) > 0
