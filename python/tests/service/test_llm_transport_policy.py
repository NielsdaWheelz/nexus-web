"""Production LLM transport ignores ambient proxy configuration."""

from __future__ import annotations

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread

import httpx
import pytest
from sqlalchemy.orm import Session

from nexus.services.llm_execution import ExecutionRuntime
from nexus.tasks.llm_task import LlmTaskSpec, run_llm_task


class _ResponseServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, body: bytes):
        self.body = body
        self.request_count = 0
        super().__init__(("127.0.0.1", 0), _ResponseHandler)


class _ResponseHandler(BaseHTTPRequestHandler):
    server: _ResponseServer

    def do_GET(self) -> None:  # noqa: N802 - stdlib handler API
        self.server.request_count += 1
        self.send_response(200)
        self.send_header("Content-Length", str(len(self.server.body)))
        self.end_headers()
        self.wfile.write(self.server.body)

    def log_message(self, format: str, *args: object) -> None:
        _ = format, args


class _RunningServer:
    def __init__(self, body: bytes):
        self.server = _ResponseServer(body)
        self.thread = Thread(target=self.server.serve_forever, daemon=True)

    def __enter__(self) -> _ResponseServer:
        self.thread.start()
        return self.server

    def __exit__(self, *exc_info: object) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()


def test_llm_worker_ignores_environment_selected_http_proxies(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    with _RunningServer(b"canonical") as target, _RunningServer(b"proxy") as proxy:
        target_url = f"http://127.0.0.1:{target.server_port}/provider"
        proxy_url = f"http://127.0.0.1:{proxy.server_port}"
        monkeypatch.setenv("HTTP_PROXY", proxy_url)
        monkeypatch.setenv("HTTPS_PROXY", proxy_url)
        monkeypatch.setenv("ALL_PROXY", proxy_url)
        monkeypatch.setenv("NO_PROXY", "")

        async def call_target(
            _db: Session,
            _runtime: ExecutionRuntime,
            client: httpx.AsyncClient,
        ) -> str:
            response = await client.get(target_url)
            response.raise_for_status()
            return response.text

        response_text = run_llm_task(LlmTaskSpec(label="proxy_contract"), call_target)

    assert response_text == "canonical"
    assert target.request_count == 1
    assert proxy.request_count == 0
