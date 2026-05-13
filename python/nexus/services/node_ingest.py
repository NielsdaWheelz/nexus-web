"""Node.js subprocess wrapper for web article ingestion.

Executes the node/ingest/ingest.mjs script as a subprocess with:
- JSON input/output protocol
- Hard timeout enforcement
- Process group isolation for clean kill
- Structured error handling

The Node script uses native fetch() (Node 20+) for HTTP and
jsdom + Mozilla Readability for article extraction. No browser required.

Exit codes from Node script:
    0  - Success
    10 - Timeout
    11 - Fetch failed
    12 - Readability extraction failed
"""

import hashlib
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

# Exit codes from node script
EXIT_SUCCESS = 0
EXIT_TIMEOUT = 10
EXIT_FETCH_FAILED = 11
EXIT_READABILITY_FAILED = 12

# Timeout configuration
DEFAULT_NODE_TIMEOUT_MS = 30000  # 30s for HTTP fetch
SUBPROCESS_TIMEOUT_S = 40  # 40s hard wall-clock limit for subprocess


@dataclass
class IngestResult:
    """Result of successful web article ingestion."""

    final_url: str
    base_url: str
    title: str
    content_html: str
    byline: str = ""
    excerpt: str = ""
    site_name: str = ""
    published_time: str = ""
    provider_fixture: dict[str, object] | None = None


@dataclass
class IngestError:
    """Error from web article ingestion."""

    error_code: ApiErrorCode
    message: str


def run_node_ingest(
    url: str,
    timeout_ms: int = DEFAULT_NODE_TIMEOUT_MS,
    subprocess_timeout_s: int = SUBPROCESS_TIMEOUT_S,
) -> IngestResult | IngestError:
    """Run the Node.js ingest script to fetch and extract a web article.

    Args:
        url: The URL to fetch.
        timeout_ms: Timeout for HTTP fetch (passed to node script).
        subprocess_timeout_s: Hard wall-clock timeout for the entire subprocess.

    Returns:
        IngestResult on success, IngestError on failure.

    Note:
        This function never raises exceptions for expected failure modes.
        It returns IngestError instead, allowing the caller to handle
        failures consistently.
    """
    from nexus.config import get_settings, real_media_provider_fixtures_requested

    if real_media_provider_fixtures_requested():
        settings = get_settings()
        if settings.real_media_provider_fixtures:
            return _run_real_media_fixture_ingest(url, settings.real_media_fixture_dir)

    # Verify script exists
    if not NODE_INGEST_SCRIPT.exists():
        return IngestError(
            error_code=ApiErrorCode.E_INGEST_FAILED,
            message=f"Node ingest script not found at {NODE_INGEST_SCRIPT}",
        )

    # Prepare input JSON
    input_data = {"url": url, "timeout_ms": timeout_ms}
    input_json = json.dumps(input_data).encode("utf-8")

    try:
        # Start subprocess in new process group for clean kill
        # Using start_new_session=True creates a new session/process group
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
            # Kill entire process group (POSIX) or process (Windows fallback)
            try:
                if hasattr(os, "killpg"):
                    os.killpg(proc.pid, signal.SIGKILL)
                else:
                    proc.kill()
            except (ProcessLookupError, OSError):
                pass  # Process already dead
            proc.wait()
            return IngestError(
                error_code=ApiErrorCode.E_INGEST_TIMEOUT,
                message=f"Subprocess timeout after {subprocess_timeout_s}s",
            )

        # Check exit code
        exit_code = proc.returncode

        if exit_code == EXIT_SUCCESS:
            # Parse successful output
            try:
                result_data = json.loads(stdout.decode("utf-8"))
                return IngestResult(
                    final_url=result_data["final_url"],
                    base_url=result_data["base_url"],
                    title=result_data.get("title", ""),
                    content_html=result_data["content_html"],
                    byline=result_data.get("byline") or "",
                    excerpt=result_data.get("excerpt") or "",
                    site_name=result_data.get("site_name") or "",
                    published_time=result_data.get("published_time") or "",
                )
            except (json.JSONDecodeError, KeyError) as e:
                return IngestError(
                    error_code=ApiErrorCode.E_INGEST_FAILED,
                    message=f"Invalid output from node script: {e}",
                )

        # Handle error exit codes
        error_message = _extract_error_message(stderr, stdout)

        if exit_code == EXIT_TIMEOUT:
            return IngestError(
                error_code=ApiErrorCode.E_INGEST_TIMEOUT,
                message=error_message or "Page load timeout",
            )
        elif exit_code == EXIT_FETCH_FAILED:
            return IngestError(
                error_code=ApiErrorCode.E_INGEST_FAILED,
                message=error_message or "Fetch failed",
            )
        elif exit_code == EXIT_READABILITY_FAILED:
            return IngestError(
                error_code=ApiErrorCode.E_INGEST_FAILED,
                message=error_message or "Readability extraction failed",
            )
        else:
            return IngestError(
                error_code=ApiErrorCode.E_INGEST_FAILED,
                message=f"Node script exited with code {exit_code}: {error_message}",
            )

    except FileNotFoundError:
        return IngestError(
            error_code=ApiErrorCode.E_INGEST_FAILED,
            message="Node.js not found. Ensure Node.js is installed.",
        )
    except Exception as e:
        return IngestError(
            error_code=ApiErrorCode.E_INGEST_FAILED,
            message=f"Subprocess error: {e}",
        )


def _extract_error_message(stderr: bytes, stdout: bytes) -> str:
    """Extract error message from subprocess output.

    The node script outputs JSON errors to stderr.
    Falls back to raw stderr/stdout if JSON parsing fails.
    """
    # Try stderr first (where errors are written)
    if stderr:
        try:
            error_data = json.loads(stderr.decode("utf-8"))
            if "error" in error_data:
                return error_data["error"]
        except (json.JSONDecodeError, UnicodeDecodeError):
            pass
        # Return raw stderr, truncated
        decoded = stderr.decode("utf-8", errors="replace")
        return decoded[:500] if len(decoded) > 500 else decoded

    # Fall back to stdout
    if stdout:
        decoded = stdout.decode("utf-8", errors="replace")
        return decoded[:500] if len(decoded) > 500 else decoded

    return ""


def _run_real_media_fixture_ingest(url: str, fixture_dir: str | None) -> IngestResult | IngestError:
    requested_url = str(url or "").strip()
    if requested_url != "https://science.nasa.gov/solar-system/moon/theres-water-on-the-moon/":
        return IngestError(
            error_code=ApiErrorCode.E_INGEST_FAILED,
            message=f"No real-media web article fixture for {requested_url}",
        )
    if fixture_dir is None:
        return IngestError(
            error_code=ApiErrorCode.E_INGEST_FAILED,
            message="REAL_MEDIA_FIXTURE_DIR is required for web article fixtures",
        )

    path = Path(fixture_dir) / "nasa-water-on-moon-capture.html"
    try:
        content_html = path.read_text(encoding="utf-8")
    except OSError as exc:
        return IngestError(
            error_code=ApiErrorCode.E_INGEST_FAILED,
            message=f"Web article fixture unavailable: {exc}",
        )

    payload = content_html.encode("utf-8")
    if len(payload) != 1_019 or hashlib.sha256(payload).hexdigest() != (
        "cedefaeab3c7fb3fab6be4aba68a23db58280e65b71c3914af2c8023e30e4e7a"
    ):
        return IngestError(
            error_code=ApiErrorCode.E_INGEST_FAILED,
            message="Web article fixture hash mismatch",
        )

    return IngestResult(
        final_url=requested_url,
        base_url="https://science.nasa.gov/",
        title="There's Water on the Moon?",
        content_html=content_html,
        byline="Molly Wasser",
        excerpt="NASA Science captured article fixture.",
        site_name="NASA Science",
        published_time="2020-11-05T00:00:00Z",
        provider_fixture={
            "path": str(path),
            "byte_length": len(payload),
            "sha256": "cedefaeab3c7fb3fab6be4aba68a23db58280e65b71c3914af2c8023e30e4e7a",
            "source_url": requested_url,
        },
    )
