"""Structured (non-streamed) LLM synthesis: shared scaffold for one strict-JSON call.

A *structured synthesis* is an ``execute_generation`` call whose response is a
strict JSON object that validates into a caller-supplied pydantic schema. The
generic mechanics are owned here once:

- :func:`build_synthesis_prompt` — the shared system-prompt scaffold: persona +
  optional preamble + a numbered ``RULES.`` block closed by the strict-JSON
  output rule. The shared index-grounding wording lives in
  :data:`INDEX_GROUNDING_RULE`; call sites whose prompts ground by index pass
  it (verbatim or extended) as their first domain rule.
- :func:`build_synthesis_intent` — the shared two-block ``GenerateIntent``
  shape: a ``Stable(GlobalScope())`` system block (the assembled prompt) plus
  a ``Dynamic`` user block (the caller-rendered candidates/instruction), with
  ``output=StrictJsonOutput`` derived from the caller's schema via the
  canonical-subset parser. The caller wraps this in one
  ``GenerationRequest`` and calls ``llm_execution.execute_generation`` itself
  (structured_synthesis is not a ledger caller).
- :func:`ground_indices` — THE grounding invariant: a model-emitted integer
  index must denote an offered candidate.
- :func:`decode_structured_synthesis` — validate a ``Succeeded`` outcome's
  strict-JSON payload into the schema and run the caller's semantic
  ``validate`` hook.

**Domain stays with the caller**: the prompt text (persona/preamble/domain
rules/JSON shape), per-candidate rendering, the schema fields, the semantic
judgement inside ``validate``, the ``GenerationRequest``/``execute_generation``
call, and mapping a non-``Succeeded`` ``CallOutcome`` to a domain failure —
this module never calls ``execute_generation`` and never inspects anything but
a ``Succeeded`` outcome.

There is no repair round: the runtime enforces strict JSON at the provider
boundary (``StrictJsonOutput``), so a decode/schema/semantic-validate failure
here is terminal — :func:`decode_structured_synthesis` raises
:class:`StructuredSynthesisError` once, and the caller maps it to its own
domain failure code.
"""

from __future__ import annotations

from collections.abc import Callable, Sequence
from typing import Literal

from provider_runtime import (
    Cancelled,
    Dynamic,
    Failed,
    GenerateIntent,
    GlobalScope,
    Incomplete,
    InvalidToolArguments,
    Present,
    PromptBlock,
    Refused,
    Stable,
    StrictJsonOutput,
    StructuredContent,
    Succeeded,
    SystemMessage,
    UserMessage,
    failure_code,
    parse_canonical_schema,
)
from pydantic import BaseModel, ValidationError

from nexus.services.llm_profiles import LlmProfile

# The shared index-grounding rule. Call sites pass it as their first domain
# rule (oracle verbatim; media-unit appends its no-invent sentence) so the
# bytes have one owner while every prompt stays reproducible verbatim.
INDEX_GROUNDING_RULE = "Refer to candidate passages only by their integer index."


class StructuredSynthesisError(Exception):
    """The strict-JSON payload failed ``schema.model_validate`` or the
    caller's semantic ``validate`` hook.

    Raised by :func:`decode_structured_synthesis` only — never for a
    non-``Succeeded`` outcome (Refused/Incomplete/Cancelled/Failed), which the
    caller matches on the raw ``CallOutcome`` itself (exhaustively, incl.
    ``Failed(TransientExhausted)`` requeue/skip contracts).
    """


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
    profile: LlmProfile,
    system_prompt: str,
    user_content: str,
    max_output_tokens: int,
    schema: type[BaseModel],
) -> GenerateIntent:
    """Assemble the shared two-block structured-synthesis intent.

    The system prompt is the sole ``Stable(GlobalScope())`` block (caching has
    no off state — the planner requires a non-empty stable prefix); the
    rendered candidates/instruction is one ``Dynamic`` user block.
    ``reasoning`` is always the profile's default (structured synthesis offers
    no reasoning choice); ``tools``/``tool_choice`` are empty — synthesis never
    calls tools.
    """
    return GenerateIntent(
        target=profile.target,
        messages=(
            SystemMessage(
                blocks=(PromptBlock(text=system_prompt, stability=Stable(GlobalScope())),)
            ),
            UserMessage(blocks=(PromptBlock(text=user_content, stability=Dynamic()),)),
        ),
        max_output_tokens=max_output_tokens,
        reasoning=profile.default_reasoning_option_id,
        tools=(),
        tool_choice="none",
        output=StrictJsonOutput(
            name=schema.__name__,
            schema=parse_canonical_schema(schema.model_json_schema()),
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
    outcome: Succeeded,
    *,
    schema: type[T],
    validate: Callable[[T], str | None] | None = None,
) -> T:
    """Validate a ``Succeeded`` strict-JSON outcome into ``schema``.

    Runs the caller's semantic ``validate`` hook (returns a rejection reason,
    or ``None`` to accept) after the schema validates. Either failure raises
    :class:`StructuredSynthesisError` — no repair round; the runtime already
    enforced strict JSON at the wire.
    """
    content = outcome.response.content
    if not isinstance(content, StructuredContent):
        # justify-defect: the intent's output=StrictJsonOutput plans
        # output_kind="strict_json", which the runtime promotes to
        # StructuredContent on every Succeeded outcome.
        raise AssertionError("strict-json outcome decoded as TextContent")
    try:
        value = schema.model_validate(content.payload)
    except ValidationError as exc:
        raise StructuredSynthesisError(f"response JSON does not match the schema: {exc}") from exc
    if validate is not None:
        reason = validate(value)
        if reason is not None:
            raise StructuredSynthesisError(reason)
    return value


def outcome_failure_facts(
    outcome: Refused | Incomplete | Cancelled | Failed,
) -> tuple[str, str | None]:
    """The ``(code, detail)`` a background owner records for any non-``Succeeded``
    terminal ``CallOutcome`` — shared across every background owner (structured-JSON
    or plain text), since the mapping from the runtime's closed outcome union to a
    domain error floor is the same everywhere. ``Failed`` (incl.
    ``TransientExhausted``) uses the runtime's own fixed failure code; an owner that
    must distinguish a transient cause for a requeue-vs-skip decision matches
    ``outcome`` itself before calling this.
    """
    if isinstance(outcome, Refused):
        return "refused", outcome.safe_detail
    if isinstance(outcome, Incomplete):
        code = "refused" if outcome.status == "refused" else "incomplete"
        detail = outcome.safe_detail.value if isinstance(outcome.safe_detail, Present) else None
        return code, detail
    if isinstance(outcome, Cancelled):
        return "cancelled", None
    if isinstance(outcome, Failed):
        return failure_code(outcome.failure), _failure_detail(outcome.failure)
    raise AssertionError(f"unhandled outcome variant: {outcome!r}")  # justify-defect: closed union


def _failure_detail(failure: object) -> str | None:
    if isinstance(failure, InvalidToolArguments):
        return failure.safe_detail
    return None
