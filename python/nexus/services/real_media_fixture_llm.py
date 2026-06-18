"""Deterministic LLM boundary for real-media fixture runs."""

import asyncio
import json
import os
import re
from collections.abc import AsyncIterator, Awaitable
from typing import cast

from provider_runtime import ProviderApiKey
from provider_runtime.types import ModelCall, ModelResponse, ModelStreamEvent, TokenUsage, ToolCall


class RealMediaFixtureModelRuntime:
    def __init__(
        self,
        *,
        enable_openai: bool = True,
        enable_anthropic: bool = True,
        enable_gemini: bool = True,
        enable_openrouter: bool = True,
        enable_cloudflare: bool = True,
    ) -> None:
        self._enabled = {
            "openai": enable_openai,
            "anthropic": enable_anthropic,
            "gemini": enable_gemini,
            "openrouter": enable_openrouter,
            "cloudflare": enable_cloudflare,
        }

    def is_provider_available(self, provider: str) -> bool:
        return bool(self._enabled.get(provider, False))

    async def generate(
        self,
        req: ModelCall,
        *,
        key: ProviderApiKey,
        timeout_s: float,
    ) -> ModelResponse:
        _ = key
        text = _synthesis_response(req) or REAL_MEDIA_FIXTURE_RESPONSE
        return ModelResponse(
            text=text,
            usage=_usage_for(req, text),
            provider_request_id="real-media-fixture",
            status="completed",
        )

    async def stream(
        self,
        req: ModelCall,
        *,
        key: ProviderApiKey,
        timeout_s: float,
        cancel: object | None = None,
    ) -> AsyncIterator[ModelStreamEvent]:
        _ = key, timeout_s
        if _should_request_app_search(req):
            query = _latest_user_query(req)
            yield ModelStreamEvent(
                type="tool_call_start",
                sequence=1,
                provider=req.model.provider,
                model=req.model.model,
                route=req.model.route,
                tool_call_id="real-media-fixture-app-search",
                tool_name=APP_SEARCH_TOOL_NAME,
            )
            if await _cancelled_during_fixture_delay(cancel):
                yield _cancelled_event(req, 2)
                return
            yield ModelStreamEvent(
                type="tool_call_delta",
                sequence=2,
                provider=req.model.provider,
                model=req.model.model,
                route=req.model.route,
                tool_call_id="real-media-fixture-app-search",
                tool_name=APP_SEARCH_TOOL_NAME,
                tool_arguments_delta=query,
                tool_arguments_partial={"query": query},
            )
            if await _cancelled_during_fixture_delay(cancel):
                yield _cancelled_event(req, 3)
                return
            yield ModelStreamEvent(
                type="tool_call_done",
                sequence=3,
                provider=req.model.provider,
                model=req.model.model,
                route=req.model.route,
                tool_call_id="real-media-fixture-app-search",
                tool_call=ToolCall(
                    id="real-media-fixture-app-search",
                    name=APP_SEARCH_TOOL_NAME,
                    arguments={"query": query},
                ),
            )
            yield ModelStreamEvent(
                type="completed",
                sequence=4,
                provider=req.model.provider,
                model=req.model.model,
                route=req.model.route,
                usage=_usage_for(req, ""),
                provider_request_id="real-media-fixture",
                status="completed",
            )
            return

        response = (
            REAL_MEDIA_FIXTURE_RESPONSE_WITH_CITATION
            if _has_citable_tool_result(req) or _has_numbered_prompt_resource(req)
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
        for index, text in enumerate(parts, start=1):
            yield ModelStreamEvent(
                type="text_delta",
                sequence=index,
                provider=req.model.provider,
                model=req.model.model,
                route=req.model.route,
                text=text,
            )
            if await _cancelled_during_fixture_delay(cancel):
                yield _cancelled_event(req, index + 1)
                return
        yield ModelStreamEvent(
            type="completed",
            sequence=len(parts) + 1,
            provider=req.model.provider,
            model=req.model.model,
            route=req.model.route,
            usage=_usage_for(req, response),
            provider_request_id="real-media-fixture",
            status="completed",
        )


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
# candidate list, so index 0 always grounds.
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
_SYNTHESIS_MARKERS: tuple[tuple[str, str], ...] = (
    ("You are the Black Forest Oracle", ORACLE_SYNTHESIS_FIXTURE_RESPONSE),
    (
        "whole-library synthesis from per-document claims",
        LIBRARY_REDUCE_SYNTHESIS_FIXTURE_RESPONSE,
    ),
    ("building a reusable unit for one document", MEDIA_UNIT_SYNTHESIS_FIXTURE_RESPONSE),
)


def _synthesis_response(req: ModelCall) -> str | None:
    system = next((turn.content for turn in req.messages if turn.role == "system"), "")
    for marker, response in _SYNTHESIS_MARKERS:
        if marker in system:
            return response
    return None


def _should_request_app_search(req: ModelCall) -> bool:
    return (
        not _has_tool_result(req)
        and any(tool.name == APP_SEARCH_TOOL_NAME for tool in req.tools)
        and bool(_latest_user_query(req).strip())
    )


def _has_tool_result(req: ModelCall) -> bool:
    return any(turn.role == "tool" and turn.tool_results for turn in req.messages)


def _has_citable_tool_result(req: ModelCall) -> bool:
    for turn in req.messages:
        if turn.role != "tool":
            continue
        for result in turn.tool_results:
            if result.is_error:
                continue
            if _tool_output_has_numbered_result(result.output):
                return True
    return False


def _has_numbered_prompt_resource(req: ModelCall) -> bool:
    return any(re.search(r'<resource\b[^>]*\bn="\d+"', turn.content) for turn in req.messages)


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


def _latest_user_query(req: ModelCall) -> str:
    for turn in reversed(req.messages):
        if turn.role == "user" and turn.content.strip():
            content = turn.content.strip()
            match = _ABOUT_QUERY_RE.search(content)
            if match:
                return match.group(1).strip()
            return content
    return "attached evidence"


async def _cancelled_during_fixture_delay(cancel: object | None) -> bool:
    raw_delay = os.environ.get("REAL_MEDIA_FIXTURE_STREAM_DELAY_MS")
    if raw_delay is None:
        return False
    delay = max(0.0, float(raw_delay) / 1000)
    if delay == 0:
        return False
    wait = getattr(cancel, "wait", None)
    if callable(wait):
        try:
            await asyncio.wait_for(cast(Awaitable[object], wait()), timeout=delay)
            return True
        except TimeoutError:
            return False
    await asyncio.sleep(delay)
    is_set = getattr(cancel, "is_set", None)
    return bool(is_set()) if callable(is_set) else False


def _cancelled_event(req: ModelCall, sequence: int) -> ModelStreamEvent:
    return ModelStreamEvent(
        type="cancelled",
        sequence=sequence,
        provider=req.model.provider,
        model=req.model.model,
        route=req.model.route,
        usage=_usage_for(req, ""),
        provider_request_id="real-media-fixture",
    )


def _usage_for(req: ModelCall, response: str) -> TokenUsage:
    input_tokens = max(1, sum(len(turn.content) for turn in req.messages) // 4)
    output_tokens = max(1, len(response) // 4)
    return TokenUsage(
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        total_tokens=input_tokens + output_tokens,
        reasoning_tokens=0,
    )
