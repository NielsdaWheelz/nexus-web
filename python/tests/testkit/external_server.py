"""Deterministic loopback podcast/media protocol for local real-stack proof."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import threading
import wave
from collections.abc import Iterator
from contextlib import contextmanager
from copy import deepcopy
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from io import BytesIO
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlsplit

PODCAST_API_KEY = "nexus-test-fixture-podcast-key"
PODCAST_API_SECRET = "nexus-test-fixture-podcast-secret"

PODCAST_REF = "nasa-hwhap-real-media"
EPISODE_REF = "nasa-hwhap-crew4"
NASA_HOST = "www.nasa.gov"
NASA_FEED_PATH = "/podcasts/houston-we-have-a-podcast/feed"
NASA_FEED_URL = f"http://{NASA_HOST}{NASA_FEED_PATH}"
NASA_TRANSCRIPT_PATH = "/nexus-fixtures/nasa-hwhap-crew4-transcript.txt"
NASA_TRANSCRIPT_URL = f"http://{NASA_HOST}{NASA_TRANSCRIPT_PATH}"
NASA_AUDIO_PATH = "/nexus-fixtures/nasa-hwhap-crew4.wav"
_NASA_AUDIO_URL = "https://www.nasa.gov/wp-content/uploads/2023/07/ep239_crew-4.mp3"

_HEX_SHA1 = re.compile(r"[0-9a-f]{40}")


@dataclass(frozen=True, slots=True)
class FixtureCorpus:
    search: dict[str, Any]
    podcast: dict[str, Any]
    episodes: dict[str, Any]
    feed: bytes
    transcript: bytes
    audio: bytes

    @classmethod
    def load(cls, fixture_root: Path) -> FixtureCorpus:
        root = fixture_root.resolve(strict=True)
        if not root.is_dir():
            raise ValueError("fixture root must be a directory")
        search = _read_payload(root / "nasa-hwhap-podcast-index-search.json")
        podcast = _read_payload(root / "nasa-hwhap-podcast-index-byfeedurl.json")
        episodes = _read_payload(root / "nasa-hwhap-podcast-index-episodes.json")
        feed = (root / "nasa-hwhap-feed-v1.xml").read_bytes()
        transcript = (root / "nasa-hwhap-crew4-transcript.txt").read_bytes()
        _validate_corpus(search, podcast, episodes, feed, transcript)
        return cls(
            search=_with_proxy_feed_url(search),
            podcast=_with_proxy_feed_url(podcast),
            episodes=episodes,
            feed=_with_transcript_reference(feed),
            transcript=transcript,
            audio=_silent_wav(duration_seconds=24),
        )


class ExternalProtocolServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, port: int, corpus: FixtureCorpus):
        self.corpus = corpus
        super().__init__(("127.0.0.1", port), ExternalProtocolHandler)


class ExternalProtocolHandler(BaseHTTPRequestHandler):
    server: ExternalProtocolServer
    protocol_version = "HTTP/1.1"

    def do_GET(self) -> None:  # noqa: N802 - stdlib handler API
        try:
            target = self._target()
            if target.host == NASA_HOST:
                self._serve_nasa(target)
                return
            if target.host != "127.0.0.1":
                raise RequestRejected(400, "host_not_owned")
            if target.path == "/livez" and not target.query:
                self._send_json(200, {"status": "alive"})
                return
            if target.path == NASA_AUDIO_PATH:
                self._serve_audio(target, head_only=False)
                return
            self._require_podcast_auth()
            self._serve_podcast_index(target)
        except RequestRejected as error:
            self._send_error(error)

    def do_HEAD(self) -> None:  # noqa: N802 - stdlib handler API
        try:
            target = self._target()
            if target.host != "127.0.0.1" or target.path != NASA_AUDIO_PATH:
                raise RequestRejected(404, "unknown_path")
            self._serve_audio(target, head_only=True)
        except RequestRejected as error:
            self._send_error(error, head_only=True)

    def do_POST(self) -> None:  # noqa: N802 - stdlib handler API
        self._send_error(RequestRejected(404, "unknown_path"))

    def do_CONNECT(self) -> None:  # noqa: N802 - stdlib handler API
        self._send_error(RequestRejected(405, "connect_tunneling_forbidden"))

    def log_message(self, format: str, *args: object) -> None:
        _ = format, args

    def _target(self) -> RequestTarget:
        parsed = urlsplit(self.path)
        if parsed.scheme:
            if parsed.scheme != "http" or parsed.username or parsed.password or not parsed.hostname:
                raise RequestRejected(400, "invalid_absolute_target")
            return RequestTarget(parsed.hostname.lower(), parsed.path or "/", parsed.query)
        host = self.headers.get("host", "").partition(":")[0].lower()
        return RequestTarget(host, parsed.path or "/", parsed.query)

    def _require_podcast_auth(self) -> None:
        auth_date = self.headers.get("x-auth-date", "")
        auth_key = self.headers.get("x-auth-key", "")
        authorization = self.headers.get("authorization", "")
        expected = hashlib.sha1(
            f"{PODCAST_API_KEY}{PODCAST_API_SECRET}{auth_date}".encode()
        ).hexdigest()
        if (
            not auth_date.isdecimal()
            or auth_key != PODCAST_API_KEY
            or not _HEX_SHA1.fullmatch(authorization)
            or authorization != expected
            or self.headers.get("user-agent") != "nexus-podcast-client/1.0"
        ):
            raise RequestRejected(401, "invalid_podcast_auth")

    def _serve_podcast_index(self, target: RequestTarget) -> None:
        queries = _query(target.query)
        corpus = self.server.corpus
        if target.path == "/search/byterm":
            _require_keys(queries, {"q", "max"})
            if "houston we have a podcast" not in _one(queries, "q").casefold():
                raise RequestRejected(422, "unknown_podcast_query")
            _bounded_int(_one(queries, "max"), minimum=1, maximum=100)
            self._send_json(200, corpus.search)
            return
        if target.path in {"/podcasts/byfeedid", "/podcasts/byfeedurl"}:
            expected_key = "id" if target.path.endswith("byfeedid") else "url"
            _require_keys(queries, {expected_key})
            value = _one(queries, expected_key).rstrip("/")
            expected = PODCAST_REF if expected_key == "id" else NASA_FEED_URL
            if value != expected:
                raise RequestRejected(404, "podcast_not_found")
            self._send_json(200, corpus.podcast)
            return
        if target.path == "/episodes/byfeedid":
            _require_keys(queries, {"id", "max"}, optional={"before"})
            if _one(queries, "id") != PODCAST_REF:
                raise RequestRejected(404, "podcast_not_found")
            limit = _bounded_int(_one(queries, "max"), minimum=1, maximum=100)
            before = (
                _bounded_int(_one(queries, "before"), minimum=1, maximum=4_102_444_800)
                if "before" in queries
                else None
            )
            items = [
                self._with_local_audio(item)
                for item in corpus.episodes["items"]
                if before is None or int(item["datePublished"]) < before
            ][:limit]
            self._send_json(200, {"items": items})
            return
        if target.path == "/episodes/byid":
            _require_keys(queries, {"id"})
            if _one(queries, "id") != EPISODE_REF:
                raise RequestRejected(404, "episode_not_found")
            self._send_json(200, {"episode": self._with_local_audio(corpus.episodes["items"][0])})
            return
        raise RequestRejected(404, "unknown_path")

    def _serve_nasa(self, target: RequestTarget) -> None:
        if target.query:
            raise RequestRejected(400, "nasa_fixture_query_forbidden")
        if self.headers.get("user-agent") != "nexus-podcast-client/1.0":
            raise RequestRejected(400, "invalid_nasa_fixture_user_agent")
        path = target.path.rstrip("/") or "/"
        if path == NASA_FEED_PATH:
            self._send_bytes(
                200,
                _with_local_audio_reference(
                    self.server.corpus.feed,
                    audio_url=self._audio_url(),
                    size_bytes=len(self.server.corpus.audio),
                ),
                "application/rss+xml",
            )
            return
        if path == NASA_TRANSCRIPT_PATH:
            self._send_bytes(200, self.server.corpus.transcript, "text/plain; charset=utf-8")
            return
        raise RequestRejected(404, "unknown_nasa_fixture")

    def _with_local_audio(self, item: dict[str, Any]) -> dict[str, Any]:
        result = deepcopy(item)
        result["enclosureUrl"] = self._audio_url()
        return result

    def _audio_url(self) -> str:
        host = str(self.server.server_address[0])
        port = int(self.server.server_address[1])
        if host != "127.0.0.1":
            raise RequestRejected(500, "fixture_server_not_loopback")
        return f"http://{host}:{port}{NASA_AUDIO_PATH}"

    def _serve_audio(self, target: RequestTarget, *, head_only: bool) -> None:
        if target.query:
            raise RequestRejected(400, "audio_fixture_query_forbidden")
        audio = self.server.corpus.audio
        headers = {"accept-ranges": "bytes", "cache-control": "private, no-store"}
        raw_range = self.headers.get("range")
        if raw_range is None:
            self._send_bytes(200, audio, "audio/wav", headers=headers, head_only=head_only)
            return
        start, end = _single_byte_range(raw_range, size_bytes=len(audio))
        headers["content-range"] = f"bytes {start}-{end}/{len(audio)}"
        self._send_bytes(
            206,
            audio[start : end + 1],
            "audio/wav",
            headers=headers,
            head_only=head_only,
        )

    def _send_json(self, status: int, payload: object, *, head_only: bool = False) -> None:
        self._send_bytes(
            status,
            json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode(),
            "application/json",
            head_only=head_only,
        )

    def _send_error(self, error: RequestRejected, *, head_only: bool = False) -> None:
        self._send_json(error.status, {"error": {"code": error.code}}, head_only=head_only)

    def _send_bytes(
        self,
        status: int,
        body: bytes,
        content_type: str,
        *,
        headers: dict[str, str] | None = None,
        head_only: bool = False,
    ) -> None:
        self.send_response(status)
        self.send_header("content-type", content_type)
        self.send_header("content-length", str(len(body)))
        self.send_header("connection", "close")
        for name, value in (headers or {}).items():
            self.send_header(name, value)
        self.end_headers()
        if not head_only:
            self.wfile.write(body)


@dataclass(frozen=True, slots=True)
class RequestTarget:
    host: str
    path: str
    query: str


class RequestRejected(Exception):
    def __init__(self, status: int, code: str):
        self.status = status
        self.code = code
        super().__init__(code)


def create_server(*, port: int, fixture_root: Path) -> ExternalProtocolServer:
    if not 0 <= port <= 65_535:
        raise ValueError("port must be between 0 and 65535")
    return ExternalProtocolServer(port, FixtureCorpus.load(fixture_root))


@contextmanager
def running_external_protocol_server(*, fixture_root: Path) -> Iterator[tuple[str, int]]:
    """Run the owned loopback protocol and close its thread deterministically."""
    server = create_server(port=0, fixture_root=fixture_root)
    thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.01})
    thread.start()
    try:
        host, port = server.server_address
        yield str(host), int(port)
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)
        assert not thread.is_alive(), "external protocol server did not stop"


def _read_payload(path: Path) -> dict[str, Any]:
    raw = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(raw, dict) or not isinstance(raw.get("payload"), dict):
        raise ValueError(f"fixture has no object payload: {path.name}")
    return raw["payload"]


def _validate_corpus(
    search: dict[str, Any],
    podcast: dict[str, Any],
    episodes: dict[str, Any],
    feed: bytes,
    transcript: bytes,
) -> None:
    feeds = search.get("feeds")
    feed_row = podcast.get("feed")
    items = episodes.get("items")
    if (
        not isinstance(feeds, list)
        or len(feeds) != 1
        or feeds[0] != feed_row
        or not isinstance(feed_row, dict)
        or feed_row.get("id") != PODCAST_REF
        or not isinstance(items, list)
        or len(items) != 1
        or not isinstance(items[0], dict)
        or items[0].get("id") != EPISODE_REF
        or "transcript_segments" in items[0]
        or b"<guid>nasa-hwhap-crew4</guid>" not in feed
        or not transcript.strip()
    ):
        raise ValueError("NASA podcast fixtures do not satisfy the protocol corpus contract")


def _with_proxy_feed_url(payload: dict[str, Any]) -> dict[str, Any]:
    result = deepcopy(payload)
    rows = result.get("feeds") if "feeds" in result else [result.get("feed")]
    if not isinstance(rows, list) or any(not isinstance(row, dict) for row in rows):
        raise ValueError("Podcast Index fixture has no feed rows")
    for row in rows:
        row["url"] = NASA_FEED_URL
    return result


def _with_transcript_reference(feed: bytes) -> bytes:
    text = feed.decode("utf-8")
    namespace = 'xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"'
    enclosure = f'      <enclosure url="{_NASA_AUDIO_URL}" type="audio/mpeg" length="0" />'
    if text.count(namespace) != 1 or text.count(enclosure) != 1 or "podcast:transcript" in text:
        raise ValueError("canonical RSS fixture cannot receive its transcript reference exactly")
    text = text.replace(
        namespace,
        f'{namespace}\n  xmlns:podcast="https://podcastindex.org/namespace/1.0"',
    )
    return text.replace(
        enclosure,
        f'{enclosure}\n      <podcast:transcript url="{NASA_TRANSCRIPT_URL}" '
        'type="text/plain" language="en" />',
    ).encode()


def _with_local_audio_reference(feed: bytes, *, audio_url: str, size_bytes: int) -> bytes:
    text = feed.decode("utf-8")
    enclosure = f'      <enclosure url="{_NASA_AUDIO_URL}" type="audio/mpeg" length="0" />'
    replacement = f'      <enclosure url="{audio_url}" type="audio/wav" length="{size_bytes}" />'
    if text.count(enclosure) != 1 or text.count(audio_url) != 0:
        raise RequestRejected(500, "canonical_audio_reference_not_unique")
    return text.replace(enclosure, replacement).encode()


def _silent_wav(*, duration_seconds: int) -> bytes:
    if duration_seconds <= 0:
        raise ValueError("audio fixture duration must be positive")
    output = BytesIO()
    sample_rate = 8_000
    with wave.open(output, "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(1)
        audio.setframerate(sample_rate)
        audio.writeframes(bytes([128]) * sample_rate * duration_seconds)
    return output.getvalue()


def _single_byte_range(raw: str, *, size_bytes: int) -> tuple[int, int]:
    match = re.fullmatch(r"bytes=(\d*)-(\d*)", raw.strip())
    if match is None or (not match.group(1) and not match.group(2)):
        raise RequestRejected(416, "invalid_audio_range")
    start_raw, end_raw = match.groups()
    if not start_raw:
        suffix_length = int(end_raw)
        if suffix_length <= 0:
            raise RequestRejected(416, "invalid_audio_range")
        return max(0, size_bytes - suffix_length), size_bytes - 1
    start = int(start_raw)
    end = int(end_raw) if end_raw else size_bytes - 1
    if start >= size_bytes or end < start:
        raise RequestRejected(416, "invalid_audio_range")
    return start, min(end, size_bytes - 1)


def _query(raw: str) -> dict[str, list[str]]:
    try:
        return parse_qs(raw, keep_blank_values=True, strict_parsing=True)
    except ValueError as error:
        raise RequestRejected(400, "invalid_query") from error


def _require_keys(
    query: dict[str, list[str]], required: set[str], *, optional: set[str] = frozenset()
) -> None:
    if not required.issubset(query) or not set(query).issubset(required | optional):
        raise RequestRejected(400, "invalid_query_keys")


def _one(query: dict[str, list[str]], key: str) -> str:
    values = query.get(key)
    if values is None or len(values) != 1 or not values[0]:
        raise RequestRejected(400, "invalid_query_value")
    return values[0]


def _bounded_int(raw: str, *, minimum: int, maximum: int) -> int:
    if not raw.isdecimal() or not minimum <= (value := int(raw)) <= maximum:
        raise RequestRejected(400, "invalid_integer_query")
    return value


def _parse_args(argv: list[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--fixture-root", type=Path, required=True)
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(argv)
    server = create_server(port=args.port, fixture_root=args.fixture_root)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
