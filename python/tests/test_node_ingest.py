"""Tests for run_node_ingest: Node.js subprocess wrapper for web article extraction.

Tests cover:
- Successful fetch and Readability extraction
- HTTP error handling (4xx, 5xx)
- Redirect following and final URL resolution
- Character encoding detection (Content-Type header, meta charset fallback)
- Subprocess timeout enforcement

These tests call run_node_ingest() directly with pytest-httpserver fixtures.
No database required.
"""

import time

import pytest
from werkzeug import Request, Response

from nexus.errors import ApiErrorCode
from nexus.services.node_ingest import IngestError, IngestResult, run_node_ingest

pytestmark = pytest.mark.integration

# ---------------------------------------------------------------------------
# HTML fixtures
# ---------------------------------------------------------------------------

VALID_ARTICLE_HTML = """\
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Test Article Title</title>
</head>
<body>
  <article>
    <h1>Test Article Title</h1>
    <p>This is the first paragraph of a substantive test article that contains
    enough text for Mozilla Readability to consider it worth extracting.</p>
    <p>This is the second paragraph providing additional context and depth so
    that the extraction heuristics are satisfied.</p>
    <p>A third paragraph rounds out the content, ensuring Readability does not
    dismiss this page as too thin to be a real article.</p>
    <p>Fourth paragraph with even more words to be safe about the content
    length threshold that Readability enforces internally.</p>
  </article>
</body>
</html>
"""

REDIRECT_TARGET_HTML = """\
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Redirected Article</title>
</head>
<body>
  <article>
    <h1>Redirected Article</h1>
    <p>This article lives at the redirect target URL and should be extracted
    correctly after the redirect is followed.</p>
    <p>Second paragraph adds sufficient content for Readability to parse it
    as an article and produce a result.</p>
    <p>Third paragraph for safety margin on content length heuristics.</p>
    <p>Fourth paragraph to be absolutely sure Readability is happy.</p>
  </article>
</body>
</html>
"""

METADATA_HTML = """\
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Metadata Article</title>
  <meta name="author" content="John Doe">
  <meta property="og:description" content="Article description for metadata test">
  <meta property="og:site_name" content="Test Site">
  <meta property="article:published_time" content="2025-06-15T12:00:00Z">
</head>
<body>
  <article>
    <h1>Metadata Article</h1>
    <p>This article contains rich metadata in its head element that should be
    extracted by Mozilla Readability and returned in the result.</p>
    <p>Second paragraph provides more content so the extraction heuristics
    treat this as a real article worth parsing.</p>
    <p>Third paragraph for additional length to satisfy content thresholds.</p>
    <p>Fourth paragraph ensures we are well above any minimum.</p>
    <p>Fifth paragraph — better safe than sorry with Readability heuristics.</p>
  </article>
</body>
</html>
"""

READABILITY_CONTENT_HTML = """\
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Title</title>
</head>
<body>
  <article>
    <h1>Title</h1>
    <p>Content paragraph one.</p>
    <p>Content paragraph two.</p>
    <p>Third paragraph so Readability does not reject the article as too short
    for extraction. This paragraph has enough text to push us past the
    threshold that Readability uses to decide a page is article-like.</p>
    <p>Fourth paragraph provides additional ballast for the content length
    heuristic. Readability is quite particular about minimum sizes.</p>
  </article>
</body>
</html>
"""

EMPTY_HTML = "<html><body></body></html>"


def _iso_article_html(special_text: str) -> str:
    """Build an article HTML string with enough content for Readability,
    containing the given special text in the first paragraph.

    NOTE: Only use characters encodable in the target charset. This template
    avoids em dashes and other characters outside ISO-8859-1."""
    return (
        "<html><head><title>Encoded Article</title></head><body>"
        "<article>"
        f"<h1>Encoded Article</h1>"
        f"<p>{special_text}</p>"
        "<p>Second paragraph provides more content for Readability extraction "
        "so the heuristics are satisfied and an article is produced.</p>"
        "<p>Third paragraph adds even more words to be safe about the minimum "
        "content length that Readability enforces internally.</p>"
        "<p>Fourth paragraph is here for the same reason - Readability needs "
        "a substantial amount of text before it will parse a page.</p>"
        "</article></body></html>"
    )


# ---------------------------------------------------------------------------
# Fetch tests
# ---------------------------------------------------------------------------


class TestNodeIngestFetch:
    """Tests for basic HTTP fetch behavior."""

    def test_successful_fetch_returns_ingest_result(self, httpserver):
        httpserver.expect_request("/article").respond_with_data(
            VALID_ARTICLE_HTML,
            content_type="text/html; charset=utf-8",
        )
        url = httpserver.url_for("/article")

        result = run_node_ingest(url)

        assert isinstance(result, IngestResult), (
            f"Expected IngestResult but got {type(result).__name__}: "
            f"{result.message if isinstance(result, IngestError) else result}"
        )
        assert "Test Article Title" in result.title, (
            f"Expected title to contain 'Test Article Title', got '{result.title}'"
        )
        assert len(result.content_html) > 0, "content_html should not be empty"
        assert result.final_url == url, (
            f"Expected final_url to be '{url}', got '{result.final_url}'"
        )

    def test_follows_redirects_and_resolves_final_url(self, httpserver):
        target_url = httpserver.url_for("/new")
        httpserver.expect_request("/old").respond_with_response(
            Response(status=301, headers={"Location": target_url})
        )
        httpserver.expect_request("/new").respond_with_data(
            REDIRECT_TARGET_HTML,
            content_type="text/html; charset=utf-8",
        )
        url = httpserver.url_for("/old")

        result = run_node_ingest(url)

        assert isinstance(result, IngestResult), (
            f"Expected IngestResult after redirect, got {type(result).__name__}: "
            f"{result.message if isinstance(result, IngestError) else result}"
        )
        assert "/new" in result.final_url, (
            f"Expected final_url to contain '/new' after redirect, got '{result.final_url}'"
        )

    def test_http_404_returns_ingest_error(self, httpserver):
        httpserver.expect_request("/missing").respond_with_data(
            "Not Found",
            status=404,
            content_type="text/plain",
        )
        url = httpserver.url_for("/missing")

        result = run_node_ingest(url)

        assert isinstance(result, IngestError), (
            f"Expected IngestError for 404 response, got {type(result).__name__}: {result}"
        )
        assert result.error_code == ApiErrorCode.E_INGEST_FAILED, (
            f"Expected error_code E_INGEST_FAILED for 404, got {result.error_code}"
        )

    def test_http_500_returns_ingest_error(self, httpserver):
        httpserver.expect_request("/error").respond_with_data(
            "Internal Server Error",
            status=500,
            content_type="text/plain",
        )
        url = httpserver.url_for("/error")

        result = run_node_ingest(url)

        assert isinstance(result, IngestError), (
            f"Expected IngestError for 500 response, got {type(result).__name__}: {result}"
        )
        assert result.error_code == ApiErrorCode.E_INGEST_FAILED, (
            f"Expected error_code E_INGEST_FAILED for 500, got {result.error_code}"
        )

    def test_invalid_url_scheme_returns_ingest_error(self):
        result = run_node_ingest("file:///etc/hosts")

        assert isinstance(result, IngestError), (
            f"Expected IngestError for unsupported URL scheme, got {type(result).__name__}: {result}"
        )
        assert result.error_code == ApiErrorCode.E_INGEST_FAILED, (
            f"Expected E_INGEST_FAILED for unsupported URL scheme, got {result.error_code}"
        )
        assert "Unsupported URL scheme" in result.message, (
            f"Expected unsupported scheme message, got: {result.message}"
        )

    def test_response_too_large_returns_ingest_error(self, httpserver):
        oversized_article = (
            "<html><body><article><p>"
            + ("A" * (11 * 1024 * 1024))
            + "</p></article></body></html>"
        )
        httpserver.expect_request("/oversized").respond_with_data(
            oversized_article,
            content_type="text/html; charset=utf-8",
        )
        url = httpserver.url_for("/oversized")

        result = run_node_ingest(url)

        assert isinstance(result, IngestError), (
            f"Expected IngestError for oversized response, got {type(result).__name__}: {result}"
        )
        assert result.error_code == ApiErrorCode.E_INGEST_FAILED, (
            f"Expected E_INGEST_FAILED for oversized response, got {result.error_code}"
        )
        assert "Response too large" in result.message, (
            f"Expected response-size error message, got: {result.message}"
        )


# ---------------------------------------------------------------------------
# Readability extraction tests
# ---------------------------------------------------------------------------


class TestNodeIngestReadability:
    """Tests for Mozilla Readability extraction."""

    def test_readability_extracts_article_content(self, httpserver):
        httpserver.expect_request("/content").respond_with_data(
            READABILITY_CONTENT_HTML,
            content_type="text/html; charset=utf-8",
        )
        url = httpserver.url_for("/content")

        result = run_node_ingest(url)

        assert isinstance(result, IngestResult), (
            f"Expected IngestResult, got {type(result).__name__}: "
            f"{result.message if isinstance(result, IngestError) else result}"
        )
        assert "Content paragraph one" in result.content_html, (
            f"Expected content_html to contain 'Content paragraph one', "
            f"got (first 300 chars): {result.content_html[:300]}"
        )
        assert "Content paragraph two" in result.content_html, (
            f"Expected content_html to contain 'Content paragraph two', "
            f"got (first 300 chars): {result.content_html[:300]}"
        )

    def test_readability_extracts_metadata(self, httpserver):
        httpserver.expect_request("/meta").respond_with_data(
            METADATA_HTML,
            content_type="text/html; charset=utf-8",
        )
        url = httpserver.url_for("/meta")

        result = run_node_ingest(url)

        assert isinstance(result, IngestResult), (
            f"Expected IngestResult with metadata, got {type(result).__name__}: "
            f"{result.message if isinstance(result, IngestError) else result}"
        )
        assert "Metadata Article" in result.title, (
            f"Expected title to contain 'Metadata Article', got '{result.title}'"
        )
        # byline comes from <meta name="author">
        assert result.byline != "", (
            f"Expected non-empty byline from <meta name='author'>, got '{result.byline}'"
        )
        # excerpt comes from og:description
        assert result.excerpt != "", (
            f"Expected non-empty excerpt from og:description, got '{result.excerpt}'"
        )

    def test_minimal_content_returns_readability_error(self, httpserver):
        httpserver.expect_request("/empty").respond_with_data(
            EMPTY_HTML,
            content_type="text/html; charset=utf-8",
        )
        url = httpserver.url_for("/empty")

        result = run_node_ingest(url)

        assert isinstance(result, IngestError), (
            f"Expected IngestError for empty page, got {type(result).__name__}: {result}"
        )
        assert result.error_code == ApiErrorCode.E_INGEST_FAILED, (
            f"Expected error_code E_INGEST_FAILED for readability failure, got {result.error_code}"
        )


# ---------------------------------------------------------------------------
# Encoding tests
# ---------------------------------------------------------------------------


class TestNodeIngestEncoding:
    """Tests for character encoding detection and decoding."""

    def test_iso_8859_1_encoding_from_content_type_header(self, httpserver):
        body_text = _iso_article_html("The résumé of naïve café culture is widely acknowledged.")
        body_bytes = body_text.encode("iso-8859-1")

        httpserver.expect_request("/iso").respond_with_data(
            body_bytes,
            content_type="text/html; charset=iso-8859-1",
        )
        url = httpserver.url_for("/iso")

        result = run_node_ingest(url)

        assert isinstance(result, IngestResult), (
            f"Expected IngestResult for ISO-8859-1 page, got {type(result).__name__}: "
            f"{result.message if isinstance(result, IngestError) else result}"
        )
        assert "café" in result.content_html, (
            f"Expected 'café' in content_html (ISO-8859-1 decoded correctly), "
            f"got (first 500 chars): {result.content_html[:500]}"
        )
        assert "résumé" in result.content_html, (
            f"Expected 'résumé' in content_html (ISO-8859-1 decoded correctly), "
            f"got (first 500 chars): {result.content_html[:500]}"
        )
        assert "naïve" in result.content_html, (
            f"Expected 'naïve' in content_html (ISO-8859-1 decoded correctly), "
            f"got (first 500 chars): {result.content_html[:500]}"
        )

    def test_windows_1252_encoding_from_content_type_header(self, httpserver):
        # U+201C and U+201D map to bytes 0x93/0x94 in Windows-1252.
        body_text = _iso_article_html("She said \u201chello world\u201d with emphasis.")
        body_bytes = body_text.encode("windows-1252")

        httpserver.expect_request("/cp1252").respond_with_data(
            body_bytes,
            content_type="text/html; charset=windows-1252",
        )
        url = httpserver.url_for("/cp1252")

        result = run_node_ingest(url)

        assert isinstance(result, IngestResult), (
            f"Expected IngestResult for Windows-1252 page, got {type(result).__name__}: "
            f"{result.message if isinstance(result, IngestError) else result}"
        )
        assert "hello world" in result.content_html, (
            "Expected decoded cp1252 text in content_html, "
            f"got (first 500 chars): {result.content_html[:500]}"
        )
        assert "\ufffd" not in result.content_html, (
            "Expected no replacement characters from cp1252 decode, "
            f"got (first 500 chars): {result.content_html[:500]}"
        )

    def test_meta_charset_fallback_when_no_content_type_charset(self, httpserver):
        html_with_meta = (
            '<html><head><meta charset="iso-8859-1">'
            "<title>Encoded Article</title></head><body>"
            "<article>"
            "<h1>Encoded Article</h1>"
            "<p>The résumé of naïve café culture is widely acknowledged.</p>"
            "<p>Second paragraph for Readability content length threshold.</p>"
            "<p>Third paragraph provides additional content to satisfy the "
            "extraction heuristics used by Mozilla Readability.</p>"
            "<p>Fourth paragraph ensures we are well above any minimum.</p>"
            "</article></body></html>"
        )
        body_bytes = html_with_meta.encode("iso-8859-1")

        httpserver.expect_request("/meta-charset").respond_with_data(
            body_bytes,
            content_type="text/html",
        )
        url = httpserver.url_for("/meta-charset")

        result = run_node_ingest(url)

        assert isinstance(result, IngestResult), (
            f"Expected IngestResult for meta-charset fallback, got {type(result).__name__}: "
            f"{result.message if isinstance(result, IngestError) else result}"
        )
        assert "café" in result.content_html, (
            f"Expected 'café' in content_html (meta charset fallback), "
            f"got (first 500 chars): {result.content_html[:500]}"
        )
        assert "résumé" in result.content_html, (
            f"Expected 'résumé' in content_html (meta charset fallback), "
            f"got (first 500 chars): {result.content_html[:500]}"
        )

    def test_meta_http_equiv_content_type_with_content_first(self, httpserver):
        html_with_meta_http_equiv = (
            "<html><head>"
            "<meta content='text/html; charset=iso-8859-1' http-equiv='Content-Type'>"
            "<title>Encoded Article</title>"
            "</head><body><article>"
            "<h1>Encoded Article</h1>"
            "<p>The résumé of naïve café culture is widely acknowledged.</p>"
            "<p>Second paragraph for Readability content length threshold.</p>"
            "<p>Third paragraph provides additional content to satisfy extraction.</p>"
            "<p>Fourth paragraph keeps article density comfortably above minimum.</p>"
            "</article></body></html>"
        )
        body_bytes = html_with_meta_http_equiv.encode("iso-8859-1")

        httpserver.expect_request("/meta-http-equiv").respond_with_data(
            body_bytes,
            content_type="text/html",
        )
        url = httpserver.url_for("/meta-http-equiv")

        result = run_node_ingest(url)

        assert isinstance(result, IngestResult), (
            f"Expected IngestResult for http-equiv charset fallback, got {type(result).__name__}: "
            f"{result.message if isinstance(result, IngestError) else result}"
        )
        assert "café" in result.content_html, (
            "Expected 'café' from http-equiv charset fallback, "
            f"got (first 500 chars): {result.content_html[:500]}"
        )

    def test_utf8_default_when_no_charset_specified(self, httpserver):
        body_text = _iso_article_html(
            "Unicode test: emoji \U0001f680, CJK \u4f60\u597d, accents \u00e9\u00e8\u00ea"
        )
        body_bytes = body_text.encode("utf-8")

        httpserver.expect_request("/utf8").respond_with_data(
            body_bytes,
            content_type="text/html",
        )
        url = httpserver.url_for("/utf8")

        result = run_node_ingest(url)

        assert isinstance(result, IngestResult), (
            f"Expected IngestResult for UTF-8 default, got {type(result).__name__}: "
            f"{result.message if isinstance(result, IngestError) else result}"
        )
        assert "\U0001f680" in result.content_html, (
            f"Expected rocket emoji in content_html (UTF-8 default), "
            f"got (first 500 chars): {result.content_html[:500]}"
        )
        assert "\u4f60\u597d" in result.content_html, (
            f"Expected CJK characters in content_html (UTF-8 default), "
            f"got (first 500 chars): {result.content_html[:500]}"
        )

    def test_invalid_charset_header_falls_back_to_utf8(self, httpserver):
        body_text = (
            "<html><head><title>UTF8 Fallback</title></head><body><article>"
            "<h1>UTF8 Fallback</h1>"
            "<p>Unicode fallback test: emoji \U0001f680 and accents café résumé naïve.</p>"
            "<p>Second paragraph provides enough text for Readability extraction.</p>"
            "<p>Third paragraph keeps the content density above the extraction threshold.</p>"
            "<p>Fourth paragraph ensures stable extraction across Readability versions.</p>"
            "</article></body></html>"
        )
        body_bytes = body_text.encode("utf-8")

        httpserver.expect_request("/invalid-charset").respond_with_data(
            body_bytes,
            content_type="text/html; charset=x-unknown-charset",
        )
        url = httpserver.url_for("/invalid-charset")

        result = run_node_ingest(url)

        assert isinstance(result, IngestResult), (
            f"Expected IngestResult with UTF-8 fallback, got {type(result).__name__}: "
            f"{result.message if isinstance(result, IngestError) else result}"
        )
        assert "\U0001f680" in result.content_html, (
            "Expected rocket emoji in content_html after UTF-8 fallback, "
            f"got (first 500 chars): {result.content_html[:500]}"
        )
        assert "résumé" in result.content_html, (
            "Expected accented text in content_html after UTF-8 fallback, "
            f"got (first 500 chars): {result.content_html[:500]}"
        )


# ---------------------------------------------------------------------------
# Timeout tests
# ---------------------------------------------------------------------------


class TestNodeIngestTimeout:
    """Tests for subprocess timeout enforcement."""

    def test_subprocess_timeout_returns_ingest_error(self, httpserver):
        def slow_handler(request: Request) -> Response:
            time.sleep(10)
            return Response(VALID_ARTICLE_HTML, content_type="text/html; charset=utf-8")

        httpserver.expect_request("/slow").respond_with_handler(slow_handler)
        url = httpserver.url_for("/slow")

        result = run_node_ingest(url, subprocess_timeout_s=1)

        assert isinstance(result, IngestError), (
            f"Expected IngestError for subprocess timeout, got {type(result).__name__}: {result}"
        )
        assert result.error_code == ApiErrorCode.E_INGEST_TIMEOUT, (
            f"Expected error_code E_INGEST_TIMEOUT, got {result.error_code}. "
            f"Message: {result.message}"
        )

    def test_fetch_timeout_returns_ingest_timeout(self, httpserver):
        def slow_handler(request: Request) -> Response:
            time.sleep(2)
            return Response(VALID_ARTICLE_HTML, content_type="text/html; charset=utf-8")

        httpserver.expect_request("/slow-fetch").respond_with_handler(slow_handler)
        url = httpserver.url_for("/slow-fetch")

        result = run_node_ingest(url, timeout_ms=100, subprocess_timeout_s=5)

        assert isinstance(result, IngestError), (
            f"Expected IngestError for fetch timeout, got {type(result).__name__}: {result}"
        )
        assert result.error_code == ApiErrorCode.E_INGEST_TIMEOUT, (
            f"Expected E_INGEST_TIMEOUT for fetch timeout, got {result.error_code}. "
            f"Message: {result.message}"
        )


# ---------------------------------------------------------------------------
# httpserver configuration
# ---------------------------------------------------------------------------


@pytest.fixture(scope="session")
def httpserver_listen_address():
    return ("127.0.0.1", 0)
