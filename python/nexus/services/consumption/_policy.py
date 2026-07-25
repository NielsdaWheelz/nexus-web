"""Consumption activity policy that must not drift across writers."""

from __future__ import annotations

from nexus.db.models import MediaKind
from nexus.schemas.consumption_activity import ActivityModality

FINISHED_PROGRESSION = 0.95


def completion_modality_for_kind(kind: str) -> ActivityModality:
    if kind in {MediaKind.web_article.value, MediaKind.epub.value, MediaKind.pdf.value}:
        return "Reading"
    if kind == MediaKind.podcast_episode.value:
        return "Listening"
    if kind == MediaKind.video.value:
        return "Viewing"
    raise AssertionError(f"unsupported completion media kind: {kind!r}")
