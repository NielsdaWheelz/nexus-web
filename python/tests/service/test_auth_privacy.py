"""Priority proof: authentication failures redact credentials and private rows stay masked."""

from __future__ import annotations

from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from nexus.errors import ApiErrorCode, NotFoundError
from nexus.services.bootstrap import ensure_user_and_default_library
from nexus.services.conversations import create_conversation, get_conversation
from tests.testkit.auth import UserRecord


def test_invalid_token_is_redacted_and_private_conversation_existence_is_masked(
    authenticated_client: TestClient,
    db_session: Session,
    test_user: UserRecord,
) -> None:
    invalid_token = "nexus-invalid-private-token"
    response = authenticated_client.get(
        "/conversations",
        headers={"Authorization": f"Bearer {invalid_token}"},
    )
    assert response.status_code == 401, (
        f"invalid credential reached an authenticated collection: {response.text}"
    )
    assert invalid_token not in response.text, "authentication response disclosed the bearer token"

    private = create_conversation(db_session, test_user.id)
    other_user_id = uuid4()
    ensure_user_and_default_library(
        db_session,
        other_user_id,
        f"privacy-proof-{other_user_id}@example.invalid",
    )

    with pytest.raises(NotFoundError) as hidden:
        get_conversation(db_session, other_user_id, private.id)
    assert hidden.value.code == ApiErrorCode.E_CONVERSATION_NOT_FOUND
    assert "not found" in hidden.value.message.casefold(), (
        f"private conversation denial leaked a distinct existence signal: {hidden.value!r}"
    )
