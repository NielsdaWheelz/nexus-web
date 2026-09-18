"""Short-lived route-neutral bearers for the private generation-tool mount."""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Final, Literal
from uuid import UUID, uuid4

import jwt
from pydantic import BaseModel, ConfigDict, SecretStr, ValidationError, field_validator

from nexus.services import generation_policy

AGENT_TOOL_GRANT_ISSUER: Final[str] = "nexus-generation-tool-authority"
AGENT_TOOL_GRANT_AUDIENCE: Final[str] = "nexus-generation-tools-mcp"
AGENT_TOOL_GRANT_SCOPE: Final[str] = "generation.tools"
MAX_AGENT_TOOL_GRANT_TTL_SECONDS: Final[int] = (
    generation_policy.MODEL_TOOL_ADMISSION_RUNTIME_SECONDS
)
_ALGORITHM: Final[str] = "HS256"
_SHA256_RE: Final[re.Pattern[str]] = re.compile(r"^[0-9a-f]{64}$")

_CLAIM_NAMES: Final[tuple[str, ...]] = (
    "iss",
    "aud",
    "scope",
    "sub",
    "jti",
    "generation_id",
    "job_id",
    "worker_id",
    "attempt_no",
    "generation_spec_fingerprint",
    "tool_plan_revision",
    "binding_revisions_digest",
    "tool_scope_digest",
    "tool_budget_digest",
    "effect_mode",
    "iat",
    "nbf",
    "exp",
)


class AgentToolGrantClaims(BaseModel):
    """Closed authority facts shared by Chat and background Codex turns."""

    model_config = ConfigDict(extra="forbid", strict=True, frozen=True)

    iss: Literal["nexus-generation-tool-authority"]
    aud: Literal["nexus-generation-tools-mcp"]
    scope: Literal["generation.tools"]
    sub: str
    jti: str
    generation_id: str
    job_id: str
    worker_id: str
    attempt_no: int
    generation_spec_fingerprint: str
    tool_plan_revision: str
    binding_revisions_digest: str
    tool_scope_digest: str
    tool_budget_digest: str
    effect_mode: Literal["ReadOnly", "AdditiveWrites"]
    iat: int
    nbf: int
    exp: int

    @field_validator("sub", "jti", "generation_id", "job_id")
    @classmethod
    def _uuid_claim(cls, value: str) -> str:
        try:
            if str(UUID(value)) != value:
                raise ValueError
        except ValueError as error:
            raise ValueError("grant identity claim must be a canonical UUID") from error
        return value

    @field_validator("worker_id")
    @classmethod
    def _worker_label(cls, value: str) -> str:
        if not value.strip() or not 1 <= len(value) <= 128:
            raise ValueError("worker_id must contain 1-128 nonblank characters")
        return value

    @field_validator("attempt_no")
    @classmethod
    def _positive_attempt(cls, value: int) -> int:
        if value < 1:
            raise ValueError("attempt_no must be positive")
        return value

    @field_validator(
        "generation_spec_fingerprint",
        "tool_plan_revision",
        "binding_revisions_digest",
        "tool_scope_digest",
        "tool_budget_digest",
    )
    @classmethod
    def _digest_claim(cls, value: str) -> str:
        if not _SHA256_RE.fullmatch(value):
            raise ValueError("grant digest claim must be lowercase sha256")
        return value


@dataclass(frozen=True, slots=True)
class GenerationToolGrantAuthority:
    """Exact frozen authority copied into a bearer without route identity."""

    user_id: UUID
    generation_id: UUID
    job_id: UUID
    worker_id: str
    attempt_no: int
    generation_spec_fingerprint: str
    tool_plan_revision: str
    binding_revisions_digest: str
    tool_scope_digest: str
    tool_budget_digest: str
    effect_mode: Literal["ReadOnly", "AdditiveWrites"]

    def claims(self, *, jti: UUID, issued_at: int, expires_at: int) -> AgentToolGrantClaims:
        return AgentToolGrantClaims(
            iss=AGENT_TOOL_GRANT_ISSUER,
            aud=AGENT_TOOL_GRANT_AUDIENCE,
            scope=AGENT_TOOL_GRANT_SCOPE,
            sub=str(self.user_id),
            jti=str(jti),
            generation_id=str(self.generation_id),
            job_id=str(self.job_id),
            worker_id=self.worker_id,
            attempt_no=self.attempt_no,
            generation_spec_fingerprint=self.generation_spec_fingerprint,
            tool_plan_revision=self.tool_plan_revision,
            binding_revisions_digest=self.binding_revisions_digest,
            tool_scope_digest=self.tool_scope_digest,
            tool_budget_digest=self.tool_budget_digest,
            effect_mode=self.effect_mode,
            iat=issued_at,
            nbf=issued_at,
            exp=expires_at,
        )


@dataclass(frozen=True, slots=True)
class IssuedGenerationToolGrant:
    """One bearer and its process-local revocation/correlation nonce."""

    token: SecretStr
    jti: str
    expires_at: datetime


def issue_generation_tool_grant(
    authority: GenerationToolGrantAuthority,
    *,
    signing_key: SecretStr,
    now: datetime,
    lease_expires_at: datetime,
    transport_deadline_at: datetime,
) -> IssuedGenerationToolGrant:
    """Mint authority only through the earliest lease/transport/runtime fence."""

    current = _epoch(now)
    expires = min(
        _epoch(lease_expires_at),
        _epoch(transport_deadline_at),
        current + MAX_AGENT_TOOL_GRANT_TTL_SECONDS,
    )
    if expires <= current:
        raise ValueError("generation tool authority has no remaining validity interval")
    jti = uuid4()
    claims = authority.claims(jti=jti, issued_at=current, expires_at=expires)
    return IssuedGenerationToolGrant(
        token=_encode_claims(claims, key=_key(signing_key)),
        jti=str(jti),
        expires_at=datetime.fromtimestamp(expires, tz=UTC),
    )


def verify_agent_tool_grant(
    bearer: SecretStr | str,
    *,
    signing_key: SecretStr,
    now: datetime,
) -> AgentToolGrantClaims:
    """Authenticate the private bearer with zero clock skew or permissive claims."""

    token = bearer.get_secret_value() if isinstance(bearer, SecretStr) else bearer
    if not token.strip():
        raise ValueError("grant bearer is blank")
    try:
        decoded = jwt.decode(
            token,
            _key(signing_key),
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
    if claims.iat > current or claims.nbf > current or claims.exp <= current:
        raise ValueError("grant is outside its exact validity interval")
    if claims.nbf != claims.iat or claims.exp - claims.iat > MAX_AGENT_TOOL_GRANT_TTL_SECONDS:
        raise ValueError("grant temporal claims are not the issued bounded interval")
    return claims


def validate_agent_tool_grant_signing_key(signing_key: SecretStr) -> None:
    """Validate configured key material without exposing it."""

    _key(signing_key)


def _key(signing_key: SecretStr) -> str:
    key = signing_key.get_secret_value()
    if not key.strip():
        raise ValueError("agent-tools signing key is blank")
    if len(key.encode("utf-8")) < 32:
        raise ValueError("agent-tools signing key must be at least 32 bytes")
    return key


def _epoch(value: datetime) -> int:
    if value.tzinfo is None or value.utcoffset() is None:
        raise ValueError("grant clock must be timezone-aware")
    return int(value.astimezone(UTC).timestamp())


def _encode_claims(claims: AgentToolGrantClaims, *, key: str) -> SecretStr:
    return SecretStr(jwt.encode(claims.model_dump(mode="json"), key, algorithm=_ALGORITHM))


__all__ = [
    "AGENT_TOOL_GRANT_AUDIENCE",
    "AGENT_TOOL_GRANT_ISSUER",
    "AGENT_TOOL_GRANT_SCOPE",
    "AgentToolGrantClaims",
    "GenerationToolGrantAuthority",
    "IssuedGenerationToolGrant",
    "MAX_AGENT_TOOL_GRANT_TTL_SECONDS",
    "issue_generation_tool_grant",
    "validate_agent_tool_grant_signing_key",
    "verify_agent_tool_grant",
]
