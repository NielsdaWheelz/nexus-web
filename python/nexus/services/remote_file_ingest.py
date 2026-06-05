"""Remote file URL classification for durable source ingest."""

from urllib.parse import urlparse


def remote_file_kind_from_url(url: str) -> str | None:
    path = urlparse(url).path.lower()
    if path.endswith(".pdf"):
        return "pdf"
    if path.endswith(".epub") or path.endswith(".epub.noimages") or path.endswith(".epub.images"):
        return "epub"
    return None
