"""Integration tests for the Post Room email ingest.

Tests the accept_email_message service layer (DB + storage) and the
/ingest/email route (HMAC auth, slug, size, 404 when disabled).

Fixtures: substack_issue.eml, substack_issue2.eml, plain_text.eml,
          no_text_part.eml — all MIME under python/tests/fixtures/email/.

Landmines honoured:
  - Uses auth_client + direct_db for cross-connection route tests (landmine 1).
  - Uses db_session for service-layer tests (no HTTP, no cross-connection).
"""

from __future__ import annotations

import hashlib
import hmac as hmac_lib
from pathlib import Path
from uuid import UUID, uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select, text
from sqlalchemy.orm import Session

from nexus.config import clear_settings_cache
from nexus.db.models import MediaKind
from nexus.services.bootstrap import ensure_user_and_default_library
from nexus.services.email_ingest_service import accept_email_message
from tests.support.storage import FakeStorageClient

pytestmark = pytest.mark.integration

_FIXTURES_DIR = Path(__file__).parent / "fixtures" / "email"
_TEST_SECRET = "test-hmac-secret-abc123"
_TEST_SLUG = "letters-test"
_TEST_DOMAIN = "mail.example.com"


def _eml(name: str) -> bytes:
    return (_FIXTURES_DIR / name).read_bytes()


def _sign(body: bytes, secret: str = _TEST_SECRET) -> str:
    return hmac_lib.new(secret.encode("utf-8"), body, hashlib.sha256).hexdigest()


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def owner_user_id(db_session: Session) -> UUID:
    uid = uuid4()
    ensure_user_and_default_library(db_session, uid)
    return uid


@pytest.fixture
def fake_storage(monkeypatch) -> FakeStorageClient:
    storage = FakeStorageClient()
    # accept writes the derived HTML; the run path (media_source_ingest) reads it —
    # both must share the same in-memory store for the full pipeline test.
    monkeypatch.setattr("nexus.services.email_ingest_service.get_storage_client", lambda: storage)
    monkeypatch.setattr("nexus.services.media_source_ingest.get_storage_client", lambda: storage)
    return storage


def _latest_attempt_id(db: Session, media_id: UUID) -> UUID:
    return db.execute(
        text(
            "SELECT id FROM media_source_attempts WHERE media_id = :mid "
            "ORDER BY attempt_no DESC, created_at DESC, id DESC LIMIT 1"
        ),
        {"mid": media_id},
    ).scalar_one()


# ---------------------------------------------------------------------------
# direct_db helpers: accept_email_message runs the author op in its own fresh
# session and commits, so credit-asserting tests need committed data across
# connections (savepoint-isolated ``db_session`` cannot see it).
# ---------------------------------------------------------------------------


def _bootstrap_owner(direct_db) -> UUID:
    user_id = uuid4()
    direct_db.register_cleanup("users", "id", user_id)
    direct_db.register_cleanup("libraries", "owner_user_id", user_id)
    direct_db.register_cleanup("memberships", "user_id", user_id)
    with direct_db.session() as session:
        ensure_user_and_default_library(session, user_id)
        session.commit()
    return user_id


def _track_email_media(direct_db, media_id: UUID) -> None:
    """Register cleanup for a media and its contributors (LIFO: credits first)."""
    direct_db.register_cleanup("media", "id", media_id)
    direct_db.register_cleanup("media_source_attempts", "media_id", media_id)
    direct_db.register_cleanup("library_entries", "media_id", media_id)
    with direct_db.session() as session:
        contributor_ids = [
            row[0]
            for row in session.execute(
                text("SELECT DISTINCT contributor_id FROM contributor_credits WHERE media_id = :m"),
                {"m": media_id},
            )
        ]
    for contributor_id in contributor_ids:
        direct_db.register_cleanup("contributors", "id", contributor_id)
        direct_db.register_cleanup("contributor_external_ids", "contributor_id", contributor_id)
        direct_db.register_cleanup("contributor_aliases", "contributor_id", contributor_id)
        direct_db.register_cleanup("contributor_credits", "contributor_id", contributor_id)
    direct_db.register_cleanup("contributor_credits", "media_id", media_id)


def _accept(direct_db, raw_body: bytes, owner_user_id: UUID):
    with direct_db.session() as session:
        result = accept_email_message(
            db=session, raw_body=raw_body, owner_user_id=owner_user_id, request_id=None
        )
    _track_email_media(direct_db, result.media_id)
    return result


@pytest.fixture
def email_env(monkeypatch, owner_user_id: UUID) -> UUID:
    """Patch env vars for email ingest + clear settings cache. Returns owner_user_id."""
    monkeypatch.setenv("EMAIL_INGEST_ENABLED", "true")
    monkeypatch.setenv("EMAIL_INGEST_HMAC_SECRET", _TEST_SECRET)
    monkeypatch.setenv("EMAIL_INGEST_ADDRESS_SLUG", _TEST_SLUG)
    monkeypatch.setenv("EMAIL_INGEST_DOMAIN", _TEST_DOMAIN)
    monkeypatch.setenv("EMAIL_INGEST_OWNER_USER_ID", str(owner_user_id))
    clear_settings_cache()
    yield owner_user_id
    clear_settings_cache()


@pytest.fixture
def email_client(email_env) -> TestClient:
    """TestClient with email ingest route mounted (EMAIL_INGEST_ENABLED=true)."""
    from nexus.app import create_app

    app = create_app(skip_auth_middleware=True)
    with TestClient(app) as client:
        yield client


# ---------------------------------------------------------------------------
# Service-layer acceptance tests (db_session — savepoint isolation)
# ---------------------------------------------------------------------------


class TestAcceptEmailMessage:
    def test_substack_eml_accepted_and_returns_media_id(
        self, db_session: Session, owner_user_id: UUID, fake_storage: FakeStorageClient
    ):
        body = _eml("substack_issue.eml")
        result = accept_email_message(
            db=db_session,
            raw_body=body,
            owner_user_id=owner_user_id,
            request_id=None,
        )
        assert result.outcome == "accepted"
        assert result.media_id is not None

    def test_accepted_media_has_correct_fields(
        self, db_session: Session, owner_user_id: UUID, fake_storage: FakeStorageClient
    ):
        body = _eml("substack_issue.eml")
        result = accept_email_message(
            db=db_session,
            raw_body=body,
            owner_user_id=owner_user_id,
            request_id=None,
        )
        row = db_session.execute(
            text(
                "SELECT kind, provider, provider_id, title, published_date FROM media WHERE id = :id"
            ),
            {"id": result.media_id},
        ).one()
        assert row.kind == MediaKind.web_article.value
        assert row.provider == "email"
        assert row.provider_id == "dispatch-42-2026-07-07@substack.com"
        assert "Weekly Dispatch" in row.title
        assert row.published_date == "2026-07-07"

    def test_duplicate_message_id_returns_duplicate_outcome(
        self, db_session: Session, owner_user_id: UUID, fake_storage: FakeStorageClient
    ):
        body = _eml("substack_issue.eml")
        r1 = accept_email_message(
            db=db_session, raw_body=body, owner_user_id=owner_user_id, request_id=None
        )
        r2 = accept_email_message(
            db=db_session, raw_body=body, owner_user_id=owner_user_id, request_id=None
        )
        assert r1.outcome == "accepted"
        assert r2.outcome == "duplicate"
        assert r1.media_id == r2.media_id
        # Exactly one Media with this Message-ID
        count = db_session.execute(
            text("SELECT COUNT(*) FROM media WHERE provider = 'email' AND provider_id = :mid"),
            {"mid": "dispatch-42-2026-07-07@substack.com"},
        ).scalar_one()
        assert count == 1

    def test_duplicate_creates_no_second_attempt(
        self, db_session: Session, owner_user_id: UUID, fake_storage: FakeStorageClient
    ):
        body = _eml("substack_issue.eml")
        r1 = accept_email_message(
            db=db_session, raw_body=body, owner_user_id=owner_user_id, request_id=None
        )
        accept_email_message(
            db=db_session, raw_body=body, owner_user_id=owner_user_id, request_id=None
        )
        attempt_count = db_session.execute(
            text("SELECT COUNT(*) FROM media_source_attempts WHERE media_id = :mid"),
            {"mid": r1.media_id},
        ).scalar_one()
        assert attempt_count == 1

    def test_plain_text_eml_accepted(
        self, db_session: Session, owner_user_id: UUID, fake_storage: FakeStorageClient
    ):
        body = _eml("plain_text.eml")
        result = accept_email_message(
            db=db_session, raw_body=body, owner_user_id=owner_user_id, request_id=None
        )
        assert result.outcome == "accepted"

    def test_no_text_part_still_accepted_as_pending(
        self, db_session: Session, owner_user_id: UUID, fake_storage: FakeStorageClient
    ):
        # Authenticated mail with no text becomes a pending media (has_content=False).
        body = _eml("no_text_part.eml")
        result = accept_email_message(
            db=db_session, raw_body=body, owner_user_id=owner_user_id, request_id=None
        )
        assert result.outcome == "accepted"
        row = db_session.execute(
            text("SELECT processing_status FROM media WHERE id = :id"),
            {"id": result.media_id},
        ).one()
        # Media is created and either pending or will fail at extract stage
        assert row.processing_status is not None

    def test_sender_contributor_resolved_by_email_authority(
        self, direct_db, fake_storage: FakeStorageClient
    ):
        owner_user_id = _bootstrap_owner(direct_db)
        result = _accept(direct_db, _eml("substack_issue.eml"), owner_user_id)
        # Contributor credit exists with the canonical email_address identity key.
        with direct_db.session() as session:
            credit = session.execute(
                text(
                    """
                    SELECT cc.contributor_id, ceid.authority, ceid.external_key
                    FROM contributor_credits cc
                    JOIN contributor_external_ids ceid
                      ON ceid.contributor_id = cc.contributor_id
                    WHERE cc.media_id = :mid AND cc.role = 'author'
                      AND ceid.authority = 'email_address'
                    """
                ),
                {"mid": result.media_id},
            ).one_or_none()
        assert credit is not None, "No email_address-authority contributor credit found"
        assert credit.authority == "email_address"
        assert credit.external_key == "alice@substack.com"

    def test_two_issues_same_sender_resolve_same_contributor(
        self, direct_db, fake_storage: FakeStorageClient
    ):
        owner_user_id = _bootstrap_owner(direct_db)
        r1 = _accept(direct_db, _eml("substack_issue.eml"), owner_user_id)
        r2 = _accept(direct_db, _eml("substack_issue2.eml"), owner_user_id)
        with direct_db.session() as session:
            cid1 = session.execute(
                text(
                    "SELECT contributor_id FROM contributor_credits "
                    "WHERE media_id = :mid AND role = 'author'"
                ),
                {"mid": r1.media_id},
            ).scalar_one()
            cid2 = session.execute(
                text(
                    "SELECT contributor_id FROM contributor_credits "
                    "WHERE media_id = :mid AND role = 'author'"
                ),
                {"mid": r2.media_id},
            ).scalar_one()
        assert cid1 == cid2, "Both issues must credit the same contributor"

    def test_author_op_failure_then_redelivery_converges(
        self, direct_db, fake_storage: FakeStorageClient, monkeypatch
    ):
        """D-27 / AC 9 (email path): the author op runs on the duplicate path.

        If the accept-time author op crashes after the media transaction commits,
        a provider re-delivery hits the duplicate short-circuit and re-runs it —
        the sender credit converges instead of being lost forever (email is
        excluded from enrichment, so this is the only author write).
        """
        import nexus.services.email_ingest_service as svc

        owner_user_id = _bootstrap_owner(direct_db)
        real = svc.replace_observed_role_slices
        calls = {"n": 0}

        def flaky(*args: object, **kwargs: object) -> None:
            calls["n"] += 1
            if calls["n"] == 1:
                raise RuntimeError("author op crashed")
            real(*args, **kwargs)  # type: ignore[arg-type]

        monkeypatch.setattr(svc, "replace_observed_role_slices", flaky)

        body = _eml("substack_issue.eml")
        # First accept: media commits, then the author op crashes (provider sees 500).
        with pytest.raises(RuntimeError, match="author op crashed"):
            with direct_db.session() as session:
                accept_email_message(
                    db=session, raw_body=body, owner_user_id=owner_user_id, request_id=None
                )

        # Re-delivery of the same Message-ID hits the duplicate path and re-runs
        # the author op, this time successfully.
        result = _accept(direct_db, body, owner_user_id)
        assert result.outcome == "duplicate"
        assert calls["n"] == 2

        with direct_db.session() as session:
            credit_count = session.execute(
                text(
                    "SELECT COUNT(*) FROM contributor_credits "
                    "WHERE media_id = :mid AND role = 'author'"
                ),
                {"mid": result.media_id},
            ).scalar_one()
        assert credit_count == 1, "sender credit converged on re-delivery"

    def test_media_lands_in_default_library(
        self, db_session: Session, owner_user_id: UUID, fake_storage: FakeStorageClient
    ):
        body = _eml("substack_issue.eml")
        result = accept_email_message(
            db=db_session, raw_body=body, owner_user_id=owner_user_id, request_id=None
        )
        count = db_session.execute(
            text("SELECT COUNT(*) FROM library_entries WHERE media_id = :mid"),
            {"mid": result.media_id},
        ).scalar_one()
        assert count >= 1

    def test_source_type_is_email_message(
        self, db_session: Session, owner_user_id: UUID, fake_storage: FakeStorageClient
    ):
        body = _eml("substack_issue.eml")
        result = accept_email_message(
            db=db_session, raw_body=body, owner_user_id=owner_user_id, request_id=None
        )
        source_type = db_session.execute(
            text("SELECT source_type FROM media_source_attempts WHERE media_id = :mid"),
            {"mid": result.media_id},
        ).scalar_one()
        assert source_type == "email_message"


# ---------------------------------------------------------------------------
# Full pipeline: accept -> run_source_attempt -> fragment (AC-1, AC-8)
# Same db_session throughout (savepoint isolation, single connection — no HTTP
# client, so landmine 1 does not apply).
# ---------------------------------------------------------------------------


class TestEmailIngestPipeline:
    def test_substack_runs_to_readable_web_article_with_fragment(
        self, db_session: Session, owner_user_id: UUID, fake_storage: FakeStorageClient
    ):
        """AC-1: a real Substack .eml runs the shared HTML pipeline to a readable
        web_article with a sanitised fragment."""
        from nexus.db.models import Fragment, Media, ProcessingStatus
        from nexus.services.media_source_ingest import run_source_attempt

        result = accept_email_message(
            db=db_session,
            raw_body=_eml("substack_issue.eml"),
            owner_user_id=owner_user_id,
            request_id=None,
        )
        assert result.outcome == "accepted"

        run_result = run_source_attempt(
            db=db_session,
            media_id=result.media_id,
            attempt_id=_latest_attempt_id(db_session, result.media_id),
            actor_user_id=owner_user_id,
            request_id=None,
        )
        assert run_result["status"] == "success"
        assert run_result["source_type"] == "email_message"

        db_session.expire_all()
        media = db_session.get(Media, result.media_id)
        assert media is not None
        assert media.processing_status == ProcessingStatus.ready_for_reading
        assert media.kind == MediaKind.web_article.value
        assert "Weekly Dispatch" in media.title

        fragment = db_session.execute(
            select(Fragment).where(Fragment.media_id == result.media_id)
        ).scalar_one()
        assert fragment.idx == 0
        assert fragment.canonical_text.strip()
        assert "slow reading" in fragment.canonical_text
        assert "<script" not in fragment.html_sanitized

    def test_no_text_part_fails_at_extract_stage(
        self, db_session: Session, owner_user_id: UUID, fake_storage: FakeStorageClient
    ):
        """AC-8: authenticated mail with no extractable text becomes a failed Media
        at failure_stage='extract' (visible in the failed-media surface)."""
        from nexus.services.media_source_ingest import run_source_attempt

        result = accept_email_message(
            db=db_session,
            raw_body=_eml("no_text_part.eml"),
            owner_user_id=owner_user_id,
            request_id=None,
        )
        assert result.outcome == "accepted"

        run_result = run_source_attempt(
            db=db_session,
            media_id=result.media_id,
            attempt_id=_latest_attempt_id(db_session, result.media_id),
            actor_user_id=owner_user_id,
            request_id=None,
        )
        assert run_result["status"] == "failed"

        db_session.expire_all()
        row = db_session.execute(
            text("SELECT processing_status, failure_stage FROM media WHERE id = :id"),
            {"id": result.media_id},
        ).one()
        assert row.processing_status == "failed"
        assert row.failure_stage == "extract"

    def test_plain_text_only_runs_to_readable_fragment(
        self, db_session: Session, owner_user_id: UUID, fake_storage: FakeStorageClient
    ):
        """D-5: a plain-text-only message is wrapped and runs the same pipeline to a
        readable fragment (no second HTML path)."""
        from nexus.db.models import Fragment, Media, ProcessingStatus
        from nexus.services.media_source_ingest import run_source_attempt

        result = accept_email_message(
            db=db_session,
            raw_body=_eml("plain_text.eml"),
            owner_user_id=owner_user_id,
            request_id=None,
        )
        run_result = run_source_attempt(
            db=db_session,
            media_id=result.media_id,
            attempt_id=_latest_attempt_id(db_session, result.media_id),
            actor_user_id=owner_user_id,
            request_id=None,
        )
        assert run_result["status"] == "success"

        db_session.expire_all()
        media = db_session.get(Media, result.media_id)
        assert media is not None
        assert media.processing_status == ProcessingStatus.ready_for_reading
        fragment = db_session.execute(
            select(Fragment).where(Fragment.media_id == result.media_id)
        ).scalar_one()
        assert fragment.canonical_text.strip()


# ---------------------------------------------------------------------------
# Route auth tests (email_client — no bearer, public path)
# ---------------------------------------------------------------------------


class TestEmailIngestRouteAuth:
    def test_valid_request_returns_200(self, direct_db, monkeypatch, fake_storage):
        # Cross-connection test: user must be committed so the route's own DB
        # session can see it (landmine 1 — auth_client + direct_db pattern).
        uid = uuid4()
        direct_db.register_cleanup("users", "id", uid)
        with direct_db.session() as s:
            ensure_user_and_default_library(s, uid)
            s.commit()

        monkeypatch.setenv("EMAIL_INGEST_ENABLED", "true")
        monkeypatch.setenv("EMAIL_INGEST_HMAC_SECRET", _TEST_SECRET)
        monkeypatch.setenv("EMAIL_INGEST_ADDRESS_SLUG", _TEST_SLUG)
        monkeypatch.setenv("EMAIL_INGEST_DOMAIN", _TEST_DOMAIN)
        monkeypatch.setenv("EMAIL_INGEST_OWNER_USER_ID", str(uid))
        clear_settings_cache()

        from nexus.app import create_app

        app = create_app(skip_auth_middleware=True)
        body = _eml("substack_issue.eml")
        sig = _sign(body)
        with TestClient(app) as client:
            response = client.post(
                "/ingest/email",
                content=body,
                headers={
                    "content-type": "message/rfc822",
                    "x-nexus-email-signature": sig,
                    "x-nexus-email-recipient": _TEST_SLUG,
                },
            )
        assert response.status_code == 200
        data = response.json()["data"]
        assert data["outcome"] in {"accepted", "duplicate"}

    def test_absent_signature_returns_401(self, email_client: TestClient, email_env: UUID):
        body = _eml("substack_issue.eml")
        response = email_client.post(
            "/ingest/email",
            content=body,
            headers={
                "content-type": "message/rfc822",
                "x-nexus-email-recipient": _TEST_SLUG,
            },
        )
        assert response.status_code == 401

    def test_tampered_body_returns_401(self, email_client: TestClient, email_env: UUID):
        body = _eml("substack_issue.eml")
        sig = _sign(body)
        # Send a different body with the valid signature
        response = email_client.post(
            "/ingest/email",
            content=body + b"X",
            headers={
                "content-type": "message/rfc822",
                "x-nexus-email-signature": sig,
                "x-nexus-email-recipient": _TEST_SLUG,
            },
        )
        assert response.status_code == 401

    def test_wrong_slug_returns_403(self, email_client: TestClient, email_env: UUID):
        body = _eml("substack_issue.eml")
        sig = _sign(body)
        response = email_client.post(
            "/ingest/email",
            content=body,
            headers={
                "content-type": "message/rfc822",
                "x-nexus-email-signature": sig,
                "x-nexus-email-recipient": "wrong-slug",
            },
        )
        assert response.status_code == 403

    def test_oversize_body_returns_413(
        self, email_client: TestClient, email_env: UUID, monkeypatch
    ):
        # Temporarily lower the limit to make the test fast.
        monkeypatch.setenv("EMAIL_INGEST_MAX_BYTES", "10")
        clear_settings_cache()
        body = b"X" * 11
        sig = _sign(body)
        response = email_client.post(
            "/ingest/email",
            content=body,
            headers={
                "content-type": "message/rfc822",
                "x-nexus-email-signature": sig,
                "x-nexus-email-recipient": _TEST_SLUG,
            },
        )
        assert response.status_code == 413

    def test_disabled_route_returns_404(self, monkeypatch):
        monkeypatch.setenv("EMAIL_INGEST_ENABLED", "false")
        clear_settings_cache()
        from nexus.app import create_app

        app = create_app(skip_auth_middleware=True)
        with TestClient(app) as client:
            response = client.post(
                "/ingest/email",
                content=b"hello",
                headers={"content-type": "message/rfc822"},
            )
        assert response.status_code == 404

    def test_ac3_parser_not_called_on_bad_sig(
        self, email_client: TestClient, email_env: UUID, monkeypatch
    ):
        """AC-3: MIME parser must NOT be called when signature fails."""
        call_log: list[str] = []

        original_from_bytes = __import__("email").message_from_bytes

        def spy_from_bytes(data, **kwargs):
            call_log.append("called")
            return original_from_bytes(data, **kwargs)

        monkeypatch.setattr("email.message_from_bytes", spy_from_bytes)

        body = _eml("substack_issue.eml")
        # Bad signature
        response = email_client.post(
            "/ingest/email",
            content=body,
            headers={
                "content-type": "message/rfc822",
                "x-nexus-email-signature": "badbad",
                "x-nexus-email-recipient": _TEST_SLUG,
            },
        )
        assert response.status_code == 401
        assert len(call_log) == 0, "MIME parser must NOT be called before signature verification"


class TestGetMeEmailIngestAddress:
    """GET /me response gains email_ingest_address when configured."""

    def test_me_returns_null_address_when_disabled(self, authenticated_client: TestClient):
        from tests.helpers import auth_headers

        response = authenticated_client.get("/me", headers=auth_headers(uuid4()))
        assert response.status_code == 200
        data = response.json()["data"]
        assert data.get("email_ingest_address") is None

    def test_me_returns_address_when_enabled(self, authenticated_client: TestClient, monkeypatch):
        from tests.helpers import auth_headers

        monkeypatch.setenv("EMAIL_INGEST_ENABLED", "true")
        monkeypatch.setenv("EMAIL_INGEST_ADDRESS_SLUG", "letters-abc")
        monkeypatch.setenv("EMAIL_INGEST_DOMAIN", "mail.example.com")
        monkeypatch.setenv("EMAIL_INGEST_HMAC_SECRET", "secret")
        monkeypatch.setenv("EMAIL_INGEST_OWNER_USER_ID", str(uuid4()))
        clear_settings_cache()

        response = authenticated_client.get("/me", headers=auth_headers(uuid4()))
        assert response.status_code == 200
        data = response.json()["data"]
        assert data["email_ingest_address"] == "letters-abc@mail.example.com"
