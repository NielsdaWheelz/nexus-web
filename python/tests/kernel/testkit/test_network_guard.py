import os
import socket
import subprocess
import sys
from pathlib import Path

import pytest


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
