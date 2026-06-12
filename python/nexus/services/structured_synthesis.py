"""Structured (non-streamed) LLM synthesis: shared scaffold + one validated call.

A *structured synthesis* is an ``llm.generate`` call whose response text is a
strict JSON object that validates into a caller-supplied pydantic schema. The
generic mechanics are owned here once:

- :func:`build_synthesis_prompt` — the shared system-prompt scaffold: persona +
  optional preamble + a numbered ``RULES.`` block closed by the strict-JSON
  output rule. The shared index-grounding wording lives in
  :data:`INDEX_GROUNDING_RULE`; call sites whose prompts ground by index pass
  it (verbatim or extended) as their first domain rule.
- :func:`build_synthesis_request` — the shared two-turn request shape
  (cached system turn, candidates + closing instruction user turn).
- :func:`ground_indices` — THE grounding invariant: a model-emitted integer
  index must denote an offered candidate.
- :func:`run_structured_synthesis` — issue the call, parse the strict JSON,
  validate into the schema, run the caller's semantic ``validate`` hook, and on
  a first failure re-issue ONE bounded repair round before failing.

**Domain stays with the caller**: the prompt text (persona/preamble/domain
rules/JSON shape), per-candidate rendering, the schema fields, the semantic
judgement inside ``validate``, and mapping any propagated ``ModelCallError`` to its
domain error codes; this primitive does not catch ``ModelCallError`` so that per-code
distinctions survive intact (provider failures are never repaired).

Failure of the parse/validate step (unparseable, schema-mismatch, not a bare
``{...}`` object, or a ``validate`` rejection) raises
:class:`StructuredSynthesisError` once the repair round is spent.
"""

from __future__ import annotations

import json
from collections.abc import Callable, Sequence
from dataclasses import dataclass, replace
from typing import Literal, Protocol, cast

from provider_runtime.types import (
    ModelCall,
    ModelMessage,
    ModelRef,
    ModelResponse,
    ProviderName,
    ReasoningConfig,
    TokenUsage,
)
from pydantic import BaseModel, ValidationError


class SynthesisLLM(Protocol):
    """The one call shape synthesis needs: ``ModelRuntime`` or a ledgered wrapper
    (``llm_ledger.LedgeredLLM``, which writes one ``llm_calls`` row per attempt)."""

    async def generate(self, req: ModelCall, *, key: str, timeout_s: int) -> ModelResponse: ...


# The shared index-grounding rule. Call sites pass it as their first domain
# rule (oracle verbatim; media-unit appends its no-invent sentence) so the
# bytes have one owner while every prompt stays reproducible verbatim.
INDEX_GROUNDING_RULE = "Refer to candidate passages only by their integer index."


class StructuredSynthesisError(Exception):
    """The model output failed strict-JSON validation or the caller's ``validate``.

    Raised when the response text is not a bare ``{...}`` JSON object, is not
    valid JSON, fails ``schema.model_validate``, or is rejected by the caller's
    semantic ``validate`` hook — from :func:`run_structured_synthesis` only
    after the one repair round is spent. The caller maps this to its own domain
    failure (e.g. Oracle's E_LLM_BAD_REQUEST).
    """


@dataclass(frozen=True)
class SynthesisRequest:
    """A fully-rendered structured-synthesis request (the prompt is domain-built)."""

    provider: str
    llm_request: ModelCall
    api_key: str
    timeout_s: int


@dataclass(frozen=True)
class SynthesisResult[T: BaseModel]:
    """The validated typed object plus its usage attribution.

    ``usage`` is summed across attempts when a repair round ran; the
    non-summable per-call ``provider_usage`` dict is dropped from a summed
    usage.
    """

    value: T
    usage: TokenUsage | None


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


def build_synthesis_request(
    *,
    provider: str,
    system_prompt: str,
    candidates_header: str,
    rendered_candidates: str,
    extra_user_block: str | None,
    model_name: str,
    max_tokens: int,
) -> ModelCall:
    """Assemble the shared two-turn synthesis request.

    Cached system turn (``cache_ttl="5m"``) + one user turn:
    ``{candidates_header}:`` + the caller-rendered candidates + an optional
    extra block (e.g. oracle's ``QUESTION: …``) + the closing instruction.
    ``reasoning_effort="none"`` always (synthesis is a single structured call).
    """
    user_content = f"{candidates_header}:\n{rendered_candidates}\n\n"
    if extra_user_block is not None:
        user_content += f"{extra_user_block}\n\n"
    user_content += "Respond with the strict JSON object as instructed."
    return ModelCall(
        model=ModelRef(provider=cast(ProviderName, provider), model=model_name),
        messages=[
            ModelMessage(role="system", content=system_prompt, cache_ttl="5m"),
            ModelMessage(role="user", content=user_content, cache_ttl="none"),
        ],
        max_output_tokens=max_tokens,
        reasoning=ReasoningConfig(effort="none"),
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


async def run_structured_synthesis[T: BaseModel](
    *,
    llm: SynthesisLLM,
    request: SynthesisRequest,
    schema: type[T],
    validate: Callable[[T], str | None] | None = None,
) -> SynthesisResult[T]:
    """Make a structured call, with one bounded repair round, into ``schema``.

    ``llm.generate`` → ``response.text`` → require a bare ``{...}`` object →
    ``json.loads`` → ``schema.model_validate`` → optional caller ``validate``
    (returns a rejection reason, or ``None`` to accept). On the first failure
    of any of those steps the call is re-issued ONCE with the bad output
    appended as an assistant turn plus a user turn naming the reason; a second
    failure raises :class:`StructuredSynthesisError` exactly as the first
    would have. The provider-call failure (``ModelCallError``) propagates unchanged
    from either attempt so the caller keeps its per-code mapping.
    """
    response = await llm.generate(
        request.llm_request,
        key=request.api_key,
        timeout_s=request.timeout_s,
    )
    try:
        value = _validated_value(response.text, schema=schema, validate=validate)
        return SynthesisResult(value=value, usage=response.usage)
    except StructuredSynthesisError as exc:
        first_usage = response.usage
        repair_request = _repair_request(request.llm_request, raw=response.text, reason=str(exc))
    response = await llm.generate(
        repair_request,
        key=request.api_key,
        timeout_s=request.timeout_s,
    )
    value = _validated_value(response.text, schema=schema, validate=validate)
    return SynthesisResult(value=value, usage=_sum_usage(first_usage, response.usage))


def _validated_value[T: BaseModel](
    raw: str, *, schema: type[T], validate: Callable[[T], str | None] | None
) -> T:
    value = _validate_strict_json(raw, schema=schema)
    if validate is not None:
        reason = validate(value)
        if reason is not None:
            raise StructuredSynthesisError(reason)
    return value


def _validate_strict_json[T: BaseModel](raw: str, *, schema: type[T]) -> T:
    cleaned = raw.strip()
    if not cleaned.startswith("{") or not cleaned.endswith("}"):
        raise StructuredSynthesisError("response is not a bare JSON object")
    try:
        parsed = json.loads(cleaned)
    except json.JSONDecodeError as exc:
        raise StructuredSynthesisError("response is not valid JSON") from exc
    try:
        return schema.model_validate(parsed)
    except ValidationError as exc:
        raise StructuredSynthesisError("response JSON does not match the schema") from exc


def _repair_request(original: ModelCall, *, raw: str, reason: str) -> ModelCall:
    return replace(
        original,
        messages=[
            *original.messages,
            ModelMessage(role="assistant", content=raw),
            ModelMessage(
                role="user",
                content=(
                    f"Your previous response was invalid: {reason}. "
                    "Respond again with only the corrected strict JSON object as instructed."
                ),
            ),
        ],
    )


def _sum_usage(first: TokenUsage | None, second: TokenUsage | None) -> TokenUsage | None:
    if first is None:
        return second
    if second is None:
        return first

    def add(x: int | None, y: int | None) -> int | None:
        return None if x is None and y is None else (x or 0) + (y or 0)

    return TokenUsage(
        input_tokens=add(first.input_tokens, second.input_tokens),
        output_tokens=add(first.output_tokens, second.output_tokens),
        total_tokens=add(first.total_tokens, second.total_tokens),
        reasoning_tokens=add(first.reasoning_tokens, second.reasoning_tokens),
        cache_creation_input_tokens=add(
            first.cache_creation_input_tokens, second.cache_creation_input_tokens
        ),
        cache_read_input_tokens=add(first.cache_read_input_tokens, second.cache_read_input_tokens),
        cached_tokens=add(first.cached_tokens, second.cached_tokens),
    )
