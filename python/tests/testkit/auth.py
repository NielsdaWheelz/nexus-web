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


class MultiUserTokenVerifier:
    """Accept one independently supplied opaque token for each controlled identity."""

    def __init__(self, identities: tuple[tuple[UUID, str], ...]) -> None:
        self._verifiers = tuple(
            StaticTokenVerifier(user_id, email) for user_id, email in identities
        )
        self._token_by_user = {
            UUID(str(verifier.verify(verifier.token)["sub"])): verifier.token
            for verifier in self._verifiers
        }

    def token_for(self, user_id: UUID) -> str:
        return self._token_by_user[user_id]

    def verify(self, token: str) -> dict[str, Any]:
        for verifier in self._verifiers:
            if hmac.compare_digest(token, verifier.token):
                return verifier.verify(token)
        raise ApiError(ApiErrorCode.E_UNAUTHENTICATED, "Invalid test token")
