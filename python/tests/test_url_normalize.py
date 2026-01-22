"""Unit tests for URL validation and normalization.

Tests cover s2_pr03.md requirements for:
- validate_requested_url(): Strict validation
- normalize_url_for_display(): URL normalization

These are pure unit tests with no external dependencies.
"""

import pytest

from nexus.errors import InvalidRequestError
from nexus.services.url_normalize import (
    MAX_URL_LENGTH,
    normalize_url_for_display,
    validate_requested_url,
)

# =============================================================================
# validate_requested_url() Tests
# =============================================================================


class TestValidateRequestedUrl:
    """Tests for validate_requested_url function."""

    # === Valid URLs ===

    def test_valid_https_url(self):
        """Valid HTTPS URL should pass."""
        validate_requested_url("https://example.com/article")

    def test_valid_http_url(self):
        """Valid HTTP URL should pass."""
        validate_requested_url("http://example.com/article")

    def test_valid_url_with_port(self):
        """Valid URL with port should pass."""
        validate_requested_url("https://example.com:8080/article")

    def test_valid_url_with_query(self):
        """Valid URL with query params should pass."""
        validate_requested_url("https://example.com/search?q=test&page=1")

    def test_valid_url_with_fragment(self):
        """Valid URL with fragment should pass (fragment stripped later)."""
        validate_requested_url("https://example.com/page#section")

    def test_valid_url_with_path(self):
        """Valid URL with path should pass."""
        validate_requested_url("https://example.com/path/to/article.html")

    def test_valid_international_domain(self):
        """Valid international domain should pass."""
        validate_requested_url("https://例え.jp/article")

    # === Scheme Validation ===

    def test_rejects_javascript_scheme(self):
        """javascript: scheme should be rejected."""
        with pytest.raises(InvalidRequestError) as exc:
            validate_requested_url("javascript:alert(1)")
        assert "scheme" in exc.value.message.lower()

    def test_rejects_ftp_scheme(self):
        """ftp: scheme should be rejected."""
        with pytest.raises(InvalidRequestError) as exc:
            validate_requested_url("ftp://example.com/file")
        assert "scheme" in exc.value.message.lower()

    def test_rejects_file_scheme(self):
        """file: scheme should be rejected."""
        with pytest.raises(InvalidRequestError) as exc:
            validate_requested_url("file:///etc/passwd")
        assert "scheme" in exc.value.message.lower()

    def test_rejects_data_scheme(self):
        """data: scheme should be rejected."""
        with pytest.raises(InvalidRequestError) as exc:
            validate_requested_url("data:text/html,<script>alert(1)</script>")
        assert "scheme" in exc.value.message.lower()

    def test_rejects_vbscript_scheme(self):
        """vbscript: scheme should be rejected."""
        with pytest.raises(InvalidRequestError) as exc:
            validate_requested_url("vbscript:MsgBox('XSS')")
        assert "scheme" in exc.value.message.lower()

    def test_accepts_uppercase_http(self):
        """Uppercase HTTP scheme should be accepted."""
        validate_requested_url("HTTP://example.com/article")

    def test_accepts_uppercase_https(self):
        """Uppercase HTTPS scheme should be accepted."""
        validate_requested_url("HTTPS://example.com/article")

    # === Length Validation ===

    def test_rejects_overlong_url(self):
        """URLs over 2048 characters should be rejected."""
        long_url = "https://example.com/" + "a" * 2030
        assert len(long_url) > MAX_URL_LENGTH

        with pytest.raises(InvalidRequestError) as exc:
            validate_requested_url(long_url)
        assert "2048" in exc.value.message

    def test_accepts_max_length_url(self):
        """URLs exactly at 2048 characters should be accepted."""
        # Build a URL that's exactly 2048 chars
        base = "https://example.com/"
        padding = "a" * (2048 - len(base))
        url = base + padding
        assert len(url) == 2048

        validate_requested_url(url)

    # === Userinfo (Credentials) Validation ===

    def test_rejects_userinfo_user_only(self):
        """URLs with username should be rejected."""
        with pytest.raises(InvalidRequestError) as exc:
            validate_requested_url("https://user@example.com/article")
        assert "credentials" in exc.value.message.lower()

    def test_rejects_userinfo_user_pass(self):
        """URLs with user:pass should be rejected."""
        with pytest.raises(InvalidRequestError) as exc:
            validate_requested_url("https://user:pass@example.com/article")
        assert "credentials" in exc.value.message.lower()

    def test_rejects_userinfo_empty_pass(self):
        """URLs with user: (empty pass) should be rejected."""
        with pytest.raises(InvalidRequestError) as exc:
            validate_requested_url("https://user:@example.com/article")
        assert "credentials" in exc.value.message.lower()

    # === Host Validation ===

    def test_rejects_localhost(self):
        """localhost should be rejected."""
        with pytest.raises(InvalidRequestError) as exc:
            validate_requested_url("http://localhost/admin")
        assert "localhost" in exc.value.message.lower()

    def test_rejects_localhost_uppercase(self):
        """LOCALHOST should be rejected (case insensitive)."""
        with pytest.raises(InvalidRequestError) as exc:
            validate_requested_url("http://LOCALHOST/admin")
        assert "localhost" in exc.value.message.lower()

    def test_rejects_127_0_0_1(self):
        """127.0.0.1 should be rejected."""
        with pytest.raises(InvalidRequestError) as exc:
            validate_requested_url("http://127.0.0.1/admin")
        assert "not allowed" in exc.value.message.lower()

    def test_rejects_127_0_0_1_with_port(self):
        """127.0.0.1:port should be rejected."""
        with pytest.raises(InvalidRequestError) as exc:
            validate_requested_url("http://127.0.0.1:8080/admin")
        assert "not allowed" in exc.value.message.lower()

    def test_rejects_ipv6_loopback(self):
        """::1 should be rejected."""
        with pytest.raises(InvalidRequestError) as exc:
            validate_requested_url("http://[::1]/admin")
        assert "not allowed" in exc.value.message.lower()

    def test_rejects_local_domain(self):
        """*.local domains should be rejected."""
        with pytest.raises(InvalidRequestError) as exc:
            validate_requested_url("http://myserver.local/api")
        assert "not allowed" in exc.value.message.lower()

    def test_rejects_private_ip_10(self):
        """10.x.x.x should be rejected."""
        with pytest.raises(InvalidRequestError) as exc:
            validate_requested_url("http://10.0.0.1/internal")
        assert "not allowed" in exc.value.message.lower()

    def test_rejects_private_ip_172(self):
        """172.16.x.x should be rejected."""
        with pytest.raises(InvalidRequestError) as exc:
            validate_requested_url("http://172.16.0.1/internal")
        assert "not allowed" in exc.value.message.lower()

    def test_rejects_private_ip_192(self):
        """192.168.x.x should be rejected."""
        with pytest.raises(InvalidRequestError) as exc:
            validate_requested_url("http://192.168.1.1/internal")
        assert "not allowed" in exc.value.message.lower()

    def test_rejects_link_local(self):
        """169.254.x.x should be rejected."""
        with pytest.raises(InvalidRequestError) as exc:
            validate_requested_url("http://169.254.1.1/metadata")
        assert "not allowed" in exc.value.message.lower()

    def test_rejects_missing_host(self):
        """URLs without host should be rejected."""
        with pytest.raises(InvalidRequestError) as exc:
            validate_requested_url("https:///path/only")
        assert "hostname" in exc.value.message.lower()

    # === Relative URLs ===

    def test_rejects_relative_url(self):
        """Relative URLs should be rejected."""
        with pytest.raises(InvalidRequestError) as exc:
            validate_requested_url("/just/a/path")
        assert "absolute" in exc.value.message.lower() or "scheme" in exc.value.message.lower()

    def test_rejects_protocol_relative_url(self):
        """Protocol-relative URLs should be rejected."""
        with pytest.raises(InvalidRequestError) as exc:
            validate_requested_url("//example.com/article")
        # Should fail because no scheme
        assert "scheme" in exc.value.message.lower()

    # === Malformed URLs ===

    def test_rejects_malformed_url(self):
        """Malformed URLs should be rejected."""
        with pytest.raises(InvalidRequestError):
            validate_requested_url("not a url at all")


# =============================================================================
# normalize_url_for_display() Tests
# =============================================================================


class TestNormalizeUrlForDisplay:
    """Tests for normalize_url_for_display function."""

    def test_lowercase_scheme(self):
        """Scheme should be lowercased."""
        result = normalize_url_for_display("HTTPS://example.com/article")
        assert result.startswith("https://")

    def test_lowercase_host(self):
        """Host should be lowercased."""
        result = normalize_url_for_display("https://EXAMPLE.COM/article")
        assert "example.com" in result

    def test_preserve_path_case(self):
        """Path case should be preserved."""
        result = normalize_url_for_display("https://example.com/Article/Page")
        assert "/Article/Page" in result

    def test_strip_fragment(self):
        """Fragment should be stripped."""
        result = normalize_url_for_display("https://example.com/page#section")
        assert "#" not in result
        assert result == "https://example.com/page"

    def test_preserve_query_params(self):
        """Query params should be preserved."""
        result = normalize_url_for_display("https://example.com/search?q=test&page=1")
        assert "?q=test&page=1" in result

    def test_preserve_non_standard_port(self):
        """Non-standard ports should be preserved."""
        result = normalize_url_for_display("https://example.com:8080/article")
        assert ":8080" in result

    def test_strip_standard_http_port(self):
        """Standard HTTP port 80 should be stripped."""
        result = normalize_url_for_display("http://example.com:80/article")
        assert ":80" not in result
        assert result == "http://example.com/article"

    def test_strip_standard_https_port(self):
        """Standard HTTPS port 443 should be stripped."""
        result = normalize_url_for_display("https://example.com:443/article")
        assert ":443" not in result
        assert result == "https://example.com/article"

    def test_empty_path_becomes_slash(self):
        """Empty path should become /."""
        result = normalize_url_for_display("https://example.com")
        assert result == "https://example.com/"

    def test_complex_normalization(self):
        """Complex URL should be normalized correctly."""
        result = normalize_url_for_display("HTTPS://EXAMPLE.COM:443/Path/Page?a=1#frag")
        assert result == "https://example.com/Path/Page?a=1"

    def test_preserves_path_with_query_and_fragment(self):
        """Path with query should be preserved, fragment stripped."""
        result = normalize_url_for_display("https://example.com/page.html?ref=home#top")
        assert result == "https://example.com/page.html?ref=home"

    def test_international_domain(self):
        """International domains should be lowercased."""
        result = normalize_url_for_display("https://例え.JP/page")
        assert "例え.jp" in result
