"""Append-only operational events for external providers."""

from __future__ import annotations

import json
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session


def record_external_provider_event(
    db: Session,
    *,
    request_id: str | None,
    source_attempt_id: UUID | None = None,
    viewer_id: UUID | None,
    media_id: UUID | None = None,
    provider: str,
    capability: str,
    operation: str,
    target_ref: str | None,
    status: str,
    api_error_code: str | None = None,
    provider_status_code: int | None = None,
    provider_error_type: str | None = None,
    provider_error_title: str | None = None,
    duration_ms: int | None = None,
    attempt_count: int = 1,
    retry_after_seconds: int | None = None,
    metadata: dict[str, object] | None = None,
) -> None:
    db.execute(
        text(
            """
            INSERT INTO external_provider_events (
                request_id, source_attempt_id, viewer_id, media_id, provider, capability, operation,
                target_ref, status, api_error_code, provider_status_code,
                provider_error_type, provider_error_title, duration_ms, attempt_count,
                retry_after_seconds, metadata
            )
            VALUES (
                :request_id, :source_attempt_id, :viewer_id, :media_id, :provider, :capability, :operation,
                :target_ref, :status, :api_error_code, :provider_status_code,
                :provider_error_type, :provider_error_title, :duration_ms, :attempt_count,
                :retry_after_seconds, CAST(:metadata AS jsonb)
            )
            """
        ),
        {
            "request_id": request_id,
            "source_attempt_id": source_attempt_id,
            "viewer_id": viewer_id,
            "media_id": media_id,
            "provider": provider,
            "capability": capability,
            "operation": operation,
            "target_ref": target_ref,
            "status": status,
            "api_error_code": api_error_code,
            "provider_status_code": provider_status_code,
            "provider_error_type": provider_error_type,
            "provider_error_title": provider_error_title,
            "duration_ms": duration_ms,
            "attempt_count": attempt_count,
            "retry_after_seconds": retry_after_seconds,
            "metadata": json.dumps(metadata or {}),
        },
    )
