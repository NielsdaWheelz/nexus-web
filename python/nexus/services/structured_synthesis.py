"""Shared scaffold for one strict-JSON generation: prompt, intent, decode.

The caller owns every domain fact — prompt text, candidate rendering, schema
fields, the semantic judgement, and the generation-boundary call. There is no
repair round: a decode or validate failure raises once.
"""

from __future__ import annotations

from collections.abc import Callable, Sequence
from typing import Literal

from pydantic import BaseModel, ValidationError

from nexus.services.codex_generation_contract import (
    GenerationTerminal,
    normalized_failure,
    retained_terminal_error_detail,
)
from nexus.services.generation_spec import GenerationIntent, JsonSchemaOutput

INDEX_GROUNDING_RULE = "Refer to candidate passages only by their integer index."


class StructuredSynthesisError(Exception):
    """A succeeded generation did not satisfy its strict output contract."""


def build_synthesis_prompt(
    *, persona: str, preamble: str | None, domain_rules: Sequence[str], json_shape: str
) -> str:
    """Persona + optional preamble + numbered rules closed by the strict-JSON rule."""

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
    """Candidates header, the caller's rendering, an optional block, the closing line."""

    user_content = f"{candidates_header}:\n{rendered_candidates}\n\n"
    if extra_user_block is not None:
        user_content += f"{extra_user_block}\n\n"
    return user_content + "Respond with the strict JSON object as instructed."


def build_synthesis_intent(
    *, system_prompt: str, user_content: str, schema: type[BaseModel]
) -> GenerationIntent:
    """Bounded instructions plus input with a strict schema; policy owns the rest."""

    return GenerationIntent(
        instructions=system_prompt,
        input=user_content,
        output=JsonSchemaOutput(
            name=schema.__name__, schema=schema.model_json_schema(), strict=True
        ),
    )


def ground_indices[E, C](
    entries: Sequence[E],
    candidates: Sequence[C],
    *,
    index_of: Callable[[E], int],
    policy: Literal["drop", "reject"],
) -> list[tuple[E, C]] | None:
    """Pair each entry with the offered candidate its model-emitted index denotes.

    An ungrounded index never reaches persistence: ``reject`` returns ``None`` on
    the first violation, ``drop`` skips the entry.
    """

    grounded: list[tuple[E, C]] = []
    for entry in entries:
        index = index_of(entry)
        if 0 <= index < len(candidates):
            grounded.append((entry, candidates[index]))
        elif policy == "reject":
            return None
    return grounded


def decode_structured_synthesis[T: BaseModel](
    terminal: GenerationTerminal,
    *,
    schema: type[T],
    validate: Callable[[T], str | None] | None = None,
) -> T:
    """Validate a succeeded strict-JSON terminal into ``schema``, then semantically."""

    if terminal.status != "succeeded":
        raise AssertionError(
            "structured synthesis received a non-succeeded terminal; caller must classify it"
        )
    if terminal.structured_output is None:
        raise StructuredSynthesisError("succeeded terminal has no structured output")
    try:
        value = schema.model_validate(terminal.structured_output)
    except ValidationError:
        # Pydantic renders rejected input values; the adapter memo is durable.
        raise StructuredSynthesisError("response JSON does not match the schema") from None
    if validate is not None:
        reason = validate(value)
        if reason is not None:
            raise StructuredSynthesisError(reason)
    return value


def outcome_failure_facts(terminal: GenerationTerminal) -> tuple[str, str | None]:
    """Return the closed ``(code, detail)`` facts for a non-succeeded terminal."""

    if terminal.status == "succeeded":
        raise AssertionError("a succeeded terminal has no failure facts")
    if terminal.status == "cancelled":
        return "cancelled", None
    if terminal.failure is None:
        raise AssertionError("a failed terminal has no failure kind")
    return normalized_failure(terminal.failure.kind), retained_terminal_error_detail(terminal)
