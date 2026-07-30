"""One replay namespace and request encoding for Podcast controls."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any, Final

from nexus.services.resource_mutation_replay import canonical_json_bytes

PODCAST_CONTROL_REPLAY_SCOPE: Final = "podcast:control"


def podcast_control_request_bytes(
    *,
    method: str,
    path: str,
    body: Mapping[str, Any] | None = None,
) -> bytes:
    """Bind one key to the complete canonical Podcast control identity."""
    return canonical_json_bytes(
        {
            "method": method,
            "path": path,
            "body": dict(body) if body is not None else {},
        }
    )
