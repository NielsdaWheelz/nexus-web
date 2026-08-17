"""Bounded HTTP-over-UDS client for the private native-agent host."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from pathlib import Path

import httpx
from pydantic import ValidationError

from nexus.services.native_agent_contract import (
    NativeAgentCapacityRejection,
    NativeAgentCommand,
    NativeAgentFrame,
    NativeAgentHealth,
    NativeAgentPermissionRequest,
    NativeAgentTerminal,
    NativeAgentToolUse,
)
from nexus.services.native_agent_operations import (
    METADATA_ENRICHMENT_TRANSPORT_DEADLINE_SECONDS,
)

_HOST_AUTHORITY = "http://nexus-codex"
_MAX_FRAME_BYTES = 256 * 1024
_MAX_STREAM_BYTES = 1024 * 1024
_MAX_HEALTH_BYTES = 4 * 1024
_MAX_FRAMES = 1_024
_REQUEST_DEADLINE_SECONDS = METADATA_ENRICHMENT_TRANSPORT_DEADLINE_SECONDS
_HEALTH_DEADLINE_SECONDS = 5.0


class NativeAgentClientError(RuntimeError):
    """Base for private native-agent transport failures."""


class NativeAgentUnavailable(NativeAgentClientError):
    """The host did not establish an accepted request."""


class NativeAgentCapacityUnavailable(NativeAgentClientError):
    """The host safely refused the request before acceptance for capacity."""


class NativeAgentTransportAmbiguous(NativeAgentClientError):
    """Transport was lost after the host accepted the turn request."""


class NativeAgentRequestRejected(NativeAgentClientError):
    """The host rejected the command before accepting a turn."""


# justify-defect: only a host or transport defect can break the closed private contract,
# so every violation of it is an internal defect rather than a modeled turn outcome.
class NativeAgentProtocolDefect(AssertionError):
    """The private host violated its closed ordered stream contract."""


@dataclass(frozen=True, slots=True)
class NativeAgentTurnObservation:
    terminal: NativeAgentTerminal
    tool_event_count: int
    permission_event_count: int


class CodexAgentClient:
    def __init__(self, socket_path: Path) -> None:
        self._socket_path = socket_path

    async def health(self) -> NativeAgentHealth:
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
                            raise NativeAgentRequestRejected(
                                "native agent host answered health with "
                                f"HTTP {response.status_code}"
                            )
                        payload = await self._read_bounded_body(response, _MAX_HEALTH_BYTES)
        except TimeoutError as error:
            raise NativeAgentUnavailable("native agent health deadline expired") from error
        except httpx.HTTPError as error:
            raise NativeAgentUnavailable("native agent host is unavailable") from error
        try:
            return NativeAgentHealth.model_validate_json(payload)
        except ValidationError as error:
            raise NativeAgentProtocolDefect(
                "native agent host returned an invalid health identity"
            ) from error

    async def turn(self, command: NativeAgentCommand) -> NativeAgentTerminal:
        return (await self.observe_turn(command)).terminal

    async def observe_turn(self, command: NativeAgentCommand) -> NativeAgentTurnObservation:
        accepted = False
        transport = httpx.AsyncHTTPTransport(uds=str(self._socket_path))
        try:
            async with asyncio.timeout(_REQUEST_DEADLINE_SECONDS):
                async with httpx.AsyncClient(transport=transport, timeout=None) as client:
                    async with client.stream(
                        "POST",
                        f"{_HOST_AUTHORITY}/v1/turns",
                        headers={
                            "accept": "application/x-ndjson",
                            "content-type": "application/json",
                        },
                        content=command.model_dump_json(),
                    ) as response:
                        if response.status_code != 200:
                            if await self._is_capacity_rejection(response):
                                raise NativeAgentCapacityUnavailable(
                                    "native agent capacity is unavailable before request acceptance"
                                )
                            raise NativeAgentRequestRejected(
                                "native agent host rejected command with "
                                f"HTTP {response.status_code}"
                            )
                        accepted = True
                        content_type = response.headers.get("content-type", "")
                        if content_type.split(";", 1)[0].strip().lower() != "application/x-ndjson":
                            raise NativeAgentProtocolDefect(
                                "native agent host returned an unexpected content type"
                            )
                        return await self._read_observation(response, command)
        except (NativeAgentClientError, NativeAgentProtocolDefect):
            raise
        except TimeoutError as error:
            if accepted:
                raise NativeAgentTransportAmbiguous(
                    "native agent request deadline expired after request acceptance"
                ) from error
            raise NativeAgentUnavailable(
                "native agent request deadline expired before request acceptance"
            ) from error
        except httpx.HTTPError as error:
            if accepted:
                raise NativeAgentTransportAmbiguous(
                    "native agent transport was lost after request acceptance"
                ) from error
            raise NativeAgentUnavailable("native agent host is unavailable") from error

    async def _read_observation(
        self,
        response: httpx.Response,
        command: NativeAgentCommand,
    ) -> NativeAgentTurnObservation:
        expected_sequence = 0
        total_bytes = 0
        terminal: NativeAgentTerminal | None = None
        forbidden_capability_seen = False
        tool_event_count = 0
        permission_event_count = 0
        buffer = bytearray()

        async for chunk in response.aiter_bytes():
            total_bytes += len(chunk)
            if total_bytes > _MAX_STREAM_BYTES:
                raise NativeAgentProtocolDefect("native agent stream exceeded its byte bound")
            buffer.extend(chunk)
            if len(buffer) > _MAX_FRAME_BYTES and b"\n" not in buffer:
                raise NativeAgentProtocolDefect("native agent frame exceeded its byte bound")
            while True:
                delimiter = buffer.find(b"\n")
                if delimiter < 0:
                    break
                raw = bytes(buffer[:delimiter])
                del buffer[: delimiter + 1]
                if not raw:
                    raise NativeAgentProtocolDefect("native agent stream contained a blank frame")
                if len(raw) > _MAX_FRAME_BYTES:
                    raise NativeAgentProtocolDefect("native agent frame exceeded its byte bound")
                frame = self._parse_frame(raw)
                if terminal is not None:
                    raise NativeAgentProtocolDefect(
                        "native agent stream emitted a frame after terminal"
                    )
                if frame.request_id != command.request_id:
                    raise NativeAgentProtocolDefect("native agent frame request_id mismatched")
                if frame.sequence != expected_sequence:
                    raise NativeAgentProtocolDefect(
                        "native agent frame sequence was not contiguous"
                    )
                expected_sequence += 1
                if expected_sequence > _MAX_FRAMES:
                    raise NativeAgentProtocolDefect("native agent stream exceeded its frame bound")
                if isinstance(frame.event, NativeAgentToolUse):
                    tool_event_count += 1
                    forbidden_capability_seen = True
                if isinstance(frame.event, NativeAgentPermissionRequest):
                    permission_event_count += 1
                    forbidden_capability_seen = True
                if isinstance(frame.event, NativeAgentTerminal):
                    terminal = frame.event

        if buffer:
            raise NativeAgentProtocolDefect("native agent stream ended with an incomplete frame")
        if terminal is None:
            raise NativeAgentProtocolDefect("native agent stream ended without terminal")
        if forbidden_capability_seen and (
            terminal.status != "failed"
            or terminal.failure is None
            or terminal.failure.kind != "policy_violation"
        ):
            raise NativeAgentProtocolDefect(
                "metadata stream observed forbidden capability without policy failure"
            )
        return NativeAgentTurnObservation(
            terminal=terminal,
            tool_event_count=tool_event_count,
            permission_event_count=permission_event_count,
        )

    @staticmethod
    async def _is_capacity_rejection(response: httpx.Response) -> bool:
        if (
            response.status_code != 503
            or response.headers.get("content-type") != "application/json"
        ):
            return False
        maximum_bytes = 256
        payload = bytearray()
        async for chunk in response.aiter_bytes():
            payload.extend(chunk)
            if len(payload) > maximum_bytes:
                return False
        try:
            observed = NativeAgentCapacityRejection.model_validate_json(payload)
        except ValidationError:
            # justify-ignore-error: capacity refusal is recognized only on an exact body,
            # and every other non-200 body is reported as a rejected command instead.
            return False
        return observed == NativeAgentCapacityRejection()

    @staticmethod
    async def _read_bounded_body(response: httpx.Response, maximum_bytes: int) -> bytes:
        payload = bytearray()
        async for chunk in response.aiter_bytes():
            payload.extend(chunk)
            if len(payload) > maximum_bytes:
                raise NativeAgentProtocolDefect("native agent response exceeded its byte bound")
        return bytes(payload)

    @staticmethod
    def _parse_frame(raw: bytes) -> NativeAgentFrame:
        try:
            return NativeAgentFrame.model_validate_json(raw)
        except ValidationError as error:
            raise NativeAgentProtocolDefect(
                "native agent stream contained an invalid frame"
            ) from error


__all__ = [
    "CodexAgentClient",
    "NativeAgentCapacityUnavailable",
    "NativeAgentClientError",
    "NativeAgentProtocolDefect",
    "NativeAgentRequestRejected",
    "NativeAgentTransportAmbiguous",
    "NativeAgentTurnObservation",
    "NativeAgentUnavailable",
]
