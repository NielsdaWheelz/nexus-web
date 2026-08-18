"""Fresh-child execution boundary for the background Postgres worker."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import traceback
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Literal, cast
from uuid import UUID

from nexus.jobs.queue import JobExecutionContext, RescheduleRequested

_PROTOCOL_VERSION = 2
_INPUT_KEYS = frozenset(
    {
        "version",
        "handler_path",
        "payload",
        "context",
        "oom_score_adj",
        "result_max_bytes",
        "runtime",
    }
)
_RESULT_KEYS = {
    "Succeeded": frozenset({"version", "kind", "payload"}),
    "Reschedule": frozenset({"version", "kind", "available_at", "delay_seconds", "payload"}),
    "ModeledFailure": frozenset({"version", "kind", "error_code", "message", "resource_dimension"}),
    "Defect": frozenset({"version", "kind", "error_type", "message"}),
}
_CONTEXT_KEYS = frozenset({"job_id", "worker_id", "attempt_no", "resource_class"})
_PRESENCE_ABSENT_KEYS = frozenset({"kind"})
_PRESENCE_PRESENT_KEYS = frozenset({"kind", "value"})
_RESOURCE_DIMENSIONS = frozenset({"Memory", "Time", "Structure", "Output"})
_RESULT_MAX_BYTES = 4 * 1024 * 1024
_WALL_TIMEOUT_MAX_SECONDS = 900.0

type ResourceFailureDimension = Literal["Memory", "Time", "Structure", "Output"]


# justify-defect: this boundary is wholly owned and accepts one exact protocol.
class BackgroundProcessProtocolDefect(RuntimeError):
    """The owned child or its configured containment boundary is invalid."""


@dataclass(frozen=True, slots=True)
class ValidatedCgroup:
    """Cgroup v2 facts required for safe child OOM selection."""

    directory: Path
    memory_limit_bytes: int

    @classmethod
    def open(cls, directory: Path, *, expected_memory_limit_bytes: int) -> ValidatedCgroup:
        expected = int(expected_memory_limit_bytes)
        if expected < 1:
            raise BackgroundProcessProtocolDefect("background memory limit must be positive")
        try:
            controllers = frozenset(
                (directory / "cgroup.controllers").read_text(encoding="ascii").split()
            )
            memory_max = (directory / "memory.max").read_text(encoding="ascii").strip()
            oom_group = (directory / "memory.oom.group").read_text(encoding="ascii").strip()
            _read_oom_kill_count(directory / "memory.events")
        except OSError as exc:
            raise BackgroundProcessProtocolDefect(
                f"background cgroup v2 contract is unreadable at {directory}"
            ) from exc
        if "memory" not in controllers:
            raise BackgroundProcessProtocolDefect("background cgroup has no memory controller")
        if memory_max == "max" or not memory_max.isdecimal() or int(memory_max) != expected:
            raise BackgroundProcessProtocolDefect(
                "background cgroup memory.max does not match the configured limit"
            )
        if oom_group != "0":
            raise BackgroundProcessProtocolDefect(
                "background cgroup memory.oom.group must be 0 so one child is killable"
            )
        return cls(directory=directory, memory_limit_bytes=expected)

    @classmethod
    def for_current_process(
        cls,
        cgroup_root: Path,
        *,
        expected_memory_limit_bytes: int,
        proc_cgroup: Path = Path("/proc/self/cgroup"),
    ) -> ValidatedCgroup:
        try:
            lines = proc_cgroup.read_text(encoding="ascii").splitlines()
        except OSError as exc:
            raise BackgroundProcessProtocolDefect(
                "current cgroup membership is unreadable"
            ) from exc
        memberships = [line.removeprefix("0::") for line in lines if line.startswith("0::/")]
        if len(memberships) != 1:
            raise BackgroundProcessProtocolDefect(
                "current process is not in one cgroup v2 hierarchy"
            )
        relative = memberships[0].lstrip("/")
        directory = cgroup_root / relative if relative else cgroup_root
        return cls.open(directory, expected_memory_limit_bytes=expected_memory_limit_bytes)

    def oom_kill_count(self) -> int:
        return _read_oom_kill_count(self.directory / "memory.events")


@dataclass(frozen=True, slots=True)
class ChildSucceeded:
    payload: dict[str, Any]


@dataclass(frozen=True, slots=True)
class ChildReschedule:
    available_at: datetime | None
    delay_seconds: int | None
    payload: Mapping[str, Any] | None

    def __post_init__(self) -> None:
        if (self.available_at is None) == (self.delay_seconds is None):
            raise ValueError("ChildReschedule requires exactly one schedule form")
        if self.delay_seconds is not None and (
            type(self.delay_seconds) is not int or self.delay_seconds < 0
        ):
            raise ValueError("ChildReschedule.delay_seconds must be a non-negative integer")


@dataclass(frozen=True, slots=True)
class ChildModeledFailure:
    error_code: str
    message: str
    resource_dimension: ResourceFailureDimension | None


@dataclass(frozen=True, slots=True)
class ChildDefect:
    error_type: str
    message: str


@dataclass(frozen=True, slots=True)
class ChildResourceFailure:
    dimension: ResourceFailureDimension


@dataclass(frozen=True, slots=True)
class ChildInterrupted:
    message: str


type ChildExecutionResult = (
    ChildSucceeded
    | ChildReschedule
    | ChildModeledFailure
    | ChildDefect
    | ChildResourceFailure
    | ChildInterrupted
)


@dataclass(frozen=True, slots=True)
class BackgroundProcessExecutor:
    """Execute one declaratively named handler in a fresh process group."""

    cgroup: ValidatedCgroup
    result_max_bytes: int
    term_grace_seconds: float
    child_oom_score_adj: int
    parser_temp_root: Path

    def __post_init__(self) -> None:
        if type(self.result_max_bytes) is not int or not (
            1024 <= self.result_max_bytes <= _RESULT_MAX_BYTES
        ):
            raise ValueError("background child result limit must be between 1024 and 4194304 bytes")
        if not 0 < self.term_grace_seconds <= 30:
            raise ValueError("background child TERM grace must be positive and at most 30 seconds")
        if type(self.child_oom_score_adj) is not int or not (1 <= self.child_oom_score_adj <= 1000):
            raise ValueError("background child oom_score_adj must be between 1 and 1000")
        if not self.parser_temp_root.is_absolute():
            raise ValueError("background parser temp root must be absolute")

    def execute(
        self,
        *,
        handler_path: str,
        payload: Mapping[str, Any],
        context: JobExecutionContext,
        wall_timeout_seconds: float,
        runtime: Literal["Base", "Llm"],
        child_exit_cleanup: Literal["None", "SourceAttemptParserTemp"] = "None",
    ) -> ChildExecutionResult:
        if not 0 < wall_timeout_seconds <= _WALL_TIMEOUT_MAX_SECONDS:
            raise ValueError(
                "background child wall timeout must be positive and at most 900 seconds"
            )
        request = _encode_request(
            handler_path=handler_path,
            payload=payload,
            context=context,
            oom_score_adj=self.child_oom_score_adj,
            result_max_bytes=self.result_max_bytes,
            runtime=runtime,
        )
        if len(request) > self.result_max_bytes:
            return ChildDefect(
                error_type="InputTooLarge",
                message="Background child input exceeded its closed protocol limit.",
            )

        cleanup_directory = _child_exit_cleanup_directory(
            parser_temp_root=self.parser_temp_root,
            payload=payload,
            cleanup=child_exit_cleanup,
        )
        try:
            oom_kills_before = self.cgroup.oom_kill_count()
            with tempfile.TemporaryFile() as result_file:
                result_fd = result_file.fileno()
                try:
                    process = subprocess.Popen(
                        [
                            sys.executable,
                            "-m",
                            "nexus.jobs.process_executor",
                            "--child-result-fd",
                            str(result_fd),
                        ],
                        stdin=subprocess.PIPE,
                        stdout=subprocess.DEVNULL,
                        start_new_session=True,
                        pass_fds=(result_fd,),
                    )
                except OSError as exc:
                    return ChildDefect(
                        error_type=type(exc).__name__,
                        message="Background child process could not be started.",
                    )

                timed_out = False
                try:
                    try:
                        process.communicate(input=request, timeout=wall_timeout_seconds)
                    except subprocess.TimeoutExpired:
                        timed_out = True
                        _signal_process_group(process.pid, signal.SIGTERM)
                        try:
                            process.wait(timeout=self.term_grace_seconds)
                        except subprocess.TimeoutExpired:
                            _signal_process_group(process.pid, signal.SIGKILL)
                            process.wait()
                finally:
                    if process.poll() is None:
                        _signal_process_group(process.pid, signal.SIGKILL)
                        process.wait()
                    _signal_process_group(process.pid, signal.SIGKILL)
                    _wait_for_process_group_exit(
                        process.pid,
                        timeout_seconds=self.term_grace_seconds,
                    )

                if timed_out:
                    return ChildResourceFailure("Time")
                oom_kills_after = self.cgroup.oom_kill_count()
                if oom_kills_after > oom_kills_before:
                    return ChildResourceFailure("Memory")
                if process.returncode != 0:
                    return ChildInterrupted(
                        f"Background child exited unexpectedly with code {process.returncode}."
                    )

                result_file.seek(0, os.SEEK_END)
                result_size = result_file.tell()
                if result_size > self.result_max_bytes:
                    return ChildDefect(
                        error_type="ResultTooLarge",
                        message="Background child result exceeded its closed protocol limit.",
                    )
                result_file.seek(0)
                encoded = result_file.read(self.result_max_bytes + 1)
                try:
                    return _decode_result(encoded)
                except BackgroundProcessProtocolDefect as exc:
                    return ChildDefect(error_type=type(exc).__name__, message=str(exc))
        finally:
            if cleanup_directory is not None:
                _remove_exact_parser_attempt_directory(cleanup_directory)

    def prune_stale_parser_temp(
        self,
        root: Path,
        *,
        worker_id: str,
        wall_timeout_seconds: float = 60.0,
    ) -> int:
        """Run storage-heavy startup cleanup outside the lean supervisor."""
        result = self.execute(
            handler_path="nexus.jobs.process_executor:_prune_stale_parser_temp",
            payload={"root": str(root)},
            context=JobExecutionContext(
                job_id=UUID(int=0),
                worker_id=worker_id,
                attempt_no=0,
                resource_class="Light",
            ),
            wall_timeout_seconds=wall_timeout_seconds,
            runtime="Base",
            child_exit_cleanup="None",
        )
        if not isinstance(result, ChildSucceeded):
            raise BackgroundProcessProtocolDefect(
                f"background parser-temp startup cleanup failed: {type(result).__name__}"
            )
        removed = result.payload.get("removed_directories")
        if type(removed) is not int or removed < 0:
            raise BackgroundProcessProtocolDefect(
                "background parser-temp startup cleanup returned an invalid count"
            )
        return removed


def _encode_request(
    *,
    handler_path: str,
    payload: Mapping[str, Any],
    context: JobExecutionContext,
    oom_score_adj: int,
    result_max_bytes: int,
    runtime: Literal["Base", "Llm"],
) -> bytes:
    value = {
        "version": _PROTOCOL_VERSION,
        "handler_path": handler_path,
        "payload": dict(payload),
        "context": {
            "job_id": str(context.job_id),
            "worker_id": context.worker_id,
            "attempt_no": context.attempt_no,
            "resource_class": context.resource_class,
        },
        "oom_score_adj": oom_score_adj,
        "result_max_bytes": result_max_bytes,
        "runtime": runtime,
    }
    try:
        return json.dumps(
            value,
            allow_nan=False,
            ensure_ascii=True,
            separators=(",", ":"),
        ).encode("utf-8")
    except (TypeError, ValueError) as exc:
        raise BackgroundProcessProtocolDefect("background child input is not JSON") from exc


def _decode_result(encoded: bytes) -> ChildExecutionResult:
    value = _decode_json_object(encoded, boundary="result")
    _require_protocol_version(value)
    kind = value.get("kind")
    if not isinstance(kind, str) or kind not in _RESULT_KEYS:
        raise BackgroundProcessProtocolDefect("background child returned an unknown result kind")
    if value.keys() != _RESULT_KEYS[kind]:
        raise BackgroundProcessProtocolDefect(f"background child returned an invalid {kind} shape")

    if kind == "Succeeded":
        payload = value["payload"]
        if not isinstance(payload, dict) or not all(isinstance(key, str) for key in payload):
            raise BackgroundProcessProtocolDefect(
                "background child success payload must be an object"
            )
        return ChildSucceeded(dict(payload))
    if kind == "Reschedule":
        available_at = value["available_at"]
        delay_seconds = value["delay_seconds"]
        if (available_at is None) == (delay_seconds is None):
            raise BackgroundProcessProtocolDefect(
                "background child reschedule requires exactly one schedule form"
            )
        parsed_available_at: datetime | None = None
        if available_at is not None:
            if not isinstance(available_at, str):
                raise BackgroundProcessProtocolDefect(
                    "background child absolute reschedule time must be a string"
                )
            try:
                parsed_available_at = datetime.fromisoformat(available_at)
            except ValueError as exc:
                raise BackgroundProcessProtocolDefect(
                    "background child absolute reschedule time is malformed"
                ) from exc
            if parsed_available_at.tzinfo is None:
                raise BackgroundProcessProtocolDefect(
                    "background child absolute reschedule time must include an offset"
                )
        if delay_seconds is not None and (type(delay_seconds) is not int or delay_seconds < 0):
            raise BackgroundProcessProtocolDefect(
                "background child relative reschedule delay must be a non-negative integer"
            )
        return ChildReschedule(
            available_at=parsed_available_at,
            delay_seconds=cast(int | None, delay_seconds),
            payload=_decode_payload_presence(value["payload"]),
        )
    if kind == "ModeledFailure":
        error_code = value["error_code"]
        message = value["message"]
        if not isinstance(error_code, str) or not error_code or not isinstance(message, str):
            raise BackgroundProcessProtocolDefect(
                "background child modeled failure fields are malformed"
            )
        return ChildModeledFailure(
            error_code=error_code,
            message=message,
            resource_dimension=_decode_resource_dimension_presence(value["resource_dimension"]),
        )
    error_type = value["error_type"]
    message = value["message"]
    if not isinstance(error_type, str) or not error_type or not isinstance(message, str):
        raise BackgroundProcessProtocolDefect("background child defect fields are malformed")
    return ChildDefect(error_type=error_type, message=message)


def _decode_payload_presence(value: object) -> Mapping[str, Any] | None:
    presence = _require_presence(value)
    if presence["kind"] == "Absent":
        return None
    payload = presence["value"]
    if not isinstance(payload, dict) or not all(isinstance(key, str) for key in payload):
        raise BackgroundProcessProtocolDefect("reschedule payload must be an object")
    return dict(payload)


def _decode_resource_dimension_presence(value: object) -> ResourceFailureDimension | None:
    presence = _require_presence(value)
    if presence["kind"] == "Absent":
        return None
    dimension = presence["value"]
    if not isinstance(dimension, str) or dimension not in _RESOURCE_DIMENSIONS:
        raise BackgroundProcessProtocolDefect("resource failure dimension is unsupported")
    return cast(ResourceFailureDimension, dimension)


def _require_presence(value: object) -> dict[str, object]:
    if not isinstance(value, dict):
        raise BackgroundProcessProtocolDefect("protocol presence value must be an object")
    if value.get("kind") == "Absent" and value.keys() == _PRESENCE_ABSENT_KEYS:
        return value
    if value.get("kind") == "Present" and value.keys() == _PRESENCE_PRESENT_KEYS:
        return value
    raise BackgroundProcessProtocolDefect("protocol presence value has an invalid shape")


def _child_result(request: dict[str, object]) -> dict[str, object]:
    from nexus.jobs.registry import resolve_job_handler

    _raise_oom_score_adj(_require_int(request["oom_score_adj"], label="oom_score_adj"))
    runtime = request["runtime"]
    if runtime not in ("Base", "Llm"):
        raise BackgroundProcessProtocolDefect("background child runtime is unsupported")
    _initialize_child_runtime(cast(Literal["Base", "Llm"], runtime))
    handler_path = request["handler_path"]
    payload = request["payload"]
    context_value = request["context"]
    if not isinstance(handler_path, str) or not handler_path:
        raise BackgroundProcessProtocolDefect("background child handler path is malformed")
    if not isinstance(payload, dict) or not all(isinstance(key, str) for key in payload):
        raise BackgroundProcessProtocolDefect("background child payload must be an object")
    if not isinstance(context_value, dict) or context_value.keys() != _CONTEXT_KEYS:
        raise BackgroundProcessProtocolDefect("background child context has an invalid shape")
    resource_class = context_value["resource_class"]
    if resource_class not in ("Light", "Heavy"):
        raise BackgroundProcessProtocolDefect("background child resource class is unsupported")
    context = JobExecutionContext(
        job_id=UUID(_require_str(context_value["job_id"], label="job_id")),
        worker_id=_require_str(context_value["worker_id"], label="worker_id"),
        attempt_no=_require_int(context_value["attempt_no"], label="attempt_no"),
        resource_class=cast(Literal["Light", "Heavy"], resource_class),
    )
    handler = resolve_job_handler(handler_path)
    try:
        result = handler(payload=payload, context=context)
    except Exception as exc:
        traceback.print_exc()
        modeled = _modeled_failure(exc)
        if modeled is not None:
            return modeled
        return {
            "version": _PROTOCOL_VERSION,
            "kind": "Defect",
            "error_type": type(exc).__name__,
            "message": str(exc)[:3000],
        }
    return _encode_handler_result(result)


def _encode_handler_result(
    result: Mapping[str, Any] | RescheduleRequested | None,
) -> dict[str, object]:
    if isinstance(result, RescheduleRequested):
        return {
            "version": _PROTOCOL_VERSION,
            "kind": "Reschedule",
            "available_at": (
                result.available_at.isoformat() if result.available_at is not None else None
            ),
            "delay_seconds": result.delay_seconds,
            "payload": (
                {"kind": "Absent"}
                if result.payload is None
                else {"kind": "Present", "value": dict(result.payload)}
            ),
        }
    if result is None:
        payload_result: dict[str, Any] = {}
    elif isinstance(result, Mapping):
        payload_result = dict(result)
    else:
        return {
            "version": _PROTOCOL_VERSION,
            "kind": "Defect",
            "error_type": "InvalidHandlerResult",
            "message": "Background job handler returned a non-object result.",
        }
    return {"version": _PROTOCOL_VERSION, "kind": "Succeeded", "payload": payload_result}


def _prune_stale_parser_temp(
    *, payload: Mapping[str, Any], context: JobExecutionContext
) -> Mapping[str, Any]:
    """Clean abandoned parser directories in a short-lived bounded child."""
    del context
    root = payload.get("root")
    if not isinstance(root, str) or not Path(root).is_absolute():
        raise BackgroundProcessProtocolDefect("parser-temp cleanup root is malformed")

    from nexus.db.session import get_session_factory
    from nexus.jobs.queue import parser_operation_has_live_job
    from nexus.services.parser_temp import prune_stale_parser_temp

    with get_session_factory()() as db:
        removed = prune_stale_parser_temp(
            Path(root),
            operation_is_live=lambda operation_id: parser_operation_has_live_job(
                db, operation_id=operation_id
            ),
        )
    return {"removed_directories": removed}


def _initialize_child_runtime(runtime: Literal["Base", "Llm"]) -> None:
    """Install dependencies that background handlers previously inherited."""
    if runtime == "Base":
        return
    from nexus.config import get_settings
    from nexus.db.session import get_session_factory
    from nexus.services.llm_profiles import validate_profiles
    from nexus.services.rate_limit import RateLimiter, set_rate_limiter

    settings = get_settings()
    validate_profiles()
    set_rate_limiter(
        RateLimiter(
            session_factory=get_session_factory(),
            rpm_limit=settings.rate_limit_rpm,
            concurrent_limit=settings.rate_limit_concurrent,
        )
    )


def _modeled_failure(exc: Exception) -> dict[str, object] | None:
    candidate = getattr(exc, "error_code", getattr(exc, "code", None))
    if candidate is None:
        return None
    value = getattr(candidate, "value", candidate)
    error_code = str(value)
    if not error_code:
        return None
    message_value = getattr(exc, "message", str(exc))
    resource_dimension = getattr(exc, "resource_dimension", None)
    if resource_dimension is None:
        dimension_presence: dict[str, object] = {"kind": "Absent"}
    elif isinstance(resource_dimension, str) and resource_dimension in _RESOURCE_DIMENSIONS:
        dimension_presence = {"kind": "Present", "value": resource_dimension}
    else:
        return {
            "version": _PROTOCOL_VERSION,
            "kind": "Defect",
            "error_type": "InvalidResourceFailureDimension",
            "message": "Modeled resource failure declared an unsupported dimension.",
        }
    return {
        "version": _PROTOCOL_VERSION,
        "kind": "ModeledFailure",
        "error_code": error_code,
        "message": str(message_value)[:3000],
        "resource_dimension": dimension_presence,
    }


def _run_child(result_fd: int) -> int:
    result_max_bytes = 1024
    try:
        encoded = sys.stdin.buffer.read()
        request = _decode_json_object(encoded, boundary="input")
        _require_protocol_version(request)
        if request.keys() != _INPUT_KEYS:
            raise BackgroundProcessProtocolDefect("background child input has an invalid shape")
        requested_result_max_bytes = _require_int(
            request["result_max_bytes"], label="result_max_bytes"
        )
        if not 1024 <= requested_result_max_bytes <= _RESULT_MAX_BYTES:
            raise BackgroundProcessProtocolDefect(
                "background child result limit must be between 1024 and 4194304 bytes"
            )
        result_max_bytes = requested_result_max_bytes
        result = _child_result(request)
        result_bytes = _bounded_result_bytes(result, result_max_bytes=result_max_bytes)
    except Exception as exc:
        traceback.print_exc()
        result_bytes = _bounded_result_bytes(
            {
                "version": _PROTOCOL_VERSION,
                "kind": "Defect",
                "error_type": type(exc).__name__,
                "message": str(exc)[:3000],
            },
            result_max_bytes=result_max_bytes,
        )
    try:
        _write_all(result_fd, result_bytes)
    finally:
        os.close(result_fd)
    return 0


def _bounded_result_bytes(result: Mapping[str, object], *, result_max_bytes: int) -> bytes:
    try:
        encoded = json.dumps(
            result,
            allow_nan=False,
            ensure_ascii=True,
            separators=(",", ":"),
        ).encode("utf-8")
    except (TypeError, ValueError):
        encoded = b""
        error_type = "ResultSerializationDefect"
        message = "Background job result was not JSON serializable."
    else:
        if len(encoded) <= result_max_bytes:
            return encoded
        error_type = "ResultTooLarge"
        message = "Background child result exceeded its closed protocol limit."
    defect = json.dumps(
        {
            "version": _PROTOCOL_VERSION,
            "kind": "Defect",
            "error_type": error_type,
            "message": message,
        },
        ensure_ascii=True,
        allow_nan=False,
        separators=(",", ":"),
    ).encode("utf-8")
    if len(defect) > result_max_bytes:
        raise BackgroundProcessProtocolDefect("background child result limit is too small")
    return defect


def _decode_json_object(encoded: bytes, *, boundary: str) -> dict[str, object]:
    try:
        value = json.loads(
            encoded.decode("utf-8"),
            object_pairs_hook=_unique_object,
            parse_constant=_reject_json_constant,
        )
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise BackgroundProcessProtocolDefect(
            f"background child {boundary} is malformed JSON"
        ) from exc
    if not isinstance(value, dict):
        raise BackgroundProcessProtocolDefect(f"background child {boundary} must be an object")
    return value


def _unique_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
    value: dict[str, object] = {}
    for key, item in pairs:
        if key in value:
            raise BackgroundProcessProtocolDefect("background child JSON contains a duplicate key")
        value[key] = item
    return value


def _reject_json_constant(_value: str) -> None:
    raise BackgroundProcessProtocolDefect("background child JSON contains a non-JSON constant")


def _require_protocol_version(value: Mapping[str, object]) -> None:
    if type(value.get("version")) is not int or value["version"] != _PROTOCOL_VERSION:
        raise BackgroundProcessProtocolDefect("background child protocol version is unsupported")


def _require_str(value: object, *, label: str) -> str:
    if not isinstance(value, str) or not value:
        raise BackgroundProcessProtocolDefect(f"background child {label} is malformed")
    return value


def _require_int(value: object, *, label: str) -> int:
    if type(value) is not int:
        raise BackgroundProcessProtocolDefect(f"background child {label} is malformed")
    return value


def _raise_oom_score_adj(configured: int) -> None:
    path = Path("/proc/self/oom_score_adj")
    try:
        current = int(path.read_text(encoding="ascii").strip())
        target = max(current, configured)
        path.write_text(f"{target}\n", encoding="ascii")
        observed = int(path.read_text(encoding="ascii").strip())
    except (OSError, ValueError) as exc:
        raise BackgroundProcessProtocolDefect("child oom_score_adj could not be raised") from exc
    if observed < target:
        raise BackgroundProcessProtocolDefect(
            "child oom_score_adj did not reach its configured value"
        )


def _read_oom_kill_count(path: Path) -> int:
    try:
        pairs = [line.split() for line in path.read_text(encoding="ascii").splitlines()]
        if any(len(pair) != 2 for pair in pairs):
            raise ValueError("memory event row has an invalid shape")
        values = {pair[0]: int(pair[1]) for pair in pairs}
    except (OSError, ValueError) as exc:
        raise BackgroundProcessProtocolDefect(
            "background cgroup memory.events is malformed"
        ) from exc
    if len(values) != len(pairs) or "oom_kill" not in values or values["oom_kill"] < 0:
        raise BackgroundProcessProtocolDefect("background cgroup memory.events is malformed")
    return values["oom_kill"]


def _child_exit_cleanup_directory(
    *,
    parser_temp_root: Path,
    payload: Mapping[str, Any],
    cleanup: Literal["None", "SourceAttemptParserTemp"],
) -> Path | None:
    if cleanup == "None":
        return None
    if cleanup != "SourceAttemptParserTemp":
        raise BackgroundProcessProtocolDefect("background child cleanup projection is unsupported")
    try:
        attempt_id = UUID(str(payload["attempt_id"]))
    except (KeyError, TypeError, ValueError) as exc:
        raise BackgroundProcessProtocolDefect(
            "source parser cleanup attempt identity is malformed"
        ) from exc
    return parser_temp_root / str(attempt_id)


def _remove_exact_parser_attempt_directory(directory: Path) -> None:
    try:
        if directory.is_symlink() or not directory.is_dir():
            directory.unlink(missing_ok=True)
            return
        shutil.rmtree(directory)
    except FileNotFoundError:
        pass


def _wait_for_process_group_exit(process_group_id: int, *, timeout_seconds: float) -> None:
    deadline = time.monotonic() + timeout_seconds
    while True:
        try:
            os.killpg(process_group_id, 0)
        except ProcessLookupError:
            return
        if time.monotonic() >= deadline:
            raise BackgroundProcessProtocolDefect(
                "background child process group did not exit after SIGKILL"
            )
        time.sleep(0.01)


def _signal_process_group(process_group_id: int, signal_number: signal.Signals) -> None:
    try:
        os.killpg(process_group_id, signal_number)
    except ProcessLookupError:
        pass


def _write_all(file_descriptor: int, payload: bytes) -> None:
    written = 0
    while written < len(payload):
        count = os.write(file_descriptor, payload[written:])
        if count <= 0:
            raise BackgroundProcessProtocolDefect("background child result channel closed early")
        written += count


def _main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--child-result-fd", type=int, required=True)
    arguments = parser.parse_args()
    return _run_child(arguments.child_result_fd)


if __name__ == "__main__":
    raise SystemExit(_main())
