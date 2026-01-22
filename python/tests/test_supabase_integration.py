"""Supabase integration tests (auth JWKS + storage).

These tests hit a real Supabase local instance and are opt-in via marker.
"""

from __future__ import annotations

import os
from uuid import uuid4

import httpx
import pytest

from nexus.auth.verifier import SupabaseJwksVerifier
from nexus.storage.client import StorageClient
from nexus.storage.paths import build_storage_path

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


def ensure_bucket(base_url: str, service_key: str, bucket: str) -> None:
    headers = supabase_headers(service_key)
    bucket_url = f"{base_url}/storage/v1/bucket/{bucket}"
    create_url = f"{base_url}/storage/v1/bucket"

    with httpx.Client(timeout=30.0) as client:
        response = client.get(bucket_url, headers=headers)
        if response.status_code == 200:
            return
        if response.status_code not in (400, 404):
            pytest.fail(f"Unexpected bucket check response: {response.status_code} {response.text}")

        for payload in (
            {"name": bucket, "public": False},
            {"id": bucket, "name": bucket, "public": False},
        ):
            response = client.post(create_url, headers=headers, json=payload)
            if response.status_code in (200, 201, 409):
                return

    pytest.fail(f"Failed to create bucket '{bucket}'")


def upload_via_signed_url(
    base_url: str, bucket: str, path: str, token: str, content: bytes
) -> None:
    upload_url = f"{base_url}/storage/v1/object/upload/sign/{bucket}/{path}?token={token}"
    headers = {"content-type": "application/pdf"}

    with httpx.Client(timeout=30.0) as client:
        response = client.put(upload_url, content=content, headers=headers)
        if response.status_code == 405:
            response = client.post(upload_url, content=content, headers=headers)

        if response.status_code not in (200, 201):
            pytest.fail(f"Signed upload failed: {response.status_code} {response.text}")


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


def test_supabase_storage_roundtrip():
    supabase_url = require_env("SUPABASE_URL")
    service_key = require_env("SUPABASE_SERVICE_KEY")
    bucket = os.environ.get("STORAGE_BUCKET", "media")

    if not os.environ.get("STORAGE_TEST_PREFIX"):
        os.environ["STORAGE_TEST_PREFIX"] = f"test_runs/{uuid4()}/"

    ensure_bucket(supabase_url, service_key, bucket)

    storage_client = StorageClient(
        supabase_url=supabase_url,
        service_key=service_key,
        bucket=bucket,
    )

    content = b"%PDF-1.4 supabase integration test"
    path = build_storage_path(uuid4(), "pdf")
    signed = storage_client.sign_upload(path, content_type="application/pdf")

    assert signed.token

    upload_via_signed_url(supabase_url.rstrip("/"), bucket, path, signed.token, content)

    try:
        metadata = storage_client.head_object(path)
        assert metadata is not None
        assert metadata.size_bytes == len(content)

        streamed = b"".join(storage_client.stream_object(path))
        assert streamed == content

        download_url = storage_client.sign_download(path, expires_in=300)
        with httpx.Client(timeout=30.0) as client:
            response = client.get(download_url, follow_redirects=True)
        assert response.status_code == 200
        assert response.content == content
    finally:
        storage_client.delete_object(path)

    assert storage_client.head_object(path) is None
