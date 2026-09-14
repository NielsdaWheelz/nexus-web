"""Authenticated client defects expose structural correlation, never error payloads."""

from __future__ import annotations

from uuid import uuid4

from fastapi.testclient import TestClient
from structlog.testing import capture_logs


def test_client_defect_report_is_authenticated_bounded_and_structural(
    authenticated_client: TestClient, anonymous_client: TestClient
) -> None:
    payload = {
        "scope": "Pane",
        "release": "a" * 40,
        "pane_id": "pane-proof",
        "visit_id": "visit-proof",
        "phase": "Admission",
        "command_id": {"kind": "Present", "value": "same-command"},
        "run_id": {"kind": "Present", "value": str(uuid4())},
        "error_code": "E_INVALID_RESPONSE",
        "request_id": {"kind": "Present", "value": "original-admission-request"},
        "component_stack": "\n    at ChatComposer\n    at Conversation",
    }
    # The HTTP boundary owns the independently reviewed wire contract; a client
    # never sends the exception's message, request, provider payload, or JS stack.
    with capture_logs() as logs:
        response = authenticated_client.post("/telemetry/client-defects", json=payload)
        assert response.status_code == 200
        reports = [entry for entry in logs if entry.get("event") == "rum.client_defect"]
        assert len(reports) == 1
        report = reports[0]
        for key, value in payload.items():
            assert report.get(key) == value

    for scope in ("Nexus", "Workspace", "ReaderProgress", "Imports"):
        shared = {
            key: value for key, value in payload.items() if key not in ("pane_id", "visit_id")
        }
        shared["scope"] = scope
        with capture_logs() as logs:
            response = authenticated_client.post("/telemetry/client-defects", json=shared)
            assert response.status_code == 200
            report = next(entry for entry in logs if entry.get("event") == "rum.client_defect")
            assert report["scope"] == scope
            assert "pane_id" not in report
            assert "visit_id" not in report

    forbidden = "private draft, token, and provider output"
    invalid = (
        {**payload, "scope": "Workspace"},
        {**payload, "message": forbidden},
        {**payload, "stack": forbidden},
        {**payload, "request": {"content": forbidden}},
        {**payload, "command_id": None},
        {**payload, "run_id": {"kind": "Present", "value": "not-a-uuid"}},
        {**payload, "error_code": forbidden},
        {**payload, "component_stack": "x" * 8001},
    )
    with capture_logs() as logs:
        for body in invalid:
            response = authenticated_client.post("/telemetry/client-defects", json=body)
            assert response.status_code == 400
        assert anonymous_client.post("/telemetry/client-defects", json=payload).status_code == 401
        assert not [entry for entry in logs if entry.get("event") == "rum.client_defect"]
        assert forbidden not in repr(logs)
