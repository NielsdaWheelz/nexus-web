"""Replay memos for the two user-owned author mutations.

Visibly private (underscore-prefixed): only :mod:`nexus.services.contributors`
composes these into the media-author PUT and the display-name PATCH. The two
scopes are ``media:{media_id}:authors`` and ``contributor:{contributor_id}:
display-name``; the facade builds them. Automatic/background author lanes have
no user and never touch this table (see spec 2.4).

Shape copied from ``services/resource_items/mutations.py`` (the resource-item
replay exemplar): one ``ResourceMutation`` row per ``(user, scope, client
mutation id)``, hash mismatch is a 409, and the stored ``response_json`` is
returned verbatim for the caller to re-validate before returning it.
"""

from __future__ import annotations

import hashlib
import json
from uuid import UUID

from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from nexus.db.models import ResourceMutation
from nexus.errors import ApiErrorCode, ConflictError


def request_hash(request: BaseModel) -> str:
    """SHA-256 over one canonical, alias-free request encoding (spec 4 / D-21).

    This deliberately deviates from the ``resource_items/mutations.py`` exemplar,
    which hashes ``by_alias=True``. The author request models are camelCase on the
    wire; hashing the alias-free (snake) field names keys the memo to the request's
    meaning rather than its wire spelling, so a wire-alias change never masquerades
    as a different mutation.
    """

    encoded = json.dumps(
        request.model_dump(mode="json", by_alias=False),
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def lookup_memo(
    db: Session,
    *,
    viewer_id: UUID,
    scope: str,
    client_mutation_id: str,
    request_hash: str,
) -> dict[str, object] | None:
    """Return the stored response for an exact replay, or ``None`` for first sight.

    A matching key with a different request hash is the reuse-with-different-payload
    conflict; it keeps the repository's established 409 convention (not the IETF
    draft's 422). The caller re-validates the returned dict before serving it.
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
    if memo.request_hash != request_hash:
        raise ConflictError(
            ApiErrorCode.E_IDEMPOTENCY_KEY_REPLAY_MISMATCH,
            "Author mutation id was reused with a different request",
        )
    return memo.response_json


def record_memo(
    db: Session,
    *,
    viewer_id: UUID,
    scope: str,
    client_mutation_id: str,
    request_hash: str,
    response_json: dict[str, object],
) -> None:
    """Persist the exact validated response for future exact replays.

    ``changed_lanes`` is intentionally empty: author mutations do not participate
    in the resource-item lane-version protocol.
    """

    db.add(
        ResourceMutation(
            user_id=viewer_id,
            mutation_scope=scope,
            client_mutation_id=client_mutation_id,
            request_hash=request_hash,
            changed_lanes={},
            response_json=response_json,
        )
    )
