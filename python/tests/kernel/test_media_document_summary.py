"""Document summaries retain metrics without fetching unused preview bodies."""

from types import SimpleNamespace
from unittest.mock import Mock
from uuid import UUID

import pytest
from sqlalchemy.orm import Session

from nexus.errors import ApiError, ApiErrorCode
from nexus.schemas.presence import absent
from nexus.services import media_read_map
from nexus.services.media_document_metrics import MediaSummaryMetrics


@pytest.mark.parametrize("kind", ["web_article", "epub"])
@pytest.mark.parametrize("navigation_ready", [False, True])
def test_document_summary_counts_navigation_without_loading_fragment_previews(
    monkeypatch: pytest.MonkeyPatch, kind: str, navigation_ready: bool
) -> None:
    media_id = UUID("11111111-1111-4111-8111-111111111111")
    db = Mock(spec=Session)
    db.execute.return_value.fetchone.return_value = (kind, "ready_for_reading", None, None)
    db.execute.return_value.fetchall.side_effect = AssertionError("unused fragment body read")
    monkeypatch.setattr(media_read_map, "can_read_media", lambda *_args: True)
    navigation = Mock(
        return_value=SimpleNamespace(
            sections=[SimpleNamespace(target=SimpleNamespace(fragment_id=media_id), label="one")]
        )
    )
    if not navigation_ready:
        navigation.side_effect = ApiError(ApiErrorCode.E_MEDIA_NOT_READY, "not ready")
    monkeypatch.setattr(media_read_map, "get_media_navigation_for_viewer", navigation)
    monkeypatch.setattr(
        media_read_map,
        "load_media_summary_metrics",
        lambda *_args: MediaSummaryMetrics(word_count=123, source_section_count=absent()),
    )

    assert media_read_map.load_media_document_summary(db, media_id, media_id) == (
        media_read_map.MediaDocumentSummary(
            section_count=1 if navigation_ready else None, word_count=123
        )
    )
