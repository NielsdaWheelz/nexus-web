"""Bounded HTTP-over-UDS client for the private Codex generation host."""

from __future__ import annotations

import asyncio
import hashlib
import importlib.metadata
import json
from collections.abc import AsyncIterator, Awaitable, Callable
from pathlib import Path
from uuid import UUID

import httpx
from pydantic import ValidationError

from nexus.services import generation_policy
from nexus.services.codex_generation_contract import (
    MAX_ADMISSION_BODY_BYTES,
    ChatOperation,
    GenerationAdmission,
    GenerationCommand,
    GenerationFrame,
    GenerationHealth,
    GenerationPermissionRequest,
    GenerationTerminal,
    GenerationToolUse,
    capacity_rejection_bytes,
    command_policy,
    generation_admission_request,
    request_fingerprint,
)
from nexus.services.codex_generation_operations import (
    CHAT_MCP_SERVER_NAME,
    chat_mcp_allowed_tools,
)

_HOST_AUTHORITY = "http://nexus-codex"
_MAX_HEALTH_BYTES = 4 * 1024
_MAX_REJECTION_BYTES = 256
_MAX_ADMISSION_RESPONSE_BYTES = MAX_ADMISSION_BODY_BYTES
_HEALTH_DEADLINE_SECONDS = 5.0
_CONTROL_DEADLINE_SECONDS = 5.0
_SDK_VERSION = importlib.metadata.version("openai-codex")
_RUNTIME_VERSION = importlib.metadata.version("openai-codex-cli-bin")


class CodexGenerationClientError(RuntimeError):
    """Base for private generation transport failures."""


class CodexGenerationUnavailable(CodexGenerationClientError):
    """The host was unavailable before accepting a generation."""


class CodexGenerationCapacityUnavailable(CodexGenerationClientError):
    """The host safely refused a generation before acceptance for capacity."""


class CodexGenerationTransportAmbiguous(CodexGenerationClientError):
    """The response stream was lost after generation acceptance."""


class CodexGenerationRequestRejected(CodexGenerationClientError):
    """The private host rejected a request without accepting a generation."""


class CodexGenerationProtocolDefect(AssertionError):
    """The host violated the closed private generation protocol."""


class CodexGenerationClient:
    def __init__(self, socket_path: Path) -> None:
        self._socket_path = socket_path

    async def health(self) -> GenerationHealth:
        transport = httpx.AsyncHTTPTransport(uds=str(self._socket_path))
        try:
            async with asyncio.timeout(_HEALTH_DEADLINE_SECONDS):
                async with httpx.AsyncClient(transport=transport, timeout=None) as client:
                    async with client.stream(
                        "GET",
                        f"{_HOST_AUTHORITY}/health",
                        headers={"accept": "application/json"},
                    ) as response:
                        if response.status_code != 200:
                            raise CodexGenerationRequestRejected(
                                f"Codex generation health returned HTTP {response.status_code}"
                            )
                        if _content_type(response) != "application/json":
                            raise CodexGenerationProtocolDefect(
                                "Codex generation health content type drifted"
                            )
                        payload = await _read_bounded(response, _MAX_HEALTH_BYTES)
        except (CodexGenerationClientError, CodexGenerationProtocolDefect):
            raise
        except TimeoutError as error:
            raise CodexGenerationUnavailable("Codex generation health deadline expired") from error
        except httpx.HTTPError as error:
            raise CodexGenerationUnavailable("Codex generation host is unavailable") from error
        try:
            observed = GenerationHealth.model_validate_json(payload)
        except ValidationError as error:
            raise CodexGenerationProtocolDefect(
                "Codex generation health identity is invalid"
            ) from error
        expected = GenerationHealth(
            policy_revision=generation_policy.POLICY_REVISION,
            sdk_version=_SDK_VERSION,
            runtime_version=_RUNTIME_VERSION,
        )
        if observed != expected:
            raise CodexGenerationProtocolDefect(
                "Codex generation health policy or runtime identity drifted"
            )
        return observed

    async def stream(
        self,
        command: GenerationCommand,
        *,
        bind_admission: Callable[[GenerationAdmission], Awaitable[GenerationCommand]] | None = None,
    ) -> AsyncIterator[GenerationFrame]:
        """Preflight identity, dispatch once, and yield validated frames incrementally."""

        is_chat = isinstance(command.operation, ChatOperation)
        if is_chat != (bind_admission is not None):
            raise ValueError("ChatTools alone requires an admission-bound command factory")
        await self.health()
        accepted = False
        policy = command_policy(command)
        transport = httpx.AsyncHTTPTransport(uds=str(self._socket_path))
        try:
            async with asyncio.timeout(float(policy.transport_deadline_seconds)):
                async with httpx.AsyncClient(transport=transport, timeout=None) as client:
                    admission: GenerationAdmission | None = None
                    dispatched_command = command
                    if bind_admission is not None:
                        # The reservation POST is not idempotently observable if its
                        # response is lost. Only the exact 503 body below proves that
                        # the host accepted nothing; transport loss is ambiguous.
                        accepted = True
                        admission = await self._admit(client, command)
                        try:
                            dispatched_command = await bind_admission(admission)
                            if request_fingerprint(dispatched_command) != request_fingerprint(
                                command
                            ) or generation_admission_request(
                                dispatched_command
                            ) != generation_admission_request(command):
                                raise CodexGenerationProtocolDefect(
                                    "admission-bound generation command changed durable identity"
                                )
                        except BaseException:
                            await self._cancel_reserved_admission(client, command.request_id)
                            raise
                    async with client.stream(
                        "POST",
                        f"{_HOST_AUTHORITY}/v2/generations",
                        headers={
                            "accept": "application/x-ndjson",
                            "content-type": "application/json",
                            **(
                                {"nexus-generation-admission": str(admission.admission_id)}
                                if admission is not None
                                else {}
                            ),
                        },
                        content=_wire_command(dispatched_command),
                    ) as response:
                        if response.status_code != 200:
                            capacity_rejection = await _is_capacity_rejection(response)
                            if admission is not None:
                                raise CodexGenerationTransportAmbiguous(
                                    "Codex generation command was rejected after admission"
                                )
                            if capacity_rejection:
                                raise CodexGenerationCapacityUnavailable(
                                    "Codex generation capacity is unavailable before acceptance"
                                )
                            raise CodexGenerationRequestRejected(
                                f"Codex generation command returned HTTP {response.status_code}"
                            )
                        accepted = True
                        if _content_type(response) != "application/x-ndjson":
                            raise CodexGenerationProtocolDefect(
                                "Codex generation stream content type drifted"
                            )
                        async for frame in _validated_frames(response, dispatched_command):
                            yield frame
        except (
            CodexGenerationClientError,
            CodexGenerationProtocolDefect,
        ):
            raise
        except TimeoutError as error:
            if accepted:
                raise CodexGenerationTransportAmbiguous(
                    "Codex generation deadline expired after acceptance"
                ) from error
            raise CodexGenerationUnavailable(
                "Codex generation deadline expired before acceptance"
            ) from error
        except httpx.HTTPError as error:
            if accepted:
                raise CodexGenerationTransportAmbiguous(
                    "Codex generation transport was lost after acceptance"
                ) from error
            raise CodexGenerationUnavailable("Codex generation host is unavailable") from error

    async def _admit(
        self,
        client: httpx.AsyncClient,
        command: GenerationCommand,
    ) -> GenerationAdmission:
        request = generation_admission_request(command)
        async with client.stream(
            "POST",
            f"{_HOST_AUTHORITY}/v2/generation-admissions",
            headers={"accept": "application/json", "content-type": "application/json"},
            content=request.model_dump_json().encode("utf-8"),
        ) as response:
            if response.status_code != 200:
                if await _is_capacity_rejection(response):
                    raise CodexGenerationCapacityUnavailable(
                        "Codex generation capacity is unavailable before acceptance"
                    )
                raise CodexGenerationRequestRejected(
                    f"Codex generation admission returned HTTP {response.status_code}"
                )
            if _content_type(response) != "application/json":
                raise CodexGenerationProtocolDefect(
                    "Codex generation admission content type drifted"
                )
            payload = await _read_bounded(response, _MAX_ADMISSION_RESPONSE_BYTES)
        try:
            admission = GenerationAdmission.model_validate_json(payload)
        except ValidationError as error:
            raise CodexGenerationProtocolDefect(
                "Codex generation admission response is invalid"
            ) from error
        if admission.request_id != command.request_id:
            raise CodexGenerationProtocolDefect(
                "Codex generation admission request identity drifted"
            )
        return admission

    async def _cancel_reserved_admission(
        self,
        client: httpx.AsyncClient,
        request_id: UUID,
    ) -> None:
        try:
            response = await client.post(
                f"{_HOST_AUTHORITY}/v2/generations/{request_id}/cancel",
                content=b"",
            )
        except httpx.HTTPError:
            return
        if response.status_code != 204 or response.content:
            raise CodexGenerationProtocolDefect(
                "Codex generation admission cancellation was not acknowledged"
            )

    async def cancel(self, request_id: UUID) -> None:
        await self._control(request_id, "cancel")

    async def policy_violation(self, request_id: UUID) -> None:
        await self._control(request_id, "policy-violation")

    async def _control(self, request_id: UUID, action: str) -> None:
        transport = httpx.AsyncHTTPTransport(uds=str(self._socket_path))
        try:
            async with asyncio.timeout(_CONTROL_DEADLINE_SECONDS):
                async with httpx.AsyncClient(transport=transport, timeout=None) as client:
                    response = await client.post(
                        f"{_HOST_AUTHORITY}/v2/generations/{request_id}/{action}",
                        content=b"",
                    )
        except TimeoutError as error:
            raise CodexGenerationUnavailable(
                f"Codex generation {action} deadline expired"
            ) from error
        except httpx.HTTPError as error:
            raise CodexGenerationUnavailable(
                f"Codex generation {action} endpoint is unavailable"
            ) from error
        if response.status_code != 204 or response.content:
            raise CodexGenerationRequestRejected(
                f"Codex generation {action} returned HTTP {response.status_code}"
            )


async def _validated_frames(
    response: httpx.Response,
    command: GenerationCommand,
) -> AsyncIterator[GenerationFrame]:
    validator = _GenerationFrameStreamValidator(command)
    async for chunk in response.aiter_bytes():
        for frame in validator.feed(chunk):
            yield frame
    yield validator.finish()


class _GenerationFrameStreamValidator:
    """One raw-byte validator shared by live transport and operator evidence."""

    def __init__(self, command: GenerationCommand) -> None:
        self._command = command
        self._stream = command_policy(command).stream
        self._expected_sequence = 0
        self._total_bytes = 0
        self._buffer = bytearray()
        self._terminal: GenerationFrame | None = None
        self._forbidden_capability_seen = False
        self._allowed_chat_tools = {
            f"{CHAT_MCP_SERVER_NAME}/{tool}" for tool in chat_mcp_allowed_tools()
        }

    def feed(self, chunk: bytes) -> tuple[GenerationFrame, ...]:
        self._total_bytes += len(chunk)
        if self._total_bytes > self._stream.max_stream_bytes:
            raise CodexGenerationProtocolDefect("Codex generation stream exceeded its byte bound")
        self._buffer.extend(chunk)
        if len(self._buffer) > self._stream.max_frame_bytes and b"\n" not in self._buffer:
            raise CodexGenerationProtocolDefect("Codex generation frame exceeded its byte bound")
        observed: list[GenerationFrame] = []
        while (delimiter := self._buffer.find(b"\n")) >= 0:
            raw = bytes(self._buffer[:delimiter])
            del self._buffer[: delimiter + 1]
            if not raw:
                raise CodexGenerationProtocolDefect(
                    "Codex generation stream contained a blank frame"
                )
            if len(raw) > self._stream.max_frame_bytes:
                raise CodexGenerationProtocolDefect(
                    "Codex generation frame exceeded its byte bound"
                )
            frame = _parse_frame(raw)
            if self._terminal is not None:
                raise CodexGenerationProtocolDefect(
                    "Codex generation emitted a frame after terminal"
                )
            if frame.sequence != self._expected_sequence:
                raise CodexGenerationProtocolDefect(
                    "Codex generation frame sequence was not contiguous"
                )
            self._expected_sequence += 1
            if self._expected_sequence > self._stream.max_frames:
                raise CodexGenerationProtocolDefect(
                    "Codex generation stream exceeded its frame bound"
                )

            event = frame.event
            if isinstance(event, GenerationTerminal):
                self._terminal = frame
                validate_generation_terminal_frame(
                    frame,
                    self._command,
                    forbidden_capability_seen=self._forbidden_capability_seen,
                )
                continue
            _validate_generation_frame_request(frame, self._command)
            if isinstance(event, GenerationToolUse):
                if (
                    command_policy(self._command).capability != "ChatTools"
                    or event.name not in self._allowed_chat_tools
                ):
                    self._forbidden_capability_seen = True
            elif isinstance(event, GenerationPermissionRequest):
                self._forbidden_capability_seen = True
            observed.append(frame)
        return tuple(observed)

    def finish(self) -> GenerationFrame:
        if self._buffer:
            raise CodexGenerationProtocolDefect(
                "Codex generation stream ended with an incomplete frame"
            )
        if self._terminal is None:
            if self._forbidden_capability_seen:
                raise CodexGenerationProtocolDefect(
                    "Codex generation observed forbidden capability without terminal"
                )
            raise CodexGenerationTransportAmbiguous(
                "Codex generation stream closed after acceptance without terminal"
            )
        return self._terminal


def validate_generation_terminal_frame(
    frame: GenerationFrame,
    command: GenerationCommand,
    *,
    forbidden_capability_seen: bool = False,
) -> GenerationTerminal:
    """Validate the terminal facts shared by live streaming and operator repair."""

    _validate_generation_frame_request(frame, command)
    terminal = frame.event
    if not isinstance(terminal, GenerationTerminal):
        raise CodexGenerationProtocolDefect("Codex generation attachment is not terminal")
    if terminal.sdk_version != _SDK_VERSION or terminal.runtime_version != _RUNTIME_VERSION:
        raise CodexGenerationProtocolDefect("Codex generation terminal runtime identity drifted")
    if forbidden_capability_seen and (
        terminal.status != "failed"
        or terminal.failure is None
        or terminal.failure.kind != "policy_violation"
    ):
        raise CodexGenerationProtocolDefect(
            "Codex generation observed forbidden capability without policy failure"
        )
    return terminal


def decode_reconciled_generation_terminal_evidence(
    *,
    raw_stream: bytes,
    raw_stream_sha256: str,
    command: GenerationCommand,
) -> GenerationTerminal:
    """Decode a raw transcript through the exact live frame-stream validator."""

    if len(raw_stream) > command_policy(command).stream.max_stream_bytes:
        raise CodexGenerationProtocolDefect(
            "Codex generation attachment exceeded its stream byte bound"
        )
    if hashlib.sha256(raw_stream).hexdigest() != raw_stream_sha256:
        raise CodexGenerationProtocolDefect(
            "Codex generation attachment digest does not match its raw evidence"
        )
    validator = _GenerationFrameStreamValidator(command)
    validator.feed(raw_stream)
    frame = validator.finish()
    terminal = frame.event
    if not isinstance(terminal, GenerationTerminal):
        raise AssertionError("validated generation transcript retained no terminal")
    return terminal


def _validate_generation_frame_request(
    frame: GenerationFrame,
    command: GenerationCommand,
) -> None:
    if frame.request_id != command.request_id:
        raise CodexGenerationProtocolDefect("Codex generation frame request_id mismatched")


def _parse_frame(raw: bytes) -> GenerationFrame:
    try:
        return GenerationFrame.model_validate_json(raw)
    except ValidationError as error:
        raise CodexGenerationProtocolDefect(
            "Codex generation host returned an invalid frame"
        ) from error


def _wire_command(command: GenerationCommand) -> bytes:
    payload = command.model_dump(mode="json", exclude_none=True)
    if command.tool_grant is not None:
        payload["tool_grant"] = {
            "kind": "Bearer",
            "token": command.tool_grant.token.get_secret_value(),
        }
    return json.dumps(
        payload,
        ensure_ascii=True,
        allow_nan=False,
        separators=(",", ":"),
    ).encode()


async def _is_capacity_rejection(response: httpx.Response) -> bool:
    if response.status_code != 503 or response.headers.get("content-type") != "application/json":
        return False
    payload = await _read_bounded(response, _MAX_REJECTION_BYTES)
    return payload == capacity_rejection_bytes()


async def _read_bounded(response: httpx.Response, maximum: int) -> bytes:
    payload = bytearray()
    async for chunk in response.aiter_bytes():
        payload.extend(chunk)
        if len(payload) > maximum:
            raise CodexGenerationProtocolDefect("Codex generation response exceeded its byte bound")
    return bytes(payload)


def _content_type(response: httpx.Response) -> str:
    return response.headers.get("content-type", "").split(";", 1)[0].strip().lower()


__all__ = [
    "CodexGenerationCapacityUnavailable",
    "CodexGenerationClient",
    "CodexGenerationClientError",
    "CodexGenerationProtocolDefect",
    "CodexGenerationRequestRejected",
    "CodexGenerationTransportAmbiguous",
    "CodexGenerationUnavailable",
    "validate_generation_terminal_frame",
    "decode_reconciled_generation_terminal_evidence",
]
