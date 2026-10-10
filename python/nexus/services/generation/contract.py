"""The generation contract every caller speaks: intent in, one terminal value out.

``generate`` takes an owner, an operation, an intent and a decode, writes one
``llm_calls`` row, and returns ``Succeeded | Failed | Cancelled``. Expected
failures are values with one code from ``FailureCode``, with one exception: a
background generation that never reached its model raises ``RouteUnavailable``
while its job has attempts left, so the queue retries it. Nothing here survives a
process: a dead worker's open row is closed ``interrupted`` by whoever comes next.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import TYPE_CHECKING, Annotated, Literal, Self
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator

from nexus.errors import ApiError, ApiErrorCode
from nexus.schemas.llm import GenerationSelection, SelectionPresentation

if TYPE_CHECKING:
    from provider_runtime.types import TokenUsage
    from sqlalchemy.orm import Session

    from nexus.jobs.queue import JobExecutionContext
    from nexus.services.tool_runtime.chat_projection import ChatToolExecutionProjection

type JsonValue = None | bool | int | float | str | list[JsonValue] | dict[str, JsonValue]
type BackgroundOperation = Literal[
    "metadata_enrichment",
    "media_summary",
    "connection_discovery",
    "oracle",
    "dossier_page",
    "dossier_note",
    "dossier_media",
    "dossier_conversation",
    "dossier_library",
    "dossier_podcast",
    "dossier_contributor",
    "dossier_idea",
]
type Operation = Literal["chat"] | BackgroundOperation
type OwnerKind = Literal[
    "chat_run",
    "oracle_reading",
    "artifact_build",
    "media_summary",
    "connection_discovery_scan",
    "media_enrichment",
]
type FailureCode = Literal[
    "auth",
    "quota",
    "rate_limited",
    "timeout",
    "output_limit",
    "content_filtered",
    "context_too_large",
    "invalid_output",
    "policy_violation",
    "runtime_unavailable",
    "interrupted",
    "defect",
]

_MAX_INSTRUCTIONS_BYTES = 32 * 1024
_MAX_INPUT_BYTES = 1024 * 1024


class TextOutput(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    kind: Literal["Text"] = "Text"


class JsonSchemaOutput(BaseModel):
    model_config = ConfigDict(
        extra="forbid", frozen=True, populate_by_name=True, serialize_by_alias=True
    )

    kind: Literal["JsonSchema"] = "JsonSchema"
    name: str = Field(min_length=1, max_length=128)
    schema_: dict[str, JsonValue] = Field(alias="schema")
    strict: Literal[True] = True

    @model_validator(mode="after")
    def _object_root(self) -> Self:
        if self.schema_.get("type") != "object":
            raise ValueError("strict JsonSchema output must have an object root")
        return self


type GenerationOutput = Annotated[TextOutput | JsonSchemaOutput, Field(discriminator="kind")]


class GenerationIntent(BaseModel):
    """What the model is asked; chat stores it on ``chat_prompt_assemblies``."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    instructions: str
    input: str
    output: GenerationOutput

    @model_validator(mode="after")
    def _bounded(self) -> Self:
        if not self.instructions.strip() or not self.input.strip():
            raise ValueError("generation instructions and input must not be blank")
        if len(self.instructions.encode()) > _MAX_INSTRUCTIONS_BYTES:
            raise ValueError(f"instructions exceed {_MAX_INSTRUCTIONS_BYTES} UTF-8 bytes")
        if len(self.input.encode()) > _MAX_INPUT_BYTES:
            raise ValueError(f"input exceeds {_MAX_INPUT_BYTES} UTF-8 bytes")
        return self


class GenerationSpec(BaseModel):
    """What one generation was admitted with: ``chat_runs`` at send, ``llm_calls`` at open."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    operation: Operation
    selection: GenerationSelection
    display_at_dispatch: SelectionPresentation | None
    tool_plan: str | None
    tool_scope: tuple[str, ...]
    effect_mode: Literal["ReadOnly", "AdditiveWrites"] | None
    context_budget_tokens: int | None
    output_budget_tokens: int | None


class GenerationUsage(BaseModel):
    """Token usage summed over every model turn of one generation."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    input_tokens: int
    output_tokens: int
    total_tokens: int
    reasoning_tokens: int | None = None
    cache_read_input_tokens: int | None = None
    cache_write_input_tokens: int | None = None

    def plus(self, other: GenerationUsage) -> GenerationUsage:
        def add(a: int | None, b: int | None) -> int | None:
            return None if a is None and b is None else (a or 0) + (b or 0)

        return GenerationUsage(
            input_tokens=self.input_tokens + other.input_tokens,
            output_tokens=self.output_tokens + other.output_tokens,
            total_tokens=self.total_tokens + other.total_tokens,
            reasoning_tokens=add(self.reasoning_tokens, other.reasoning_tokens),
            cache_read_input_tokens=add(
                self.cache_read_input_tokens, other.cache_read_input_tokens
            ),
            cache_write_input_tokens=add(
                self.cache_write_input_tokens, other.cache_write_input_tokens
            ),
        )


def usage_of(usage: TokenUsage) -> GenerationUsage:
    """One provider-runtime usage report as nexus usage; both routes report this type."""

    from provider_runtime.types import Present

    def count(value: object) -> int | None:
        return value.value if isinstance(value, Present) else None

    return GenerationUsage(
        input_tokens=usage.input_tokens,
        output_tokens=usage.output_tokens,
        total_tokens=usage.total_tokens,
        reasoning_tokens=count(usage.reasoning_tokens),
        cache_read_input_tokens=count(usage.cache_read_input_tokens),
        cache_write_input_tokens=count(usage.cache_write_input_tokens),
    )


@dataclass(frozen=True, slots=True)
class Owner:
    """The ledger owner, the tool principal and the job attempt that claims the work."""

    kind: OwnerKind
    id: UUID
    user_id: UUID
    job: JobExecutionContext


@dataclass(frozen=True, slots=True)
class Tools:
    """Model tools as data; ``generate`` binds them once its row exists."""

    plan_id: str
    scope_refs: frozenset[str]
    projection: ChatToolExecutionProjection | None = None


@dataclass(frozen=True, slots=True)
class TextDelta:
    text: str


@dataclass(frozen=True, slots=True)
class ToolCalling:
    tool: str


type Event = TextDelta | ToolCalling


class InvalidOutput(ValueError):
    """The one exception a decode may raise: the output broke its contract."""


class RouteUnavailable(ApiError):
    """A background generation never reached its model; its job retries with backoff."""

    def __init__(self, detail: str) -> None:
        super().__init__(ApiErrorCode.E_GENERATION_RUNTIME_UNAVAILABLE, detail)


@dataclass(frozen=True, slots=True)
class Succeeded[T]:
    generation_id: UUID
    value: T
    usage: GenerationUsage | None


@dataclass(frozen=True, slots=True)
class Failed:
    generation_id: UUID
    code: FailureCode
    detail: str
    partial_text: str
    usage: GenerationUsage | None
    rejection: InvalidOutput | None = None


@dataclass(frozen=True, slots=True)
class Cancelled:
    generation_id: UUID
    partial_text: str
    usage: GenerationUsage | None


type Terminal[T] = Succeeded[T] | Failed | Cancelled
type Decode[T] = Callable[[JsonValue], T]
type OnEvent = Callable[[Event], Awaitable[None]]
type Stop = Callable[[Session], bool]


def text(value: JsonValue) -> str:
    """The decode of a Text generation: its final text."""

    if not isinstance(value, str):
        raise AssertionError("a Text generation returned non-text output")
    return value


@dataclass(frozen=True, slots=True)
class RouteResult:
    """What a route adapter hands back; ``evidence`` is route audit, never model text.

    ``sent`` is False only when no request reached the model, so nothing was billed.
    """

    status: Literal["succeeded", "failed", "cancelled"]
    output: JsonValue
    usage: GenerationUsage | None
    code: FailureCode | None
    detail: str
    evidence: dict[str, JsonValue]
    sent: bool = True
