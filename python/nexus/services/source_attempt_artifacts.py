"""Which storage objects a source-attempt payload owns."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any


def source_attempt_storage_paths(source_payload: Mapping[str, Any] | None) -> list[str]:
    """Storage objects owned or referenced by one source-attempt payload: the
    input artifact plus, on a legacy browser capture, its original source markup
    (``source_storage_path`` until the one-shot conversion rewrites the payload,
    ``retained_legacy_paths`` afterwards, through the rollback window)."""
    payload = source_payload or {}
    retained = payload.get("retained_legacy_paths")
    candidates = [
        payload.get("storage_path"),
        payload.get("source_storage_path"),
        *(retained if isinstance(retained, list) else []),
    ]
    return [path.strip() for path in candidates if isinstance(path, str) and path.strip()]
