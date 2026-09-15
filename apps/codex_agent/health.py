"""Low-memory, fail-closed health probe for the private Codex agent host."""

from __future__ import annotations

import json
import socket
from pathlib import Path
from typing import Final

from apps.codex_agent.health_contract import expected_health_identity
from apps.codex_agent.path_environment import required_absolute_path

_SOCKET_ENV: Final = "NEXUS_CODEX_AGENT_SOCKET"
_MAX_RESPONSE_BYTES: Final = 8 * 1024
_MAX_HEADER_BYTES: Final = 4 * 1024
_MAX_BODY_BYTES: Final = 4 * 1024
_DEADLINE_SECONDS: Final = 3.0
_REQUEST: Final = (
    b"GET /health HTTP/1.1\r\n"
    b"Host: nexus-codex\r\n"
    b"Accept: application/json\r\n"
    b"Connection: close\r\n"
    b"\r\n"
)
_EXPECTED_HEALTH: Final = expected_health_identity()


def _unique_json_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
    value: dict[str, object] = {}
    for name, member in pairs:
        if name in value:
            raise ValueError("duplicate JSON member")
        value[name] = member
    return value


def check(socket_path: Path | None = None) -> dict[str, str]:
    """Read and validate the complete bounded health response over its UDS."""

    path = socket_path if socket_path is not None else required_absolute_path(_SOCKET_ENV)
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as stream:
            stream.settimeout(_DEADLINE_SECONDS)
            stream.connect(str(path))
            stream.sendall(_REQUEST)
            response = bytearray()
            while True:
                chunk = stream.recv(4096)
                if not chunk:
                    break
                response.extend(chunk)
                if len(response) > _MAX_RESPONSE_BYTES:
                    raise RuntimeError("Codex generation health response exceeds its bound")
    except OSError as error:
        raise RuntimeError("Codex generation health socket is unavailable") from error
    return _parse_health_response(bytes(response))


def _parse_health_response(response: bytes) -> dict[str, str]:
    header_block, separator, body = response.partition(b"\r\n\r\n")
    if not separator or len(header_block) > _MAX_HEADER_BYTES or len(body) > _MAX_BODY_BYTES:
        raise RuntimeError("Codex generation health HTTP envelope is malformed")
    try:
        lines = header_block.decode("ascii").split("\r\n")
    except UnicodeDecodeError as error:
        raise RuntimeError("Codex generation health headers are not ASCII") from error
    if not lines or lines[0] != "HTTP/1.1 200 OK":
        raise RuntimeError("Codex generation health did not return exact HTTP 200")

    headers: dict[str, str] = {}
    for line in lines[1:]:
        name, delimiter, value = line.partition(":")
        canonical_name = name.lower()
        if (
            not delimiter
            or not canonical_name
            or any(not (character.isalnum() or character == "-") for character in canonical_name)
            or canonical_name in headers
            or any(character != "\t" and not " " <= character <= "~" for character in value)
        ):
            raise RuntimeError("Codex generation health headers are malformed")
        headers[canonical_name] = value.strip()
    if headers.get("content-type") != "application/json" or "transfer-encoding" in headers:
        raise RuntimeError("Codex generation health content framing differs")
    content_length = headers.get("content-length", "")
    if (
        not content_length.isascii()
        or not content_length.isdecimal()
        or int(content_length) != len(body)
    ):
        raise RuntimeError("Codex generation health content length differs")

    try:
        payload: object = json.loads(
            body.decode("utf-8"),
            object_pairs_hook=_unique_json_object,
        )
    except (UnicodeDecodeError, ValueError) as error:
        raise RuntimeError("Codex generation health body is malformed") from error
    if payload != _EXPECTED_HEALTH:
        raise RuntimeError("Codex generation health identity differs")
    return dict(_EXPECTED_HEALTH)


def main() -> None:
    print(json.dumps(check(), sort_keys=True, separators=(",", ":")))


if __name__ == "__main__":
    main()
