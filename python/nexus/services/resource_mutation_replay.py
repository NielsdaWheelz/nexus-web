"""Shared replay-ledger mechanics for ``resource_mutations`` (spec
lectern-player-lifecycle-hard-cutover.md §5).

Every command surface keyed by one bounded ``clientMutationId`` shares this
lookup/record shape: same ``(viewer_id, mutation_scope, client_mutation_id)``
key with the same request bytes returns the memoized response without
writing; the same key with different request bytes is
``ConflictError(E_IDEMPOTENCY_KEY_REPLAY_MISMATCH)``.

This module owns hashing, lookup, mismatch classification, and recording. It
deliberately does NOT own the request-to-bytes dump choice: each caller
produces its own canonical payload (``by_alias=True`` or ``False``, a
BaseModel dump, or a hand-built dict) and passes it through
``canonical_json_bytes``, then hands the resulting bytes to ``lookup_replay``/
``record_replay``. Keeping that choice at the caller is what keeps every
existing scope's stored ``request_hash`` byte-for-byte identical to its
pre-extraction value.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping
from typing import Any
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from nexus.db.models import ResourceMutation
from nexus.errors import ApiErrorCode, ConflictError


def canonical_json_bytes(payload: Mapping[str, Any]) -> bytes:
    """Sort keys, use compact separators, encode UTF-8: the one dump basis
    every existing replay scope already hashed against."""
    return json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")


def lookup_replay(
    db: Session,
    *,
    viewer_id: UUID,
    scope: str,
    client_mutation_id: str,
    request_bytes: bytes,
) -> dict[str, object] | None:
    """Return the memoized response for an exact replay, or ``None`` on first sight.

    A matching key with a different request hash is reuse-with-different-payload:
    it raises ``ConflictError(E_IDEMPOTENCY_KEY_REPLAY_MISMATCH)``. The caller
    re-validates the returned dict into its own response model before serving it.
    """
    memo = db.scalar(
        select(ResourceMutation).where(
            ResourceMutation.user_id == viewer_id,
            ResourceMutation.mutation_scope == scope,
            ResourceMutation.client_mutation_id == client_mutation_id,
        )
    )
    if memo is None:
        return None
    if memo.request_hash != hashlib.sha256(request_bytes).hexdigest():
        raise ConflictError(
            ApiErrorCode.E_IDEMPOTENCY_KEY_REPLAY_MISMATCH,
            "Resource mutation id was reused with a different request",
        )
    return memo.response_json


def record_replay(
    db: Session,
    *,
    viewer_id: UUID,
    scope: str,
    client_mutation_id: str,
    request_bytes: bytes,
    response_json: dict[str, object],
    changed_lanes: dict[str, object],
) -> None:
    """Add (not commit) the memo row so a future exact replay is a pure read.

    The caller commits, alongside its own domain writes, in the same
    transaction attempt.
    """
    db.add(
        ResourceMutation(
            user_id=viewer_id,
            mutation_scope=scope,
            client_mutation_id=client_mutation_id,
            request_hash=hashlib.sha256(request_bytes).hexdigest(),
            changed_lanes=changed_lanes,
            response_json=response_json,
        )
    )
