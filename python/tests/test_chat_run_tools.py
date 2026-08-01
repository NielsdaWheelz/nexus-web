"""Pure-function contracts for the chat-run tool dispatch/output owner.

``chat_run_tools`` owns the ``message_tool_calls`` lifecycle and tool-output
rendering, extracted verbatim from ``chat_runs.py``. The DB-mutating persisters
(``persist_tool_call_*``, ``bind_provider_tool_call_events``) are exercised by the
integration suite (``test_chat_runs.py`` / ``test_attached_citations.py``); this
file pins the pure pieces — the tool-output JSON shapes and the event payload
builders — plus an import-smoke that the public API stayed put after the
extraction.
"""

from __future__ import annotations

import json
from types import SimpleNamespace
from uuid import uuid4

from nexus.services import chat_run_tools
from nexus.services.chat_run_citations import (
    CitationCandidateNumbering,
    NumberedCitationCandidate,
)


def test_public_api_surface() -> None:
    """The executor-called names are public on the extracted module."""
    for name in (
        "app_search_tool_output",
        "persist_tool_call_start",
        "persist_tool_call_error",
        "bind_provider_tool_call_events",
        "persist_tool_call_trace",
        "tool_trace_event",
    ):
        assert callable(getattr(chat_run_tools, name)), name


def test_app_search_tool_output_numbers_only_citable_rows() -> None:
    """A citable row consumes the next ``n``; an uncitable row is unnumbered."""
    run_result = SimpleNamespace(
        selected_citations=[
            SimpleNamespace(
                citation_target="media:x",
                title="Citable",
                snippet="snip-1",
                result_type="media",
                source_label="Lib",
            ),
            SimpleNamespace(
                citation_target=None,
                title="Uncitable",
                snippet="snip-2",
                result_type="conversation",
                source_label=None,
            ),
        ],
        citations=[1, 2, 3],
        status="complete",
        error_code=None,
    )
    payload = json.loads(
        chat_run_tools.app_search_tool_output(
            run_result,
            CitationCandidateNumbering(
                rows=(
                    NumberedCitationCandidate(uuid4(), 0, 2),
                    NumberedCitationCandidate(uuid4(), 1, None),
                ),
                next_ordinal=3,
            ),
        )
    )
    assert payload["results"] == [
        {
            "title": "Citable",
            "snippet": "snip-1",
            "kind": "media",
            "source_label": "Lib",
            "n": 2,
        },
        {
            "title": "Uncitable",
            "snippet": "snip-2",
            "kind": "conversation",
            "source_label": None,
        },
    ]
    assert payload["total_candidates"] == 3
    assert payload["status"] == "complete"
    assert payload["error_code"] is None


def test_tool_trace_event_maps_error_status_and_uri_filter() -> None:
    tool_call_id = uuid4()
    assistant_message_id = uuid4()
    run = SimpleNamespace(assistant_message_id=assistant_message_id)
    ok_result = SimpleNamespace(is_error=False, uri="media:abc", error_code=None)
    ok_event = chat_run_tools.tool_trace_event(
        run=run,
        tool_call_id=tool_call_id,
        tool_call_index=1,
        tool_name="read_resource",
        result=ok_result,
    )
    assert ok_event["status"] == "complete"
    assert ok_event["scope"] == "conversation_context"
    assert ok_event["types"] == []
    assert ok_event["filters"] == {"uri": "media:abc"}
    assert ok_event["error_code"] is None

    err_result = SimpleNamespace(is_error=True, uri="media:abc", error_code="too_large")
    err_event = chat_run_tools.tool_trace_event(
        run=run,
        tool_call_id=tool_call_id,
        tool_call_index=1,
        tool_name="read_resource",
        result=err_result,
    )
    assert err_event["status"] == "error"
    assert err_event["error_code"] == "too_large"
