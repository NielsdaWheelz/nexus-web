"""Strict, deterministic Codex v2 UDS peer owned by the local test controller."""

from __future__ import annotations

import argparse
import importlib.metadata
import json
import re
import socketserver
import threading
from http import HTTPStatus
from pathlib import Path
from typing import BinaryIO
from uuid import UUID

from pydantic import ValidationError

from nexus.services import generation_policy
from nexus.services.codex_generation_contract import (
    MAX_COMMAND_BODY_BYTES,
    ChatOperation,
    GenerationCommand,
    GenerationFrame,
    GenerationHealth,
    GenerationSessionRef,
    GenerationTerminal,
    GenerationText,
    GenerationUsage,
    MediaSummaryOperation,
    MetadataEnrichmentOperation,
    request_fingerprint,
)

_HOST = "nexus-codex"
_MAX_REQUEST_LINE_BYTES = 4 * 1024
_MAX_HEADER_LINE_BYTES = 8 * 1024
_MAX_HEADER_BYTES = 32 * 1024
_MAX_HEADER_COUNT = 64
_ACCEPTED_AT = "2026-08-27T12:34:56.123456Z"
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


class RequestRejected(Exception):
    def __init__(self, status: HTTPStatus, code: str) -> None:
        self.status = status
        self.code = code
        super().__init__(code)


def deterministic_synthesis_output(command: GenerationCommand) -> dict[str, object]:
    """Return the exact tool-free synthesis needed by real-stack journeys."""

    if command.tool_grant is not None:
        raise RequestRejected(HTTPStatus.UNPROCESSABLE_ENTITY, "synthesis_tool_grant_forbidden")
    if isinstance(command.operation, MetadataEnrichmentOperation):
        return {
            "title": None,
            "authors": None,
            "publisher": None,
            "description": None,
            "published_date": None,
            "language": "en",
        }
    if isinstance(command.operation, MediaSummaryOperation):
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
        super().__init__(str(socket_path), CodexGenerationPeerHandler)

    def record_command(self, command: GenerationCommand) -> None:
        row = {
            "operation": command.operation.kind,
            "profile": (
                command.operation.profile if isinstance(command.operation, ChatOperation) else None
            ),
            "request_fingerprint": request_fingerprint(command),
            "request_id": str(command.request_id),
            "tool_grant_present": command.tool_grant is not None,
        }
        with self._audit_lock, self.audit.open("a", encoding="utf-8") as audit:
            audit.write(json.dumps(row, separators=(",", ":"), sort_keys=True) + "\n")


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
        if content_length > MAX_COMMAND_BODY_BYTES:
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
            policy_revision=generation_policy.POLICY_REVISION,
            sdk_version=_SDK_VERSION,
            runtime_version=_RUNTIME_VERSION,
        )
        self._send_bytes(
            HTTPStatus.OK,
            health.model_dump_json().encode("utf-8"),
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
        if isinstance(command.operation, ChatOperation):
            prompt = f"{command.intent.instructions}\n{command.intent.input}".casefold()
            if "sofia" not in prompt or "clavius crater" not in prompt:
                raise RequestRejected(HTTPStatus.UNPROCESSABLE_ENTITY, "unknown_chat_scenario")
            text = _GROUNDED_RESPONSE
            structured_output = None
        else:
            structured_output = deterministic_synthesis_output(command)
            text = json.dumps(structured_output, separators=(",", ":"), sort_keys=True)
        self.peer.record_command(command)
        events = (
            (GenerationText(text=text),) if isinstance(command.operation, ChatOperation) else ()
        ) + (
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
                accepted_at=_ACCEPTED_AT,
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
