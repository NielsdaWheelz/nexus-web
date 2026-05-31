from uuid import uuid4

import pytest

from nexus.tasks.podcast_transcribe_episode import podcast_transcribe_episode_job

pytestmark = pytest.mark.unit


def test_podcast_transcribe_episode_task_rejects_invalid_media_id(monkeypatch):
    called = {"value": False}

    def fail_if_called(*args: object, **kwargs: object) -> None:
        _ = args, kwargs
        called["value"] = True
        raise AssertionError("service should not run for invalid media id")

    monkeypatch.setattr(
        "nexus.tasks.podcast_transcribe_episode.run_podcast_transcription_now",
        fail_if_called,
    )

    result = podcast_transcribe_episode_job(media_id="not-a-uuid")

    assert result == {"status": "failed", "error_code": "E_INVALID_REQUEST"}
    assert called["value"] is False


def test_podcast_transcribe_episode_task_rejects_invalid_requested_by_user_id(
    monkeypatch,
):
    called = {"session": False, "service": False}

    def fail_session_factory() -> None:
        called["session"] = True
        raise AssertionError("session should not open for invalid requester id")

    def fail_if_called(*args: object, **kwargs: object) -> None:
        _ = args, kwargs
        called["service"] = True
        raise AssertionError("service should not run for invalid requester id")

    monkeypatch.setattr(
        "nexus.tasks.podcast_transcribe_episode.get_session_factory",
        fail_session_factory,
    )
    monkeypatch.setattr(
        "nexus.tasks.podcast_transcribe_episode.run_podcast_transcription_now",
        fail_if_called,
    )

    result = podcast_transcribe_episode_job(
        media_id=str(uuid4()),
        requested_by_user_id="invalid-user-id",
    )

    assert result == {"status": "failed", "error_code": "E_INVALID_REQUEST"}
    assert called == {"session": False, "service": False}
