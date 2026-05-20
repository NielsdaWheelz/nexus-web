"""Integration tests for the Android-handoff one-time-code service."""

from __future__ import annotations

import hashlib
from datetime import UTC, datetime, timedelta
from uuid import UUID

import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session

from nexus.db.models import AuthHandoffCode
from nexus.services.auth_handoff_codes import (
    consume_auth_handoff_code,
    create_auth_handoff_code,
    purge_expired_auth_handoff_codes,
)
from tests.helpers import auth_headers, create_test_user_id
from tests.utils.db import DirectSessionManager

pytestmark = pytest.mark.integration

ACCESS_TOKEN = "sb-access-token-value"
REFRESH_TOKEN = "sb-refresh-token-value"
VERIFIER = "android-shell-handoff-verifier-0123456789"


def _sha256(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


class TestAuthHandoffCodeService:
    def test_create_returns_prefixed_code_and_persists_hashed_row(
        self, db_session: Session, bootstrapped_user: UUID
    ):
        challenge = _sha256(VERIFIER).upper()
        before = datetime.now(UTC)

        code = create_auth_handoff_code(
            db_session,
            user_id=bootstrapped_user,
            access_token=ACCESS_TOKEN,
            refresh_token=REFRESH_TOKEN,
            challenge=challenge,
        )

        assert code.startswith("nx_hand_"), (
            f"Expected handoff code to be prefixed nx_hand_, got {code!r}"
        )

        row = db_session.execute(
            select(AuthHandoffCode).where(AuthHandoffCode.user_id == bootstrapped_user)
        ).scalar_one()
        assert row.code_hash == _sha256(code), (
            f"Expected code_hash to be sha256(code). code={code!r}, row.code_hash={row.code_hash!r}"
        )
        assert row.challenge == challenge.lower(), (
            f"Expected challenge stored lowercased. Stored {row.challenge!r}, gave {challenge!r}"
        )
        assert row.access_token == ACCESS_TOKEN
        assert row.refresh_token == REFRESH_TOKEN
        assert row.expires_at > before, (
            f"Expected expires_at in the future. expires_at={row.expires_at}, before={before}"
        )

    def test_consume_with_matching_code_and_verifier_returns_tokens_and_burns_row(
        self, db_session: Session, bootstrapped_user: UUID
    ):
        code = create_auth_handoff_code(
            db_session,
            user_id=bootstrapped_user,
            access_token=ACCESS_TOKEN,
            refresh_token=REFRESH_TOKEN,
            challenge=_sha256(VERIFIER),
        )

        result = consume_auth_handoff_code(db_session, code, VERIFIER)

        assert result == (ACCESS_TOKEN, REFRESH_TOKEN), (
            f"Expected consume to return the stored token pair, got {result!r}"
        )
        remaining = db_session.execute(
            select(AuthHandoffCode).where(AuthHandoffCode.user_id == bootstrapped_user)
        ).scalar_one_or_none()
        assert remaining is None, (
            f"Expected handoff row to be deleted after consume, found {remaining!r}"
        )

    def test_consume_with_wrong_verifier_does_not_burn_the_row(
        self, db_session: Session, bootstrapped_user: UUID
    ):
        code = create_auth_handoff_code(
            db_session,
            user_id=bootstrapped_user,
            access_token=ACCESS_TOKEN,
            refresh_token=REFRESH_TOKEN,
            challenge=_sha256(VERIFIER),
        )

        intercepted = consume_auth_handoff_code(db_session, code, "attacker-guessed-verifier")

        assert intercepted is None, (
            f"Expected consume with wrong verifier to return None, got {intercepted!r}"
        )
        survivor = db_session.execute(
            select(AuthHandoffCode).where(AuthHandoffCode.user_id == bootstrapped_user)
        ).scalar_one_or_none()
        assert survivor is not None, (
            "Expected handoff row to survive a wrong-verifier consume so the legitimate "
            "shell can still redeem the code."
        )

        legitimate = consume_auth_handoff_code(db_session, code, VERIFIER)
        assert legitimate == (ACCESS_TOKEN, REFRESH_TOKEN), (
            f"Expected legitimate consume after wrong-verifier attempt to succeed, got {legitimate!r}"
        )

    def test_consume_with_unknown_code_returns_none_and_writes_nothing(
        self, db_session: Session, bootstrapped_user: UUID
    ):
        before_rows = db_session.execute(select(AuthHandoffCode)).all()

        result = consume_auth_handoff_code(db_session, "nx_hand_does-not-exist", VERIFIER)

        assert result is None
        after_rows = db_session.execute(select(AuthHandoffCode)).all()
        assert after_rows == before_rows, (
            f"Expected unknown-code consume to be a no-op; before={before_rows!r}, after={after_rows!r}"
        )

    def test_consume_after_first_redeem_returns_none(
        self, db_session: Session, bootstrapped_user: UUID
    ):
        code = create_auth_handoff_code(
            db_session,
            user_id=bootstrapped_user,
            access_token=ACCESS_TOKEN,
            refresh_token=REFRESH_TOKEN,
            challenge=_sha256(VERIFIER),
        )

        first = consume_auth_handoff_code(db_session, code, VERIFIER)
        assert first == (ACCESS_TOKEN, REFRESH_TOKEN)

        replay = consume_auth_handoff_code(db_session, code, VERIFIER)
        assert replay is None, (
            f"Expected single-use replay to return None, got {replay!r}"
        )

    def test_consume_after_expiry_returns_none(
        self, db_session: Session, bootstrapped_user: UUID
    ):
        code = "nx_hand_expired-fixture-code"
        now = datetime.now(UTC)
        db_session.add(
            AuthHandoffCode(
                user_id=bootstrapped_user,
                code_hash=_sha256(code),
                challenge=_sha256(VERIFIER),
                access_token=ACCESS_TOKEN,
                refresh_token=REFRESH_TOKEN,
                created_at=now - timedelta(minutes=2),
                expires_at=now - timedelta(minutes=1),
            )
        )
        db_session.flush()

        result = consume_auth_handoff_code(db_session, code, VERIFIER)

        assert result is None, f"Expected expired-code consume to return None, got {result!r}"
        survivor = db_session.execute(
            select(AuthHandoffCode).where(AuthHandoffCode.user_id == bootstrapped_user)
        ).scalar_one_or_none()
        assert survivor is not None, (
            "Expected the WHERE clause to filter by expiry without deleting; "
            "expired rows are removed by the purge job, not by consume."
        )

    def test_purge_deletes_expired_rows_and_leaves_unexpired_rows_alone(
        self, db_session: Session, bootstrapped_user: UUID
    ):
        now = datetime.now(UTC)
        expired_code = "nx_hand_expired-purge-target"
        live_code = "nx_hand_live-purge-survivor"
        db_session.add(
            AuthHandoffCode(
                user_id=bootstrapped_user,
                code_hash=_sha256(expired_code),
                challenge=_sha256(VERIFIER),
                access_token=ACCESS_TOKEN,
                refresh_token=REFRESH_TOKEN,
                created_at=now - timedelta(minutes=5),
                expires_at=now - timedelta(minutes=4),
            )
        )
        db_session.add(
            AuthHandoffCode(
                user_id=bootstrapped_user,
                code_hash=_sha256(live_code),
                challenge=_sha256(VERIFIER),
                access_token=ACCESS_TOKEN,
                refresh_token=REFRESH_TOKEN,
                created_at=now,
                expires_at=now + timedelta(seconds=90),
            )
        )
        db_session.flush()

        deleted = purge_expired_auth_handoff_codes(db_session)

        assert deleted == 1, f"Expected purge to delete exactly the expired row, got {deleted}"
        remaining = db_session.execute(
            select(AuthHandoffCode.code_hash).where(
                AuthHandoffCode.user_id == bootstrapped_user
            )
        ).scalars().all()
        assert remaining == [_sha256(live_code)], (
            f"Expected only the live row to survive purge, got {remaining!r}"
        )


class TestAuthHandoffCodeRoutes:
    def test_mint_route_returns_code_envelope_and_persists_row(
        self, auth_client, direct_db: DirectSessionManager
    ):
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))
        direct_db.register_cleanup("auth_handoff_codes", "user_id", user_id)
        direct_db.register_cleanup("users", "id", user_id)

        response = auth_client.post(
            "/auth/handoff-codes",
            headers=auth_headers(user_id),
            json={
                "access_token": ACCESS_TOKEN,
                "refresh_token": REFRESH_TOKEN,
                "challenge": _sha256(VERIFIER),
            },
        )

        assert response.status_code == 201, (
            f"Expected 201 from mint route, got {response.status_code}: {response.json()}"
        )
        code = response.json()["data"]["code"]
        assert code.startswith("nx_hand_"), f"Expected nx_hand_ prefix, got {code!r}"

        with direct_db.session() as db:
            row = db.execute(
                select(AuthHandoffCode).where(AuthHandoffCode.user_id == user_id)
            ).scalar_one()
            assert row.code_hash == _sha256(code)
            assert row.challenge == _sha256(VERIFIER)

    def test_consume_route_returns_token_pair_envelope_for_valid_code_and_verifier(
        self, auth_client, direct_db: DirectSessionManager
    ):
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))
        direct_db.register_cleanup("auth_handoff_codes", "user_id", user_id)
        direct_db.register_cleanup("users", "id", user_id)

        mint = auth_client.post(
            "/auth/handoff-codes",
            headers=auth_headers(user_id),
            json={
                "access_token": ACCESS_TOKEN,
                "refresh_token": REFRESH_TOKEN,
                "challenge": _sha256(VERIFIER),
            },
        )
        assert mint.status_code == 201
        code = mint.json()["data"]["code"]

        consume = auth_client.post(
            "/auth/handoff-codes/consume",
            json={"code": code, "verifier": VERIFIER},
        )

        assert consume.status_code == 200, (
            f"Expected 200 from consume route, got {consume.status_code}: {consume.json()}"
        )
        data = consume.json()["data"]
        assert data == {"access_token": ACCESS_TOKEN, "refresh_token": REFRESH_TOKEN}

    def test_consume_route_rejects_wrong_verifier_with_unauthenticated_error(
        self, auth_client, direct_db: DirectSessionManager
    ):
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))
        direct_db.register_cleanup("auth_handoff_codes", "user_id", user_id)
        direct_db.register_cleanup("users", "id", user_id)

        mint = auth_client.post(
            "/auth/handoff-codes",
            headers=auth_headers(user_id),
            json={
                "access_token": ACCESS_TOKEN,
                "refresh_token": REFRESH_TOKEN,
                "challenge": _sha256(VERIFIER),
            },
        )
        assert mint.status_code == 201
        code = mint.json()["data"]["code"]

        response = auth_client.post(
            "/auth/handoff-codes/consume",
            json={"code": code, "verifier": "attacker-guessed-verifier"},
        )

        assert response.status_code == 401, (
            f"Expected 401 for wrong verifier, got {response.status_code}: {response.json()}"
        )
        assert response.json()["error"]["code"] == "E_UNAUTHENTICATED"
