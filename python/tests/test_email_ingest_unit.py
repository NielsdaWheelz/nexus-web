"""Unit tests for the email ingest service primitives.

Tests HMAC verification, MIME extraction, and Message-ID normalization in
isolation. No database or storage required.
"""

from __future__ import annotations

import hashlib
import hmac as hmac_lib
from pathlib import Path

import pytest

from nexus.services.email_ingest_service import (
    _synthesize_message_id,
    extract_email_html,
    normalize_message_id,
    verify_email_signature,
)

pytestmark = pytest.mark.unit

_FIXTURES_DIR = Path(__file__).parent / "fixtures" / "email"


def _eml(name: str) -> bytes:
    return (_FIXTURES_DIR / name).read_bytes()


def _sign(body: bytes, secret: str) -> str:
    return hmac_lib.new(secret.encode("utf-8"), body, hashlib.sha256).hexdigest()


class TestVerifyEmailSignature:
    def test_valid_signature_returns_true(self):
        body = b"hello world"
        secret = "my-test-secret"
        sig = _sign(body, secret)
        assert verify_email_signature(body, sig, secret) is True

    def test_tampered_body_returns_false(self):
        body = b"hello world"
        secret = "my-test-secret"
        sig = _sign(body, secret)
        assert verify_email_signature(b"hello worldX", sig, secret) is False

    def test_wrong_secret_returns_false(self):
        body = b"hello"
        sig = _sign(body, "secret-a")
        assert verify_email_signature(body, sig, "secret-b") is False

    def test_absent_signature_returns_false(self):
        assert verify_email_signature(b"hello", None, "secret") is False

    def test_blank_secret_returns_false(self):
        body = b"hello"
        sig = _sign(body, "")
        assert verify_email_signature(body, sig, "") is False

    def test_malformed_hex_header_returns_false(self):
        assert verify_email_signature(b"hello", "not-hex!!!", "secret") is False

    def test_empty_body_valid_signature(self):
        body = b""
        secret = "sec"
        sig = _sign(body, secret)
        assert verify_email_signature(body, sig, secret) is True

    def test_signature_is_case_insensitive(self):
        body = b"data"
        secret = "s"
        sig = _sign(body, secret).upper()
        assert verify_email_signature(body, sig, secret) is True


class TestNormalizeMessageId:
    def test_strips_angle_brackets(self):
        assert normalize_message_id("<msg@example.com>") == "msg@example.com"

    def test_lowercases_host(self):
        assert normalize_message_id("<MSG@EXAMPLE.COM>") == "MSG@example.com"

    def test_strips_whitespace(self):
        assert normalize_message_id("  <msg@h.com>  ") == "msg@h.com"

    def test_no_brackets_passthrough(self):
        assert normalize_message_id("msg@host.com") == "msg@host.com"

    def test_none_returns_none(self):
        assert normalize_message_id(None) is None

    def test_empty_returns_none(self):
        assert normalize_message_id("") is None

    def test_blank_returns_none(self):
        assert normalize_message_id("   ") is None


class TestSynthesizeMessageId:
    def test_deterministic_for_same_body(self):
        body = b"test body content"
        assert _synthesize_message_id(body) == _synthesize_message_id(body)

    def test_differs_for_different_body(self):
        assert _synthesize_message_id(b"a") != _synthesize_message_id(b"b")

    def test_starts_with_prefix(self):
        mid = _synthesize_message_id(b"x")
        assert mid.startswith("synthesized-")


class TestExtractEmailHtml:
    def test_multipart_prefers_html_part(self):
        eml = _eml("substack_issue.eml")
        html, subject, date = extract_email_html(eml)
        # Should return the HTML part, not the wrapped plain-text
        assert "<h1>" in html
        assert subject == "The Weekly Dispatch: Issue 42"

    def test_plain_text_only_is_wrapped(self):
        eml = _eml("plain_text.eml")
        html, subject, date = extract_email_html(eml)
        assert "<pre>" in html
        assert "Hello reader" in html
        assert subject == "A Plain Text Letter"

    def test_no_text_part_raises(self):
        eml = _eml("no_text_part.eml")
        from nexus.errors import InvalidRequestError

        with pytest.raises(InvalidRequestError, match="no readable text"):
            extract_email_html(eml)

    def test_subject_decoded(self):
        eml = _eml("substack_issue.eml")
        _, subject, _ = extract_email_html(eml)
        assert subject == "The Weekly Dispatch: Issue 42"

    def test_date_parsed_to_iso(self):
        eml = _eml("substack_issue.eml")
        _, _, date = extract_email_html(eml)
        assert date == "2026-07-07"

    def test_no_text_part_returns_no_html(self):
        eml = _eml("no_text_part.eml")
        from nexus.errors import InvalidRequestError

        with pytest.raises(InvalidRequestError):
            extract_email_html(eml)


class TestEmailIngestNegativeGates:
    """Static source-grep invariants (G-2, G-3, G-4, G-5, G-6)."""

    def _read(self, rel: str) -> str:
        root = Path(__file__).resolve().parents[2]
        return (root / rel).read_text(encoding="utf-8")

    def test_g2_two_compare_digest_calls(self):
        """G-2: exactly one compare_digest in the service + one in the route."""
        svc = self._read("python/nexus/services/email_ingest_service.py")
        route = self._read("python/nexus/api/routes/email_ingest.py")
        assert svc.count("compare_digest") == 1, "service must have exactly one compare_digest"
        assert route.count("compare_digest") == 1, "route must have exactly one compare_digest"

    def test_g3_no_get_viewer_in_route(self):
        """G-3: email_ingest.py must not depend on get_viewer."""
        route = self._read("python/nexus/api/routes/email_ingest.py")
        assert "get_viewer" not in route
        assert "Depends(get_viewer)" not in route

    def test_g4_no_email_in_media_kind_check(self):
        """G-4: no 'email' MediaKind — the ck_media_kind CHECK literal must not contain it."""
        models = self._read("python/nexus/db/models.py")
        import re

        # The constraint literal PRECEDES the name= argument, so capture the string
        # argument that immediately precedes name="ck_media_kind" and assert against it
        # directly (a lookahead-to-next-CheckConstraint match would miss the literal).
        match = re.search(
            r'CheckConstraint\(\s*"([^"]*)"\s*,\s*name="ck_media_kind"',
            models,
        )
        assert match is not None, "ck_media_kind CheckConstraint not found in models.py"
        kind_literal = match.group(1)
        assert "email" not in kind_literal, (
            f"'email' must not be a MediaKind; ck_media_kind = {kind_literal!r}"
        )
        # Positive control: the guard is actually looking at the kind allowlist.
        assert "web_article" in kind_literal

    def test_g5_no_sanitizer_call_in_email_files(self):
        """G-5: email-authored files do not call the sanitizer or fragment builder directly."""
        svc = self._read("python/nexus/services/email_ingest_service.py")
        route = self._read("python/nexus/api/routes/email_ingest.py")
        assert "sanitize_html" not in svc
        assert "sanitize_html" not in route
        assert "prepare_web_article_fragment" not in svc
        assert "prepare_web_article_fragment" not in route

    def test_g6_email_in_strong_authorities(self):
        """G-6: 'email' is in STRONG_CONTRIBUTOR_EXTERNAL_ID_AUTHORITIES."""
        taxonomy = self._read("python/nexus/services/contributor_taxonomy.py")
        # Confirm it's in the strong set literal
        assert '"email"' in taxonomy or "'email'" in taxonomy
        from nexus.services.contributor_taxonomy import STRONG_CONTRIBUTOR_EXTERNAL_ID_AUTHORITIES

        assert "email" in STRONG_CONTRIBUTOR_EXTERNAL_ID_AUTHORITIES
