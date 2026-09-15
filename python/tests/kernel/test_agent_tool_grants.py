"""Contract for the dedicated, sessionless generation-tool bearer grant."""

from __future__ import annotations

import base64
import json
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
from pydantic import SecretStr

from nexus.services.agent_tool_grants import (
    AGENT_TOOL_GRANT_AUDIENCE,
    AGENT_TOOL_GRANT_ISSUER,
    AGENT_TOOL_GRANT_SCOPE,
    MAX_AGENT_TOOL_GRANT_TTL_SECONDS,
    AgentToolGrantClaims,
    GenerationToolGrantAuthority,
    issue_agent_tool_grant,
    issue_generation_tool_grant,
    verify_agent_tool_grant,
)

_SIGNING_KEY = SecretStr("dedicated-generation-tools-hs256-key")


def _claims(now: datetime) -> AgentToolGrantClaims:
    issued_at = int(now.timestamp())
    return AgentToolGrantClaims(
        iss=AGENT_TOOL_GRANT_ISSUER,
        aud=AGENT_TOOL_GRANT_AUDIENCE,
        scope=AGENT_TOOL_GRANT_SCOPE,
        sub=str(uuid4()),
        jti=str(uuid4()),
        job_id=str(uuid4()),
        worker_id="worker-red-proof",
        attempt_no=3,
        generation_id=str(uuid4()),
        generation_spec_fingerprint="a" * 64,
        tool_plan_revision="a" * 64,
        binding_revisions_digest="b" * 64,
        tool_scope_digest="c" * 64,
        tool_budget_digest="d" * 64,
        effect_mode="ReadOnly",
        iat=issued_at,
        nbf=issued_at,
        exp=issued_at + MAX_AGENT_TOOL_GRANT_TTL_SECONDS,
    )


def test_grant_is_strict_hs256_bearer_and_does_not_leak_secret() -> None:
    from nexus.services import generation_policy

    now = datetime(2026, 8, 24, 12, 0, tzinfo=UTC)
    claims = _claims(now)
    bearer = issue_agent_tool_grant(claims, signing_key=_SIGNING_KEY, now=now)

    assert verify_agent_tool_grant(bearer, signing_key=_SIGNING_KEY, now=now) == claims
    assert "dedicated-generation-tools" not in repr(bearer)
    assert "dedicated-generation-tools" not in str(bearer)
    assert "token" not in claims.model_dump(mode="json")

    assert (
        MAX_AGENT_TOOL_GRANT_TTL_SECONDS == generation_policy.MODEL_TOOL_ADMISSION_RUNTIME_SECONDS
    )
    assert MAX_AGENT_TOOL_GRANT_TTL_SECONDS == 900
    with pytest.raises(ValueError, match=str(MAX_AGENT_TOOL_GRANT_TTL_SECONDS)):
        issue_agent_tool_grant(
            claims.model_copy(update={"exp": claims.iat + MAX_AGENT_TOOL_GRANT_TTL_SECONDS + 1}),
            signing_key=_SIGNING_KEY,
            now=now,
        )

    for changed in (
        claims.model_copy(update={"iss": "wrong-issuer"}),
        claims.model_copy(update={"aud": "wrong-audience"}),
        claims.model_copy(update={"scope": "wrong-scope"}),
    ):
        with pytest.raises(ValueError):
            issue_agent_tool_grant(changed, signing_key=_SIGNING_KEY, now=now)

    with pytest.raises(ValueError):
        verify_agent_tool_grant(bearer, signing_key=SecretStr("wrong-key"), now=now)
    header, payload, signature = bearer.get_secret_value().split(".")
    non_hs256_header = (
        base64.urlsafe_b64encode(
            json.dumps({"alg": "RS256", "typ": "JWT"}, separators=(",", ":")).encode()
        )
        .rstrip(b"=")
        .decode()
    )
    with pytest.raises(ValueError):
        verify_agent_tool_grant(
            SecretStr(f"{non_hs256_header}.{payload}.{signature}"),
            signing_key=_SIGNING_KEY,
            now=now,
        )


def test_grant_rejects_clock_skew_and_missing_or_extra_claims() -> None:
    now = datetime(2026, 8, 24, 12, 0, tzinfo=UTC)
    claims = _claims(now)

    with pytest.raises(ValueError):
        issue_agent_tool_grant(
            claims.model_copy(update={"nbf": claims.iat + 1}),
            signing_key=_SIGNING_KEY,
            now=now,
        )
    old = now - timedelta(seconds=MAX_AGENT_TOOL_GRANT_TTL_SECONDS + 1)
    expired = issue_agent_tool_grant(
        _claims(old),
        signing_key=_SIGNING_KEY,
        now=old,
    )
    with pytest.raises(ValueError):
        verify_agent_tool_grant(expired, signing_key=_SIGNING_KEY, now=now)
    future = claims.model_copy(update={"iat": claims.iat + 1, "nbf": claims.iat + 1})
    future_bearer = issue_agent_tool_grant(
        future,
        signing_key=_SIGNING_KEY,
        now=now + timedelta(seconds=1),
    )
    with pytest.raises(ValueError):
        verify_agent_tool_grant(future_bearer, signing_key=_SIGNING_KEY, now=now)
    with pytest.raises(ValueError):
        issue_agent_tool_grant(
            claims.model_copy(update={"exp": claims.iat - 1}),
            signing_key=_SIGNING_KEY,
            now=now,
        )

    for required_claim in ("generation_id", "tool_scope_digest"):
        wire = claims.model_dump(mode="json")
        wire.pop(required_claim)
        with pytest.raises(ValueError):
            AgentToolGrantClaims.model_validate(wire)
    with pytest.raises(ValueError):
        AgentToolGrantClaims.model_validate(
            {**claims.model_dump(mode="json"), "session_id": "nope"}
        )


def test_generation_tool_grant_uses_earliest_lease_and_transport_fence() -> None:
    issued_at = datetime(2026, 8, 24, 12, 0, 17, tzinfo=UTC)
    authority = GenerationToolGrantAuthority(
        user_id=uuid4(),
        generation_id=uuid4(),
        job_id=uuid4(),
        worker_id="worker-route-neutral-clock",
        attempt_no=1,
        generation_spec_fingerprint="a" * 64,
        tool_plan_revision="b" * 64,
        binding_revisions_digest="c" * 64,
        tool_scope_digest="d" * 64,
        tool_budget_digest="e" * 64,
        effect_mode="ReadOnly",
    )
    issued = issue_generation_tool_grant(
        authority,
        signing_key=_SIGNING_KEY,
        now=issued_at,
        lease_expires_at=issued_at + timedelta(seconds=283),
        transport_deadline_at=issued_at + timedelta(seconds=600),
    )
    claims = verify_agent_tool_grant(
        issued.token,
        signing_key=_SIGNING_KEY,
        now=issued_at,
    )
    assert claims.iat == claims.nbf == int(issued_at.timestamp())
    assert claims.exp == int((issued_at + timedelta(seconds=283)).timestamp())
    assert claims.exp - claims.iat == 283
    assert "owner_kind" not in claims.model_dump(mode="json")
    assert "provider" not in claims.model_dump(mode="json")
    assert "model" not in claims.model_dump(mode="json")

    with pytest.raises(ValueError, match="no remaining"):
        issue_generation_tool_grant(
            authority,
            signing_key=_SIGNING_KEY,
            now=issued_at,
            lease_expires_at=issued_at,
            transport_deadline_at=issued_at + timedelta(seconds=600),
        )
