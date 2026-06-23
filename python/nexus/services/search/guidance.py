"""Disabled generated-guidance metadata for app-search ledgers."""

from __future__ import annotations

from dataclasses import dataclass
from uuid import UUID

from sqlalchemy.orm import Session

RETRIEVAL_GUIDANCE_USAGE_VERSION = "retrieval_guidance_usage.v1"


@dataclass(frozen=True, slots=True)
class AppSearchGuidance:
    query_suffix: str
    metadata: dict[str, object]


def unused_guidance_metadata() -> dict[str, object]:
    return {
        "version": RETRIEVAL_GUIDANCE_USAGE_VERSION,
        "status": "unused",
    }


def load_app_search_guidance(
    db: Session,
    *,
    viewer_id: UUID,
    query_class: str,
    scope_uris: list[str],
) -> AppSearchGuidance:
    del db, viewer_id, query_class, scope_uris
    return AppSearchGuidance("", unused_guidance_metadata())
