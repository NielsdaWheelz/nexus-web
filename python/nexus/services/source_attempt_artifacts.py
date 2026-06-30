"""Source-attempt payload artifact ownership helpers."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

_DERIVED_ARTIFACT_PAYLOAD_KEYS = frozenset({"arxiv_source_package"})


def source_attempt_storage_paths(source_payload: Mapping[str, Any] | None) -> list[str]:
    """Return storage objects owned or referenced by a source-attempt payload."""
    if source_payload is None:
        return []

    storage_paths: list[str] = []
    _append_storage_path(storage_paths, source_payload.get("storage_path"))
    _append_storage_path(storage_paths, source_payload.get("source_storage_path"))
    for key in _DERIVED_ARTIFACT_PAYLOAD_KEYS:
        nested = source_payload.get(key)
        if isinstance(nested, Mapping):
            _append_storage_path(storage_paths, nested.get("storage_path"))
    return storage_paths


def clone_source_payload_for_new_attempt(
    source_payload: Mapping[str, Any] | None,
) -> dict[str, Any]:
    """Copy source identity for retry/refresh without carrying attempt-local artifacts."""
    payload = dict(source_payload or {})
    payload.pop("source_storage_path", None)
    for key in _DERIVED_ARTIFACT_PAYLOAD_KEYS:
        payload.pop(key, None)
    return payload


def _append_storage_path(storage_paths: list[str], value: object) -> None:
    if not isinstance(value, str):
        return
    storage_path = value.strip()
    if storage_path and storage_path not in storage_paths:
        storage_paths.append(storage_path)
