"""Provider-independent, app-owned facts for one Codex generation."""

from __future__ import annotations

from typing import Annotated, Literal, get_origin

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    JsonValue,
    SecretStr,
    StringConstraints,
    ValidationInfo,
    model_validator,
)
from pydantic_core import PydanticUndefined

_MAX_INSTRUCTIONS_BYTES = 32 * 1024
_MAX_INPUT_BYTES = 1024 * 1024


class WireTaggedModel(BaseModel):
    """Strict frozen wire base that requires every Literal tag on JSON input."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    @model_validator(mode="before")
    @classmethod
    def _require_wire_tags(cls, data: object, info: ValidationInfo) -> object:
        if info.mode == "json" and isinstance(data, dict):
            missing = [
                name
                for name, field in cls.model_fields.items()
                if field.default is not PydanticUndefined
                and get_origin(field.annotation) is Literal
                and name not in data
            ]
            if missing:
                raise ValueError(f"wire tags are required: {', '.join(missing)}")
        return data


class TextOutput(WireTaggedModel):
    kind: Literal["Text"] = "Text"


class JsonSchemaOutput(WireTaggedModel):
    model_config = ConfigDict(
        extra="forbid",
        frozen=True,
        populate_by_name=True,
        serialize_by_alias=True,
    )

    kind: Literal["JsonSchema"] = "JsonSchema"
    name: Annotated[str, StringConstraints(min_length=1, max_length=128)]
    schema_: dict[str, JsonValue] = Field(alias="schema", serialization_alias="schema")
    strict: Literal[True] = True

    @model_validator(mode="after")
    def _schema_is_object(self) -> JsonSchemaOutput:
        if self.schema_.get("type") != "object":
            raise ValueError("strict JsonSchema output must have an object root")
        return self


GenerationOutput = Annotated[TextOutput | JsonSchemaOutput, Field(discriminator="kind")]


class BearerToolGrant(WireTaggedModel):
    """Sensitive, run-scoped material; its value is never serialized."""

    kind: Literal["Bearer"] = "Bearer"
    token: SecretStr = Field(exclude=True, repr=False)

    @model_validator(mode="after")
    def _token_is_not_blank(self) -> BearerToolGrant:
        if not self.token.get_secret_value().strip():
            raise ValueError("bearer token must not be blank")
        return self


class GenerationIntent(WireTaggedModel):
    instructions: str
    input: str
    output: GenerationOutput

    @model_validator(mode="after")
    def _bounded_text(self) -> GenerationIntent:
        if not self.instructions.strip():
            raise ValueError("instructions must not be blank")
        if not self.input.strip():
            raise ValueError("input must not be blank")
        if utf8_size(self.instructions) > _MAX_INSTRUCTIONS_BYTES:
            raise ValueError(f"instructions exceeds {_MAX_INSTRUCTIONS_BYTES} UTF-8 bytes")
        if utf8_size(self.input) > _MAX_INPUT_BYTES:
            raise ValueError(f"input exceeds {_MAX_INPUT_BYTES} UTF-8 bytes")
        return self


def utf8_size(value: str) -> int:
    return len(value.encode("utf-8"))


def validate_intent_bounds(
    intent: GenerationIntent, *, instructions_max_bytes: int, input_max_bytes: int
) -> None:
    if utf8_size(intent.instructions) > instructions_max_bytes:
        raise ValueError(f"instructions exceeds {instructions_max_bytes} UTF-8 bytes")
    if utf8_size(intent.input) > input_max_bytes:
        raise ValueError(f"input exceeds {input_max_bytes} UTF-8 bytes")


__all__ = [
    "BearerToolGrant",
    "GenerationIntent",
    "GenerationOutput",
    "JsonSchemaOutput",
    "TextOutput",
    "WireTaggedModel",
    "utf8_size",
    "validate_intent_bounds",
]
