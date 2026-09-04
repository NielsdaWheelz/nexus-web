"""Real-UDS proof for the secret-free Codex model catalog client."""

from __future__ import annotations

import asyncio
import socketserver
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime
from importlib.util import find_spec
from pathlib import Path
from tempfile import gettempdir
from typing import TYPE_CHECKING
from uuid import uuid4

# BASE sensitivity overlays this proof without candidate production owners.
_CUTOVER_PRESENT = find_spec("nexus.services.generation_spec") is not None

if TYPE_CHECKING or _CUTOVER_PRESENT:
    from provider_runtime import Absent, Present
    from provider_runtime.agent_runtime import (
        AgentModelCatalog,
        AgentModelFacts,
        AgentReasoningFacts,
    )

    from nexus.services.codex_generation_client import CodexGenerationClient
    from nexus.services.codex_generation_contract import codex_model_catalog_to_wire

_LINUX_SUN_PATH_BYTES = 108


def _catalog() -> AgentModelCatalog:
    return AgentModelCatalog(
        backend_contract_revision="provider-runtime.agent-model-catalog.v1",
        definition_revision="2" * 64,
        native_revision=Absent(),
        observed_at=datetime(2026, 8, 31, 12, 0, tzinfo=UTC),
        models=(
            AgentModelFacts(
                key="gpt-5.6-terra",
                dispatch_model="gpt-5.6-terra",
                label="GPT-5.6 Terra",
                source_context_window=Absent(),
                source_max_output_tokens=Absent(),
                input_modalities=("text", "image"),
                reasoning=(
                    AgentReasoningFacts(
                        key="medium",
                        label="Balanced reasoning",
                        native_wire_value="medium",
                    ),
                ),
                source_default_reasoning=Present("medium"),
                upgrade=Absent(),
                retirement=Absent(),
                row_fingerprint="1" * 64,
            ),
        ),
        diagnostics=(),
    )


def _short_socket_path() -> Path:
    path = Path(gettempdir()) / f"nexus-catalog-{uuid4().hex[:16]}.sock"
    assert len(str(path).encode()) < _LINUX_SUN_PATH_BYTES
    return path


@contextmanager
def _catalog_peer(socket_path: Path, requests: list[bytes]) -> Iterator[None]:
    payload = codex_model_catalog_to_wire(_catalog()).model_dump_json().encode()

    class Handler(socketserver.StreamRequestHandler):
        def handle(self) -> None:
            request_line = self.rfile.readline()
            requests.append(request_line)
            headers: dict[str, str] = {}
            while True:
                line = self.rfile.readline()
                if line in (b"\r\n", b"\n", b""):
                    break
                name, value = line.decode("ascii").split(":", 1)
                headers[name.casefold()] = value.strip()
            assert request_line == b"GET /v2/model-catalog HTTP/1.1\r\n"
            assert headers["accept"] == "application/json"
            self.wfile.write(
                b"HTTP/1.1 200 OK\r\n"
                b"Content-Type: application/json\r\n"
                + f"Content-Length: {len(payload)}\r\n".encode("ascii")
                + b"Connection: close\r\n\r\n"
                + payload
            )
            self.wfile.flush()

    class Server(socketserver.UnixStreamServer):
        allow_reuse_address = False

    with Server(str(socket_path), Handler) as server:
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            yield
        finally:
            server.shutdown()
            thread.join(timeout=5)
            server.server_close()
            socket_path.unlink(missing_ok=True)


def test_catalog_client_reads_the_authenticated_catalog_over_private_uds() -> None:
    """Risk: the API process bypasses the private host or loses source catalog facts."""

    assert _CUTOVER_PRESENT, "the private Codex model catalog cutover is absent"
    socket_path = _short_socket_path()
    requests: list[bytes] = []
    with _catalog_peer(socket_path, requests):
        observed = asyncio.run(CodexGenerationClient(socket_path).model_catalog())

    assert requests == [b"GET /v2/model-catalog HTTP/1.1\r\n"]
    assert observed == _catalog()
    assert "credential" not in repr(observed).casefold()
