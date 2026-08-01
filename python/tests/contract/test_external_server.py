from __future__ import annotations

import asyncio
import hashlib
import http.client
import json
import wave
from collections.abc import AsyncIterator
from io import BytesIO
from pathlib import Path
from typing import Any
from urllib.parse import urlencode

import pytest
from provider_runtime import (
    CATALOG,
    AssistantMessage,
    CanonicalTool,
    ContinuationDelta,
    Dynamic,
    GenerateIntent,
    GlobalScope,
    Present,
    PromptBlock,
    ProviderTarget,
    Stable,
    StrictJsonOutput,
    Succeeded,
    SystemMessage,
    TerminalEvent,
    TextContent,
    TextOutput,
    ToolCallDone,
    ToolResultMessage,
    UserMessage,
    parse_canonical_schema,
)
from provider_runtime import openai as openai_codec
from provider_runtime.transport import SseEvent

from tests.testkit.external_server import (
    NASA_AUDIO_PATH,
    NASA_FEED_URL,
    NASA_TRANSCRIPT_URL,
    OPENAI_API_KEY,
    PODCAST_API_KEY,
    PODCAST_API_SECRET,
    running_external_protocol_server,
)

_FIXTURES = Path(__file__).parents[1] / "fixtures" / "real_media"
_TARGET = ProviderTarget(provider="openai", model="gpt-5.6-terra")
_SYSTEM_PROMPT = "Use app_search to answer from the attached source with citations."
_USER_PROMPT = "What did SOFIA establish about water in Clavius Crater? Use the attached source."


def _request(
    address: tuple[str, int],
    method: str,
    target: str,
    *,
    headers: dict[str, str] | None = None,
    body: bytes | None = None,
) -> tuple[int, dict[str, str], bytes]:
    connection = http.client.HTTPConnection(*address, timeout=2)
    try:
        connection.request(method, target, body=body, headers=headers or {})
        response = connection.getresponse()
        return (
            response.status,
            {name.lower(): value for name, value in response.getheaders()},
            response.read(),
        )
    finally:
        connection.close()


def _podcast_headers() -> dict[str, str]:
    auth_date = "1785456000"
    authorization = hashlib.sha1(
        f"{PODCAST_API_KEY}{PODCAST_API_SECRET}{auth_date}".encode()
    ).hexdigest()
    return {
        "X-Auth-Date": auth_date,
        "X-Auth-Key": PODCAST_API_KEY,
        "Authorization": authorization,
        "User-Agent": "nexus-podcast-client/1.0",
    }


def test_podcast_index_rss_and_transcript_are_one_authentic_local_protocol() -> None:
    with running_external_protocol_server(fixture_root=_FIXTURES) as address:
        assert address[0] == "127.0.0.1"
        status, _, body = _request(
            address,
            "GET",
            f"/search/byterm?{urlencode({'q': 'Houston We Have a Podcast', 'max': 20})}",
            headers=_podcast_headers(),
        )
        search = json.loads(body)
        assert status == 200
        assert search["feeds"] == [
            {
                "id": "nasa-hwhap-real-media",
                "title": "Houston We Have a Podcast",
                "author": "NASA Johnson Space Center",
                "url": NASA_FEED_URL,
                "link": "https://www.nasa.gov/podcasts/houston-we-have-a-podcast/",
                "image": None,
                "description": "NASA Johnson Space Center podcast.",
            }
        ]

        status, _, body = _request(
            address,
            "GET",
            "/podcasts/byfeedid?id=nasa-hwhap-real-media",
            headers=_podcast_headers(),
        )
        assert status == 200
        assert json.loads(body)["feed"] == search["feeds"][0]

        status, _, body = _request(
            address,
            "GET",
            f"/podcasts/byfeedurl?{urlencode({'url': NASA_FEED_URL})}",
            headers=_podcast_headers(),
        )
        assert status == 200
        assert json.loads(body)["feed"]["id"] == "nasa-hwhap-real-media"

        status, _, body = _request(
            address,
            "GET",
            "/episodes/byfeedid?id=nasa-hwhap-real-media&max=100",
            headers=_podcast_headers(),
        )
        episode = json.loads(body)["items"][0]
        assert status == 200
        assert episode["id"] == "nasa-hwhap-crew4"
        assert "transcript_segments" not in episode
        audio_url = f"http://{address[0]}:{address[1]}{NASA_AUDIO_PATH}"
        assert episode["enclosureUrl"] == audio_url

        status, _, body = _request(
            address,
            "GET",
            "/episodes/byid?id=nasa-hwhap-crew4",
            headers=_podcast_headers(),
        )
        assert status == 200
        assert json.loads(body)["episode"] == episode

        status, headers, feed = _request(
            address,
            "GET",
            NASA_FEED_URL,
            headers={"User-Agent": "nexus-podcast-client/1.0"},
        )
        assert status == 200
        assert headers["content-type"] == "application/rss+xml"
        assert b"<guid>nasa-hwhap-crew4</guid>" in feed
        assert f'<podcast:transcript url="{NASA_TRANSCRIPT_URL}"'.encode() in feed
        assert f'<enclosure url="{audio_url}" type="audio/wav"'.encode() in feed

        status, headers, transcript = _request(
            address,
            "GET",
            NASA_TRANSCRIPT_URL,
            headers={"User-Agent": "nexus-podcast-client/1.0"},
        )
        assert status == 200
        assert headers["content-type"] == "text/plain; charset=utf-8"
        assert transcript == (_FIXTURES / "nasa-hwhap-crew4-transcript.txt").read_bytes()

        status, headers, body = _request(address, "HEAD", NASA_AUDIO_PATH)
        assert status == 200
        assert headers["content-type"] == "audio/wav"
        assert headers["accept-ranges"] == "bytes"
        assert body == b""
        audio_size = int(headers["content-length"])

        status, headers, body = _request(
            address,
            "GET",
            NASA_AUDIO_PATH,
            headers={"Range": "bytes=0-4095"},
        )
        assert status == 206
        assert headers["content-range"] == f"bytes 0-4095/{audio_size}"
        assert len(body) == 4096

        status, _, audio = _request(address, "GET", NASA_AUDIO_PATH)
        assert status == 200
        with wave.open(BytesIO(audio), "rb") as wav:
            assert wav.getnchannels() == 1
            assert wav.getframerate() == 8_000
            assert wav.getnframes() / wav.getframerate() == 24


def test_openai_embedding_protocol_returns_index_complete_normalized_vectors() -> None:
    request = json.dumps(
        {
            "model": "text-embedding-3-small",
            "input": ["water on the moon", "water on the moon", "podcast transcript"],
            "dimensions": 16,
        },
        separators=(",", ":"),
    ).encode()
    with running_external_protocol_server(fixture_root=_FIXTURES) as address:
        status, _, body = _request(
            address,
            "POST",
            "/v1/embeddings",
            headers={
                "Authorization": f"Bearer {OPENAI_API_KEY}",
                "Content-Type": "application/json",
            },
            body=request,
        )

    response = json.loads(body)
    assert status == 200, f"embedding fixture rejected its canonical request: {response!r}"
    assert [row["index"] for row in response["data"]] == [0, 1, 2], (
        f"embedding fixture returned incomplete or reordered indexes: {response!r}"
    )
    vectors = [row["embedding"] for row in response["data"]]
    assert all(len(vector) == 16 for vector in vectors), (
        f"embedding fixture violated the requested dimensions: {vectors!r}"
    )
    assert vectors[0] == vectors[1] and vectors[0] != vectors[2], (
        f"embedding fixture was not stable and input-sensitive: {vectors!r}"
    )
    assert all(
        sum(value * value for value in vector) == pytest.approx(1.0) for vector in vectors
    ), f"embedding fixture returned non-normalized semantic vectors: {vectors!r}"
    assert response["usage"] == {"prompt_tokens": 10, "total_tokens": 10}, (
        f"embedding fixture returned an unexpected usage oracle: {response!r}"
    )


def _app_search_tool() -> CanonicalTool:
    nullable_strings = {"anyOf": [{"type": "array", "items": {"type": "string"}}, {"type": "null"}]}
    return CanonicalTool(
        name="app_search",
        description="Search attached Nexus evidence.",
        parameters=parse_canonical_schema(
            {
                "type": "object",
                "properties": {
                    "query": {"type": "string"},
                    "kinds": nullable_strings,
                    "formats": nullable_strings,
                    "authors": nullable_strings,
                    "roles": nullable_strings,
                    "scopes": nullable_strings,
                },
                "required": ["query", "kinds", "formats", "authors", "roles", "scopes"],
                "additionalProperties": False,
            }
        ),
    )


def _chat_messages() -> tuple[SystemMessage | UserMessage, ...]:
    return (
        SystemMessage(blocks=(PromptBlock(text=_SYSTEM_PROMPT, stability=Stable(GlobalScope())),)),
        UserMessage(blocks=(PromptBlock(text=_USER_PROMPT, stability=Dynamic()),)),
    )


def _encoded_body(
    *,
    messages: tuple[Any, ...],
    tools: tuple[CanonicalTool, ...],
    output: TextOutput | StrictJsonOutput,
    stream: bool,
) -> bytes:
    intent = GenerateIntent(
        target=_TARGET,
        messages=messages,
        max_output_tokens=1_000,
        reasoning="low",
        tools=tools,
        tool_choice="auto" if tools else "none",
        output=output,
    )
    request = openai_codec.finalize(
        openai_codec.encode(intent, CATALOG.chat_contract(_TARGET)),
        "nexus-fixture-affinity",
    )
    if stream:
        request = openai_codec.stream_request(request)
    return request.body


def _openai_request(address: tuple[str, int], body: bytes) -> tuple[int, dict[str, str], bytes]:
    return _request(
        address,
        "POST",
        "/v1/responses",
        headers={
            "Authorization": f"Bearer {OPENAI_API_KEY}",
            "Content-Type": "application/json",
        },
        body=body,
    )


def _sse_events(body: bytes) -> AsyncIterator[SseEvent]:
    async def events() -> AsyncIterator[SseEvent]:
        for raw_frame in body.decode().split("\n\n"):
            if not raw_frame:
                continue
            lines = [line.removeprefix("data: ") for line in raw_frame.splitlines()]
            yield SseEvent(event=None, data="\n".join(lines))

    return events()


def _decode_sse(headers: dict[str, str], body: bytes) -> list[Any]:
    async def decode() -> list[Any]:
        return [event async for event in openai_codec.decode_stream(headers, _sse_events(body))]

    return asyncio.run(decode())


def test_openai_stream_calls_app_search_then_returns_grounded_cited_text() -> None:
    tool = _app_search_tool()
    with running_external_protocol_server(fixture_root=_FIXTURES) as address:
        status, headers, body = _openai_request(
            address,
            _encoded_body(
                messages=_chat_messages(),
                tools=(tool,),
                output=TextOutput(),
                stream=True,
            ),
        )
        assert status == 200
        assert headers["content-type"] == "text/event-stream; charset=utf-8"
        first_events = _decode_sse(headers, body)
        tool_done = next(event for event in first_events if isinstance(event, ToolCallDone))
        continuation = next(
            event.artifact for event in first_events if isinstance(event, ContinuationDelta)
        )
        assert dict(tool_done.tool_call.arguments) == {
            "query": "SOFIA water Clavius Crater",
            "kinds": ["documents"],
            "formats": ["article"],
            "authors": None,
            "roles": None,
            "scopes": None,
        }
        first_terminal = next(
            event.outcome for event in first_events if isinstance(event, TerminalEvent)
        )
        assert isinstance(first_terminal, Succeeded)
        assert isinstance(first_terminal.response.content, TextContent)
        assert first_terminal.response.content.text == ""

        tool_output = json.dumps(
            {
                "results": [
                    {
                        "n": 3,
                        "title": "SOFIA Confirms Water on the Sunlit Moon",
                        "snippet": "SOFIA detected water molecules in Clavius Crater.",
                        "kind": "content_chunk",
                        "source_label": "NASA",
                    }
                ],
                "total_candidates": 1,
                "status": "success",
                "error_code": None,
            }
        )
        second_messages = (
            *_chat_messages(),
            AssistantMessage(
                text="",
                tool_calls=(tool_done.tool_call,),
                continuation=Present(continuation),
            ),
            ToolResultMessage(
                call_id=tool_done.tool_call.id,
                output=tool_output,
                is_error=False,
            ),
        )
        status, headers, body = _openai_request(
            address,
            _encoded_body(
                messages=second_messages,
                tools=(tool,),
                output=TextOutput(),
                stream=True,
            ),
        )
        assert status == 200
        second_events = _decode_sse(headers, body)
        second_terminal = next(
            event.outcome for event in second_events if isinstance(event, TerminalEvent)
        )
        assert isinstance(second_terminal, Succeeded)
        assert isinstance(second_terminal.response.content, TextContent)
        assert second_terminal.response.content.text == (
            "The source says SOFIA helped confirm water on the Moon by detecting a "
            "water signature in Clavius Crater. [3]"
        )


_STRICT_CASES = (
    (
        "media_metadata_enrichment",
        "Extract bibliographic and descriptive metadata for this media item.",
        {
            "title": {"anyOf": [{"type": "string"}, {"type": "null"}]},
            "authors": {
                "anyOf": [
                    {"type": "array", "items": {"type": "string"}},
                    {"type": "null"},
                ]
            },
            "publisher": {"anyOf": [{"type": "string"}, {"type": "null"}]},
            "description": {"anyOf": [{"type": "string"}, {"type": "null"}]},
            "published_date": {"anyOf": [{"type": "string"}, {"type": "null"}]},
            "language": {"anyOf": [{"type": "string"}, {"type": "null"}]},
        },
        {
            "title": "SOFIA Confirms Water on the Sunlit Moon",
            "authors": ["NASA"],
            "publisher": "NASA",
            "description": (
                "SOFIA detected a water signature in Clavius Crater, confirming that water "
                "exists on the sunlit surface of the Moon."
            ),
            "published_date": "2020-10",
            "language": "en",
        },
    ),
    (
        "MediaUnitSynthesis",
        "You are building a reusable unit for one document.",
        {
            "summary_md": {"type": "string"},
            "claims": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "claim_text": {"type": "string"},
                        "candidate_index": {"type": "integer"},
                    },
                    "required": ["claim_text", "candidate_index"],
                    "additionalProperties": False,
                },
            },
        },
        {
            "summary_md": (
                "The document reports that SOFIA confirmed water on the sunlit Moon, "
                "detecting a water signature in Clavius Crater."
            ),
            "claims": [
                {
                    "claim_text": (
                        "SOFIA detected a water signature in Clavius Crater, confirming "
                        "water on the sunlit Moon."
                    ),
                    "candidate_index": 0,
                }
            ],
        },
    ),
    (
        "SynapseSynthesis",
        "You are the resonance engine of a personal knowledge system.",
        {
            "connections": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "candidate_index": {"type": "integer"},
                        "kind": {
                            "type": "string",
                            "enum": ["context", "supports", "contradicts"],
                        },
                        "rationale": {"type": "string"},
                    },
                    "required": ["candidate_index", "kind", "rationale"],
                    "additionalProperties": False,
                },
            }
        },
        {"connections": []},
    ),
    (
        "StandardSynthesis",
        "You are an expert teacher and careful research writer.",
        {
            "content_html": {"type": "string"},
            "citations": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "ordinal": {"type": "integer"},
                        "candidate_index": {"type": "integer"},
                        "role": {"type": "string"},
                    },
                    "required": ["ordinal", "candidate_index", "role"],
                    "additionalProperties": False,
                },
            },
        },
        {
            "content_html": (
                '<article><section id="finding"><h2>Finding</h2><p>The fixture dossier '
                "records one grounded finding from the available source "
                '<cite data-nexus-citation="1"></cite>.</p></section></article>'
            ),
            "citations": [{"ordinal": 1, "candidate_index": 0, "role": "supports"}],
        },
    ),
    (
        "IdeaResolverEnvelope",
        "You resolve a selected phrase to one exact Idea identity.",
        {
            "kind": {"type": "string", "enum": ["Existing", "New", "Unresolved"]},
            "idea_subject_id": {"anyOf": [{"type": "string"}, {"type": "null"}]},
            "display_title": {"anyOf": [{"type": "string"}, {"type": "null"}]},
            "idea_key": {
                "anyOf": [
                    {
                        "type": "object",
                        "properties": {
                            "version": {"type": "string", "enum": ["v1"]},
                            "title_key": {"type": "string"},
                            "disambiguator_key": {"anyOf": [{"type": "string"}, {"type": "null"}]},
                        },
                        "required": ["version", "title_key", "disambiguator_key"],
                        "additionalProperties": False,
                    },
                    {"type": "null"},
                ]
            },
        },
        {
            "kind": "Unresolved",
            "idea_subject_id": None,
            "display_title": None,
            "idea_key": None,
        },
    ),
)


@pytest.mark.parametrize(
    ("name", "system_prompt", "properties", "expected"),
    _STRICT_CASES,
    ids=[case[0] for case in _STRICT_CASES],
)
def test_openai_nonstream_strict_outputs_decode_through_the_real_codec(
    name: str,
    system_prompt: str,
    properties: dict[str, Any],
    expected: dict[str, Any],
) -> None:
    schema = parse_canonical_schema(
        {
            "type": "object",
            "properties": properties,
            "required": list(properties),
            "additionalProperties": False,
        }
    )
    messages = (
        SystemMessage(blocks=(PromptBlock(text=system_prompt, stability=Stable(GlobalScope())),)),
        UserMessage(
            blocks=(
                PromptBlock(
                    text="CANDIDATES:\n[0] SOFIA detected water in Clavius Crater.",
                    stability=Dynamic(),
                ),
            )
        ),
    )
    with running_external_protocol_server(fixture_root=_FIXTURES) as address:
        status, headers, body = _openai_request(
            address,
            _encoded_body(
                messages=messages,
                tools=(),
                output=StrictJsonOutput(name=name, schema=schema),
                stream=False,
            ),
        )
    assert status == 200
    decoded = openai_codec.decode_response(status, headers, body)
    assert isinstance(decoded, Succeeded)
    assert isinstance(decoded.response.content, TextContent)
    assert json.loads(decoded.response.content.text) == expected


def test_unknown_paths_and_prompts_fail_closed() -> None:
    with running_external_protocol_server(fixture_root=_FIXTURES) as address:
        status, _, body = _request(
            address,
            "GET",
            "/not-a-provider-path",
            headers=_podcast_headers(),
        )
        assert status == 404
        assert json.loads(body) == {"error": {"code": "unknown_path"}}

        unknown_messages = (
            _chat_messages()[0],
            UserMessage(blocks=(PromptBlock(text="Tell me a joke.", stability=Dynamic()),)),
        )
        status, _, body = _openai_request(
            address,
            _encoded_body(
                messages=unknown_messages,
                tools=(_app_search_tool(),),
                output=TextOutput(),
                stream=True,
            ),
        )
        assert status == 422
        assert json.loads(body) == {"error": {"code": "unknown_chat_prompt"}}
