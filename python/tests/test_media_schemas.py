from uuid import uuid4

import pytest
from pydantic import ValidationError

from nexus.schemas.media import (
    ArticleCaptureResponse,
    FromUrlResponse,
    MediaOut,
    TranscriptRequestResponse,
)


@pytest.mark.parametrize(
    ("schema", "payload"),
    [
        (
            MediaOut,
            {
                "id": uuid4(),
                "kind": "web_article",
                "title": "Test",
                "canonical_source_url": None,
                "capabilities": {
                    "can_read": False,
                    "can_highlight": False,
                    "can_quote": False,
                    "can_search": False,
                    "can_play": False,
                    "can_download_file": False,
                    "can_delete": False,
                    "can_retry": False,
                    "can_refresh_source": False,
                    "can_retry_metadata": False,
                },
                "created_at": "2026-06-05T00:00:00Z",
                "updated_at": "2026-06-05T00:00:00Z",
            },
        ),
        (
            ArticleCaptureResponse,
            {
                "media_id": uuid4(),
                "source_attempt_id": uuid4(),
                "source_type": "web_article",
                "source_attempt_status": "queued",
                "idempotency_outcome": "created",
                "ingest_enqueued": True,
            },
        ),
        (
            TranscriptRequestResponse,
            {
                "media_id": str(uuid4()),
                "transcript_state": "pending",
                "transcript_coverage": "none",
                "request_reason": "search",
                "required_minutes": 1,
                "remaining_minutes": 10,
                "fits_budget": True,
                "request_enqueued": True,
            },
        ),
        (
            FromUrlResponse,
            {
                "media_id": uuid4(),
                "source_attempt_id": uuid4(),
                "source_type": "web_article",
                "source_attempt_status": "queued",
                "idempotency_outcome": "created",
                "ingest_enqueued": True,
            },
        ),
    ],
)
@pytest.mark.parametrize("status", ["embedding", "ready"])
def test_media_processing_response_schemas_reject_legacy_statuses(
    schema,
    payload,
    status,
):
    with pytest.raises(ValidationError):
        schema.model_validate({**payload, "processing_status": status})
