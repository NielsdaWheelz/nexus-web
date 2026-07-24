from __future__ import annotations

from contextlib import nullcontext
from datetime import UTC, datetime
from uuid import uuid4

from nexus.services.transcript_segments import TranscriptSegmentInput
from nexus.services.transcripts import current


class _ScalarResult:
    def __init__(self, value):
        self._value = value

    def scalar(self):
        return self._value


class _RecordingDb:
    def __init__(self, media_id):
        self.media_id = media_id
        self.statements: list[str] = []

    def execute(self, statement, _params):
        self.statements.append(" ".join(str(statement).split()))
        return _ScalarResult(self.media_id)

    def begin_nested(self):
        return nullcontext()


def test_current_transcript_locks_publication_boundary_before_advisory_lock(
    monkeypatch,
) -> None:
    media_id = uuid4()
    db = _RecordingDb(media_id)
    monkeypatch.setattr(current, "insert_transcript_fragments", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(current, "deactivate_content_index", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(
        current,
        "rebuild_transcript_content_index",
        lambda *_args, **_kwargs: None,
    )
    monkeypatch.setattr(current, "mark_ready_for_reading_by_id", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(current, "set_media_transcript_state", lambda *_args, **_kwargs: None)

    current.write_current_transcript(
        db,
        media_id=media_id,
        request_reason="rss_feed",
        transcript_coverage="full",
        transcript_segments=[
            TranscriptSegmentInput(
                segment_idx=0,
                t_start_ms=0,
                t_end_ms=1_000,
                canonical_text="Current source",
                speaker_label=None,
            )
        ],
        now=datetime.now(UTC),
    )

    assert db.statements[0] == "SELECT id FROM media WHERE id = :media_id FOR UPDATE"
    assert db.statements[1] == ("SELECT pg_advisory_xact_lock(hashtext(:lock_key))")
    assert db.statements[2].startswith("DELETE FROM podcast_transcript_segments")
    assert db.statements[3] == "DELETE FROM fragments WHERE media_id = :media_id"
