"""Public projection-revision protocol for the hard-cut Chat tool wire shape.

The revision is a browser/server admission contract, not a decoding fallback.
Missing or stale clients must be rejected before a Chat mutation, every route
that can disclose the replaced shape shares that gate, and the direct stream
preflight must admit the browser-authored header.
"""

from __future__ import annotations

from collections.abc import Generator, Mapping
from typing import Any
from uuid import UUID, uuid4

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import ValidationError
from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.db.models import MessageToolCall
from nexus.db.session import create_session_factory
from nexus.middleware.stream_cors import StreamCORSMiddleware
from nexus.schemas.conversation import ToolProjectionOut
from nexus.services.billing_entitlements import grant_entitlement_override
from nexus.services.rate_limit import RateLimiter, get_rate_limiter, set_rate_limiter
from tests.testkit.auth import UserRecord

_PROJECTION_HEADER = "X-Nexus-Tool-Projection"
_RELOAD_REQUIRED_CODE = "E_TOOL_PROJECTION_RELOAD_REQUIRED"
_STALE_REVISION = "0" * 64


def _current_projection_revision() -> str:
    # Imported at the point where a current client is exercised so the initial
    # red is the missing admission gate, not an unrelated import failure while
    # N1's generated declaration artifact is landing.
    from nexus.services.tool_runtime.declarations import (
        BROWSER_TOOL_PROJECTION_REVISION,
    )

    return BROWSER_TOOL_PROJECTION_REVISION


def _current_tool_contract_revision(canonical_tool_id: str) -> str:
    from nexus.services.tool_runtime.declarations import CHAT_TOOL_DECLARATIONS

    return next(
        entry.spec.tool_contract_revision
        for entry in CHAT_TOOL_DECLARATIONS
        if str(entry.spec.id) == canonical_tool_id
    )


def _chat_row_counts(db: Session, viewer_id: UUID) -> tuple[int, int, int, int]:
    row = db.execute(
        text(
            """
            SELECT
              (SELECT count(*) FROM conversations WHERE owner_user_id = :viewer_id),
              (SELECT count(*)
                 FROM messages AS message
                 JOIN conversations AS conversation
                   ON conversation.id = message.conversation_id
                WHERE conversation.owner_user_id = :viewer_id),
              (SELECT count(*) FROM chat_runs WHERE owner_user_id = :viewer_id),
              (SELECT count(*) FROM background_jobs WHERE kind = 'chat_run')
            """
        ),
        {"viewer_id": viewer_id},
    ).one()
    conversations, messages, runs, jobs = row._tuple()
    return int(conversations), int(messages), int(runs), int(jobs)


def _send_body() -> dict[str, object]:
    return {
        "destination": {"kind": "New"},
        "content": "Prove the projection gate before creating this run.",
        "profile_id": "balanced",
        "reasoning_option_id": "medium",
        "reader_selection": {"kind": "Absent"},
    }


def _assert_reload_required(response: Any, *, boundary: str) -> None:
    if response.status_code != 409:
        raise AssertionError(f"{boundary} crossed the public Chat boundary with a stale projection")
    body = response.json()
    assert body.get("error", {}).get("code") == _RELOAD_REQUIRED_CODE, (
        f"{boundary} returned a second projection-mismatch shape: {body!r}"
    )


def _projection_request(
    client: TestClient,
    *,
    method: str,
    path: str,
    revision: str | None,
    body: Mapping[str, object] | None = None,
):
    headers = {} if revision is None else {_PROJECTION_HEADER: revision}
    if path == "/chat-runs" or path.endswith(("/rerun", "/regenerate")):
        headers["Idempotency-Key"] = f"tool-projection-proof-{uuid4()}"
    return client.request(method, path, headers=headers, json=body)


@pytest.fixture
def projection_rate_limiter(db_session: Session) -> Generator[None, None, None]:
    previous = get_rate_limiter()
    set_rate_limiter(RateLimiter(session_factory=create_session_factory(db_session.get_bind())))
    try:
        yield
    finally:
        set_rate_limiter(previous)


def test_revision_gates_every_changed_chat_projection_boundary(
    authenticated_client: TestClient,
    db_session: Session,
    test_user: UserRecord,
    projection_rate_limiter: None,
) -> None:
    grant_entitlement_override(
        db_session,
        user_id=test_user.id,
        plan_tier="ai_pro",
        platform_token_quota_mode="unlimited",
        platform_token_limit_monthly=None,
        transcription_quota_mode="unlimited",
        transcription_minutes_limit_monthly=None,
        expires_at=None,
        reason="tool projection protocol proof",
        actor_label="nexus-test",
    )
    db_session.commit()

    before_rejected_sends = _chat_row_counts(db_session, test_user.id)
    for label, revision in (("missing revision", None), ("stale revision", _STALE_REVISION)):
        response = _projection_request(
            authenticated_client,
            method="POST",
            path="/chat-runs",
            revision=revision,
            body=_send_body(),
        )
        _assert_reload_required(response, boundary=f"fresh send with {label}")
    assert _chat_row_counts(db_session, test_user.id) == before_rejected_sends, (
        "projection rejection created a conversation, message pair, ChatRun, or durable job"
    )

    unknown_id = uuid4()
    projection_boundaries: tuple[tuple[str, str, Mapping[str, object] | None], ...] = (
        (
            "GET",
            f"/chat-runs?conversation_id={unknown_id}&status=active",
            None,
        ),
        ("GET", f"/chat-runs/{unknown_id}", None),
        ("POST", f"/chat-runs/{unknown_id}/cancel", None),
        ("POST", f"/messages/{unknown_id}/rerun", None),
        ("POST", f"/messages/{unknown_id}/regenerate", None),
        (
            "GET",
            f"/conversations/{unknown_id}/messages?limit=30&window=latest",
            None,
        ),
        ("GET", f"/conversations/{unknown_id}/tree", None),
        (
            "POST",
            f"/conversations/{unknown_id}/active-path",
            {"active_leaf_message_id": str(unknown_id)},
        ),
        (
            "POST",
            f"/conversations/{unknown_id}/tool-calls/{unknown_id}/undo",
            None,
        ),
        ("GET", f"/stream/chat-runs/{unknown_id}/events", None),
    )
    for method, path, body in projection_boundaries:
        for label, revision in (
            ("missing revision", None),
            ("stale revision", _STALE_REVISION),
        ):
            response = _projection_request(
                authenticated_client,
                method=method,
                path=path,
                revision=revision,
                body=body,
            )
            _assert_reload_required(response, boundary=f"{method} {path} with {label}")

    current_revision = _current_projection_revision()
    for method, path, body in projection_boundaries:
        response = _projection_request(
            authenticated_client,
            method=method,
            path=path,
            revision=current_revision,
            body=body,
        )
        error = response.json().get("error", {}) if response.content else {}
        assert error.get("code") != _RELOAD_REQUIRED_CODE, (
            f"current projection was rejected at {method} {path}: {response.text}"
        )

    current_send = _projection_request(
        authenticated_client,
        method="POST",
        path="/chat-runs",
        revision=current_revision,
        body=_send_body(),
    )
    assert current_send.status_code == 200, (
        f"current projection could not create one Chat run: {current_send.text}"
    )
    created = current_send.json()["data"]
    assert _chat_row_counts(db_session, test_user.id) == tuple(
        value + delta for value, delta in zip(before_rejected_sends, (1, 2, 1, 1), strict=True)
    )

    # This is a setup-only current_execution row. Its raw nullable audit code
    # remains storage-owned; the public same-system shape derives and emits the
    # closed presentation fields instead.
    tool_call = MessageToolCall(
        conversation_id=UUID(created["conversation"]["id"]),
        user_message_id=UUID(created["user_message"]["id"]),
        assistant_message_id=UUID(created["assistant_message"]["id"]),
        canonical_tool_id="nexus.document.search",
        provider_wire_name=None,
        record_kind="current_execution",
        canonical_input_sha256="a" * 64,
        tool_contract_revision=_current_tool_contract_revision("nexus.document.search"),
        binding_policy_revision="c" * 64,
        tool_call_index=1,
        search_query_fingerprint=None,
        scope="provider_tool",
        requested_types=[],
        result_refs=[],
        selected_context_refs=[],
        provider_request_ids=[],
        status="running",
        error_code=None,
    )
    db_session.add(tool_call)
    db_session.commit()

    run_response = authenticated_client.get(
        f"/chat-runs/{created['run']['id']}",
        headers={_PROJECTION_HEADER: current_revision},
    )
    assert run_response.status_code == 200, run_response.text
    public_tool = run_response.json()["data"]["assistant_message"]["trust_trail"]["tool_calls"][0]
    assert {
        "record_kind": public_tool["record_kind"],
        "canonical_tool_id": public_tool["canonical_tool_id"],
        "provider_wire_name": public_tool["provider_wire_name"],
        "effect": public_tool["effect"],
        "result_kind": public_tool["result_kind"],
        "activity_label": public_tool["activity_label"],
        "error_type": public_tool["error_type"],
    } == {
        "record_kind": "current_execution",
        "canonical_tool_id": "nexus.document.search",
        "provider_wire_name": None,
        "effect": "Read",
        "result_kind": "retrieval",
        "activity_label": "Searching this document",
        "error_type": None,
    }
    assert "tool_name" not in public_tool
    assert "error_code" not in public_tool
    assert "query_hash" not in public_tool

    missing_error_type = {
        key: public_tool[key]
        for key in (
            "record_kind",
            "canonical_tool_id",
            "provider_wire_name",
            "effect",
            "result_kind",
            "activity_label",
        )
    }
    with pytest.raises(ValidationError, match="error_type"):
        ToolProjectionOut.model_validate(missing_error_type)

    cors_app = FastAPI()
    cors_app.add_middleware(
        StreamCORSMiddleware,
        allowed_origins=["https://nexus-projection.test"],
    )
    with TestClient(cors_app) as cors_client:
        preflight = cors_client.options(
            f"/stream/chat-runs/{unknown_id}/events",
            headers={
                "Origin": "https://nexus-projection.test",
                "Access-Control-Request-Method": "GET",
                "Access-Control-Request-Headers": (
                    "authorization,last-event-id,x-nexus-sse-attempt,x-nexus-tool-projection"
                ),
            },
        )
    assert preflight.status_code == 204, preflight.text
    allowed_headers = {
        item.strip().casefold()
        for item in preflight.headers["access-control-allow-headers"].split(",")
    }
    assert "x-nexus-tool-projection" in allowed_headers, (
        f"direct Chat SSE preflight did not admit {_PROJECTION_HEADER}: {allowed_headers!r}"
    )
