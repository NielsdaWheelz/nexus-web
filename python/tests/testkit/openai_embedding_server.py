"""Canonical-host TLS OpenAI embedding fixture owned by the test controller."""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import math
import ssl
import struct
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, cast

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID

from nexus_test_control import services as test_services
from nexus_test_control.runtime import EndpointKind, read_runtime, runtime_state_dir
from tests.testkit.worker import controller_run, kill_and_forget_process

_API_KEY = "nexus-test-fixture-openai-key"
_HOST = "api.openai.com"
_MAX_REQUEST_BYTES = 1_048_576
_TEST_ENV = {"NEXUS_ENV": "test"}


@dataclass(frozen=True, slots=True)
class EmbeddingPeer:
    state: Path
    certificate: Path
    key: Path
    audit: Path
    port: int

    def server_environment(self) -> dict[str, str]:
        return {
            "NEXUS_TEST_OPENAI_CERTIFICATE": str(self.certificate),
            "NEXUS_TEST_OPENAI_KEY": str(self.key),
            "NEXUS_TEST_OPENAI_AUDIT": str(self.audit),
        }

    def worker_environment(self) -> dict[str, str]:
        return {
            "NEXUS_TEST_STATIC_DNS": json.dumps(
                {"api.openai.com": {"address": "127.0.0.1", "port": self.port}},
                separators=(",", ":"),
                sort_keys=True,
            ),
            "NEXUS_TEST_TLS_CA_CERT": str(self.certificate),
        }

    def requests(self) -> tuple[dict[str, object], ...]:
        rows = tuple(
            json.loads(line) for line in self.audit.read_text(encoding="utf-8").splitlines() if line
        )
        return tuple(
            row["payload"]
            for row in rows
            if isinstance(row, dict)
            and row.get("path") == "/v1/embeddings"
            and isinstance(row.get("payload"), dict)
        )


def _write_embedding_peer_certificate(certificate: Path, key_path: Path) -> None:
    key = rsa.generate_private_key(public_exponent=65_537, key_size=2048)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, _HOST)])
    value = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(datetime.now(UTC) - timedelta(minutes=1))
        .not_valid_after(datetime.now(UTC) + timedelta(days=1))
        .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
        .add_extension(x509.SubjectAlternativeName([x509.DNSName(_HOST)]), critical=False)
        .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
        .sign(key, hashes.SHA256())
    )
    certificate.write_bytes(value.public_bytes(serialization.Encoding.PEM))
    key_path.write_bytes(
        key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        )
    )
    key_path.chmod(0o600)


class _OpenAIProviderServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, port: int, certificate: Path, key: Path, audit: Path):
        self.audit = audit
        self._evidence_lock = threading.Lock()
        super().__init__(("127.0.0.1", port), _OpenAIProviderHandler)
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(certfile=certificate, keyfile=key)
        self.socket = context.wrap_socket(self.socket, server_side=True)

    def record_request(self, path: str, payload: dict[str, Any]) -> None:
        with self._evidence_lock, self.audit.open("a", encoding="utf-8") as audit:
            audit.write(
                json.dumps(
                    {"path": path, "payload": payload},
                    separators=(",", ":"),
                    sort_keys=True,
                )
                + "\n"
            )


class _OpenAIProviderHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    @property
    def provider(self) -> _OpenAIProviderServer:
        return cast(_OpenAIProviderServer, self.server)

    def do_GET(self) -> None:  # noqa: N802 - stdlib handler API
        if self.path == "/livez" and self.headers.get("host", "").partition(":")[0] in {
            "127.0.0.1",
            _HOST,
        }:
            self._send_json(200, {"status": "alive"})
            return
        self._send_json(404, {"error": {"code": "unknown_path"}})

    def do_POST(self) -> None:  # noqa: N802 - stdlib handler API
        try:
            if self.headers.get("host") != _HOST:
                raise RequestRejected(404, "unknown_host")
            if self.headers.get("authorization") != f"Bearer {_API_KEY}":
                raise RequestRejected(401, "invalid_auth")
            content_type = self.headers.get("content-type", "").partition(";")[0].strip().lower()
            if content_type != "application/json":
                raise RequestRejected(415, "invalid_content_type")
            payload = self._read_payload()
            self.provider.record_request(self.path, payload)
            if self.path == "/v1/embeddings":
                self._serve_embeddings(payload)
                return
            raise RequestRejected(404, "unknown_path")
        except RequestRejected as error:
            self._send_json(error.status, {"error": {"code": error.code}})

    def _serve_embeddings(self, payload: dict[str, Any]) -> None:
        model = payload.get("model")
        inputs = payload.get("input")
        dimensions = payload.get("dimensions")
        if (
            set(payload) != {"model", "input", "dimensions", "encoding_format"}
            or model != "text-embedding-3-small"
            or payload.get("encoding_format") != "base64"
            or not isinstance(inputs, list)
            or not 1 <= len(inputs) <= 64
            or any(not isinstance(value, str) for value in inputs)
            or not isinstance(dimensions, int)
            or isinstance(dimensions, bool)
            or not 8 <= dimensions <= 3072
        ):
            raise RequestRejected(422, "invalid_embedding_request")
        token_count = sum(len(str(value).split()) for value in inputs)
        self._send_json(
            200,
            {
                "object": "list",
                "data": [
                    {
                        "object": "embedding",
                        "index": index,
                        "embedding": _base64_embedding(value, dimensions),
                    }
                    for index, value in enumerate(inputs)
                ],
                "model": model,
                "usage": {"prompt_tokens": token_count, "total_tokens": token_count},
            },
            headers={"x-request-id": "req_nexus_embedding_fixture"},
        )

    def _read_payload(self) -> dict[str, Any]:
        raw_length = self.headers.get("content-length", "")
        if not raw_length.isdecimal() or not 1 <= int(raw_length) <= _MAX_REQUEST_BYTES:
            raise RequestRejected(413, "invalid_request_size")
        try:
            payload = json.loads(self.rfile.read(int(raw_length)))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise RequestRejected(400, "invalid_json") from error
        if not isinstance(payload, dict):
            raise RequestRejected(400, "request_must_be_object")
        return payload

    def _send_json(
        self,
        status: int,
        payload: object,
        *,
        headers: dict[str, str] | None = None,
    ) -> None:
        body = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode()
        self._send_bytes(status, body, "application/json", headers=headers)

    def _send_bytes(
        self,
        status: int,
        body: bytes,
        content_type: str,
        *,
        headers: dict[str, str] | None = None,
    ) -> None:
        self.send_response(status)
        self.send_header("content-type", content_type)
        self.send_header("content-length", str(len(body)))
        self.send_header("connection", "close")
        for name, value in (headers or {}).items():
            self.send_header(name, value)
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format: str, *args: object) -> None:
        _ = format, args


class RequestRejected(Exception):
    def __init__(self, status: int, code: str):
        self.status = status
        self.code = code
        super().__init__(code)


def _deterministic_embedding(value: str, dimensions: int) -> list[float]:
    vector = [0.0] * dimensions
    for token in value.casefold().split():
        digest = hashlib.sha256(token.encode()).digest()
        bucket = int.from_bytes(digest[:4], "big") % dimensions
        vector[bucket] += -1.0 if digest[4] % 2 else 1.0
    norm = math.sqrt(sum(component * component for component in vector))
    return [component / norm for component in vector] if norm else vector


def _base64_embedding(value: str, dimensions: int) -> str:
    vector = _deterministic_embedding(value, dimensions)
    return base64.b64encode(struct.pack(f"<{dimensions}f", *vector)).decode("ascii")


@contextmanager
def running_openai_embedding_server(
    root: Path,
) -> Iterator[EmbeddingPeer]:
    """Start one controller-owned deterministic embedding peer."""
    run = controller_run()
    runtime = read_runtime(root)
    state = runtime_state_dir(root) / "runs" / run.run_id / "embedding-peer"
    state.mkdir(parents=False, exist_ok=False)
    certificate = state / "ca.pem"
    key = state / "server-key.pem"
    audit = state / "requests.jsonl"
    audit.touch(mode=0o600, exist_ok=False)
    _write_embedding_peer_certificate(certificate, key)
    peer = EmbeddingPeer(state, certificate, key, audit, runtime.ports.provider_openai)
    process: test_services.StartedProcess | None = None
    try:
        process = test_services.start_python_process(
            root,
            _TEST_ENV,
            run,
            "provider-openai",
            overrides=peer.server_environment(),
        )
        test_services.wait_process_ready(
            root,
            _TEST_ENV,
            process,
            EndpointKind.PROVIDER_OPENAI,
            "/livez",
            tls_ca=peer.certificate,
        )
        yield peer
    finally:
        if process is not None:
            kill_and_forget_process(process)
        for path in (audit, certificate, key):
            path.unlink(missing_ok=True)
        state.rmdir()


def create_server(
    *,
    port: int,
    certificate: Path,
    key: Path,
    audit: Path,
) -> _OpenAIProviderServer:
    if not 1 <= port <= 65_535:
        raise ValueError("port must be between 1 and 65535")
    return _OpenAIProviderServer(port, certificate, key, audit)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", required=True, type=int)
    parser.add_argument("--certificate", required=True, type=Path)
    parser.add_argument("--key", required=True, type=Path)
    parser.add_argument("--audit", required=True, type=Path)
    args = parser.parse_args()
    server = create_server(
        port=args.port,
        certificate=args.certificate.resolve(strict=True),
        key=args.key.resolve(strict=True),
        audit=args.audit.resolve(strict=True),
    )
    try:
        server.serve_forever(poll_interval=0.01)
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
