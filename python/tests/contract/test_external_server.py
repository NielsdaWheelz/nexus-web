from __future__ import annotations

import hashlib
import http.client
import json
import wave
from io import BytesIO
from pathlib import Path
from urllib.parse import urlencode

from tests.testkit.external_server import (
    NASA_AUDIO_PATH,
    NASA_FEED_URL,
    NASA_TRANSCRIPT_URL,
    PODCAST_API_KEY,
    PODCAST_API_SECRET,
    running_external_protocol_server,
)

_FIXTURES = Path(__file__).parents[1] / "fixtures" / "real_media"


def _request(
    address: tuple[str, int],
    method: str,
    target: str,
    *,
    headers: dict[str, str] | None = None,
    body: bytes | None = None,
) -> tuple[int, dict[str, str], bytes]:
    connection = http.client.HTTPConnection(*address, timeout=2)
    try:
        connection.request(method, target, body=body, headers=headers or {})
        response = connection.getresponse()
        return (
            response.status,
            {name.lower(): value for name, value in response.getheaders()},
            response.read(),
        )
    finally:
        connection.close()


def _podcast_headers() -> dict[str, str]:
    auth_date = "1785456000"
    authorization = hashlib.sha1(
        f"{PODCAST_API_KEY}{PODCAST_API_SECRET}{auth_date}".encode()
    ).hexdigest()
    return {
        "X-Auth-Date": auth_date,
        "X-Auth-Key": PODCAST_API_KEY,
        "Authorization": authorization,
        "User-Agent": "nexus-podcast-client/1.0",
    }


def test_podcast_index_rss_and_transcript_are_one_authentic_local_protocol() -> None:
    with running_external_protocol_server(fixture_root=_FIXTURES) as address:
        assert address[0] == "127.0.0.1"
        status, _, body = _request(
            address,
            "GET",
            f"/search/byterm?{urlencode({'q': 'Houston We Have a Podcast', 'max': 20})}",
            headers=_podcast_headers(),
        )
        search = json.loads(body)
        assert status == 200
        assert search["feeds"] == [
            {
                "id": "nasa-hwhap-real-media",
                "title": "Houston We Have a Podcast",
                "author": "NASA Johnson Space Center",
                "url": NASA_FEED_URL,
                "link": "https://www.nasa.gov/podcasts/houston-we-have-a-podcast/",
                "image": None,
                "description": "NASA Johnson Space Center podcast.",
            }
        ]

        status, _, body = _request(
            address,
            "GET",
            "/podcasts/byfeedid?id=nasa-hwhap-real-media",
            headers=_podcast_headers(),
        )
        assert status == 200
        assert json.loads(body)["feed"] == search["feeds"][0]

        status, _, body = _request(
            address,
            "GET",
            f"/podcasts/byfeedurl?{urlencode({'url': NASA_FEED_URL})}",
            headers=_podcast_headers(),
        )
        assert status == 200
        assert json.loads(body)["feed"]["id"] == "nasa-hwhap-real-media"

        status, _, body = _request(
            address,
            "GET",
            "/episodes/byfeedid?id=nasa-hwhap-real-media&max=100",
            headers=_podcast_headers(),
        )
        episode = json.loads(body)["items"][0]
        assert status == 200
        assert episode["id"] == "nasa-hwhap-crew4"
        assert "transcript_segments" not in episode
        audio_url = f"http://{address[0]}:{address[1]}{NASA_AUDIO_PATH}"
        assert episode["enclosureUrl"] == audio_url

        status, _, body = _request(
            address,
            "GET",
            "/episodes/byid?id=nasa-hwhap-crew4",
            headers=_podcast_headers(),
        )
        assert status == 200
        assert json.loads(body)["episode"] == episode

        status, headers, feed = _request(
            address,
            "GET",
            NASA_FEED_URL,
            headers={"User-Agent": "nexus-podcast-client/1.0"},
        )
        assert status == 200
        assert headers["content-type"] == "application/rss+xml"
        assert b"<guid>nasa-hwhap-crew4</guid>" in feed
        assert f'<podcast:transcript url="{NASA_TRANSCRIPT_URL}"'.encode() in feed
        assert f'<enclosure url="{audio_url}" type="audio/wav"'.encode() in feed

        status, headers, transcript = _request(
            address,
            "GET",
            NASA_TRANSCRIPT_URL,
            headers={"User-Agent": "nexus-podcast-client/1.0"},
        )
        assert status == 200
        assert headers["content-type"] == "text/plain; charset=utf-8"
        assert transcript == (_FIXTURES / "nasa-hwhap-crew4-transcript.txt").read_bytes()

        status, headers, body = _request(address, "HEAD", NASA_AUDIO_PATH)
        assert status == 200
        assert headers["content-type"] == "audio/wav"
        assert headers["accept-ranges"] == "bytes"
        assert body == b""
        audio_size = int(headers["content-length"])

        status, headers, body = _request(
            address,
            "GET",
            NASA_AUDIO_PATH,
            headers={"Range": "bytes=0-4095"},
        )
        assert status == 206
        assert headers["content-range"] == f"bytes 0-4095/{audio_size}"
        assert len(body) == 4096

        status, _, audio = _request(address, "GET", NASA_AUDIO_PATH)
        assert status == 200
        with wave.open(BytesIO(audio), "rb") as wav:
            assert wav.getnchannels() == 1
            assert wav.getframerate() == 8_000
            assert wav.getnframes() / wav.getframerate() == 24
