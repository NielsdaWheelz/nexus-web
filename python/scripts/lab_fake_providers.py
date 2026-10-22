"""Disposable provider wires, never model semantics or scenario fixtures.

The real SDK and pinned Codex client consume Responses SSE/WebSocket events and
OpenAI embeddings over verified HTTPS. Replies are fixed text and deterministic
word vectors; they establish transport/composition, not model quality, tools or
structured generation. Every process starts with empty request counters.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import itertools
import json
import math
import re
import struct
import time
from pathlib import Path

import uvicorn
from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import StreamingResponse

app = FastAPI()
counts = {"responses_http": 0, "responses_ws": 0, "embeddings": 0, "prewarm": 0}
sequence = itertools.count(1)
TEXT = "lab fake provider response"


def events(body: dict[str, object]) -> list[dict[str, object]]:
    number = next(sequence)
    identifier = f"resp_lab_{number}"
    item_id = f"msg_lab_{number}"
    prewarm = body.get("generate") is False
    if prewarm:
        counts["prewarm"] += 1
    part = {"type": "output_text", "text": TEXT, "annotations": []}
    item = {
        "type": "message",
        "role": "assistant",
        "id": item_id,
        "status": "completed",
        "content": [part],
    }
    response = {
        "id": identifier,
        "object": "response",
        "created_at": int(time.time()),
        "status": "completed",
        "error": None,
        "incomplete_details": None,
        "model": body.get("model"),
        "output": [] if prewarm else [item],
        "usage": {
            "input_tokens": 1,
            "input_tokens_details": {"cached_tokens": 0},
            "output_tokens": 0 if prewarm else 5,
            "output_tokens_details": {"reasoning_tokens": 0},
            "total_tokens": 1 if prewarm else 6,
        },
    }
    frames: list[dict[str, object]] = [
        {"type": "response.created", "response": response | {"status": "in_progress", "output": []}}
    ]
    if not prewarm:
        position = {"item_id": item_id, "output_index": 0, "content_index": 0}
        frames.extend(
            [
                {
                    "type": "response.output_item.added",
                    "output_index": 0,
                    "item": item | {"status": "in_progress", "content": []},
                },
                {"type": "response.content_part.added", **position, "part": part | {"text": ""}},
                {"type": "response.output_text.delta", **position, "delta": TEXT},
                {"type": "response.output_text.done", **position, "text": TEXT},
                {"type": "response.content_part.done", **position, "part": part},
                {"type": "response.output_item.done", "output_index": 0, "item": item},
            ]
        )
    frames.append({"type": "response.completed", "response": response})
    return frames


@app.get("/health")
@app.get("/_lab/requests")
def observed() -> dict[str, object]:
    return {"kind": "lab_fake_providers", "counts": counts.copy()}


@app.get("/backend-api/wham/accounts/check")
def account(request: Request) -> dict[str, object]:
    account_id = request.headers.get("chatgpt-account-id", "lab-fake-account")
    return {
        "accounts": [
            {
                "id": account_id,
                "workspace_backend_origin": str(request.base_url).rstrip("/"),
                "account_routing_override": "NO_CONSTRAINT",
            }
        ],
        "default_account_id": account_id,
    }


@app.get("/backend-api/wham/config/bundle")
def bundle() -> dict[str, object]:
    return {}


@app.post("/v1/responses")
@app.post("/backend-api/codex/responses")
async def responses(request: Request) -> StreamingResponse:
    counts["responses_http"] += 1
    frames = events(await request.json())

    async def stream():
        for frame in frames:
            yield f"event: {frame['type']}\ndata: {json.dumps(frame)}\n\n"

    return StreamingResponse(stream(), media_type="text/event-stream")


@app.websocket("/v1/responses")
@app.websocket("/backend-api/codex/responses")
async def websocket(socket: WebSocket) -> None:
    await socket.accept()
    try:
        while True:
            body = await socket.receive_json()
            if body.get("type") != "response.create":
                await socket.close(code=1003)
                return
            counts["responses_ws"] += 1
            for frame in events(body):
                await socket.send_json(frame)
    except WebSocketDisconnect:
        pass


@app.post("/v1/embeddings")
async def embeddings(request: Request) -> dict[str, object]:
    counts["embeddings"] += 1
    body = await request.json()
    inputs = body["input"] if isinstance(body["input"], list) else [body["input"]]
    dimensions = body.get("dimensions", 256)
    data = []
    for index, text in enumerate(inputs):
        vector = [0.0] * dimensions
        for word in re.findall(r"[a-z0-9]+", str(text).lower()):
            slot = int.from_bytes(hashlib.sha256(word.encode()).digest()[:4]) % dimensions
            vector[slot] += 1
        norm = math.hypot(*vector)
        if norm:
            vector = [value / norm for value in vector]
        else:
            vector[0] = 1.0
        encoded = (
            base64.b64encode(struct.pack(f"<{dimensions}f", *vector)).decode()
            if body.get("encoding_format") == "base64"
            else vector
        )
        data.append({"object": "embedding", "index": index, "embedding": encoded})
    return {
        "object": "list",
        "data": data,
        "model": body["model"],
        "usage": {"prompt_tokens": len(inputs), "total_tokens": len(inputs)},
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--certificate", required=True, type=Path)
    parser.add_argument("--key", required=True, type=Path)
    args = parser.parse_args()
    uvicorn.run(
        app,
        host="0.0.0.0",
        port=8443,
        ssl_certfile=str(args.certificate),
        ssl_keyfile=str(args.key),
        access_log=False,
    )
