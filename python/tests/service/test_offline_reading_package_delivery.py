"""Retained package preparation, one-use transfer, and current account authority."""

from __future__ import annotations

import asyncio
import base64
import hashlib
import io
import json
import zipfile
from dataclasses import dataclass
from pathlib import Path
from uuid import UUID, uuid4

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import Engine, text
from sqlalchemy.orm import Session
from starlette.types import Message, Receive, Scope, Send

from nexus.api.read_admission import ReadAdmission
from nexus.app import add_request_id_middleware, create_app
from nexus.auth.middleware import AuthMiddleware
from nexus.config import clear_settings_cache, get_settings, require_reader_publication_limits
from nexus.db.models import (
    Media,
    MediaKind,
    ProcessingStatus,
    ReaderPublication,
    ReaderPublicationArtifact,
)
from nexus.db.session import create_session_factory
from nexus.jobs.registry import get_default_registry
from nexus.jobs.worker import JobWorker
from nexus.services.bootstrap import ensure_user_and_default_library
from nexus.services.library_entries import (
    delete_entry,
    ensure_media_in_default_library,
    media_target,
)
from nexus.services.offline_reading_packages import verify_offline_reading_zip
from nexus.services.offline_reading_preparation import ensure_offline_package_for_viewer
from nexus.services.stream_tokens import (
    mint_offline_reading_package_token,
    verify_offline_reading_package_token,
)
from nexus.storage.client import get_storage_client
from nexus.storage.paths import build_reader_publication_member_storage_path
from tests.testkit.auth import StaticTokenVerifier
from tests.testkit.unreachable_state import make_pending_job_due

_KIND = "prepare_offline_reading_package"
_FIXTURE = Path(__file__).parents[3] / "testdata/offline-reading/retained-unicode-schema-2.zip"


@dataclass(frozen=True, slots=True)
class _ReadyArticle:
    viewer_id: UUID
    email: str
    default_library_id: UUID
    media_id: UUID
    generation: int = 7


def _commit_ready_article(engine: Engine, *, title: str) -> _ReadyArticle:
    """Frozen generation seven coexists with a replacement currently extracting."""
    viewer_id, media_id = uuid4(), uuid4()
    email = f"offline-package-{viewer_id}@example.invalid"
    with Session(engine) as db:
        library_id = ensure_user_and_default_library(db, viewer_id, email)
        db.add(
            Media(
                id=media_id,
                kind=MediaKind.web_article.value,
                title=title,
                processing_status=ProcessingStatus.extracting,
                created_by_user_id=viewer_id,
            )
        )
        db.flush()
        ensure_media_in_default_library(db, viewer_id, media_id)
        db.add(ReaderPublication(id=uuid4(), media_id=media_id, generation=8))
        db.commit()
    storage = get_storage_client()
    with zipfile.ZipFile(_FIXTURE) as archive, Session(engine) as db:
        for key in archive.namelist():
            if key == "manifest.json":
                continue
            body = archive.read(key)
            if key == "descriptor.json":
                descriptor = json.loads(body)
                descriptor["media_id"] = str(media_id)
                body = json.dumps(descriptor, ensure_ascii=False, separators=(",", ":")).encode()
                role = "descriptor"
            elif key.startswith("index/"):
                role = "index"
            elif key.startswith("units/"):
                role = "unit"
            else:
                role = "asset"
            digest = hashlib.sha256(body).hexdigest()
            storage_path = build_reader_publication_member_storage_path(media_id, digest)
            media_type = "image/png" if role == "asset" else "application/json"
            storage.put_object(storage_path, body, media_type)
            db.add(
                ReaderPublicationArtifact(
                    media_id=media_id,
                    generation=7,
                    path=key,
                    role=role,
                    storage_path=storage_path,
                    media_type=media_type,
                    size_bytes=len(body),
                    sha256=digest,
                )
            )
        db.commit()
    return _ReadyArticle(viewer_id, email, library_id, media_id)


def _package_app(
    verifier: StaticTokenVerifier,
    *,
    requires_internal_header: bool = False,
    internal_secret: str | None = None,
) -> FastAPI:
    app = create_app(
        install_auth_middleware=lambda application: application.add_middleware(
            AuthMiddleware,
            verifier=verifier,
            requires_internal_header=requires_internal_header,
            internal_secret=internal_secret,
            bootstrap_callback=None,
        )
    )
    add_request_id_middleware(app, log_requests=False)
    return app


def _prepare(engine: Engine, article: _ReadyArticle) -> UUID:
    with Session(engine) as db:
        ensure_offline_package_for_viewer(
            db,
            viewer_id=article.viewer_id,
            media_id=article.media_id,
            generation=article.generation,
        )
        job_id = db.scalar(
            text(
                "SELECT id FROM background_jobs WHERE kind = :kind AND payload->>'media_id' = :media"
            ),
            {"kind": _KIND, "media": str(article.media_id)},
        )
        assert job_id is not None
    worker = JobWorker(
        session_factory=create_session_factory(engine),
        worker_id=f"offline-package-proof-{uuid4()}",
        registry={_KIND: get_default_registry()[_KIND]},
        allowed_kinds=(_KIND,),
    )
    assert worker.run_exact(job_id) is True
    with Session(engine) as db:
        row = db.execute(
            text("SELECT status, result, error_code FROM background_jobs WHERE id = :id"),
            {"id": job_id},
        ).one()
        assert row.status == "succeeded", row
        assert row.result == {"status": "ready", "reader_generation": 7}
    return job_id


def _claimed_jtis(engine: Engine, jtis: tuple[str, ...]) -> set[str]:
    with Session(engine) as db:
        return set(
            db.scalars(
                text("SELECT jti FROM stream_token_jti_claims WHERE jti = ANY(:jtis)"),
                {"jtis": list(jtis)},
            )
        )


def _mint(article: _ReadyArticle) -> tuple[str, str]:
    minted = mint_offline_reading_package_token(
        user_id=article.viewer_id, media_id=article.media_id, reader_generation=article.generation
    )
    jti = verify_offline_reading_package_token(minted.token, expected_media_id=article.media_id).jti
    return minted.token, jti


def test_direct_package_is_account_generation_integrity_and_replay_bound(engine: Engine) -> None:
    article = _commit_ready_article(engine, title="Replacement eight is extracting")
    verifier = StaticTokenVerifier(article.viewer_id, article.email)
    headers = {
        "Authorization": f"Bearer {verifier.token}",
        "X-Nexus-Expected-Account-Id": str(article.viewer_id),
    }
    mint_path = f"/internal/media/{article.media_id}/offline-reading-token"
    request = {"expected_reader_generation": 7}
    with TestClient(_package_app(verifier)) as client:
        foreign = client.post(
            mint_path,
            json=request,
            headers={**headers, "X-Nexus-Expected-Account-Id": str(uuid4())},
        )
        assert foreign.status_code == 403, foreign.text
        with Session(engine) as db:
            assert (
                db.scalar(
                    text(
                        "SELECT count(*) FROM background_jobs WHERE kind = :kind AND payload->>'media_id' = :media"
                    ),
                    {"kind": _KIND, "media": str(article.media_id)},
                )
                == 0
            )
        pending = client.post(mint_path, json=request, headers=headers)
        assert pending.status_code == 202, pending.text
        expected_status = (
            f"/media/{article.media_id}/reader-publications/7/offline-package?schema=2"
        )
        assert pending.json()["data"] == {"reader_generation": 7, "status_path": expected_status}
        repeated = client.post(mint_path, json=request, headers=headers)
        assert repeated.status_code == 202, repeated.text
        preparing = client.get(expected_status, headers=headers)
        assert preparing.json()["data"] == {"reader_generation": 7, "state": {"kind": "Preparing"}}
        wrong_status_account = client.get(
            expected_status, headers={**headers, "X-Nexus-Expected-Account-Id": str(uuid4())}
        )
        assert wrong_status_account.status_code == 403
        with Session(engine) as db:
            assert (
                db.scalar(
                    text(
                        "SELECT count(*) FROM background_jobs WHERE kind = :kind AND payload->>'media_id' = :media"
                    ),
                    {"kind": _KIND, "media": str(article.media_id)},
                )
                == 1
            )
            assert (
                db.scalar(
                    text(
                        "SELECT count(*) FROM reader_publication_artifacts WHERE media_id = :media AND role = 'archive'"
                    ),
                    {"media": article.media_id},
                )
                == 0
            )
        _prepare(engine, article)
        ready = client.get(expected_status, headers=headers)
        assert ready.json()["data"] == {"reader_generation": 7, "state": {"kind": "Ready"}}
        binding = client.get("/internal/offline-reading/account-binding", headers=headers)
        assert binding.json()["data"] == {
            "account_id": str(article.viewer_id),
            "protocol_version": 1,
            "package_schema_version": 2,
            "reader_contract_version": 1,
            "minimum_reader_bundle_version": 2,
        }
        mint = client.post(mint_path, json=request, headers=headers)
        assert mint.status_code == 200, mint.text
        minted = mint.json()["data"]
        assert minted["account_id"] == str(article.viewer_id)
        assert minted["reader_generation"] == 7
        assert minted["package_schema_version"] == 2
        direct_headers = {
            "Authorization": f"Bearer {minted['token']}",
            "Accept-Encoding": "identity",
        }
        path = f"/offline-reading/packages/{article.media_id}"
        # Current fragments may be replacing. Transfer must not assemble or read them.
        with Session(engine) as blocker:
            blocker.execute(text("LOCK TABLE fragments IN ACCESS EXCLUSIVE MODE"))
            response = client.get(path, headers=direct_headers)
            blocker.rollback()
        replay = client.get(path, headers=direct_headers)
    assert response.status_code == 200, response.text[:200]
    assert response.headers["content-type"] == "application/vnd.nexus.offline-reading+zip"
    assert response.headers["cache-control"] == "private, no-store, no-transform"
    assert response.headers["content-length"] == str(len(response.content))
    assert "content-encoding" not in response.headers
    assert response.headers["nexus-account-id"] == str(article.viewer_id)
    assert response.headers["nexus-reader-generation"] == "7"
    expected_digest = base64.b64encode(hashlib.sha256(response.content).digest()).decode("ascii")
    assert response.headers["content-digest"] == f"sha-256=:{expected_digest}:"
    verified = verify_offline_reading_zip(
        response.content, publication_limits=require_reader_publication_limits()
    )
    assert verified.manifest.media_id == article.media_id
    assert verified.manifest.reader_generation == 7
    assert verified.manifest.title == "café 🧠 — retained seven"
    with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
        assert "reader.json" not in archive.namelist()
        units = [
            json.loads(archive.read(key))
            for key in sorted(archive.namelist())
            if key.startswith("units/")
        ]
        assert "".join(unit["canonical_text"] for unit in units) == "café 🧠\ncat"
        assert len([key for key in archive.namelist() if key.startswith("assets/")]) == 1
        expanded = sum(archive.getinfo(entry.path).file_size for entry in verified.manifest.entries)
        assert response.headers["nexus-expanded-length"] == str(expanded)
    assert replay.status_code == 401, replay.text[:200]
    assert replay.json()["error"]["code"] == "E_STREAM_TOKEN_REPLAYED"
    with Session(engine) as db:
        assert (
            db.scalar(
                text("SELECT generation FROM reader_publications WHERE media_id = :id"),
                {"id": article.media_id},
            )
            == 8
        )
        assert (
            db.scalar(
                text(
                    "SELECT count(*) FROM reader_publication_artifacts WHERE media_id = :media AND role = 'archive'"
                ),
                {"media": article.media_id},
            )
            == 1
        )


def test_production_internal_header_posture_admits_only_the_direct_package_route(
    engine: Engine,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Prod requires X-Nexus-Internal; only this exact path may arrive without it.

    Caddy proxies the APK's package GET straight to the API with no internal
    header, so the path exemption must be evaluated before that check while every
    neighbouring and unrouted path keeps failing closed. The same request carries
    a browser Origin to prove the native lane emits no CORS while stream CORS is
    unchanged.
    """
    article = _commit_ready_article(engine, title="Production posture article")
    _prepare(engine, article)
    internal_secret = f"offline-reading-internal-{uuid4()}"
    browser_origin = get_settings().app_public_url.rstrip("/")
    monkeypatch.setenv("STREAM_CORS_ORIGINS", browser_origin)
    clear_settings_cache()
    try:
        verifier = StaticTokenVerifier(article.viewer_id, article.email)
        app = _package_app(
            verifier,
            requires_internal_header=True,
            internal_secret=internal_secret,
        )
        bearer = {"Authorization": f"Bearer {verifier.token}"}
        with TestClient(app) as client:
            mint = client.post(
                f"/internal/media/{article.media_id}/offline-reading-token",
                headers={
                    **bearer,
                    "X-Nexus-Internal": internal_secret,
                    "X-Nexus-Expected-Account-Id": str(article.viewer_id),
                },
                json={"expected_reader_generation": 7},
            )
            mint_without_internal = client.post(
                f"/internal/media/{article.media_id}/offline-reading-token",
                headers=bearer,
            )
            binding_without_internal = client.get(
                "/internal/offline-reading/account-binding",
                headers=bearer,
            )
            package_token = mint.json()["data"]["token"]
            package_bearer = {"Authorization": f"Bearer {package_token}"}
            direct = client.get(
                f"/offline-reading/packages/{article.media_id}",
                headers={
                    **package_bearer,
                    "Accept-Encoding": "identity",
                    "Origin": browser_origin,
                },
            )
            unrouted_child = client.get(
                f"/offline-reading/packages/{article.media_id}/extra",
                headers=package_bearer,
            )
            non_canonical_path = client.get(
                "/offline-reading/packages/not-a-uuid",
                headers=package_bearer,
            )
            stream_preflight = client.options(
                f"/stream/chat-runs/{uuid4()}",
                headers={
                    "Origin": browser_origin,
                    "Access-Control-Request-Method": "GET",
                },
            )
    finally:
        clear_settings_cache()

    assert mint.status_code == 200, mint.text
    assert mint_without_internal.status_code == 403, mint_without_internal.text
    assert mint_without_internal.json()["error"]["code"] == "E_INTERNAL_ONLY"
    assert binding_without_internal.status_code == 403, binding_without_internal.text
    assert binding_without_internal.json()["error"]["code"] == "E_INTERNAL_ONLY"
    assert direct.status_code == 200, (
        "the direct package route must serve a Caddy-forwarded request that carries "
        f"only its scoped token: {direct.status_code} {direct.text[:200]}"
    )
    assert direct.headers["nexus-account-id"] == str(article.viewer_id)
    assert direct.headers["content-type"] == "application/vnd.nexus.offline-reading+zip"
    assert [name for name in direct.headers if name.lower().startswith("access-control-")] == [], (
        f"the native package lane emitted browser CORS headers: {dict(direct.headers)}"
    )
    assert unrouted_child.status_code == 403, unrouted_child.text
    assert unrouted_child.json()["error"]["code"] == "E_INTERNAL_ONLY"
    assert non_canonical_path.status_code == 403, non_canonical_path.text
    assert non_canonical_path.json()["error"]["code"] == "E_INTERNAL_ONLY"
    assert stream_preflight.status_code == 204, stream_preflight.text
    assert stream_preflight.headers["access-control-allow-origin"] == browser_origin


def test_package_route_refuses_foreign_or_revoked_visibility_before_claiming_its_token(
    engine: Engine,
) -> None:
    """A signed token is not read authority: current visibility decides, before the claim.

    Visibility can be revoked inside the token's 300-second lifetime, and a token
    minted for another account must never resolve, so both denials must produce no
    package and must leave the one-use JTI unclaimed for the legitimate holder.
    """
    article = _commit_ready_article(engine, title="Revoked visibility article")
    stranger_id = uuid4()
    with Session(engine) as db:
        ensure_user_and_default_library(
            db,
            stranger_id,
            f"offline-package-stranger-{stranger_id}@example.invalid",
        )
        db.commit()
    foreign = mint_offline_reading_package_token(
        user_id=stranger_id,
        media_id=article.media_id,
        reader_generation=article.generation,
    )
    foreign_jti = verify_offline_reading_package_token(
        foreign.token,
        expected_media_id=article.media_id,
    ).jti
    owner_token, owner_jti = _mint(article)

    verifier = StaticTokenVerifier(article.viewer_id, article.email)
    app = _package_app(verifier)
    with TestClient(app) as client:
        path = f"/offline-reading/packages/{article.media_id}"
        foreign_response = client.get(
            path,
            headers={"Authorization": f"Bearer {foreign.token}"},
        )
        with Session(engine) as db:
            removed = delete_entry(db, article.default_library_id, media_target(article.media_id))
            db.commit()
        revoked_response = client.get(
            path,
            headers={"Authorization": f"Bearer {owner_token}"},
        )

    assert removed, "the fixture never removed the library entry it meant to revoke"
    assert foreign_response.status_code == 404, foreign_response.text
    assert foreign_response.json()["error"]["code"] == "E_MEDIA_NOT_FOUND"
    assert revoked_response.status_code == 404, (
        "a token minted before visibility was revoked still produced a package: "
        f"{revoked_response.status_code} {revoked_response.text[:200]}"
    )
    assert revoked_response.json()["error"]["code"] == "E_MEDIA_NOT_FOUND"
    assert _claimed_jtis(engine, (foreign_jti, owner_jti)) == set(), (
        "an authorization denial consumed a one-use package token"
    )


def test_a_broken_retained_member_fails_typed_and_stays_dead_across_later_mints(
    engine: Engine,
) -> None:
    """A retained member that no longer matches its digest is a permanent rejection.

    Preparation must record that condition as its own failure class, so the status
    route reports `Integrity` instead of a generic transient `Server` fault, and a
    later mint must leave the dead-lettered preparation terminal rather than buying
    it a fresh attempt budget.
    """
    article = _commit_ready_article(engine, title="Corrupted retained member")
    with Session(engine) as db:
        member = db.execute(
            text(
                "SELECT storage_path, size_bytes, media_type FROM reader_publication_artifacts "
                "WHERE media_id = :media AND generation = 7 AND role = 'asset'"
            ),
            {"media": article.media_id},
        ).one()
    get_storage_client().put_object(
        member.storage_path, bytes(member.size_bytes), member.media_type
    )

    with Session(engine) as db:
        assert (
            ensure_offline_package_for_viewer(
                db,
                viewer_id=article.viewer_id,
                media_id=article.media_id,
                generation=article.generation,
            )
            is False
        )
        job_id = db.scalar(
            text(
                "SELECT id FROM background_jobs WHERE kind = :kind AND payload->>'media_id' = :media"
            ),
            {"kind": _KIND, "media": str(article.media_id)},
        )
        assert job_id is not None
    definition = get_default_registry()[_KIND]
    worker = JobWorker(
        session_factory=create_session_factory(engine),
        worker_id=f"offline-package-integrity-{uuid4()}",
        registry={_KIND: definition},
        allowed_kinds=(_KIND,),
    )
    for _attempt in range(definition.max_attempts):
        assert worker.run_exact(job_id) is True
        with Session(engine) as db:
            if (
                db.scalar(text("SELECT status FROM background_jobs WHERE id = :id"), {"id": job_id})
                == "pending"
            ):
                make_pending_job_due(db, job_id=job_id)
    with Session(engine) as db:
        failed = db.execute(
            text("SELECT status, attempts, error_code FROM background_jobs WHERE id = :id"),
            {"id": job_id},
        ).one()
    assert (failed.status, failed.attempts, failed.error_code) == (
        "dead",
        definition.max_attempts,
        "E_OFFLINE_PACKAGE_INTEGRITY",
    ), failed

    verifier = StaticTokenVerifier(article.viewer_id, article.email)
    headers = {
        "Authorization": f"Bearer {verifier.token}",
        "X-Nexus-Expected-Account-Id": str(article.viewer_id),
    }
    status_path = f"/media/{article.media_id}/reader-publications/7/offline-package?schema=2"
    with TestClient(_package_app(verifier)) as client:
        failure = client.get(status_path, headers=headers)
        remint = client.post(
            f"/internal/media/{article.media_id}/offline-reading-token",
            json={"expected_reader_generation": 7},
            headers=headers,
        )
        after = client.get(status_path, headers=headers)

    assert failure.json()["data"] == {
        "reader_generation": 7,
        "state": {"kind": "Failed", "reason": "Integrity"},
    }
    assert remint.status_code == 202, remint.text
    assert after.json()["data"] == failure.json()["data"]
    with Session(engine) as db:
        unchanged = db.execute(
            text("SELECT status, attempts FROM background_jobs WHERE id = :id"),
            {"id": job_id},
        ).one()
    assert (unchanged.status, unchanged.attempts) == ("dead", definition.max_attempts), (
        "a client mint re-armed a dead-lettered preparation"
    )


def test_a_second_package_transfer_is_refused_retryable_without_burning_its_token(
    engine: Engine,
) -> None:
    """Package bytes are bounded by their own pool, and a refusal costs nothing.

    The transfer budget is the only thing standing between one device's download
    and the memory of every foreground read, so the second download must be
    turned away before the route runs. Its one-use token is therefore still
    unclaimed when the advertised `Retry-After` elapses; a refusal that consumed
    the token would make a momentarily busy server look like a replay attack.
    """
    article = _commit_ready_article(engine, title="Two devices download at once")
    _prepare(engine, article)
    verifier = StaticTokenVerifier(article.viewer_id, article.email)
    app = _package_app(verifier)
    # Explicit fixture input, not a production-qualified capacity profile: one
    # permit makes the second transfer's refusal deterministic.
    app.state.package_transfer_admission = ReadAdmission(
        max_concurrency=1, deadline_seconds=60, retry_after_seconds=3, request_bytes=262144
    )
    holding_token, _ = _mint(article)
    refused_token, refused_jti = _mint(article)
    path = f"/offline-reading/packages/{article.media_id}"

    async def scenario() -> None:
        started, release = asyncio.Event(), asyncio.Event()
        first_request = True

        async def wire(scope: Scope, receive: Receive, send: Send) -> None:
            nonlocal first_request
            holds_the_permit, first_request = first_request, False

            async def gated(message: Message) -> None:
                if holds_the_permit and message["type"] == "http.response.body":
                    started.set()
                    await release.wait()
                await send(message)

            await app(scope, receive, gated)

        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=wire), base_url="http://test"
        ) as client:
            holding = asyncio.create_task(
                client.get(path, headers={"Authorization": f"Bearer {holding_token}"})
            )
            try:
                await asyncio.wait_for(started.wait(), timeout=10)
                busy = await client.get(path, headers={"Authorization": f"Bearer {refused_token}"})
            finally:
                release.set()
                transferred = await holding
        assert busy.status_code == 503, busy.text[:200]
        assert busy.json()["error"]["code"] == "E_READ_CAPACITY"
        assert busy.headers["retry-after"] == "3"
        assert "content-digest" not in busy.headers, "a refused transfer described package bytes"
        assert transferred.status_code == 200, transferred.text[:200]
        assert (
            verify_offline_reading_zip(
                transferred.content, publication_limits=require_reader_publication_limits()
            ).manifest.media_id
            == article.media_id
        )

    asyncio.run(scenario())
    assert _claimed_jtis(engine, (refused_jti,)) == set(), (
        "a capacity refusal consumed the caller's one-use package token"
    )
