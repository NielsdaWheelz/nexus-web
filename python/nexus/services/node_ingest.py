"""Strict Node subprocess boundary for web article ingestion."""

import json
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

from nexus.config import get_settings
from nexus.errors import ApiErrorCode
from nexus.services.url_normalize import MAX_URL_LENGTH

DEFAULT_NODE_TIMEOUT_MS = 30_000
SUBPROCESS_TIMEOUT_S = 40
_PROTOCOL_VERSION = 1
_NODE_ENVIRONMENT = {"LANG": "C.UTF-8", "NODE_ENV": "production"}
_MAX_NODE_INGEST_HTML_BYTES = 10 * 1024 * 1024
_MAX_NODE_INGEST_METADATA_CODE_POINTS = {
    "title": 1_000,
    "byline": 1_000,
    "excerpt": 2_000,
    "site_name": 255,
    "published_time": 64,
}
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
_FAILURE_KEYS = frozenset({"version", "tag", "failure"})


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


@dataclass(frozen=True, slots=True)
class IngestError:
    """Error from web article ingestion."""

    error_code: ApiErrorCode
    message: str


@dataclass(frozen=True, slots=True)
class NodeIngestCommand:
    """One explicitly composed Node ingress command."""

    executable: str
    script: Path


# justify-defect: every use represents an owned script or wire-contract violation.
class NodeIngestProtocolDefect(RuntimeError):
    """The owned Node process violated its closed result contract."""


def run_node_ingest(
    url: str,
    timeout_ms: int = DEFAULT_NODE_TIMEOUT_MS,
    *,
    command: NodeIngestCommand | None = None,
) -> IngestResult | IngestError:
    """Run the explicitly configured ingress through its closed subprocess protocol."""
    if command is None:
        executable = shutil.which("node")
        if executable is None:
            # justify-defect: the worker's composed runtime requires Node.
            raise NodeIngestProtocolDefect("Node.js executable is unavailable")
        command = NodeIngestCommand(
            executable=Path(executable).resolve(strict=True).as_posix(),
            script=get_settings().node_ingest_script,
        )
    script = command.script
    if not script.is_absolute():
        # justify-defect: runtime composition must name one absolute entrypoint.
        raise NodeIngestProtocolDefect("Node ingest script must be an absolute path")
    if not script.is_file():
        # justify-defect: the deployed owned script is required infrastructure.
        raise NodeIngestProtocolDefect("Node ingest script is unavailable")

    input_json = json.dumps({"url": url, "timeout_ms": timeout_ms}).encode("utf-8")

    try:
        proc = subprocess.Popen(
            [command.executable, str(script)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=_NODE_ENVIRONMENT,
        )

        try:
            stdout, _stderr = proc.communicate(input=input_json, timeout=SUBPROCESS_TIMEOUT_S)
        except subprocess.TimeoutExpired:
            try:
                # This helper deliberately remains in the outer background child's
                # process group. Its local timeout owns only the direct Node child;
                # outer containment owns the complete process group.
                proc.kill()
            except (ProcessLookupError, OSError):
                # justify-ignore-error: the process already exited before the timeout cleanup.
                pass
            proc.wait()
            return IngestError(
                error_code=ApiErrorCode.E_INGEST_TIMEOUT,
                message="Source fetch timed out.",
            )

        if proc.returncode != 0:
            # justify-defect: modeled failures are protocol values with exit zero.
            raise NodeIngestProtocolDefect("Node ingest process exited unexpectedly")
        return _decode_result(stdout)

    except FileNotFoundError as exc:
        # justify-defect: Node is required infrastructure for this owned adapter.
        raise NodeIngestProtocolDefect("Node.js executable is unavailable") from exc
    except OSError as exc:
        # justify-defect: process-launch failures are not modeled source outcomes.
        raise NodeIngestProtocolDefect("Node ingest process could not start") from exc


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
        return _decode_success(value)
    if tag == "Failure":
        return _decode_failure(value)
    raise NodeIngestProtocolDefect("Node ingest returned an unsupported result tag")


def _decode_success(value: dict[str, object]) -> IngestResult:
    if value.keys() != _SUCCESS_KEYS:
        raise NodeIngestProtocolDefect("Node ingest returned an invalid Success payload")
    fields = _SUCCESS_KEYS - {"version", "tag"}
    strings: dict[str, str] = {}
    for field in fields:
        raw = value[field]
        if not isinstance(raw, str) or not _is_bounded_success_field(field, raw):
            raise NodeIngestProtocolDefect("Node ingest returned an invalid Success payload")
        strings[field] = raw

    final_url = strings["final_url"]
    base_url = strings["base_url"]
    if base_url != final_url or not _is_normalized_http_url(final_url):
        raise NodeIngestProtocolDefect("Node ingest returned an invalid Success payload")
    return IngestResult(
        final_url=final_url,
        base_url=base_url,
        title=strings["title"],
        content_html=strings["content_html"],
        source_html=strings["source_html"],
        byline=strings["byline"],
        excerpt=strings["excerpt"],
        site_name=strings["site_name"],
        published_time=strings["published_time"],
    )


def _is_bounded_success_field(field: str, value: str) -> bool:
    if field in {"content_html", "source_html"}:
        return _has_at_most_utf8_bytes(value, _MAX_NODE_INGEST_HTML_BYTES)
    maximum_code_points = _MAX_NODE_INGEST_METADATA_CODE_POINTS.get(field)
    return maximum_code_points is None or _has_at_most_code_points(value, maximum_code_points)


def _has_at_most_utf8_bytes(value: str, maximum: int) -> bool:
    try:
        return len(value.encode("utf-8")) <= maximum
    except UnicodeEncodeError:
        return False


def _has_at_most_code_points(value: str, maximum: int) -> bool:
    try:
        value.encode("utf-8")
    except UnicodeEncodeError:
        return False
    return len(value) <= maximum


def _is_normalized_http_url(value: str) -> bool:
    if not value.isascii() or not 0 < len(value) <= MAX_URL_LENGTH:
        return False
    try:
        parsed = urlsplit(value)
        hostname = parsed.hostname
        port = parsed.port
    except ValueError:
        return False
    if (
        parsed.scheme not in {"http", "https"}
        or hostname is None
        or parsed.username is not None
        or parsed.password is not None
        or parsed.fragment
    ):
        return False
    authority = f"[{hostname}]" if ":" in hostname else hostname
    if port is not None and port != (443 if parsed.scheme == "https" else 80):
        authority = f"{authority}:{port}"
    normalized = urlunsplit((parsed.scheme, authority, parsed.path or "/", parsed.query, ""))
    return value == normalized


def _decode_failure(value: dict[str, object]) -> IngestError:
    if value.keys() != _FAILURE_KEYS:
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
        message = "Source denied access." if status in {401, 403} else f"HTTP error: {status}"
    elif tag == "UnsafeDestination" and failure.keys() == {"tag"}:
        error_code = ApiErrorCode.E_SSRF_BLOCKED
        message = "Source cannot be fetched safely."
    elif tag == "UnsupportedMediaType" and failure.keys() == {"tag"}:
        error_code = ApiErrorCode.E_INVALID_CONTENT_TYPE
        message = "Source is not an HTML document."
    elif tag == "UnsupportedContentEncoding" and failure.keys() == {"tag"}:
        error_code = ApiErrorCode.E_INVALID_CONTENT_TYPE
        message = "Source uses an unsupported content encoding."
    elif tag == "Timeout" and failure.keys() == {"tag"}:
        error_code = ApiErrorCode.E_INGEST_TIMEOUT
        message = "Source fetch timed out."
    elif tag == "Network" and failure.keys() == {"tag"}:
        error_code = ApiErrorCode.E_SOURCE_FETCH_FAILED
        message = "Source fetch failed."
    elif tag == "TooManyRedirects" and failure.keys() == {"tag"}:
        error_code = ApiErrorCode.E_SOURCE_FETCH_FAILED
        message = "Source redirected too many times."
    elif (
        tag == "TooLarge"
        and failure.keys() == {"tag", "limit"}
        and failure.get("limit") in {"wire", "decompressed", "decoded", "source"}
    ):
        error_code = ApiErrorCode.E_SOURCE_TOO_LARGE
        message = "Source exceeds the import size limit."
    elif tag == "Readability" and failure.keys() == {"tag"}:
        error_code = ApiErrorCode.E_SOURCE_NOT_READABLE
        message = "Source does not contain a readable article."
    else:
        raise NodeIngestProtocolDefect("Node ingest returned an unsupported failure variant")
    return IngestError(error_code=error_code, message=message)
