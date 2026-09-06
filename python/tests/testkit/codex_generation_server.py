"""Strict, deterministic Codex v2 UDS peer owned by the local test controller."""

from __future__ import annotations

import argparse
import importlib.metadata
import json
import re
import socketserver
import threading
from dataclasses import dataclass
from datetime import UTC, datetime
from http import HTTPStatus
from pathlib import Path
from typing import BinaryIO
from uuid import NAMESPACE_URL, UUID, uuid5

from pydantic import ValidationError

from nexus.schemas.presence import Absent, Present
from nexus.services.codex_generation_contract import (
    MAX_ADMISSION_BODY_BYTES,
    MAX_COMMAND_BODY_BYTES,
    CodexModelCatalog,
    GenerationAdmission,
    GenerationAdmissionRequest,
    GenerationCapacityRejection,
    GenerationCommand,
    GenerationFrame,
    GenerationHealth,
    GenerationSessionRef,
    GenerationTerminal,
    GenerationText,
    GenerationUsage,
    codex_model_catalog_to_wire,
    generation_admission_request,
    generation_command_draft,
    request_fingerprint,
)
from tests.testkit.generation_catalog import policy_complete_codex_catalog

_HOST = "nexus-codex"
_MAX_REQUEST_LINE_BYTES = 4 * 1024
_MAX_HEADER_LINE_BYTES = 8 * 1024
_MAX_HEADER_BYTES = 32 * 1024
_MAX_HEADER_COUNT = 64
_SDK_VERSION = importlib.metadata.version("openai-codex")
_RUNTIME_VERSION = importlib.metadata.version("openai-codex-cli-bin")
_GROUNDED_RESPONSE = (
    "The source says SOFIA helped confirm water on the Moon by detecting a "
    "water signature in Clavius Crater. [1]"
)
_CONTROL_PATH = re.compile(
    r"/v2/generations/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-"
    r"[89ab][0-9a-f]{3}-[0-9a-f]{12})/(cancel|policy-violation)\Z"
)


@dataclass(frozen=True, slots=True)
class _ReservedAdmission:
    request: GenerationAdmissionRequest
    response: GenerationAdmission


def _accepted_at() -> str:
    """The real current UTC instant in the exact wire shape the contract validates."""
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


class RequestRejected(Exception):
    def __init__(self, status: HTTPStatus, code: str) -> None:
        self.status = status
        self.code = code
        super().__init__(code)


def deterministic_synthesis_output(command: GenerationCommand) -> dict[str, object]:
    """Return the exact tool-free synthesis needed by real-stack journeys."""

    if command.tool_grant is not None or not isinstance(
        command.spec.model_tool_plan_snapshot, Absent
    ):
        raise RequestRejected(HTTPStatus.UNPROCESSABLE_ENTITY, "synthesis_tool_grant_forbidden")
    if command.spec.operation == "metadata_enrichment":
        return {
            "title": None,
            "authors": None,
            "publisher": None,
            "description": None,
            "published_date": None,
            "language": "en",
        }
    if command.spec.operation == "media_summary":
        candidate = re.search(
            r"(?:\A|\n)\[0\]\s+(.+?)(?=\n\n\[\d+\]\s|\Z)",
            command.intent.input,
            re.DOTALL,
        )
        summary = " ".join(candidate.group(1).split())[:512] if candidate is not None else ""
        if not summary:
            raise RequestRejected(HTTPStatus.UNPROCESSABLE_ENTITY, "missing_media_candidate")
        return {"summary_md": summary, "claims": []}
    raise RequestRejected(HTTPStatus.UNPROCESSABLE_ENTITY, "unsupported_operation")


class CodexGenerationPeerServer(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    allow_reuse_address = False
    daemon_threads = True

    def __init__(self, socket_path: Path, audit: Path) -> None:
        self.audit = audit
        self._audit_lock = threading.Lock()
        self._admission_lock = threading.Lock()
        self._pending: _ReservedAdmission | None = None
        super().__init__(str(socket_path), CodexGenerationPeerHandler)

    def record_command(self, command: GenerationCommand) -> None:
        plan = command.spec.model_tool_plan_snapshot
        row = {
            "catalog_definition_revision": command.spec.catalog_definition_revision,
            "generation_spec_fingerprint": command.spec.fingerprint,
            "model": command.spec.selection.model,
            "model_tool_plan": plan.value.plan_id if isinstance(plan, Present) else None,
            "operation": command.spec.operation,
            "reasoning": command.spec.selection.reasoning,
            "request_fingerprint": request_fingerprint(command),
            "request_id": str(command.request_id),
            "route": command.spec.selection.route,
            "tool_grant_present": command.tool_grant is not None,
        }
        with self._audit_lock, self.audit.open("a", encoding="utf-8") as audit:
            audit.write(json.dumps(row, separators=(",", ":"), sort_keys=True) + "\n")

    def reserve(self, request: GenerationAdmissionRequest) -> GenerationAdmission | None:
        """Mirror the production host's one replay-stable pending slot."""

        with self._admission_lock:
            pending = self._pending
            if pending is not None:
                return pending.response if pending.request == request else None
            response = GenerationAdmission(
                request_id=request.request_id,
                admission_id=uuid5(
                    NAMESPACE_URL,
                    f"nexus-test-codex-admission:{request.request_id}:{request.request_fingerprint}",
                ),
                admitted_at=_accepted_at(),
                runtime_deadline_seconds=request.turn_timeout_seconds,
            )
            self._pending = _ReservedAdmission(request=request, response=response)
            return response

    def consume(self, admission_id: UUID, command: GenerationCommand) -> bool:
        with self._admission_lock:
            pending = self._pending
            if pending is None or pending.response.admission_id != admission_id:
                return False
            matches = pending.request == generation_admission_request(
                generation_command_draft(command)
            )
            self._pending = None
            return matches

    def cancel(self, request_id: UUID) -> None:
        with self._admission_lock:
            pending = self._pending
            if pending is not None and pending.request.request_id == request_id:
                self._pending = None


class CodexGenerationPeerHandler(socketserver.StreamRequestHandler):
    @property
    def peer(self) -> CodexGenerationPeerServer:
        server = self.server
        if not isinstance(server, CodexGenerationPeerServer):
            raise AssertionError("Codex generation handler has the wrong server")
        return server

    def handle(self) -> None:
        try:
            method, path, headers, body = self._read_request()
            if method == "GET" and path == "/health":
                self._serve_health(headers, body)
                return
            if method == "GET" and path == "/v2/model-catalog":
                self._serve_model_catalog(headers, body)
                return
            if method == "POST" and path == "/v2/generation-admissions":
                self._serve_admission(headers, body)
                return
            if method == "POST" and path == "/v2/generations":
                self._serve_generation(headers, body)
                return
            if method == "POST" and (match := _CONTROL_PATH.fullmatch(path)) is not None:
                self._serve_control(headers, body, match.group(1))
                return
            raise RequestRejected(HTTPStatus.NOT_FOUND, "unknown_path")
        except RequestRejected as error:
            self._send_json(error.status, {"error": {"code": error.code}})

    def _read_request(self) -> tuple[str, str, dict[str, str], bytes]:
        request_line = self._readline(self.rfile, _MAX_REQUEST_LINE_BYTES, "request_line")
        try:
            method, path, version = request_line.decode("ascii").rstrip("\r\n").split(" ")
        except (UnicodeDecodeError, ValueError) as error:
            raise RequestRejected(HTTPStatus.BAD_REQUEST, "invalid_request_line") from error
        if version != "HTTP/1.1" or method not in {"GET", "POST"} or not path.startswith("/"):
            raise RequestRejected(HTTPStatus.BAD_REQUEST, "invalid_request_line")
        headers: dict[str, str] = {}
        header_bytes = 0
        for _ in range(_MAX_HEADER_COUNT):
            line = self._readline(self.rfile, _MAX_HEADER_LINE_BYTES, "header_line")
            header_bytes += len(line)
            if header_bytes > _MAX_HEADER_BYTES:
                raise RequestRejected(
                    HTTPStatus.REQUEST_HEADER_FIELDS_TOO_LARGE, "headers_too_large"
                )
            if line == b"\r\n":
                break
            try:
                name, value = line.decode("ascii").rstrip("\r\n").split(":", 1)
            except (UnicodeDecodeError, ValueError) as error:
                raise RequestRejected(HTTPStatus.BAD_REQUEST, "invalid_header") from error
            normalized_name = name.strip().casefold()
            normalized_value = value.strip()
            if not normalized_name or normalized_name in headers:
                raise RequestRejected(HTTPStatus.BAD_REQUEST, "invalid_header")
            headers[normalized_name] = normalized_value
        else:
            raise RequestRejected(HTTPStatus.REQUEST_HEADER_FIELDS_TOO_LARGE, "too_many_headers")
        if headers.get("host") != _HOST:
            raise RequestRejected(HTTPStatus.BAD_REQUEST, "invalid_host")
        if "transfer-encoding" in headers or "content-encoding" in headers:
            raise RequestRejected(HTTPStatus.BAD_REQUEST, "encoded_body_forbidden")
        raw_length = headers.get("content-length", "0")
        if not raw_length.isdecimal():
            raise RequestRejected(HTTPStatus.BAD_REQUEST, "invalid_content_length")
        content_length = int(raw_length)
        maximum_body_bytes = (
            MAX_ADMISSION_BODY_BYTES
            if path == "/v2/generation-admissions"
            else MAX_COMMAND_BODY_BYTES
        )
        if content_length > maximum_body_bytes:
            raise RequestRejected(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "request_too_large")
        body = self.rfile.read(content_length)
        if len(body) != content_length:
            raise RequestRejected(HTTPStatus.BAD_REQUEST, "incomplete_body")
        return method, path, headers, body

    @staticmethod
    def _readline(stream: BinaryIO, maximum: int, code: str) -> bytes:
        line = stream.readline(maximum + 1)
        if not line or len(line) > maximum or not line.endswith(b"\r\n"):
            raise RequestRejected(HTTPStatus.BAD_REQUEST, code)
        return line

    def _serve_health(self, headers: dict[str, str], body: bytes) -> None:
        if body or headers.get("accept") != "application/json":
            raise RequestRejected(HTTPStatus.BAD_REQUEST, "invalid_health_request")
        health = GenerationHealth(
            sdk_version=_SDK_VERSION,
            runtime_version=_RUNTIME_VERSION,
        )
        self._send_bytes(
            HTTPStatus.OK,
            health.model_dump_json().encode("utf-8"),
            "application/json",
        )

    def _serve_model_catalog(self, headers: dict[str, str], body: bytes) -> None:
        if body or headers.get("accept") != "application/json":
            raise RequestRejected(HTTPStatus.BAD_REQUEST, "invalid_model_catalog_request")
        catalog: CodexModelCatalog = codex_model_catalog_to_wire(policy_complete_codex_catalog())
        self._send_bytes(
            HTTPStatus.OK,
            catalog.model_dump_json().encode("utf-8"),
            "application/json",
        )

    def _serve_admission(self, headers: dict[str, str], body: bytes) -> None:
        if (
            headers.get("accept") != "application/json"
            or headers.get("content-type") != "application/json"
            or not body
        ):
            raise RequestRejected(HTTPStatus.UNSUPPORTED_MEDIA_TYPE, "invalid_admission_headers")
        try:
            request = GenerationAdmissionRequest.model_validate_json(body)
        except ValidationError as error:
            raise RequestRejected(HTTPStatus.UNPROCESSABLE_ENTITY, "invalid_admission") from error
        admission = self.peer.reserve(request)
        if admission is None:
            rejection = GenerationCapacityRejection()
            self._send_bytes(
                HTTPStatus.SERVICE_UNAVAILABLE,
                rejection.model_dump_json().encode("utf-8"),
                "application/json",
            )
            return
        self._send_bytes(
            HTTPStatus.OK,
            admission.model_dump_json().encode("utf-8"),
            "application/json",
        )

    def _serve_generation(self, headers: dict[str, str], body: bytes) -> None:
        if (
            headers.get("accept") != "application/x-ndjson"
            or headers.get("content-type") != "application/json"
            or not body
        ):
            raise RequestRejected(HTTPStatus.UNSUPPORTED_MEDIA_TYPE, "invalid_generation_headers")
        try:
            command = GenerationCommand.model_validate_json(body)
        except ValidationError as error:
            raise RequestRejected(HTTPStatus.UNPROCESSABLE_ENTITY, "invalid_generation") from error
        raw_admission_id = headers.get("nexus-generation-admission")
        try:
            admission_id = UUID(raw_admission_id or "")
        except ValueError as error:
            raise RequestRejected(HTTPStatus.CONFLICT, "invalid_generation_admission") from error
        if str(admission_id) != raw_admission_id or not self.peer.consume(admission_id, command):
            raise RequestRejected(HTTPStatus.CONFLICT, "generation_admission_mismatch")
        if command.spec.operation == "chat":
            prompt = f"{command.intent.instructions}\n{command.intent.input}".casefold()
            if "sofia" not in prompt or "clavius crater" not in prompt:
                raise RequestRejected(HTTPStatus.UNPROCESSABLE_ENTITY, "unknown_chat_scenario")
            text = _GROUNDED_RESPONSE
            structured_output = None
        else:
            structured_output = deterministic_synthesis_output(command)
            text = json.dumps(structured_output, separators=(",", ":"), sort_keys=True)
        self.peer.record_command(command)
        events = ((GenerationText(text=text),) if command.spec.operation == "chat" else ()) + (
            GenerationTerminal(
                status="succeeded",
                failure=None,
                final_text=text,
                structured_output=structured_output,
                session_ref=GenerationSessionRef(
                    schema_version="agent-session-ref.v1",
                    backend="codex",
                    transport="sdk",
                    native_session_id=f"test-{command.request_id}",
                    profile_key="codex-personal",
                    state_root_fingerprint="1" * 64,
                    cwd_fingerprint="2" * 64,
                ),
                usage=GenerationUsage(
                    input_tokens=64,
                    output_tokens=24,
                    total_tokens=88,
                    reasoning_tokens=0,
                ),
                diagnostics=(),
                accepted_at=_accepted_at(),
                sdk_version=_SDK_VERSION,
                runtime_version=_RUNTIME_VERSION,
            ),
        )
        frames = tuple(
            GenerationFrame(
                request_id=command.request_id,
                sequence=sequence,
                event=event,
            )
            for sequence, event in enumerate(events)
        )
        payload = b"".join(frame.model_dump_json().encode("utf-8") + b"\n" for frame in frames)
        self._send_bytes(HTTPStatus.OK, payload, "application/x-ndjson")

    def _serve_control(
        self,
        headers: dict[str, str],
        body: bytes,
        request_id: str,
    ) -> None:
        try:
            UUID(request_id)
        except ValueError as error:
            raise RequestRejected(HTTPStatus.BAD_REQUEST, "invalid_request_id") from error
        if body or headers.get("content-length") != "0":
            raise RequestRejected(HTTPStatus.BAD_REQUEST, "invalid_control_request")
        self.peer.cancel(UUID(request_id))
        self._send_bytes(HTTPStatus.NO_CONTENT, b"", "application/json")

    def _send_json(self, status: HTTPStatus, payload: object) -> None:
        self._send_bytes(
            status,
            json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8"),
            "application/json",
        )

    def _send_bytes(self, status: HTTPStatus, body: bytes, content_type: str) -> None:
        self.wfile.write(
            f"HTTP/1.1 {status.value} {status.phrase}\r\n".encode("ascii")
            + f"Content-Type: {content_type}\r\n".encode("ascii")
            + f"Content-Length: {len(body)}\r\n".encode("ascii")
            + b"Connection: close\r\n\r\n"
            + body
        )
        self.wfile.flush()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--socket", required=True, type=Path)
    parser.add_argument("--audit", required=True, type=Path)
    arguments = parser.parse_args()
    socket_path = arguments.socket
    audit = arguments.audit.resolve(strict=True)
    if socket_path.is_symlink() or socket_path.exists():
        raise RuntimeError("Codex generation peer socket must be absent before startup")
    state = socket_path.parent.resolve(strict=True)
    if socket_path.parent != state or audit.parent != state or not audit.is_file():
        raise RuntimeError("Codex generation peer requires its exact state files")
    server = CodexGenerationPeerServer(socket_path, audit)
    try:
        server.serve_forever(poll_interval=0.01)
    finally:
        server.server_close()
        if socket_path.is_symlink() or not socket_path.is_socket():
            raise RuntimeError("Codex generation peer socket changed identity during shutdown")
        socket_path.unlink()


if __name__ == "__main__":
    main()
