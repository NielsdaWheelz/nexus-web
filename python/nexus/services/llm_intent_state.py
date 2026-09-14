"""Durable, JSON-safe state for product-owned generation intents."""

from __future__ import annotations

import math
from collections.abc import Mapping, Sequence
from typing import Annotated, Literal, cast

from provider_runtime import (
    Absent as RuntimeAbsent,
)
from provider_runtime import (
    AssistantMessage,
    CanonicalTool,
    GenerateIntent,
    PromptBlock,
    ProviderTarget,
    SystemMessage,
    TextOutput,
    ToolResultMessage,
    UserMessage,
)
from provider_runtime import (
    Present as RuntimePresent,
)
from provider_runtime.types import (
    ContinuationArtifact,
    ImageBlock,
    PromptMessage,
    ProviderName,
    ReasoningLevel,
    StrictJsonOutput,
    ToolCall,
)
from provider_runtime.types import (
    Presence as RuntimePresence,
)
from pydantic import BaseModel, ConfigDict, Field, JsonValue

from nexus.schemas.presence import Absent, Presence, absent, present


class _StateModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class ProviderTargetState(_StateModel):
    provider: ProviderName
    model: str = Field(min_length=1)


class PromptBlockState(_StateModel):
    text: str


class ContinuationState(_StateModel):
    target: ProviderTargetState
    codec_id: str = Field(min_length=1)
    opaque_payload: dict[str, JsonValue]


class ToolCallState(_StateModel):
    id: str = Field(min_length=1)
    name: str = Field(min_length=1)
    arguments: dict[str, JsonValue]


class SystemMessageState(_StateModel):
    kind: Literal["System"] = "System"
    blocks: tuple[PromptBlockState, ...]


class UserMessageState(_StateModel):
    kind: Literal["User"] = "User"
    blocks: tuple[PromptBlockState, ...]


class AssistantMessageState(_StateModel):
    kind: Literal["Assistant"] = "Assistant"
    text: str
    tool_calls: tuple[ToolCallState, ...]
    continuation: Presence[ContinuationState]


class ToolResultMessageState(_StateModel):
    kind: Literal["ToolResult"] = "ToolResult"
    call_id: str = Field(min_length=1)
    output: str
    is_error: bool


type PromptMessageState = Annotated[
    SystemMessageState | UserMessageState | AssistantMessageState | ToolResultMessageState,
    Field(discriminator="kind"),
]


class CanonicalToolState(_StateModel):
    name: str = Field(min_length=1)
    description: str
    parameters: dict[str, JsonValue]


class TextOutputState(_StateModel):
    kind: Literal["Text"] = "Text"


class StrictJsonOutputState(_StateModel):
    kind: Literal["StrictJson"] = "StrictJson"
    name: str = Field(min_length=1)
    json_schema: dict[str, JsonValue]


type OutputState = Annotated[
    TextOutputState | StrictJsonOutputState,
    Field(discriminator="kind"),
]


class GenerateIntentState(_StateModel):
    """The sole persisted representation of a durable chat intent.

    Product persistence deliberately holds only JSON-safe intent facts. Provider
    engines own wire request construction and native replay encoding.
    """

    target: ProviderTargetState
    messages: tuple[PromptMessageState, ...]
    max_output_tokens: int = Field(gt=0)
    reasoning: ReasoningLevel
    tools: tuple[CanonicalToolState, ...]
    tool_choice: Literal["auto", "none"]
    output: OutputState
    provider_options: dict[str, JsonValue] = Field(default_factory=dict)

    @classmethod
    def from_intent(cls, intent: GenerateIntent) -> GenerateIntentState:
        return cls(
            target=_target_state(intent.target),
            messages=tuple(_message_state(message) for message in intent.messages),
            max_output_tokens=intent.max_output_tokens,
            reasoning=intent.reasoning,
            tools=tuple(
                CanonicalToolState(
                    name=tool.name,
                    description=tool.description,
                    parameters=_json_object(tool.parameters),
                )
                for tool in intent.tools
            ),
            tool_choice=intent.tool_choice,
            output=_output_state(intent.output),
            provider_options=_json_object(intent.provider_options),
        )

    def to_intent(self) -> GenerateIntent:
        return GenerateIntent(
            target=_target(self.target),
            messages=tuple(_message(message) for message in self.messages),
            max_output_tokens=self.max_output_tokens,
            reasoning=self.reasoning,
            tools=tuple(
                CanonicalTool(
                    name=tool.name,
                    description=tool.description,
                    parameters=dict(tool.parameters),
                )
                for tool in self.tools
            ),
            tool_choice=self.tool_choice,
            output=_output(self.output),
            provider_options=dict(self.provider_options),
        )

    def conservative_token_admission_bound(self) -> int:
        """The deterministic quota reservation for this persisted intent."""

        return len(self.model_dump_json().encode("utf-8")) + self.max_output_tokens


def conservative_token_admission_bound(intent: GenerateIntent) -> int:
    """Return the persisted-intent bytes plus requested output allowance."""

    return GenerateIntentState.from_intent(intent).conservative_token_admission_bound()


def tool_call_state(value: ToolCall) -> ToolCallState:
    return ToolCallState(
        id=value.id,
        name=value.name,
        arguments=_json_object(value.arguments),
    )


def tool_call_from_state(value: ToolCallState) -> ToolCall:
    return ToolCall(id=value.id, name=value.name, arguments=dict(value.arguments))


def continuation_state(value: ContinuationArtifact) -> ContinuationState:
    return ContinuationState(
        target=_target_state(value.target),
        codec_id=value.codec_id,
        opaque_payload=_json_object(value.opaque_payload),
    )


def continuation_from_state(
    value: Presence[ContinuationState],
) -> RuntimePresence[ContinuationArtifact]:
    if isinstance(value, Absent):
        return RuntimeAbsent()
    return RuntimePresent(
        ContinuationArtifact(
            target=_target(value.value.target),
            codec_id=value.value.codec_id,
            opaque_payload=dict(value.value.opaque_payload),
        )
    )


def assistant_message_from_state(
    *,
    text: str,
    tool_calls: tuple[ToolCallState, ...],
    continuation: Presence[ContinuationState],
) -> AssistantMessage:
    return AssistantMessage(
        text=text,
        tool_calls=tuple(tool_call_from_state(call) for call in tool_calls),
        continuation=continuation_from_state(continuation),
    )


def _target_state(target: ProviderTarget) -> ProviderTargetState:
    return ProviderTargetState(provider=target.provider, model=target.model)


def _json_object(value: Mapping[str, object]) -> dict[str, JsonValue]:
    """Normalize an immutable runtime mapping into the durable JSON domain."""

    return {key: _json_value(item) for key, item in value.items()}


def _json_value(value: object) -> JsonValue:
    if value is None or isinstance(value, bool | int | str):
        return value
    if isinstance(value, float):
        if not math.isfinite(value):
            raise ValueError("durable LLM state rejects non-finite numbers")
        return value
    if isinstance(value, Mapping):
        if any(not isinstance(key, str) for key in value):
            raise ValueError("durable LLM state requires string object keys")
        return {cast(str, key): _json_value(item) for key, item in value.items()}
    if isinstance(value, Sequence) and not isinstance(value, str | bytes | bytearray):
        return [_json_value(item) for item in value]
    raise ValueError(f"durable LLM state cannot encode {type(value).__name__}")


def _target(state: ProviderTargetState) -> ProviderTarget:
    return ProviderTarget(provider=state.provider, model=state.model)


def _prompt_block_state(value: PromptBlock | ImageBlock) -> PromptBlockState:
    if not isinstance(value, PromptBlock):
        raise ValueError("durable generation intents support text prompt blocks only")
    return PromptBlockState(text=value.text)


def _block(state: PromptBlockState) -> PromptBlock:
    return PromptBlock(text=state.text)


def _message_state(value: PromptMessage) -> PromptMessageState:
    if isinstance(value, SystemMessage):
        return SystemMessageState(
            blocks=tuple(_prompt_block_state(block) for block in value.blocks)
        )
    if isinstance(value, UserMessage):
        return UserMessageState(blocks=tuple(_prompt_block_state(block) for block in value.blocks))
    if isinstance(value, AssistantMessage):
        continuation = (
            absent()
            if isinstance(value.continuation, RuntimeAbsent)
            else present(continuation_state(value.continuation.value))
        )
        return AssistantMessageState(
            text=value.text,
            tool_calls=tuple(tool_call_state(call) for call in value.tool_calls),
            continuation=continuation,
        )
    if isinstance(value, ToolResultMessage):
        return ToolResultMessageState(
            call_id=value.call_id,
            output=value.output,
            is_error=value.is_error,
        )
    raise AssertionError("unknown provider prompt message")


def _message(value: PromptMessageState) -> PromptMessage:
    if isinstance(value, SystemMessageState):
        return SystemMessage(blocks=tuple(_block(block) for block in value.blocks))
    if isinstance(value, UserMessageState):
        return UserMessage(blocks=tuple(_block(block) for block in value.blocks))
    if isinstance(value, AssistantMessageState):
        return assistant_message_from_state(
            text=value.text,
            tool_calls=value.tool_calls,
            continuation=value.continuation,
        )
    if isinstance(value, ToolResultMessageState):
        return ToolResultMessage(
            call_id=value.call_id,
            output=value.output,
            is_error=value.is_error,
        )
    raise AssertionError("unknown stored prompt message")


def _output_state(value: TextOutput | StrictJsonOutput) -> OutputState:
    if isinstance(value, TextOutput):
        return TextOutputState()
    return StrictJsonOutputState(
        name=value.name,
        json_schema=_json_object(value.schema),
    )


def _output(value: OutputState) -> TextOutput | StrictJsonOutput:
    if isinstance(value, TextOutputState):
        return TextOutput()
    return StrictJsonOutput(name=value.name, schema=dict(value.json_schema))
