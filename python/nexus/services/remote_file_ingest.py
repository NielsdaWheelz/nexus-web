"""Remote file URL classification for durable source ingest."""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Literal
from urllib.parse import unquote, urlparse

_ARXIV_PDF_PATH_RE = re.compile(
    r"^/pdf/(?P<arxiv_id>(?:[a-z.-]+/)?(?:\d{4}\.\d{4,5}|\d{7})(?:v\d+)?)(?:\.pdf)?$",
    re.IGNORECASE,
)
_ARXIV_PDF_HOSTS = {"arxiv.org", "www.arxiv.org", "export.arxiv.org"}
_EPUB_SUFFIXES = (
    ".epub",
    ".epub.images",
    ".epub.noimages",
    ".epub3",
    ".epub3.images",
    ".epub3.noimages",
)

RemoteFileKind = Literal["pdf", "epub"]


@dataclass(frozen=True, slots=True)
class ArxivPdfSource:
    arxiv_id: str
    source_url: str


def remote_file_kind_from_url(url: str) -> RemoteFileKind | None:
    """Classify a URL as a downloadable PDF or EPUB by its path, else ``None``."""
    path = unquote(urlparse(url).path).lower()
    if path.endswith(".pdf"):
        return "pdf"
    if path.endswith(_EPUB_SUFFIXES):
        return "epub"
    return "pdf" if arxiv_pdf_source_from_url(url) is not None else None


def arxiv_pdf_source_from_url(url: str) -> ArxivPdfSource | None:
    """Map an arxiv ``/pdf/<id>`` URL to its e-print source package URL."""
    parsed = urlparse(url)
    if (parsed.hostname or "").lower() not in _ARXIV_PDF_HOSTS:
        return None
    match = _ARXIV_PDF_PATH_RE.match(parsed.path)
    if match is None:
        return None
    arxiv_id = match.group("arxiv_id")
    return ArxivPdfSource(arxiv_id=arxiv_id, source_url=f"https://arxiv.org/e-print/{arxiv_id}")
