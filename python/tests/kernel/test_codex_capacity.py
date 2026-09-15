"""Codex admission uses observed capacity while retaining kernel boundaries."""

from pathlib import Path

import pytest
from apps.codex_agent.capacity import CapacityPaths, capacity_is_available


@pytest.fixture
def capacity_paths(tmp_path: Path) -> CapacityPaths:
    paths = CapacityPaths(
        meminfo=tmp_path / "meminfo",
        memory_pressure=tmp_path / "pressure",
        memory_current=tmp_path / "current",
        memory_max=tmp_path / "maximum",
    )
    paths.meminfo.write_text(f"MemAvailable: {400 * 1024} kB\n")
    paths.memory_pressure.write_text(
        "some avg10=0.10 avg60=0.01 avg300=0.00 total=100\n"
        "full avg10=0.01 avg60=0.00 avg300=0.00 total=10\n"
    )
    paths.memory_current.write_text(f"{128 * 1024 * 1024}\n")
    paths.memory_max.write_text(f"{448 * 1024 * 1024}\n")
    return paths


def test_turn_admission_uses_observed_headroom_despite_minor_recent_stalls(
    capacity_paths: CapacityPaths,
) -> None:
    # The observed 400 MiB available exceeds the reserve without forecasting growth.
    assert capacity_is_available(capacity_paths)


@pytest.mark.parametrize(
    ("available_kib", "some", "full", "admitted"),
    [
        (256 * 1024, "5.00", "0.01", True),
        (256 * 1024 - 1, "0.00", "0.00", False),
        (400 * 1024, "5.01", "0.01", False),
    ],
)
def test_turn_admission_retains_observed_reserve_and_pressure_boundaries(
    capacity_paths: CapacityPaths, available_kib: int, some: str, full: str, admitted: bool
) -> None:
    capacity_paths.meminfo.write_text(f"MemAvailable: {available_kib} kB\n")
    capacity_paths.memory_pressure.write_text(
        f"some avg10={some} avg60=0.00 avg300=0.00 total=100\n"
        f"full avg10={full} avg60=0.00 avg300=0.00 total=10\n"
    )
    assert capacity_is_available(capacity_paths) is admitted


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("memory_max", f"{449 * 1024 * 1024}\n"),
        ("memory_current", f"{448 * 1024 * 1024 + 1}\n"),
        ("meminfo", "MemAvailable: unknown kB\n"),
        ("memory_pressure", "some avg10=0.00 avg60=0.00 avg300=0.00 total=0\n"),
    ],
)
def test_turn_admission_refuses_changed_limits_and_incomplete_measurements(
    capacity_paths: CapacityPaths, field: str, value: str
) -> None:
    getattr(capacity_paths, field).write_text(value)
    assert not capacity_is_available(capacity_paths)


def test_turn_admission_refuses_unavailable_measurements(capacity_paths: CapacityPaths) -> None:
    capacity_paths.memory_pressure.unlink()
    assert not capacity_is_available(capacity_paths)
