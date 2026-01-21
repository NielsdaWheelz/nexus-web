"""Tests for the health endpoint.

The health endpoint is a liveness check that:
- Does not require authentication
- Does not touch the database
- Always returns 200 if the process is running
"""

from fastapi.testclient import TestClient


class TestHealthEndpoint:
    """Tests for GET /health"""

    def test_health_returns_200(self, client: TestClient):
        """Health endpoint returns 200 OK."""
        response = client.get("/health")
        assert response.status_code == 200

    def test_health_returns_correct_envelope(self, client: TestClient):
        """Health endpoint returns proper success envelope."""
        response = client.get("/health")
        data = response.json()

        assert "data" in data
        assert data["data"] == {"status": "ok"}

    def test_health_content_type_is_json(self, client: TestClient):
        """Health endpoint returns JSON content type."""
        response = client.get("/health")
        assert response.headers["content-type"] == "application/json"
