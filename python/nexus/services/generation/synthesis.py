"""The shared scaffold of one strict-JSON generation: prompt, intent, decode, grounding.

The caller owns every domain fact: prompt text, candidate rendering, the schema
and its semantic acceptance. There is no repair round: a rejection is final.
"""

from __future__ import annotations

from collections.abc import Callable, Sequence
from typing import Final

from pydantic import BaseModel, ValidationError

from nexus.services.generation.contract import (
    Decode,
    GenerationIntent,
    InvalidOutput,
    JsonSchemaOutput,
    JsonValue,
)

INDEX_GROUNDING_RULE: Final = "Refer to candidate passages only by their integer index."


def build_synthesis_prompt(
    *, persona: str, preamble: str | None, domain_rules: Sequence[str], json_shape: str
) -> str:
    """Persona, an optional preamble and numbered rules closed by the strict-JSON rule."""

    rules = [f"{number}. {rule}" for number, rule in enumerate(domain_rules, start=1)]
    rules.append(
        f"{len(domain_rules) + 1}. Output strict JSON of the form: {json_shape}. "
        "No markdown fences, no extra keys, no commentary outside the JSON."
    )
    head = [persona] if preamble is None else [persona, preamble]
    return "\n\n".join([*head, "RULES.\n" + "\n".join(rules)])


def build_synthesis_user_content(
    *, candidates_header: str, rendered_candidates: str, extra_user_block: str | None
) -> str:
    """The candidates under their header, an optional block, then the closing line."""

    user_content = f"{candidates_header}:\n{rendered_candidates}\n\n"
    if extra_user_block is not None:
        user_content += f"{extra_user_block}\n\n"
    return user_content + "Respond with the strict JSON object as instructed."


def build_synthesis_intent(
    *, system_prompt: str, user_content: str, schema: type[BaseModel]
) -> GenerationIntent:
    return GenerationIntent(
        instructions=system_prompt,
        input=user_content,
        output=JsonSchemaOutput(name=schema.__name__, schema=schema.model_json_schema()),
    )


def strict[M: BaseModel, T](schema: type[M], accept: Callable[[M], T]) -> Decode[T]:
    """Validate the parsed output into ``schema``, then let the caller accept it.

    ``accept`` raises ``InvalidOutput`` (or a subclass) for a semantic rejection.
    """

    def decode(value: JsonValue) -> T:
        try:
            model = schema.model_validate(value)
        except ValidationError:
            # pydantic renders the rejected values; the detail stays value-free.
            raise InvalidOutput("response JSON does not match the schema") from None
        return accept(model)

    return decode


def ground_indices[E, C](
    entries: Sequence[E], candidates: Sequence[C], *, index_of: Callable[[E], int]
) -> list[tuple[E, C]] | None:
    """Pair each entry with the offered candidate its index names; None if one names none."""

    grounded: list[tuple[E, C]] = []
    for entry in entries:
        index = index_of(entry)
        if not 0 <= index < len(candidates):
            return None
        grounded.append((entry, candidates[index]))
    return grounded
