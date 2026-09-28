"""The wire schema: FastAPI's OpenAPI document plus the SSE event payload models.

``python -m nexus.wire_schema`` prints it as sorted JSON; ``bun run gen:wire`` in
apps/web renders it to ``src/lib/api/wire.gen.ts``. It is built from the routers,
not the app, so it needs no settings, database, network or secrets.
"""

import json

from fastapi.encoders import jsonable_encoder
from fastapi.openapi.models import Components
from fastapi.openapi.utils import get_openapi
from pydantic.json_schema import models_json_schema

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
    ChatRunDoneEventPayload,
    ChatRunMetaEventPayload,
)
from nexus.schemas.execution import ChatRunExecutionOut, DurableExecutionOut
from nexus.schemas.oracle import (
    OracleBindEventPayload,
    OracleCompleteDoneEventPayload,
    OracleFailedDoneEventPayload,
    OracleMetaEventPayload,
    OracleOmensEventPayload,
    OracleReadingImageOut,
    OracleTextEventPayload,
)
from nexus.schemas.podcast import PodcastSubscriptionLifecycleSnapshotOut

# Every model whose JSON is an SSE `data:` frame as-is (api/routes/stream.py),
# split by how the stream dumps it. Not listed: chat tool_* payloads (the read
# path strips their audit fields, so no model is the wire), the media snapshot
# (a hand-built dict), and the chat citation_index / context_ref_added and oracle
# passage payloads, which nest ResourceActivationOut by field name while typed
# routes emit it by alias (ticket resource-activation-has-two-wire-casings).
SSE_PAYLOADS_BY_NAME = (
    ChatRunMetaEventPayload,
    ChatRunAssistantActivityEventPayload,
    ChatRunAssistantTextDeltaEventPayload,
    ChatRunDoneEventPayload,
    ChatRunExecutionOut,
    DurableExecutionOut,
    OracleMetaEventPayload,
    OracleBindEventPayload,
    OracleTextEventPayload,
    OracleReadingImageOut,
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
    schema = get_openapi(title="Nexus API", version="0.1.0", routes=router.routes)
    components = schema["components"]["schemas"]
    for models, by_alias in ((SSE_PAYLOADS_BY_NAME, False), (SSE_PAYLOADS_BY_ALIAS, True)):
        _, definitions = models_json_schema(
            [(model, "serialization") for model in models],
            by_alias=by_alias,
            ref_template="#/components/schemas/{model}",
        )
        # Normalized the way get_openapi normalizes its own, so equal schemas compare equal.
        normalized = jsonable_encoder(
            Components(schemas=definitions["$defs"]), by_alias=True, exclude_none=True
        )["schemas"]
        for name, definition in normalized.items():
            if components.setdefault(name, definition) != definition:
                raise ValueError(f"two different schemas are named {name}")
    return schema


if __name__ == "__main__":
    print(json.dumps(wire_schema(), indent=1, sort_keys=True, ensure_ascii=False))
