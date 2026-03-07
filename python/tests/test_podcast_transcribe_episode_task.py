from uuid import uuid4

from nexus.tasks.podcast_transcribe_episode import podcast_transcribe_episode_job


def test_podcast_transcribe_episode_task_rejects_invalid_media_id(monkeypatch):
    called = {"value": False}

    def fail_if_called(*args, **kwargs):  # noqa: ANN002, ANN003
        _ = args, kwargs
        called["value"] = True
        raise AssertionError("service should not run for invalid media id")

    monkeypatch.setattr(
        "nexus.tasks.podcast_transcribe_episode.podcast_service.run_podcast_transcription_now",
        fail_if_called,
    )

    result = podcast_transcribe_episode_job.run(media_id="not-a-uuid")

    assert result == {"status": "failed", "error_code": "E_INVALID_REQUEST"}
    assert called["value"] is False


def test_podcast_transcribe_episode_task_ignores_invalid_requested_by_user_id(monkeypatch):
    captured = {"requested_by_user_id": "sentinel"}

    class _FakeDb:
        def close(self) -> None:
            return None

    def fake_session_factory():
        return lambda: _FakeDb()

    def fake_run(db, *, media_id, requested_by_user_id, request_id):  # noqa: ANN001
        _ = db, media_id, request_id
        captured["requested_by_user_id"] = requested_by_user_id
        return {"status": "completed", "segment_count": 1}

    monkeypatch.setattr(
        "nexus.tasks.podcast_transcribe_episode.get_session_factory",
        fake_session_factory,
    )
    monkeypatch.setattr(
        "nexus.tasks.podcast_transcribe_episode.podcast_service.run_podcast_transcription_now",
        fake_run,
    )

    result = podcast_transcribe_episode_job.run(
        media_id=str(uuid4()),
        requested_by_user_id="invalid-user-id",
    )

    assert result["status"] == "completed"
    assert captured["requested_by_user_id"] is None
