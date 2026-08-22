"""Deterministic loopback origin for the production-Caddyfile process seam."""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
from uuid import UUID

import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import PlainTextResponse, Response

ACCOUNT_ID = "22222222-2222-4222-8222-222222222222"
PACKAGE_BYTES = b"nexus-offline-reading-package-v1\n" * 64
FALLBACK_TEXT = "nexus-caddy-fallback\n" * 512
PACKAGE_DIGEST = (
    "sha-256=:" + base64.b64encode(hashlib.sha256(PACKAGE_BYTES).digest()).decode() + ":"
)


def create_app(audit_path: Path) -> FastAPI:
    app = FastAPI()

    def record(request: Request) -> None:
        row = {
            "accept_encoding": request.headers.get("accept-encoding"),
            "authorization": request.headers.get("authorization"),
            "path": request.url.path,
        }
        with audit_path.open("a", encoding="utf-8") as audit:
            audit.write(json.dumps(row, separators=(",", ":"), sort_keys=True) + "\n")

    @app.get("/readyz")
    async def ready() -> PlainTextResponse:
        return PlainTextResponse("ready")

    @app.get("/offline-reading/packages/{media_id}")
    async def package(media_id: UUID, request: Request) -> Response:
        record(request)
        return Response(
            PACKAGE_BYTES,
            media_type="application/vnd.nexus.offline-reading+zip",
            headers={
                "Content-Digest": PACKAGE_DIGEST,
                "Content-Length": str(len(PACKAGE_BYTES)),
                "Nexus-Account-Id": ACCOUNT_ID,
                "Nexus-Reader-Generation": "7",
            },
        )

    @app.get("/{path:path}")
    async def fallback(path: str, request: Request) -> PlainTextResponse:
        record(request)
        return PlainTextResponse(FALLBACK_TEXT)

    return app


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--audit", type=Path, required=True)
    arguments = parser.parse_args()
    if os.environ.get("NEXUS_ENV") != "test" or not os.environ.get("NEXUS_TEST_RUN_ID"):
        raise RuntimeError("offline-reading Caddy origin requires its owned test run")
    uvicorn.run(
        create_app(arguments.audit),
        host="127.0.0.1",
        port=arguments.port,
        log_level="warning",
        access_log=False,
    )


if __name__ == "__main__":
    main()
