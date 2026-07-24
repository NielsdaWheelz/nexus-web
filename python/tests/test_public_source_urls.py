from __future__ import annotations

from uuid import uuid4

import pytest

from nexus.services.public_source_urls import (
    CurrentSourceIdentity,
    current_public_source_url,
    public_source_url,
)


def _identity(
    url: str | None,
    *,
    source_type: str = "generic_web_url",
    requested_url: str | None = None,
    provider: str | None = None,
    provider_target_ref: str | None = None,
) -> CurrentSourceIdentity:
    return CurrentSourceIdentity(
        source_type=source_type,
        canonical_source_url=url,
        requested_url=url if requested_url is None else requested_url,
        provider=provider,
        provider_target_ref=provider_target_ref,
    )


@pytest.mark.parametrize(
    "url",
    [
        "https://user@example.org/private",
        "https://user:password@example.org/private",
        "http://127.0.0.1/private",
        "http://[::1]/private",
        "http://2130706433/private",
        "http://localhost/private",
        "http://service.local/private",
        "http://service.internal/private",
        "http://single-label/private",
        "https://bad_label.example.org/private",
        "https://example.org\\@attacker.example/private",
        "https://example.org/\nprivate",
    ],
)
def test_generic_public_source_rejects_credential_and_privateish_hosts(url: str) -> None:
    assert public_source_url(_identity(url)) is None


def test_generic_public_source_strips_query_params_fragments_and_path_params() -> None:
    assert (
        public_source_url(
            _identity(
                "https://News.Example.ORG:443/story;session=secret"
                "?X-Amz-Signature=secret&token=private#highlight"
            )
        )
        == "https://news.example.org/story"
    )


def test_generic_public_source_canonicalizes_unicode_hostname_to_idna() -> None:
    assert (
        public_source_url(_identity("https://Bücher.Example.ORG/read"))
        == "https://xn--bcher-kva.example.org/read"
    )


@pytest.mark.parametrize(
    "source_type",
    [
        "browser_article_capture",
        "browser_pdf_capture",
        "browser_epub_capture",
        "uploaded_pdf_file",
        "uploaded_epub_file",
        "unknown",
    ],
)
def test_non_allowlisted_source_types_never_egress_urls(source_type: str) -> None:
    assert (
        public_source_url(
            _identity(
                "https://example.org/private?token=secret#fragment",
                source_type=source_type,
            )
        )
        is None
    )


@pytest.mark.parametrize(
    ("identity", "expected"),
    [
        (
            _identity(
                "https://x.com/user/status/123",
                source_type="x_post",
                provider="x",
                provider_target_ref="123",
            ),
            "https://x.com/i/status/123",
        ),
        (
            _identity(
                "https://youtu.be/abcdefghijk",
                source_type="youtube_video",
                provider="youtube",
                provider_target_ref="abcdefghijk",
            ),
            "https://www.youtube.com/watch?v=abcdefghijk",
        ),
        (
            _identity(
                "https://arxiv.org/pdf/2401.12345.pdf",
                source_type="remote_pdf_url",
            ),
            "https://arxiv.org/abs/2401.12345",
        ),
    ],
)
def test_provider_source_identity_positive_matrix(
    identity: CurrentSourceIdentity,
    expected: str,
) -> None:
    assert public_source_url(identity) == expected


@pytest.mark.parametrize(
    "identity",
    [
        _identity(
            "https://x.com/user/status/123",
            source_type="x_post",
            provider=None,
            provider_target_ref="123",
        ),
        _identity(
            "https://x.com/user/status/456",
            source_type="x_post",
            provider="x",
            provider_target_ref="123",
        ),
        _identity(
            "https://youtu.be/abcdefghijk",
            source_type="youtube_video",
            provider=None,
            provider_target_ref="abcdefghijk",
        ),
        _identity(
            "https://youtu.be/lmnopqrstuv",
            source_type="youtube_video",
            provider="youtube",
            provider_target_ref="abcdefghijk",
        ),
        _identity(
            "https://arxiv.org/pdf/2401.12345.pdf",
            source_type="remote_pdf_url",
            requested_url="https://arxiv.org/pdf/2401.54321.pdf",
        ),
        _identity(
            None,
            source_type="remote_pdf_url",
            requested_url=None,
            provider="arxiv",
            provider_target_ref="../../private",
        ),
        _identity(
            None,
            source_type="x_post",
            requested_url=None,
            provider="x",
            provider_target_ref="１２３",
        ),
    ],
)
def test_missing_or_conflicting_provider_identity_is_absent(
    identity: CurrentSourceIdentity,
) -> None:
    assert public_source_url(identity) is None


def test_current_source_query_uses_the_same_total_order_as_projection_facts() -> None:
    class EmptyDb:
        statement = ""

        def execute(self, statement, _params):
            self.statement = str(statement)
            return self

        def mappings(self):
            return self

        def first(self):
            return None

    db = EmptyDb()

    assert current_public_source_url(db, media_id=uuid4()) is None
    assert "ORDER BY attempt_no DESC, id DESC" in db.statement
