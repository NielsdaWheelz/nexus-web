"""Validate and seal redacted Codex operation-certification observations.

The E/D-owned integration runner is the sole observation producer: it creates
the dedicated synthetic user, dispatches each real domain operation, performs
one reversible chat write and undo, and tears the user down. This command owns
only the strict handoff and immutable evidence. It deliberately contains no
fixture dispatch, direct-provider fallback, or operation implementation.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import stat
from datetime import UTC, datetime
from pathlib import Path
from typing import Annotated, Literal, Self
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator

from nexus.services import generation_policy

_EVIDENCE_SCHEMA = "nexus-codex-operation-certification.v1"
_MAX_OBSERVATIONS_BYTES = 256 * 1024
_MAX_EVIDENCE_BYTES = 64 * 1024
_MAX_CERTIFICATION_SECONDS = 3 * 60 * 60
_CHAT_WRITE_TOOL = "nexus.note.create"
_FORBIDDEN_KEYS = frozenset(
    {
        "authorization",
        "credential",
        "diagnostics",
        "final_text",
        "grant",
        "input",
        "instructions",
        "model_output",
        "output",
        "prompt",
        "raw_event",
        "raw_frame",
        "session_ref",
        "token",
    }
)

BoundedText = Annotated[str, StringConstraints(min_length=1, max_length=128)]
Sha = Annotated[str, StringConstraints(pattern=r"^[0-9a-f]{40}$")]


class _Closed(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class UsageObservation(_Closed):
    input_tokens: int = Field(ge=0)
    output_tokens: int = Field(ge=0)
    total_tokens: int = Field(ge=0)

    @model_validator(mode="after")
    def _total_is_exact(self) -> Self:
        if self.total_tokens != self.input_tokens + self.output_tokens:
            raise ValueError("usage total must equal input plus output")
        return self


class OperationObservation(_Closed):
    operation: BoundedText
    fixture_id: BoundedText
    generation_id: UUID
    operation_revision: BoundedText
    plan_id: generation_policy.PlanId
    plan_revision: BoundedText
    model_name: BoundedText
    reasoning_effort: BoundedText
    capability: Literal["Synthesis"]
    terminal_status: Literal["succeeded"]
    failure_code: None
    semantic_output_valid: Literal[True]
    usage: UsageObservation
    sdk_version: BoundedText
    runtime_version: BoundedText
    tool_event_count: Literal[0]
    permission_event_count: Literal[0]
    elapsed_ms: int = Field(ge=0)


class ChatWriteUndoObservation(_Closed):
    operation: Literal["chat"]
    profile: Literal["balanced"]
    fixture_id: Literal["synthetic:chat-write-undo:v1"]
    run_id: UUID
    generation_id: UUID
    operation_revision: BoundedText
    plan_id: generation_policy.PlanId
    plan_revision: BoundedText
    model_name: BoundedText
    reasoning_effort: BoundedText
    capability: Literal["ChatTools"]
    terminal_status: Literal["succeeded"]
    failure_code: None
    usage: UsageObservation
    sdk_version: BoundedText
    runtime_version: BoundedText
    permission_event_count: Literal[0]
    tool_event_count: int = Field(ge=2, le=64)
    tool_id: Literal["nexus.note.create"]
    tool_call_id: BoundedText
    write_completed: Literal[True]
    undo_completed: Literal[True]
    effect_absent_after_undo: Literal[True]
    elapsed_ms: int = Field(ge=0)


class TeardownObservation(_Closed):
    synthetic_user_id: UUID
    user_deleted: Literal[True]
    residual_rows: Literal[0]
    completed_at: datetime


class CertificationObservations(_Closed):
    schema_version: Literal["nexus-codex-operation-certification-observations.v1"]
    producer: Literal["nexus-operation-certification-runner"]
    producer_revision: BoundedText
    source_sha: Sha
    policy_revision: BoundedText
    started_at: datetime
    completed_at: datetime
    operations: tuple[OperationObservation, ...]
    chat_write_undo: ChatWriteUndoObservation
    teardown: TeardownObservation

    @model_validator(mode="after")
    def _exact_portfolio(self) -> Self:
        expected_operations = tuple(generation_policy.OPERATIONS)
        observed_operations = tuple(item.operation for item in self.operations)
        if observed_operations != expected_operations:
            raise ValueError("operation observations must match canonical policy order exactly")
        if self.policy_revision != generation_policy.POLICY_REVISION:
            raise ValueError("certification policy revision differs from the candidate")
        for item in self.operations:
            policy = generation_policy.operation_policy(item.operation)
            if (
                item.fixture_id != f"synthetic:{item.operation}:v1"
                or item.operation_revision != policy.revision
                or item.plan_id != policy.plan_id
                or item.plan_revision != generation_policy.POLICY_REVISION
                or item.model_name != policy.model
                or item.reasoning_effort != policy.effort
                or item.capability != policy.capability
                or item.elapsed_ms > policy.transport_deadline_seconds * 1_000
            ):
                raise ValueError(f"{item.operation} certification facts differ from policy")

        chat = self.chat_write_undo
        chat_policy = generation_policy.chat_policy(chat.profile)
        if (
            chat.operation_revision != chat_policy.revision
            or chat.plan_id != chat_policy.plan_id
            or chat.plan_revision != generation_policy.POLICY_REVISION
            or chat.model_name != chat_policy.model
            or chat.reasoning_effort != chat_policy.effort
            or chat.capability != chat_policy.capability
            or chat.tool_id != _CHAT_WRITE_TOOL
            or chat.elapsed_ms > chat_policy.transport_deadline_seconds * 1_000
        ):
            raise ValueError("chat write/undo certification facts differ from policy")

        started = _utc(self.started_at)
        completed = _utc(self.completed_at)
        teardown_completed = _utc(self.teardown.completed_at)
        if completed < started or teardown_completed != completed:
            raise ValueError("certification timestamps are not ordered")
        if (completed - started).total_seconds() > _MAX_CERTIFICATION_SECONDS:
            raise ValueError("certification exceeded its wall-time bound")
        return self


def _utc(value: datetime) -> datetime:
    if value.tzinfo is None or value.utcoffset() is None:
        raise ValueError("certification timestamps must be timezone-aware")
    return value.astimezone(UTC)


def _reject_duplicate_keys(pairs: list[tuple[str, object]]) -> dict[str, object]:
    value: dict[str, object] = {}
    for key, item in pairs:
        if key in value:
            raise ValueError(f"duplicate JSON key {key!r}")
        value[key] = item
    return value


def _reject_sensitive_keys(value: object) -> None:
    if isinstance(value, dict):
        for key, item in value.items():
            if key.lower() in _FORBIDDEN_KEYS:
                raise ValueError(f"certification observations contain forbidden field {key!r}")
            _reject_sensitive_keys(item)
    elif isinstance(value, list):
        for item in value:
            _reject_sensitive_keys(item)


def read_observations(path: Path) -> CertificationObservations:
    metadata = path.lstat()
    if not stat.S_ISREG(metadata.st_mode) or path.is_symlink():
        raise ValueError("certification observations must be a regular non-symlink file")
    if metadata.st_size > _MAX_OBSERVATIONS_BYTES:
        raise ValueError("certification observations exceed their byte bound")
    raw = path.read_bytes()
    try:
        value = json.loads(raw, object_pairs_hook=_reject_duplicate_keys)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError("certification observations are not strict JSON") from error
    _reject_sensitive_keys(value)
    return CertificationObservations.model_validate(value)


def build_evidence(observations: CertificationObservations) -> bytes:
    payload = observations.model_dump(mode="json")
    user_id = str(observations.teardown.synthetic_user_id)
    payload["schema_version"] = _EVIDENCE_SCHEMA
    payload["synthetic_user_fingerprint"] = hashlib.sha256(user_id.encode()).hexdigest()
    payload["teardown"] = {
        "user_deleted": True,
        "residual_rows": 0,
        "completed_at": observations.teardown.completed_at.isoformat(),
    }
    encoded = json.dumps(
        payload,
        ensure_ascii=True,
        allow_nan=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode()
    if len(encoded) > _MAX_EVIDENCE_BYTES:
        raise ValueError("certification evidence exceeds its byte bound")
    return encoded + b"\n"


def write_evidence(path: Path, observations: CertificationObservations) -> None:
    if os.geteuid() != 0:
        raise PermissionError("operation certification evidence must be written as root")
    if not path.is_absolute() or path.name != f"{observations.source_sha}.json":
        raise ValueError("evidence path must be absolute and named for the source SHA")
    parent = path.parent
    parent_metadata = parent.lstat()
    if (
        not stat.S_ISDIR(parent_metadata.st_mode)
        or parent.is_symlink()
        or parent.resolve(strict=True) != parent
        or parent_metadata.st_uid != 0
        or parent_metadata.st_gid != 0
        or stat.S_IMODE(parent_metadata.st_mode) != 0o755
    ):
        raise PermissionError("evidence directory must be root-owned mode 0755 without symlinks")
    payload = build_evidence(observations)
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    descriptor = os.open(path, flags, 0o444)
    try:
        with os.fdopen(descriptor, "wb", closefd=True) as evidence:
            evidence.write(payload)
            evidence.flush()
            os.fsync(evidence.fileno())
        os.chown(path, 0, 0)
        path.chmod(0o444)
    except BaseException:
        path.unlink(missing_ok=True)
        raise


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Validate E/D runner observations and seal redacted Codex evidence."
    )
    parser.add_argument("--observations", type=Path, required=True)
    parser.add_argument("--evidence", type=Path, required=True)
    arguments = parser.parse_args()
    observations = read_observations(arguments.observations)
    write_evidence(arguments.evidence, observations)
    print(
        json.dumps(
            {
                "schema_version": "nexus-codex-operation-certification-command.v1",
                "source_sha": observations.source_sha,
                "status": "passed",
                "evidence": str(arguments.evidence),
            },
            ensure_ascii=True,
            separators=(",", ":"),
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()
