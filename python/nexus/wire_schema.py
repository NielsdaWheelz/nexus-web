"""The wire schema: FastAPI's OpenAPI document plus the SSE event payload models.

``python -m nexus.wire_schema`` prints it as sorted JSON; ``bun run gen:wire`` in
apps/web renders it to ``src/lib/api/wire.gen.ts``. It is built from the routers,
not the app, so it needs no settings, database, network or secrets.
"""

import json
from typing import Any

from fastapi._compat import (
    ModelField,
    get_definitions,
    get_flat_models_from_fields,
    get_model_name_map,
)
from fastapi.encoders import jsonable_encoder
from fastapi.openapi.models import OpenAPI
from fastapi.openapi.utils import get_fields_from_routes, get_openapi_path
from fastapi.routing import APIRoute
from pydantic.fields import FieldInfo

from nexus.api.routes import create_api_router
from nexus.schemas.artifact import (
    CancelledEventPayload,
    FailedEventPayload,
    ProgressEventPayload,
    StartedEventPayload,
    SucceededEventPayload,
)
from nexus.schemas.conversation import (
    ChatRunAssistantActivityEventPayload,
    ChatRunAssistantTextDeltaEventPayload,
    ChatRunCitationIndexEventPayload,
    ChatRunContextRefAddedEventPayload,
    ChatRunDoneEventPayload,
    ChatRunMetaEventPayload,
    ChatRunToolCallDoneEventOut,
    ChatRunToolCallStartEventOut,
    ChatRunToolResultEventOut,
)
from nexus.schemas.execution import ChatRunExecutionOut, DurableExecutionOut
from nexus.schemas.media import MediaProcessingSnapshotOut
from nexus.schemas.metadata_enrichment import MetadataEnrichmentView
from nexus.schemas.oracle import (
    OracleBindEventPayload,
    OracleCompleteDoneEventPayload,
    OracleFailedDoneEventPayload,
    OracleMetaEventPayload,
    OracleOmensEventPayload,
    OracleReadingImageOut,
    OracleReadingPassageOut,
    OracleTextEventPayload,
)
from nexus.schemas.podcast import PodcastSubscriptionLifecycleSnapshotOut

# Every model whose JSON is an SSE `data:` frame as-is (api/routes/stream.py),
# split by how the stream dumps it. Tool events use their public projections;
# stored audit models never describe the wire.
SSE_PAYLOADS_BY_NAME = (
    MediaProcessingSnapshotOut,
    MetadataEnrichmentView,
    ChatRunMetaEventPayload,
    ChatRunToolCallDoneEventOut,
    ChatRunToolCallStartEventOut,
    ChatRunToolResultEventOut,
    ChatRunAssistantActivityEventPayload,
    ChatRunAssistantTextDeltaEventPayload,
    ChatRunDoneEventPayload,
    ChatRunCitationIndexEventPayload,
    ChatRunContextRefAddedEventPayload,
    ChatRunExecutionOut,
    DurableExecutionOut,
    OracleMetaEventPayload,
    OracleBindEventPayload,
    OracleTextEventPayload,
    OracleReadingImageOut,
    OracleReadingPassageOut,
    OracleOmensEventPayload,
    OracleCompleteDoneEventPayload,
    OracleFailedDoneEventPayload,
    StartedEventPayload,
    ProgressEventPayload,
    SucceededEventPayload,
    FailedEventPayload,
    CancelledEventPayload,
)
SSE_PAYLOADS_BY_ALIAS = (PodcastSubscriptionLifecycleSnapshotOut,)


def wire_schema() -> dict:
    router = create_api_router(podcasts=True, email_ingest=True)
    fields = get_fields_from_routes(router.routes)
    # current by-name SSE models have no aliased fields, including nested models.
    # one native batch coordinates their refs with HTTP's input/output schemas.
    fields.extend(
        ModelField(
            field_info=FieldInfo(annotation=model),
            name=model.__name__,
            mode="serialization",
        )
        for model in SSE_PAYLOADS_BY_NAME + SSE_PAYLOADS_BY_ALIAS
    )
    flat_models = get_flat_models_from_fields(fields, known_models=set())
    model_name_map = get_model_name_map(flat_models)
    field_mapping, definitions = get_definitions(fields=fields, model_name_map=model_name_map)
    paths: dict[str, dict[str, Any]] = {}
    security_schemes: dict[str, Any] = {}
    operation_ids: set[str] = set()
    for route in router.routes:
        if not isinstance(route, APIRoute):
            continue
        result = get_openapi_path(
            route=route,
            operation_ids=operation_ids,
            model_name_map=model_name_map,
            field_mapping=field_mapping,
        )
        if result:
            path, security, path_definitions = result
            if path:
                paths.setdefault(route.path_format, {}).update(path)
            security_schemes.update(security)
            definitions.update(path_definitions)
    components: dict[str, dict[str, Any]] = {
        "schemas": {name: definitions[name] for name in sorted(definitions)}
    }
    if security_schemes:
        components["securitySchemes"] = security_schemes
    return jsonable_encoder(
        OpenAPI.model_validate(
            {
                "openapi": "3.1.0",
                "info": {"title": "Nexus API", "version": "0.1.0"},
                "paths": paths,
                "components": components,
            }
        ),
        by_alias=True,
        exclude_none=True,
    )


if __name__ == "__main__":
    print(json.dumps(wire_schema(), indent=1, sort_keys=True, ensure_ascii=False))
