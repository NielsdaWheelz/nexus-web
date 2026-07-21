import asyncio
from typing import cast
from uuid import uuid4

import pytest
from provider_runtime import (
    Cancelled,
    CancelSignal,
    CanonicalTool,
    Dynamic,
    FinalizedProviderCall,
    GenerateIntent,
    GlobalScope,
    OutputSpec,
    PromptBlock,
    PromptMessage,
    ProviderCredential,
    RuntimeStreamEvent,
    Stable,
    StrictJsonOutput,
    Succeeded,
    SystemMessage,
    TerminalEvent,
    TextContent,
    TextDelta,
    TextOutput,
    ToolCallDone,
    ToolCallStart,
    ToolResultMessage,
    UserMessage,
    parse_canonical_schema,
)
from pydantic import BaseModel

from nexus.services.artifacts.reducers.library_dossier import (
    _LI_SYSTEM_PROMPT,
    _LiSynthesis,
    _map_li_citations,
)
from nexus.services.artifacts.reducers.library_dossier import (
    _Candidate as LiCandidate,
)
from nexus.services.llm_profiles import profile as profile_lookup
from nexus.services.media_intelligence import (
    _MEDIA_UNIT_SYSTEM_PROMPT,
    MediaUnitSynthesis,
    _map_claims_to_spans,
)
from nexus.services.media_intelligence import (
    _Candidate as MediaUnitCandidate,
)
from nexus.services.metadata_enrichment import (
    _ENRICHMENT_SYSTEM_PROMPT,
    MetadataEnrichmentOutput,
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
    RealMediaFixtureExecutionRuntime,
)
from nexus.services.resource_graph.refs import ResourceRef
from nexus.services.structured_synthesis import decode_structured_synthesis
from nexus.services.synapse import _SYNAPSE_SYSTEM_PROMPT, SynapseSynthesis

pytestmark = [pytest.mark.unit, pytest.mark.asyncio]

# `.generate`/`.stream` explicitly discard `plan`/`credential` (the fixture
# scripts outcomes purely from `intent`), so one placeholder pair suffices
# for every call in this file.
_PLAN = cast(FinalizedProviderCall, None)
_CREDENTIAL = cast(ProviderCredential, None)

_TARGET = profile_lookup("fast").target
_TOOL_CALL_ID = "real-media-fixture-app-search"
_APP_SEARCH_TOOLS = (
    CanonicalTool(
        name=APP_SEARCH_TOOL_NAME,
        description="Search saved content.",
        parameters={"type": "object"},
    ),
)
_TEXT_OUTPUT = TextOutput()


def _intent(
    *messages: PromptMessage,
    tools: tuple[CanonicalTool, ...] = _APP_SEARCH_TOOLS,
    output: OutputSpec = _TEXT_OUTPUT,
) -> GenerateIntent:
    return GenerateIntent(
        target=_TARGET,
        messages=messages,
        max_output_tokens=1024,
        reasoning=profile_lookup("fast").default_reasoning_option_id,
        tools=tools,
        tool_choice="auto" if tools else "none",
        output=output,
    )


def _user(text: str) -> UserMessage:
    return UserMessage(blocks=(PromptBlock(text=text, stability=Dynamic()),))


def _system(text: str) -> SystemMessage:
    return SystemMessage(blocks=(PromptBlock(text=text, stability=Stable(GlobalScope())),))


def _tool_result(output: str, *, is_error: bool = False) -> ToolResultMessage:
    return ToolResultMessage(call_id=_TOOL_CALL_ID, output=output, is_error=is_error)


async def _stream_events(
    intent: GenerateIntent, *, cancel: CancelSignal | None = None
) -> list[RuntimeStreamEvent]:
    runtime = RealMediaFixtureExecutionRuntime()
    return [event async for event in runtime.stream(intent, _PLAN, _CREDENTIAL, cancel=cancel)]


def _streamed_text(events: list[RuntimeStreamEvent]) -> str:
    return "".join(event.event.text for event in events if isinstance(event.event, TextDelta))


async def test_real_media_fixture_llm_uses_app_search_before_answering() -> None:
    events = await _stream_events(
        _intent(_user("What does this source say about SOFIA? Use the attached evidence."))
    )

    assert len(events) == 3
    assert events[0].seq == 1
    assert isinstance(events[0].event, ToolCallStart)
    assert events[0].event.name == APP_SEARCH_TOOL_NAME

    assert events[1].seq == 2
    assert isinstance(events[1].event, ToolCallDone)
    assert events[1].event.tool_call.name == APP_SEARCH_TOOL_NAME
    assert events[1].event.tool_call.arguments == {"query": "SOFIA"}

    assert events[2].seq == 3
    assert isinstance(events[2].event, TerminalEvent)
    assert isinstance(events[2].event.outcome, Succeeded)


async def test_real_media_fixture_llm_cancel_event_matches_provider_contract(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("REAL_MEDIA_FIXTURE_STREAM_DELAY_MS", "1")
    cancel = asyncio.Event()
    cancel.set()

    events = await _stream_events(
        _intent(_user("What does this source say about SOFIA? Use the attached evidence.")),
        cancel=cancel,
    )

    assert len(events) == 2
    assert isinstance(events[0].event, ToolCallStart)
    assert events[1].seq == 2
    assert isinstance(events[1].event, TerminalEvent)
    assert isinstance(events[1].event.outcome, Cancelled)
    assert events[1].event.outcome.meta.provider == _TARGET.provider
    assert events[1].event.outcome.meta.model == _TARGET.model


async def test_real_media_fixture_llm_cites_tool_result() -> None:
    events = await _stream_events(
        _intent(
            _user("What does this source say about SOFIA?"),
            _tool_result('{"results":[{"n":1}]}'),
        )
    )

    assert isinstance(events[0].event, TextDelta)
    assert _streamed_text(events) == REAL_MEDIA_FIXTURE_RESPONSE_WITH_CITATION
    terminal = events[-1].event
    assert isinstance(terminal, TerminalEvent)
    assert isinstance(terminal.outcome, Succeeded)


async def test_real_media_fixture_llm_cites_numbered_prompt_resource() -> None:
    # Production renders `<resource n="..">` blocks into a SystemMessage
    # (context_assembler._build_resources_block -> chat_prompt
    # dynamic_system_blocks), not a UserMessage.
    events = await _stream_events(
        _intent(
            _system('<resources><resource uri="content_chunk:1" n="1">text</resource></resources>'),
            _user("What does this source say about SOFIA?"),
            _tool_result('{"results":[],"total_candidates":0,"status":"empty"}'),
        )
    )

    assert isinstance(events[0].event, TextDelta)
    assert _streamed_text(events) == REAL_MEDIA_FIXTURE_RESPONSE_WITH_CITATION
    assert isinstance(events[-1].event, TerminalEvent)


async def test_real_media_fixture_llm_does_not_cite_empty_tool_result() -> None:
    events = await _stream_events(
        _intent(
            _user("What does this source say about SOFIA?"),
            _tool_result('{"results":[],"total_candidates":0,"status":"empty"}'),
        )
    )

    assert isinstance(events[0].event, TextDelta)
    assert _streamed_text(events) == REAL_MEDIA_FIXTURE_RESPONSE
    assert isinstance(events[-1].event, TerminalEvent)


async def test_real_media_fixture_llm_does_not_cite_tool_error() -> None:
    events = await _stream_events(
        _intent(
            _user("What does this source say about SOFIA?"),
            _tool_result('{"error":"search failed"}', is_error=True),
        )
    )

    assert isinstance(events[0].event, TextDelta)
    assert _streamed_text(events) == REAL_MEDIA_FIXTURE_RESPONSE
    assert isinstance(events[-1].event, TerminalEvent)


async def test_real_media_fixture_llm_generate_without_marker_keeps_chat_response() -> None:
    runtime = RealMediaFixtureExecutionRuntime()

    outcome = await runtime.generate(
        _intent(_user("What does this source say about SOFIA?")), _PLAN, _CREDENTIAL
    )

    assert isinstance(outcome, Succeeded)
    content = outcome.response.content
    assert isinstance(content, TextContent)
    assert content.text == REAL_MEDIA_FIXTURE_RESPONSE
    assert content.tool_calls == ()


def _strict_json_output(schema: type[BaseModel]) -> StrictJsonOutput:
    return StrictJsonOutput(
        name=schema.__name__, schema=parse_canonical_schema(schema.model_json_schema())
    )


async def _synthesize[T: BaseModel](system_prompt: str, *, schema: type[T]) -> T:
    """Run `generate` against a synthesis-marker intent and decode the outcome
    through the REAL `structured_synthesis.decode_structured_synthesis`, the
    same path every structured-synthesis owner (oracle, LI reduce,
    media-unit, metadata enrichment, synapse) uses in production. This
    exercises the fixture's `StrictJsonOutput` -> `StructuredContent`
    contract, not just its canned JSON text.
    """
    runtime = RealMediaFixtureExecutionRuntime()
    outcome = await runtime.generate(
        _intent(
            _system(system_prompt),
            _user("CANDIDATES:\n[0] alpha\n\nRespond with the strict JSON object as instructed."),
            tools=(),
            output=_strict_json_output(schema),
        ),
        _PLAN,
        _CREDENTIAL,
    )
    assert isinstance(outcome, Succeeded)
    return decode_structured_synthesis(outcome, schema=schema)


async def test_real_media_fixture_llm_generate_strict_json_without_marker_raises() -> None:
    runtime = RealMediaFixtureExecutionRuntime()

    with pytest.raises(AssertionError, match="no _SYNTHESIS_MARKERS entry matched"):
        await runtime.generate(
            _intent(
                _system("You are an unregistered synthesis persona."),
                _user("Respond with the strict JSON object as instructed."),
                tools=(),
                output=_strict_json_output(MetadataEnrichmentOutput),
            ),
            _PLAN,
            _CREDENTIAL,
        )


async def test_real_media_fixture_llm_oracle_synthesis_passes_real_validator() -> None:
    value = await _synthesize(_ORACLE_SYSTEM_PROMPT, schema=_OracleSynthesisOutput)

    # Oracle invokes synthesis only with >= 3 candidates; validate at that minimum.
    candidates = [
        OracleCandidate(
            source_kind="public_domain",
            exact_snippet=snippet,
            locator_label="Inferno",
            attribution_text="Dante Alighieri",
            deep_link=None,
            title="Inferno",
            target=ResourceRef(scheme="oracle_passage_anchor", id=uuid4()),
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
    value = await _synthesize(_LI_SYSTEM_PROMPT, schema=_LiSynthesis)

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
    value = await _synthesize(_MEDIA_UNIT_SYSTEM_PROMPT, schema=MediaUnitSynthesis)

    candidate = MediaUnitCandidate(evidence_span_id=uuid4(), text="chunk")
    grounded = _map_claims_to_spans(value, [candidate])

    assert value.summary_md.strip()
    assert grounded == [(value.claims[0].claim_text, candidate.evidence_span_id, 0)]


async def test_real_media_fixture_llm_metadata_enrichment_synthesis_validates() -> None:
    # enrich_metadata calls execute_generation unconditionally (no
    # candidate-count gate), so this marker is reachable on every real-media
    # ingest — see nexus/tasks/enrich_metadata.py.
    value = await _synthesize(_ENRICHMENT_SYSTEM_PROMPT, schema=MetadataEnrichmentOutput)

    assert value.title
    assert value.authors
    assert value.language == "en"


async def test_real_media_fixture_llm_synapse_synthesis_validates() -> None:
    # synapse_scan skips synthesis on an empty candidate list, but the seeded
    # real-media corpus gives every scanned item sibling candidates. The
    # canned response is the empty-connections list synapse's own domain
    # rules call "a good answer", so it needs no candidate to ground against.
    value = await _synthesize(_SYNAPSE_SYSTEM_PROMPT, schema=SynapseSynthesis)

    assert value.connections == []
