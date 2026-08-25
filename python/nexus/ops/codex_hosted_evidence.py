"""Closed validation and staging for the hosted Codex canary artifact."""

from __future__ import annotations

import json
import os
import re
import sys
import tempfile
from pathlib import Path

_MAX_BYTES = 16 * 1024
_MAX_JSON_INTEGER = (1 << 53) - 1
_MAX_PLAN_ELAPSED_MS = 600_000
_RUN_ID = re.compile(r"[0-9a-f]{16}")
_VERSION = re.compile(r"[0-9][A-Za-z0-9.+-]{0,63}")


def codex_hosted_evidence_is_valid(path: Path, *, run_id: str) -> bool:
    """Return whether ``path`` is the exact bounded artifact for ``run_id``."""

    return _validated_evidence_bytes(path, run_id=run_id) is not None


def _validated_evidence_bytes(path: Path, *, run_id: str) -> bytes | None:
    if _RUN_ID.fullmatch(run_id) is None:
        return None
    try:
        with path.open("rb") as handle:
            encoded = handle.read(_MAX_BYTES + 1)
        if len(encoded) > _MAX_BYTES:
            return None
        evidence = json.loads(
            encoded.decode("utf-8"),
            object_pairs_hook=_unique_object,
        )
    # justify-ignore-error: an unreadable (OSError), undecodable
    # (UnicodeDecodeError), or malformed (ValueError, including the
    # duplicate-key hook) artifact is exactly the invalid-evidence outcome
    # this validator exists to report as None.
    except (OSError, UnicodeDecodeError, ValueError):
        return None
    return encoded if _evidence_has_closed_shape(evidence, run_id=run_id) else None


def _evidence_has_closed_shape(evidence: object, *, run_id: str) -> bool:
    if type(evidence) is not dict or set(evidence) != {
        "schema_version",
        "run_id",
        "subscription_turns",
        "results",
    }:
        return False
    results = evidence["results"]
    if (
        evidence.get("schema_version") != "nexus-hosted-codex-canary.v2"
        or evidence.get("run_id") != run_id
        or not _safe_integer(evidence.get("subscription_turns"))
        or evidence["subscription_turns"] != 4
        or type(results) is not list
        or len(results) != 4
        or any(type(item) is not dict for item in results)
    ):
        return False
    plans = {
        ("routine", "gpt-5.6-luna", "low"),
        ("standard", "gpt-5.6-terra", "medium"),
        ("thorough", "gpt-5.6-terra", "high"),
        ("deep", "gpt-5.6-sol", "high"),
    }
    observed: set[tuple[object, object, object]] = set()
    tool_counts: dict[object, int] = {}
    for result in results:
        if set(result) != {
            "plan_id",
            "plan_revision",
            "model",
            "reasoning",
            "backend",
            "transport",
            "auth_profile",
            "terminal_status",
            "structured_output_valid",
            "session_ref_schema_version",
            "usage",
            "sdk_version",
            "runtime_version",
            "tool_events",
            "elapsed_ms",
            "permission_requests",
        }:
            return False
        usage = result.get("usage")
        if (
            result.get("backend") != "codex"
            or result.get("transport") != "sdk"
            or result.get("auth_profile") != "codex-personal"
            or result.get("terminal_status") != "succeeded"
            or type(result.get("structured_output_valid")) is not bool
            or result.get("session_ref_schema_version") != "agent-session-ref.v1"
            or type(result.get("plan_revision")) is not str
            or not result["plan_revision"]
            or type(result.get("sdk_version")) is not str
            or _VERSION.fullmatch(result["sdk_version"]) is None
            or type(result.get("runtime_version")) is not str
            or _VERSION.fullmatch(result["runtime_version"]) is None
            or not _safe_integer(result.get("tool_events"))
            or not _safe_integer(result.get("elapsed_ms"))
            or not 0 < result["elapsed_ms"] <= _MAX_PLAN_ELAPSED_MS
            or not _safe_integer(result.get("permission_requests"))
            or result["permission_requests"] != 0
            or type(usage) is not dict
            or set(usage) != {"input_tokens", "output_tokens", "total_tokens"}
            or any(not _safe_integer(usage.get(key)) for key in usage)
        ):
            return False
        observed.add((result.get("plan_id"), result.get("model"), result.get("reasoning")))
        tool_counts[result.get("plan_id")] = int(result["tool_events"])
    return observed == plans and tool_counts == {
        "routine": 0,
        "standard": 0,
        "thorough": 0,
        "deep": 1,
    }


def _safe_integer(value: object) -> bool:
    return type(value) is int and 0 <= value <= _MAX_JSON_INTEGER


def _unique_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
    value: dict[str, object] = {}
    for key, item in pairs:
        if key in value:
            raise ValueError("duplicate hosted evidence key")
        value[key] = item
    return value


def _stage(source: Path, destination: Path) -> None:
    run_id = source.parent.name
    if _RUN_ID.fullmatch(run_id) is None or not destination.is_file():
        raise ValueError("hosted evidence staging paths are invalid")
    encoded = _validated_evidence_bytes(source, run_id=run_id)
    if encoded is None:
        raise ValueError("hosted evidence is invalid")

    temporary: Path | None = None
    replaced = False
    try:
        with tempfile.NamedTemporaryFile(
            mode="wb",
            prefix=f".{destination.name}.",
            suffix=".partial",
            dir=destination.parent,
            delete=False,
        ) as handle:
            temporary = Path(handle.name)
            handle.write(encoded)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, destination)
        replaced = True
    finally:
        if temporary is not None and not replaced:
            temporary.unlink(missing_ok=True)


def _main() -> int:
    arguments = sys.argv[1:]
    if len(arguments) != 3 or arguments[0] != "stage":
        return 2
    try:
        _stage(Path(arguments[1]), Path(arguments[2]))
    # justify-ignore-error: the CLI contract is a silent nonzero exit; invalid
    # evidence or paths (ValueError) and filesystem failure (OSError) are the
    # only failures staging raises, and both leave the destination untouched.
    except (OSError, ValueError):
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(_main())
