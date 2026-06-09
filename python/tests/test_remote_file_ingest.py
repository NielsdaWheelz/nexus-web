import pytest

from nexus.services.remote_file_ingest import arxiv_pdf_source_from_url, remote_file_kind_from_url


@pytest.mark.parametrize(
    ("url", "expected"),
    [
        ("https://example.com/report.pdf", "pdf"),
        ("https://example.com/report.PDF?download=1", "pdf"),
        ("https://example.com/book.epub", "epub"),
        ("https://example.com/book.epub.images", "epub"),
        ("https://arxiv.org/pdf/1706.03762", "pdf"),
        ("https://arxiv.org/pdf/1706.03762v7", "pdf"),
        ("https://export.arxiv.org/pdf/math/0301234", "pdf"),
        ("https://arxiv.org/pdf/q-bio.NC/0301234", "pdf"),
    ],
)
def test_remote_file_kind_from_url_recognizes_owned_remote_file_urls(url, expected):
    assert remote_file_kind_from_url(url) == expected


@pytest.mark.parametrize(
    "url",
    [
        "https://arxiv.org/abs/1706.03762",
        "https://example.com/pdf/1706.03762",
        "https://example.com/report",
        "https://arxiv.org/pdf/",
        "https://arxiv.org/pdf/not-an-arxiv-id",
    ],
)
def test_remote_file_kind_from_url_keeps_non_file_urls_as_web(url):
    assert remote_file_kind_from_url(url) is None


@pytest.mark.parametrize(
    ("url", "arxiv_id", "source_url"),
    [
        (
            "https://arxiv.org/pdf/1706.03762",
            "1706.03762",
            "https://arxiv.org/e-print/1706.03762",
        ),
        (
            "https://arxiv.org/pdf/1706.03762v7.pdf",
            "1706.03762v7",
            "https://arxiv.org/e-print/1706.03762v7",
        ),
        (
            "https://export.arxiv.org/pdf/q-bio.NC/0301234",
            "q-bio.NC/0301234",
            "https://arxiv.org/e-print/q-bio.NC/0301234",
        ),
    ],
)
def test_arxiv_pdf_source_from_url_builds_matching_source_package_url(
    url,
    arxiv_id,
    source_url,
):
    source = arxiv_pdf_source_from_url(url)

    assert source is not None
    assert source.arxiv_id == arxiv_id
    assert source.source_url == source_url


def test_arxiv_pdf_source_from_url_rejects_non_pdf_arxiv_urls():
    assert arxiv_pdf_source_from_url("https://arxiv.org/abs/1706.03762") is None
