from uuid import uuid4

import pytest
from provider_runtime import ProviderApiKey
from provider_runtime.types import (
    ModelCall,
    ModelMessage,
    ModelRef,
    ReasoningConfig,
    ToolResult,
    ToolSpec,
)
from pydantic import BaseModel

from nexus.services.library_intelligence_reduce import (
    _LI_SYSTEM_PROMPT,
    _LiSynthesis,
    _map_li_citations,
)
from nexus.services.library_intelligence_reduce import (
    _Candidate as LiCandidate,
)
from nexus.services.media_intelligence import (
    _MEDIA_UNIT_SYSTEM_PROMPT,
    MediaUnitSynthesis,
    _map_claims_to_spans,
)
from nexus.services.media_intelligence import (
    _Candidate as MediaUnitCandidate,
)
from nexus.services.oracle import (
    _ORACLE_SYSTEM_PROMPT,
    _OracleSynthesisOutput,
    _validate_oracle_output,
)
from nexus.services.oracle import (
    _Candidate as OracleCandidate,
)
from nexus.services.real_media_fixture_llm import (
    APP_SEARCH_TOOL_NAME,
    REAL_MEDIA_FIXTURE_RESPONSE,
    REAL_MEDIA_FIXTURE_RESPONSE_WITH_CITATION,
    RealMediaFixtureModelRuntime,
)
from nexus.services.resource_graph.refs import ResourceRef
from nexus.services.structured_synthesis import (
    SynthesisRequest,
    run_structured_synthesis,
)

pytestmark = [pytest.mark.unit, pytest.mark.asyncio]
_FIXTURE_KEY = ProviderApiKey("real-media-fixture", source="test")


def _request(*turns: ModelMessage) -> ModelCall:
    return ModelCall(
        model=ModelRef(provider="openai", model="gpt-5.4-mini"),
        messages=list(turns),
        max_output_tokens=1024,
        tools=(
            ToolSpec(
                name=APP_SEARCH_TOOL_NAME,
                description="Search saved content.",
                parameters={"type": "object"},
            ),
        ),
    )


async def _chunks(req: ModelCall):
    router = RealMediaFixtureModelRuntime()
    return [
        chunk
        async for chunk in router.stream(
            req,
            key=_FIXTURE_KEY,
            timeout_s=45,
        )
    ]


async def test_real_media_fixture_llm_uses_app_search_before_answering() -> None:
    chunks = await _chunks(
        _request(
            ModelMessage(
                role="user",
                content="What does this source say about SOFIA? Use the attached evidence.",
            ),
        )
    )

    assert chunks[0].tool_call is not None
    assert chunks[0].tool_call.name == APP_SEARCH_TOOL_NAME
    assert chunks[0].tool_call.arguments == {"query": "SOFIA"}
    assert chunks[1].done is True


async def test_real_media_fixture_llm_cites_tool_result() -> None:
    chunks = await _chunks(
        _request(
            ModelMessage(role="user", content="What does this source say about SOFIA?"),
            ModelMessage(
                role="tool",
                tool_results=(
                    ToolResult(
                        call_id="real-media-fixture-app-search",
                        output='{"results":[{"n":1}]}',
                    ),
                ),
            ),
        )
    )

    assert chunks[0].delta_text == REAL_MEDIA_FIXTURE_RESPONSE_WITH_CITATION
    assert chunks[1].done is True


async def test_real_media_fixture_llm_cites_numbered_prompt_resource() -> None:
    chunks = await _chunks(
        _request(
            ModelMessage(
                role="system",
                content='<resources><resource uri="content_chunk:1" n="1">text</resource></resources>',
            ),
            ModelMessage(role="user", content="What does this source say about SOFIA?"),
            ModelMessage(
                role="tool",
                tool_results=(
                    ToolResult(
                        call_id="real-media-fixture-app-search",
                        output='{"results":[],"total_candidates":0,"status":"empty"}',
                    ),
                ),
            ),
        )
    )

    assert chunks[0].delta_text == REAL_MEDIA_FIXTURE_RESPONSE_WITH_CITATION
    assert chunks[1].done is True


async def test_real_media_fixture_llm_does_not_cite_empty_tool_result() -> None:
    chunks = await _chunks(
        _request(
            ModelMessage(role="user", content="What does this source say about SOFIA?"),
            ModelMessage(
                role="tool",
                tool_results=(
                    ToolResult(
                        call_id="real-media-fixture-app-search",
                        output='{"results":[],"total_candidates":0,"status":"empty"}',
                    ),
                ),
            ),
        )
    )

    assert chunks[0].delta_text == REAL_MEDIA_FIXTURE_RESPONSE
    assert chunks[1].done is True


async def _synthesize[T: BaseModel](system_prompt: str, schema: type[T]) -> T:
    """Run the fixture router's canned text through the real synthesis validation."""
    result = await run_structured_synthesis(
        llm=RealMediaFixtureModelRuntime(),
        request=SynthesisRequest(
            provider="anthropic",
            llm_request=ModelCall(
                model=ModelRef(provider="anthropic", model="claude-haiku-4-5-20251001"),
                messages=[
                    ModelMessage(role="system", content=system_prompt, cache_ttl="5m"),
                    ModelMessage(
                        role="user",
                        content=(
                            "CANDIDATES:\n[0] alpha\n\n"
                            "Respond with the strict JSON object as instructed."
                        ),
                    ),
                ],
                max_output_tokens=2048,
                reasoning=ReasoningConfig(effort="none"),
            ),
            api_key="real-media-fixture",
            timeout_s=45,
        ),
        schema=schema,
    )
    return result.value


async def test_real_media_fixture_llm_oracle_synthesis_passes_real_validator() -> None:
    value = await _synthesize(_ORACLE_SYSTEM_PROMPT, _OracleSynthesisOutput)

    # Oracle invokes synthesis only with >= 3 candidates; validate at that minimum.
    candidates = [
        OracleCandidate(
            source_kind="public_domain",
            exact_snippet=snippet,
            locator_label="Inferno",
            attribution_text="Dante Alighieri",
            deep_link=None,
            title="Inferno",
            target=ResourceRef(scheme="oracle_corpus_passage", id=uuid4()),
            tags=[],
            score=1.0,
        )
        for snippet in (
            "Midway upon the journey of our life I found myself within a forest dark.",
            "All hope abandon, ye who enter in!",
            "Thence we came forth to rebehold the stars.",
        )
    ]
    parsed = _validate_oracle_output(value, candidates=candidates)

    assert parsed is not None
    by_phase = parsed[4]
    assert set(by_phase) == {"descent", "ordeal", "ascent"}
    assert {index for index, _marginalia in by_phase.values()} == {0, 1, 2}


async def test_real_media_fixture_llm_library_reduce_synthesis_grounds() -> None:
    value = await _synthesize(_LI_SYSTEM_PROMPT, _LiSynthesis)

    candidate = LiCandidate(
        global_index=0,
        media_id=uuid4(),
        evidence_span_id=uuid4(),
        claim_text="SOFIA confirmed water on the sunlit Moon.",
        summary_md="s",
    )
    grounded = _map_li_citations(value, [candidate])

    assert value.content_md.strip()
    assert [(g.ordinal, g.role, g.evidence_span_id) for g in grounded] == [
        (1, "supports", candidate.evidence_span_id)
    ]


async def test_real_media_fixture_llm_media_unit_synthesis_grounds() -> None:
    value = await _synthesize(_MEDIA_UNIT_SYSTEM_PROMPT, MediaUnitSynthesis)

    candidate = MediaUnitCandidate(evidence_span_id=uuid4(), text="chunk")
    grounded = _map_claims_to_spans(value, [candidate])

    assert value.summary_md.strip()
    assert grounded == [(value.claims[0].claim_text, candidate.evidence_span_id, 0)]


async def test_real_media_fixture_llm_generate_without_marker_keeps_chat_response() -> None:
    router = RealMediaFixtureModelRuntime()

    response = await router.generate(
        _request(ModelMessage(role="user", content="What does this source say about SOFIA?")),
        key=_FIXTURE_KEY,
        timeout_s=45,
    )

    assert response.text == REAL_MEDIA_FIXTURE_RESPONSE


async def test_real_media_fixture_llm_does_not_cite_tool_error() -> None:
    chunks = await _chunks(
        _request(
            ModelMessage(role="user", content="What does this source say about SOFIA?"),
            ModelMessage(
                role="tool",
                tool_results=(
                    ToolResult(
                        call_id="real-media-fixture-app-search",
                        output='{"error":"search failed"}',
                        is_error=True,
                    ),
                ),
            ),
        )
    )

    assert chunks[0].delta_text == REAL_MEDIA_FIXTURE_RESPONSE
    assert chunks[1].done is True
