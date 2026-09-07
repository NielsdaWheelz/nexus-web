"""Structured generation synthesis: shared scaffold for one strict-JSON call.

A *structured synthesis* is a generation whose response is a strict JSON
object that validates into a caller-supplied pydantic schema. The generic
mechanics are owned here once:

- :func:`build_synthesis_prompt` — the shared system-prompt scaffold: persona +
  optional preamble + a numbered ``RULES.`` block closed by the strict-JSON
  output rule. The shared index-grounding wording lives in
  :data:`INDEX_GROUNDING_RULE`; call sites whose prompts ground by index pass
  it (verbatim or extended) as their first domain rule.
- :func:`build_synthesis_intent` — the shared two-block app-owned
  ``GenerationIntent`` shape: bounded instructions plus bounded input, with a
  strict ``JsonSchemaOutput`` derived from the caller's schema. The caller
  wraps this in the operation command and calls the generation boundary.
- :func:`ground_indices` — THE grounding invariant: a model-emitted integer
  index must denote an offered candidate.
- :func:`decode_structured_synthesis` — validate a succeeded terminal's
  strict-JSON payload into the schema and run the caller's semantic
  ``validate`` hook.

**Domain stays with the caller**: the prompt text (persona/preamble/domain
rules/JSON shape), per-candidate rendering, the schema fields, the semantic
judgement inside ``validate``, the generation-boundary call, and mapping a
non-success terminal to a domain failure — this module never calls a
generation boundary.

There is no repair round: a decode/schema/semantic-validate failure here is
terminal — :func:`decode_structured_synthesis` raises
:class:`StructuredSynthesisError` once, and the caller maps it to
``invalid_output``.
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
from nexus.services.generation_intent import GenerationIntent, JsonSchemaOutput

# The shared index-grounding rule. Call sites pass it as their first domain
# rule (oracle verbatim; media-unit appends its no-invent sentence) so the
# bytes have one owner while every prompt stays reproducible verbatim.
INDEX_GROUNDING_RULE = "Refer to candidate passages only by their integer index."


class StructuredSynthesisError(Exception):
    """A succeeded generation did not satisfy its strict output contract."""


def build_synthesis_prompt(
    *,
    persona: str,
    preamble: str | None,
    domain_rules: Sequence[str],
    json_shape: str,
) -> str:
    """Assemble the shared synthesis system prompt.

    ``persona`` + optional ``preamble`` (blank-line separated) + ``RULES.`` +
    the numbered ``domain_rules`` (1..N-1, moved verbatim from the call site)
    + the final rule N demanding strict JSON of ``json_shape``.
    """
    rules = [f"{number}. {rule}" for number, rule in enumerate(domain_rules, start=1)]
    rules.append(
        f"{len(domain_rules) + 1}. Output strict JSON of the form: {json_shape}. "
        "No markdown fences, no extra keys, no commentary outside the JSON."
    )
    head = [persona] if preamble is None else [persona, preamble]
    return "\n\n".join([*head, "RULES.\n" + "\n".join(rules)])


def build_synthesis_user_content(
    *,
    candidates_header: str,
    rendered_candidates: str,
    extra_user_block: str | None,
) -> str:
    """Assemble the shared user-turn text: ``{candidates_header}:`` + the
    caller-rendered candidates + an optional extra block (e.g. oracle's
    ``QUESTION: …``) + the closing instruction."""
    user_content = f"{candidates_header}:\n{rendered_candidates}\n\n"
    if extra_user_block is not None:
        user_content += f"{extra_user_block}\n\n"
    user_content += "Respond with the strict JSON object as instructed."
    return user_content


def build_synthesis_intent(
    *,
    system_prompt: str,
    user_content: str,
    schema: type[BaseModel],
) -> GenerationIntent:
    """Assemble the shared two-block structured-synthesis intent.

    Runtime target, effort, tools, retries, and output-token controls are
    selected by the operation policy and cannot enter this intent.
    """
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

    THE invariant: ``0 <= index_of(entry) < len(candidates)`` — an ungrounded
    index never reaches persistence. ``"reject"`` returns ``None`` on the first
    violation (the whole output is invalid); ``"drop"`` skips violating
    entries. Caller-side concerns (phase cover, ordinal dedupe, role coercion,
    dense reordinaling) stay out.
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
    """Validate a succeeded strict-JSON terminal into ``schema``.

    Runs the caller's semantic ``validate`` hook (returns a rejection reason,
    or ``None`` to accept) after the schema validates. Either failure raises
    :class:`StructuredSynthesisError` — no repair round; the runtime already
    enforced strict JSON at the wire.
    """
    if terminal.status != "succeeded":
        raise AssertionError(
            "structured synthesis received a non-succeeded terminal; caller must classify it"
        )
    if terminal.structured_output is None:
        raise StructuredSynthesisError("succeeded terminal has no structured output")
    try:
        value = schema.model_validate(terminal.structured_output)
    except ValidationError:
        # Pydantic's rendered exception includes rejected input values.  The
        # adapter memo is durable and exception chains may reach defect logs, so
        # retain only the closed classification at both boundaries.
        raise StructuredSynthesisError("response JSON does not match the schema") from None
    if validate is not None:
        reason = validate(value)
        if reason is not None:
            raise StructuredSynthesisError(reason)
    return value


def outcome_failure_facts(
    terminal: GenerationTerminal,
) -> tuple[str, str | None]:
    """Return the closed ``(code, detail)`` facts for a terminal."""
    if terminal.status == "succeeded":
        raise AssertionError("a succeeded terminal has no failure facts")
    if terminal.status == "cancelled":
        return "cancelled", None
    if terminal.failure is None:
        raise AssertionError("a failed terminal has no failure kind")
    return normalized_failure(terminal.failure.kind), retained_terminal_error_detail(terminal)
