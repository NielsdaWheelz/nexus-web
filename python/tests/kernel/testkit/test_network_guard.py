import json
import os
import socket
import subprocess
import sys
from pathlib import Path

import pytest

from tests.testkit.network import install_network_guard


def test_pytest_process_allows_only_local_sockets() -> None:
    for host in ("127.0.0.1", "::1", "127.0.1.1"):
        family = socket.AF_INET6 if ":" in host else socket.AF_INET
        with socket.socket(family) as local:
            local.connect_ex((host, 9))

    left, right = socket.socketpair()
    left.sendall(b"ok")
    assert right.recv(2) == b"ok"
    left.close()
    right.close()

    with socket.socket() as external, pytest.raises(PermissionError, match="198.51.100.1"):
        external.connect(("198.51.100.1", 443))

    with pytest.raises(PermissionError, match="example.com"):
        socket.getaddrinfo("example.com", 443)

    with (
        socket.socket(type=socket.SOCK_DGRAM) as external,
        pytest.raises(PermissionError, match="198.51.100.1"),
    ):
        external.sendto(b"blocked", ("198.51.100.1", 53))


def test_spawned_python_process_allows_only_local_sockets() -> None:
    program = """
import socket

assert socket.getaddrinfo('127.0.0.1', 0)
for host in ('127.0.0.1', '::1', '127.0.1.1'):
    sock = socket.socket(socket.AF_INET6 if ':' in host else socket.AF_INET)
    try:
        sock.connect_ex((host, 9))
    finally:
        sock.close()

left, right = socket.socketpair()
left.sendall(b'ok')
assert right.recv(2) == b'ok'
left.close()
right.close()

for host in ('198.51.100.1', 'example.com'):
    try:
        socket.getaddrinfo(host, 443)
    except PermissionError as error:
        assert host in str(error)
    else:
        raise AssertionError(f'external host was allowed: {host}')
"""
    completed = subprocess.run(
        [sys.executable, "-c", program],
        cwd=Path(__file__).parents[3],
        env=os.environ.copy(),
        check=False,
        capture_output=True,
        text=True,
    )

    assert completed.returncode == 0, (
        "spawned Python network guard failed\n"
        f"stdout:\n{completed.stdout}\n"
        f"stderr:\n{completed.stderr}"
    )


def test_static_dns_can_route_one_canonical_host_to_an_owned_loopback_port(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        listener.listen()
        port = listener.getsockname()[1]
        monkeypatch.setenv(
            "NEXUS_TEST_STATIC_DNS",
            json.dumps({"api.openai.com": {"address": "127.0.0.1", "port": port}}),
        )
        restore = install_network_guard()
        try:
            addresses = socket.getaddrinfo("api.openai.com", 443, type=socket.SOCK_STREAM)
            with socket.socket() as client:
                client.connect(("127.0.0.1", 443))
                connected, _ = listener.accept()
                connected.close()
        finally:
            restore()

    assert addresses
    assert {address[-1] for address in addresses} == {("127.0.0.1", port)}


def test_nested_guards_can_resolve_the_owned_public_dns_fixture_without_allowing_it(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv(
        "NEXUS_TEST_STATIC_DNS",
        '{"www.nasa.gov":"93.184.216.34"}',
    )
    restore_outer = install_network_guard()
    restore_inner = install_network_guard()
    try:
        addresses = socket.getaddrinfo(
            "www.nasa.gov",
            443,
            type=socket.SOCK_STREAM,
        )
        with (
            socket.socket() as external,
            pytest.raises(PermissionError, match="93.184.216.34"),
        ):
            external.connect(("93.184.216.34", 443))
    finally:
        restore_inner()
        restore_outer()

    assert addresses
    assert {address[-1][0] for address in addresses} == {"93.184.216.34"}


@pytest.mark.parametrize(
    "mapping",
    (
        '{"api.openai.com":{"address":"198.51.100.1","port":25443}}',
        '{"api.openai.com":{"address":"127.0.0.1","port":0}}',
        '{"api.openai.com":{"address":"127.0.0.1","port":"25443"}}',
        '{"api.openai.com":{"address":"127.0.0.1","port":25443,"extra":true}}',
    ),
)
def test_static_dns_rejects_nonloopback_and_malformed_routes(
    monkeypatch: pytest.MonkeyPatch,
    mapping: str,
) -> None:
    monkeypatch.setenv("NEXUS_TEST_STATIC_DNS", mapping)

    with pytest.raises(PermissionError, match="invalid static DNS mapping"):
        install_network_guard()


def test_static_dns_rejects_ambiguous_tls_port_rewrites(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv(
        "NEXUS_TEST_STATIC_DNS",
        json.dumps(
            {
                "api.openai.com": {"address": "127.0.0.1", "port": 25443},
                "api.example.test": {"address": "127.0.0.1", "port": 25444},
            }
        ),
    )
    restore = install_network_guard()
    try:
        with (
            socket.socket() as client,
            pytest.raises(PermissionError, match="ambiguous loopback routes"),
        ):
            client.connect(("127.0.0.1", 443))
    finally:
        restore()
