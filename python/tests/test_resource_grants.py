"""Concurrency, lifecycle, and trusted-storage contracts for resource grants."""

from __future__ import annotations

import threading
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

import pytest
from sqlalchemy import event, select, text
from sqlalchemy.orm import Session

from nexus.db.models import ResourceGrant
from nexus.errors import ApiError, ApiErrorCode
from nexus.services import (
    highlights,
    media_deletion,
    public_resource_sharing,
    resource_grants,
)
from nexus.services.bootstrap import ensure_user_and_default_library
from nexus.services.resource_graph.refs import ResourceRef
from nexus.services.sealed_handles import new_share_token, share_token_hash
from tests.factories import (
    add_media_to_library,
    create_test_fragment,
    create_test_highlight,
    create_test_media,
)
from tests.helpers import auth_headers, create_test_user_id
from tests.utils.db import DirectSessionManager

pytestmark = pytest.mark.integration


def _enable_sharing(direct_db: DirectSessionManager, user_id: UUID) -> None:
    direct_db.register_cleanup("billing_entitlement_overrides", "user_id", user_id)
    with direct_db.session() as db:
        db.execute(
            text("""
                INSERT INTO billing_entitlement_overrides
                    (id, user_id, plan_tier, reason)
                VALUES (:id, :user_id, 'plus', 'resource grant contract test')
            """),
            {"id": uuid4(), "user_id": user_id},
        )
        db.commit()


def _bootstrap_user(auth_client, user_id: UUID) -> UUID:
    response = auth_client.get("/me", headers=auth_headers(user_id))
    assert response.status_code == 200, response.text
    return UUID(response.json()["data"]["default_library_id"])


def _seed_media(
    auth_client,
    direct_db: DirectSessionManager,
    *,
    owner_id: UUID,
) -> tuple[UUID, UUID]:
    default_library_id = _bootstrap_user(auth_client, owner_id)
    _enable_sharing(direct_db, owner_id)
    with direct_db.session() as db:
        media_id = create_test_media(db)
        fragment_id = create_test_fragment(db, media_id, "Public grant fixture")
        add_media_to_library(db, default_library_id, media_id)
        db.commit()
    direct_db.register_cleanup("media", "id", media_id)
    direct_db.register_cleanup("resource_grants", "subject_id", media_id)
    return media_id, fragment_id


def _run_concurrently(targets: list[Callable[[], object]]) -> list[object]:
    barrier = threading.Barrier(len(targets))
    results: list[object] = [None] * len(targets)
    errors: list[BaseException] = []
    result_lock = threading.Lock()

    def run(index: int, target: Callable[[], object]) -> None:
        try:
            barrier.wait(timeout=10)
            result = target()
            with result_lock:
                results[index] = result
        except BaseException as exc:  # pragma: no cover - surfaced below
            with result_lock:
                errors.append(exc)

    threads = [
        threading.Thread(target=run, args=(index, target), daemon=True)
        for index, target in enumerate(targets)
    ]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=30)
    for thread in threads:
        if thread.is_alive():
            errors.append(AssertionError(f"worker thread did not finish: {thread.name}"))
    assert errors == [], errors
    return results


@pytest.mark.parametrize("audience_kind", ["user", "link"])
def test_concurrent_duplicate_create_converges_to_one_grant(
    auth_client,
    direct_db: DirectSessionManager,
    monkeypatch,
    audience_kind: str,
) -> None:
    owner_id = create_test_user_id()
    recipient_id = create_test_user_id()
    media_id, _ = _seed_media(auth_client, direct_db, owner_id=owner_id)
    _bootstrap_user(auth_client, recipient_id)
    subject = ResourceRef(scheme="media", id=media_id)
    if audience_kind == "link":
        monkeypatch.setattr(
            public_resource_sharing,
            "link_projection_availability",
            lambda _db, **_kwargs: public_resource_sharing.Available(),
        )

    def create() -> bool:
        audience: resource_grants.GrantAudience
        if audience_kind == "user":
            audience = resource_grants.UserGrantAudience(user_id=recipient_id)
        else:
            audience = resource_grants.LinkGrantAudience()
        with direct_db.session() as db:
            return resource_grants.create_grant(
                db,
                viewer_user_id=owner_id,
                subject=subject,
                audience=audience,
            ).created

    assert sorted(_run_concurrently([create, create])) == [False, True]
    with direct_db.session() as db:
        assert (
            db.scalar(
                text("""
                SELECT count(*)
                FROM resource_grants
                WHERE created_by_user_id = :owner_id
                  AND subject_scheme = 'media'
                  AND subject_id = :media_id
            """),
                {"owner_id": owner_id, "media_id": media_id},
            )
            == 1
        )


def test_teardown_wins_before_create_and_leaves_no_orphan_grant(
    auth_client,
    direct_db: DirectSessionManager,
) -> None:
    owner_id = create_test_user_id()
    recipient_id = create_test_user_id()
    media_id, _ = _seed_media(auth_client, direct_db, owner_id=owner_id)
    _bootstrap_user(auth_client, recipient_id)
    attempted_media_lock = threading.Event()
    outcome: list[object] = []

    teardown_db = direct_db.session()
    teardown_db.execute(
        text("SELECT 1 FROM media WHERE id = :media_id FOR UPDATE"),
        {"media_id": media_id},
    ).one()
    teardown_db.execute(
        text("DELETE FROM library_entries WHERE media_id = :media_id"),
        {"media_id": media_id},
    )
    assert media_deletion.claim_document_teardown_if_unreferenced_locked(teardown_db, media_id)

    def create_after_claim() -> None:
        with direct_db.session() as db:
            connection = db.connection()

            def observe_media_lock(
                _connection,
                _cursor,
                statement: str,
                _parameters,
                _context,
                _executemany,
            ) -> None:
                normalized = " ".join(statement.lower().split())
                if "from media" in normalized and "for update" in normalized:
                    attempted_media_lock.set()

            event.listen(connection, "before_cursor_execute", observe_media_lock)
            try:
                outcome.append(
                    resource_grants.create_grant(
                        db,
                        viewer_user_id=owner_id,
                        subject=ResourceRef(scheme="media", id=media_id),
                        audience=resource_grants.UserGrantAudience(user_id=recipient_id),
                    )
                )
            except ApiError as exc:
                outcome.append(exc.code)

    worker = threading.Thread(target=create_after_claim, daemon=True)
    worker.start()
    assert attempted_media_lock.wait(timeout=10)
    teardown_db.commit()
    teardown_db.close()
    worker.join(timeout=20)
    assert not worker.is_alive()
    assert outcome == [ApiErrorCode.E_MEDIA_DELETING]
    with direct_db.session() as db:
        assert (
            db.scalar(
                text("SELECT count(*) FROM resource_grants WHERE subject_id = :media_id"),
                {"media_id": media_id},
            )
            == 0
        )
        intent_id = db.scalar(
            text("SELECT id FROM media_teardown_intents WHERE media_id = :media_id"),
            {"media_id": media_id},
        )
        job_ids = list(
            db.scalars(
                text(
                    "SELECT id FROM background_jobs "
                    "WHERE kind = 'media_teardown' AND payload->>'mediaId' = :media_id"
                ),
                {"media_id": str(media_id)},
            )
        )
    direct_db.register_cleanup("media_teardown_intents", "id", intent_id)
    for job_id in job_ids:
        direct_db.register_cleanup("background_jobs", "id", job_id)


@pytest.mark.parametrize("delete_actor", ["creator", "recipient"])
def test_concurrent_revoke_or_decline_and_final_library_removal_claims_teardown_once(
    auth_client,
    direct_db: DirectSessionManager,
    delete_actor: str,
) -> None:
    owner_id = create_test_user_id()
    recipient_id = create_test_user_id()
    media_id, _ = _seed_media(auth_client, direct_db, owner_id=owner_id)
    _bootstrap_user(auth_client, recipient_id)
    with direct_db.session() as db:
        grant = resource_grants.create_grant(
            db,
            viewer_user_id=owner_id,
            subject=ResourceRef(scheme="media", id=media_id),
            audience=resource_grants.UserGrantAudience(user_id=recipient_id),
        ).grant

    def revoke() -> str:
        with direct_db.session() as db:
            resource_grants.delete_grant(
                db,
                viewer_user_id=(owner_id if delete_actor == "creator" else recipient_id),
                handle=grant.handle,
            )
        return "grant-removed"

    def remove_library_reference() -> str:
        with direct_db.session() as db:
            db.execute(
                text("SELECT 1 FROM media WHERE id = :media_id FOR UPDATE"),
                {"media_id": media_id},
            ).one()
            db.execute(
                text("DELETE FROM library_entries WHERE media_id = :media_id"),
                {"media_id": media_id},
            )
            media_deletion.claim_document_teardown_if_unreferenced_locked(db, media_id)
            db.commit()
        return "library-removed"

    assert sorted(_run_concurrently([revoke, remove_library_reference])) == [
        "grant-removed",
        "library-removed",
    ]
    with direct_db.session() as db:
        assert (
            db.scalar(
                text("SELECT count(*) FROM resource_grants WHERE subject_id = :media_id"),
                {"media_id": media_id},
            )
            == 0
        )
        intent_ids = list(
            db.scalars(
                text("SELECT id FROM media_teardown_intents WHERE media_id = :media_id"),
                {"media_id": media_id},
            )
        )
        job_ids = list(
            db.scalars(
                text(
                    "SELECT id FROM background_jobs "
                    "WHERE kind = 'media_teardown' AND payload->>'mediaId' = :media_id"
                ),
                {"media_id": str(media_id)},
            )
        )
    assert len(intent_ids) == 1
    direct_db.register_cleanup("media_teardown_intents", "id", intent_ids[0])
    for job_id in job_ids:
        direct_db.register_cleanup("background_jobs", "id", job_id)


def test_highlight_delete_wins_before_grant_create(
    auth_client,
    direct_db: DirectSessionManager,
) -> None:
    owner_id = create_test_user_id()
    recipient_id = create_test_user_id()
    media_id, fragment_id = _seed_media(auth_client, direct_db, owner_id=owner_id)
    _bootstrap_user(auth_client, recipient_id)
    with direct_db.session() as db:
        highlight_id = create_test_highlight(db, owner_id, fragment_id, "Public")
    direct_db.register_cleanup("resource_grants", "subject_id", highlight_id)
    attempted_media_lock = threading.Event()
    outcome: list[object] = []

    deleting_db = direct_db.session()
    deleting_db.execute(
        text("SELECT 1 FROM media WHERE id = :media_id FOR UPDATE"),
        {"media_id": media_id},
    ).one()

    def create_after_delete() -> None:
        with direct_db.session() as db:
            connection = db.connection()

            def observe_media_lock(
                _connection,
                _cursor,
                statement: str,
                _parameters,
                _context,
                _executemany,
            ) -> None:
                normalized = " ".join(statement.lower().split())
                if "from media" in normalized and "for update" in normalized:
                    attempted_media_lock.set()

            event.listen(connection, "before_cursor_execute", observe_media_lock)
            try:
                outcome.append(
                    resource_grants.create_grant(
                        db,
                        viewer_user_id=owner_id,
                        subject=ResourceRef(scheme="highlight", id=highlight_id),
                        audience=resource_grants.UserGrantAudience(user_id=recipient_id),
                    )
                )
            except ApiError as exc:
                outcome.append(exc.code)

    worker = threading.Thread(target=create_after_delete, daemon=True)
    worker.start()
    assert attempted_media_lock.wait(timeout=10)
    highlights.delete_highlight(deleting_db, owner_id, highlight_id)
    deleting_db.close()
    worker.join(timeout=20)
    assert not worker.is_alive()
    assert outcome == [ApiErrorCode.E_NOT_FOUND]
    with direct_db.session() as db:
        assert (
            db.scalar(
                text("SELECT count(*) FROM resource_grants WHERE subject_id = :highlight_id"),
                {"highlight_id": highlight_id},
            )
            == 0
        )


def test_repoint_coalesces_duplicate_audiences_by_oldest_grant_and_keeps_highlight_exact(
    db_session: Session,
    monkeypatch,
) -> None:
    owner_id = uuid4()
    recipient_id = uuid4()
    ensure_user_and_default_library(db_session, owner_id)
    ensure_user_and_default_library(db_session, recipient_id)
    loser_id = create_test_media(db_session, title="Duplicate loser")
    winner_id = create_test_media(db_session, title="Duplicate winner")
    fragment_id = create_test_fragment(db_session, loser_id, "Exact highlight")
    highlight_id = create_test_highlight(db_session, owner_id, fragment_id, "Exact")
    older_id = uuid4()
    newer_id = uuid4()
    highlight_grant_id = uuid4()
    now = datetime.now(UTC)
    db_session.add_all(
        [
            ResourceGrant(
                id=older_id,
                subject_scheme="media",
                subject_id=loser_id,
                created_by_user_id=owner_id,
                grantee_user_id=recipient_id,
                created_at=now - timedelta(seconds=1),
            ),
            ResourceGrant(
                id=newer_id,
                subject_scheme="media",
                subject_id=winner_id,
                created_by_user_id=owner_id,
                grantee_user_id=recipient_id,
                created_at=now,
            ),
            ResourceGrant(
                id=highlight_grant_id,
                subject_scheme="highlight",
                subject_id=highlight_id,
                created_by_user_id=owner_id,
                grantee_user_id=recipient_id,
                created_at=now,
            ),
        ]
    )
    db_session.flush()
    invalidated: list[set[UUID]] = []
    monkeypatch.setattr(
        resource_grants,
        "_notify_user_visibility_changed",
        lambda _db, user_ids: invalidated.append(set(user_ids)),
    )

    assert (
        resource_grants.repoint_media_subjects(
            db_session,
            loser_media_id=loser_id,
            winner_media_id=winner_id,
        )
        == 2
    )

    direct_rows = list(
        db_session.scalars(
            select(ResourceGrant).where(
                ResourceGrant.subject_scheme == "media",
                ResourceGrant.subject_id.in_([loser_id, winner_id]),
            )
        )
    )
    assert [(row.id, row.subject_id) for row in direct_rows] == [(older_id, winner_id)]
    assert db_session.get(ResourceGrant, highlight_grant_id).subject_id == highlight_id
    assert resource_grants.count_for_media(db_session, loser_id) == 1
    assert resource_grants.count_for_media(db_session, winner_id) == 1
    assert invalidated == [{owner_id, recipient_id}]


def test_duplicate_teardown_cleans_exact_loser_highlight_grants(
    auth_client,
    direct_db: DirectSessionManager,
    monkeypatch,
) -> None:
    owner_id = create_test_user_id()
    recipient_id = create_test_user_id()
    default_library_id = _bootstrap_user(auth_client, owner_id)
    _bootstrap_user(auth_client, recipient_id)
    with direct_db.session() as db:
        loser_id = create_test_media(db, title="Duplicate loser with shared highlight")
        winner_id = create_test_media(db, title="Canonical winner")
        fragment_id = create_test_fragment(db, loser_id, "Exact shared highlight")
        highlight_id = create_test_highlight(db, owner_id, fragment_id, "Exact")
        add_media_to_library(db, default_library_id, loser_id)
        direct_grant_id = uuid4()
        highlight_grant_id = uuid4()
        db.add_all(
            [
                ResourceGrant(
                    id=direct_grant_id,
                    subject_scheme="media",
                    subject_id=loser_id,
                    created_by_user_id=owner_id,
                    grantee_user_id=recipient_id,
                ),
                ResourceGrant(
                    id=highlight_grant_id,
                    subject_scheme="highlight",
                    subject_id=highlight_id,
                    created_by_user_id=owner_id,
                    grantee_user_id=recipient_id,
                ),
            ]
        )
        db.commit()

    invalidated: list[set[UUID]] = []
    monkeypatch.setattr(
        resource_grants,
        "_notify_user_visibility_changed",
        lambda _db, user_ids: invalidated.append(set(user_ids)),
    )

    lifecycle_events: list[str] = []
    repoint_media_subjects = resource_grants.repoint_media_subjects

    def observe_repoint(*args, **kwargs):
        lifecycle_events.append("repoint")
        return repoint_media_subjects(*args, **kwargs)

    monkeypatch.setattr(resource_grants, "repoint_media_subjects", observe_repoint)

    with direct_db.session() as db:

        def observe_media_lock(
            _connection,
            _cursor,
            statement: str,
            _parameters,
            _context,
            _executemany,
        ) -> None:
            normalized = " ".join(statement.lower().split())
            if "select id from media where id = any" in normalized and "for update" in normalized:
                lifecycle_events.append("media-lock")

        event.listen(db.connection(), "before_cursor_execute", observe_media_lock)
        assert (
            media_deletion.delete_duplicate_document_media(
                db,
                loser_media_id=loser_id,
                winner_media_id=winner_id,
            )
            == []
        )
        db.commit()

    assert lifecycle_events[:2] == ["media-lock", "repoint"]
    with direct_db.session() as db:
        assert db.get(ResourceGrant, direct_grant_id).subject_id == winner_id
        assert db.get(ResourceGrant, highlight_grant_id) is None
        assert resource_grants.count_for_media(db, loser_id) == 0
        intent_id = db.scalar(
            text("SELECT id FROM media_teardown_intents WHERE media_id = :media_id"),
            {"media_id": loser_id},
        )
        job_ids = list(
            db.scalars(
                text(
                    "SELECT id FROM background_jobs "
                    "WHERE kind = 'media_teardown' AND payload->>'mediaId' = :media_id"
                ),
                {"media_id": str(loser_id)},
            )
        )
    assert intent_id is not None
    assert invalidated == [
        {owner_id, recipient_id},
        {owner_id, recipient_id},
    ]
    direct_db.register_cleanup("resource_grants", "id", direct_grant_id)
    direct_db.register_cleanup("media_teardown_intents", "id", intent_id)
    for job_id in job_ids:
        direct_db.register_cleanup("background_jobs", "id", job_id)


def test_malformed_trusted_audience_branch_defects(db_session: Session) -> None:
    owner_id = uuid4()
    recipient_id = uuid4()
    ensure_user_and_default_library(db_session, owner_id)
    ensure_user_and_default_library(db_session, recipient_id)
    media_id = create_test_media(db_session)
    token = new_share_token()
    db_session.add(
        ResourceGrant(
            id=uuid4(),
            subject_scheme="media",
            subject_id=media_id,
            created_by_user_id=owner_id,
            grantee_user_id=recipient_id,
            share_token=str(token),
            share_token_hash=share_token_hash(token),
        )
    )
    db_session.flush()

    with pytest.raises(AssertionError, match="impossible audience branch"):
        resource_grants.list_creator_grants(
            db_session,
            creator_id=owner_id,
            subject=ResourceRef(scheme="media", id=media_id),
        )


def test_both_user_foreign_keys_are_non_cascading_restrictive(db_session: Session) -> None:
    rows = db_session.execute(
        text("""
            SELECT conname, confdeltype
            FROM pg_constraint
            WHERE conrelid = 'resource_grants'::regclass
              AND conname IN (
                'fk_resource_grants_created_by_user_id_users',
                'fk_resource_grants_grantee_user_id_users'
              )
            ORDER BY conname
        """)
    ).all()

    assert rows == [
        ("fk_resource_grants_created_by_user_id_users", "a"),
        ("fk_resource_grants_grantee_user_id_users", "a"),
    ]
