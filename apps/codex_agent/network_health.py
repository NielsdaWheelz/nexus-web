"""Behavioral proof of the credential host's exact network contract."""

from __future__ import annotations

import errno
import http.client
import ipaddress
import socket
import ssl
import sys
from dataclasses import dataclass
from urllib.parse import urlsplit

_CONNECT_TIMEOUT_SECONDS = 1.0
_MCP_TIMEOUT_SECONDS = 8.0
_MCP_PATH = "/internal/agent-tools/mcp"
_UNREACHABLE_ERRORS = frozenset(
    {errno.EAGAIN, errno.ENETUNREACH, errno.EHOSTUNREACH, errno.ETIMEDOUT}
)


class _McpProofFailure(RuntimeError):
    def __init__(self, stage: str, cause: Exception) -> None:
        super().__init__(f"{stage}: {type(cause).__name__}")


@dataclass(frozen=True, slots=True)
class DeniedTarget:
    address: ipaddress.IPv4Address
    port: int

    @classmethod
    def parse(cls, value: str) -> DeniedTarget:
        raw_address, separator, raw_port = value.rpartition(":")
        if not separator or not raw_port.isdigit():
            raise ValueError("denied network target must be IPv4:port")
        address = ipaddress.IPv4Address(raw_address)
        port = int(raw_port)
        if not 1 <= port <= 65_535:
            raise ValueError("denied network target port is outside range")
        return cls(address=address, port=port)


def prove_unreachable(targets: tuple[DeniedTarget, ...]) -> None:
    if not targets:
        raise ValueError("at least one denied network target is required")
    for target in targets:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as connection:
            connection.settimeout(_CONNECT_TIMEOUT_SECONDS)
            result = connection.connect_ex((str(target.address), target.port))
        if result not in _UNREACHABLE_ERRORS:
            raise RuntimeError("Codex host has a route to a denied network target")


def prove_mcp_auth_boundary(origin: str) -> None:
    """Prove DNS, SNI relay, TLS, Caddy routing, and auth-first MCP together."""

    parsed = urlsplit(origin)
    if (
        parsed.scheme != "https"
        or parsed.hostname is None
        or parsed.hostname != parsed.hostname.lower()
        or parsed.port not in (None, 443)
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path != _MCP_PATH
        or parsed.query
        or parsed.fragment
    ):
        raise ValueError("MCP origin is outside the exact HTTPS contract")
    connection = http.client.HTTPSConnection(
        parsed.hostname,
        443,
        timeout=_MCP_TIMEOUT_SECONDS,
        context=ssl.create_default_context(),
    )
    stage = "connect-tls"
    try:
        connection.connect()
        stage = "request"
        connection.request(
            "POST",
            _MCP_PATH,
            body=b"",
            headers={"Accept": "application/json"},
        )
        stage = "response-headers"
        response = connection.getresponse()
        stage = "response-contract"
        if (
            response.status != 401
            or response.getheader("Location") is not None
            or response.getheader("Set-Cookie") is not None
        ):
            raise RuntimeError("MCP egress path differs from the auth-first contract")
        stage = "response-body"
        if response.read(1) != b"":
            stage = "response-contract"
            raise RuntimeError("MCP authentication rejection must have no body")
    except (OSError, RuntimeError, ValueError, http.client.HTTPException) as error:
        if isinstance(error, socket.gaierror):
            stage = "dns"
        raise _McpProofFailure(stage, error) from None
    finally:
        connection.close()


def main() -> None:
    stage = "arguments"
    try:
        if len(sys.argv) >= 3 and sys.argv[1] == "--denied-targets":
            stage = "denied-targets"
            prove_unreachable(tuple(DeniedTarget.parse(value) for value in sys.argv[2:]))
        elif len(sys.argv) == 3 and sys.argv[1] == "--mcp-origin":
            stage = "mcp-origin"
            prove_mcp_auth_boundary(sys.argv[2])
        else:
            raise ValueError("network proof requires exactly one supported proof mode")
    except (OSError, RuntimeError, ValueError, http.client.HTTPException) as error:
        detail = (
            str(error)
            if isinstance(error, _McpProofFailure)
            else f"{stage}: {type(error).__name__}"
        )
        print(f"Codex network proof {detail}", file=sys.stderr)
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
