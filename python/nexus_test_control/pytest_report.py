"""Bounded failed-phase observations from pytest's actual exception reports."""

from __future__ import annotations

import json
import os
import sys
from collections.abc import Generator
from dataclasses import dataclass
from pathlib import Path

import pytest
from _pytest.capture import CaptureManager

from nexus_test_control.evidence import JsonValue, redact_text
from nexus_test_control.redaction import environment_secrets

PYTEST_FAILURE_MARKER = "NEXUS_PYTEST_FAILURE:"
_MAX_RECORD_BYTES = 4096
_MAX_RECORDS = 3
_REPORTED = pytest.StashKey[int]()


@dataclass(frozen=True)
class PytestFailure:
    phase: str
    node: str
    exception_type: str
    message: str
    frame: str
    line: int
    assertion: bool
    truncated: bool

    def as_json(self) -> dict[str, JsonValue]:
        return {
            "phase": self.phase,
            "node": self.node,
            "exception_type": self.exception_type,
            "message": self.message,
            "frame": self.frame,
            "line": self.line,
            "assertion": self.assertion,
            "truncated": self.truncated,
        }


def _bounded_text(value: str, json_bytes: int) -> str:
    # Do not retain an arbitrary cut prefix: the parent may know additional
    # secrets intentionally withheld from this child's environment.
    if (
        len(value) <= json_bytes
        and len(json.dumps(value, ensure_ascii=False).encode("utf-8")) <= json_bytes
    ):
        return value
    return "[truncated]"


@pytest.hookimpl(wrapper=True)
def pytest_runtest_makereport(
    item: pytest.Item, call: pytest.CallInfo[None]
) -> Generator[None, pytest.TestReport, pytest.TestReport]:
    report = yield
    if not report.failed or call.excinfo is None:
        return report
    count = item.config.stash.get(_REPORTED, 0)
    if count > _MAX_RECORDS:
        return report
    item.config.stash[_REPORTED] = count + 1
    if count == _MAX_RECORDS:
        encoded = '{"overflow":true}'
    else:
        error = call.excinfo.value
        # Keep one real source frame. If the exception originated in an external
        # library, prefer the last frame under this pytest invocation's root.
        frame = call.excinfo.traceback[-1]
        for entry in call.excinfo.traceback:
            path = Path(str(entry.path))
            if path.is_relative_to(item.config.rootpath) and ".venv" not in path.parts:
                frame = entry
        secrets = environment_secrets(os.environ)
        raw = tuple(
            redact_text(value, secrets)
            for value in (
                item.nodeid,
                f"{type(error).__module__}.{type(error).__qualname__}",
                str(error),
                str(frame.path),
            )
        )
        # JSON-encoded field budgets total 3840 bytes; the fixed envelope
        # (phase, keys, booleans, source line) fits the remaining 256 bytes.
        bounded = tuple(
            _bounded_text(value, limit)
            for value, limit in zip(raw, (768, 256, 2048, 768), strict=True)
        )
        record = PytestFailure(
            phase=report.when,
            node=bounded[0],
            exception_type=bounded[1],
            message=bounded[2],
            frame=bounded[3],
            line=frame.lineno + 1,
            assertion=isinstance(error, (AssertionError, pytest.fail.Exception)),
            truncated=bounded != raw,
        )
        encoded = json.dumps(record.as_json(), ensure_ascii=False, separators=(",", ":"))
        assert len(encoded.encode("utf-8")) <= _MAX_RECORD_BYTES
    capture = item.config.pluginmanager.get_plugin("capturemanager")
    assert isinstance(capture, CaptureManager)
    with capture.global_and_fixture_disabled():
        sys.stdout.write(f"\n{PYTEST_FAILURE_MARKER}{encoded}\n")
        sys.stdout.flush()
    return report


def read_pytest_failures(stdout: str) -> tuple[PytestFailure, ...]:
    """Reject incomplete evidence instead of classifying arbitrary log text."""
    records: list[PytestFailure] = []
    seen: set[str] = set()
    for line in stdout.splitlines():
        if not line.startswith(PYTEST_FAILURE_MARKER) or line in seen:
            continue
        seen.add(line)
        encoded = line[len(PYTEST_FAILURE_MARKER) :]
        if len(encoded.encode("utf-8")) > _MAX_RECORD_BYTES or len(records) >= _MAX_RECORDS:
            raise ValueError("pytest failure evidence exceeds its record bound")
        try:
            value = json.loads(encoded)
        except ValueError as error:
            raise ValueError("pytest failure evidence is malformed or truncated") from error
        if (
            not isinstance(value, dict)
            or set(value)
            != {
                "phase",
                "node",
                "exception_type",
                "message",
                "frame",
                "line",
                "assertion",
                "truncated",
            }
            or any(
                type(value[key]) is not str
                for key in ("phase", "node", "exception_type", "message", "frame")
            )
            or value["phase"] not in {"setup", "call", "teardown"}
            or not value["node"]
            or not value["exception_type"]
            or not value["frame"]
            or type(value["line"]) is not int
            or value["line"] < 1
            or type(value["assertion"]) is not bool
            or type(value["truncated"]) is not bool
        ):
            raise ValueError("pytest failure evidence has an invalid record")
        records.append(PytestFailure(**value))
    if not records:
        raise ValueError("pytest failure evidence is missing")
    return tuple(records)
