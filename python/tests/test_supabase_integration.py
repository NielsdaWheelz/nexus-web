"""Supabase Auth integration tests.

These tests hit a real Supabase local instance and are opt-in via marker.
"""

from __future__ import annotations

import os
from uuid import uuid4

import httpx
import pytest

from nexus.auth.verifier import SupabaseJwksVerifier

pytestmark = pytest.mark.supabase


def require_env(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        pytest.fail(f"{name} must be set for Supabase tests")
    return value


def supabase_headers(api_key: str) -> dict[str, str]:
    return {
        "apikey": api_key,
        "Authorization": f"Bearer {api_key}",
    }


def test_supabase_jwks_verifier_accepts_real_token():
    supabase_url = require_env("SUPABASE_URL")
    anon_key = require_env("SUPABASE_ANON_KEY")
    jwks_url = require_env("SUPABASE_JWKS_URL")
    issuer = require_env("SUPABASE_ISSUER")
    audiences = require_env("SUPABASE_AUDIENCES")

    email = f"jwks-{uuid4()}@example.com"
    password = "test-password-123"

    with httpx.Client(timeout=30.0) as client:
        response = client.post(
            f"{supabase_url}/auth/v1/signup",
            headers=supabase_headers(anon_key),
            json={"email": email, "password": password},
        )

    if response.status_code not in (200, 201):
        pytest.fail(f"Supabase signup failed: {response.status_code} {response.text}")

    data = response.json()
    token = data.get("access_token") or data.get("session", {}).get("access_token")
    if not token:
        pytest.fail("Supabase signup response missing access token")

    verifier = SupabaseJwksVerifier(
        jwks_url=jwks_url,
        issuer=issuer,
        audiences=[aud.strip() for aud in audiences.split(",") if aud.strip()],
    )
    claims = verifier.verify(token)

    assert claims.get("sub")
