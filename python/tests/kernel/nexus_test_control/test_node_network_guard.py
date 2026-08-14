from __future__ import annotations

import os
import subprocess
from pathlib import Path


def test_node_guard_rejects_external_fetch_before_transport() -> None:
    repo_root = Path(__file__).parents[4]
    guard = repo_root / "python/tests/testkit/node-network-guard.mjs"
    result = subprocess.run(
        (
            "node",
            f"--import={guard}",
            "--input-type=module",
            "--eval",
            'await fetch("https://example.com/")',
        ),
        cwd=repo_root,
        check=False,
        capture_output=True,
        text=True,
        timeout=5,
    )

    assert result.returncode != 0
    assert "test process denied external network host: example.com" in result.stderr


def test_node_guard_denies_direct_tcp_and_tls_before_transport_but_allows_loopback(
    tmp_path: Path,
) -> None:
    repo_root = Path(__file__).parents[4]
    guard = repo_root / "python/tests/testkit/node-network-guard.mjs"
    probe = tmp_path / "socket-contact-probe.mjs"
    probe.write_text(
        "import fs from 'node:fs';\n"
        "import net from 'node:net';\n"
        "import tls from 'node:tls';\n"
        "const contact = (entrypoint) => {\n"
        "  fs.writeFileSync(process.env.NODE_NETWORK_CONTACT_MARKER, entrypoint);\n"
        "  throw new Error(`probe observed ${entrypoint} transport`);\n"
        "};\n"
        "net.Socket.prototype.connect = () => contact('Socket.connect');\n"
        "tls.connect = () => contact('tls.connect');\n"
        "tls.TLSSocket.prototype.connect = () => contact('TLSSocket.connect');\n"
    )
    entries = {
        "tcp-socket": (
            'import net from "node:net"; new net.Socket().connect({host:"example.com",port:443})'
        ),
        "tls-connect": ('import tls from "node:tls"; tls.connect({host:"example.com",port:443})'),
        "tls-socket": (
            'import net from "node:net"; import tls from "node:tls"; '
            'new tls.TLSSocket(new net.Socket()).connect({host:"example.com",port:443})'
        ),
    }

    for entrypoint, source in entries.items():
        marker = tmp_path / f"{entrypoint}.contact"
        result = subprocess.run(
            (
                "node",
                f"--import={probe}",
                f"--import={guard}",
                "--input-type=module",
                "--eval",
                source,
            ),
            cwd=repo_root,
            env={**os.environ, "NODE_NETWORK_CONTACT_MARKER": str(marker)},
            check=False,
            capture_output=True,
            text=True,
            timeout=5,
        )

        assert result.returncode != 0
        assert "test process denied external network host: example.com" in result.stderr
        assert "probe observed" not in result.stderr
        assert not marker.exists(), entrypoint

    loopback_marker = tmp_path / "loopback.contact"
    loopback = subprocess.run(
        (
            "node",
            f"--import={probe}",
            f"--import={guard}",
            "--input-type=module",
            "--eval",
            'import tls from "node:tls"; tls.connect({host:"127.0.0.1",port:443})',
        ),
        cwd=repo_root,
        env={**os.environ, "NODE_NETWORK_CONTACT_MARKER": str(loopback_marker)},
        check=False,
        capture_output=True,
        text=True,
        timeout=5,
    )

    assert loopback.returncode != 0
    assert "probe observed tls.connect transport" in loopback.stderr
    assert loopback_marker.read_text() == "tls.connect"
