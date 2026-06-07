"""Unit tests for the generic structured-synthesis primitive.

These pin the one shared mechanic: one ``llm.generate`` call → strict JSON object
→ pydantic schema validation → typed result, with provider-call errors
(``LLMError``) propagating unchanged and parse/validate failures surfacing as
``StructuredSynthesisError``. The fake router stands in for the external LLM
provider boundary (the only mock allowed here).
"""

import json

import pytest
from llm_calling.errors import LLMError, LLMErrorCode
from llm_calling.types import LLMRequest, LLMResponse, LLMUsage, Turn
from pydantic import BaseModel, ConfigDict

from nexus.services.structured_synthesis import (
    StructuredSynthesisError,
    SynthesisRequest,
    run_structured_synthesis,
)

pytestmark = pytest.mark.unit


class _Output(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid")

    title: str
    count: int


class _FakeRouter:
    """Returns one canned response for the single ``generate`` call."""

    def __init__(self, response: LLMResponse) -> None:
        self.response = response
        self.calls = 0

    async def generate(self, _provider, _request, _api_key, *, timeout_s):
        self.calls += 1
        return self.response


class _RaisingRouter:
    """Raises a provider error for the single ``generate`` call."""

    def __init__(self, error: LLMError) -> None:
        self.error = error

    async def generate(self, _provider, _request, _api_key, *, timeout_s):
        raise self.error


def _request() -> SynthesisRequest:
    return SynthesisRequest(
        provider="anthropic",
        llm_request=LLMRequest(
            model_name="test-model",
            messages=[Turn(role="user", content="hi")],
            max_tokens=128,
        ),
        api_key="sk-test",
        timeout_s=30,
    )


def _response(text: str, *, usage: LLMUsage | None = None, request_id: str | None = None):
    return LLMResponse(text=text, usage=usage, provider_request_id=request_id)


async def test_valid_json_validates_into_schema_and_surfaces_usage():
    usage = LLMUsage(input_tokens=10, output_tokens=5, total_tokens=15)
    router = _FakeRouter(
        _response(
            json.dumps({"title": "Folio", "count": 3}),
            usage=usage,
            request_id="req-123",
        )
    )

    result = await run_structured_synthesis(llm=router, request=_request(), schema=_Output)

    assert router.calls == 1, "exactly one generate call should be made"
    assert result.value == _Output(title="Folio", count=3)
    assert result.usage is usage, "usage must be surfaced from the response"


async def test_leading_and_trailing_whitespace_is_tolerated():
    router = _FakeRouter(_response('\n  {"title": "Folio", "count": 1}\n  '))

    result = await run_structured_synthesis(llm=router, request=_request(), schema=_Output)

    assert result.value == _Output(title="Folio", count=1)


async def test_fenced_json_is_rejected_as_typed_error():
    # The contract is a *bare* JSON object; a ```json fence is rejected (it does
    # not start with "{"), mirroring Oracle's strict no-fence acceptance.
    fenced = "```json\n" + json.dumps({"title": "Folio", "count": 3}) + "\n```"
    router = _FakeRouter(_response(fenced))

    with pytest.raises(StructuredSynthesisError):
        await run_structured_synthesis(llm=router, request=_request(), schema=_Output)


async def test_unparseable_json_raises_typed_error():
    router = _FakeRouter(_response("{not valid json,,,}"))

    with pytest.raises(StructuredSynthesisError):
        await run_structured_synthesis(llm=router, request=_request(), schema=_Output)


async def test_non_object_json_raises_typed_error():
    # A bare array starts with "[" so it fails the bare-object guard.
    router = _FakeRouter(_response("[1, 2, 3]"))

    with pytest.raises(StructuredSynthesisError):
        await run_structured_synthesis(llm=router, request=_request(), schema=_Output)


async def test_schema_mismatch_raises_typed_error():
    # Wrong field type (count is a string) fails strict schema validation.
    router = _FakeRouter(_response(json.dumps({"title": "Folio", "count": "three"})))

    with pytest.raises(StructuredSynthesisError):
        await run_structured_synthesis(llm=router, request=_request(), schema=_Output)


async def test_extra_keys_raise_typed_error_under_forbid():
    router = _FakeRouter(_response(json.dumps({"title": "Folio", "count": 3, "extra": "nope"})))

    with pytest.raises(StructuredSynthesisError):
        await run_structured_synthesis(llm=router, request=_request(), schema=_Output)


async def test_provider_error_propagates_unchanged():
    # The provider-call failure must NOT be wrapped — callers (Oracle) map each
    # LLMErrorCode to a distinct domain error code.
    error = LLMError(LLMErrorCode.PROVIDER_DOWN, "boom", provider="anthropic")
    router = _RaisingRouter(error)

    with pytest.raises(LLMError) as excinfo:
        await run_structured_synthesis(llm=router, request=_request(), schema=_Output)

    assert excinfo.value.error_code is LLMErrorCode.PROVIDER_DOWN
