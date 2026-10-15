"""Which source URL an anonymous share may disclose.

A generic web URL (validated and normalized at ingest) loses its params, query and fragment.
An X post, a YouTube video or an arXiv PDF discloses its canonical URL only when every
identity its attempt carries (provider target ref, canonical and requested URL) agrees on
it. Nothing else is disclosed.
"""

from __future__ import annotations

import re
from urllib.parse import urlparse, urlunparse

from sqlalchemy import RowMapping

from nexus.services.remote_file import arxiv_pdf_id
from nexus.services.x_identity import canonical_x_post_url, classify_x_url
from nexus.services.youtube_identity import classify_youtube_provider_video_id, classify_youtube_url


def public_source_url(attempt: RowMapping) -> str | None:
    """The disclosable URL of the latest succeeded source attempt, if any."""
    source_type, provider = attempt["source_type"], attempt["provider"]
    ref = (attempt["provider_target_ref"] or "").strip()
    urls = [url for url in (attempt["canonical_source_url"], attempt["requested_url"]) if url]
    if source_type == "generic_web_url" and attempt["canonical_source_url"]:
        parsed = urlparse(attempt["canonical_source_url"])
        return urlunparse(parsed._replace(params="", query="", fragment=""))
    if source_type in {"x_author_thread", "x_post"} and provider == "x":
        from_ref = [canonical_x_post_url(ref) if re.fullmatch(r"[0-9]+", ref) else None]
        x = [identity.canonical_url if (identity := classify_x_url(url)) else None for url in urls]
        return _agreed((from_ref if ref else []) + x)
    if source_type == "youtube_video" and provider == "youtube":
        video = classify_youtube_provider_video_id(ref) if ref else None
        from_ref = [video.watch_url if video else None] if ref else []
        watch = [
            identity.watch_url if (identity := classify_youtube_url(u)) else None for u in urls
        ]
        return _agreed(from_ref + watch)
    if source_type == "remote_pdf_url":  # url acquisition writes no provider or ref here
        ids = [arxiv_pdf_id(url) for url in urls]
        agreed = _agreed(ids)
        return None if agreed is None else f"https://arxiv.org/abs/{agreed}"
    return None


def _agreed(identities: list[str | None]) -> str | None:
    if not identities or None in identities or len(set(identities)) != 1:
        return None
    return identities[0]
