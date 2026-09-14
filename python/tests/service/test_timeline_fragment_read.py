"""The legacy fragment read keeps timeline semantics and masks document access."""

from uuid import uuid4

import pytest
from sqlalchemy import Engine
from sqlalchemy.orm import Session

from nexus.db.models import Fragment, Media, MediaTranscriptState
from nexus.errors import ApiError, ApiErrorCode
from nexus.services.bootstrap import ensure_user_and_default_library
from nexus.services.library_entries import ensure_media_in_default_library
from nexus.services.media import list_fragments_for_viewer


def test_authenticated_fragments_only_expose_readable_timelines(engine: Engine) -> None:
    viewer, outsider = uuid4(), uuid4()
    with Session(engine) as db:
        for user in (viewer, outsider):
            ensure_user_and_default_library(db, user, f"timeline-fragments-{user}@example.invalid")
        for kind in ("web_article", "epub", "pdf", "podcast_episode", "video"):
            media_id = uuid4()
            db.add(
                Media(
                    id=media_id,
                    kind=kind,
                    title="Source read boundary",
                    processing_status="ready_for_reading",
                    created_by_user_id=viewer,
                )
            )
            db.flush()
            ensure_media_in_default_library(db, viewer, media_id)
            timeline = kind in {"podcast_episode", "video"}
            if timeline:
                db.add(
                    MediaTranscriptState(
                        media_id=media_id, transcript_state="ready", transcript_coverage="full"
                    )
                )
            if kind != "pdf":
                for index, (text, start, end, speaker) in enumerate(
                    (("late words", 900, 1800, "later"), ("early", 100, 300, "earlier"))
                ):
                    db.add(
                        Fragment(
                            id=uuid4(),
                            media_id=media_id,
                            idx=index,
                            html_sanitized=f"<p>{text}</p>",
                            canonical_text=text,
                            t_start_ms=start if timeline else None,
                            t_end_ms=end if timeline else None,
                            speaker_label=speaker if timeline else None,
                        )
                    )
            db.flush()
            with pytest.raises(ApiError) as masked:
                list_fragments_for_viewer(db, outsider, media_id)
            assert masked.value.code == ApiErrorCode.E_MEDIA_NOT_FOUND
            if not timeline:
                with pytest.raises(ApiError) as unsupported:
                    list_fragments_for_viewer(db, viewer, media_id)
                assert unsupported.value.code == ApiErrorCode.E_INVALID_KIND
                continue
            fragments = list_fragments_for_viewer(db, viewer, media_id)
            assert [
                (
                    row.idx,
                    row.canonical_text,
                    row.html_sanitized,
                    row.t_start_ms,
                    row.t_end_ms,
                    row.speaker_label,
                    row.word_count,
                    row.document_word_start,
                )
                for row in fragments
            ] == [
                (1, "early", "<p>early</p>", 100, 300, "earlier", 1, 2),
                (0, "late words", "<p>late words</p>", 900, 1800, "later", 2, 0),
            ]
        with pytest.raises(ApiError) as absent:
            list_fragments_for_viewer(db, viewer, uuid4())
        assert absent.value.code == ApiErrorCode.E_MEDIA_NOT_FOUND
