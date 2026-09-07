"""Controller-owned loopback TLS boundary for configured generation providers."""

from __future__ import annotations

import argparse
import json
import ssl
import threading
from collections.abc import Mapping
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import MappingProxyType
from typing import cast

from nexus_test_control.provider_api_contract import (
    PROVIDER_API_NAMES,
    TEST_GENERATION_CONTINUATION_ENCRYPTION_KEY,
)

_MAX_REQUEST_BYTES = 1_048_576
_SECRET_OBSERVATION_PATH = "/_test/generation-secret-observations"

# Fixed non-production sentinels let the external protocol peer observe the
# complete request boundary without returning or persisting secret material.
GENERATION_SECRET_ISOLATION_SENTINELS: Mapping[str, str] = MappingProxyType(
    {
        "codex_auth": "nexus-test-codex-auth-secret-isolation",
        "codex_diagnostic": "nexus-test-codex-diagnostic-secret-isolation",
        "codex_failure_text": "nexus-test-codex-failure-secret-isolation",
        "codex_tool_bearer": "nexus-test-codex-tool-bearer-secret-isolation",
        "continuation_key": TEST_GENERATION_CONTINUATION_ENCRYPTION_KEY,
        "continuation_payload": "nexus-test-continuation-payload-secret-isolation",
    }
)


class _ProviderApiServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, port: int, certificate: Path, key: Path, audit: Path):
        self.audit = audit
        self._audit_lock = threading.Lock()
        self._secret_observations = {
            name: {"body": False, "headers": False}
            for name in GENERATION_SECRET_ISOLATION_SENTINELS
        }
        self._observed_requests = 0
        self._authorization_header_seen = False
        super().__init__(("127.0.0.1", port), _ProviderApiHandler)
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(certfile=certificate, keyfile=key)
        self.socket = context.wrap_socket(self.socket, server_side=True)

    def observe_and_record_request(
        self,
        method: str,
        path: str,
        payload: object,
        *,
        headers: tuple[tuple[str, str], ...],
    ) -> None:
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        header_values = "\n".join(value for _name, value in headers)
        with self._audit_lock, self.audit.open("a", encoding="utf-8") as audit:
            self._observed_requests += 1
            self._authorization_header_seen = self._authorization_header_seen or any(
                name.lower() == "authorization" for name, _value in headers
            )
            for name, sentinel in GENERATION_SECRET_ISOLATION_SENTINELS.items():
                observation = self._secret_observations[name]
                observation["body"] = observation["body"] or sentinel in body
                observation["headers"] = observation["headers"] or sentinel in header_values
            audit.write(
                json.dumps(
                    {
                        "method": method,
                        "path": _redact_secret_isolation_sentinels(path),
                        "payload": _redact_secret_isolation_sentinels(payload),
                    },
                    separators=(",", ":"),
                    sort_keys=True,
                )
                + "\n"
            )

    def secret_observations(self) -> dict[str, object]:
        with self._audit_lock:
            return {
                "authorization_header_seen": self._authorization_header_seen,
                "request_count": self._observed_requests,
                "sentinels": {
                    name: dict(observation)
                    for name, observation in self._secret_observations.items()
                },
            }


class _ProviderApiHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    @property
    def provider(self) -> _ProviderApiServer:
        return cast(_ProviderApiServer, self.server)

    def do_GET(self) -> None:  # noqa: N802 - stdlib handler API
        is_loopback = self.headers.get("host", "").partition(":")[0] == "127.0.0.1"
        if self.path == "/livez" and is_loopback:
            self._send_json(200, {"providers": list(PROVIDER_API_NAMES), "status": "alive"})
            return
        if self.path == _SECRET_OBSERVATION_PATH and is_loopback:
            self._send_json(200, self.provider.secret_observations())
            return
        self._send_json(404, {"error": {"code": "unknown_path"}})

    def do_POST(self) -> None:  # noqa: N802 - stdlib handler API
        payload = self._read_payload()
        if payload is None:
            return
        self.provider.observe_and_record_request(
            "POST",
            self.path,
            payload,
            headers=tuple(self.headers.items()),
        )
        if not isinstance(payload, dict):
            self._send_json(400, {"error": {"code": "request_must_be_an_object"}})
            return
        provider, model = _provider_identity(self.path, payload)
        if provider is None or model is None or not _canonical_path(provider, self.path):
            self._send_json(404, {"error": {"code": "unknown_provider_path"}})
            return
        reasoning = _fixture_marker(payload, "NEXUS_EXPECT_REASONING=")
        if reasoning is not None and not _has_exact_reasoning_wire(
            provider=provider,
            model=model,
            reasoning=reasoning,
            payload=payload,
        ):
            self._send_json(400, {"error": {"code": "reasoning_fixture_mismatch"}})
            return
        scenario = _scenario(payload)
        if scenario is None:
            self._send_json(400, {"error": {"code": "missing_fixture_scenario"}})
            return
        if scenario == "strict" and not _has_strict_output_wire(
            provider=provider,
            model=model,
            payload=payload,
        ):
            self._send_json(400, {"error": {"code": "strict_output_fixture_mismatch"}})
            return
        text = f"provider:{provider}:{scenario}-ok"
        if scenario == "strict":
            text = '{"answer":"strict-ok"}'
        if scenario == "tool" and not _has_tool_result(payload):
            tool_name = _first_function_name(payload)
            if tool_name is None:
                self._send_json(400, {"error": {"code": "invalid_tool_fixture_request"}})
                return
            if provider == "openai":
                self._send_openai_responses_tool(model, tool_name)
            elif provider == "anthropic":
                self._send_anthropic_tool(model, tool_name)
            elif provider == "gemini":
                self._send_gemini_tool(model, tool_name)
            else:
                self._send_openai_chat_tool(provider, model, tool_name)
            return
        if scenario == "tool":
            if not _has_model_tool_continuation(provider, payload):
                self._send_json(400, {"error": {"code": "tool_continuation_fixture_mismatch"}})
                return
            text = f"provider:{provider}:tool-ok"
        if provider == "openai":
            self._send_openai_responses_text(model, text)
        elif provider == "anthropic":
            self._send_anthropic_text(model, text)
        elif provider == "gemini":
            self._send_gemini_text(model, text)
        else:
            self._send_openai_chat_text(model, text)

    def _send_openai_responses_text(self, model: str, text: str) -> None:
        item = {
            "id": "msg_fixture",
            "type": "message",
            "role": "assistant",
            "status": "completed",
            "content": [{"type": "output_text", "text": text, "annotations": []}],
        }
        self._send_sse(
            (
                ("response.created", _openai_created(model)),
                (
                    "response.output_text.delta",
                    {
                        "type": "response.output_text.delta",
                        "sequence_number": 1,
                        "output_index": 0,
                        "item_id": "msg_fixture",
                        "content_index": 0,
                        "logprobs": [],
                        "delta": text,
                    },
                ),
                (
                    "response.output_item.done",
                    {
                        "type": "response.output_item.done",
                        "sequence_number": 2,
                        "output_index": 0,
                        "item": item,
                    },
                ),
                ("response.completed", _openai_completed(model, [item], sequence=3)),
            ),
            headers={"x-request-id": "req-openai-fixture"},
        )

    def _send_openai_responses_tool(self, model: str, tool_name: str) -> None:
        item = {
            "id": "fc_fixture",
            "type": "function_call",
            "call_id": "call_fixture",
            "name": tool_name,
            "arguments": '{"query":"fixture"}',
            "status": "completed",
        }
        self._send_sse(
            (
                ("response.created", _openai_created(model)),
                (
                    "response.output_item.added",
                    {
                        "type": "response.output_item.added",
                        "sequence_number": 1,
                        "output_index": 0,
                        "item": {**item, "arguments": ""},
                    },
                ),
                (
                    "response.function_call_arguments.delta",
                    {
                        "type": "response.function_call_arguments.delta",
                        "sequence_number": 2,
                        "output_index": 0,
                        "item_id": "fc_fixture",
                        "delta": '{"query":"fixture"}',
                    },
                ),
                (
                    "response.output_item.done",
                    {
                        "type": "response.output_item.done",
                        "sequence_number": 3,
                        "output_index": 0,
                        "item": item,
                    },
                ),
                ("response.completed", _openai_completed(model, [item], sequence=4)),
            ),
            headers={"x-request-id": "req-openai-fixture"},
        )

    def _send_anthropic_tool(self, model: str, tool_name: str) -> None:
        self._send_sse(
            (
                (
                    "message_start",
                    {
                        "type": "message_start",
                        "message": {
                            "id": "msg_anthropic_fixture",
                            "type": "message",
                            "role": "assistant",
                            "content": [],
                            "model": model,
                            "stop_reason": None,
                            "stop_sequence": None,
                            "usage": {"input_tokens": 3, "output_tokens": 0},
                        },
                    },
                ),
                (
                    "content_block_start",
                    {
                        "type": "content_block_start",
                        "index": 0,
                        "content_block": {"type": "thinking", "thinking": "", "signature": ""},
                    },
                ),
                (
                    "content_block_delta",
                    {
                        "type": "content_block_delta",
                        "index": 0,
                        "delta": {"type": "thinking_delta", "thinking": "fixture reasoning"},
                    },
                ),
                (
                    "content_block_delta",
                    {
                        "type": "content_block_delta",
                        "index": 0,
                        "delta": {"type": "signature_delta", "signature": "sig-fixture"},
                    },
                ),
                ("content_block_stop", {"type": "content_block_stop", "index": 0}),
                (
                    "content_block_start",
                    {
                        "type": "content_block_start",
                        "index": 1,
                        "content_block": {
                            "type": "tool_use",
                            "id": "toolu_fixture",
                            "name": tool_name,
                            "input": {},
                        },
                    },
                ),
                (
                    "content_block_delta",
                    {
                        "type": "content_block_delta",
                        "index": 1,
                        "delta": {
                            "type": "input_json_delta",
                            "partial_json": '{"query":"fixture"}',
                        },
                    },
                ),
                ("content_block_stop", {"type": "content_block_stop", "index": 1}),
                (
                    "message_delta",
                    {
                        "type": "message_delta",
                        "delta": {"stop_reason": "tool_use", "stop_sequence": None},
                        "usage": {"output_tokens": 2},
                    },
                ),
                ("message_stop", {"type": "message_stop"}),
            ),
            headers={"request-id": "req-anthropic-fixture"},
        )

    def _send_gemini_tool(self, model: str, tool_name: str) -> None:
        self._send_sse(
            (
                (
                    None,
                    {
                        "candidates": [
                            {
                                "content": {
                                    "role": "model",
                                    "parts": [
                                        {
                                            "functionCall": {
                                                "name": tool_name,
                                                "args": {"query": "fixture"},
                                            },
                                            "thoughtSignature": "c2ln",
                                        }
                                    ],
                                },
                                "finishReason": "STOP",
                            }
                        ],
                        "modelVersion": model,
                        "usageMetadata": {
                            "promptTokenCount": 3,
                            "candidatesTokenCount": 2,
                            "totalTokenCount": 5,
                        },
                    },
                ),
            )
        )

    def _send_openai_chat_tool(self, provider: str, model: str, tool_name: str) -> None:
        native_reasoning: dict[str, object]
        if provider == "openrouter":
            native_reasoning = {
                "reasoning_details": [
                    {
                        "type": "reasoning.encrypted",
                        "data": "fixture-reasoning",
                        "index": 0,
                    }
                ]
            }
        else:
            native_reasoning = {"reasoning_content": "fixture reasoning"}
        self._send_sse(
            (
                (
                    None,
                    {
                        "id": f"chatcmpl-{provider}-tool-fixture",
                        "object": "chat.completion.chunk",
                        "created": 1,
                        "model": model,
                        "choices": [
                            {
                                "index": 0,
                                "delta": {
                                    "role": "assistant",
                                    **native_reasoning,
                                    "tool_calls": [
                                        {
                                            "index": 0,
                                            "id": "call_fixture",
                                            "type": "function",
                                            "function": {
                                                "name": tool_name,
                                                "arguments": '{"query":"fixture"}',
                                            },
                                        }
                                    ],
                                },
                                "finish_reason": None,
                            }
                        ],
                    },
                ),
                (
                    None,
                    {
                        "id": f"chatcmpl-{provider}-tool-fixture",
                        "object": "chat.completion.chunk",
                        "created": 1,
                        "model": model,
                        "choices": [
                            {
                                "index": 0,
                                "delta": {},
                                "finish_reason": "tool_calls",
                            }
                        ],
                        "usage": {
                            "prompt_tokens": 3,
                            "completion_tokens": 2,
                            "total_tokens": 5,
                        },
                    },
                ),
                (None, "[DONE]"),
            )
        )

    def _send_anthropic_text(self, model: str, text: str) -> None:
        self._send_sse(
            (
                (
                    "message_start",
                    {
                        "type": "message_start",
                        "message": {
                            "id": "msg_anthropic_fixture",
                            "type": "message",
                            "role": "assistant",
                            "content": [],
                            "model": model,
                            "stop_reason": None,
                            "stop_sequence": None,
                            "usage": {"input_tokens": 3, "output_tokens": 0},
                        },
                    },
                ),
                (
                    "content_block_start",
                    {
                        "type": "content_block_start",
                        "index": 0,
                        "content_block": {"type": "text", "text": ""},
                    },
                ),
                (
                    "content_block_delta",
                    {
                        "type": "content_block_delta",
                        "index": 0,
                        "delta": {"type": "text_delta", "text": text},
                    },
                ),
                ("content_block_stop", {"type": "content_block_stop", "index": 0}),
                (
                    "message_delta",
                    {
                        "type": "message_delta",
                        "delta": {"stop_reason": "end_turn", "stop_sequence": None},
                        "usage": {"output_tokens": 2},
                    },
                ),
                ("message_stop", {"type": "message_stop"}),
            ),
            headers={"request-id": "req-anthropic-fixture"},
        )

    def _send_gemini_text(self, model: str, text: str) -> None:
        self._send_sse(
            (
                (
                    None,
                    {
                        "candidates": [
                            {
                                "content": {"role": "model", "parts": [{"text": text}]},
                                "finishReason": "STOP",
                            }
                        ],
                        "modelVersion": model,
                        "usageMetadata": {
                            "promptTokenCount": 3,
                            "candidatesTokenCount": 2,
                            "totalTokenCount": 5,
                        },
                    },
                ),
            )
        )

    def _send_openai_chat_text(self, model: str, text: str) -> None:
        self._send_sse(
            (
                (
                    None,
                    {
                        "id": "chatcmpl-fixture",
                        "object": "chat.completion.chunk",
                        "created": 1,
                        "model": model,
                        "choices": [
                            {
                                "index": 0,
                                "delta": {"role": "assistant", "content": text},
                                "finish_reason": None,
                            }
                        ],
                    },
                ),
                (
                    None,
                    {
                        "id": "chatcmpl-fixture",
                        "object": "chat.completion.chunk",
                        "created": 1,
                        "model": model,
                        "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
                        "usage": {
                            "prompt_tokens": 3,
                            "completion_tokens": 2,
                            "total_tokens": 5,
                        },
                    },
                ),
                (None, "[DONE]"),
            )
        )

    def _read_payload(self) -> object | None:
        raw_length = self.headers.get("content-length", "")
        if not raw_length.isdecimal() or not 1 <= int(raw_length) <= _MAX_REQUEST_BYTES:
            self._send_json(413, {"error": {"code": "invalid_request_size"}})
            return None
        try:
            return json.loads(self.rfile.read(int(raw_length)))
        except (UnicodeDecodeError, json.JSONDecodeError):
            self._send_json(400, {"error": {"code": "invalid_json"}})
            return None

    def _send_json(self, status: int, payload: object) -> None:
        body = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.send_header("connection", "close")
        self.end_headers()
        self.wfile.write(body)

    def _send_sse(
        self,
        frames: tuple[tuple[str | None, object], ...],
        *,
        headers: dict[str, str] | None = None,
    ) -> None:
        chunks: list[bytes] = []
        for event, payload in frames:
            if event is not None:
                chunks.append(f"event: {event}\n".encode())
            data = (
                payload if isinstance(payload, str) else json.dumps(payload, separators=(",", ":"))
            )
            chunks.append(f"data: {data}\n\n".encode())
        body = b"".join(chunks)
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.send_header("content-length", str(len(body)))
        self.send_header("connection", "close")
        for name, value in (headers or {}).items():
            self.send_header(name, value)
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format: str, *args: object) -> None:
        _ = format, args


def _redact_secret_isolation_sentinels(value: object) -> object:
    if isinstance(value, str):
        redacted = value
        for sentinel in GENERATION_SECRET_ISOLATION_SENTINELS.values():
            redacted = redacted.replace(sentinel, "[REDACTED]")
        return redacted
    if isinstance(value, dict):
        return {
            _redact_secret_isolation_sentinels(key): _redact_secret_isolation_sentinels(child)
            for key, child in value.items()
        }
    if isinstance(value, list):
        return [_redact_secret_isolation_sentinels(child) for child in value]
    return value


def _provider_identity(path: str, payload: dict[str, object]) -> tuple[str | None, str | None]:
    model = payload.get("model")
    if not isinstance(model, str):
        marker = "/models/"
        if marker in path:
            model = path.split(marker, 1)[1].split(":", 1)[0]
    if not isinstance(model, str) or not model:
        return None, None
    if model.startswith("gpt-"):
        provider = "openai"
    elif model.startswith("claude-"):
        provider = "anthropic"
    elif model.startswith("gemini-"):
        provider = "gemini"
    elif model == "kimi-k3":
        provider = "moonshot"
    elif model.startswith("moonshotai/"):
        provider = "openrouter"
    elif model.startswith("deepseek-"):
        provider = "deepseek"
    elif model.startswith("grok-"):
        provider = "xai"
    else:
        return None, None
    return provider, model


def _canonical_path(provider: str, path: str) -> bool:
    path_only = path.partition("?")[0]
    if provider == "openai":
        return path_only == "/v1/responses"
    if provider == "anthropic":
        return path_only == "/v1/messages"
    if provider == "gemini":
        return path_only.startswith("/v1beta/models/") and path_only.endswith(
            ":streamGenerateContent"
        )
    if provider in {"moonshot", "xai"}:
        return path_only == "/v1/chat/completions"
    if provider == "openrouter":
        return path_only == "/api/v1/chat/completions"
    if provider == "deepseek":
        return path_only == "/chat/completions"
    return False


def _walk(value: object) -> tuple[object, ...]:
    found = [value]
    if isinstance(value, dict):
        for child in value.values():
            found.extend(_walk(child))
    elif isinstance(value, list):
        for child in value:
            found.extend(_walk(child))
    return tuple(found)


def _fixture_marker(payload: dict[str, object], prefix: str) -> str | None:
    for value in _walk(payload):
        if isinstance(value, str) and prefix in value:
            return value.split(prefix, 1)[1].split(maxsplit=1)[0]
    return None


def _scenario(payload: dict[str, object]) -> str | None:
    scenario = _fixture_marker(payload, "NEXUS_PROVIDER_SCENARIO=")
    return scenario if scenario in {"text", "strict", "tool"} else None


def _provider_row(provider: str, model: str) -> object | None:
    from provider_runtime.registry import api_model_catalog

    return next(
        (
            row
            for row in api_model_catalog().models
            if row.provider == provider and row.dispatch.model_id == model
        ),
        None,
    )


def _plain_json(value: object) -> object:
    if isinstance(value, Mapping):
        return {str(key): _plain_json(child) for key, child in value.items()}
    if isinstance(value, tuple | list):
        return [_plain_json(child) for child in value]
    return value


def _mapping_contains(actual: object, expected: object) -> bool:
    if isinstance(expected, dict):
        return isinstance(actual, dict) and all(
            key in actual and _mapping_contains(actual[key], child)
            for key, child in expected.items()
        )
    if isinstance(expected, list):
        return (
            isinstance(actual, list)
            and len(actual) == len(expected)
            and all(
                _mapping_contains(actual_child, expected_child)
                for actual_child, expected_child in zip(actual, expected, strict=True)
            )
        )
    return actual == expected


def _has_exact_reasoning_wire(
    *,
    provider: str,
    model: str,
    reasoning: str,
    payload: dict[str, object],
) -> bool:
    row = _provider_row(provider, model)
    if row is None:
        return False
    reasoning_rows = getattr(row, "reasoning", ())
    selected = next((item for item in reasoning_rows if item.key == reasoning), None)
    if selected is None:
        return False
    expected = _plain_json(selected.native_wire_fragment)
    if row.dispatch.engine == "gemini_generate":
        if not isinstance(expected, dict) or set(expected) != {"thinking_config"}:
            return False
        thinking_config = expected["thinking_config"]
        if (
            not isinstance(thinking_config, dict)
            or set(thinking_config) != {"thinking_level"}
            or not isinstance(thinking_config["thinking_level"], str)
        ):
            return False
        # google-genai validates the registry fragment as typed config, then
        # serializes the enum value in its protocol spelling.  Keep this peer
        # independent of that SDK so a serializer drift breaks qualification.
        expected_wire = {
            "thinkingConfig": {
                "thinking_level": thinking_config["thinking_level"].upper(),
            }
        }
        return _mapping_contains(payload.get("generationConfig"), expected_wire)
    return _mapping_contains(payload, expected)


def _has_strict_output_wire(
    *,
    provider: str,
    model: str,
    payload: dict[str, object],
) -> bool:
    row = _provider_row(provider, model)
    if row is None:
        return False
    engine = row.dispatch.engine
    if engine == "openai_responses":
        text = payload.get("text")
        return isinstance(text, dict) and _mapping_contains(
            text.get("format"),
            {"type": "json_schema", "strict": True},
        )
    if engine == "anthropic_messages":
        output_config = payload.get("output_config")
        return isinstance(output_config, dict) and _mapping_contains(
            output_config.get("format"),
            {"type": "json_schema"},
        )
    if engine == "gemini_generate":
        config = payload.get("generationConfig")
        return (
            isinstance(config, dict)
            and config.get("responseMimeType") == "application/json"
            and isinstance(config.get("responseJsonSchema"), dict)
        )
    if engine == "openai_chat":
        response_format = payload.get("response_format")
        expected_type = "json_schema" if row.structured.kind == "native" else "json_object"
        return isinstance(response_format, dict) and response_format.get("type") == expected_type
    return False


def _dict_values(payload: dict[str, object]) -> tuple[dict[str, object], ...]:
    return tuple(value for value in _walk(payload) if isinstance(value, dict))


def _has_model_tool_continuation(provider: str, payload: dict[str, object]) -> bool:
    values = _dict_values(payload)
    if provider == "openai":
        return any(
            value.get("type") == "function_call" and value.get("call_id") == "call_fixture"
            for value in values
        ) and any(value.get("type") == "function_call_output" for value in values)
    if provider == "anthropic":
        return (
            any(
                value.get("type") == "thinking" and value.get("signature") == "sig-fixture"
                for value in values
            )
            and any(
                value.get("type") == "tool_use" and value.get("id") == "toolu_fixture"
                for value in values
            )
            and any(value.get("type") == "tool_result" for value in values)
        )
    if provider == "gemini":
        return any(
            value.get("thoughtSignature") == "c2ln" and "functionCall" in value for value in values
        ) and any("functionResponse" in value for value in values)
    assistant = next(
        (
            value
            for value in values
            if value.get("role") == "assistant" and isinstance(value.get("tool_calls"), list)
        ),
        None,
    )
    if assistant is None or not any(value.get("role") == "tool" for value in values):
        return False
    if provider == "openrouter":
        return isinstance(assistant.get("reasoning_details"), list)
    if provider in {"moonshot", "deepseek"}:
        return assistant.get("reasoning_content") == "fixture reasoning"
    return provider == "xai"


def _has_tool_result(payload: dict[str, object]) -> bool:
    for value in _walk(payload):
        if not isinstance(value, dict):
            continue
        if value.get("type") in {"function_call_output", "tool_result", "functionResponse"}:
            return True
        if value.get("role") == "tool":
            return True
        if "functionResponse" in value or "function_response" in value:
            return True
    return False


def _first_function_name(payload: dict[str, object]) -> str | None:
    for value in _walk(payload.get("tools", [])):
        if not isinstance(value, dict):
            continue
        if value.get("type") == "function" and isinstance(value.get("name"), str):
            return cast(str, value["name"])
        function = value.get("function")
        if isinstance(function, dict) and isinstance(function.get("name"), str):
            return cast(str, function["name"])
        if isinstance(value.get("name"), str) and any(
            key in value
            for key in (
                "input_schema",
                "parameters",
                "parameters_json_schema",
                "parametersJsonSchema",
            )
        ):
            return cast(str, value["name"])
    return None


def _openai_created(model: str) -> dict[str, object]:
    return {
        "type": "response.created",
        "sequence_number": 0,
        "response": {"id": "resp_fixture", "status": "in_progress", "model": model},
    }


def _openai_completed(
    model: str, output: list[dict[str, object]], *, sequence: int
) -> dict[str, object]:
    return {
        "type": "response.completed",
        "sequence_number": sequence,
        "response": {
            "id": "resp_fixture",
            "object": "response",
            "created_at": 1,
            "status": "completed",
            "model": model,
            "output": output,
            "parallel_tool_calls": True,
            "tool_choice": "auto",
            "tools": [],
            "usage": {
                "input_tokens": 3,
                "output_tokens": 2,
                "total_tokens": 5,
                "input_tokens_details": {"cached_tokens": 0},
                "output_tokens_details": {"reasoning_tokens": 0},
            },
        },
    }


def create_server(
    *,
    port: int,
    certificate: Path,
    key: Path,
    audit: Path,
) -> _ProviderApiServer:
    if not 1 <= port <= 65_535:
        raise ValueError("port must be between 1 and 65535")
    return _ProviderApiServer(port, certificate, key, audit)


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
