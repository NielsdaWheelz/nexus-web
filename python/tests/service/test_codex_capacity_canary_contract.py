"""Fail-closed structured-output contract for the capacity qualification canary."""

from __future__ import annotations

import asyncio
import importlib.util
import json
import socketserver
import sys
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from types import ModuleType

import pytest
from apps.codex_agent import capacity_canary
from apps.codex_agent.capacity_canary import check

_REPO_ROOT = Path(__file__).resolve().parents[3]


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


@contextmanager
def _faulting_turn_host(socket_path: Path, *, mode: str) -> Iterator[None]:
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
            self.rfile.read(int(headers["content-length"]))
            assert request_line.startswith(b"POST /v1/turns HTTP/")
            if mode == "request_rejected":
                self.wfile.write(
                    b"HTTP/1.1 422 Unprocessable Entity\r\n"
                    b"Content-Length: 0\r\n"
                    b"Connection: close\r\n\r\n"
                )
            elif mode == "protocol_defect":
                self.wfile.write(
                    b"HTTP/1.1 200 OK\r\n"
                    b"Content-Type: application/json\r\n"
                    b"Content-Length: 0\r\n"
                    b"Connection: close\r\n\r\n"
                )
            elif mode == "transport_ambiguous":
                # Acceptance is observable in the 200 response. Closing before
                # its declared body arrives is therefore a post-accept transport
                # loss, not a request rejection or a protocol-authored terminal.
                self.wfile.write(
                    b"HTTP/1.1 200 OK\r\n"
                    b"Content-Type: application/x-ndjson\r\n"
                    b"Content-Length: 1\r\n"
                    b"Connection: close\r\n\r\n"
                )
            else:
                raise AssertionError(f"unsupported faulting turn host mode {mode!r}")
            self.wfile.flush()

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


def test_capacity_canary_rejects_succeeded_terminal_without_metadata_object(tmp_path: Path) -> None:
    """Risk: qualification promotes a host whose successful turns cannot publish metadata."""

    socket_path = tmp_path / "capacity-canary.sock"
    with _empty_success_terminal_host(socket_path):
        result, exit_code = asyncio.run(check(socket_path))

    assert exit_code == 22, "invalid structured output authorized capacity qualification"
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


def test_capacity_canary_authors_preaccept_unavailable_as_retriable_transport(
    tmp_path: Path,
) -> None:
    """Risk: host unavailability permanently disqualifies an otherwise valid candidate."""

    result, exit_code = asyncio.run(check(tmp_path / "absent-capacity-canary.sock"))

    assert exit_code == 23
    assert result == {
        "schema_version": "nexus-codex-capacity-canary.v1",
        "status": "transport_retriable",
        "turns": [],
    }


def test_capacity_canary_authors_postaccept_loss_as_retriable_transport(tmp_path: Path) -> None:
    """Risk: an ambiguous accepted turn is mislabeled as a measured capacity breach."""

    socket_path = tmp_path / "ambiguous-capacity-canary.sock"
    with _faulting_turn_host(socket_path, mode="transport_ambiguous"):
        result, exit_code = asyncio.run(check(socket_path))

    assert exit_code == 23
    assert result == {
        "schema_version": "nexus-codex-capacity-canary.v1",
        "status": "transport_retriable",
        "turns": [],
    }


@pytest.mark.parametrize("mode", ["request_rejected", "protocol_defect"])
def test_capacity_canary_keeps_authored_or_protocol_defects_as_failed_breach(
    tmp_path: Path,
    mode: str,
) -> None:
    """Risk: a rejected command or malformed host protocol is made silently retriable."""

    socket_path = tmp_path / f"{mode}-capacity-canary.sock"
    with _faulting_turn_host(socket_path, mode=mode):
        result, exit_code = asyncio.run(check(socket_path))

    assert exit_code == 22
    assert result == {
        "schema_version": "nexus-codex-capacity-canary.v1",
        "status": "failed",
        "turns": [],
    }


def _release_controller() -> ModuleType:
    path = _REPO_ROOT / "deploy/hetzner/release.py"
    spec = importlib.util.spec_from_file_location("nexus_release_canary_contract", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def test_release_controller_mirrors_the_canary_exit_and_phase_contract() -> None:
    """Risk: the controller's mirrored canary table drifts from the canary itself."""

    release = _release_controller()

    # The literal table is the reviewed public contract; the mirror equality
    # below then documents that the controller carries exactly these values.
    assert capacity_canary.EXIT_CODES == {
        "passed": 0,
        "not_run": 20,
        "provider_blocked": 21,
        "failed": 22,
        "transport_retriable": 23,
    }
    # No stated terminal may collide with what a dying process produces on its
    # own: 1 is an uncaught exception, 128..255 is 128+signal. The controller's
    # parse-first classification depends on this disjointness.
    for status, code in capacity_canary.EXIT_CODES.items():
        if status != "passed":
            assert code != 1 and not (128 <= code <= 255), (status, code)

    assert release._CODEX_CAPACITY_CANARY_EXIT_CODES == capacity_canary.EXIT_CODES
    assert release._CODEX_CAPACITY_PHASES == tuple(
        phase for phase, _request_id in capacity_canary.TURNS
    )
