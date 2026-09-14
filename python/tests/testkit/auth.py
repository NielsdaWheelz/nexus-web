"""Controlled implementation of the external token-verification boundary."""

from __future__ import annotations

import hmac
from dataclasses import dataclass
from typing import Any
from uuid import UUID

from nexus.errors import ApiError, ApiErrorCode


@dataclass(frozen=True, slots=True)
class UserRecord:
    id: UUID
    email: str
    default_library_id: UUID


class StaticTokenVerifier:
    """Accept one opaque token and return one independently supplied identity."""

    def __init__(self, user_id: UUID, email: str) -> None:
        self.token = f"nexus-test-token-{user_id}"
        self._claims = {"sub": str(user_id), "email": email}

    def verify(self, token: str) -> dict[str, Any]:
        if not hmac.compare_digest(token, self.token):
            raise ApiError(ApiErrorCode.E_UNAUTHENTICATED, "Invalid test token")
        return self._claims.copy()
