from __future__ import annotations

import asyncio
import http.client
import ipaddress
import socket
import ssl
import struct
from typing import ClassVar

import pytest
from apps.codex_agent import egress_policy, network_health


def _query(host: str, *, query_id: int = 0x1234) -> bytes:
    labels = b"".join(bytes((len(label),)) + label.encode("ascii") for label in host.split("."))
    return (
        struct.pack("!HHHHHH", query_id, 0x0100, 1, 0, 0, 0)
        + labels
        + b"\0"
        + struct.pack("!HH", 1, 1)
    )


def _client_hello(host: str) -> bytes:
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    context.check_hostname = False
    context.verify_mode = ssl.CERT_NONE
    incoming = ssl.MemoryBIO()
    outgoing = ssl.MemoryBIO()
    connection = context.wrap_bio(incoming, outgoing, server_side=False, server_hostname=host)
    with pytest.raises(ssl.SSLWantReadError):
        connection.do_handshake()
    return outgoing.read()


def test_codex_egress_allows_only_subscription_auth_and_mcp_sni(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    policy = egress_policy.EgressPolicy(
        ipaddress.IPv4Address("172.30.0.2"), "mcp.nexus.example.com"
    )

    allowed_dns = egress_policy.dns_response(_query("auth.openai.com"), policy)
    assert struct.unpack_from("!H", allowed_dns, 6)[0] == 1
    assert allowed_dns[-4:] == ipaddress.IPv4Address("172.30.0.2").packed
    denied_dns = egress_policy.dns_response(_query("api.anthropic.com"), policy)
    assert struct.unpack_from("!H", denied_dns, 6)[0] == 0, (
        "unapproved DNS names were resolved to the egress proxy"
    )
    assert struct.unpack_from("!H", denied_dns, 2)[0] & 0x0005 == 0x0005

    assert egress_policy.client_hello_sni(_client_hello("chatgpt.com")) == "chatgpt.com"
    assert (
        egress_policy.client_hello_sni(_client_hello("mcp.nexus.example.com"))
        == "mcp.nexus.example.com"
    )
    with pytest.raises(egress_policy.PolicyError):
        host = egress_policy.client_hello_sni(_client_hello("api.anthropic.com"))
        if not policy.admits(host):
            raise egress_policy.PolicyError("unapproved SNI")

    async def prove_multicast_is_never_a_public_connection() -> None:
        multicast = {
            "ipv4-multicast.example": (socket.AF_INET, "224.0.0.1"),
            "ipv6-multicast.example": (socket.AF_INET6, "ff02::1"),
        }
        connector_calls: list[tuple[str, int]] = []

        async def multicast_getaddrinfo(
            _loop: asyncio.BaseEventLoop,
            host: str,
            port: int,
            *args: object,
            **kwargs: object,
        ) -> list[tuple[object, ...]]:
            del args, kwargs
            family, address = multicast[host]
            return [(family, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", (address, port))]

        async def reject_multicast_connection(
            host: str,
            port: int,
            **_kwargs: object,
        ) -> tuple[asyncio.StreamReader, asyncio.StreamWriter]:
            connector_calls.append((host, port))
            raise AssertionError(f"multicast destination reached connector: {host}:{port}")

        monkeypatch.setattr(asyncio.BaseEventLoop, "getaddrinfo", multicast_getaddrinfo)
        monkeypatch.setattr(asyncio, "open_connection", reject_multicast_connection)
        for host in multicast:
            with pytest.raises(OSError, match="no reachable public address"):
                await egress_policy._public_connection(host)
        assert connector_calls == []

    asyncio.run(prove_multicast_is_never_a_public_connection())


def test_codex_network_health_proves_the_exact_allowed_mcp_boundary(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class Response:
        status = 401

        @staticmethod
        def read(amount: int) -> bytes:
            assert amount == 1
            return b""

        @staticmethod
        def getheader(name: str) -> None:
            assert name in {"Location", "Set-Cookie"}
            return None

    class Connection:
        observed: ClassVar[list[tuple[object, ...]]] = []

        def __init__(
            self,
            host: str,
            port: int,
            *,
            timeout: float,
            context: ssl.SSLContext,
        ) -> None:
            assert isinstance(context, ssl.SSLContext)
            self.observed.append(("connect", host, port, timeout))

        def request(
            self,
            method: str,
            path: str,
            *,
            body: bytes,
            headers: dict[str, str],
        ) -> None:
            self.observed.append(("request", method, path, body, headers))

        @staticmethod
        def getresponse() -> Response:
            return Response()

        def close(self) -> None:
            self.observed.append(("close",))

    monkeypatch.setattr(http.client, "HTTPSConnection", Connection)

    network_health.prove_mcp_auth_boundary("https://api.example.test/internal/agent-tools/mcp")

    assert Connection.observed == [
        ("connect", "api.example.test", 443, 8.0),
        (
            "request",
            "POST",
            "/internal/agent-tools/mcp",
            b"",
            {"Accept": "application/json"},
        ),
        ("close",),
    ]


def test_codex_tls_listener_relays_only_admitted_sni_to_public_addresses(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    policy = egress_policy.EgressPolicy(
        ipaddress.IPv4Address("172.30.0.2"), "mcp.nexus.example.com"
    )
    allowed_hello = _client_hello("mcp.nexus.example.com")
    denied_hello = _client_hello("api.anthropic.com")
    response = b"deterministic-upstream-response"
    original_open_connection = asyncio.open_connection
    original_getaddrinfo = asyncio.BaseEventLoop.getaddrinfo

    async def exercise() -> None:
        upstream_hellos: list[bytes] = []

        async def upstream(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
            try:
                upstream_hellos.append(await reader.readexactly(len(allowed_hello)))
                writer.write(response)
                await writer.drain()
            finally:
                writer.close()
                await writer.wait_closed()

        upstream_server = await asyncio.start_server(upstream, "127.0.0.1", 0)
        upstream_port = upstream_server.sockets[0].getsockname()[1]
        connector_calls: list[tuple[str, int]] = []

        async def deterministic_getaddrinfo(
            loop: asyncio.BaseEventLoop,
            host: str,
            port: int,
            *args: object,
            **kwargs: object,
        ) -> list[tuple[object, ...]]:
            del loop
            if host == "mcp.nexus.example.com":
                return [(2, 1, 6, "", ("93.184.216.34", port))]
            if host == "chatgpt.com":
                return [(2, 1, 6, "", ("127.0.0.1", 9))]
            return await original_getaddrinfo(
                asyncio.get_running_loop(), host, port, *args, **kwargs
            )

        monkeypatch.setattr(asyncio.BaseEventLoop, "getaddrinfo", deterministic_getaddrinfo)

        async def deterministic_connector(
            host: str, port: int, **kwargs: object
        ) -> tuple[asyncio.StreamReader, asyncio.StreamWriter]:
            if (host, port) != ("93.184.216.34", 443):
                raise AssertionError(f"non-global address was connected: {host}:{port}")
            connector_calls.append((host, port))
            return await original_open_connection("127.0.0.1", upstream_port, **kwargs)

        monkeypatch.setattr(asyncio, "open_connection", deterministic_connector)
        slots = asyncio.Semaphore(16)

        async def serve_client(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
            await egress_policy._serve_tls(reader, writer, policy, slots)

        tls_server = await asyncio.start_server(
            serve_client,
            "127.0.0.1",
            0,
        )
        tls_port = tls_server.sockets[0].getsockname()[1]
        try:
            allowed_reader, allowed_writer = await original_open_connection("127.0.0.1", tls_port)
            allowed_writer.write(allowed_hello)
            await allowed_writer.drain()
            try:
                relayed_response = await asyncio.wait_for(
                    allowed_reader.readexactly(len(response)), 2
                )
            except asyncio.IncompleteReadError as error:
                raise AssertionError(
                    f"connector={connector_calls!r}; upstream={upstream_hellos!r}"
                ) from error
            assert relayed_response == response
            allowed_writer.close()
            await allowed_writer.wait_closed()

            denied_reader, denied_writer = await original_open_connection("127.0.0.1", tls_port)
            denied_writer.write(denied_hello)
            await denied_writer.drain()
            assert await asyncio.wait_for(denied_reader.read(), 2) == b""
            denied_writer.close()
            await denied_writer.wait_closed()
        finally:
            tls_server.close()
            await tls_server.wait_closed()
            upstream_server.close()
            await upstream_server.wait_closed()

        assert connector_calls == [("93.184.216.34", 443)]
        assert upstream_hellos == [allowed_hello]

    asyncio.run(exercise())

    async def prove_non_global_resolution_is_refused() -> None:
        with pytest.raises(OSError, match="no reachable public address"):
            await egress_policy._public_connection("chatgpt.com")

    asyncio.run(prove_non_global_resolution_is_refused())
