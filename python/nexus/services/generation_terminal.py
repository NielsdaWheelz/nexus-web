"""Product projection of already committed provider truth; no dispatch protocol."""

import json
from typing import Literal, cast

from provider_runtime.agent_runtime import (
    AgentFailure,
    AgentQuotaExhausted,
    AgentTerminal,
    freeze_json_value,
    thaw_json_value,
)
from provider_runtime.types import Present
from pydantic import BaseModel, ConfigDict

from nexus.services.generation_spec import JsonValue


class GenerationFailure(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    kind: str
    stage: str | None = None
    cause_code: str | None = None


class GenerationUsage(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    input_tokens: int
    output_tokens: int
    total_tokens: int
    reasoning_tokens: int | None = None
    cache_read_input_tokens: int | None = None
    cache_write_input_tokens: int | None = None


class GenerationToolUse(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    tool_call_id: str
    name: str
    phase: Literal["started", "updated", "completed"]
    succeeded: bool | None = None


class GenerationTerminal(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    status: Literal["succeeded", "failed", "cancelled"]
    failure: GenerationFailure | None
    final_text: str
    structured_output: JsonValue
    usage: GenerationUsage | None


def project_terminal(terminal: AgentTerminal) -> GenerationTerminal:
    failure = None
    if isinstance(terminal.failure, AgentQuotaExhausted):
        failure = GenerationFailure(kind="quota_exhausted")
    elif isinstance(terminal.failure, AgentFailure):
        failure = GenerationFailure(kind=terminal.failure.cause)
    raw = terminal.raw_structured_output
    if raw is not None:
        output = thaw_json_value(raw.value)
    else:
        try:
            output = thaw_json_value(freeze_json_value(json.loads(terminal.final_text)))
        except ValueError:
            output = None
    usage = None
    if isinstance(terminal.usage, Present):
        value = terminal.usage.value
        usage = GenerationUsage(
            input_tokens=value.input_tokens,
            output_tokens=value.output_tokens,
            total_tokens=value.total_tokens,
            reasoning_tokens=value.reasoning_tokens.value
            if isinstance(value.reasoning_tokens, Present)
            else None,
            cache_read_input_tokens=value.cache_read_input_tokens.value
            if isinstance(value.cache_read_input_tokens, Present)
            else None,
            cache_write_input_tokens=value.cache_write_input_tokens.value
            if isinstance(value.cache_write_input_tokens, Present)
            else None,
        )
    return GenerationTerminal(
        status=terminal.status,
        failure=failure,
        final_text=terminal.final_text,
        structured_output=cast(JsonValue, output),
        usage=usage,
    )


NormalizedFailureCode = Literal[
    "auth",
    "quota",
    "timeout",
    "output_limit",
    "invalid_output",
    "policy_violation",
    "runtime_unavailable",
    "capacity_unavailable",
    "context_too_large",
]


class GenerationContractDefect(RuntimeError):
    """A host/contract defect that must not become a product terminal."""


FAILURE_KIND_TO_NORMALIZED: dict[str, NormalizedFailureCode] = {
    "credential_unavailable": "auth",
    "credential_rejected": "auth",
    "quota_exhausted": "quota",
    "turn_timeout": "timeout",
    "output_limit_exceeded": "output_limit",
    "output_schema_violation": "invalid_output",
    "policy_violation": "policy_violation",
    "approval_unanswered": "policy_violation",
    "executable_unavailable": "runtime_unavailable",
    "transport_unavailable": "runtime_unavailable",
    "session_unavailable": "runtime_unavailable",
    "backend_failed": "runtime_unavailable",
    "capacity_unavailable": "capacity_unavailable",
    "context_admission": "context_too_large",
}


def normalized_failure(kind: str) -> NormalizedFailureCode:
    if kind in {"invalid_request", "runtime_defect"}:
        raise GenerationContractDefect(f"{kind} is a host defect")
    try:
        return FAILURE_KIND_TO_NORMALIZED[kind]
    except KeyError as error:
        raise GenerationContractDefect(f"unknown host failure kind {kind!r}") from error


def retained_terminal_error_detail(terminal: GenerationTerminal) -> str | None:
    """Derive the durable detail from the terminal's own closed status algebra."""

    if terminal.status == "succeeded":
        return None
    if terminal.status == "cancelled":
        return "codex generation cancelled"
    if terminal.failure is None:
        raise AssertionError("failed generation terminal has no failure kind")
    normalized_failure(terminal.failure.kind)
    detail = f"codex generation failed: {terminal.failure.kind}"
    if terminal.failure.stage is not None:
        detail += f"; stage={terminal.failure.stage}"
    if terminal.failure.cause_code is not None:
        detail += f"; cause={terminal.failure.cause_code}"
    return detail
