"""SSRF + size-cap characterization tests for the feed-controlled fetch chokepoint.

`safe_get` is the single egress for feed-controlled URLs (RSS pages, chapter JSON,
transcript sidecars). These pin the security-critical behavior the cutover made an
acceptance criterion: reject bad schemes / loopback / private / metadata hosts, abort
oversize bodies mid-stream, and RE-VALIDATE every redirect hop. The real SSRF guards
(validate_requested_url + validate_dns_resolution)
are exercised directly; the fetch mechanics are exercised against a local HTTP server
with the guards stubbed (the local server is itself a loopback address the real guards
would correctly reject).
"""

from __future__ import annotations

import pytest

from nexus.errors import ApiError, ApiErrorCode, InvalidRequestError
from nexus.services.net.safe_fetch import SafeFetchResult, safe_get

pytestmark = pytest.mark.unit


def _assert_blocked(url: str) -> ApiError:
    with pytest.raises(ApiError) as exc_info:
        safe_get(url, max_bytes=1_000, timeout_s=5.0)
    return exc_info.value


# --- SSRF rejection via the real guards (no network) --------------------------------


def test_rejects_non_http_scheme() -> None:
    assert _assert_blocked("ftp://example.com/feed.xml").code == ApiErrorCode.E_SSRF_BLOCKED


@pytest.mark.parametrize(
    "url",
    [
        "http://127.0.0.1/feed.xml",  # loopback
        "http://10.0.0.1/feed.xml",  # private
        "http://169.254.169.254/latest/meta-data",  # cloud metadata
    ],
)
def test_rejects_literal_private_and_metadata_ips(url: str) -> None:
    assert _assert_blocked(url).code == ApiErrorCode.E_SSRF_BLOCKED


def test_rejects_hostname_that_resolves_to_loopback(monkeypatch: pytest.MonkeyPatch) -> None:
    # Isolate the DNS-resolution guard: bypass the literal-IP check so the rejection can
    # only come from validate_dns_resolution resolving "localhost" -> 127.0.0.1.
    monkeypatch.setattr("nexus.services.net.safe_fetch.validate_requested_url", lambda _url: None)
    assert _assert_blocked("http://localhost/feed.xml").code == ApiErrorCode.E_SSRF_BLOCKED


# --- Fetch mechanics against a local server (guards stubbed) -------------------------


@pytest.fixture
def _allow_local(monkeypatch: pytest.MonkeyPatch) -> None:
    """Stub the SSRF guards so the loopback test server is reachable; the rejection
    tests above cover the guards themselves."""
    monkeypatch.setattr("nexus.services.net.safe_fetch.validate_requested_url", lambda _url: None)
    monkeypatch.setattr("nexus.services.net.safe_fetch.validate_dns_resolution", lambda _host: None)


def test_returns_result_within_size_cap(_allow_local: None, httpserver) -> None:  # noqa: ANN001
    httpserver.expect_request("/chapters.json").respond_with_data(
        '{"version":"1.2.0"}', content_type="application/json"
    )
    result = safe_get(
        httpserver.url_for("/chapters.json"),
        max_bytes=1_000,
        timeout_s=5.0,
    )
    assert isinstance(result, SafeFetchResult)
    assert result.content_type == "application/json"
    assert result.text == '{"version":"1.2.0"}'
    assert result.content == b'{"version":"1.2.0"}'


def test_aborts_oversize_body(_allow_local: None, httpserver) -> None:  # noqa: ANN001
    httpserver.expect_request("/big.xml").respond_with_data(b"x" * 500, content_type="text/xml")
    with pytest.raises(ApiError) as exc_info:
        safe_get(httpserver.url_for("/big.xml"), max_bytes=10, timeout_s=5.0)
    assert exc_info.value.code == ApiErrorCode.E_SOURCE_TOO_LARGE


def test_revalidates_each_redirect_hop(monkeypatch: pytest.MonkeyPatch, httpserver) -> None:  # noqa: ANN001
    # Allow the server host but reject the redirect target, proving safe_get re-runs the
    # SSRF guard on every hop instead of trusting the first validation.
    monkeypatch.setattr("nexus.services.net.safe_fetch.validate_dns_resolution", lambda _host: None)

    def fake_validate(url: str) -> None:
        if "blocked.invalid" in url:
            raise InvalidRequestError(ApiErrorCode.E_SSRF_BLOCKED, "blocked redirect target")

    monkeypatch.setattr("nexus.services.net.safe_fetch.validate_requested_url", fake_validate)
    httpserver.expect_request("/start").respond_with_data(
        "", status=302, headers={"Location": "http://blocked.invalid/evil"}
    )
    with pytest.raises(ApiError) as exc_info:
        safe_get(httpserver.url_for("/start"), max_bytes=1_000, timeout_s=5.0)
    assert exc_info.value.code == ApiErrorCode.E_SSRF_BLOCKED


def test_rejects_redirect_loop(_allow_local: None, httpserver) -> None:  # noqa: ANN001
    httpserver.expect_request("/loop").respond_with_data(
        "", status=302, headers={"Location": httpserver.url_for("/loop")}
    )
    with pytest.raises(ApiError) as exc_info:
        safe_get(httpserver.url_for("/loop"), max_bytes=1_000, timeout_s=5.0)
    assert exc_info.value.code == ApiErrorCode.E_SOURCE_FETCH_FAILED
