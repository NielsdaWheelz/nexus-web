"""Closed owner of source URLs allowed in anonymous media projections."""

from __future__ import annotations

import ipaddress
import re
import unicodedata
from dataclasses import dataclass
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

_PUBLIC_SOURCE_TYPES = frozenset(
    {
        "generic_web_url",
        "x_author_thread",
        "x_post",
        "youtube_video",
        "video_transcript",
        "remote_pdf_url",
    }
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


@dataclass(frozen=True, slots=True)
class CurrentSourceIdentity:
    """Source-owned identity from the current successful acquisition attempt."""

    source_type: str
    canonical_source_url: str | None
    requested_url: str | None
    provider: str | None
    provider_target_ref: str | None


def current_public_source_url(db: Session, *, media_id: UUID) -> str | None:
    """Return the allowlisted public URL for the current successful source."""
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
    return public_source_url(
        CurrentSourceIdentity(
            source_type=str(row["source_type"]),
            canonical_source_url=(
                str(row["canonical_source_url"])
                if row["canonical_source_url"] is not None
                else None
            ),
            requested_url=str(row["requested_url"]) if row["requested_url"] is not None else None,
            provider=str(row["provider"]) if row["provider"] is not None else None,
            provider_target_ref=(
                str(row["provider_target_ref"]) if row["provider_target_ref"] is not None else None
            ),
        )
    )


def public_source_url(identity: CurrentSourceIdentity) -> str | None:
    """Project only source identities explicitly approved for anonymous egress."""
    if identity.source_type not in _PUBLIC_SOURCE_TYPES:
        return None

    if identity.source_type == "generic_web_url":
        return _canonical_public_http_url(identity.canonical_source_url)

    if identity.source_type in {"x_author_thread", "x_post"}:
        if identity.provider != "x":
            return None
        identities: list[str] = []
        provider_target_ref = (identity.provider_target_ref or "").strip()
        if provider_target_ref:
            if re.fullmatch(r"[0-9]+", provider_target_ref) is None:
                return None
            identities.append(canonical_x_post_url(provider_target_ref))
        for candidate in (identity.canonical_source_url, identity.requested_url):
            if candidate:
                classified = classify_x_url(candidate)
                if classified is None:
                    return None
                identities.append(classified.canonical_url)
        return _one_identity(identities)

    if identity.source_type in {"youtube_video", "video_transcript"}:
        if identity.provider != "youtube":
            return None
        identities: list[str] = []
        provider_target_ref = (identity.provider_target_ref or "").strip()
        if provider_target_ref:
            classified = classify_youtube_provider_video_id(provider_target_ref)
            if classified is None:
                return None
            identities.append(classified.watch_url)
        for candidate in (identity.canonical_source_url, identity.requested_url):
            if candidate:
                from_url = classify_youtube_url(candidate)
                if from_url is None:
                    return None
                identities.append(from_url.watch_url)
        return _one_identity(identities)

    if identity.source_type == "remote_pdf_url":
        if identity.provider not in {None, "arxiv"}:
            return None
        identities: list[str] = []
        provider_target_ref = (identity.provider_target_ref or "").strip()
        if provider_target_ref:
            arxiv = arxiv_pdf_source_from_url(f"https://arxiv.org/abs/{provider_target_ref}")
            if arxiv is None:
                return None
            identities.append(f"https://arxiv.org/abs/{arxiv.arxiv_id}")
        for candidate in (identity.requested_url, identity.canonical_source_url):
            if candidate:
                arxiv = arxiv_pdf_source_from_url(candidate)
                if arxiv is None:
                    return None
                identities.append(f"https://arxiv.org/abs/{arxiv.arxiv_id}")
        return _one_identity(identities)

    return None


def _one_identity(identities: list[str]) -> str | None:
    if not identities or len(set(identities)) != 1:
        return None
    return identities[0]


def _canonical_public_http_url(raw: str | None) -> str | None:
    if raw is None:
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
        or any(char.isspace() or unicodedata.category(char).startswith("C") for char in raw)
        or "\\" in raw
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
        # Source URLs never expose IP literals, including globally routable
        # literals. A hostname keeps the public-source policy auditable.
        ipaddress.ip_address(host)
    except ValueError:
        pass
    else:
        return None
    if (
        port is not None
        and not (scheme == "http" and port == 80)
        and not (scheme == "https" and port == 443)
    ):
        netloc = f"{host}:{port}"
    else:
        netloc = host
    path = parsed.path or "/"
    if re.search(r"%(?![0-9A-Fa-f]{2})", path):
        return None
    canonical_path = quote(path, safe="/:@!$&'()*+,;=-._~%")
    normalized = urlunparse((scheme, netloc, canonical_path, "", "", ""))
    if len(normalized.encode("utf-8")) > _MAX_PUBLIC_URL_BYTES:
        return None
    return normalized
