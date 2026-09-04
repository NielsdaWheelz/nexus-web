"""Closed validation and staging for the hosted Codex canary artifact."""

from __future__ import annotations

import json
import os
import re
import sys
import tempfile
from pathlib import Path

_MAX_BYTES = 64 * 1024
_MAX_JSON_INTEGER = (1 << 53) - 1
_MAX_PLAN_ELAPSED_MS = 600_000
_MAX_SUBSCRIPTION_TURNS = 16
_RUN_ID = re.compile(r"[0-9a-f]{16}")
_SOURCE_SHA = re.compile(r"[0-9a-f]{40}")
_SHA256 = re.compile(r"[0-9a-f]{64}")
_QUALIFICATION_SCOPE = "codex_target_capability_set"
_CHAT_PLAN_ID = "ChatReadAdditiveWrite"
_POLICY_REVISION = (
    "generation-policy.v2.0d24533c6d6185d1a1a0d28b654ec8cdfee1fc4f48097b31769bc50e11d4f789"
)
_POLICY_FINGERPRINT = "bba771639692232e1639d554b9ccbcbbdaa081f3e93e88db816feebfb79a08f5"
_BACKEND_CONTRACT_REVISION = "provider-runtime.agent-model-catalog.v1"
_CODEX_SDK_VERSION = "0.144.4"
_CODEX_CLI_VERSION = "0.144.4"

# Artifact staging deliberately has a dependency-free interpreter boundary.
# These source-owned qualification pins are cross-checked against the live
# product owners by a kernel contract; policy/catalog/tool drift therefore
# fails review without making the gate import the application dependency graph.
_TARGET_FACTS: dict[str, tuple[str, tuple[str, ...]]] = {
    "CodexPersonal:gpt-5.3-codex-spark": (
        "5320dbd986c1ad3fc22c83d812b5ca0436cb9e58314e017a9918b5fd1086e1df",
        ("low", "medium", "high", "xhigh"),
    ),
    "CodexPersonal:gpt-5.4": (
        "23ebfda5fc7640322e9972313d3f1579c362e4c98f461da31d8b99b956515adb",
        ("low", "medium", "high", "xhigh"),
    ),
    "CodexPersonal:gpt-5.4-mini": (
        "88da385ac6f0083d1341d43693d833a924592880ad33c4a92e0e2263e713ffe6",
        ("low", "medium", "high", "xhigh"),
    ),
    "CodexPersonal:gpt-5.5": (
        "7310d9a2469e28a290acfe7e384913d4f6861d1cce21dae4e92a72a3030a4fb0",
        ("low", "medium", "high", "xhigh"),
    ),
    "CodexPersonal:gpt-5.6-luna": (
        "9b3458184f127976f3d9b47a3a7860db7142cd66173f05197d63de37a129b7c6",
        ("low", "medium", "high", "xhigh", "max"),
    ),
    "CodexPersonal:gpt-5.6-sol": (
        "03e6ecd4b90f505dfbf91d423721d3f8809acb333ba8d511033383952fc3eed2",
        ("low", "medium", "high", "xhigh", "max", "ultra"),
    ),
    "CodexPersonal:gpt-5.6-terra": (
        "183cd530500586e7c806cb098e719b2bfa495cb1f6322c20536640f107602e4f",
        ("low", "medium", "high", "xhigh", "max", "ultra"),
    ),
}
_TOOL_FACTS: dict[str, tuple[str, int]] = {
    "ChatReadAdditiveWrite": (
        "3fc34933d27eeb7518984e1274a3be5001902dfb8d4a3669bc83160302d2ceff",
        11,
    ),
    "IdeaDossierRead": (
        "35ae7ab9ab1b2da96b3c7809b93c1cce8122e9a4eb7ef146d14aec0b2ca34d8b",
        5,
    ),
    "LibraryDossierRead": (
        "b6b91ec256ef4113aee8aff329affdfeff08f855eb71cbcce6bf05d1bed93902",
        5,
    ),
}
_BACKGROUND_CASES = {
    "dossier_library": (
        "CodexPersonal:gpt-5.6-terra",
        "high",
        "LibraryDossierRead",
        ["strict-structured", "tools-continuation"],
    ),
    "dossier_idea": (
        "CodexPersonal:gpt-5.6-terra",
        "high",
        "IdeaDossierRead",
        ["strict-structured", "tools-continuation"],
    ),
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
        "catalog_definition_revision",
        "backend_contract_revision",
        "codex_sdk_version",
        "codex_cli_version",
        "qualification_scope",
        "target_set",
        "tool_authority_revisions",
        "subscription_turns",
        "results",
    }:
        return False
    results = evidence["results"]
    expected_targets = _expected_codex_targets()
    expected_tools = _expected_tool_revisions()
    if (
        evidence.get("schema_version") != "nexus-hosted-codex-canary.v4"
        or evidence.get("run_id") != run_id
        or evidence.get("source_sha") != source_sha
        or evidence.get("policy_revision") != _POLICY_REVISION
        or evidence.get("policy_fingerprint") != _POLICY_FINGERPRINT
        or not isinstance(evidence.get("catalog_definition_revision"), str)
        or _SHA256.fullmatch(evidence["catalog_definition_revision"]) is None
        or evidence.get("backend_contract_revision") != _BACKEND_CONTRACT_REVISION
        or evidence.get("codex_sdk_version") != _CODEX_SDK_VERSION
        or evidence.get("codex_cli_version") != _CODEX_CLI_VERSION
        or evidence.get("qualification_scope") != _QUALIFICATION_SCOPE
        or evidence.get("tool_authority_revisions") != expected_tools
        or not _safe_integer(evidence.get("subscription_turns"))
        or type(results) is not list
        or evidence["subscription_turns"] != len(results)
        or not 0 < len(results) <= _MAX_SUBSCRIPTION_TURNS
        or len(results) != len(expected_targets) + len(_BACKGROUND_CASES)
        or any(type(item) is not dict for item in results)
    ):
        return False

    target_rows = evidence.get("target_set")
    if not isinstance(target_rows, list) or len(target_rows) != len(expected_targets):
        return False
    reasoning_by_target: dict[str, tuple[str, ...]] = {}
    observed_target_order: list[str] = []
    for row in target_rows:
        if type(row) is not dict or set(row) != {
            "target_key",
            "source_row_fingerprint",
            "reasoning",
        }:
            return False
        target_key = row.get("target_key")
        reasoning = row.get("reasoning")
        if (
            not isinstance(target_key, str)
            or target_key not in expected_targets
            or row.get("source_row_fingerprint") != expected_targets[target_key][0]
            or not isinstance(reasoning, list)
            or tuple(reasoning) != expected_targets[target_key][1]
        ):
            return False
        observed_target_order.append(target_key)
        reasoning_by_target[target_key] = tuple(reasoning)
    if observed_target_order != sorted(expected_targets):
        return False

    observed_chat: set[str] = set()
    observed_background: set[str] = set()
    for result in results:
        if set(result) != {
            "receipt_kind",
            "target_key",
            "source_row_fingerprint",
            "operation",
            "reasoning",
            "capability_classes",
            "tool_plan_id",
            "tool_authority_revision",
            "terminal_status",
            "structured_output_valid",
            "usage_present",
            "sdk_version",
            "runtime_version",
            "declared_tool_count",
            "tool_events",
            "elapsed_ms",
            "permission_requests",
        }:
            return False
        target_key = result.get("target_key")
        reasoning = result.get("reasoning")
        plan_id = result.get("tool_plan_id")
        if (
            not isinstance(target_key, str)
            or target_key not in expected_targets
            or result.get("source_row_fingerprint") != expected_targets[target_key][0]
            or not isinstance(reasoning, str)
            or reasoning not in reasoning_by_target[target_key]
            or not isinstance(plan_id, str)
            or plan_id not in expected_tools
            or result.get("tool_authority_revision") != expected_tools[plan_id]
            or result.get("terminal_status") != "succeeded"
            or type(result.get("structured_output_valid")) is not bool
            or result.get("usage_present") is not True
            or result.get("sdk_version") != evidence["codex_sdk_version"]
            or result.get("runtime_version") != evidence["codex_cli_version"]
            or result.get("declared_tool_count") != _TOOL_FACTS[plan_id][1]
            or not _safe_integer(result.get("tool_events"))
            or result.get("tool_events") != 1
            or not _safe_integer(result.get("elapsed_ms"))
            or not 0 < result["elapsed_ms"] <= _MAX_PLAN_ELAPSED_MS
            or not _safe_integer(result.get("permission_requests"))
            or result["permission_requests"] != 0
        ):
            return False
        if result.get("receipt_kind") == "chat_target":
            if (
                result.get("operation") != "chat"
                or result.get("capability_classes") != ["text", "tools-continuation"]
                or plan_id != _CHAT_PLAN_ID
                or result.get("structured_output_valid") is not False
                or target_key in observed_chat
            ):
                return False
            observed_chat.add(target_key)
            continue
        if result.get("receipt_kind") != "background":
            return False
        operation = result.get("operation")
        if not isinstance(operation, str) or operation not in _BACKGROUND_CASES:
            return False
        expected_target, expected_reasoning, expected_plan, expected_classes = _BACKGROUND_CASES[
            operation
        ]
        if (
            target_key != expected_target
            or reasoning != expected_reasoning
            or plan_id != expected_plan
            or result.get("capability_classes") != expected_classes
            or result.get("structured_output_valid") is not True
            or operation in observed_background
        ):
            return False
        observed_background.add(operation)
    return observed_chat == set(expected_targets) and observed_background == set(_BACKGROUND_CASES)


def _expected_codex_targets() -> dict[str, tuple[str, tuple[str, ...]]]:
    return dict(_TARGET_FACTS)


def _expected_tool_revisions() -> dict[str, str]:
    return {plan_id: facts[0] for plan_id, facts in _TOOL_FACTS.items()}


def codex_hosted_contract_facts() -> dict[str, object]:
    """Return a copy of the dependency-free pins for source-owner verification."""

    return {
        "policy_revision": _POLICY_REVISION,
        "policy_fingerprint": _POLICY_FINGERPRINT,
        "backend_contract_revision": _BACKEND_CONTRACT_REVISION,
        "codex_sdk_version": _CODEX_SDK_VERSION,
        "codex_cli_version": _CODEX_CLI_VERSION,
        "targets": {
            key: {"source_row_fingerprint": facts[0], "reasoning": list(facts[1])}
            for key, facts in _TARGET_FACTS.items()
        },
        "tools": {
            key: {"authority_revision": facts[0], "declared_tool_count": facts[1]}
            for key, facts in _TOOL_FACTS.items()
        },
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
