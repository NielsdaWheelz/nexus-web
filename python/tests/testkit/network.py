"""Exact local-socket boundary shared by pytest and spawned Python proof."""

import json
import os
import socket
import ssl
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

_ALLOWED_HOSTS = frozenset({"127.0.0.1", "::1", "127.0.1.1"})
_SYSTEM_GETADDRINFO = socket.getaddrinfo


@dataclass(frozen=True, slots=True)
class _LoopbackRoute:
    address: str
    port: int


def _static_dns() -> dict[str, str | _LoopbackRoute]:
    raw = os.environ.get("NEXUS_TEST_STATIC_DNS", "{}")
    try:
        value = json.loads(raw)
    except json.JSONDecodeError as error:
        raise PermissionError("test process received invalid static DNS JSON") from error
    if not isinstance(value, dict):
        raise PermissionError("test process received an invalid static DNS mapping")
    routes: dict[str, str | _LoopbackRoute] = {}
    for host, target in value.items():
        if not isinstance(host, str) or not host:
            raise PermissionError("test process received an invalid static DNS mapping")
        if isinstance(target, str) and target == "93.184.216.34":
            routes[host] = target
            continue
        if (
            isinstance(target, dict)
            and set(target) == {"address", "port"}
            and target["address"] == "127.0.0.1"
            and isinstance(target["port"], int)
            and not isinstance(target["port"], bool)
            and 1 <= target["port"] <= 65_535
        ):
            routes[host] = _LoopbackRoute(target["address"], target["port"])
            continue
        raise PermissionError("test process received an invalid static DNS mapping")
    return routes


def _require_local(address: Any) -> None:
    if isinstance(address, (str, bytes)):
        return  # Unix-domain socket path.
    if not isinstance(address, tuple) or not address:
        raise PermissionError(f"test process rejected socket address: {address!r}")
    host = address[0]
    if isinstance(host, bytes):
        host = host.decode("ascii")
    if not isinstance(host, str) or host not in _ALLOWED_HOSTS:
        raise PermissionError(f"test process denied external socket host: {host!r}")


def _rewrite_loopback_route(
    address: Any,
    static_dns: dict[str, str | _LoopbackRoute],
) -> Any:
    if not isinstance(address, tuple) or len(address) < 2 or address[1] != 443:
        return address
    host = address[0].decode("ascii") if isinstance(address[0], bytes) else address[0]
    routes = {
        target.port
        for target in static_dns.values()
        if isinstance(target, _LoopbackRoute) and target.address == host
    }
    if len(routes) > 1:
        raise PermissionError("test process received ambiguous loopback routes")
    if not routes:
        return address
    return (host, routes.pop(), *address[2:])


def install_network_guard() -> Callable[[], None]:
    """Allow only exact local TCP/UDP hosts and Unix-domain sockets."""
    original_connect = socket.socket.connect
    original_connect_ex = socket.socket.connect_ex
    original_sendto = socket.socket.sendto
    original_sendmsg = socket.socket.sendmsg
    original_getaddrinfo = socket.getaddrinfo
    original_gethostbyname = socket.gethostbyname
    static_dns = _static_dns()

    def connect(self: socket.socket, address: Any) -> None:
        address = _rewrite_loopback_route(address, static_dns)
        _require_local(address)
        original_connect(self, address)

    def connect_ex(self: socket.socket, address: Any) -> int:
        address = _rewrite_loopback_route(address, static_dns)
        _require_local(address)
        return original_connect_ex(self, address)

    def sendto(self: socket.socket, data: Any, *args: Any) -> int:
        address = _rewrite_loopback_route(args[-1], static_dns)
        _require_local(address)
        return original_sendto(self, data, *args[:-1], address)

    def sendmsg(self: socket.socket, buffers: Any, *args: Any) -> int:
        if args:
            address = args[-1]
            if isinstance(address, (str, bytes, tuple)):
                address = _rewrite_loopback_route(address, static_dns)
                _require_local(address)
                args = (*args[:-1], address)
        return original_sendmsg(self, buffers, *args)

    def getaddrinfo(
        host: str | bytes | None,
        port: str | int | None,
        *args: Any,
        **kwargs: Any,
    ) -> list[Any]:
        normalized = host.decode("ascii") if isinstance(host, bytes) else host
        if normalized in static_dns:
            target = static_dns[normalized]
            if isinstance(target, _LoopbackRoute):
                return original_getaddrinfo(target.address, target.port, *args, **kwargs)
            return _SYSTEM_GETADDRINFO(target, port, *args, **kwargs)
        if normalized is not None:
            _require_local((normalized, 0))
        return original_getaddrinfo(host, port, *args, **kwargs)

    def gethostbyname(host: str) -> str:
        if host in static_dns:
            target = static_dns[host]
            return target.address if isinstance(target, _LoopbackRoute) else target
        _require_local((host, 0))
        return original_gethostbyname(host)

    socket.socket.connect = connect
    socket.socket.connect_ex = connect_ex
    socket.socket.sendto = sendto
    socket.socket.sendmsg = sendmsg
    socket.getaddrinfo = getaddrinfo
    socket.gethostbyname = gethostbyname

    def restore() -> None:
        socket.socket.connect = original_connect
        socket.socket.connect_ex = original_connect_ex
        socket.socket.sendto = original_sendto
        socket.socket.sendmsg = original_sendmsg
        socket.getaddrinfo = original_getaddrinfo
        socket.gethostbyname = original_gethostbyname

    return restore


def install_test_tls_ca() -> Callable[[], None]:
    """Trust one test-owned CA without weakening a production HTTP client."""
    raw_certificate = os.environ.get("NEXUS_TEST_TLS_CA_CERT")
    if raw_certificate is None:
        return lambda: None
    certificate = Path(raw_certificate).resolve(strict=True)
    original_create_default_context = ssl.create_default_context

    def create_default_context(
        purpose: ssl.Purpose = ssl.Purpose.SERVER_AUTH,
        *,
        cafile: str | None = None,
        capath: str | None = None,
        cadata: str | bytes | None = None,
    ) -> ssl.SSLContext:
        context = original_create_default_context(
            purpose,
            cafile=cafile,
            capath=capath,
            cadata=cadata,
        )
        context.load_verify_locations(cafile=certificate)
        return context

    ssl.create_default_context = create_default_context

    def restore() -> None:
        ssl.create_default_context = original_create_default_context

    return restore
