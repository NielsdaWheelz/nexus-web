"""Tests for image proxy service.

Tests cover:
- URL validation and normalization
- SSRF protection (hostname denylist, private IP blocking)
- Content validation (MIME type, magic bytes, Pillow decode)
- Caching behavior (LRU, byte budget, ETag)
- Integration with FastAPI endpoint
"""

import socket

import pytest
import respx
from httpx import Response

from nexus.errors import ApiError, ApiErrorCode
from nexus.services.image_proxy import (
    ImageCache,
    check_hostname_denylist,
    clear_cache,
    compute_etag,
    etags_match,
    fetch_image,
    is_private_ip,
    normalize_image_url,
    sniff_magic_bytes,
    validate_and_decode_image,
    validate_content_type,
    validate_dns_resolution,
    validate_url,
)
from tests.helpers import auth_headers
from tests.image_fixtures import (
    HTML_CONTENT,
    SVG_CONTENT,
    SVG_WITH_XML,
    TEXT_CONTENT,
    TINY_GIF,
    TINY_JPEG,
    TINY_PNG,
)

# =============================================================================
# URL Validation Tests
# =============================================================================


class TestUrlNormalization:
    """Tests for URL normalization."""

    def test_lowercase_scheme_and_host(self):
        assert normalize_image_url("HTTP://EXAMPLE.COM/img.png") == "http://example.com/img.png"

    def test_removes_default_http_port(self):
        assert normalize_image_url("http://example.com:80/img.png") == "http://example.com/img.png"

    def test_removes_default_https_port(self):
        assert (
            normalize_image_url("https://example.com:443/img.png") == "https://example.com/img.png"
        )

    def test_preserves_non_default_port(self):
        assert (
            normalize_image_url("http://example.com:8080/img.png")
            == "http://example.com:8080/img.png"
        )

    def test_strips_fragment(self):
        assert (
            normalize_image_url("http://example.com/img.png#section")
            == "http://example.com/img.png"
        )

    def test_preserves_query_params(self):
        assert (
            normalize_image_url("http://example.com/img.png?w=100&h=100")
            == "http://example.com/img.png?w=100&h=100"
        )


class TestUrlValidation:
    """Tests for URL validation (SSRF protection)."""

    def test_valid_http_url(self):
        normalized, hostname, port = validate_url("http://example.com/image.png")
        assert hostname == "example.com"
        assert port is None
        assert normalized == "http://example.com/image.png"

    def test_valid_https_url(self):
        normalized, hostname, port = validate_url("https://cdn.example.com/image.png")
        assert hostname == "cdn.example.com"
        assert port is None

    def test_rejects_ftp_scheme(self):
        with pytest.raises(ApiError) as exc:
            validate_url("ftp://example.com/image.png")
        assert exc.value.code == ApiErrorCode.E_SSRF_BLOCKED
        assert "scheme must be http or https" in exc.value.message

    def test_rejects_file_scheme(self):
        with pytest.raises(ApiError) as exc:
            validate_url("file:///etc/passwd")
        assert exc.value.code == ApiErrorCode.E_SSRF_BLOCKED

    def test_rejects_data_scheme(self):
        with pytest.raises(ApiError) as exc:
            validate_url("data:image/png;base64,abc123")
        assert exc.value.code == ApiErrorCode.E_SSRF_BLOCKED

    def test_rejects_javascript_scheme(self):
        with pytest.raises(ApiError) as exc:
            validate_url("javascript:alert(1)")
        assert exc.value.code == ApiErrorCode.E_SSRF_BLOCKED

    def test_rejects_userinfo_with_password(self):
        with pytest.raises(ApiError) as exc:
            validate_url("http://user:pass@example.com/image.png")
        assert exc.value.code == ApiErrorCode.E_SSRF_BLOCKED
        assert "credentials" in exc.value.message

    def test_rejects_userinfo_without_password(self):
        with pytest.raises(ApiError) as exc:
            validate_url("http://user@example.com/image.png")
        assert exc.value.code == ApiErrorCode.E_SSRF_BLOCKED

    def test_rejects_non_standard_port(self):
        with pytest.raises(ApiError) as exc:
            validate_url("http://example.com:8080/image.png")
        assert exc.value.code == ApiErrorCode.E_SSRF_BLOCKED
        assert "port must be 80 or 443" in exc.value.message

    def test_accepts_explicit_port_80(self):
        normalized, hostname, port = validate_url("http://example.com:80/image.png")
        assert port == 80

    def test_accepts_explicit_port_443(self):
        normalized, hostname, port = validate_url("https://example.com:443/image.png")
        assert port == 443

    def test_rejects_empty_host(self):
        with pytest.raises(ApiError) as exc:
            validate_url("http:///image.png")
        assert exc.value.code == ApiErrorCode.E_INVALID_REQUEST


# =============================================================================
# Hostname Denylist Tests
# =============================================================================


class TestHostnameDenylist:
    """Tests for hostname denylist (pre-DNS)."""

    def test_blocks_localhost(self):
        with pytest.raises(ApiError) as exc:
            check_hostname_denylist("localhost")
        assert exc.value.code == ApiErrorCode.E_SSRF_BLOCKED

    def test_blocks_localhost_case_insensitive(self):
        with pytest.raises(ApiError) as exc:
            check_hostname_denylist("LOCALHOST")
        assert exc.value.code == ApiErrorCode.E_SSRF_BLOCKED

    def test_blocks_dot_local_suffix(self):
        with pytest.raises(ApiError) as exc:
            check_hostname_denylist("myservice.local")
        assert exc.value.code == ApiErrorCode.E_SSRF_BLOCKED

    def test_blocks_dot_internal_suffix(self):
        with pytest.raises(ApiError) as exc:
            check_hostname_denylist("api.internal")
        assert exc.value.code == ApiErrorCode.E_SSRF_BLOCKED

    def test_blocks_dot_lan_suffix(self):
        with pytest.raises(ApiError) as exc:
            check_hostname_denylist("router.lan")
        assert exc.value.code == ApiErrorCode.E_SSRF_BLOCKED

    def test_blocks_dot_home_suffix(self):
        with pytest.raises(ApiError) as exc:
            check_hostname_denylist("nas.home")
        assert exc.value.code == ApiErrorCode.E_SSRF_BLOCKED

    def test_allows_legitimate_hosts(self):
        # These should not raise
        check_hostname_denylist("example.com")
        check_hostname_denylist("cdn.cloudflare.com")
        check_hostname_denylist("images.unsplash.com")


# =============================================================================
# DNS Resolution / Private IP Tests
# =============================================================================


class TestPrivateIpDetection:
    """Tests for private IP detection."""

    def test_loopback_ipv4(self):
        from ipaddress import ip_address

        assert is_private_ip(ip_address("127.0.0.1"))
        assert is_private_ip(ip_address("127.255.255.255"))

    def test_loopback_ipv6(self):
        from ipaddress import ip_address

        assert is_private_ip(ip_address("::1"))

    def test_private_class_a(self):
        from ipaddress import ip_address

        assert is_private_ip(ip_address("10.0.0.1"))
        assert is_private_ip(ip_address("10.255.255.255"))

    def test_private_class_b(self):
        from ipaddress import ip_address

        assert is_private_ip(ip_address("172.16.0.1"))
        assert is_private_ip(ip_address("172.31.255.255"))

    def test_private_class_c(self):
        from ipaddress import ip_address

        assert is_private_ip(ip_address("192.168.0.1"))
        assert is_private_ip(ip_address("192.168.255.255"))

    def test_link_local_ipv4(self):
        from ipaddress import ip_address

        assert is_private_ip(ip_address("169.254.1.1"))

    def test_metadata_endpoint(self):
        from ipaddress import ip_address

        assert is_private_ip(ip_address("169.254.169.254"))

    def test_public_ip(self):
        from ipaddress import ip_address

        assert not is_private_ip(ip_address("8.8.8.8"))
        assert not is_private_ip(ip_address("93.184.216.34"))


class TestDnsResolution:
    """Tests for DNS resolution validation using monkeypatch."""

    def test_blocks_hostname_resolving_to_localhost(self, monkeypatch):
        """Test that hostname resolving to 127.0.0.1 is blocked."""

        def fake_getaddrinfo(host, port, *args, **kwargs):
            if host == "evil.test":
                return [(socket.AF_INET, socket.SOCK_STREAM, 0, "", ("127.0.0.1", 80))]
            raise socket.gaierror("Test only accepts evil.test")

        monkeypatch.setattr(socket, "getaddrinfo", fake_getaddrinfo)

        with pytest.raises(ApiError) as exc:
            validate_dns_resolution("evil.test")
        assert exc.value.code == ApiErrorCode.E_SSRF_BLOCKED

    def test_blocks_hostname_resolving_to_private_10_x(self, monkeypatch):
        """Test that hostname resolving to 10.x.x.x is blocked."""

        def fake_getaddrinfo(host, port, *args, **kwargs):
            return [(socket.AF_INET, socket.SOCK_STREAM, 0, "", ("10.0.0.1", 80))]

        monkeypatch.setattr(socket, "getaddrinfo", fake_getaddrinfo)

        with pytest.raises(ApiError) as exc:
            validate_dns_resolution("internal.example.com")
        assert exc.value.code == ApiErrorCode.E_SSRF_BLOCKED

    def test_blocks_hostname_resolving_to_private_172_16_x(self, monkeypatch):
        """Test that hostname resolving to 172.16.x.x is blocked."""

        def fake_getaddrinfo(host, port, *args, **kwargs):
            return [(socket.AF_INET, socket.SOCK_STREAM, 0, "", ("172.16.0.1", 80))]

        monkeypatch.setattr(socket, "getaddrinfo", fake_getaddrinfo)

        with pytest.raises(ApiError) as exc:
            validate_dns_resolution("internal.example.com")
        assert exc.value.code == ApiErrorCode.E_SSRF_BLOCKED

    def test_blocks_hostname_resolving_to_private_192_168_x(self, monkeypatch):
        """Test that hostname resolving to 192.168.x.x is blocked."""

        def fake_getaddrinfo(host, port, *args, **kwargs):
            return [(socket.AF_INET, socket.SOCK_STREAM, 0, "", ("192.168.1.1", 80))]

        monkeypatch.setattr(socket, "getaddrinfo", fake_getaddrinfo)

        with pytest.raises(ApiError) as exc:
            validate_dns_resolution("router.example.com")
        assert exc.value.code == ApiErrorCode.E_SSRF_BLOCKED

    def test_blocks_hostname_resolving_to_metadata_endpoint(self, monkeypatch):
        """Test that hostname resolving to AWS metadata endpoint is blocked."""

        def fake_getaddrinfo(host, port, *args, **kwargs):
            return [(socket.AF_INET, socket.SOCK_STREAM, 0, "", ("169.254.169.254", 80))]

        monkeypatch.setattr(socket, "getaddrinfo", fake_getaddrinfo)

        with pytest.raises(ApiError) as exc:
            validate_dns_resolution("metadata.example.com")
        assert exc.value.code == ApiErrorCode.E_SSRF_BLOCKED

    def test_allows_public_ip(self, monkeypatch):
        """Test that hostname resolving to public IP is allowed."""

        def fake_getaddrinfo(host, port, *args, **kwargs):
            return [(socket.AF_INET, socket.SOCK_STREAM, 0, "", ("93.184.216.34", 80))]

        monkeypatch.setattr(socket, "getaddrinfo", fake_getaddrinfo)

        # Should not raise
        validate_dns_resolution("example.com")

    def test_dns_resolution_failure(self, monkeypatch):
        """Test that DNS resolution failure is handled."""

        def fake_getaddrinfo(host, port, *args, **kwargs):
            raise socket.gaierror("Name or service not known")

        monkeypatch.setattr(socket, "getaddrinfo", fake_getaddrinfo)

        with pytest.raises(ApiError) as exc:
            validate_dns_resolution("nonexistent.invalid")
        assert exc.value.code == ApiErrorCode.E_IMAGE_FETCH_FAILED


# =============================================================================
# Content Validation Tests
# =============================================================================


class TestContentTypeValidation:
    """Tests for Content-Type validation."""

    def test_accepts_missing_content_type(self):
        # Should not raise - we'll sniff the content
        validate_content_type(None)

    def test_accepts_image_png(self):
        validate_content_type("image/png")

    def test_accepts_image_jpeg(self):
        validate_content_type("image/jpeg")

    def test_accepts_application_octet_stream(self):
        # Common misbehavior - should proceed to sniff
        validate_content_type("application/octet-stream")

    def test_rejects_text_html(self):
        with pytest.raises(ApiError) as exc:
            validate_content_type("text/html")
        assert exc.value.code == ApiErrorCode.E_INVALID_REQUEST

    def test_rejects_text_plain(self):
        with pytest.raises(ApiError) as exc:
            validate_content_type("text/plain")
        assert exc.value.code == ApiErrorCode.E_INVALID_REQUEST

    def test_rejects_application_json(self):
        with pytest.raises(ApiError) as exc:
            validate_content_type("application/json")
        assert exc.value.code == ApiErrorCode.E_INVALID_REQUEST

    def test_rejects_image_svg_xml(self):
        with pytest.raises(ApiError) as exc:
            validate_content_type("image/svg+xml")
        assert exc.value.code == ApiErrorCode.E_INVALID_REQUEST

    def test_handles_content_type_with_charset(self):
        # Should handle Content-Type with charset parameter
        with pytest.raises(ApiError):
            validate_content_type("text/html; charset=utf-8")


class TestMagicByteSniffing:
    """Tests for magic byte sniffing (defense in depth)."""

    def test_rejects_svg_content(self):
        with pytest.raises(ApiError) as exc:
            sniff_magic_bytes(SVG_CONTENT)
        assert exc.value.code == ApiErrorCode.E_INVALID_REQUEST

    def test_rejects_svg_with_xml_declaration(self):
        with pytest.raises(ApiError) as exc:
            sniff_magic_bytes(SVG_WITH_XML)
        assert exc.value.code == ApiErrorCode.E_INVALID_REQUEST

    def test_rejects_html_content(self):
        with pytest.raises(ApiError) as exc:
            sniff_magic_bytes(HTML_CONTENT)
        assert exc.value.code == ApiErrorCode.E_INVALID_REQUEST

    def test_rejects_svg_with_leading_whitespace(self):
        # SVG with leading whitespace should still be detected
        data = b"   \n\t  <svg></svg>"
        with pytest.raises(ApiError) as exc:
            sniff_magic_bytes(data)
        assert exc.value.code == ApiErrorCode.E_INVALID_REQUEST

    def test_accepts_png_data(self):
        # Should not raise
        sniff_magic_bytes(TINY_PNG)

    def test_accepts_jpeg_data(self):
        # Should not raise
        sniff_magic_bytes(TINY_JPEG)


class TestImageDecoding:
    """Tests for image decoding with Pillow."""

    def test_decodes_valid_png(self):
        content_type = validate_and_decode_image(TINY_PNG, "image/png")
        assert content_type == "image/png"

    def test_decodes_valid_jpeg(self):
        content_type = validate_and_decode_image(TINY_JPEG, "image/jpeg")
        assert content_type == "image/jpeg"

    def test_decodes_valid_gif(self):
        content_type = validate_and_decode_image(TINY_GIF, "image/gif")
        assert content_type == "image/gif"

    def test_rejects_invalid_image_data(self):
        with pytest.raises(ApiError) as exc:
            validate_and_decode_image(TEXT_CONTENT, None)
        assert exc.value.code == ApiErrorCode.E_INVALID_REQUEST

    def test_derives_content_type_from_pillow(self):
        # When upstream sends wrong content type, derive from Pillow
        content_type = validate_and_decode_image(TINY_PNG, "application/octet-stream")
        assert content_type == "image/png"

    def test_uses_valid_upstream_content_type(self):
        # When upstream sends valid image type, use it
        content_type = validate_and_decode_image(TINY_PNG, "image/png")
        assert content_type == "image/png"


# =============================================================================
# Cache Tests
# =============================================================================


class TestImageCache:
    """Tests for LRU cache with byte budget."""

    def test_basic_get_put(self):
        cache = ImageCache(max_entries=10, max_bytes=1000)
        from nexus.services.image_proxy import CacheEntry

        entry = CacheEntry(data=b"test", content_type="image/png", etag='"abc"')
        cache.put("key1", entry)

        result = cache.get("key1")
        assert result is not None
        assert result.data == b"test"
        assert result.etag == '"abc"'

    def test_get_nonexistent_key(self):
        cache = ImageCache()
        assert cache.get("nonexistent") is None

    def test_entry_limit_eviction(self):
        cache = ImageCache(max_entries=2, max_bytes=10000)
        from nexus.services.image_proxy import CacheEntry

        cache.put("key1", CacheEntry(data=b"1", content_type="image/png", etag='"1"'))
        cache.put("key2", CacheEntry(data=b"2", content_type="image/png", etag='"2"'))
        cache.put("key3", CacheEntry(data=b"3", content_type="image/png", etag='"3"'))

        # key1 should be evicted (LRU)
        assert cache.get("key1") is None
        assert cache.get("key2") is not None
        assert cache.get("key3") is not None

    def test_byte_budget_eviction(self):
        cache = ImageCache(max_entries=100, max_bytes=10)
        from nexus.services.image_proxy import CacheEntry

        cache.put("key1", CacheEntry(data=b"12345", content_type="image/png", etag='"1"'))
        cache.put("key2", CacheEntry(data=b"67890", content_type="image/png", etag='"2"'))
        cache.put("key3", CacheEntry(data=b"abcde", content_type="image/png", etag='"3"'))

        # key1 should be evicted due to byte budget
        assert cache.get("key1") is None
        assert cache.size <= 2
        assert cache.total_bytes <= 10

    def test_access_updates_lru_order(self):
        cache = ImageCache(max_entries=2, max_bytes=10000)
        from nexus.services.image_proxy import CacheEntry

        cache.put("key1", CacheEntry(data=b"1", content_type="image/png", etag='"1"'))
        cache.put("key2", CacheEntry(data=b"2", content_type="image/png", etag='"2"'))

        # Access key1 to make it recently used
        cache.get("key1")

        # Add key3 - should evict key2 (LRU)
        cache.put("key3", CacheEntry(data=b"3", content_type="image/png", etag='"3"'))

        assert cache.get("key1") is not None
        assert cache.get("key2") is None
        assert cache.get("key3") is not None

    def test_clear(self):
        cache = ImageCache()
        from nexus.services.image_proxy import CacheEntry

        cache.put("key1", CacheEntry(data=b"test", content_type="image/png", etag='"1"'))
        cache.clear()

        assert cache.size == 0
        assert cache.total_bytes == 0
        assert cache.get("key1") is None


# =============================================================================
# ETag Tests
# =============================================================================


class TestETagHandling:
    """Tests for ETag computation and matching."""

    def test_compute_etag_is_quoted(self):
        etag = compute_etag(b"test data")
        assert etag.startswith('"')
        assert etag.endswith('"')

    def test_compute_etag_is_consistent(self):
        etag1 = compute_etag(b"same data")
        etag2 = compute_etag(b"same data")
        assert etag1 == etag2

    def test_compute_etag_differs_for_different_data(self):
        etag1 = compute_etag(b"data1")
        etag2 = compute_etag(b"data2")
        assert etag1 != etag2

    def test_etags_match_exact(self):
        assert etags_match('"abc123"', '"abc123"')

    def test_etags_match_unquoted(self):
        assert etags_match("abc123", '"abc123"')

    def test_etags_match_weak_validator(self):
        assert etags_match('W/"abc123"', '"abc123"')

    def test_etags_match_wildcard(self):
        assert etags_match("*", '"abc123"')

    def test_etags_match_comma_separated(self):
        assert etags_match('"other", "abc123"', '"abc123"')

    def test_etags_no_match(self):
        assert not etags_match('"different"', '"abc123"')


# =============================================================================
# Integration Tests with respx
# =============================================================================


class TestFetchImageIntegration:
    """Integration tests for fetch_image using respx to mock HTTP."""

    @pytest.fixture(autouse=True)
    def clear_image_cache(self):
        """Clear the global cache before each test."""
        clear_cache()
        yield
        clear_cache()

    @respx.mock
    def test_fetch_valid_png(self, monkeypatch):
        """Test fetching a valid PNG image."""

        # Mock DNS to return public IP
        def fake_getaddrinfo(host, port, *args, **kwargs):
            return [(socket.AF_INET, socket.SOCK_STREAM, 0, "", ("93.184.216.34", 80))]

        monkeypatch.setattr(socket, "getaddrinfo", fake_getaddrinfo)

        # Mock HTTP response
        respx.get("http://example.com/image.png").mock(
            return_value=Response(200, content=TINY_PNG, headers={"Content-Type": "image/png"})
        )

        result = fetch_image("http://example.com/image.png")

        assert result.data == TINY_PNG
        assert result.content_type == "image/png"
        assert result.etag.startswith('"')
        assert not result.not_modified

    @respx.mock
    def test_fetch_caches_response(self, monkeypatch):
        """Test that responses are cached."""

        def fake_getaddrinfo(host, port, *args, **kwargs):
            return [(socket.AF_INET, socket.SOCK_STREAM, 0, "", ("93.184.216.34", 80))]

        monkeypatch.setattr(socket, "getaddrinfo", fake_getaddrinfo)

        # Mock HTTP - should only be called once
        route = respx.get("http://example.com/cached.png").mock(
            return_value=Response(200, content=TINY_PNG, headers={"Content-Type": "image/png"})
        )

        # First fetch
        result1 = fetch_image("http://example.com/cached.png")
        assert route.call_count == 1

        # Second fetch - should come from cache
        result2 = fetch_image("http://example.com/cached.png")
        assert route.call_count == 1  # No additional HTTP call

        assert result1.data == result2.data
        assert result1.etag == result2.etag

    @respx.mock
    def test_conditional_get_returns_not_modified(self, monkeypatch):
        """Test that If-None-Match matching returns 304."""

        def fake_getaddrinfo(host, port, *args, **kwargs):
            return [(socket.AF_INET, socket.SOCK_STREAM, 0, "", ("93.184.216.34", 80))]

        monkeypatch.setattr(socket, "getaddrinfo", fake_getaddrinfo)

        respx.get("http://example.com/conditional.png").mock(
            return_value=Response(200, content=TINY_PNG, headers={"Content-Type": "image/png"})
        )

        # First fetch to populate cache
        result1 = fetch_image("http://example.com/conditional.png")

        # Second fetch with matching ETag
        result2 = fetch_image("http://example.com/conditional.png", if_none_match=result1.etag)

        assert result2.not_modified
        assert result2.data == b""  # No body for 304
        assert result2.etag == result1.etag

    @respx.mock
    def test_rejects_svg_content(self, monkeypatch):
        """Test that SVG content is rejected."""

        def fake_getaddrinfo(host, port, *args, **kwargs):
            return [(socket.AF_INET, socket.SOCK_STREAM, 0, "", ("93.184.216.34", 80))]

        monkeypatch.setattr(socket, "getaddrinfo", fake_getaddrinfo)

        respx.get("http://example.com/image.svg").mock(
            return_value=Response(
                200, content=SVG_CONTENT, headers={"Content-Type": "image/svg+xml"}
            )
        )

        with pytest.raises(ApiError) as exc:
            fetch_image("http://example.com/image.svg")
        assert exc.value.code == ApiErrorCode.E_INVALID_REQUEST

    @respx.mock
    def test_rejects_svg_disguised_as_png(self, monkeypatch):
        """Test that SVG with wrong Content-Type is caught by magic byte sniffing."""

        def fake_getaddrinfo(host, port, *args, **kwargs):
            return [(socket.AF_INET, socket.SOCK_STREAM, 0, "", ("93.184.216.34", 80))]

        monkeypatch.setattr(socket, "getaddrinfo", fake_getaddrinfo)

        respx.get("http://example.com/fake.png").mock(
            return_value=Response(200, content=SVG_CONTENT, headers={"Content-Type": "image/png"})
        )

        with pytest.raises(ApiError) as exc:
            fetch_image("http://example.com/fake.png")
        assert exc.value.code == ApiErrorCode.E_INVALID_REQUEST

    def test_rejects_localhost_url(self):
        """Test that localhost URL is blocked before DNS."""
        with pytest.raises(ApiError) as exc:
            fetch_image("http://localhost/image.png")
        assert exc.value.code == ApiErrorCode.E_SSRF_BLOCKED

    def test_rejects_private_ip_literal(self):
        """Test that private IP literal is blocked."""
        with pytest.raises(ApiError) as exc:
            fetch_image("http://127.0.0.1/image.png")
        assert exc.value.code == ApiErrorCode.E_SSRF_BLOCKED

    def test_rejects_metadata_endpoint(self, monkeypatch):
        """Test that AWS metadata endpoint is blocked."""

        def fake_getaddrinfo(host, port, *args, **kwargs):
            return [(socket.AF_INET, socket.SOCK_STREAM, 0, "", ("169.254.169.254", 80))]

        monkeypatch.setattr(socket, "getaddrinfo", fake_getaddrinfo)

        with pytest.raises(ApiError) as exc:
            fetch_image("http://metadata.aws/image.png")
        assert exc.value.code == ApiErrorCode.E_SSRF_BLOCKED

    @respx.mock
    def test_handles_redirect(self, monkeypatch):
        """Test that one redirect is followed with validation."""

        def fake_getaddrinfo(host, port, *args, **kwargs):
            return [(socket.AF_INET, socket.SOCK_STREAM, 0, "", ("93.184.216.34", 80))]

        monkeypatch.setattr(socket, "getaddrinfo", fake_getaddrinfo)

        # First request returns redirect
        respx.get("http://example.com/redirect.png").mock(
            return_value=Response(302, headers={"Location": "http://cdn.example.com/image.png"})
        )
        # Second request returns image
        respx.get("http://cdn.example.com/image.png").mock(
            return_value=Response(200, content=TINY_PNG, headers={"Content-Type": "image/png"})
        )

        result = fetch_image("http://example.com/redirect.png")
        assert result.data == TINY_PNG

    @respx.mock
    def test_rejects_double_redirect(self, monkeypatch):
        """Test that more than one redirect is rejected."""

        def fake_getaddrinfo(host, port, *args, **kwargs):
            return [(socket.AF_INET, socket.SOCK_STREAM, 0, "", ("93.184.216.34", 80))]

        monkeypatch.setattr(socket, "getaddrinfo", fake_getaddrinfo)

        respx.get("http://example.com/redirect1.png").mock(
            return_value=Response(302, headers={"Location": "http://example.com/redirect2.png"})
        )
        respx.get("http://example.com/redirect2.png").mock(
            return_value=Response(302, headers={"Location": "http://example.com/final.png"})
        )

        with pytest.raises(ApiError) as exc:
            fetch_image("http://example.com/redirect1.png")
        assert exc.value.code == ApiErrorCode.E_IMAGE_FETCH_FAILED
        assert "Too many redirects" in exc.value.message

    @respx.mock
    def test_rejects_redirect_to_private_ip(self, monkeypatch):
        """Test that redirect to private IP is blocked."""
        call_count = [0]

        def fake_getaddrinfo(host, port, *args, **kwargs):
            call_count[0] += 1
            if host == "example.com":
                return [(socket.AF_INET, socket.SOCK_STREAM, 0, "", ("93.184.216.34", 80))]
            elif host == "internal.corp":
                return [(socket.AF_INET, socket.SOCK_STREAM, 0, "", ("10.0.0.1", 80))]
            raise socket.gaierror("Unknown host")

        monkeypatch.setattr(socket, "getaddrinfo", fake_getaddrinfo)

        respx.get("http://example.com/evil.png").mock(
            return_value=Response(302, headers={"Location": "http://internal.corp/secret.png"})
        )

        with pytest.raises(ApiError) as exc:
            fetch_image("http://example.com/evil.png")
        assert exc.value.code == ApiErrorCode.E_SSRF_BLOCKED


# =============================================================================
# FastAPI Route Integration Tests
# =============================================================================


class TestImageProxyEndpoint:
    """Integration tests for the /media/image endpoint.

    These tests mock the image_proxy service to avoid network calls
    and focus on testing route behavior.
    """

    def test_unauthenticated_request_rejected(self, authenticated_client):
        """Test that unauthenticated requests are rejected."""
        # Make request without auth headers
        response = authenticated_client.get(
            "/media/image", params={"url": "http://example.com/image.png"}
        )
        # Should get 401 since no auth header
        assert response.status_code == 401

    def test_authenticated_request_succeeds(self, authenticated_client, test_user_id, monkeypatch):
        """Test that authenticated requests succeed."""
        from nexus.services.image_proxy import ImageResponse

        # Mock the fetch_image function to avoid network calls
        def mock_fetch_image(url, if_none_match=None):
            return ImageResponse(
                data=TINY_PNG,
                content_type="image/png",
                etag='"test-etag"',
                not_modified=False,
            )

        monkeypatch.setattr("nexus.services.image_proxy.fetch_image", mock_fetch_image)

        response = authenticated_client.get(
            "/media/image",
            params={"url": "http://example.com/test.png"},
            headers=auth_headers(test_user_id),
        )

        assert response.status_code == 200
        assert response.headers["Content-Type"] == "image/png"
        assert response.headers["Cache-Control"] == "private, max-age=86400"
        assert response.headers["ETag"] == '"test-etag"'
        assert response.content == TINY_PNG

    def test_conditional_get_304(self, authenticated_client, test_user_id, monkeypatch):
        """Test that conditional GET returns 304."""
        from nexus.services.image_proxy import ImageResponse

        # Mock fetch_image to return not_modified
        def mock_fetch_image(url, if_none_match=None):
            if if_none_match == '"test-etag"':
                return ImageResponse(
                    data=b"",
                    content_type="image/png",
                    etag='"test-etag"',
                    not_modified=True,
                )
            return ImageResponse(
                data=TINY_PNG,
                content_type="image/png",
                etag='"test-etag"',
                not_modified=False,
            )

        monkeypatch.setattr("nexus.services.image_proxy.fetch_image", mock_fetch_image)

        # First request
        response1 = authenticated_client.get(
            "/media/image",
            params={"url": "http://example.com/etag.png"},
            headers=auth_headers(test_user_id),
        )
        assert response1.status_code == 200
        etag = response1.headers["ETag"]

        # Second request with If-None-Match
        response2 = authenticated_client.get(
            "/media/image",
            params={"url": "http://example.com/etag.png"},
            headers={**auth_headers(test_user_id), "If-None-Match": etag},
        )

        assert response2.status_code == 304
        assert response2.content == b""

    def test_ssrf_blocked_returns_403(self, authenticated_client, test_user_id):
        """Test that SSRF attempts return 403."""
        clear_cache()

        response = authenticated_client.get(
            "/media/image",
            params={"url": "http://localhost/secret.png"},
            headers=auth_headers(test_user_id),
        )

        assert response.status_code == 403
        data = response.json()
        assert data["error"]["code"] == "E_SSRF_BLOCKED"

    def test_oversized_image_returns_413(self, authenticated_client, test_user_id, monkeypatch):
        """Test that oversized images return 413."""
        from nexus.errors import ApiError, ApiErrorCode

        # Mock fetch_image to raise size limit error
        def mock_fetch_image(url, if_none_match=None):
            raise ApiError(ApiErrorCode.E_IMAGE_TOO_LARGE, "Image exceeds maximum size")

        monkeypatch.setattr("nexus.services.image_proxy.fetch_image", mock_fetch_image)

        response = authenticated_client.get(
            "/media/image",
            params={"url": "http://example.com/huge.png"},
            headers=auth_headers(test_user_id),
        )

        assert response.status_code == 413
        data = response.json()
        assert data["error"]["code"] == "E_IMAGE_TOO_LARGE"


# =============================================================================
# E2E Integration Tests for Image Proxy (PR-11)
# =============================================================================


class TestImageProxyE2E:
    """E2E integration tests for image proxy per PR-11 spec section 7.

    Tests verify:
    1. Request proxied image returns correct headers
    2. ETag present in response
    3. Cache-Control present in response
    4. Re-request with If-None-Match returns 304

    These tests use respx to mock upstream HTTP but test the full
    endpoint flow including caching behavior.
    """

    @pytest.fixture(autouse=True)
    def clear_image_cache_e2e(self):
        """Clear the global cache before each test."""
        clear_cache()
        yield
        clear_cache()

    @respx.mock
    def test_e2e_proxied_image_has_required_headers(
        self, authenticated_client, test_user_id, monkeypatch
    ):
        """PR-11 Section 7.2: Verify Content-Type, ETag, and Cache-Control headers."""

        def fake_getaddrinfo(host, port, *args, **kwargs):
            return [(socket.AF_INET, socket.SOCK_STREAM, 0, "", ("93.184.216.34", 80))]

        monkeypatch.setattr(socket, "getaddrinfo", fake_getaddrinfo)

        respx.get("http://example.com/photo.png").mock(
            return_value=Response(200, content=TINY_PNG, headers={"Content-Type": "image/png"})
        )

        response = authenticated_client.get(
            "/media/image",
            params={"url": "http://example.com/photo.png"},
            headers=auth_headers(test_user_id),
        )

        # Assert Content-Type is image/*
        assert response.status_code == 200
        assert response.headers["Content-Type"].startswith("image/")

        # Assert ETag present
        assert "ETag" in response.headers
        etag = response.headers["ETag"]
        assert etag.startswith('"')
        assert etag.endswith('"')

        # Assert Cache-Control present
        assert "Cache-Control" in response.headers
        assert "max-age" in response.headers["Cache-Control"]

    @respx.mock
    def test_e2e_conditional_request_returns_304(
        self, authenticated_client, test_user_id, monkeypatch
    ):
        """PR-11 Section 7.3: Re-request with If-None-Match returns 304 Not Modified."""

        def fake_getaddrinfo(host, port, *args, **kwargs):
            return [(socket.AF_INET, socket.SOCK_STREAM, 0, "", ("93.184.216.34", 80))]

        monkeypatch.setattr(socket, "getaddrinfo", fake_getaddrinfo)

        respx.get("http://example.com/cached.png").mock(
            return_value=Response(200, content=TINY_PNG, headers={"Content-Type": "image/png"})
        )

        # First request
        response1 = authenticated_client.get(
            "/media/image",
            params={"url": "http://example.com/cached.png"},
            headers=auth_headers(test_user_id),
        )

        assert response1.status_code == 200
        etag = response1.headers["ETag"]
        assert etag is not None

        # Second request with If-None-Match
        response2 = authenticated_client.get(
            "/media/image",
            params={"url": "http://example.com/cached.png"},
            headers={**auth_headers(test_user_id), "If-None-Match": etag},
        )

        # Should return 304 Not Modified
        assert response2.status_code == 304
        assert response2.content == b""
        # ETag should still be present in 304 response
        assert "ETag" in response2.headers

    @respx.mock
    def test_e2e_different_etag_returns_full_response(
        self, authenticated_client, test_user_id, monkeypatch
    ):
        """Verify mismatched ETag returns full 200 response."""

        def fake_getaddrinfo(host, port, *args, **kwargs):
            return [(socket.AF_INET, socket.SOCK_STREAM, 0, "", ("93.184.216.34", 80))]

        monkeypatch.setattr(socket, "getaddrinfo", fake_getaddrinfo)

        respx.get("http://example.com/mismatch.png").mock(
            return_value=Response(200, content=TINY_PNG, headers={"Content-Type": "image/png"})
        )

        # Request with wrong ETag
        response = authenticated_client.get(
            "/media/image",
            params={"url": "http://example.com/mismatch.png"},
            headers={**auth_headers(test_user_id), "If-None-Match": '"wrong-etag"'},
        )

        # Should return full 200 response
        assert response.status_code == 200
        assert len(response.content) > 0

    @respx.mock
    def test_e2e_wildcard_etag_returns_304(self, authenticated_client, test_user_id, monkeypatch):
        """Verify wildcard If-None-Match (*) returns 304 if cached."""

        def fake_getaddrinfo(host, port, *args, **kwargs):
            return [(socket.AF_INET, socket.SOCK_STREAM, 0, "", ("93.184.216.34", 80))]

        monkeypatch.setattr(socket, "getaddrinfo", fake_getaddrinfo)

        respx.get("http://example.com/wildcard.png").mock(
            return_value=Response(200, content=TINY_PNG, headers={"Content-Type": "image/png"})
        )

        # First request to populate cache
        response1 = authenticated_client.get(
            "/media/image",
            params={"url": "http://example.com/wildcard.png"},
            headers=auth_headers(test_user_id),
        )
        assert response1.status_code == 200

        # Second request with wildcard
        response2 = authenticated_client.get(
            "/media/image",
            params={"url": "http://example.com/wildcard.png"},
            headers={**auth_headers(test_user_id), "If-None-Match": "*"},
        )

        assert response2.status_code == 304
