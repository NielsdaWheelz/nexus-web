"""Bearer verification: the api's one contact with the session provider (supabase).

A bearer is valid iff it is RS256/ES256-signed by a key the provider's JWKS publishes, its
``iss`` is the issuer, its ``aud`` one of the audiences, ``exp`` holds within 60 s and ``sub``
is a uuid. The key set is cached for an hour; an unknown ``kid`` refetches it at most every
30 s. Fetches run off the event loop, one at a time; a request whose key is cached never waits.
"""

import asyncio
import math
import time
from uuid import UUID

import jwt
from starlette.concurrency import run_in_threadpool

from nexus.errors import ApiError, ApiErrorCode
from nexus.logging import get_logger

logger = get_logger(__name__)

_KEYS_TTL_S = 3600
_UNKNOWN_KID_COOLDOWN_S = 30


class TokenVerifier:
    def __init__(self, jwks_url: str | None, issuer: str | None, audiences: tuple[str, ...]):
        if not (jwks_url and issuer and audiences):
            raise RuntimeError(
                "SUPABASE_JWKS_URL, SUPABASE_ISSUER and SUPABASE_AUDIENCES are required"
            )
        self._client = jwt.PyJWKClient(jwks_url, cache_jwk_set=False, timeout=5)
        self._issuer = issuer
        self._audiences = audiences
        self._keys: dict[str, jwt.PyJWK] = {}
        self._fetched_at = -math.inf
        self._fetching = asyncio.Lock()

    async def verify(self, token: str) -> tuple[UUID, str | None]:
        """The user id and the lowercased email; 401 E_UNAUTHENTICATED, 503 E_AUTH_UNAVAILABLE."""
        try:
            key = await self._key(jwt.get_unverified_header(token).get("kid"))
            claims = jwt.decode(
                token,
                key,
                algorithms=["RS256", "ES256"],
                audience=self._audiences,
                issuer=self._issuer,
                leeway=60,
                options={"require": ["exp", "iss", "sub"]},
            )
            user_id = UUID(claims["sub"])
        except (jwt.PyJWTError, ValueError) as exc:  # ValueError: sub is not a uuid
            logger.warning("auth_failure", reason=type(exc).__name__)
            raise ApiError(ApiErrorCode.E_UNAUTHENTICATED, f"Invalid token: {exc}") from exc
        email = claims.get("email")
        return user_id, (email.strip().lower() or None) if isinstance(email, str) else None

    async def _key(self, kid: str | None) -> jwt.PyJWK:
        fetched_at = self._fetched_at
        age = time.monotonic() - fetched_at
        if age > _KEYS_TTL_S or (kid not in self._keys and age > _UNKNOWN_KID_COOLDOWN_S):
            async with self._fetching:
                if self._fetched_at == fetched_at:  # no fetch landed while this one waited
                    try:
                        keys = await run_in_threadpool(self._client.get_signing_keys)
                    # unreachable, not json, or no usable signing key: the provider's fault
                    except (jwt.PyJWTError, ValueError) as exc:
                        logger.warning("auth_failure", reason="jwks_unavailable", error=str(exc))
                        raise ApiError(
                            ApiErrorCode.E_AUTH_UNAVAILABLE, "Authentication service unavailable"
                        ) from exc
                    self._keys = {key.key_id: key for key in keys if key.key_id}
                    self._fetched_at = time.monotonic()
        if kid not in self._keys:
            raise jwt.InvalidTokenError("signing key not found")
        return self._keys[kid]
