"""Fail-closed per-turn memory admission for the private Codex host."""

from __future__ import annotations

import re
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from pathlib import Path

_EXPECTED_MEMORY_MAX_BYTES = 384 * 1024 * 1024
_HOST_HEADROOM_BYTES = 256 * 1024 * 1024
_MAX_INPUT_BYTES = 16 * 1024
_PSI_AVG10_MAX = Decimal("5")
_UNSIGNED_INTEGER = re.compile(rb"(?:0|[1-9][0-9]*)\n?\Z")
_PSI_LINE = re.compile(
    r"(some|full) avg10=((?:0|[1-9][0-9]*)(?:\.[0-9]+)?) "
    r"avg60=(?:0|[1-9][0-9]*)(?:\.[0-9]+)? "
    r"avg300=(?:0|[1-9][0-9]*)(?:\.[0-9]+)? total=(?:0|[1-9][0-9]*)"
)


@dataclass(frozen=True, slots=True)
class CapacityPaths:
    """Kernel files that own the host's production admission snapshot."""

    meminfo: Path = Path("/proc/meminfo")
    memory_pressure: Path = Path("/proc/pressure/memory")
    memory_current: Path = Path("/sys/fs/cgroup/memory.current")
    memory_max: Path = Path("/sys/fs/cgroup/memory.max")


PRODUCTION_CAPACITY_PATHS = CapacityPaths()


def capacity_is_available(paths: CapacityPaths = PRODUCTION_CAPACITY_PATHS) -> bool:
    """Return whether one turn fits the fixed existing-VPS envelope."""

    try:
        available = _mem_available_bytes(_read_ascii(paths.meminfo))
        pressure = _memory_pressure(_read_ascii(paths.memory_pressure))
        current = _unsigned_bytes(_read_bounded(paths.memory_current))
        maximum = _unsigned_bytes(_read_bounded(paths.memory_max))
    except (OSError, UnicodeDecodeError, ValueError, InvalidOperation):
        # justify-ignore-error: admission is fail-closed, so an unreadable or malformed
        # kernel snapshot refuses the turn exactly as observed pressure does.
        return False
    if maximum != _EXPECTED_MEMORY_MAX_BYTES or current > maximum:
        return False
    remaining_growth = maximum - current
    return (
        available >= remaining_growth + _HOST_HEADROOM_BYTES
        and pressure["full"] == 0
        and pressure["some"] <= _PSI_AVG10_MAX
    )


def _read_bounded(path: Path) -> bytes:
    with path.open("rb") as source:
        payload = source.read(_MAX_INPUT_BYTES + 1)
    if not payload or len(payload) > _MAX_INPUT_BYTES:
        raise ValueError("capacity input is empty or exceeds its bound")
    return payload


def _read_ascii(path: Path) -> str:
    return _read_bounded(path).decode("ascii")


def _unsigned_bytes(payload: bytes) -> int:
    if _UNSIGNED_INTEGER.fullmatch(payload) is None:
        raise ValueError("cgroup memory value is not a finite unsigned integer")
    return int(payload)


def _mem_available_bytes(payload: str) -> int:
    matches = re.findall(r"(?m)^MemAvailable:[ \t]+([0-9]+) kB$", payload)
    if len(matches) != 1:
        raise ValueError("MemAvailable is absent, duplicated, or malformed")
    return int(matches[0]) * 1024


def _memory_pressure(payload: str) -> dict[str, Decimal]:
    lines = payload.splitlines()
    if len(lines) != 2:
        raise ValueError("memory PSI must contain exactly some and full lines")
    observed: dict[str, Decimal] = {}
    for line in lines:
        match = _PSI_LINE.fullmatch(line)
        if match is None or match.group(1) in observed:
            raise ValueError("memory PSI is malformed or duplicated")
        observed[match.group(1)] = Decimal(match.group(2))
    if set(observed) != {"some", "full"}:
        raise ValueError("memory PSI is incomplete")
    return observed


__all__ = ["PRODUCTION_CAPACITY_PATHS", "CapacityPaths", "capacity_is_available"]
