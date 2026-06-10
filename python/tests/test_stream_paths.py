"""Unit tests for the `/stream/` SSE-path predicate (pure, no DB)."""

from __future__ import annotations

import pytest

from nexus.stream_paths import is_stream_path

_ID = "00000000-0000-0000-0000-000000000000"


@pytest.mark.parametrize(
    "path",
    [
        f"/stream/chat-runs/{_ID}/events",
        f"/stream/oracle-readings/{_ID}/events",
        f"/stream/library-intelligence/{_ID}/events",
        f"/stream/media/{_ID}/events",
        # R5: any unrouted /stream/* is treated as a stream path, so auth lets it
        # through to the router (which 404s it) — no Supabase auth, no data leak.
        "/stream/foo",
        "/stream/",
    ],
)
def test_stream_paths_are_recognized(path: str) -> None:
    assert is_stream_path(path) is True


@pytest.mark.parametrize(
    "path",
    [
        "/chat-runs",  # legacy un-prefixed chat-run stream is no longer a stream path
        f"/media/{_ID}",  # the media resource (and its old un-prefixed event stream)
        "/health",
        "/streamed",  # prefix must be the full "/stream/" segment, not a substring
    ],
)
def test_non_stream_paths_are_rejected(path: str) -> None:
    assert is_stream_path(path) is False
