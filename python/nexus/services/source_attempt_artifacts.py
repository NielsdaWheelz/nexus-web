"""Which storage objects a source-attempt payload owns."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

_ATTEMPT_LOCAL_KEYS = ("source_storage_path", "arxiv_source_package")


def source_attempt_storage_paths(source_payload: Mapping[str, Any] | None) -> list[str]:
    """Storage objects owned or referenced by one source-attempt payload."""
    payload = source_payload or {}
    package = payload.get("arxiv_source_package")
    candidates = [
        payload.get("storage_path"),
        payload.get("source_storage_path"),
        package.get("storage_path") if isinstance(package, Mapping) else None,
    ]
    paths: list[str] = []
    for candidate in candidates:
        path = candidate.strip() if isinstance(candidate, str) else ""
        if path and path not in paths:
            paths.append(path)
    return paths


def clone_source_payload_for_new_attempt(
    source_payload: Mapping[str, Any] | None,
) -> dict[str, Any]:
    """Copy source identity for a retry, dropping the previous attempt's artifacts."""
    payload = dict(source_payload or {})
    for key in _ATTEMPT_LOCAL_KEYS:
        payload.pop(key, None)
    return payload
