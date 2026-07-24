"""Strict Node subprocess boundary for web article ingestion."""

import json
import os
import signal
import subprocess
from dataclasses import dataclass
from pathlib import Path

from nexus.errors import ApiErrorCode

# In production, set NODE_INGEST_SCRIPT env var to the absolute path.
# Dev fallback: walk up from python/nexus/services/ to repo root.
_DEV_FALLBACK = Path(__file__).parent.parent.parent.parent / "node" / "ingest" / "ingest.mjs"
NODE_INGEST_SCRIPT = Path(os.environ.get("NODE_INGEST_SCRIPT", _DEV_FALLBACK))

DEFAULT_NODE_TIMEOUT_MS = 30000  # 30s for HTTP fetch
SUBPROCESS_TIMEOUT_S = 40  # 40s hard wall-clock limit for subprocess
_PROTOCOL_VERSION = 1
_SUCCESS_KEYS = frozenset(
    {
        "version",
        "tag",
        "final_url",
        "base_url",
        "title",
        "content_html",
        "source_html",
        "byline",
        "excerpt",
        "site_name",
        "published_time",
    }
)
_FAILURE_KEYS = frozenset({"version", "tag", "failure", "message"})


@dataclass(frozen=True, slots=True)
class IngestResult:
    """Result of successful web article ingestion."""

    final_url: str
    base_url: str
    title: str
    content_html: str
    source_html: str
    byline: str = ""
    excerpt: str = ""
    site_name: str = ""
    published_time: str = ""
    provider_fixture: dict[str, object] | None = None


@dataclass(frozen=True, slots=True)
class IngestError:
    """Error from web article ingestion."""

    error_code: ApiErrorCode
    message: str


# justify-defect: every use represents an owned script or wire-contract violation.
class NodeIngestProtocolDefect(RuntimeError):
    """The owned Node process violated its closed result contract."""


def run_node_ingest(
    url: str,
    timeout_ms: int = DEFAULT_NODE_TIMEOUT_MS,
    subprocess_timeout_s: int = SUBPROCESS_TIMEOUT_S,
) -> IngestResult | IngestError:
    """Return a modeled source result; raise when the owned protocol is broken."""
    from nexus.config import get_settings, real_media_provider_fixtures_requested

    if real_media_provider_fixtures_requested():
        settings = get_settings()
        if settings.real_media_provider_fixtures:
            return _run_real_media_fixture_ingest(url, settings.real_media_fixture_dir)

    if not NODE_INGEST_SCRIPT.exists():
        # justify-defect: the deployed owned script is required infrastructure.
        raise NodeIngestProtocolDefect(f"Node ingest script not found at {NODE_INGEST_SCRIPT}")

    input_json = json.dumps({"url": url, "timeout_ms": timeout_ms}).encode("utf-8")

    try:
        proc = subprocess.Popen(
            ["node", str(NODE_INGEST_SCRIPT)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            start_new_session=True,
        )

        try:
            stdout, stderr = proc.communicate(input=input_json, timeout=subprocess_timeout_s)
        except subprocess.TimeoutExpired:
            try:
                if hasattr(os, "killpg"):
                    os.killpg(proc.pid, signal.SIGKILL)
                else:
                    proc.kill()
            except (ProcessLookupError, OSError):
                # justify-ignore-error: the process already exited before the timeout cleanup.
                pass
            proc.wait()
            return IngestError(
                error_code=ApiErrorCode.E_INGEST_TIMEOUT,
                message=f"Subprocess timeout after {subprocess_timeout_s}s",
            )

        if proc.returncode != 0:
            # justify-defect: modeled failures are protocol values with exit zero.
            raise NodeIngestProtocolDefect(
                f"Node ingest exited with code {proc.returncode}: "
                f"{_decode_output_excerpt(stderr or stdout)}"
            )
        return _decode_result(stdout)

    except FileNotFoundError as exc:
        # justify-defect: Node is required infrastructure for this owned adapter.
        raise NodeIngestProtocolDefect("Node.js executable is unavailable") from exc
    except OSError as e:
        # justify-defect: process-launch failures are not modeled source outcomes.
        raise NodeIngestProtocolDefect(f"Node ingest subprocess failed: {e}") from e


def _decode_result(output: bytes) -> IngestResult | IngestError:
    try:
        value = json.loads(output.decode("utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        # justify-defect: this process is owned and must emit the closed JSON union.
        raise NodeIngestProtocolDefect("Node ingest returned malformed JSON") from exc
    if not isinstance(value, dict):
        raise NodeIngestProtocolDefect("Node ingest result must be an object")
    if type(value.get("version")) is not int or value["version"] != _PROTOCOL_VERSION:
        raise NodeIngestProtocolDefect("Node ingest returned an unsupported protocol version")

    tag = value.get("tag")
    if tag == "Success":
        if value.keys() != _SUCCESS_KEYS or not all(
            isinstance(value[key], str) for key in _SUCCESS_KEYS - {"version", "tag"}
        ):
            raise NodeIngestProtocolDefect("Node ingest returned an invalid Success payload")
        return IngestResult(
            final_url=value["final_url"],
            base_url=value["base_url"],
            title=value["title"],
            content_html=value["content_html"],
            source_html=value["source_html"],
            byline=value["byline"],
            excerpt=value["excerpt"],
            site_name=value["site_name"],
            published_time=value["published_time"],
        )
    if tag == "Failure":
        return _decode_failure(value)
    raise NodeIngestProtocolDefect(f"Node ingest returned unknown result tag: {tag!r}")


def _decode_failure(value: dict[str, object]) -> IngestError:
    if value.keys() != _FAILURE_KEYS or not isinstance(value["message"], str):
        raise NodeIngestProtocolDefect("Node ingest returned an invalid Failure payload")
    failure = value["failure"]
    if not isinstance(failure, dict):
        raise NodeIngestProtocolDefect("Node ingest failure must be an object")
    tag = failure.get("tag")
    if tag == "Http":
        if failure.keys() != {"tag", "status"}:
            raise NodeIngestProtocolDefect("Node ingest returned an invalid Http failure")
        status = failure["status"]
        if type(status) is not int or not 100 <= status <= 599 or 200 <= status <= 299:
            raise NodeIngestProtocolDefect(
                f"Node ingest returned impossible HTTP status: {status!r}"
            )
        error_code = (
            ApiErrorCode.E_SOURCE_ACCESS_DENIED
            if status in {401, 403}
            else ApiErrorCode.E_SOURCE_FETCH_FAILED
        )
    elif tag == "Timeout" and failure.keys() == {"tag"}:
        error_code = ApiErrorCode.E_INGEST_TIMEOUT
    elif tag == "Network" and failure.keys() == {"tag"}:
        error_code = ApiErrorCode.E_SOURCE_FETCH_FAILED
    elif tag == "TooLarge" and failure.keys() == {"tag"}:
        error_code = ApiErrorCode.E_SOURCE_TOO_LARGE
    elif tag == "Readability" and failure.keys() == {"tag"}:
        error_code = ApiErrorCode.E_SOURCE_NOT_READABLE
    else:
        raise NodeIngestProtocolDefect(f"Node ingest returned unknown failure variant: {tag!r}")
    return IngestError(error_code=error_code, message=value["message"])


def _decode_output_excerpt(output: bytes) -> str:
    decoded = output.decode("utf-8", errors="replace")
    return decoded[:500] if len(decoded) > 500 else decoded


def _run_real_media_fixture_ingest(url: str, fixture_dir: str | None) -> IngestResult:
    requested_url = url.strip()
    if requested_url != "https://science.nasa.gov/solar-system/moon/theres-water-on-the-moon/":
        # justify-defect: a requested owned fixture must exist in the fixture catalog.
        raise NodeIngestProtocolDefect(f"No real-media web article fixture for {requested_url}")
    if fixture_dir is None:
        # justify-defect: fixture mode requires its declared fixture directory.
        raise NodeIngestProtocolDefect(
            "REAL_MEDIA_FIXTURE_DIR is required for web article fixtures"
        )

    path = Path(fixture_dir) / "nasa-water-on-moon-capture.html"
    try:
        content_html = path.read_text(encoding="utf-8")
    except OSError as exc:
        raise NodeIngestProtocolDefect(f"Web article fixture unavailable: {exc}") from exc

    payload = content_html.encode("utf-8")
    if len(payload) != 1_019:
        raise NodeIngestProtocolDefect("Web article fixture size mismatch")

    return IngestResult(
        final_url=requested_url,
        base_url="https://science.nasa.gov/",
        title="There's Water on the Moon?",
        content_html=content_html,
        source_html=content_html,
        byline="Molly Wasser",
        excerpt="NASA Science captured article fixture.",
        site_name="NASA Science",
        published_time="2020-11-05T00:00:00Z",
        provider_fixture={
            "path": str(path),
            "byte_length": len(payload),
            "source_url": requested_url,
        },
    )
