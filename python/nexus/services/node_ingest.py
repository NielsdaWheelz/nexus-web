"""Node.js subprocess wrapper for web article ingestion.

Executes the node/ingest/ingest.mjs script as a subprocess with:
- JSON input/output protocol
- Hard timeout enforcement
- Process group isolation for clean kill
- Structured error handling

Exit codes from Node script:
    0  - Success
    10 - Timeout
    11 - Fetch failed
    12 - Readability extraction failed
"""

import json
import os
import signal
import subprocess
from dataclasses import dataclass
from pathlib import Path

from nexus.errors import ApiErrorCode

# Find the node ingest script relative to this file
# Goes up from python/nexus/services/ to repo root, then to node/ingest/
_REPO_ROOT = Path(__file__).parent.parent.parent.parent
NODE_INGEST_SCRIPT = _REPO_ROOT / "node" / "ingest" / "ingest.mjs"

# Exit codes from node script
EXIT_SUCCESS = 0
EXIT_TIMEOUT = 10
EXIT_FETCH_FAILED = 11
EXIT_READABILITY_FAILED = 12

# Timeout configuration
DEFAULT_NODE_TIMEOUT_MS = 30000  # 30s for Playwright fetch
SUBPROCESS_TIMEOUT_S = 40  # 40s hard wall-clock limit for subprocess


@dataclass
class IngestResult:
    """Result of successful web article ingestion."""

    final_url: str
    base_url: str
    title: str
    content_html: str


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
        timeout_ms: Timeout for Playwright page load (passed to node script).
        subprocess_timeout_s: Hard wall-clock timeout for the entire subprocess.

    Returns:
        IngestResult on success, IngestError on failure.

    Note:
        This function never raises exceptions for expected failure modes.
        It returns IngestError instead, allowing the caller to handle
        failures consistently.
    """
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
            # Kill entire process group
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except ProcessLookupError:
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
