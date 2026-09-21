"""The Node article-extraction subprocess boundary."""

from __future__ import annotations

import json
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from nexus.errors import ApiErrorCode

_PRODUCTION_NODE_EXECUTABLE = "/usr/local/bin/node"
_PRODUCTION_NODE_INGEST_SCRIPT = Path("/app/node/ingest/ingest.mjs")
_LOCAL_NODE_INGEST_SCRIPT = Path(__file__).resolve().parents[3] / "node/ingest/ingest.mjs"

DEFAULT_NODE_TIMEOUT_MS = 30_000
SUBPROCESS_TIMEOUT_S = 40
_PROTOCOL_VERSION = 1
_NODE_ENVIRONMENT = {"LANG": "C.UTF-8", "NODE_ENV": "production"}

_FAILURES: dict[str, tuple[ApiErrorCode, str]] = {
    "UnsafeDestination": (ApiErrorCode.E_SSRF_BLOCKED, "Source cannot be fetched safely."),
    "UnsupportedMediaType": (
        ApiErrorCode.E_INVALID_CONTENT_TYPE,
        "Source is not an HTML document.",
    ),
    "UnsupportedContentEncoding": (
        ApiErrorCode.E_INVALID_CONTENT_TYPE,
        "Source uses an unsupported content encoding.",
    ),
    "Timeout": (ApiErrorCode.E_INGEST_TIMEOUT, "Source fetch timed out."),
    "Network": (ApiErrorCode.E_SOURCE_FETCH_FAILED, "Source fetch failed."),
    "TooManyRedirects": (ApiErrorCode.E_SOURCE_FETCH_FAILED, "Source redirected too many times."),
    "TooLarge": (ApiErrorCode.E_SOURCE_TOO_LARGE, "Source exceeds the import size limit."),
    "Readability": (
        ApiErrorCode.E_SOURCE_NOT_READABLE,
        "Source does not contain a readable article.",
    ),
}


@dataclass(frozen=True, slots=True)
class IngestResult:
    final_url: str
    base_url: str
    title: str
    content_html: str
    source_html: str
    byline: str = ""
    excerpt: str = ""
    site_name: str = ""
    published_time: str = ""


@dataclass(frozen=True, slots=True)
class IngestError:
    error_code: ApiErrorCode
    message: str


@dataclass(frozen=True, slots=True)
class NodeIngestCommand:
    executable: str
    script: Path


class NodeIngestProtocolDefect(RuntimeError):
    """The owned Node process violated its closed result contract."""


def local_node_ingest_command() -> NodeIngestCommand:
    """Resolve the checked-out ingress command for local and test composition."""
    executable = shutil.which("node")
    if executable is None:
        raise NodeIngestProtocolDefect("local Node.js executable is unavailable")
    return NodeIngestCommand(
        executable=Path(executable).resolve(strict=True).as_posix(),
        script=_LOCAL_NODE_INGEST_SCRIPT,
    )


def run_node_ingest(
    url: str,
    timeout_ms: int = DEFAULT_NODE_TIMEOUT_MS,
    *,
    command: NodeIngestCommand | None = None,
) -> IngestResult | IngestError:
    """Run the image-baked production ingress or an explicit local/test seam."""
    resolved = command or NodeIngestCommand(
        executable=_PRODUCTION_NODE_EXECUTABLE, script=_PRODUCTION_NODE_INGEST_SCRIPT
    )
    if not resolved.script.is_file():
        raise NodeIngestProtocolDefect("Node ingest script is unavailable")
    request = json.dumps({"url": url, "timeout_ms": timeout_ms}).encode("utf-8")
    try:
        proc = subprocess.Popen(
            [resolved.executable, str(resolved.script)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=_NODE_ENVIRONMENT,
        )
        try:
            stdout, _stderr = proc.communicate(input=request, timeout=SUBPROCESS_TIMEOUT_S)
        except subprocess.TimeoutExpired:
            # This helper stays in the outer background child's process group:
            # its timeout owns only the direct Node child.
            proc.kill()
            proc.wait()
            return IngestError(ApiErrorCode.E_INGEST_TIMEOUT, "Source fetch timed out.")
        if proc.returncode != 0:
            raise NodeIngestProtocolDefect("Node ingest process exited unexpectedly")
    except OSError as exc:
        raise NodeIngestProtocolDefect("Node ingest process could not start") from exc
    return _decode_result(stdout)


def _decode_result(output: bytes) -> IngestResult | IngestError:
    try:
        value = json.loads(output.decode("utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise NodeIngestProtocolDefect("Node ingest returned malformed JSON") from exc
    if not isinstance(value, dict) or value.get("version") != _PROTOCOL_VERSION:
        raise NodeIngestProtocolDefect("Node ingest returned an unsupported protocol version")
    if value.get("tag") == "Success":
        return IngestResult(
            final_url=_field(value, "final_url"),
            base_url=_field(value, "base_url"),
            title=_field(value, "title"),
            content_html=_field(value, "content_html"),
            source_html=_field(value, "source_html"),
            byline=_field(value, "byline"),
            excerpt=_field(value, "excerpt"),
            site_name=_field(value, "site_name"),
            published_time=_field(value, "published_time"),
        )
    if value.get("tag") == "Failure":
        return _decode_failure(value.get("failure"))
    raise NodeIngestProtocolDefect("Node ingest returned an unsupported result tag")


def _field(value: dict[str, Any], key: str) -> str:
    raw = value.get(key)
    if not isinstance(raw, str):
        raise NodeIngestProtocolDefect("Node ingest returned an invalid Success payload")
    return raw


def _decode_failure(failure: Any) -> IngestError:
    if not isinstance(failure, dict):
        raise NodeIngestProtocolDefect("Node ingest failure must be an object")
    tag = failure.get("tag")
    if tag == "Http":
        status = failure.get("status")
        if not isinstance(status, int) or not 100 <= status <= 599 or 200 <= status <= 299:
            raise NodeIngestProtocolDefect(
                f"Node ingest returned impossible HTTP status: {status!r}"
            )
        if status in {401, 403}:
            return IngestError(ApiErrorCode.E_SOURCE_ACCESS_DENIED, "Source denied access.")
        return IngestError(ApiErrorCode.E_SOURCE_FETCH_FAILED, f"HTTP error: {status}")
    known = _FAILURES.get(str(tag))
    if known is None:
        raise NodeIngestProtocolDefect("Node ingest returned an unsupported failure variant")
    return IngestError(*known)
