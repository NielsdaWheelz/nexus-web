"""Deterministic ``ExecutionRuntime`` for real-media fixture runs.

Implements the structural ``ExecutionRuntime`` seam
(``nexus.services.llm_execution.ExecutionRuntime``) that
``nexus.tasks.llm_task`` constructs in place of
``ProductionExecutionRuntime`` when ``settings.real_media_provider_fixtures``
is set. Unlike the production runtime, which ignores ``intent`` and dispatches
the finalized ``plan``, this fixture scripts its outcome from the *typed*
``GenerateIntent`` — content-conditional canned responses keyed on system
prompt markers and app-search tool-call state, restoring the pre-cutover
``RealMediaFixtureModelRuntime`` ergonomics against the new type surface.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
from collections.abc import AsyncIterator, Awaitable
from typing import cast

from provider_runtime import (
    Absent,
    AssistantMessage,
    CallMeta,
    CallOutcome,
    CancelSignal,
    FinalizedProviderCall,
    GenerateIntent,
    PossiblyBillable,
    Present,
    PromptMessage,
    ProviderCredential,
    ResponsePayload,
    RuntimeStreamEvent,
    StrictJsonOutput,
    StructuredContent,
    Succeeded,
    SystemMessage,
    TerminalEvent,
    TextContent,
    TextDelta,
    ToolCall,
    ToolCallDone,
    ToolCallStart,
    ToolResultMessage,
    UserMessage,
)
from provider_runtime import Cancelled as CancelledOutcome
from provider_runtime import TokenUsage as _TokenUsage


class RealMediaFixtureExecutionRuntime:
    """The fixture ``ExecutionRuntime``: scripts outcomes from ``intent``,
    ignoring ``plan``/``credential`` (never reaches a real provider)."""

    async def generate(
        self,
        intent: GenerateIntent,
        plan: FinalizedProviderCall,
        credential: ProviderCredential,
    ) -> CallOutcome:
        _ = plan, credential
        if isinstance(intent.output, StrictJsonOutput):
            # Production plans output_kind="strict_json" to StructuredContent on
            # every Succeeded outcome (decode_structured_synthesis asserts on
            # it) — the fixture must uphold the same contract. A marker miss
            # here means a structured-synthesis owner reaches generate() with
            # no canned payload for it; that is a coverage gap in
            # `_SYNTHESIS_MARKERS`, not a runtime the caller should silently
            # fall back from.
            canned_json = _synthesis_response(intent)
            if canned_json is None:
                raise AssertionError(
                    "real-media fixture: no _SYNTHESIS_MARKERS entry matched a "
                    "StrictJsonOutput intent's system prompt"
                )
            return Succeeded(
                meta=_meta(intent, canned_json),
                response=ResponsePayload(
                    content=StructuredContent(payload=json.loads(canned_json), text=canned_json),
                    continuation=Absent(),
                ),
            )
        text = _synthesis_response(intent) or REAL_MEDIA_FIXTURE_RESPONSE
        return Succeeded(
            meta=_meta(intent, text),
            response=ResponsePayload(
                content=TextContent(text=text, tool_calls=()), continuation=Absent()
            ),
        )

    def stream(
        self,
        intent: GenerateIntent,
        plan: FinalizedProviderCall,
        credential: ProviderCredential,
        *,
        cancel: CancelSignal | None,
    ) -> AsyncIterator[RuntimeStreamEvent]:
        _ = plan, credential
        return _stream(intent, cancel)


APP_SEARCH_TOOL_NAME = "app_search"
_ABOUT_QUERY_RE = re.compile(r"\babout\s+(.+?)\?\s*(?:use\b|$)", re.IGNORECASE)
REAL_MEDIA_FIXTURE_RESPONSE = (
    "The source says SOFIA helped confirm water on the Moon by detecting a "
    "water signature in Clavius Crater."
)
REAL_MEDIA_FIXTURE_RESPONSE_WITH_CITATION = REAL_MEDIA_FIXTURE_RESPONSE + " [1]"

# Canned strict-JSON structured-synthesis outputs, keyed on the spec-pinned
# persona opening of each synthesis system prompt. Indices are the lowest that
# every call site guarantees: oracle fails the reading before synthesis when
# fewer than 3 candidates exist (its validator demands 3 distinct in-range
# indices), and LI reduce / media-unit build fail before synthesis on an empty
# candidate list, so index 0 always grounds. metadata_enrichment has no
# candidate-count gate at all (see below); synapse_scan grounds nothing
# (its canned response is the empty-connections list its own domain rules
# call "a good answer").
ORACLE_SYNTHESIS_FIXTURE_RESPONSE = json.dumps(
    {
        "argument": (
            "Of the steady lamp the fixture keeps, and the deterministic road "
            "it lights through the dark of every run."
        ),
        "folio_motto": "Lumen In Tenebris",
        "folio_motto_gloss": "A light in the darkness.",
        "folio_theme": "Of the Threshold",
        "passages": [
            {
                "phase": "descent",
                "candidate_index": 0,
                "marginalia": "The descent names the question's first shadow.",
            },
            {
                "phase": "ordeal",
                "candidate_index": 1,
                "marginalia": "The ordeal holds the matter at its standstill.",
            },
            {
                "phase": "ascent",
                "candidate_index": 2,
                "marginalia": "The ascent shows what the dawn gives to see.",
            },
        ],
        "interpretation": (
            "I saw a lamp carried through a quiet archive, and every record "
            "answered in its appointed order."
        ),
        "omens": ["a lamp in the archive", "an index that holds", "a door opening on order"],
    }
)
LIBRARY_REDUCE_SYNTHESIS_FIXTURE_RESPONSE = json.dumps(
    {
        "content_md": (
            "This library centers on one documented finding: SOFIA confirmed water "
            "on the sunlit Moon by detecting a water signature in Clavius Crater [1]. "
            "Start with that source; the fixture corpus raises no cross-source "
            "tensions or open questions."
        ),
        "citations": [{"ordinal": 1, "claim_index": 0, "role": "supports"}],
    }
)
MEDIA_UNIT_SYNTHESIS_FIXTURE_RESPONSE = json.dumps(
    {
        "summary_md": (
            "The document reports that SOFIA confirmed water on the sunlit Moon, "
            "detecting a water signature in Clavius Crater."
        ),
        "claims": [
            {
                "claim_text": (
                    "SOFIA detected a water signature in Clavius Crater, "
                    "confirming water on the sunlit Moon."
                ),
                "candidate_index": 0,
            }
        ],
    }
)
# enrich_metadata calls execute_generation unconditionally (no candidate-count
# gate — see nexus/tasks/enrich_metadata.py), so every real-media ingest
# reaches this marker. Fields satisfy MetadataEnrichmentOutput's validators
# (non-empty strings, ISO published_date, ISO 639-1 language).
METADATA_ENRICHMENT_SYNTHESIS_FIXTURE_RESPONSE = json.dumps(
    {
        "title": "SOFIA Confirms Water on the Sunlit Moon",
        "authors": ["NASA"],
        "publisher": "NASA",
        "description": (
            "SOFIA detected a water signature in Clavius Crater, confirming "
            "that water exists on the sunlit surface of the Moon."
        ),
        "published_date": "2020-10",
        "language": "en",
    }
)
# synapse_scan skips synthesis on an empty candidate list (nexus/services/
# synapse.py) but the seeded real-media corpus (epub/pdf/podcast/video/
# web_article, ingested together) gives every scanned item sibling
# candidates, so this marker is reachable. "An empty list is a good answer"
# is an explicit domain rule, so the canned response needs no candidate
# grounding.
SYNAPSE_SYNTHESIS_FIXTURE_RESPONSE = json.dumps({"connections": []})
_SYNTHESIS_MARKERS: tuple[tuple[str, str], ...] = (
    ("You are the Black Forest Oracle", ORACLE_SYNTHESIS_FIXTURE_RESPONSE),
    (
        "whole-library synthesis from per-document claims",
        LIBRARY_REDUCE_SYNTHESIS_FIXTURE_RESPONSE,
    ),
    ("building a reusable unit for one document", MEDIA_UNIT_SYNTHESIS_FIXTURE_RESPONSE),
    (
        "Extract bibliographic and descriptive metadata for this media item",
        METADATA_ENRICHMENT_SYNTHESIS_FIXTURE_RESPONSE,
    ),
    (
        "You are the resonance engine of a personal knowledge system",
        SYNAPSE_SYNTHESIS_FIXTURE_RESPONSE,
    ),
)


async def _stream(
    intent: GenerateIntent, cancel: CancelSignal | None
) -> AsyncIterator[RuntimeStreamEvent]:
    if _should_request_app_search(intent):
        query = _latest_user_query(intent)
        yield RuntimeStreamEvent(
            seq=1,
            event=ToolCallStart(call_id="real-media-fixture-app-search", name=APP_SEARCH_TOOL_NAME),
        )
        if await _cancelled_during_fixture_delay(cancel):
            yield RuntimeStreamEvent(seq=2, event=TerminalEvent(outcome=_cancelled(intent)))
            return
        yield RuntimeStreamEvent(
            seq=2,
            event=ToolCallDone(
                tool_call=ToolCall(
                    id="real-media-fixture-app-search",
                    name=APP_SEARCH_TOOL_NAME,
                    arguments={"query": query},
                )
            ),
        )
        yield RuntimeStreamEvent(seq=3, event=TerminalEvent(outcome=_succeeded(intent, "")))
        return

    response = (
        REAL_MEDIA_FIXTURE_RESPONSE_WITH_CITATION
        if _has_citable_tool_result(intent) or _has_numbered_prompt_resource(intent)
        else REAL_MEDIA_FIXTURE_RESPONSE
    )
    parts = [
        "The source says SOFIA ",
        "helped confirm water on the Moon ",
        "by detecting a water signature ",
        "in Clavius Crater.",
    ]
    if response.endswith(" [1]"):
        parts[-1] += " [1]"
    seq = 1
    for text in parts:
        yield RuntimeStreamEvent(seq=seq, event=TextDelta(text=text))
        seq += 1
        if await _cancelled_during_fixture_delay(cancel):
            yield RuntimeStreamEvent(seq=seq, event=TerminalEvent(outcome=_cancelled(intent)))
            return
    yield RuntimeStreamEvent(seq=seq, event=TerminalEvent(outcome=_succeeded(intent, response)))


def _succeeded(intent: GenerateIntent, text: str) -> Succeeded:
    return Succeeded(
        meta=_meta(intent, text),
        response=ResponsePayload(
            content=TextContent(text=text, tool_calls=()), continuation=Absent()
        ),
    )


def _cancelled(intent: GenerateIntent) -> CancelledOutcome:
    return CancelledOutcome(meta=_meta(intent, ""))


def _meta(intent: GenerateIntent, response_text: str) -> CallMeta:
    return CallMeta(
        provider=intent.target.provider,
        model=intent.target.model,
        provider_request_id=Present("real-media-fixture"),
        upstream_provider=Absent(),
        usage=Present(_usage_for(intent, response_text)),
        attempt_trace=(),
        billability=PossiblyBillable(),
    )


def _message_text(message: PromptMessage) -> str:
    if isinstance(message, SystemMessage | UserMessage):
        return " ".join(block.text for block in message.blocks)
    if isinstance(message, AssistantMessage):
        return message.text
    return message.output  # ToolResultMessage


def _synthesis_response(intent: GenerateIntent) -> str | None:
    system_text = "\n".join(
        _message_text(message) for message in intent.messages if isinstance(message, SystemMessage)
    )
    for marker, response in _SYNTHESIS_MARKERS:
        if marker in system_text:
            return response
    return None


def _should_request_app_search(intent: GenerateIntent) -> bool:
    return (
        not _has_tool_result(intent)
        and any(tool.name == APP_SEARCH_TOOL_NAME for tool in intent.tools)
        and bool(_latest_user_query(intent).strip())
    )


def _has_tool_result(intent: GenerateIntent) -> bool:
    return any(isinstance(message, ToolResultMessage) for message in intent.messages)


def _has_citable_tool_result(intent: GenerateIntent) -> bool:
    for message in intent.messages:
        if not isinstance(message, ToolResultMessage) or message.is_error:
            continue
        if _tool_output_has_numbered_result(message.output):
            return True
    return False


def _has_numbered_prompt_resource(intent: GenerateIntent) -> bool:
    # Production renders `<resource n="..">` blocks into a SystemMessage
    # (context_assembler._build_resources_block -> chat_prompt
    # dynamic_system_blocks), not a UserMessage — scan both.
    for message in intent.messages:
        if not isinstance(message, SystemMessage | UserMessage):
            continue
        for block in message.blocks:
            if re.search(r'<resource\b[^>]*\bn="\d+"', block.text):
                return True
    return False


def _tool_output_has_numbered_result(output: str) -> bool:
    try:
        payload = json.loads(output)
    except json.JSONDecodeError:
        return False
    if not isinstance(payload, dict):
        return False
    results = payload.get("results")
    if not isinstance(results, list):
        return False
    for item in results:
        if not isinstance(item, dict):
            continue
        n = item.get("n")
        if isinstance(n, int) and n > 0:
            return True
    return False


def _latest_user_query(intent: GenerateIntent) -> str:
    for message in reversed(intent.messages):
        if not isinstance(message, UserMessage):
            continue
        content = " ".join(block.text for block in message.blocks).strip()
        if not content:
            continue
        match = _ABOUT_QUERY_RE.search(content)
        if match:
            return match.group(1).strip()
        return content
    return "attached evidence"


async def _cancelled_during_fixture_delay(cancel: CancelSignal | None) -> bool:
    raw_delay = os.environ.get("REAL_MEDIA_FIXTURE_STREAM_DELAY_MS")
    if raw_delay is None:
        return False
    delay = max(0.0, float(raw_delay) / 1000)
    if delay == 0:
        return False
    if cancel is None:
        await asyncio.sleep(delay)
        return False
    try:
        await asyncio.wait_for(cast(Awaitable[object], cancel.wait()), timeout=delay)
        return True
    except TimeoutError:
        return False


def _usage_for(intent: GenerateIntent, response: str) -> _TokenUsage:
    prompt_chars = sum(len(_message_text(message)) for message in intent.messages)
    input_tokens = max(1, prompt_chars // 4)
    output_tokens = max(1, len(response) // 4)
    return _TokenUsage(
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        total_tokens=input_tokens + output_tokens,
        reasoning_tokens=Absent(),
        cache_read_input_tokens=Absent(),
        cache_write_input_tokens=Absent(),
    )
