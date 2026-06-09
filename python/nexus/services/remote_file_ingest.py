"""Remote file URL classification for durable source ingest."""

import re
from dataclasses import dataclass
from urllib.parse import urlparse

_ARXIV_PDF_PATH_RE = re.compile(
    r"^/pdf/(?P<arxiv_id>(?:[a-z.-]+/)?(?:\d{4}\.\d{4,5}|\d{7})(?:v\d+)?)(?:\.pdf)?$",
    re.IGNORECASE,
)
_ARXIV_PDF_HOSTS = {"arxiv.org", "www.arxiv.org", "export.arxiv.org"}


@dataclass(frozen=True)
class ArxivPdfSource:
    arxiv_id: str
    source_url: str


def remote_file_kind_from_url(url: str) -> str | None:
    parsed = urlparse(url)
    path = parsed.path.lower()
    if path.endswith(".pdf"):
        return "pdf"
    if path.endswith(".epub") or path.endswith(".epub.noimages") or path.endswith(".epub.images"):
        return "epub"
    if arxiv_pdf_source_from_url(url) is not None:
        return "pdf"
    return None


def arxiv_pdf_source_from_url(url: str) -> ArxivPdfSource | None:
    parsed = urlparse(url)
    if (parsed.hostname or "").lower() not in _ARXIV_PDF_HOSTS:
        return None
    match = _ARXIV_PDF_PATH_RE.match(parsed.path)
    if match is None:
        return None
    arxiv_id = match.group("arxiv_id")
    return ArxivPdfSource(
        arxiv_id=arxiv_id,
        source_url=f"https://arxiv.org/e-print/{arxiv_id}",
    )
