"""Subscription lifecycle streams mask viewers and fence subscription epochs."""

from __future__ import annotations

import asyncio
from uuid import UUID, uuid4

from fastapi.testclient import TestClient
from sqlalchemy import Engine
from sqlalchemy.orm import Session
from starlette.requests import Request
from starlette.responses import StreamingResponse

from nexus.api.routes import stream as stream_routes
from nexus.app import create_app
from nexus.db.models import PodcastSubscription, PodcastSubscriptionBackfill
from nexus.services.bootstrap import ensure_user_and_default_library
from nexus.services.stream_tokens import mint_stream_token
from tests.testkit.podcast_subscription_lifecycle import seed_subscription_lifecycle


def test_subscription_lifecycle_stream_masks_foreign_state_before_listener_allocation(
    engine: Engine,
) -> None:
    viewer_id = uuid4()
    foreign_user_id = uuid4()
    with Session(engine) as db:
        ensure_user_and_default_library(
            db,
            viewer_id,
            f"viewer-stream-{viewer_id}@example.invalid",
        )
        ensure_user_and_default_library(
            db,
            foreign_user_id,
            f"foreign-stream-{foreign_user_id}@example.invalid",
        )
        podcast_id, _, _ = seed_subscription_lifecycle(
            db,
            user_id=foreign_user_id,
            sync_status="Complete",
            backfill_state="Complete",
        )
        db.commit()

    token = mint_stream_token(viewer_id).token
    with TestClient(create_app()) as client:
        response = client.get(
            f"/stream/podcast-subscriptions/{podcast_id}/events",
            headers={"Authorization": f"Bearer {token}"},
        )

    assert response.status_code == 404
    assert response.json()["error"]["code"] == "E_NOT_FOUND"


def test_subscription_lifecycle_stream_never_emits_replacement_over_the_prior_epoch(
    engine: Engine,
) -> None:
    viewer_id = uuid4()
    with Session(engine) as db:
        ensure_user_and_default_library(
            db,
            viewer_id,
            f"epoch-stream-{viewer_id}@example.invalid",
        )
        podcast_id, prior_subscription_id, prior_backfill_id = seed_subscription_lifecycle(
            db,
            user_id=viewer_id,
            sync_status="Pending",
            backfill_state="Pending",
        )
        db.commit()

    async def request_scope() -> Request:
        async def receive() -> dict[str, object]:
            return {"type": "http.request", "body": b"", "more_body": False}

        return Request(
            {
                "type": "http",
                "asgi": {"version": "3.0"},
                "http_version": "1.1",
                "method": "GET",
                "scheme": "http",
                "path": f"/stream/podcast-subscriptions/{podcast_id}/events",
                "raw_path": b"",
                "query_string": b"",
                "headers": [],
                "client": ("testclient", 50000),
                "server": ("testserver", 80),
            },
            receive,
        )

    async def scenario() -> tuple[str, str, UUID]:
        async def read_body(response: StreamingResponse) -> str:
            chunks: list[str] = []
            async for chunk in response.body_iterator:
                chunks.append(chunk.decode() if isinstance(chunk, bytes) else chunk)
            return "".join(chunks)

        prior_response = await stream_routes.stream_podcast_subscription_events(
            await request_scope(),
            podcast_id,
            viewer_id,
        )
        with Session(engine) as db:
            prior_backfill = db.get(PodcastSubscriptionBackfill, prior_backfill_id)
            prior_subscription = db.get(PodcastSubscription, prior_subscription_id)
            assert prior_backfill is not None
            assert prior_subscription is not None
            db.delete(prior_backfill)
            db.flush()
            db.delete(prior_subscription)
            db.flush()
            _, replacement_subscription_id, _ = seed_subscription_lifecycle(
                db,
                user_id=viewer_id,
                podcast_id=podcast_id,
                sync_status="Complete",
                backfill_state="Complete",
            )
            db.commit()

        prior_body = await read_body(prior_response)
        replacement_response = await stream_routes.stream_podcast_subscription_events(
            await request_scope(),
            podcast_id,
            viewer_id,
        )
        replacement_body = await read_body(replacement_response)
        return prior_body, replacement_body, replacement_subscription_id

    prior_body, replacement_body, replacement_subscription_id = asyncio.run(scenario())

    assert prior_body == "", "replacement state crossed the prior epoch listener"
    assert replacement_subscription_id != prior_subscription_id
    assert 'event: state\ndata: {"podcastId":' in replacement_body
    assert '"syncStatus":"Complete"' in replacement_body
    assert '"processedCount":7' in replacement_body
    assert "event: done" in replacement_body
