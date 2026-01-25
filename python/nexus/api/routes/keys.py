"""User API Keys routes.

Route handlers for BYOK (Bring Your Own Key) API key management.
Routes are transport-only: each calls exactly one service function.

Per PR-03 spec:
- GET /keys: List user's keys (safe fields only, no secrets)
- POST /keys: Upsert key for provider (encrypt at rest)
- DELETE /keys/:id: Revoke key (wipe ciphertext, retain fingerprint)

All routes require authentication.
Response envelope: {"data": ...}
Error envelope: {"error": {"code": "...", "message": "...", "request_id": "..."}}

Security invariants:
- Response never includes encrypted_key, key_nonce, master_key_version
- Plaintext keys are never logged
- Keys are encrypted before storage
"""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Response
from pydantic import ValidationError
from sqlalchemy.orm import Session

from nexus.api.deps import get_db
from nexus.auth.middleware import Viewer, get_viewer
from nexus.errors import ApiError, ApiErrorCode
from nexus.responses import success_response
from nexus.schemas.keys import UserApiKeyCreate
from nexus.services import user_keys as user_keys_service

router = APIRouter(tags=["keys"])


@router.get("/keys")
def list_keys(
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """List the user's API keys.

    Returns only safe fields - never includes encrypted_key, key_nonce, or master_key_version.
    Empty list is valid if user has no keys.

    Returns:
        {"data": [UserApiKeyOut, ...]}
    """
    keys = user_keys_service.list_user_keys(db=db, user_id=viewer.user_id)
    return success_response([k.model_dump(mode="json") for k in keys])


@router.post("/keys", status_code=201)
def upsert_key(
    body: UserApiKeyCreate,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
    response: Response,
) -> dict:
    """Add or update an API key for a provider.

    This is an upsert operation: if a key already exists for the
    (user_id, provider) pair, it is overwritten.

    On upsert:
    - Generate new nonce
    - Re-encrypt with new ciphertext
    - Set status = 'untested'
    - Update key_fingerprint
    - Clear last_tested_at
    - Clear revoked_at

    Returns:
        201 Created (new key): {"data": UserApiKeyOut}
        200 OK (updated key): {"data": UserApiKeyOut}

    Errors:
        E_KEY_PROVIDER_INVALID (400): Unknown provider
        E_KEY_INVALID_FORMAT (400): Key too short or contains whitespace
    """
    try:
        key_out, is_created = user_keys_service.upsert_user_key(
            db=db,
            user_id=viewer.user_id,
            provider=body.provider,
            api_key=body.api_key,
        )
    except ValidationError as e:
        # Pydantic validation already handled by FastAPI, but just in case
        raise ApiError(ApiErrorCode.E_KEY_INVALID_FORMAT, str(e)) from e

    # Set status code based on whether key was created or updated
    if not is_created:
        response.status_code = 200

    return success_response(key_out.model_dump(mode="json"))


@router.delete("/keys/{key_id}", status_code=204)
def revoke_key(
    key_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> Response:
    """Revoke an API key.

    Secure revocation wipes ciphertext:
    - Set status = 'revoked'
    - Set revoked_at = now()
    - Wipe encrypted_key, key_nonce, master_key_version to NULL
    - Retain key_fingerprint for audit trail

    Idempotent: revoking an already-revoked key returns 204 (no error).

    Returns:
        204 No Content

    Errors:
        E_KEY_NOT_FOUND (404): Key doesn't exist or not owned by viewer
    """
    user_keys_service.revoke_user_key(
        db=db,
        user_id=viewer.user_id,
        key_id=key_id,
    )
    return Response(status_code=204)
