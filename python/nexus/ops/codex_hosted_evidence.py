"""Closed validation and staging for the hosted Codex canary artifact."""

from __future__ import annotations

import json
import os
import re
import sys
import tempfile
from pathlib import Path

from nexus.services import generation_policy

_MAX_BYTES = 16 * 1024
_MAX_JSON_INTEGER = (1 << 53) - 1
_MAX_PLAN_ELAPSED_MS = 600_000
_RUN_ID = re.compile(r"[0-9a-f]{16}")
_SOURCE_SHA = re.compile(r"[0-9a-f]{40}")
_QUALIFICATION_SCOPE = "model_effort_runtime_wire"
_QUALIFIED_PLAN_IDS = ["routine", "standard", "thorough", "deep"]
_CASE_FACTS = {
    "routine": ("metadata_enrichment", None, "structured", True, 0),
    "standard": ("dawn_write", None, "text", False, 0),
    "thorough": ("dossier_library", None, "structured", True, 0),
    "deep": ("chat", "deep", "mcp_read", False, 1),
}


def codex_hosted_evidence_is_valid(path: Path, *, run_id: str, source_sha: str) -> bool:
    """Return whether ``path`` is the exact bounded artifact for ``run_id``."""

    return _validated_evidence_bytes(path, run_id=run_id, source_sha=source_sha) is not None


def codex_hosted_readiness_is_valid(path: Path, *, run_id: str) -> bool:
    """Return whether a no-content subscription-readiness result is run-bound."""

    if _RUN_ID.fullmatch(run_id) is None:
        return False
    try:
        with path.open("rb") as handle:
            encoded = handle.read(_MAX_BYTES + 1)
        if len(encoded) > _MAX_BYTES:
            return False
        readiness = json.loads(encoded.decode("utf-8"), object_pairs_hook=_unique_object)
    except (OSError, UnicodeDecodeError, ValueError):
        return False
    return readiness == {
        "schema_version": "nexus-hosted-codex-readiness.v1",
        "run_id": run_id,
        "status": "subscription_unavailable",
    }


def _validated_evidence_bytes(path: Path, *, run_id: str, source_sha: str) -> bytes | None:
    if _RUN_ID.fullmatch(run_id) is None or _SOURCE_SHA.fullmatch(source_sha) is None:
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
    return (
        encoded
        if _evidence_has_closed_shape(evidence, run_id=run_id, source_sha=source_sha)
        else None
    )


def _evidence_has_closed_shape(evidence: object, *, run_id: str, source_sha: str) -> bool:
    if type(evidence) is not dict or set(evidence) != {
        "schema_version",
        "run_id",
        "source_sha",
        "policy_revision",
        "policy_fingerprint",
        "policy_facts_fingerprint",
        "provider_runtime_revision",
        "codex_sdk_version",
        "codex_cli_version",
        "qualification_scope",
        "qualified_plan_ids",
        "subscription_turns",
        "results",
    }:
        return False
    results = evidence["results"]
    if (
        evidence.get("schema_version") != "nexus-hosted-codex-canary.v3"
        or evidence.get("run_id") != run_id
        or evidence.get("source_sha") != source_sha
        or evidence.get("policy_revision") != generation_policy.POLICY_REVISION
        or evidence.get("policy_fingerprint") != generation_policy.POLICY_FINGERPRINT
        or evidence.get("policy_facts_fingerprint") != generation_policy.POLICY_FACTS_FINGERPRINT
        or evidence.get("provider_runtime_revision")
        != generation_policy.PLAN_EVAL_PIN["provider_runtime_revision"]
        or evidence.get("codex_sdk_version") != generation_policy.PLAN_EVAL_PIN["codex_sdk_version"]
        or evidence.get("codex_cli_version") != generation_policy.PLAN_EVAL_PIN["codex_sdk_version"]
        or evidence.get("qualification_scope") != _QUALIFICATION_SCOPE
        or evidence.get("qualified_plan_ids") != _QUALIFIED_PLAN_IDS
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
            "operation",
            "profile",
            "operation_revision",
            "case_shape",
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
            or result.get("sdk_version") != evidence["codex_sdk_version"]
            or result.get("runtime_version") != evidence["codex_cli_version"]
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
        plan_id = result.get("plan_id")
        expected_case = _CASE_FACTS.get(plan_id)
        if expected_case is None:
            return False
        operation, profile, case_shape, structured_output_valid, tool_events = expected_case
        expected_revision = generation_policy.operation_revision(operation, profile=profile)
        if (
            result.get("operation") != operation
            or result.get("profile") != profile
            or result.get("operation_revision") != expected_revision
            or result.get("case_shape") != case_shape
            or result.get("structured_output_valid") is not structured_output_valid
            or result.get("tool_events") != tool_events
        ):
            return False
        observed.add((result.get("plan_id"), result.get("model"), result.get("reasoning")))
        tool_counts[plan_id] = int(result["tool_events"])
    return observed == plans and tool_counts == {
        plan_id: facts[-1] for plan_id, facts in _CASE_FACTS.items()
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


def _stage(source: Path, destination: Path, source_sha: str) -> None:
    run_id = source.parent.name
    if _RUN_ID.fullmatch(run_id) is None or not destination.is_file():
        raise ValueError("hosted evidence staging paths are invalid")
    encoded = _validated_evidence_bytes(source, run_id=run_id, source_sha=source_sha)
    if encoded is None:
        raise ValueError("hosted evidence is invalid")
    _replace_atomically(destination, encoded)


def _replace_atomically(destination: Path, encoded: bytes) -> None:
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


def _stage_readiness(source: Path, destination: Path, github_run_id: str) -> None:
    run_id = source.parent.name
    if _RUN_ID.fullmatch(run_id) is None or not destination.is_file():
        raise ValueError("hosted readiness staging paths are invalid")
    if not re.fullmatch(r"[1-9][0-9]*", github_run_id):
        raise ValueError("GitHub run identity is invalid")
    if not codex_hosted_readiness_is_valid(source, run_id=run_id):
        raise ValueError("hosted subscription readiness is invalid")
    _replace_atomically(
        destination,
        (
            json.dumps(
                {
                    "schema_version": "nexus-hosted-codex-canary-not-run.v1",
                    "github_run_id": int(github_run_id),
                    "status": "subscription_unavailable",
                },
                separators=(",", ":"),
            )
            + "\n"
        ).encode(),
    )


def _gate(destination: Path, canary_outcome: str, source_sha: str) -> None:
    if canary_outcome != "success":
        raise ValueError("hosted canary controller did not succeed")
    try:
        with destination.open("rb") as handle:
            encoded = handle.read(_MAX_BYTES + 1)
        if len(encoded) > _MAX_BYTES:
            raise ValueError("hosted qualification artifact is oversized")
        evidence = json.loads(encoded.decode("utf-8"), object_pairs_hook=_unique_object)
    except (OSError, UnicodeDecodeError, ValueError):
        raise ValueError("hosted qualification artifact is invalid") from None
    if type(evidence) is not dict or not isinstance(evidence.get("run_id"), str):
        raise ValueError("hosted qualification artifact is not a success receipt")
    if (
        _validated_evidence_bytes(
            destination,
            run_id=evidence["run_id"],
            source_sha=source_sha,
        )
        is None
    ):
        raise ValueError("hosted qualification artifact is invalid")


def _main() -> int:
    arguments = sys.argv[1:]
    try:
        if len(arguments) == 4 and arguments[0] == "stage":
            _stage(Path(arguments[1]), Path(arguments[2]), arguments[3])
        elif len(arguments) == 4 and arguments[0] == "stage-readiness":
            _stage_readiness(Path(arguments[1]), Path(arguments[2]), arguments[3])
        elif len(arguments) == 4 and arguments[0] == "gate":
            _gate(Path(arguments[1]), arguments[2], arguments[3])
        else:
            return 2
    # justify-ignore-error: the CLI contract is a silent nonzero exit; invalid
    # evidence or paths (ValueError) and filesystem failure (OSError) are the
    # only failures staging raises, and both leave the destination untouched.
    except (OSError, ValueError):
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(_main())
