"""Fail-closed structured-output contract for the capacity qualification canary."""

from __future__ import annotations

import asyncio
import hashlib
import importlib.metadata
import importlib.util
import json
import socketserver
import sys
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from tempfile import gettempdir
from types import ModuleType
from typing import TYPE_CHECKING
from uuid import UUID, uuid4

import pytest
from apps.codex_agent import capacity_canary

_GENERATION_SPEC_PRESENT = importlib.util.find_spec("nexus.services.generation_spec") is not None
if TYPE_CHECKING or _GENERATION_SPEC_PRESENT:
    from apps.codex_agent.capacity_canary import CapacityCanaryInput, check

    from nexus.services.codex_generation_contract import (
        GenerationAdmission,
        GenerationAdmissionRequest,
    )
    from tests.testkit.codex_generation import codex_generation_draft


def _require_generation_spec() -> None:
    assert _GENERATION_SPEC_PRESENT, "the final capacity-canary generation spec is absent"


def _canary_input() -> CapacityCanaryInput:
    draft = codex_generation_draft(
        request_id=UUID(int=100),
        operation="dawn_write",
        instructions=capacity_canary.CANARY_INSTRUCTIONS,
        input_text=capacity_canary.CANARY_INPUT,
        model="gpt-5.6-terra",
        reasoning="medium",
        turn_timeout_seconds=180,
    )
    spec_document = draft.spec.model_dump(mode="json", by_alias=True)
    spec_document["prompt_template_revision"] = capacity_canary.CANARY_PROMPT_TEMPLATE_REVISION
    spec_document["effective_context_budget_tokens"] = 128_000
    spec_document["effective_output_budget_tokens"] = 16_000
    prompt_ref = spec_document["prompt_payload_ref"]
    assert isinstance(prompt_ref, dict)
    prompt_ref.update(
        {
            "owner_kind": "CodexCapacityCanary",
            "owner_id": "production-capacity",
            "revision": "dawn-write.v1",
        }
    )
    fingerprint_facts = dict(spec_document)
    fingerprint_facts.pop("fingerprint")
    spec_document["fingerprint"] = hashlib.sha256(
        json.dumps(
            fingerprint_facts,
            ensure_ascii=True,
            allow_nan=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
    ).hexdigest()
    return CapacityCanaryInput(
        schema_version="nexus-codex-capacity-canary-input.v1",
        spec=spec_document,
        intent=draft.intent,
    )


def _write_health(handler: socketserver.StreamRequestHandler) -> None:
    payload = json.dumps(
        {
            "schema_version": "nexus-generation-health.v2",
            "status": "ready",
            "backend": "codex",
            "transport": "sdk",
            "auth_profile": "codex-personal",
            "command_schema_version": "nexus-generation-command.v3",
            "sdk_version": importlib.metadata.version("openai-codex"),
            "runtime_version": importlib.metadata.version("openai-codex-cli-bin"),
        },
        separators=(",", ":"),
    ).encode()
    handler.wfile.write(
        b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n"
        + f"Content-Length: {len(payload)}\r\nConnection: close\r\n\r\n".encode()
        + payload
    )
    handler.wfile.flush()


_REPO_ROOT = Path(__file__).resolve().parents[3]
_LINUX_SUN_PATH_BYTES = 108


def _request_body(handler: socketserver.StreamRequestHandler, headers: dict[str, str]) -> bytes:
    if "content-length" in headers:
        return handler.rfile.read(int(headers["content-length"]))
    assert headers.get("transfer-encoding") == "chunked"
    body = bytearray()
    while True:
        size = int(handler.rfile.readline().split(b";", 1)[0], 16)
        if size == 0:
            handler.rfile.readline()
            return bytes(body)
        body.extend(handler.rfile.read(size))
        assert handler.rfile.read(2) == b"\r\n"


def _write_admission(
    handler: socketserver.StreamRequestHandler,
    payload: bytes,
) -> GenerationAdmission:
    request = GenerationAdmissionRequest.model_validate_json(payload)
    admission = GenerationAdmission(
        request_id=request.request_id,
        admission_id=uuid4(),
        admitted_at="2026-08-24T00:00:00.000000Z",
        runtime_deadline_seconds=request.turn_timeout_seconds,
    )
    response = admission.model_dump_json().encode("utf-8")
    handler.wfile.write(
        b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n"
        + f"Content-Length: {len(response)}\r\nConnection: close\r\n\r\n".encode()
        + response
    )
    handler.wfile.flush()
    return admission


def _short_socket_path() -> Path:
    socket_path = Path(gettempdir()) / f"nexus-capacity-canary-{uuid4().hex[:16]}.sock"
    assert len(str(socket_path).encode("utf-8")) < _LINUX_SUN_PATH_BYTES
    return socket_path


@contextmanager
def _empty_success_terminal_host(socket_path: Path) -> Iterator[None]:
    admission_ids: set[str] = set()

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
            if request_line.startswith(b"GET /health "):
                _write_health(self)
                return
            body = _request_body(self, headers)
            if request_line.startswith(b"POST /v2/generation-admissions HTTP/"):
                admission = _write_admission(self, body)
                admission_ids.add(str(admission.admission_id))
                return
            assert request_line.startswith(b"POST /v2/generations HTTP/")
            assert headers.get("nexus-generation-admission") in admission_ids
            command = json.loads(body)
            frame = {
                "schema_version": "nexus-generation-event.v2",
                "request_id": command["request_id"],
                "sequence": 0,
                "event": {
                    "kind": "terminal",
                    "status": "succeeded",
                    "failure": None,
                    "final_text": "",
                    "structured_output": None,
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
                    "accepted_at": "2026-08-24T00:00:00.000000Z",
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


@contextmanager
def _faulting_turn_host(socket_path: Path, *, mode: str) -> Iterator[None]:
    admission_ids: set[str] = set()

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
            if request_line.startswith(b"GET /health "):
                _write_health(self)
                return
            body = _request_body(self, headers)
            if request_line.startswith(b"POST /v2/generation-admissions HTTP/"):
                if mode == "request_rejected":
                    self.wfile.write(
                        b"HTTP/1.1 422 Unprocessable Entity\r\n"
                        b"Content-Length: 0\r\n"
                        b"Connection: close\r\n\r\n"
                    )
                    self.wfile.flush()
                    return
                admission = _write_admission(self, body)
                admission_ids.add(str(admission.admission_id))
                return
            assert request_line.startswith(b"POST /v2/generations HTTP/")
            assert headers.get("nexus-generation-admission") in admission_ids
            if mode == "protocol_defect":
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
            socket_path.unlink(missing_ok=True)


def test_capacity_canary_rejects_succeeded_terminal_without_bounded_text() -> None:
    """Risk: qualification promotes a host whose successful turns cannot publish text."""

    _require_generation_spec()
    socket_path = _short_socket_path()
    with _empty_success_terminal_host(socket_path):
        canary_input = _canary_input()
        result, exit_code = asyncio.run(check(socket_path, canary_input))

    assert exit_code == 22, "empty successful text authorized capacity qualification"
    assert result["status"] == "failed"
    assert result["turns"] == [
        {
            "phase": "cold",
            "operation": "dawn_write",
            "generation_spec_fingerprint": canary_input.spec.fingerprint,
            "model": "gpt-5.6-terra",
            "reasoning": "medium",
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

    _require_generation_spec()
    result, exit_code = asyncio.run(
        check(tmp_path / "absent-capacity-canary.sock", _canary_input())
    )

    assert exit_code == 23
    assert result == {
        "schema_version": "nexus-codex-capacity-canary.v4",
        "status": "transport_retriable",
        "turns": [],
    }


def test_capacity_canary_authors_postaccept_loss_as_retriable_transport() -> None:
    """Risk: an ambiguous accepted turn is mislabeled as a measured capacity breach."""

    _require_generation_spec()
    socket_path = _short_socket_path()
    with _faulting_turn_host(socket_path, mode="transport_ambiguous"):
        result, exit_code = asyncio.run(check(socket_path, _canary_input()))

    assert exit_code == 23
    assert result == {
        "schema_version": "nexus-codex-capacity-canary.v4",
        "status": "transport_retriable",
        "turns": [],
    }


@pytest.mark.parametrize("mode", ["request_rejected", "protocol_defect"])
def test_capacity_canary_keeps_authored_or_protocol_defects_as_failed_breach(
    mode: str,
) -> None:
    """Risk: a rejected command or malformed host protocol is made silently retriable."""

    _require_generation_spec()
    socket_path = _short_socket_path()
    with _faulting_turn_host(socket_path, mode=mode):
        result, exit_code = asyncio.run(check(socket_path, _canary_input()))

    assert exit_code == 22
    assert result == {
        "schema_version": "nexus-codex-capacity-canary.v4",
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

    _require_generation_spec()
    release = _release_controller()

    # The literal table is the reviewed public contract; the mirror equality
    # below then documents that the controller carries exactly these values.
    assert capacity_canary.EXIT_CODES == {
        "passed": 0,
        "not_run": 20,
        "subscription_blocked": 21,
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


def test_release_controller_accepts_only_the_canonical_candidate_frozen_input() -> None:
    """Risk: release qualification runs a caller-invented or drifted generation spec."""

    _require_generation_spec()
    release = _release_controller()
    payload = (
        json.dumps(
            _canary_input().model_dump(mode="json", by_alias=True),
            ensure_ascii=True,
            separators=(",", ":"),
            sort_keys=True,
        )
        + "\n"
    ).encode()

    assert release._validated_codex_capacity_input_bytes(payload) == payload

    for mutate in (
        lambda value: value["spec"].__setitem__("operation", "dossier_library"),
        lambda value: value["spec"]["selection"].__setitem__("reasoning", "high"),
        lambda value: value["intent"].__setitem__("input", "operator supplied input"),
    ):
        value = json.loads(payload)
        mutate(value)
        drifted = (
            json.dumps(value, ensure_ascii=True, separators=(",", ":"), sort_keys=True) + "\n"
        ).encode()
        with pytest.raises(release.ReleaseDefect):
            release._validated_codex_capacity_input_bytes(drifted)
