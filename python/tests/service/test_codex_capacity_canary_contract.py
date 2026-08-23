"""Fail-closed structured-output contract for the capacity qualification canary."""

from __future__ import annotations

import asyncio
import json
import socketserver
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from tempfile import gettempdir
from uuid import uuid4

from apps.codex_agent.capacity_canary import check

_LINUX_SUN_PATH_BYTES = 108


def _short_socket_path() -> Path:
    socket_path = Path(gettempdir()) / f"nexus-capacity-canary-{uuid4().hex[:16]}.sock"
    assert len(str(socket_path).encode("utf-8")) < _LINUX_SUN_PATH_BYTES
    return socket_path


@contextmanager
def _empty_success_terminal_host(socket_path: Path) -> Iterator[None]:
    class Handler(socketserver.StreamRequestHandler):
        def handle(self) -> None:
            request_line = self.rfile.readline()
            headers: dict[str, str] = {}
            while True:
                line = self.rfile.readline()
                if line in (b"\r\n", b"\n", b""):
                    break
                name, value = line.decode("ascii").split(":", 1)
                headers[name.casefold()] = value.strip()
            command = json.loads(self.rfile.read(int(headers["content-length"])))
            frame = {
                "schema_version": "nexus-agent-event.v1",
                "request_id": command["request_id"],
                "sequence": 0,
                "event": {
                    "kind": "terminal",
                    "status": "succeeded",
                    "failure": None,
                    "final_text": "",
                    "structured_output": {},
                    "session_ref": {
                        "schema_version": "agent-session-ref.v1",
                        "backend": "codex",
                        "transport": "sdk",
                        "native_session_id": "thread-test",
                        "profile_key": "codex-personal",
                        "state_root_fingerprint": "1" * 64,
                        "cwd_fingerprint": "2" * 64,
                    },
                    "usage": {
                        "input_tokens": 1,
                        "output_tokens": 1,
                        "total_tokens": 2,
                        "reasoning_tokens": None,
                        "cache_read_input_tokens": None,
                        "cache_write_input_tokens": None,
                    },
                    "diagnostics": [],
                    "sdk_version": "0.144.4",
                    "runtime_version": "0.144.4",
                },
            }
            payload = (json.dumps(frame, separators=(",", ":")) + "\n").encode("utf-8")
            self.wfile.write(
                b"HTTP/1.1 200 OK\r\n"
                b"Content-Type: application/x-ndjson\r\n"
                + f"Content-Length: {len(payload)}\r\n".encode("ascii")
                + b"Connection: close\r\n\r\n"
                + payload
            )
            self.wfile.flush()
            assert request_line.startswith(b"POST /v1/turns HTTP/")

    class Server(socketserver.UnixStreamServer):
        allow_reuse_address = False

    with Server(str(socket_path), Handler) as server:
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            yield
        finally:
            server.shutdown()
            thread.join(timeout=5)
            server.server_close()
            socket_path.unlink(missing_ok=True)


def test_capacity_canary_rejects_succeeded_terminal_without_metadata_object() -> None:
    """Risk: qualification promotes a host whose successful turns cannot publish metadata."""

    socket_path = _short_socket_path()
    with _empty_success_terminal_host(socket_path):
        result, exit_code = asyncio.run(check(socket_path))

    assert exit_code == 1, "invalid structured output authorized capacity qualification"
    assert result["status"] == "failed"
    assert result["turns"] == [
        {
            "phase": "cold",
            "terminal_status": "succeeded",
            "failure_kind": None,
            "usage_present": True,
            "sdk_version": "0.144.4",
            "runtime_version": "0.144.4",
            "tool_event_count": 0,
            "permission_event_count": 0,
        }
    ]
