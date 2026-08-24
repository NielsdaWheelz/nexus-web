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
        evidence.get("schema_version") != "nexus-hosted-codex-canary.v1"
        or evidence.get("run_id") != run_id
        or not _safe_integer(evidence.get("subscription_turns"))
        or evidence["subscription_turns"] != 1
        or type(results) is not list
        or len(results) != 1
        or type(results[0]) is not dict
    ):
        return False
    result = results[0]
    if set(result) != {
        "backend",
        "transport",
        "auth_profile",
        "model",
        "reasoning",
        "structured_output_valid",
        "session_ref_schema_version",
        "usage",
        "sdk_version",
        "runtime_version",
        "tool_events",
        "permission_requests",
    }:
        return False
    usage = result.get("usage")
    return (
        result.get("backend") == "codex"
        and result.get("transport") == "sdk"
        and result.get("auth_profile") == "codex-personal"
        and result.get("model") == "gpt-5.6-luna"
        and result.get("reasoning") == "low"
        and result.get("structured_output_valid") is True
        and result.get("session_ref_schema_version") == "agent-session-ref.v1"
        and type(result.get("sdk_version")) is str
        and _VERSION.fullmatch(result["sdk_version"]) is not None
        and type(result.get("runtime_version")) is str
        and _VERSION.fullmatch(result["runtime_version"]) is not None
        and _safe_integer(result.get("tool_events"))
        and result["tool_events"] == 0
        and _safe_integer(result.get("permission_requests"))
        and result["permission_requests"] == 0
        and type(usage) is dict
        and set(usage) == {"input_tokens", "output_tokens", "total_tokens"}
        and all(_safe_integer(usage.get(key)) for key in usage)
    )


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
