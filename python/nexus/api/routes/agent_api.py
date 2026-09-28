"""Execution-private, bearer-scoped generation operations."""

from __future__ import annotations

import json
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import JSONResponse
from llm_tools import SchemaDecodeError, ToolId, validate_tool_input
from sqlalchemy.orm import Session

from nexus.auth.middleware import Viewer, get_viewer
from nexus.db.session import get_db, get_session_factory
from nexus.services.agent_api import (
    AgentApiRefusal,
    authenticate_generation_api,
    execute_operation,
    list_generation_api_effects,
    undo_generation_api_position,
)
from nexus.services.tool_runtime.catalog import (
    FrozenToolOperation,
    required_agent_api_operation,
)

router = APIRouter(prefix="/agent-api", tags=["generation-api"])
user_router = APIRouter(tags=["generation-effects"])

_IDS = (
    "web.search",
    "web.read",
    "nexus.search",
    "nexus.resource.read",
    "nexus.document.search",
    "nexus.resource.inspect",
    "nexus.relations.list",
    "nexus.library.add",
    "nexus.note.create",
    "nexus.highlight.create",
    "nexus.edge.create",
    "nexus.queue.add",
)
_EXAMPLES: dict[str, dict[str, object]] = {
    "web.search": {"query": "history of the printing press", "freshness_days": None},
    "web.read": {"url": "https://example.org/article"},
    "nexus.search": {
        "query": "printing press",
        "kinds": None,
        "formats": None,
        "authors": None,
        "roles": None,
        "scopes": None,
        "limit": None,
    },
    "nexus.resource.read": {"uri": "media:00000000-0000-4000-8000-000000000001"},
    "nexus.document.search": {
        "uri": "media:00000000-0000-4000-8000-000000000001",
        "query": "printing press",
        "limit": None,
    },
    "nexus.resource.inspect": {"uri": "media:00000000-0000-4000-8000-000000000001"},
    "nexus.relations.list": {
        "uri": "media:00000000-0000-4000-8000-000000000001",
        "direction": "both",
        "kinds": None,
        "limit": None,
    },
    "nexus.library.add": {
        "library_id": None,
        "library_name": "Reading",
        "resource_uri": "media:00000000-0000-4000-8000-000000000001",
    },
    "nexus.note.create": {"markdown": "A useful observation.", "page_uri": None},
    "nexus.highlight.create": {
        "color": None,
        "exact": "The exact sentence to highlight.",
        "media_uri": "media:00000000-0000-4000-8000-000000000001",
        "note": None,
        "prefix": None,
        "suffix": None,
    },
    "nexus.edge.create": {
        "kind": None,
        "rationale": "These works discuss the same event.",
        "source_uri": "media:00000000-0000-4000-8000-000000000001",
        "target_uri": "media:00000000-0000-4000-8000-000000000002",
    },
    "nexus.queue.add": {"media_uri": "media:00000000-0000-4000-8000-000000000001"},
}


def _operation(request: Request) -> FrozenToolOperation:
    runtime = getattr(request.app.state, "tool_runtime", None)
    if runtime is None:
        raise RuntimeError("generation API tool runtime is not initialized")
    return required_agent_api_operation(runtime)


def _bearer(request: Request) -> str:
    header = request.headers.get("authorization", "")
    prefix = "Bearer "
    if not header.startswith(prefix) or not header[len(prefix) :] or " " in header[len(prefix) :]:
        raise AgentApiRefusal(401, "invalid_bearer")
    return header[len(prefix) :]


def _error(error: AgentApiRefusal) -> JSONResponse:
    return JSONResponse(
        status_code=error.status,
        content={"error": {"code": error.code}},
        headers={"Cache-Control": "no-store"},
    )


def _user_error(error: AgentApiRefusal) -> JSONResponse:
    return JSONResponse(
        status_code=error.status,
        content={"error": {"code": error.code, "message": error.code.replace("_", " ")}},
        headers={"Cache-Control": "no-store"},
    )


def _error_response(description: str, *codes: str) -> dict[str, object]:
    return {
        "description": description,
        "content": {
            "application/json": {
                "schema": {
                    "type": "object",
                    "additionalProperties": False,
                    "required": ["error"],
                    "properties": {
                        "error": {
                            "type": "object",
                            "additionalProperties": False,
                            "required": ["code"],
                            "properties": {"code": {"type": "string", "enum": list(codes)}},
                        }
                    },
                },
                "example": {"error": {"code": codes[0]}},
            }
        },
    }


async def _bounded_body(request: Request, *, max_bytes: int) -> bytes:
    announced = request.headers.get("content-length")
    if announced is not None:
        try:
            length = int(announced)
        except ValueError:
            raise AgentApiRefusal(422, "invalid_input") from None
        if length < 0:
            raise AgentApiRefusal(422, "invalid_input")
        if length > max_bytes:
            raise AgentApiRefusal(413, "body_too_large")
    body = bytearray()
    async for chunk in request.stream():
        if len(body) + len(chunk) > max_bytes:
            raise AgentApiRefusal(413, "body_too_large")
        body.extend(chunk)
    return bytes(body)


@router.get("/openapi.json", include_in_schema=False)
def generation_api_spec(request: Request) -> JSONResponse:
    try:
        bearer = _bearer(request)
        with get_session_factory()() as db, db.begin():
            authenticate_generation_api(db, bearer=bearer, require_child=False)
    except AgentApiRefusal as error:
        return _error(error)
    operation = _operation(request)
    paths: dict[str, object] = {}
    for canonical_id in _IDS:
        spec = operation.plan.catalog_view.spec(ToolId(canonical_id))
        limit = operation.plan.grant(ToolId(canonical_id)).limits
        paths[f"/agent-api/operations/{canonical_id}"] = {
            "post": {
                "operationId": canonical_id,
                "summary": spec.summary,
                "description": spec.documentation.text,
                "security": [{"generationBearer": []}],
                "parameters": [
                    {
                        "name": "Idempotency-Key",
                        "in": "header",
                        "required": True,
                        "schema": {"type": "string", "format": "uuid"},
                        "description": "Reuse this UUID after a lost response. A new UUID is a new operation.",
                    }
                ],
                "requestBody": {
                    "required": True,
                    "content": {
                        "application/json": {
                            "schema": spec.input_schema.presentation,
                            "example": _EXAMPLES.get(canonical_id),
                        }
                    },
                },
                "responses": {
                    "200": {
                        "description": "Canonical typed tool result and evidence.",
                        "content": {
                            "application/json": {
                                "schema": {
                                    "type": "object",
                                    "additionalProperties": False,
                                    "required": ["position_id", "result"],
                                    "properties": {
                                        "position_id": {"type": "string", "format": "uuid"},
                                        "result": {
                                            "oneOf": [
                                                {
                                                    "type": "object",
                                                    "additionalProperties": False,
                                                    "required": ["type", "value"],
                                                    "properties": {
                                                        "type": {"const": "Success"},
                                                        "value": spec.success_schema.presentation,
                                                    },
                                                },
                                                {
                                                    "type": "object",
                                                    "additionalProperties": False,
                                                    "required": ["type", "error"],
                                                    "properties": {
                                                        "type": {"const": "Failure"},
                                                        "error": spec.error_schema.presentation,
                                                    },
                                                },
                                            ]
                                        },
                                    },
                                }
                            }
                        },
                    },
                    "401": _error_response("Missing or invalid bearer.", "invalid_bearer"),
                    "409": _error_response(
                        "Inactive run, changed claim, replay mismatch, or unresolved operation.",
                        "inactive_generation",
                        "changed_job_claim",
                        "changed_account",
                        "inactive_child",
                        "replay_mismatch",
                        "operation_in_progress_or_uncertain",
                        "operation_uncertain",
                    ),
                    "404": _error_response("Unknown operation.", "unknown_operation"),
                    "413": _error_response(
                        "Body exceeds this operation's input byte limit.", "body_too_large"
                    ),
                    "422": _error_response(
                        "Body or Idempotency-Key violates its schema.",
                        "invalid_idempotency_key",
                        "invalid_input",
                    ),
                    "503": _error_response(
                        "Declared external dependency is unavailable.", "dependency_unavailable"
                    ),
                },
                "x-nexus-limits": limit.json(),
            }
        }
    document = {
        "openapi": "3.1.0",
        "info": {
            "title": "Nexus generation API",
            "version": operation.definition.authority_revision,
        },
        "paths": paths,
        "components": {
            "securitySchemes": {"generationBearer": {"type": "http", "scheme": "bearer"}}
        },
    }
    return JSONResponse(document, headers={"Cache-Control": "no-store"})


def _make_handler(canonical_id: str):
    async def handler(request: Request) -> JSONResponse:
        try:
            bearer = _bearer(request)
            with get_session_factory()() as db, db.begin():
                authenticate_generation_api(db, bearer=bearer, require_child=True)
            operation = _operation(request)
            grant = operation.plan.grant(ToolId(canonical_id))
            raw_key = request.headers.get("idempotency-key")
            try:
                key = UUID(raw_key or "")
            except ValueError:
                raise AgentApiRefusal(422, "invalid_idempotency_key") from None
            raw = await _bounded_body(request, max_bytes=grant.limits.max_input_bytes)
            try:
                value = validate_tool_input(
                    operation.plan.catalog_view.binding(ToolId(canonical_id)), json.loads(raw)
                )
            except (UnicodeDecodeError, json.JSONDecodeError, SchemaDecodeError):
                raise AgentApiRefusal(422, "invalid_input") from None
            arguments: dict[str, object] = value.model_dump(mode="json")
            result = await execute_operation(
                bearer=bearer,
                canonical_id=canonical_id,
                idempotency_key=key,
                arguments=arguments,
                operation=operation,
                session_factory=get_session_factory(),
            )
            return JSONResponse(result, headers={"Cache-Control": "no-store"})
        except AgentApiRefusal as error:
            return _error(error)

    return handler


for _canonical_id in _IDS:
    router.add_api_route(
        f"/operations/{_canonical_id}",
        _make_handler(_canonical_id),
        methods=["POST"],
        include_in_schema=False,
    )


@router.post("/operations/{canonical_id}", include_in_schema=False)
def unknown_operation(request: Request, canonical_id: str) -> JSONResponse:
    del canonical_id
    try:
        bearer = _bearer(request)
        with get_session_factory()() as db, db.begin():
            authenticate_generation_api(db, bearer=bearer, require_child=True)
    except AgentApiRefusal as error:
        return _error(error)
    return _error(AgentApiRefusal(404, "unknown_operation"))


@user_router.post("/generation-effects/{position_id}/undo")
def undo_background_generation_write(
    position_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> JSONResponse:
    try:
        changed = undo_generation_api_position(
            db, viewer_id=viewer.user_id, position_id=position_id
        )
    except AgentApiRefusal as error:
        return _user_error(error)
    return JSONResponse(
        {"position_id": str(position_id), "reverted": True, "changed": changed},
        headers={"Cache-Control": "no-store"},
    )


@user_router.get("/generation-effects")
def recent_generation_effects(
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
    generation_id: Annotated[UUID | None, Query()] = None,
    before: Annotated[UUID | None, Query()] = None,
) -> JSONResponse:
    try:
        page = list_generation_api_effects(
            db, viewer_id=viewer.user_id, generation_id=generation_id, before=before
        )
    except AgentApiRefusal as error:
        return _user_error(error)
    return JSONResponse(page, headers={"Cache-Control": "no-store"})
