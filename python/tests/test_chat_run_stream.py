"""Tests for chat-run SSE delivery and stream auth boundaries."""

import json
import time
from datetime import UTC, datetime
from uuid import UUID, uuid4

import jwt
import pytest
from sqlalchemy import inspect, text
from sqlalchemy.engine import Engine

from nexus.auth.stream_token import (
    STREAM_TOKEN_AUDIENCE,
    STREAM_TOKEN_ISSUER,
    STREAM_TOKEN_SCOPE,
    STREAM_TOKEN_TTL_SECONDS,
    _get_signing_key_bytes,
    mint_stream_token,
    verify_stream_token,
)
from nexus.errors import ApiError, ApiErrorCode
from nexus.middleware.stream_cors import StreamCORSMiddleware
from nexus.services.bootstrap import ensure_user_and_default_library
from tests.factories import create_test_conversation, create_test_message, create_test_model
from tests.utils.db import DirectSessionManager

pytestmark = pytest.mark.integration


def _require_chat_runs_schema(engine: Engine) -> None:
    tables = set(inspect(engine).get_table_names())
    missing = {"chat_runs", "chat_run_events"} - tables
    if missing:
        pytest.skip(f"chat-runs schema not present yet: {', '.join(sorted(missing))}")


@pytest.fixture
def chat_runs_schema(engine: Engine) -> None:
    _require_chat_runs_schema(engine)


def _insert_terminal_run(
    direct_db: DirectSessionManager,
    *,
    owner_user_id: UUID,
    status: str = "complete",
) -> tuple[UUID, UUID]:
    run_id = uuid4()
    with direct_db.session() as session:
        ensure_user_and_default_library(session, owner_user_id)
        model_id = create_test_model(session)
        conversation_id = create_test_conversation(session, owner_user_id)
        user_message_id = create_test_message(
            session,
            conversation_id=conversation_id,
            seq=1,
            role="user",
            content="Hello",
        )
        assistant_message_id = create_test_message(
            session,
            conversation_id=conversation_id,
            seq=2,
            role="assistant",
            content="Hi",
            status=status,
            model_id=model_id,
        )
        session.execute(
            text(
                """
                INSERT INTO chat_runs (
                    id, owner_user_id, conversation_id, user_message_id,
                    assistant_message_id, idempotency_key, payload_hash, status,
                    model_id, reasoning, key_mode, web_search, completed_at,
                    next_event_seq
                )
                VALUES (
                    :id, :owner_user_id, :conversation_id, :user_message_id,
                    :assistant_message_id, :idempotency_key, :payload_hash, :status,
                    :model_id, 'none', 'auto', '{"mode": "off"}'::jsonb, :completed_at,
                    4
                )
                """
            ),
            {
                "id": run_id,
                "owner_user_id": owner_user_id,
                "conversation_id": conversation_id,
                "user_message_id": user_message_id,
                "assistant_message_id": assistant_message_id,
                "idempotency_key": f"stream-run-{run_id}",
                "payload_hash": f"payload-{run_id}",
                "status": status,
                "model_id": model_id,
                "completed_at": datetime.now(UTC),
            },
        )
        session.execute(
            text(
                """
                INSERT INTO chat_run_events (id, run_id, seq, event_type, payload)
                VALUES
                    (:meta_id, :run_id, 1, 'meta', CAST(:meta_payload AS jsonb)),
                    (:delta_id, :run_id, 2, 'delta', CAST(:delta_payload AS jsonb)),
                    (:done_id, :run_id, 3, 'done', CAST(:done_payload AS jsonb))
                """
            ),
            {
                "meta_id": uuid4(),
                "delta_id": uuid4(),
                "done_id": uuid4(),
                "run_id": run_id,
                "meta_payload": json.dumps({"conversation_id": str(conversation_id)}),
                "delta_payload": json.dumps({"delta": "Hi"}),
                "done_payload": json.dumps({"status": status}),
            },
        )
        session.commit()

    direct_db.register_cleanup("conversations", "id", conversation_id)
    direct_db.register_cleanup("messages", "conversation_id", conversation_id)
    direct_db.register_cleanup("chat_runs", "id", run_id)
    direct_db.register_cleanup("chat_run_events", "run_id", run_id)
    return run_id, conversation_id


def _parse_sse_events(body: str) -> list[dict]:
    events = []
    for block in body.strip().split("\n\n"):
        fields = {}
        for line in block.splitlines():
            if line.startswith(":"):
                continue
            key, value = line.split(": ", 1)
            fields[key] = value
        if fields:
            fields["data"] = json.loads(fields["data"])
            events.append(fields)
    return events


class TestStreamTokenMint:
    def test_mint_returns_token_and_url(self):
        user_id = uuid4()
        result = mint_stream_token(user_id)
        assert isinstance(result["token"], str)
        assert result["stream_base_url"]
        assert result["expires_at"]

    def test_mint_token_is_valid_jwt(self):
        user_id = uuid4()
        result = mint_stream_token(user_id)
        key = _get_signing_key_bytes()
        payload = jwt.decode(
            result["token"],
            key,
            algorithms=["HS256"],
            audience=STREAM_TOKEN_AUDIENCE,
        )
        assert payload["sub"] == str(user_id)
        assert payload["iss"] == STREAM_TOKEN_ISSUER
        assert payload["scope"] == STREAM_TOKEN_SCOPE
        assert payload["exp"] - payload["iat"] == STREAM_TOKEN_TTL_SECONDS


class TestStreamTokenVerify:
    def test_valid_token(self, direct_db: DirectSessionManager):
        user_id = uuid4()
        with direct_db.session() as session:
            ensure_user_and_default_library(session, user_id)
            session.commit()
        result = mint_stream_token(user_id)
        uid, jti = verify_stream_token(result["token"])
        direct_db.register_cleanup("stream_token_jti_claims", "jti", jti)
        assert uid == user_id
        assert isinstance(jti, str) and jti

    def test_expired_token_rejected(self):
        user_id = uuid4()
        key = _get_signing_key_bytes()
        payload = {
            "iss": STREAM_TOKEN_ISSUER,
            "aud": STREAM_TOKEN_AUDIENCE,
            "sub": str(user_id),
            "exp": int(time.time()) - 10,
            "iat": int(time.time()) - 70,
            "jti": str(uuid4()),
            "scope": STREAM_TOKEN_SCOPE,
        }
        token = jwt.encode(payload, key, algorithm="HS256")

        with pytest.raises(ApiError) as exc:
            verify_stream_token(token)

        assert exc.value.code == ApiErrorCode.E_STREAM_TOKEN_EXPIRED

    def test_wrong_scope_rejected(self):
        user_id = uuid4()
        key = _get_signing_key_bytes()
        payload = {
            "iss": STREAM_TOKEN_ISSUER,
            "aud": STREAM_TOKEN_AUDIENCE,
            "sub": str(user_id),
            "exp": int(time.time()) + 60,
            "iat": int(time.time()),
            "jti": str(uuid4()),
            "scope": "wrong",
        }
        token = jwt.encode(payload, key, algorithm="HS256")

        with pytest.raises(ApiError) as exc:
            verify_stream_token(token)

        assert exc.value.code == ApiErrorCode.E_STREAM_TOKEN_INVALID


class TestChatRunEventStream:
    def test_replays_events_after_query_cursor(
        self, auth_client, direct_db: DirectSessionManager, chat_runs_schema
    ):
        user_id = uuid4()
        run_id, _conversation_id = _insert_terminal_run(direct_db, owner_user_id=user_id)
        stream_token = mint_stream_token(user_id)["token"]

        response = auth_client.get(
            f"/stream/chat-runs/{run_id}/events?after=1",
            headers={"Authorization": f"Bearer {stream_token}"},
        )

        assert response.status_code == 200, (
            f"Expected stream replay to succeed, got {response.status_code}: {response.text}"
        )
        events = _parse_sse_events(response.text)
        assert [(event["id"], event["event"]) for event in events] == [
            ("2", "delta"),
            ("3", "done"),
        ]
        assert events[0]["data"] == {"delta": "Hi"}
        assert events[1]["data"] == {"status": "complete"}

    def test_replays_events_after_last_event_id_header(
        self, auth_client, direct_db: DirectSessionManager, chat_runs_schema
    ):
        user_id = uuid4()
        run_id, _conversation_id = _insert_terminal_run(direct_db, owner_user_id=user_id)
        stream_token = mint_stream_token(user_id)["token"]

        response = auth_client.get(
            f"/stream/chat-runs/{run_id}/events",
            headers={
                "Authorization": f"Bearer {stream_token}",
                "Last-Event-ID": "2",
            },
        )

        assert response.status_code == 200, (
            f"Expected Last-Event-ID replay to succeed, got {response.status_code}: {response.text}"
        )
        events = _parse_sse_events(response.text)
        assert [(event["id"], event["event"]) for event in events] == [("3", "done")]
        assert events[0]["data"] == {"status": "complete"}


class TestStreamCORSMiddleware:
    @pytest.mark.asyncio
    async def test_non_stream_path_passes_through(self):
        calls = []

        async def app(scope, receive, send):
            calls.append(scope)

        middleware = StreamCORSMiddleware(app, allowed_origins=["https://nexus.test"])
        scope = {"type": "http", "path": "/chat-runs", "method": "GET", "headers": []}
        await middleware(scope, None, None)

        assert len(calls) == 1

    @pytest.mark.asyncio
    async def test_stream_path_without_origin_passes_through(self):
        calls = []

        async def app(scope, receive, send):
            calls.append(scope)

        middleware = StreamCORSMiddleware(app, allowed_origins=["https://nexus.test"])
        scope = {
            "type": "http",
            "path": "/stream/chat-runs/00000000-0000-0000-0000-000000000000/events",
            "method": "GET",
            "headers": [],
        }
        await middleware(scope, None, None)

        assert len(calls) == 1

    @pytest.mark.asyncio
    async def test_stream_path_wrong_origin_rejected(self):
        async def app(scope, receive, send):
            raise AssertionError("App should not be called for rejected CORS request")

        sent_messages = []

        async def send(message):
            sent_messages.append(message)

        middleware = StreamCORSMiddleware(app, allowed_origins=["https://nexus.test"])
        scope = {
            "type": "http",
            "path": "/stream/chat-runs/00000000-0000-0000-0000-000000000000/events",
            "method": "GET",
            "headers": [(b"origin", b"https://evil.com")],
        }
        await middleware(scope, None, send)

        assert any(message.get("status") == 403 for message in sent_messages)

    @pytest.mark.asyncio
    async def test_options_preflight_handled(self):
        sent_messages = []

        async def app(scope, receive, send):
            raise AssertionError("App should not be called for preflight")

        async def send(message):
            sent_messages.append(message)

        middleware = StreamCORSMiddleware(app, allowed_origins=["https://nexus.test"])
        scope = {
            "type": "http",
            "path": "/stream/chat-runs/00000000-0000-0000-0000-000000000000/events",
            "method": "OPTIONS",
            "headers": [(b"origin", b"https://nexus.test")],
        }
        await middleware(scope, None, send)

        assert any(message.get("status") == 204 for message in sent_messages)


class TestLegacyStreamSendRoutesRemoved:
    def test_old_stream_send_routes_are_removed(self, auth_client, chat_runs_schema):
        stream_token = mint_stream_token(uuid4())["token"]

        new_conversation_response = auth_client.post(
            "/stream/conversations/messages",
            headers={"Authorization": f"Bearer {stream_token}"},
            json={},
        )
        existing_conversation_response = auth_client.post(
            f"/stream/conversations/{uuid4()}/messages",
            headers={"Authorization": f"Bearer {stream_token}"},
            json={},
        )

        assert new_conversation_response.status_code == 404
        assert existing_conversation_response.status_code == 404
