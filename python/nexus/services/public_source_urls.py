"""Which source URL an anonymous share may disclose.

Only a few source types may show their origin, and a provider-identified source
only when every identity its attempt carries (provider target ref, canonical
and requested URL) canonicalizes to the same public URL.
"""

from __future__ import annotations

import re
from urllib.parse import urlparse, urlunparse

from sqlalchemy import RowMapping

from nexus.services.remote_file import arxiv_pdf_id
from nexus.services.x_identity import canonical_x_post_url, classify_x_url
from nexus.services.youtube_identity import classify_youtube_provider_video_id, classify_youtube_url


def public_source_url(attempt: RowMapping) -> str | None:
    """The disclosable URL of the latest succeeded source attempt, if any.

    A generic web URL was validated and normalized at ingest; it loses its
    params, query and fragment here.
    """
    source_type, provider = attempt["source_type"], attempt["provider"]
    ref = (attempt["provider_target_ref"] or "").strip()
    urls = [url for url in (attempt["canonical_source_url"], attempt["requested_url"]) if url]
    if source_type == "generic_web_url" and attempt["canonical_source_url"]:
        parsed = urlparse(attempt["canonical_source_url"])
        return urlunparse(parsed._replace(params="", query="", fragment=""))
    if source_type in {"x_author_thread", "x_post"} and provider == "x":
        from_ref = canonical_x_post_url(ref) if re.fullmatch(r"[0-9]+", ref) else None
        return _agreed(
            [from_ref] if ref else [],
            [identity.canonical_url if (identity := classify_x_url(url)) else None for url in urls],
        )
    if source_type in {"youtube_video", "video_transcript"} and provider == "youtube":
        from_ref = classify_youtube_provider_video_id(ref) if ref else None
        return _agreed(
            [from_ref.watch_url if from_ref else None] if ref else [],
            [
                identity.watch_url if (identity := classify_youtube_url(url)) else None
                for url in urls
            ],
        )
    if source_type == "remote_pdf_url" and provider in {None, "arxiv"}:
        return _agreed(
            [_arxiv_abs_url(f"https://arxiv.org/abs/{ref}")] if ref else [],
            [
                _arxiv_abs_url(url)
                for url in (attempt["requested_url"], attempt["canonical_source_url"])
                if url
            ],
        )
    return None


def _agreed(from_ref: list[str | None], from_urls: list[str | None]) -> str | None:
    identities = [*from_ref, *from_urls]
    if not identities or None in identities or len(set(identities)) != 1:
        return None
    return identities[0]


def _arxiv_abs_url(url: str) -> str | None:
    arxiv_id = arxiv_pdf_id(url)
    return None if arxiv_id is None else f"https://arxiv.org/abs/{arxiv_id}"
