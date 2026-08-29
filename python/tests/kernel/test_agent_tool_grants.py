"""RED contract for the dedicated, sessionless ChatTools bearer grant."""

from __future__ import annotations

import base64
import json
from datetime import UTC, datetime, timedelta
from importlib.util import find_spec
from uuid import uuid4

import pytest
from pydantic import SecretStr

_AGENT_TOOL_GRANT_BOUNDARY_PRESENT = find_spec("nexus.services.agent_tool_grants") is not None
if _AGENT_TOOL_GRANT_BOUNDARY_PRESENT:
    from nexus.services.agent_tool_grants import (
        AGENT_TOOL_GRANT_AUDIENCE,
        AGENT_TOOL_GRANT_ISSUER,
        AGENT_TOOL_GRANT_SCOPE,
        MAX_AGENT_TOOL_GRANT_TTL_SECONDS,
        AgentToolGrantClaims,
        issue_agent_tool_grant,
        verify_agent_tool_grant,
    )

_SIGNING_KEY = SecretStr("dedicated-chat-tools-hs256-test-key")


def _claims(now: datetime) -> AgentToolGrantClaims:
    issued_at = int(now.timestamp())
    return AgentToolGrantClaims(
        iss=AGENT_TOOL_GRANT_ISSUER,
        aud=AGENT_TOOL_GRANT_AUDIENCE,
        scope=AGENT_TOOL_GRANT_SCOPE,
        sub=str(uuid4()),
        jti=str(uuid4()),
        run_id=str(uuid4()),
        job_id=str(uuid4()),
        worker_id="worker-red-proof",
        attempt_no=3,
        generation_id=str(uuid4()),
        tool_plan_revision="a" * 64,
        request_fingerprint="a" * 64,
        iat=issued_at,
        nbf=issued_at,
        exp=issued_at + MAX_AGENT_TOOL_GRANT_TTL_SECONDS,
    )


def test_grant_is_strict_hs256_bearer_and_does_not_leak_secret() -> None:
    assert _AGENT_TOOL_GRANT_BOUNDARY_PRESENT, "dedicated agent-tool grant boundary is absent"
    from nexus.services import generation_policy

    now = datetime(2026, 8, 24, 12, 0, tzinfo=UTC)
    claims = _claims(now)
    bearer = issue_agent_tool_grant(claims, signing_key=_SIGNING_KEY, now=now)

    assert verify_agent_tool_grant(bearer, signing_key=_SIGNING_KEY, now=now) == claims
    assert "dedicated-chat-tools" not in repr(bearer)
    assert "dedicated-chat-tools" not in str(bearer)
    assert "token" not in claims.model_dump(mode="json")

    assert MAX_AGENT_TOOL_GRANT_TTL_SECONDS == max(
        generation_policy.chat_policy(profile).turn_timeout_seconds
        for profile in generation_policy.CHAT_PROFILES
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
        forged = issue_agent_tool_grant(changed, signing_key=_SIGNING_KEY, now=now)
        with pytest.raises(ValueError):
            verify_agent_tool_grant(forged, signing_key=_SIGNING_KEY, now=now)

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
    assert _AGENT_TOOL_GRANT_BOUNDARY_PRESENT, "dedicated agent-tool grant boundary is absent"
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

    wire = claims.model_dump(mode="json")
    wire.pop("generation_id")
    with pytest.raises(ValueError):
        AgentToolGrantClaims.model_validate(wire)
    with pytest.raises(ValueError):
        AgentToolGrantClaims.model_validate(
            {**claims.model_dump(mode="json"), "session_id": "nope"}
        )
