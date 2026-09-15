"""DNS and TLS-SNI egress boundary for the private Codex host.

The host lives on an internal Docker network whose only peer is this process.
Approved names resolve to this process; its TLS listener verifies the original
SNI before opening a public connection.  The TLS stream remains end-to-end and
the policy process never sees plaintext or credentials.
"""

from __future__ import annotations

import asyncio
import ipaddress
import os
import re
import socket
import struct
import sys
from dataclasses import dataclass
from typing import Final

_PROXY_IP_ENV: Final = "NEXUS_CODEX_EGRESS_PROXY_IP"
_MCP_HOST_ENV: Final = "NEXUS_CODEX_EGRESS_MCP_HOST"
_DNS_PORT: Final = 53
_TLS_PORT: Final = 443
_MAX_DNS_QUERY_BYTES: Final = 4_096
_MAX_CLIENT_HELLO_BYTES: Final = 64 * 1_024
_CLIENT_HELLO_TIMEOUT_SECONDS: Final = 5.0
_CONNECT_TIMEOUT_SECONDS: Final = 10.0
_STREAM_IDLE_TIMEOUT_SECONDS: Final = 1_200.0
_MAX_CONNECTIONS: Final = 16
_DNS_TTL_SECONDS: Final = 30
_DNS_HEADER = struct.Struct("!HHHHHH")
_DNS_A_ANSWER = struct.Struct("!HHHLH")
_DNS_OPT = struct.Struct("!BHHIH")
_DNS_NAME = re.compile(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?")
_PRIVATE_PROXY_NETWORKS: Final[tuple[ipaddress.IPv4Network, ...]] = (
    ipaddress.IPv4Network("10.0.0.0/8"),
    ipaddress.IPv4Network("172.16.0.0/12"),
    ipaddress.IPv4Network("192.168.0.0/16"),
)


class PolicyError(ValueError):
    """A request is malformed or outside the exact egress policy."""


class _NeedMoreData(Exception):
    pass


@dataclass(frozen=True, slots=True)
class EgressPolicy:
    proxy_ip: ipaddress.IPv4Address
    mcp_host: str

    @classmethod
    def from_environment(cls) -> EgressPolicy:
        try:
            proxy_ip = ipaddress.IPv4Address(os.environ[_PROXY_IP_ENV])
            mcp_host = _canonical_host(os.environ[_MCP_HOST_ENV])
        except KeyError as error:
            raise RuntimeError(f"missing required environment variable {error.args[0]}") from error
        if not any(proxy_ip in network for network in _PRIVATE_PROXY_NETWORKS):
            raise RuntimeError(f"{_PROXY_IP_ENV} must be a private unicast IPv4 address")
        if mcp_host == "chatgpt.com" or mcp_host.endswith(".chatgpt.com"):
            raise RuntimeError(f"{_MCP_HOST_ENV} must name the distinct Nexus MCP origin")
        return cls(proxy_ip=proxy_ip, mcp_host=mcp_host)

    def admits(self, host: str) -> bool:
        return (
            host == "chatgpt.com"
            or host.endswith(".chatgpt.com")
            or host == "auth.openai.com"
            or host == self.mcp_host
        )


def _canonical_host(value: str) -> str:
    if len(value) > 253 or value != value.lower() or value.endswith(".") or "." not in value:
        raise PolicyError("host must be a canonical lowercase DNS name")
    try:
        value.encode("ascii")
        ipaddress.ip_address(value)
    except UnicodeEncodeError as error:
        raise PolicyError("host must use canonical ASCII IDNA") from error
    except ValueError:
        pass
    else:
        raise PolicyError("IP literals are not admitted")
    if any(_DNS_NAME.fullmatch(label) is None for label in value.split(".")):
        raise PolicyError("host contains an invalid DNS label")
    if value == "localhost" or value.endswith((".localhost", ".local", ".internal")):
        raise PolicyError("local hostnames are not admitted")
    return value


def _dns_name(query: bytes, offset: int) -> tuple[str, int]:
    labels: list[str] = []
    while True:
        if offset >= len(query):
            raise PolicyError("truncated DNS name")
        length = query[offset]
        offset += 1
        if length == 0:
            break
        if length > 63 or length & 0xC0:
            raise PolicyError("compressed or oversized DNS question name")
        end = offset + length
        if end > len(query):
            raise PolicyError("truncated DNS label")
        try:
            label = query[offset:end].decode("ascii")
        except UnicodeDecodeError as error:
            raise PolicyError("non-ASCII DNS label") from error
        labels.append(label)
        offset = end
    return _canonical_host(".".join(labels)), offset


def dns_response(query: bytes, policy: EgressPolicy) -> bytes:
    if len(query) < _DNS_HEADER.size or len(query) > _MAX_DNS_QUERY_BYTES:
        raise PolicyError("DNS query size is outside policy")
    request_id, flags, questions, answers, authorities, additional = _DNS_HEADER.unpack_from(query)
    response_flags = 0x8000 | (flags & 0x0100) | 0x0080
    if flags & 0x8000 or flags & 0x7800 or questions != 1 or answers != 0 or authorities != 0:
        return _DNS_HEADER.pack(request_id, response_flags | 1, 0, 0, 0, 0)
    question = b""
    response_opt = b""
    version = 0
    try:
        host, offset = _dns_name(query, _DNS_HEADER.size)
        if offset + 4 > len(query):
            raise PolicyError("truncated DNS question")
        query_type, query_class = struct.unpack_from("!HH", query, offset)
        question = query[_DNS_HEADER.size : offset + 4]
        offset += 4
        if additional:
            # RFC 6891 section 7 distinguishes malformed OPT from no EDNS support.
            if query[offset : offset + 3] == b"\x00\x00\x29":
                response_opt = _DNS_OPT.pack(0, 41, _MAX_DNS_QUERY_BYTES, 0, 0)
            if offset + _DNS_OPT.size > len(query):
                raise PolicyError("truncated DNS OPT record")
            name, record_type, _payload_size, ttl, data_length = _DNS_OPT.unpack_from(query, offset)
            offset += _DNS_OPT.size
            if name != 0 or record_type != 41:
                raise PolicyError("DNS additional record must be one bounded root OPT")
            response_opt = _DNS_OPT.pack(0, 41, _MAX_DNS_QUERY_BYTES, ttl & 0x8000, 0)
            if additional != 1 or offset + data_length != len(query):
                raise PolicyError("DNS query must contain exactly one complete OPT")
            while offset < len(query):
                if offset + 4 > len(query):
                    raise PolicyError("truncated DNS OPT option")
                _option_code, option_length = struct.unpack_from("!HH", query, offset)
                offset += 4 + option_length
                if offset > len(query):
                    raise PolicyError("truncated DNS OPT option data")
            # RFC 6891: ignore unknown options/flags and answer every valid OPT.
            # Replies fit below 512 bytes; advertise our own receive bound.
            version = (ttl >> 16) & 0xFF
            response_ttl = (ttl & 0x8000) | (0x01000000 if version else 0)
            response_opt = _DNS_OPT.pack(0, 41, _MAX_DNS_QUERY_BYTES, response_ttl, 0)
        if offset != len(query):
            raise PolicyError("unexpected trailing DNS records")
    except PolicyError:
        if response_opt:
            return (
                _DNS_HEADER.pack(request_id, response_flags | 1, 1, 0, 0, 1)
                + question
                + response_opt
            )
        return _DNS_HEADER.pack(request_id, response_flags | 1, 0, 0, 0, 0)
    if version:
        # BADVERS is extended RCODE 16; the response advertises EDNS version 0.
        return _DNS_HEADER.pack(request_id, response_flags, 1, 0, 0, 1) + question + response_opt
    if query_class != 1 or not policy.admits(host):
        return (
            _DNS_HEADER.pack(request_id, response_flags | 5, 1, 0, 0, additional)
            + question
            + response_opt
        )
    if query_type != 1:
        return (
            _DNS_HEADER.pack(request_id, response_flags, 1, 0, 0, additional)
            + question
            + response_opt
        )
    answer = (
        _DNS_A_ANSWER.pack(
            0xC00C,
            1,
            1,
            _DNS_TTL_SECONDS,
            4,
        )
        + policy.proxy_ip.packed
    )
    return (
        _DNS_HEADER.pack(request_id, response_flags, 1, 1, 0, additional)
        + question
        + answer
        + response_opt
    )


class _DnsDatagram(asyncio.DatagramProtocol):
    def __init__(self, policy: EgressPolicy) -> None:
        self._policy = policy

    def datagram_received(self, data: bytes, addr: tuple[str | object, ...]) -> None:
        transport = getattr(self, "transport", None)
        if not isinstance(transport, asyncio.DatagramTransport):
            return
        try:
            response = dns_response(data, self._policy)
        except PolicyError:
            return
        transport.sendto(response, addr)

    def connection_made(self, transport: asyncio.BaseTransport) -> None:
        if not isinstance(transport, asyncio.DatagramTransport):
            transport.close()
            return
        self.transport = transport


async def _serve_dns_tcp(
    reader: asyncio.StreamReader,
    writer: asyncio.StreamWriter,
    policy: EgressPolicy,
) -> None:
    try:
        size = struct.unpack("!H", await reader.readexactly(2))[0]
        if size > _MAX_DNS_QUERY_BYTES:
            raise PolicyError("DNS-over-TCP query is oversized")
        response = dns_response(await reader.readexactly(size), policy)
        writer.write(struct.pack("!H", len(response)) + response)
        await writer.drain()
    except (asyncio.IncompleteReadError, ConnectionError, PolicyError):
        pass
    finally:
        await _close_writer(writer)


async def _close_writer(writer: asyncio.StreamWriter) -> None:
    """Close a transport without promoting an already-lost peer into a task error."""

    try:
        writer.close()
        await writer.wait_closed()
    except OSError:
        pass


def _read_u16(value: bytes, offset: int) -> tuple[int, int]:
    if offset + 2 > len(value):
        raise PolicyError("truncated TLS ClientHello")
    return int.from_bytes(value[offset : offset + 2]), offset + 2


def _skip_vector_u8(value: bytes, offset: int) -> int:
    if offset >= len(value):
        raise PolicyError("truncated TLS ClientHello vector")
    end = offset + 1 + value[offset]
    if end > len(value):
        raise PolicyError("truncated TLS ClientHello vector")
    return end


def _skip_vector_u16(value: bytes, offset: int) -> int:
    length, offset = _read_u16(value, offset)
    end = offset + length
    if end > len(value):
        raise PolicyError("truncated TLS ClientHello vector")
    return end


def _client_hello_sni(hello: bytes) -> str:
    if len(hello) < 34:
        raise PolicyError("truncated TLS ClientHello")
    offset = 34
    offset = _skip_vector_u8(hello, offset)
    offset = _skip_vector_u16(hello, offset)
    offset = _skip_vector_u8(hello, offset)
    extensions_length, offset = _read_u16(hello, offset)
    extensions_end = offset + extensions_length
    if extensions_end != len(hello):
        raise PolicyError("TLS ClientHello extension length differs")
    names: list[str] = []
    while offset < extensions_end:
        extension_type, offset = _read_u16(hello, offset)
        extension_length, offset = _read_u16(hello, offset)
        extension_end = offset + extension_length
        if extension_end > extensions_end:
            raise PolicyError("truncated TLS ClientHello extension")
        if extension_type == 0:
            names_length, names_offset = _read_u16(hello, offset)
            if names_offset + names_length != extension_end:
                raise PolicyError("TLS SNI list length differs")
            while names_offset < extension_end:
                name_type = hello[names_offset]
                name_length, name_offset = _read_u16(hello, names_offset + 1)
                name_end = name_offset + name_length
                if name_end > extension_end:
                    raise PolicyError("truncated TLS SNI name")
                if name_type == 0:
                    try:
                        names.append(_canonical_host(hello[name_offset:name_end].decode("ascii")))
                    except UnicodeDecodeError as error:
                        raise PolicyError("TLS SNI is not ASCII") from error
                names_offset = name_end
        offset = extension_end
    if len(names) != 1:
        raise PolicyError("TLS ClientHello must carry exactly one host_name SNI")
    return names[0]


def client_hello_sni(records: bytes) -> str:
    payload = bytearray()
    offset = 0
    while True:
        if offset + 5 > len(records):
            raise _NeedMoreData
        content_type = records[offset]
        record_length = int.from_bytes(records[offset + 3 : offset + 5])
        if content_type != 22 or record_length > 18_432:
            raise PolicyError("connection did not begin with a bounded TLS handshake")
        record_end = offset + 5 + record_length
        if record_end > len(records):
            raise _NeedMoreData
        payload.extend(records[offset + 5 : record_end])
        if len(payload) >= 4:
            if payload[0] != 1:
                raise PolicyError("TLS handshake did not begin with ClientHello")
            hello_length = int.from_bytes(payload[1:4])
            if hello_length > _MAX_CLIENT_HELLO_BYTES - 4:
                raise PolicyError("TLS ClientHello is oversized")
            if len(payload) >= hello_length + 4:
                return _client_hello_sni(bytes(payload[4 : hello_length + 4]))
        offset = record_end


async def _public_connection(
    host: str,
) -> tuple[asyncio.StreamReader, asyncio.StreamWriter]:
    loop = asyncio.get_running_loop()
    addresses = await loop.getaddrinfo(host, _TLS_PORT, type=socket.SOCK_STREAM)
    last_error: OSError | None = None
    for family, socket_type, protocol, _canonical, socket_address in addresses:
        del socket_type, protocol, _canonical
        address = ipaddress.ip_address(socket_address[0])
        if not address.is_global or address.is_multicast:
            continue
        try:
            async with asyncio.timeout(_CONNECT_TIMEOUT_SECONDS):
                return await asyncio.open_connection(str(address), _TLS_PORT, family=family)
        except OSError as error:
            last_error = error
    raise OSError(f"no reachable public address for admitted host {host}") from last_error


async def _relay(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
    while chunk := await asyncio.wait_for(
        reader.read(64 * 1_024), timeout=_STREAM_IDLE_TIMEOUT_SECONDS
    ):
        writer.write(chunk)
        await writer.drain()


async def _serve_tls(
    reader: asyncio.StreamReader,
    writer: asyncio.StreamWriter,
    policy: EgressPolicy,
    slots: asyncio.Semaphore,
) -> None:
    upstream_writer: asyncio.StreamWriter | None = None
    try:
        async with slots:
            initial = bytearray()
            async with asyncio.timeout(_CLIENT_HELLO_TIMEOUT_SECONDS):
                while True:
                    if len(initial) >= _MAX_CLIENT_HELLO_BYTES:
                        raise PolicyError("TLS ClientHello is oversized")
                    chunk = await reader.read(
                        min(16 * 1_024, _MAX_CLIENT_HELLO_BYTES - len(initial))
                    )
                    if not chunk:
                        raise PolicyError("connection closed before TLS ClientHello")
                    initial.extend(chunk)
                    try:
                        host = client_hello_sni(bytes(initial))
                    except _NeedMoreData:
                        continue
                    break
            if not policy.admits(host):
                raise PolicyError("TLS SNI is outside the egress policy")
            upstream_reader, upstream_writer = await _public_connection(host)
            upstream_writer.write(initial)
            await upstream_writer.drain()
            client_to_upstream = asyncio.create_task(_relay(reader, upstream_writer))
            upstream_to_client = asyncio.create_task(_relay(upstream_reader, writer))
            done, pending = await asyncio.wait(
                (client_to_upstream, upstream_to_client),
                return_when=asyncio.FIRST_COMPLETED,
            )
            for task in pending:
                task.cancel()
            await asyncio.gather(*done, *pending, return_exceptions=True)
    except (TimeoutError, ConnectionError, OSError, PolicyError):
        pass
    finally:
        if upstream_writer is not None:
            await _close_writer(upstream_writer)
        await _close_writer(writer)


async def serve(policy: EgressPolicy) -> None:
    loop = asyncio.get_running_loop()
    udp_transport, _protocol = await loop.create_datagram_endpoint(
        lambda: _DnsDatagram(policy),
        local_addr=("0.0.0.0", _DNS_PORT),
    )
    dns_tcp = await asyncio.start_server(
        lambda reader, writer: _serve_dns_tcp(reader, writer, policy),
        "0.0.0.0",
        _DNS_PORT,
    )
    slots = asyncio.Semaphore(_MAX_CONNECTIONS)
    tls = await asyncio.start_server(
        lambda reader, writer: _serve_tls(reader, writer, policy, slots),
        "0.0.0.0",
        _TLS_PORT,
    )
    try:
        async with dns_tcp, tls:
            await asyncio.gather(dns_tcp.serve_forever(), tls.serve_forever())
    finally:
        udp_transport.close()


def health() -> None:
    for port in (_DNS_PORT, _TLS_PORT):
        with socket.create_connection(("127.0.0.1", port), timeout=1):
            pass


def main() -> None:
    if sys.argv[1:] == ["health"]:
        health()
        return
    if sys.argv[1:]:
        raise SystemExit("usage: python -m apps.codex_agent.egress_policy [health]")
    asyncio.run(serve(EgressPolicy.from_environment()))


if __name__ == "__main__":
    main()
