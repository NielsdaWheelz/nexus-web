"""Tests for error handling and response envelopes.

Verifies:
- Error envelope shape is correct
- Every error code maps to correct HTTP status
- Unknown exceptions return E_INTERNAL with 500
- Malformed JSON returns E_INVALID_REQUEST
"""

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from nexus.errors import (
    ERROR_CODE_TO_STATUS,
    ApiError,
    ApiErrorCode,
    ForbiddenError,
    InvalidRequestError,
    NotFoundError,
)
from nexus.responses import (
    error_response,
    success_response,
    unhandled_exception_handler,
)


class TestErrorResponse:
    """Tests for error response envelope format."""

    def test_error_response_has_correct_shape(self):
        """Error response contains error object with code and message."""
        response = error_response(ApiErrorCode.E_NOT_FOUND, "Resource not found")

        assert "error" in response
        assert "code" in response["error"]
        assert "message" in response["error"]
        assert response["error"]["code"] == "E_NOT_FOUND"
        assert response["error"]["message"] == "Resource not found"

    def test_error_response_code_is_string(self):
        """Error code in response is a string, not enum."""
        response = error_response(ApiErrorCode.E_FORBIDDEN, "Access denied")

        assert isinstance(response["error"]["code"], str)


class TestSuccessResponse:
    """Tests for success response envelope format."""

    def test_success_response_has_data_key(self):
        """Success response wraps data in 'data' key."""
        response = success_response({"id": "123", "name": "test"})

        assert "data" in response
        assert response["data"] == {"id": "123", "name": "test"}

    def test_success_response_with_list(self):
        """Success response works with list data."""
        items = [{"id": "1"}, {"id": "2"}]
        response = success_response(items)

        assert response["data"] == items

    def test_success_response_with_none(self):
        """Success response works with None data."""
        response = success_response(None)

        assert "data" in response
        assert response["data"] is None


class TestErrorCodeToStatus:
    """Tests for error code to HTTP status mapping."""

    def test_all_error_codes_have_status_mapping(self):
        """Every ApiErrorCode has a corresponding HTTP status."""
        for code in ApiErrorCode:
            assert code in ERROR_CODE_TO_STATUS, f"Missing status mapping for {code}"

    @pytest.mark.parametrize(
        "code,expected_status",
        [
            (ApiErrorCode.E_UNAUTHENTICATED, 401),
            (ApiErrorCode.E_FORBIDDEN, 403),
            (ApiErrorCode.E_INTERNAL_ONLY, 403),
            (ApiErrorCode.E_DEFAULT_LIBRARY_FORBIDDEN, 403),
            (ApiErrorCode.E_LAST_ADMIN_FORBIDDEN, 403),
            (ApiErrorCode.E_NOT_FOUND, 404),
            (ApiErrorCode.E_LIBRARY_NOT_FOUND, 404),
            (ApiErrorCode.E_MEDIA_NOT_FOUND, 404),
            (ApiErrorCode.E_INVALID_REQUEST, 400),
            (ApiErrorCode.E_NAME_INVALID, 400),
            (ApiErrorCode.E_AUTH_UNAVAILABLE, 503),
            (ApiErrorCode.E_INTERNAL, 500),
            # S2 error codes
            (ApiErrorCode.E_INGEST_FAILED, 502),
            (ApiErrorCode.E_INGEST_TIMEOUT, 504),
            (ApiErrorCode.E_SANITIZATION_FAILED, 500),
            (ApiErrorCode.E_HIGHLIGHT_INVALID_RANGE, 400),
            (ApiErrorCode.E_HIGHLIGHT_CONFLICT, 409),
            (ApiErrorCode.E_MEDIA_NOT_READY, 409),
            # S4 error codes
            (ApiErrorCode.E_USER_NOT_FOUND, 404),
            (ApiErrorCode.E_INVITE_NOT_FOUND, 404),
            (ApiErrorCode.E_INVITE_ALREADY_EXISTS, 409),
            (ApiErrorCode.E_INVITE_MEMBER_EXISTS, 409),
            (ApiErrorCode.E_INVITE_NOT_PENDING, 409),
            (ApiErrorCode.E_OWNER_REQUIRED, 403),
            (ApiErrorCode.E_OWNER_EXIT_FORBIDDEN, 403),
            (ApiErrorCode.E_OWNERSHIP_TRANSFER_INVALID, 409),
            (ApiErrorCode.E_CONVERSATION_SHARE_DEFAULT_LIBRARY_FORBIDDEN, 403),
            # S5 error codes
            (ApiErrorCode.E_RETRY_INVALID_STATE, 409),
            (ApiErrorCode.E_RETRY_NOT_ALLOWED, 409),
            (ApiErrorCode.E_CHAPTER_NOT_FOUND, 404),
            (ApiErrorCode.E_ARCHIVE_UNSAFE, 400),
        ],
    )
    def test_error_code_maps_to_correct_status(self, code: ApiErrorCode, expected_status: int):
        """Each error code maps to the expected HTTP status."""
        assert ERROR_CODE_TO_STATUS[code] == expected_status


class TestApiErrorClass:
    """Tests for ApiError exception class."""

    def test_api_error_has_code_and_message(self):
        """ApiError stores code and message."""
        error = ApiError(ApiErrorCode.E_NOT_FOUND, "Item not found")

        assert error.code == ApiErrorCode.E_NOT_FOUND
        assert error.message == "Item not found"

    def test_api_error_derives_status_code(self):
        """ApiError derives HTTP status from code."""
        error = ApiError(ApiErrorCode.E_FORBIDDEN, "Access denied")

        assert error.status_code == 403

    def test_not_found_error_defaults(self):
        """NotFoundError has sensible defaults."""
        error = NotFoundError()

        assert error.code == ApiErrorCode.E_NOT_FOUND
        assert error.status_code == 404

    def test_forbidden_error_defaults(self):
        """ForbiddenError has sensible defaults."""
        error = ForbiddenError()

        assert error.code == ApiErrorCode.E_FORBIDDEN
        assert error.status_code == 403

    def test_invalid_request_error_defaults(self):
        """InvalidRequestError has sensible defaults."""
        error = InvalidRequestError()

        assert error.code == ApiErrorCode.E_INVALID_REQUEST
        assert error.status_code == 400


class TestMalformedJsonHandling:
    """Tests for malformed JSON body handling."""

    def test_malformed_json_returns_400(self, client: TestClient):
        """Malformed JSON body returns 400 with E_INVALID_REQUEST."""
        # Send invalid JSON
        response = client.post(
            "/health",  # Any endpoint that might accept JSON
            content="{invalid json",
            headers={"content-type": "application/json"},
        )

        # Malformed JSON should return 400 with E_INVALID_REQUEST
        assert response.status_code == 400
        data = response.json()
        assert data["error"]["code"] == "E_INVALID_REQUEST"

    def test_empty_body_with_json_content_type(self, client: TestClient):
        """Empty body with JSON content type is handled gracefully."""
        response = client.post(
            "/health",
            content="",
            headers={"content-type": "application/json"},
        )
        # Should not crash - either 405 (method not allowed) or handled gracefully
        assert response.status_code in (400, 405)


class TestUnhandledExceptionHandling:
    """Tests for unhandled exception handling."""

    def test_unhandled_exception_returns_500_with_e_internal(self):
        """Unhandled exceptions return 500 with E_INTERNAL code."""
        # Create a test app with a route that raises an unhandled exception
        test_app = FastAPI()

        @test_app.get("/crash")
        def crash_endpoint():
            raise RuntimeError("Unexpected error")

        test_app.add_exception_handler(Exception, unhandled_exception_handler)

        client = TestClient(test_app, raise_server_exceptions=False)
        response = client.get("/crash")

        assert response.status_code == 500
        data = response.json()
        assert data["error"]["code"] == "E_INTERNAL"
        assert "Internal server error" in data["error"]["message"]

    def test_unhandled_exception_does_not_leak_details(self):
        """Unhandled exceptions do not leak stack traces or details."""
        test_app = FastAPI()

        @test_app.get("/crash")
        def crash_endpoint():
            raise RuntimeError("SECRET_INTERNAL_DETAIL")

        test_app.add_exception_handler(Exception, unhandled_exception_handler)

        client = TestClient(test_app, raise_server_exceptions=False)
        response = client.get("/crash")

        # Response should not contain the internal error message
        response_text = response.text
        assert "SECRET_INTERNAL_DETAIL" not in response_text
