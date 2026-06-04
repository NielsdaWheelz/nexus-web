"""Tests for chat-run SSE delivery and stream auth boundaries."""

import json
import time
from datetime import UTC, datetime
from types import SimpleNamespace
from uuid import UUID, uuid4

import jwt
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from llm_calling.types import LLMChunk, LLMUsage
from sqlalchemy import inspect, text
from sqlalchemy.engine import Engine

from nexus.api.routes import _sse
from nexus.api.routes import stream as stream_routes
from nexus.auth.middleware import AuthMiddleware
from nexus.db.listen import StreamListenCapacityError
from nexus.services.stream_tokens import (
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
from nexus.services.billing_entitlements import grant_entitlement_override
from nexus.services.bootstrap import ensure_user_and_default_library
from tests.factories import (
    create_test_conversation,
    create_test_message,
    create_test_model,
)
from tests.utils.db import DirectSessionManager

pytestmark = pytest.mark.integration


def _require_chat_runs_schema(engine: Engine) -> None:
    tables = set(inspect(engine).get_table_names())
    missing = {"chat_runs", "chat_run_events"} - tables
    if missing:
        pytest.fail(f"chat-runs schema missing: {', '.join(sorted(missing))}")


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
                    model_id, reasoning, key_mode, completed_at,
                    next_event_seq
                )
                VALUES (
                    :id, :owner_user_id, :conversation_id, :user_message_id,
                    :assistant_message_id, :idempotency_key, :payload_hash, :status,
                    :model_id, 'none', 'auto', :completed_at,
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
                "meta_payload": json.dumps(
                    {
                        "run_id": str(run_id),
                        "conversation_id": str(conversation_id),
                        "user_message_id": str(user_message_id),
                        "assistant_message_id": str(assistant_message_id),
                        "model_id": str(model_id),
                        "provider": "openai",
                    }
                ),
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


def _seed_ai_plus_billing(direct_db: DirectSessionManager, user_id: UUID) -> None:
    direct_db.register_cleanup("billing_entitlement_overrides", "user_id", user_id)
    direct_db.register_cleanup("billing_entitlement_override_events", "user_id", user_id)
    with direct_db.session() as session:
        grant_entitlement_override(
            session,
            user_id=user_id,
            plan_tier="ai_plus",
            platform_token_quota_mode="plan",
            platform_token_limit_monthly=None,
            transcription_quota_mode="plan",
            transcription_minutes_limit_monthly=None,
            expires_at=None,
            reason="chat stream test access",
            actor_label="test",
        )


class _StreamingAnswerRouter:
    def __init__(self, *deltas: str) -> None:
        self.deltas = deltas

    async def generate_stream(self, _provider, _req, _api_key, *, timeout_s):
        for delta in self.deltas:
            yield LLMChunk(delta_text=delta, done=False)
        yield LLMChunk(
            delta_text="",
            done=True,
            usage=LLMUsage(input_tokens=10, output_tokens=20, total_tokens=30),
            provider_request_id="resp_source_backed_test",
        )

    async def generate(self, _provider, request, _api_key, *, timeout_s):
        answer = "".join(self.deltas)
        first = self.deltas[0].rstrip()
        second_start = len(first) + 1
        second = answer[second_start:]
        if "Generate one concise artifact" in request.messages[0].content:
            payload = json.loads(request.messages[1].content)
            return SimpleNamespace(
                text=json.dumps(
                    {
                        "artifact_kind": payload["requested_artifact_kind"],
                        "title": "Source timeline",
                        "preview_text": "A source-backed timeline was generated.",
                        "parts": [
                            {
                                "part_key": "event-1",
                                "part_type": "event",
                                "text": first,
                                "evidence_ordinals": [0],
                                "support_state": "source_grounded",
                            }
                        ],
                    }
                )
            )
        if "Extract every atomic factual claim" in request.messages[0].content:
            return SimpleNamespace(
                text=json.dumps(
                    {
                        "claims": [
                            {
                                "text": first,
                                "answer_start_offset": 0,
                                "answer_end_offset": len(first),
                            },
                            {
                                "text": second,
                                "answer_start_offset": second_start,
                                "answer_end_offset": second_start + len(second),
                            },
                        ]
                    }
                )
            )
        return SimpleNamespace(
            text=json.dumps(
                {
                    "claims": [
                        {
                            "ordinal": 0,
                            "answer_start_offset": 0,
                            "answer_end_offset": len(first),
                            "support_status": "supported",
                            "evidence_ordinals": [0],
                            "confidence": 0.98,
                        },
                        {
                            "ordinal": 1,
                            "answer_start_offset": second_start,
                            "answer_end_offset": second_start + len(second),
                            "support_status": "not_enough_evidence",
                            "evidence_ordinals": [],
                            "unsupported_reason": "not in selected evidence",
                            "confidence": 0.1,
                        },
                    ]
                }
            )
        )


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


def _response_start_headers(sent_messages: list[dict]) -> dict[str, str]:
    start = next(message for message in sent_messages if message["type"] == "http.response.start")
    return {
        key.decode("latin1").lower(): value.decode("latin1")
        for key, value in start.get("headers", [])
    }


class _FakeListener:
    def __init__(self) -> None:
        self.closed_reason: str | None = None

    async def notifications(self):
        yield

    async def close(self, *, reason: str = "closed") -> None:
        self.closed_reason = reason


class TestStreamTokenMint:
    def test_mint_returns_token_and_url(self):
        user_id = uuid4()
        result = mint_stream_token(user_id)
        assert isinstance(result.token, str)
        assert result.stream_base_url
        assert result.expires_at

    def test_mint_token_is_valid_jwt(self):
        user_id = uuid4()
        result = mint_stream_token(user_id)
        key = _get_signing_key_bytes()
        payload = jwt.decode(
            result.token,
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
        verified = verify_stream_token(result.token)
        uid, jti = verified.user_id, verified.jti
        direct_db.register_cleanup("stream_token_jti_claims", "jti", jti)
        assert uid == user_id
        assert isinstance(jti, str) and jti

    def test_replay_rejected(self, direct_db: DirectSessionManager):
        user_id = uuid4()
        with direct_db.session() as session:
            ensure_user_and_default_library(session, user_id)
            session.commit()
        token = mint_stream_token(user_id).token
        jti = verify_stream_token(token).jti
        direct_db.register_cleanup("stream_token_jti_claims", "jti", jti)

        with pytest.raises(ApiError) as exc:
            verify_stream_token(token)

        assert exc.value.code == ApiErrorCode.E_STREAM_TOKEN_REPLAYED

    def test_expired_claim_allows_fresh_token_with_same_jti(
        self,
        direct_db: DirectSessionManager,
    ):
        user_id = uuid4()
        jti = str(uuid4())
        direct_db.register_cleanup("stream_token_jti_claims", "jti", jti)
        with direct_db.session() as session:
            ensure_user_and_default_library(session, user_id)
            session.execute(
                text(
                    """
                    INSERT INTO stream_token_jti_claims (jti, user_id, expires_at)
                    VALUES (:jti, :user_id, now() - interval '1 second')
                    """
                ),
                {"jti": jti, "user_id": user_id},
            )
            session.commit()

        now = int(time.time())
        token = jwt.encode(
            {
                "iss": STREAM_TOKEN_ISSUER,
                "aud": STREAM_TOKEN_AUDIENCE,
                "sub": str(user_id),
                "exp": now + STREAM_TOKEN_TTL_SECONDS,
                "iat": now,
                "jti": jti,
                "scope": STREAM_TOKEN_SCOPE,
            },
            _get_signing_key_bytes(),
            algorithm="HS256",
        )

        verified = verify_stream_token(token)
        uid, claimed_jti = verified.user_id, verified.jti

        assert uid == user_id
        assert claimed_jti == jti
        with direct_db.session() as session:
            active_claims = session.execute(
                text(
                    """
                    SELECT COUNT(*)
                    FROM stream_token_jti_claims
                    WHERE jti = :jti AND expires_at > now()
                    """
                ),
                {"jti": jti},
            ).scalar_one()
        assert active_claims == 1

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
        stream_token = mint_stream_token(user_id).token

        response = auth_client.get(
            f"/chat-runs/{run_id}/events?after=1",
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
        assert events[1]["data"] == {
            "status": "complete",
            "usage": None,
            "error_code": None,
            "final_chars": None,
        }

    def test_replays_strict_reference_added_payload(
        self, auth_client, direct_db: DirectSessionManager, chat_runs_schema
    ):
        user_id = uuid4()
        run_id, conversation_id = _insert_terminal_run(direct_db, owner_user_id=user_id)
        reference_id = uuid4()
        resource_uri = f"chunk:{uuid4()}"
        created_at = datetime.now(UTC).isoformat().replace("+00:00", "Z")
        reference_payload = {
            "reference_id": str(reference_id),
            "conversation_id": str(conversation_id),
            "resource_uri": resource_uri,
            "label": "Chunk evidence",
            "summary": "A cited chunk.",
            "inline_body": "Quoted body.",
            "fetch_hint": "inline",
            "missing": False,
            "created_at": created_at,
        }
        with direct_db.session() as session:
            session.execute(
                text(
                    """
                    UPDATE chat_run_events
                    SET event_type = 'reference_added',
                        payload = CAST(:payload AS jsonb)
                    WHERE run_id = :run_id AND seq = 2
                    """
                ),
                {"run_id": run_id, "payload": json.dumps(reference_payload)},
            )
            session.commit()

        stream_token = mint_stream_token(user_id).token

        response = auth_client.get(
            f"/chat-runs/{run_id}/events?after=1",
            headers={"Authorization": f"Bearer {stream_token}"},
        )

        assert response.status_code == 200, (
            f"Expected stream replay to succeed, got {response.status_code}: {response.text}"
        )
        events = _parse_sse_events(response.text)
        assert [(event["id"], event["event"]) for event in events] == [
            ("2", "reference_added"),
            ("3", "done"),
        ]
        assert events[0]["data"] == reference_payload

    def test_replays_events_after_last_event_id_header(
        self, auth_client, direct_db: DirectSessionManager, chat_runs_schema
    ):
        user_id = uuid4()
        run_id, _conversation_id = _insert_terminal_run(direct_db, owner_user_id=user_id)
        stream_token = mint_stream_token(user_id).token

        response = auth_client.get(
            f"/chat-runs/{run_id}/events",
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
        assert events[0]["data"] == {
            "status": "complete",
            "usage": None,
            "error_code": None,
            "final_chars": None,
        }

    def test_closes_when_cursor_is_at_terminal_run(
        self, auth_client, direct_db: DirectSessionManager, chat_runs_schema
    ):
        user_id = uuid4()
        run_id, _conversation_id = _insert_terminal_run(direct_db, owner_user_id=user_id)
        stream_token = mint_stream_token(user_id).token

        response = auth_client.get(
            f"/chat-runs/{run_id}/events?after=3",
            headers={"Authorization": f"Bearer {stream_token}"},
        )

        assert response.status_code == 200, (
            f"Expected terminal cursor stream to close, got {response.status_code}: {response.text}"
        )
        assert response.text == ""

    @pytest.mark.asyncio
    async def test_tail_closes_when_run_disappears_after_stream_open(self):
        class Request:
            async def is_disconnected(self) -> bool:
                return False

        def missing_run(_cursor):
            raise ApiError(ApiErrorCode.E_NOT_FOUND, "Not found")

        listener = _FakeListener()
        chunks = [
            chunk
            async for chunk in _sse.tail_cursor_stream(
                request=Request(),
                listener=listener,
                after=0,
                read_after=missing_run,
            )
        ]

        assert chunks == []
        assert listener.closed_reason == "gone"

    @pytest.mark.asyncio
    async def test_route_rejects_listener_capacity_before_response(self, monkeypatch):
        async def reject_capacity(*_args, **_kwargs):
            raise StreamListenCapacityError()

        monkeypatch.setattr(stream_routes, "_assert_chat_run_owner", lambda *_args: None)
        monkeypatch.setattr(stream_routes, "open_sse_listener", reject_capacity)

        with pytest.raises(StreamListenCapacityError):
            await stream_routes.stream_chat_run_events(
                request=object(),
                run_id=uuid4(),
                viewer_id=uuid4(),
                after=None,
                last_event_id=None,
            )


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
            "path": "/chat-runs/00000000-0000-0000-0000-000000000000/events",
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
            "path": "/chat-runs/00000000-0000-0000-0000-000000000000/events",
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
            "path": "/chat-runs/00000000-0000-0000-0000-000000000000/events",
            "method": "OPTIONS",
            "headers": [(b"origin", b"https://nexus.test")],
        }
        await middleware(scope, None, send)

        assert any(message.get("status") == 204 for message in sent_messages)
        headers = _response_start_headers(sent_messages)
        assert headers["access-control-allow-origin"] == "https://nexus.test"
        assert headers["access-control-allow-methods"] == "GET, OPTIONS"
        assert headers["access-control-allow-headers"] == "Authorization, Last-Event-ID"

    @pytest.mark.asyncio
    async def test_actual_get_injects_stream_cors_headers(self):
        sent_messages = []

        async def app(scope, receive, send):
            await send(
                {
                    "type": "http.response.start",
                    "status": 200,
                    "headers": [(b"content-type", b"text/event-stream; charset=utf-8")],
                }
            )
            await send({"type": "http.response.body", "body": b"", "more_body": False})

        async def send(message):
            sent_messages.append(message)

        middleware = StreamCORSMiddleware(app, allowed_origins=["https://nexus.test"])
        scope = {
            "type": "http",
            "path": "/chat-runs/00000000-0000-0000-0000-000000000000/events",
            "method": "GET",
            "headers": [
                (b"origin", b"https://nexus.test"),
                (b"authorization", b"Bearer token"),
                (b"last-event-id", b"3"),
            ],
        }
        await middleware(scope, None, send)

        headers = _response_start_headers(sent_messages)
        assert headers["access-control-allow-origin"] == "https://nexus.test"
        assert headers["access-control-expose-headers"] == "X-Request-Id"


class TestStreamAuthMiddlewareBoundary:
    def test_chat_run_events_use_stream_token_auth_boundary(self):
        app = FastAPI()

        @app.get("/chat-runs/{run_id}/events")
        def events(run_id: str):
            return {"run_id": run_id}

        app.add_middleware(
            AuthMiddleware,
            verifier=object(),
            requires_internal_header=True,
            internal_secret="secret",
            bootstrap_callback=lambda user_id, email=None: user_id,
        )

        response = TestClient(app).get("/chat-runs/00000000-0000-0000-0000-000000000000/events")

        assert response.status_code == 200
