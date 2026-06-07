"""Generic single structured (non-streamed) LLM call + JSON→typed-schema validation.

A *structured synthesis* is one ``llm.generate`` call whose response text is a
strict JSON object that validates into a caller-supplied pydantic schema. The
generic mechanics — issuing the one call, reading ``response.text``, parsing the
strict JSON, validating it into the schema, and surfacing usage — are owned here
once.

**Domain stays with the caller**: building the ``LLMRequest`` (the prompt and
the JSON contract it instructs), defining the schema fields, and all semantic
validation / output guards run on the returned ``value``. The caller also owns
mapping any propagated ``LLMError`` to its domain error codes; this primitive
does not catch ``LLMError`` so that per-code distinctions survive intact.

Failure of the parse/validate step (unparseable, schema-mismatch, or not a bare
``{...}`` object) raises :class:`StructuredSynthesisError`. The provider-call
failure (``LLMError``) propagates unchanged.
"""

from __future__ import annotations

import json
from dataclasses import dataclass

from llm_calling.router import LLMRouter
from llm_calling.types import LLMRequest, LLMUsage
from pydantic import BaseModel, ValidationError


class StructuredSynthesisError(Exception):
    """The provider returned output that is not the expected strict JSON schema.

    Raised when the response text is not a bare ``{...}`` JSON object, is not
    valid JSON, or fails ``schema.model_validate``. The caller maps this to its
    own domain failure (e.g. Oracle's E_LLM_BAD_REQUEST).
    """


@dataclass(frozen=True)
class SynthesisRequest:
    """A fully-rendered structured-synthesis request (the prompt is domain-built)."""

    provider: str
    llm_request: LLMRequest
    api_key: str
    timeout_s: int


@dataclass(frozen=True)
class SynthesisResult[T: BaseModel]:
    """The validated typed object plus the provider call's usage attribution."""

    value: T
    usage: LLMUsage | None


async def run_structured_synthesis[T: BaseModel](
    *,
    llm: LLMRouter,
    request: SynthesisRequest,
    schema: type[T],
) -> SynthesisResult[T]:
    """Make one structured call and validate its strict-JSON output into ``schema``.

    One ``llm.generate`` → ``response.text`` → require a bare ``{...}`` object →
    ``json.loads`` → ``schema.model_validate`` → :class:`SynthesisResult`. The
    provider-call failure (``LLMError``) propagates unchanged so the caller keeps
    its per-code mapping; a parse/validate failure raises
    :class:`StructuredSynthesisError`.
    """
    response = await llm.generate(
        request.provider,
        request.llm_request,
        request.api_key,
        timeout_s=request.timeout_s,
    )
    value = _validate_strict_json(response.text, schema=schema)
    return SynthesisResult(value=value, usage=response.usage)


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
