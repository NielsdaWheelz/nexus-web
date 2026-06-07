"""Integration tests for the RUM web-vitals telemetry ingest route.

Covers AC-8 of the first-paint-speed cutover: a posted web vital produces a
``rum.web_vital`` structlog line carrying the request's ``request_id``.
"""

import pytest
import structlog

from nexus.logging import add_request_context
from nexus.middleware.request_id import REQUEST_ID_HEADER
from tests.helpers import auth_headers, create_test_user_id

pytestmark = pytest.mark.integration


@pytest.fixture
def rum_log_sink():
    """Capture structlog events with request context injected, then restore config.

    Includes ``add_request_context`` so captured events carry the request-scoped
    ``request_id`` exactly as the production logging chain would.
    """
    events: list[dict] = []
    original_config = structlog.get_config()

    def capture_processor(logger, method_name, event_dict):
        events.append(event_dict.copy())
        raise structlog.DropEvent

    structlog.configure(
        processors=[add_request_context, capture_processor],
        wrapper_class=structlog.stdlib.BoundLogger,
        cache_logger_on_first_use=False,
    )

    yield events

    structlog.configure(**original_config)


def _valid_vital() -> dict:
    """A representative valid web-vital payload (snake_case keys)."""
    return {
        "name": "LCP",
        "value": 1234.5,
        "rating": "good",
        "id": "v3-1700000000000-1234567890",
        "href": "/libraries",
        "nav_id": "nav-abc-123",
    }


class TestPostWebVital:
    """POST /telemetry/web-vitals."""

    def test_valid_vital_logs_rum_event_with_request_id(self, auth_client, rum_log_sink):
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        resp = auth_client.post(
            "/telemetry/web-vitals",
            json=_valid_vital(),
            headers=auth_headers(user_id),
        )

        assert resp.status_code == 200, f"Expected 200, got {resp.status_code}: {resp.text}"
        request_id = resp.headers[REQUEST_ID_HEADER]

        rum_events = [e for e in rum_log_sink if e.get("event") == "rum.web_vital"]
        assert len(rum_events) == 1, (
            f"Expected exactly one rum.web_vital event, got {len(rum_events)}: {rum_log_sink}"
        )
        event = rum_events[0]
        assert event["request_id"] == request_id, (
            f"rum.web_vital request_id {event.get('request_id')!r} does not match "
            f"response X-Request-ID {request_id!r}"
        )
        assert event["name"] == "LCP"
        assert event["rating"] == "good"
        assert event["metric_id"] == "v3-1700000000000-1234567890"
        assert event["href"] == "/libraries"
        assert event["nav_id"] == "nav-abc-123"

    def test_invalid_name_is_rejected(self, auth_client):
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        payload = _valid_vital()
        payload["name"] = "FID"

        resp = auth_client.post(
            "/telemetry/web-vitals",
            json=payload,
            headers=auth_headers(user_id),
        )

        assert resp.status_code == 400, f"Expected 400, got {resp.status_code}: {resp.text}"

    def test_extra_field_is_rejected(self, auth_client):
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        payload = _valid_vital()
        payload["bogus"] = True

        resp = auth_client.post(
            "/telemetry/web-vitals",
            json=payload,
            headers=auth_headers(user_id),
        )

        assert resp.status_code == 400, f"Expected 400, got {resp.status_code}: {resp.text}"
