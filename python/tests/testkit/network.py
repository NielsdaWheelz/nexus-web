"""Exact local-socket boundary shared by pytest and spawned Python proof."""

import socket
from collections.abc import Callable
from typing import Any

_ALLOWED_HOSTS = frozenset({"127.0.0.1", "::1", "127.0.1.1"})


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


def install_network_guard() -> Callable[[], None]:
    """Allow only exact local TCP/UDP hosts and Unix-domain sockets."""
    original_connect = socket.socket.connect
    original_connect_ex = socket.socket.connect_ex
    original_sendto = socket.socket.sendto
    original_sendmsg = socket.socket.sendmsg
    original_getaddrinfo = socket.getaddrinfo
    original_gethostbyname = socket.gethostbyname

    def connect(self: socket.socket, address: Any) -> None:
        _require_local(address)
        original_connect(self, address)

    def connect_ex(self: socket.socket, address: Any) -> int:
        _require_local(address)
        return original_connect_ex(self, address)

    def sendto(self: socket.socket, data: Any, *args: Any) -> int:
        _require_local(args[-1])
        return original_sendto(self, data, *args)

    def sendmsg(self: socket.socket, buffers: Any, *args: Any) -> int:
        if args:
            address = args[-1]
            if isinstance(address, (str, bytes, tuple)):
                _require_local(address)
        return original_sendmsg(self, buffers, *args)

    def getaddrinfo(host: str | bytes | None, *args: Any, **kwargs: Any) -> list[Any]:
        if host is not None:
            _require_local((host, 0))
        return original_getaddrinfo(host, *args, **kwargs)

    def gethostbyname(host: str) -> str:
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
