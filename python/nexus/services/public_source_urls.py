"""The allowlisted public source URL for anonymous media projections.

Only a handful of source types may leak their origin URL to an anonymous
viewer, and only when every identity the attempt carries — provider target ref,
canonical source URL, requested URL — canonicalizes to the same public URL.
"""

from __future__ import annotations

import ipaddress
import re
import unicodedata
from urllib.parse import quote, urlparse, urlunparse
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.services.remote_file_ingest import arxiv_pdf_source_from_url
from nexus.services.x_identity import classify_x_url
from nexus.services.x_types import canonical_x_post_url
from nexus.services.youtube_identity import (
    classify_youtube_provider_video_id,
    classify_youtube_url,
)

_BLOCKED_HOST_SUFFIXES = (
    ".example",
    ".home",
    ".internal",
    ".invalid",
    ".lan",
    ".local",
    ".localhost",
    ".test",
)
_DNS_LABEL_RE = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$")
_MAX_PUBLIC_URL_BYTES = 2048


def current_public_source_url(db: Session, *, media_id: UUID) -> str | None:
    """The allowlisted public URL of the current successful source, if any."""
    row = (
        db.execute(
            text(
                """
                SELECT source_type, canonical_source_url, requested_url,
                       provider, provider_target_ref
                FROM media_source_attempts
                WHERE media_id = :media_id
                  AND status = 'succeeded'
                ORDER BY attempt_no DESC, id DESC
                LIMIT 1
                """
            ),
            {"media_id": media_id},
        )
        .mappings()
        .first()
    )
    if row is None:
        return None
    source_type = str(row["source_type"])
    provider = row["provider"]
    ref = str(row["provider_target_ref"] or "").strip()
    urls = [value for value in (row["canonical_source_url"], row["requested_url"]) if value]

    if source_type == "generic_web_url":
        return _canonical_public_http_url(row["canonical_source_url"])
    if source_type in {"x_author_thread", "x_post"} and provider == "x":
        return _agreed(
            [canonical_x_post_url(ref) if re.fullmatch(r"[0-9]+", ref) else None] if ref else [],
            [_x_identity(url) for url in urls],
        )
    if source_type in {"youtube_video", "video_transcript"} and provider == "youtube":
        return _agreed(
            [_youtube_identity_from_ref(ref)] if ref else [],
            [_youtube_identity(url) for url in urls],
        )
    if source_type == "remote_pdf_url" and provider in {None, "arxiv"}:
        return _agreed(
            [_arxiv_abs_url(f"https://arxiv.org/abs/{ref}")] if ref else [],
            [
                _arxiv_abs_url(url)
                for url in (row["requested_url"], row["canonical_source_url"])
                if url
            ],
        )
    return None


def _agreed(from_ref: list[str | None], from_urls: list[str | None]) -> str | None:
    """One URL only when every identity present canonicalizes to the same value."""
    identities = [*from_ref, *from_urls]
    if not identities or any(identity is None for identity in identities):
        return None
    return identities[0] if len(set(identities)) == 1 else None


def _x_identity(url: str) -> str | None:
    identity = classify_x_url(url)
    return None if identity is None else identity.canonical_url


def _youtube_identity(url: str) -> str | None:
    identity = classify_youtube_url(url)
    return None if identity is None else identity.watch_url


def _youtube_identity_from_ref(ref: str) -> str | None:
    identity = classify_youtube_provider_video_id(ref)
    return None if identity is None else identity.watch_url


def _arxiv_abs_url(url: str) -> str | None:
    arxiv = arxiv_pdf_source_from_url(url)
    return None if arxiv is None else f"https://arxiv.org/abs/{arxiv.arxiv_id}"


def _canonical_public_http_url(raw: object) -> str | None:
    """A strict, auditable public http(s) URL: named host, no IP literal, no credentials."""
    if not isinstance(raw, str):
        return None
    try:
        parsed = urlparse(raw)
        port = parsed.port
    except ValueError:
        return None
    scheme = parsed.scheme.lower()
    unicode_host = (parsed.hostname or "").lower().rstrip(".")
    if (
        scheme not in {"http", "https"}
        or not unicode_host
        or parsed.username is not None
        or parsed.password is not None
        or "\\" in raw
        or any(char.isspace() or unicodedata.category(char).startswith("C") for char in raw)
    ):
        return None
    try:
        host = unicode_host.encode("idna").decode("ascii").lower()
    except UnicodeError:
        return None
    labels = host.split(".")
    if (
        len(host) > 253
        or len(labels) < 2
        or any(_DNS_LABEL_RE.fullmatch(label) is None for label in labels)
        or any(host == suffix[1:] or host.endswith(suffix) for suffix in _BLOCKED_HOST_SUFFIXES)
    ):
        return None
    try:
        ipaddress.ip_address(host)
    except ValueError:
        pass
    else:
        return None
    default_port = 80 if scheme == "http" else 443
    netloc = f"{host}:{port}" if port is not None and port != default_port else host
    path = parsed.path or "/"
    if re.search(r"%(?![0-9A-Fa-f]{2})", path):
        return None
    normalized = urlunparse((scheme, netloc, quote(path, safe="/:@!$&'()*+,;=-._~%"), "", "", ""))
    return normalized if len(normalized.encode("utf-8")) <= _MAX_PUBLIC_URL_BYTES else None
