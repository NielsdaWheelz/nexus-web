"""Dedicated HS256 grants for the sessionless ChatTools MCP mount."""

from __future__ import annotations

import re
from datetime import UTC, datetime
from typing import Final
from uuid import UUID, uuid4

import jwt
from pydantic import BaseModel, ConfigDict, SecretStr, ValidationError, field_validator

from nexus.services import generation_policy

AGENT_TOOL_GRANT_ISSUER: Final[str] = "nexus-agent-tools"
AGENT_TOOL_GRANT_AUDIENCE: Final[str] = "nexus-chat-tools-mcp"
AGENT_TOOL_GRANT_SCOPE: Final[str] = "chat.tools"
MAX_AGENT_TOOL_GRANT_TTL_SECONDS: Final[int] = max(
    generation_policy.chat_policy(profile).transport_deadline_seconds
    for profile in generation_policy.CHAT_PROFILES
)
_ALGORITHM: Final[str] = "HS256"
_SHA256_RE: Final[re.Pattern[str]] = re.compile(r"^[0-9a-f]{64}$")

_CLAIM_NAMES: Final[tuple[str, ...]] = (
    "iss",
    "aud",
    "scope",
    "sub",
    "jti",
    "run_id",
    "job_id",
    "worker_id",
    "attempt_no",
    "generation_id",
    "tool_plan_revision",
    "request_fingerprint",
    "iat",
    "nbf",
    "exp",
)


class AgentToolGrantClaims(BaseModel):
    """The closed wire claims accepted by the ChatTools boundary."""

    model_config = ConfigDict(extra="forbid", strict=True)

    iss: str
    aud: str
    scope: str
    sub: str
    jti: str
    run_id: str
    job_id: str
    worker_id: str
    attempt_no: int
    generation_id: str
    tool_plan_revision: str
    request_fingerprint: str
    iat: int
    nbf: int
    exp: int

    @field_validator(
        "iss",
        "aud",
        "scope",
        "sub",
        "jti",
        "run_id",
        "job_id",
        "worker_id",
        "generation_id",
        "request_fingerprint",
    )
    @classmethod
    def _non_blank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("grant claim must not be blank")
        return value

    @field_validator("worker_id")
    @classmethod
    def _worker_id_bound(cls, value: str) -> str:
        if not 1 <= len(value) <= 128:
            raise ValueError("worker_id must contain 1-128 characters")
        return value

    @field_validator("attempt_no")
    @classmethod
    def _positive_attempt(cls, value: int) -> int:
        if value < 1:
            raise ValueError("attempt_no must be positive")
        return value

    @field_validator("sub", "jti", "run_id", "job_id", "generation_id")
    @classmethod
    def _uuid_claim(cls, value: str) -> str:
        try:
            if str(UUID(value)) != value:
                raise ValueError("grant identity claim must be canonical lowercase UUID")
        except ValueError as error:
            raise ValueError("grant identity claim must be a UUID") from error
        return value

    @field_validator("request_fingerprint")
    @classmethod
    def _fingerprint_claim(cls, value: str) -> str:
        if not _SHA256_RE.fullmatch(value):
            raise ValueError("request_fingerprint must be lowercase sha256")
        return value

    @field_validator("tool_plan_revision")
    @classmethod
    def _plan_revision_claim(cls, value: str) -> str:
        if not _SHA256_RE.fullmatch(value):
            raise ValueError("tool_plan_revision must be lowercase sha256")
        return value


def issue_agent_tool_grant(
    claims: AgentToolGrantClaims,
    *,
    signing_key: SecretStr,
    now: datetime,
) -> SecretStr:
    """Issue a bearer token after validating its exact, no-skew lifetime."""
    key = _key(signing_key)
    current = _epoch(now)
    checked = _checked_claims(claims)
    if checked.iat != current or checked.nbf != current:
        raise ValueError("grant iat and nbf must equal the issuing clock")
    if checked.exp <= current or checked.exp - current > MAX_AGENT_TOOL_GRANT_TTL_SECONDS:
        raise ValueError(
            "grant lifetime must be positive and at most "
            f"{MAX_AGENT_TOOL_GRANT_TTL_SECONDS} seconds"
        )
    encoded = jwt.encode(checked.model_dump(mode="json"), key, algorithm=_ALGORITHM)
    return SecretStr(encoded)


def issue_chat_generation_grant(
    *,
    user_id: UUID,
    run_id: UUID,
    job_id: UUID,
    worker_id: str,
    attempt_no: int,
    generation_id: UUID,
    tool_plan_revision: str,
    request_fingerprint: str,
    signing_key: SecretStr,
    now: datetime,
    ttl_seconds: int = MAX_AGENT_TOOL_GRANT_TTL_SECONDS,
) -> SecretStr:
    """Issue one exact run/job/generation-bound ChatTools bearer."""
    current = _epoch(now)
    claims = AgentToolGrantClaims(
        iss=AGENT_TOOL_GRANT_ISSUER,
        aud=AGENT_TOOL_GRANT_AUDIENCE,
        scope=AGENT_TOOL_GRANT_SCOPE,
        sub=str(user_id),
        jti=str(uuid4()),
        run_id=str(run_id),
        job_id=str(job_id),
        worker_id=worker_id,
        attempt_no=attempt_no,
        generation_id=str(generation_id),
        tool_plan_revision=tool_plan_revision,
        request_fingerprint=request_fingerprint,
        iat=current,
        nbf=current,
        exp=current + ttl_seconds,
    )
    return issue_agent_tool_grant(claims, signing_key=signing_key, now=now)


def verify_agent_tool_grant(
    bearer: SecretStr | str,
    *,
    signing_key: SecretStr,
    now: datetime,
) -> AgentToolGrantClaims:
    """Verify the dedicated grant with exact issuer, audience, and zero skew."""
    key = _key(signing_key)
    token = bearer.get_secret_value() if isinstance(bearer, SecretStr) else bearer
    if not token.strip():
        raise ValueError("grant bearer is blank")
    try:
        decoded = jwt.decode(
            token,
            key,
            algorithms=[_ALGORITHM],
            issuer=AGENT_TOOL_GRANT_ISSUER,
            audience=AGENT_TOOL_GRANT_AUDIENCE,
            leeway=0,
            options={
                "require": list(_CLAIM_NAMES),
                "verify_exp": False,
                "verify_nbf": False,
                "verify_iat": False,
            },
        )
        claims = AgentToolGrantClaims.model_validate(decoded)
    except (jwt.InvalidTokenError, ValidationError, ValueError) as error:
        raise ValueError("grant is not verifiable") from error
    current = _epoch(now)
    if claims.iss != AGENT_TOOL_GRANT_ISSUER or claims.aud != AGENT_TOOL_GRANT_AUDIENCE:
        raise ValueError("grant route claims do not match")
    if claims.scope != AGENT_TOOL_GRANT_SCOPE:
        raise ValueError("grant scope does not match")
    if claims.iat > current or claims.nbf > current or claims.exp <= current:
        raise ValueError("grant is outside its exact validity interval")
    if claims.nbf < claims.iat or claims.exp <= claims.iat:
        raise ValueError("grant temporal claims are not ordered")
    if claims.exp - claims.iat > MAX_AGENT_TOOL_GRANT_TTL_SECONDS:
        raise ValueError(f"grant lifetime exceeds {MAX_AGENT_TOOL_GRANT_TTL_SECONDS} seconds")
    return claims


def _key(signing_key: SecretStr) -> str:
    key = signing_key.get_secret_value()
    if not key.strip():
        raise ValueError("agent-tools signing key is blank")
    if len(key.encode("utf-8")) < 32:
        raise ValueError("agent-tools signing key must be at least 32 bytes")
    return key


def validate_agent_tool_grant_signing_key(signing_key: SecretStr) -> None:
    """Validate the configured grant key without exposing its value."""
    _key(signing_key)


def _epoch(value: datetime) -> int:
    if value.tzinfo is None:
        raise ValueError("grant clock must be timezone-aware")
    return int(value.astimezone(UTC).timestamp())


def _checked_claims(claims: AgentToolGrantClaims) -> AgentToolGrantClaims:
    return AgentToolGrantClaims.model_validate(claims.model_dump(mode="json"))
