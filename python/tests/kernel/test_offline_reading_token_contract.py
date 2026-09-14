"""Scoped offline-reading package tokens never widen the SSE bearer lane."""

from __future__ import annotations

from uuid import uuid4

import pytest

from nexus.config import clear_settings_cache
from nexus.errors import ApiError, ApiErrorCode
from nexus.offline_reading_paths import is_offline_reading_package_path
from nexus.services.stream_tokens import (
    mint_offline_reading_package_token,
    mint_stream_token,
    verify_offline_reading_package_token,
    verify_stream_token,
)


def test_offline_package_token_is_media_generation_and_schema_bound(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("NEXUS_ENV", "test")
    monkeypatch.setenv("DATABASE_URL", "postgresql://nexus_test:nexus_test@localhost/nexus_test")
    monkeypatch.setenv("SUPABASE_JWKS_URL", "https://fixture.example.test/jwks")
    monkeypatch.setenv("SUPABASE_ISSUER", "https://fixture.example.test/auth/v1")
    monkeypatch.setenv("SUPABASE_AUDIENCES", "authenticated")
    clear_settings_cache()
    user_id = uuid4()
    media_id = uuid4()

    minted = mint_offline_reading_package_token(
        user_id=user_id,
        media_id=media_id,
        reader_generation=7,
    )
    verified = verify_offline_reading_package_token(minted.token, expected_media_id=media_id)

    assert verified.user_id == user_id
    assert verified.media_id == media_id
    assert verified.reader_generation == 7
    # The wire contract the native client pins (OFFLINE_READING_PACKAGE_SCHEMA_VERSION
    # = 2 in apps/android/.../offline/reading/OfflineReadingModels.kt).
    assert verified.package_schema_version == 2
    assert minted.account_id == user_id
    assert minted.reader_generation == 7
    assert minted.package_schema_version == 2

    with pytest.raises(ApiError) as wrong_path:
        verify_offline_reading_package_token(minted.token, expected_media_id=uuid4())
    assert wrong_path.value.code == ApiErrorCode.E_STREAM_TOKEN_INVALID

    with pytest.raises(ApiError) as wrong_lane:
        verify_stream_token(minted.token)
    assert wrong_lane.value.code == ApiErrorCode.E_STREAM_TOKEN_INVALID

    # Lane binding is symmetric: the SSE bearer is not package authority either.
    with pytest.raises(ApiError) as reverse_lane:
        verify_offline_reading_package_token(
            mint_stream_token(user_id).token,
            expected_media_id=media_id,
        )
    assert reverse_lane.value.code == ApiErrorCode.E_STREAM_TOKEN_INVALID
    clear_settings_cache()


@pytest.mark.parametrize(
    ("path", "expected"),
    (
        ("/offline-reading/packages/11111111-1111-4111-8111-111111111111", True),
        ("/offline-reading/packages/11111111-1111-4111-8111-111111111111/extra", False),
        ("/offline-reading/packages/not-a-uuid", False),
        ("/offline-reading/packages/11111111-1111-4111-8111-11111111111A", False),
        ("/offline-reading/packages", False),
        ("/offline-reading/token/11111111-1111-4111-8111-111111111111", False),
    ),
)
def test_only_one_canonical_direct_package_path_bypasses_supabase(
    path: str,
    expected: bool,
) -> None:
    assert is_offline_reading_package_path(path) is expected
