"""Behavioral proof that the credential host has no route to the data plane."""

from __future__ import annotations

import errno
import ipaddress
import socket
import sys
from dataclasses import dataclass

_CONNECT_TIMEOUT_SECONDS = 1.0
_UNREACHABLE_ERRORS = frozenset(
    {errno.EAGAIN, errno.ENETUNREACH, errno.EHOSTUNREACH, errno.ETIMEDOUT}
)


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


def main() -> None:
    stage = "arguments"
    try:
        if len(sys.argv) < 3 or sys.argv[1] != "--denied-targets":
            raise ValueError("network proof requires --denied-targets and at least one target")
        stage = "denied-targets"
        prove_unreachable(tuple(DeniedTarget.parse(value) for value in sys.argv[2:]))
    except (OSError, RuntimeError, ValueError) as error:
        print(f"Codex network proof {stage}: {type(error).__name__}", file=sys.stderr)
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
