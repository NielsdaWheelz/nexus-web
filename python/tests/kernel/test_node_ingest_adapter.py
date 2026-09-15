from __future__ import annotations

import json

import pytest

from nexus.errors import ApiErrorCode
from nexus.services import node_ingest
from nexus.services.node_ingest import (
    IngestError,
    NodeIngestProtocolDefect,
)


@pytest.mark.parametrize(
    ("failure", "expected"),
    (
        (
            {"tag": "UnsupportedMediaType"},
            IngestError(ApiErrorCode.E_INVALID_CONTENT_TYPE, "Source is not an HTML document."),
        ),
        (
            {"tag": "UnsupportedContentEncoding"},
            IngestError(
                ApiErrorCode.E_INVALID_CONTENT_TYPE,
                "Source uses an unsupported content encoding.",
            ),
        ),
        (
            {"tag": "TooLarge", "limit": "decompressed"},
            IngestError(ApiErrorCode.E_SOURCE_TOO_LARGE, "Source exceeds the import size limit."),
        ),
        (
            {"tag": "Readability"},
            IngestError(
                ApiErrorCode.E_SOURCE_NOT_READABLE,
                "Source does not contain a readable article.",
            ),
        ),
        (
            {"tag": "Http", "status": 401},
            IngestError(ApiErrorCode.E_SOURCE_ACCESS_DENIED, "Source denied access."),
        ),
        (
            {"tag": "Http", "status": 404},
            IngestError(ApiErrorCode.E_SOURCE_FETCH_FAILED, "HTTP error: 404"),
        ),
        (
            {"tag": "Http", "status": 500},
            IngestError(ApiErrorCode.E_SOURCE_FETCH_FAILED, "HTTP error: 500"),
        ),
        (
            {"tag": "Network"},
            IngestError(ApiErrorCode.E_SOURCE_FETCH_FAILED, "Source fetch failed."),
        ),
        (
            {"tag": "Timeout"},
            IngestError(ApiErrorCode.E_INGEST_TIMEOUT, "Source fetch timed out."),
        ),
        (
            {"tag": "TooManyRedirects"},
            IngestError(
                ApiErrorCode.E_SOURCE_FETCH_FAILED,
                "Source redirected too many times.",
            ),
        ),
    ),
)
def test_modeled_node_failures_have_only_closed_safe_api_outcomes(
    failure: dict[str, object],
    expected: IngestError,
) -> None:
    """Risk: untrusted Node diagnostic detail becomes a durable public error."""
    result = node_ingest._decode_result(
        json.dumps({"version": 1, "tag": "Failure", "failure": failure}).encode("utf-8"),
    )

    assert result == expected


@pytest.mark.parametrize(
    "failure",
    (
        {"tag": "TooLarge", "limit": "unbounded"},
        {"tag": "Http", "status": 200},
        {"tag": "Unexpected"},
        {"tag": "Network", "detail": "private-peer=169.254.169.254"},
    ),
)
def test_node_failure_decoder_rejects_non_closed_variants(failure: dict[str, object]) -> None:
    with pytest.raises(NodeIngestProtocolDefect, match="unsupported|invalid|impossible"):
        node_ingest._decode_result(
            json.dumps({"version": 1, "tag": "Failure", "failure": failure}).encode("utf-8"),
        )


def _success_payload() -> dict[str, object]:
    return {
        "version": 1,
        "tag": "Success",
        "final_url": "https://example.test/article",
        "base_url": "https://example.test/article",
        "title": "Example article",
        "content_html": "<article>safe</article>",
        "source_html": "<html><body>safe</body></html>",
        "byline": "Author",
        "excerpt": "Excerpt",
        "site_name": "Example",
        "published_time": "2026-08-14T00:00:00Z",
    }


def test_node_success_is_typed_bounded_and_returns_one_normalized_final_url() -> None:
    """Risk: a compromised owned process injects an unbounded or noncanonical article shape."""
    payload = _success_payload()

    assert node_ingest._decode_result(
        json.dumps(payload).encode("utf-8")
    ) == node_ingest.IngestResult(
        final_url="https://example.test/article",
        base_url="https://example.test/article",
        title="Example article",
        content_html="<article>safe</article>",
        source_html="<html><body>safe</body></html>",
        byline="Author",
        excerpt="Excerpt",
        site_name="Example",
        published_time="2026-08-14T00:00:00Z",
    )

    payload["base_url"] = "https://example.test/other"
    with pytest.raises(NodeIngestProtocolDefect, match="Success payload"):
        node_ingest._decode_result(json.dumps(payload).encode("utf-8"))


@pytest.mark.parametrize(
    ("field", "length"),
    (
        ("content_html", 10 * 1024 * 1024 + 1),
        ("source_html", 10 * 1024 * 1024 + 1),
        ("title", 1_001),
        ("byline", 1_001),
        ("excerpt", 2_001),
        ("site_name", 256),
        ("published_time", 65),
    ),
)
def test_node_success_rejects_each_overlong_owned_field(field: str, length: int) -> None:
    payload = _success_payload()
    payload[field] = "x" * length

    with pytest.raises(NodeIngestProtocolDefect, match="Success payload"):
        node_ingest._decode_result(json.dumps(payload).encode("utf-8"))


def test_node_success_rejects_a_final_url_above_the_owned_bound() -> None:
    payload = _success_payload()
    overlong_url = "https://example.test/" + "x" * node_ingest.MAX_URL_LENGTH
    payload["final_url"] = overlong_url
    payload["base_url"] = overlong_url

    with pytest.raises(NodeIngestProtocolDefect, match="Success payload"):
        node_ingest._decode_result(json.dumps(payload).encode("utf-8"))

    payload["base_url"] = "https://example.test/article"
    payload["final_url"] = "https://EXAMPLE.test/article"
    with pytest.raises(NodeIngestProtocolDefect, match="Success payload"):
        node_ingest._decode_result(json.dumps(payload).encode("utf-8"))
