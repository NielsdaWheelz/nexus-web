from __future__ import annotations

from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

import pytest
from sqlalchemy import text

from tests.factories import (
    add_media_to_library,
    create_normalized_fragment_highlight,
    create_test_fragment,
    create_test_library,
    create_test_media,
)
from tests.helpers import auth_headers, create_test_user_id
from tests.utils.db import DirectSessionManager

pytestmark = pytest.mark.integration


def _seed_podcast_subscription(
    session,
    *,
    viewer_id: UUID,
    title: str,
    status: str,
) -> UUID:
    podcast_id = uuid4()
    session.execute(
        text("""
            INSERT INTO podcasts (
                id, provider, provider_podcast_id, title, feed_url
            ) VALUES (
                :podcast_id, 'podcast_index', :provider_podcast_id,
                :title, :feed_url
            )
        """),
        {
            "podcast_id": podcast_id,
            "provider_podcast_id": f"resonance-{podcast_id}",
            "title": title,
            "feed_url": f"https://example.com/{podcast_id}.xml",
        },
    )
    session.execute(
        text("""
            INSERT INTO podcast_subscriptions (user_id, podcast_id, status)
            VALUES (:viewer_id, :podcast_id, :status)
        """),
        {
            "viewer_id": viewer_id,
            "podcast_id": podcast_id,
            "status": status,
        },
    )
    return podcast_id


def test_lectern_slate_envelope_is_exact_and_rejects_every_query_parameter(auth_client) -> None:
    user_id = create_test_user_id()
    auth_client.get("/me", headers=auth_headers(user_id))

    response = auth_client.get("/lectern/slate", headers=auth_headers(user_id))
    assert response.status_code == 200, response.text
    assert set(response.json()) == {"data"}
    assert set(response.json()["data"]) == {"items"}
    assert len(response.json()["data"]["items"]) <= 10

    rejected = auth_client.get(
        "/lectern/slate",
        headers=auth_headers(user_id),
        params={"limit": 10},
    )
    assert rejected.status_code == 400, rejected.text
    assert rejected.json()["error"]["code"] == "E_INVALID_REQUEST"

    removed = auth_client.get("/lectern/recent", headers=auth_headers(user_id))
    assert removed.status_code == 404


def test_lectern_slate_surfaces_recent_visible_media_and_excludes_finished(
    auth_client, direct_db: DirectSessionManager
) -> None:
    user_id = create_test_user_id()
    me = auth_client.get("/me", headers=auth_headers(user_id)).json()["data"]
    with direct_db.session() as session:
        eligible_id = create_test_media(session, title="Recent eligible work")
        finished_id = create_test_media(session, title="Finished work")
        teardown_id = create_test_media(session, title="Teardown-pending work")
        add_media_to_library(session, UUID(me["default_library_id"]), eligible_id)
        add_media_to_library(session, UUID(me["default_library_id"]), finished_id)
        add_media_to_library(session, UUID(me["default_library_id"]), teardown_id)
        session.execute(
            text("""
                INSERT INTO consumption_overrides (user_id, media_id, status)
                VALUES (:user_id, :media_id, 'finished')
            """),
            {"user_id": user_id, "media_id": finished_id},
        )
        session.execute(
            text("""
                INSERT INTO media_teardown_intents (id, media_id)
                VALUES (:intent_id, :media_id)
            """),
            {"intent_id": uuid4(), "media_id": teardown_id},
        )
        session.commit()
    for media_id in (eligible_id, finished_id, teardown_id):
        direct_db.register_cleanup("media", "id", media_id)
        direct_db.register_cleanup("library_entries", "media_id", media_id)
    direct_db.register_cleanup("consumption_overrides", "media_id", finished_id)
    direct_db.register_cleanup("media_teardown_intents", "media_id", teardown_id)

    response = auth_client.get("/lectern/slate", headers=auth_headers(user_id))
    assert response.status_code == 200, response.text
    items = response.json()["data"]["items"]
    refs = [item["target"]["ref"] for item in items]
    assert f"media:{eligible_id}" in refs
    assert f"media:{finished_id}" not in refs
    assert f"media:{teardown_id}" not in refs
    selected = next(item for item in items if item["target"]["ref"] == f"media:{eligible_id}")
    assert set(selected) == {"target", "reason"}
    assert selected["target"]["kind"] == "Media"
    assert selected["reason"]["kind"] == "AddedToNexus"
    assert len(items) <= 10
    assert len(refs) == len(set(refs))


def test_lectern_slate_counts_hidden_rows_toward_the_real_capacity(
    auth_client,
    direct_db: DirectSessionManager,
) -> None:
    user_id = create_test_user_id()
    auth_client.get("/me", headers=auth_headers(user_id))
    capacity_title = f"Hidden capacity row {uuid4()}"
    with direct_db.session() as session:
        session.execute(
            text("""
                WITH inserted_media AS (
                    INSERT INTO media (
                        kind, title, processing_status, created_by_user_id
                    )
                    SELECT
                        'web_article', :title, 'ready_for_reading', :viewer_id
                    FROM generate_series(1, 2000)
                    RETURNING id
                ),
                numbered AS (
                    SELECT
                        id,
                        row_number() OVER (ORDER BY id ASC) - 1 AS position
                    FROM inserted_media
                )
                INSERT INTO consumption_queue_items (
                    user_id, media_id, position, source
                )
                SELECT :viewer_id, id, position, 'manual'
                FROM numbered
            """),
            {"viewer_id": user_id, "title": capacity_title},
        )
        session.commit()
    direct_db.register_cleanup("media", "title", capacity_title)
    direct_db.register_cleanup("consumption_queue_items", "user_id", user_id)

    response = auth_client.get("/lectern/slate", headers=auth_headers(user_id))
    assert response.status_code == 200, response.text
    assert response.json() == {"data": {"items": []}}


def test_day_precision_publication_is_not_crowded_out_before_arrival_cap(
    auth_client, direct_db: DirectSessionManager
) -> None:
    user_id = create_test_user_id()
    me = auth_client.get("/me", headers=auth_headers(user_id)).json()["data"]
    default_library_id = UUID(me["default_library_id"])
    with direct_db.session() as session:
        ordinary_ids = [
            create_test_media(session, title=f"Recent added {index}") for index in range(20)
        ]
        published_id = create_test_media(session, title="Published today, added long ago")
        partial_id = create_test_media(session, title="Month precision is not an instant")
        invalid_id = create_test_media(session, title="Invalid calendar date is not an instant")
        for media_id in [*ordinary_ids, published_id, partial_id, invalid_id]:
            add_media_to_library(session, default_library_id, media_id)
        session.execute(
            text("""
                UPDATE media
                SET created_at = :old_created_at,
                    published_date = :published_on
                WHERE id = :media_id
            """),
            {
                "media_id": published_id,
                "old_created_at": datetime.now(UTC) - timedelta(days=100),
                "published_on": datetime.now(UTC).date().isoformat(),
            },
        )
        session.execute(
            text("""
                UPDATE media
                SET created_at = :old_created_at,
                    published_date = :published_month
                WHERE id = :media_id
            """),
            {
                "media_id": partial_id,
                "old_created_at": datetime.now(UTC) - timedelta(days=100),
                "published_month": datetime.now(UTC).strftime("%Y-%m"),
            },
        )
        session.execute(
            text("""
                UPDATE media
                SET created_at = :old_created_at,
                    published_date = '2026-02-31'
                WHERE id = :media_id
            """),
            {
                "media_id": invalid_id,
                "old_created_at": datetime.now(UTC) - timedelta(days=100),
            },
        )
        session.commit()
    for media_id in [*ordinary_ids, published_id, partial_id, invalid_id]:
        direct_db.register_cleanup("media", "id", media_id)
        direct_db.register_cleanup("library_entries", "media_id", media_id)

    response = auth_client.get("/lectern/slate", headers=auth_headers(user_id))
    assert response.status_code == 200, response.text
    published = next(
        item
        for item in response.json()["data"]["items"]
        if item["target"]["ref"] == f"media:{published_id}"
    )
    assert published["reason"]["kind"] == "Published"
    assert all(
        item["target"]["ref"] not in {f"media:{partial_id}", f"media:{invalid_id}"}
        for item in response.json()["data"]["items"]
    )


def test_lectern_slate_preserves_rediscovery_before_relational_family_caps(
    auth_client, direct_db: DirectSessionManager
) -> None:
    user_id = create_test_user_id()
    me = auth_client.get("/me", headers=auth_headers(user_id)).json()["data"]
    default_library_id = UUID(me["default_library_id"])
    with direct_db.session() as session:
        anchor_id = create_test_media(session, title="Rediscovery crowding anchor")
        recent_ids = [
            create_test_media(session, title=f"Recent connected target {index}")
            for index in range(21)
        ]
        old_id = create_test_media(session, title="Old connected target")
        for media_id in [anchor_id, *recent_ids, old_id]:
            add_media_to_library(session, default_library_id, media_id)

        now = datetime.now(UTC)
        session.execute(
            text("""
                UPDATE media
                SET created_at = :created_at
                WHERE id = :media_id
            """),
            {"media_id": old_id, "created_at": now - timedelta(days=120)},
        )
        session.execute(
            text("""
                INSERT INTO reader_engagement_states (
                    id, user_id, media_id, last_engaged_at, max_total_progression
                ) VALUES (
                    :id, :user_id, :media_id, :last_engaged_at, 0.4
                )
            """),
            {
                "id": uuid4(),
                "user_id": user_id,
                "media_id": anchor_id,
                "last_engaged_at": now,
            },
        )
        session.execute(
            text("""
                INSERT INTO resource_edges (
                    user_id, kind, origin, source_scheme, source_id,
                    target_scheme, target_id, created_at
                ) VALUES (
                    :user_id, 'context', 'user', 'media', :anchor_id,
                    'media', :target_id, :created_at
                )
            """),
            [
                {
                    "user_id": user_id,
                    "anchor_id": anchor_id,
                    "target_id": media_id,
                    "created_at": now,
                }
                for media_id in recent_ids
            ]
            + [
                {
                    "user_id": user_id,
                    "anchor_id": anchor_id,
                    "target_id": old_id,
                    "created_at": now - timedelta(days=1),
                }
            ],
        )
        session.commit()

    for media_id in [anchor_id, *recent_ids, old_id]:
        direct_db.register_cleanup("media", "id", media_id)
        direct_db.register_cleanup("library_entries", "media_id", media_id)
    direct_db.register_cleanup("reader_engagement_states", "media_id", anchor_id)
    direct_db.register_cleanup("resource_edges", "source_id", anchor_id)

    response = auth_client.get("/lectern/slate", headers=auth_headers(user_id))
    assert response.status_code == 200, response.text
    rediscovered = next(
        item
        for item in response.json()["data"]["items"]
        if item["target"]["ref"] == f"media:{old_id}"
    )
    assert rediscovered["reason"] == {
        "kind": "Connected",
        "anchor": {
            "ref": f"media:{anchor_id}",
            "label": "Rediscovery crowding anchor",
        },
        "edgeOrigin": "user",
    }


def test_library_slate_default_is_media_only_and_read_only_destination_is_empty(
    auth_client, direct_db: DirectSessionManager
) -> None:
    owner_id = create_test_user_id()
    viewer_id = create_test_user_id()
    owner_me = auth_client.get("/me", headers=auth_headers(owner_id)).json()["data"]
    viewer_me = auth_client.get("/me", headers=auth_headers(viewer_id)).json()["data"]

    with direct_db.session() as session:
        default_candidate_id = create_test_media(
            session,
            title="Default Slate system-only candidate",
        )
        system_library_id = session.execute(
            text("""
                INSERT INTO libraries (
                    name, owner_user_id, is_default, system_key
                ) VALUES (
                    'Default Slate corpus', :viewer_id, false, :system_key
                )
                RETURNING id
            """),
            {
                "viewer_id": viewer_id,
                "system_key": f"default-slate-{uuid4()}",
            },
        ).scalar_one()
        session.execute(
            text("""
                INSERT INTO memberships (library_id, user_id, role)
                VALUES (:library_id, :viewer_id, 'admin')
            """),
            {"library_id": system_library_id, "viewer_id": viewer_id},
        )
        default_anchor_id = create_test_media(session, title="Default Slate anchor")
        add_media_to_library(
            session,
            UUID(viewer_me["default_library_id"]),
            default_anchor_id,
        )
        session.execute(
            text("""
                INSERT INTO library_entries (library_id, media_id, position)
                VALUES (:library_id, :media_id, 0)
            """),
            {
                "library_id": system_library_id,
                "media_id": default_candidate_id,
            },
        )
        session.execute(
            text("""
                INSERT INTO resource_edges (
                    user_id, kind, origin,
                    source_scheme, source_id, target_scheme, target_id, snapshot
                ) VALUES (
                    :viewer_id, 'context', 'synapse',
                    'media', :anchor_id, 'media', :candidate_id,
                    '{"excerpt":"Default Slate affinity."}'::jsonb
                )
            """),
            {
                "viewer_id": viewer_id,
                "anchor_id": default_anchor_id,
                "candidate_id": default_candidate_id,
            },
        )
        default_podcast_id = _seed_podcast_subscription(
            session,
            viewer_id=viewer_id,
            title="Default Slate podcast exclusion",
            status="active",
        )
        session.execute(
            text("""
                INSERT INTO resource_edges (
                    user_id, kind, origin,
                    source_scheme, source_id, target_scheme, target_id
                ) VALUES (
                    :viewer_id, 'context', 'user',
                    'media', :anchor_id, 'podcast', :podcast_id
                )
            """),
            {
                "viewer_id": viewer_id,
                "anchor_id": default_anchor_id,
                "podcast_id": default_podcast_id,
            },
        )
        session.commit()
    direct_db.register_cleanup("libraries", "id", system_library_id)
    direct_db.register_cleanup("memberships", "library_id", system_library_id)
    direct_db.register_cleanup("media", "id", default_candidate_id)
    direct_db.register_cleanup("media", "id", default_anchor_id)
    direct_db.register_cleanup("podcasts", "id", default_podcast_id)
    direct_db.register_cleanup("library_entries", "library_id", system_library_id)
    direct_db.register_cleanup("library_entries", "media_id", default_anchor_id)
    direct_db.register_cleanup("resource_edges", "source_id", default_anchor_id)

    default_response = auth_client.get(
        f"/libraries/{viewer_me['default_library_id']}/slate",
        headers=auth_headers(viewer_id),
    )
    assert default_response.status_code == 200, default_response.text
    default_items = default_response.json()["data"]["items"]
    assert [item["target"]["ref"] for item in default_items] == [f"media:{default_candidate_id}"]
    assert default_items[0]["target"]["kind"] == "Media"
    assert all(item["target"]["ref"] != f"podcast:{default_podcast_id}" for item in default_items)

    system_response = auth_client.get(
        f"/libraries/{system_library_id}/slate",
        headers=auth_headers(viewer_id),
    )
    assert system_response.status_code == 200, system_response.text
    assert system_response.json() == {"data": {"items": []}}

    system_response = auth_client.get(
        f"/libraries/{system_library_id}/slate",
        headers=auth_headers(viewer_id),
    )
    assert system_response.status_code == 200, system_response.text
    assert system_response.json() == {"data": {"items": []}}

    with direct_db.session() as session:
        shared_id = create_test_library(session, owner_id, "Read-only Slate")
        session.execute(
            text("""
                INSERT INTO memberships (library_id, user_id, role)
                VALUES (:library_id, :viewer_id, 'member')
            """),
            {"library_id": shared_id, "viewer_id": viewer_id},
        )
        session.commit()
    direct_db.register_cleanup("memberships", "library_id", shared_id)
    direct_db.register_cleanup("libraries", "id", shared_id)

    response = auth_client.get(f"/libraries/{shared_id}/slate", headers=auth_headers(viewer_id))
    assert response.status_code == 200, response.text
    assert response.json() == {"data": {"items": []}}

    rejected = auth_client.get(
        f"/libraries/{shared_id}/slate",
        headers=auth_headers(viewer_id),
        params={"cursor": "forbidden"},
    )
    assert rejected.status_code == 400, rejected.text
    assert rejected.json()["error"]["code"] == "E_INVALID_REQUEST"

    assert owner_me["default_library_id"]


def test_library_slate_excludes_complete_membership_beyond_the_loaded_page(
    auth_client, direct_db: DirectSessionManager
) -> None:
    user_id = create_test_user_id()
    me = auth_client.get("/me", headers=auth_headers(user_id)).json()["data"]
    with direct_db.session() as session:
        library_id = create_test_library(session, user_id, "Complete Slate membership")
        anchor_id = create_test_media(session, title="Loaded first anchor")
        already_member_id = create_test_media(session, title="Member beyond loaded page")
        outside_id = create_test_media(session, title="Outside complete membership")
        unrelated_recent_id = create_test_media(session, title="Recent but unrelated")
        add_media_to_library(session, library_id, anchor_id)
        add_media_to_library(session, library_id, already_member_id)
        add_media_to_library(session, UUID(me["default_library_id"]), outside_id)
        add_media_to_library(session, UUID(me["default_library_id"]), unrelated_recent_id)
        session.execute(
            text("""
                INSERT INTO resource_edges (
                    user_id, kind, origin,
                    source_scheme, source_id, target_scheme, target_id
                ) VALUES
                    (:user_id, 'context', 'user',
                     'media', :anchor_id, 'media', :already_member_id),
                    (:user_id, 'context', 'user',
                     'media', :anchor_id, 'media', :outside_id)
            """),
            {
                "user_id": user_id,
                "anchor_id": anchor_id,
                "already_member_id": already_member_id,
                "outside_id": outside_id,
            },
        )
        session.commit()
    direct_db.register_cleanup("libraries", "id", library_id)
    direct_db.register_cleanup("memberships", "library_id", library_id)
    for media_id in (anchor_id, already_member_id, outside_id, unrelated_recent_id):
        direct_db.register_cleanup("media", "id", media_id)
        direct_db.register_cleanup("library_entries", "media_id", media_id)
    direct_db.register_cleanup("resource_edges", "source_id", anchor_id)

    first_page = auth_client.get(
        f"/libraries/{library_id}/entries",
        headers=auth_headers(user_id),
        params={"limit": 1},
    )
    assert first_page.status_code == 200, first_page.text
    assert first_page.json()["page"]["has_more"] is True

    response = auth_client.get(f"/libraries/{library_id}/slate", headers=auth_headers(user_id))
    assert response.status_code == 200, response.text
    refs = {item["target"]["ref"] for item in response.json()["data"]["items"]}
    assert f"media:{outside_id}" in refs
    assert f"media:{already_member_id}" not in refs
    assert f"media:{unrelated_recent_id}" not in refs


def test_library_slate_accepts_only_actively_subscribed_podcast_targets(
    auth_client, direct_db: DirectSessionManager
) -> None:
    user_id = create_test_user_id()
    auth_client.get("/me", headers=auth_headers(user_id))
    with direct_db.session() as session:
        library_id = create_test_library(session, user_id, "Podcast Slate eligibility")
        anchor_id = create_test_media(session, title="Podcast relation anchor")
        add_media_to_library(session, library_id, anchor_id)
        active_id = _seed_podcast_subscription(
            session,
            viewer_id=user_id,
            title="Active Slate podcast",
            status="active",
        )
        unsubscribed_id = _seed_podcast_subscription(
            session,
            viewer_id=user_id,
            title="Unsubscribed Slate podcast",
            status="unsubscribed",
        )
        session.execute(
            text("""
                INSERT INTO resource_edges (
                    user_id, kind, origin,
                    source_scheme, source_id, target_scheme, target_id
                ) VALUES
                    (:user_id, 'context', 'user',
                     'media', :anchor_id, 'podcast', :active_id),
                    (:user_id, 'context', 'user',
                     'media', :anchor_id, 'podcast', :unsubscribed_id)
            """),
            {
                "user_id": user_id,
                "anchor_id": anchor_id,
                "active_id": active_id,
                "unsubscribed_id": unsubscribed_id,
            },
        )
        session.commit()
    direct_db.register_cleanup("libraries", "id", library_id)
    direct_db.register_cleanup("memberships", "library_id", library_id)
    direct_db.register_cleanup("media", "id", anchor_id)
    direct_db.register_cleanup("library_entries", "media_id", anchor_id)
    for podcast_id in (active_id, unsubscribed_id):
        direct_db.register_cleanup("podcasts", "id", podcast_id)
    direct_db.register_cleanup("resource_edges", "source_id", anchor_id)

    response = auth_client.get(f"/libraries/{library_id}/slate", headers=auth_headers(user_id))
    assert response.status_code == 200, response.text
    items = response.json()["data"]["items"]
    refs = {item["target"]["ref"] for item in items}
    assert f"podcast:{active_id}" in refs
    assert f"podcast:{unsubscribed_id}" not in refs
    active = next(item for item in items if item["target"]["ref"] == f"podcast:{active_id}")
    assert active["target"]["kind"] == "Podcast"


def test_library_slate_uses_incoming_synapse_edge_and_keeps_finished_candidate(
    auth_client, direct_db: DirectSessionManager
) -> None:
    user_id = create_test_user_id()
    me = auth_client.get("/me", headers=auth_headers(user_id)).json()["data"]
    with direct_db.session() as session:
        library_id = create_test_library(session, user_id, "Relational Slate")
        anchor_id = create_test_media(session, title="Library anchor")
        candidate_id = create_test_media(session, title="Connected finished candidate")
        add_media_to_library(session, library_id, anchor_id)
        add_media_to_library(session, UUID(me["default_library_id"]), candidate_id)
        session.execute(
            text("""
                INSERT INTO consumption_overrides (user_id, media_id, status)
                VALUES (:user_id, :candidate_id, 'finished')
            """),
            {"user_id": user_id, "candidate_id": candidate_id},
        )
        session.execute(
            text("""
                INSERT INTO resource_edges (
                    user_id, kind, origin,
                    source_scheme, source_id, target_scheme, target_id, snapshot
                ) VALUES (
                    :user_id, 'context', 'synapse',
                    'media', :candidate_id, 'media', :anchor_id,
                    '{"excerpt":"A persisted human-reviewed connection."}'::jsonb
                )
            """),
            {
                "user_id": user_id,
                "candidate_id": candidate_id,
                "anchor_id": anchor_id,
            },
        )
        session.commit()

    direct_db.register_cleanup("libraries", "id", library_id)
    direct_db.register_cleanup("memberships", "library_id", library_id)
    for media_id in (anchor_id, candidate_id):
        direct_db.register_cleanup("media", "id", media_id)
        direct_db.register_cleanup("library_entries", "media_id", media_id)
    direct_db.register_cleanup("consumption_overrides", "media_id", candidate_id)
    direct_db.register_cleanup("resource_edges", "source_id", candidate_id)

    response = auth_client.get(f"/libraries/{library_id}/slate", headers=auth_headers(user_id))
    assert response.status_code == 200, response.text
    items = response.json()["data"]["items"]
    candidate = next(item for item in items if item["target"]["ref"] == f"media:{candidate_id}")
    assert candidate["reason"] == {
        "kind": "Connected",
        "anchor": {
            "ref": f"media:{anchor_id}",
            "label": "Library anchor",
        },
        "edgeOrigin": "synapse",
    }


def test_lectern_slate_excludes_relation_between_child_endpoints_of_same_owner(
    auth_client, direct_db: DirectSessionManager
) -> None:
    user_id = create_test_user_id()
    me = auth_client.get("/me", headers=auth_headers(user_id)).json()["data"]
    with direct_db.session() as session:
        media_id = create_test_media(session, title="Normalized self-edge owner")
        add_media_to_library(session, UUID(me["default_library_id"]), media_id)
        fragment_id = create_test_fragment(
            session,
            media_id,
            content="Two child endpoints share this media owner.",
        )
        highlight_id = create_normalized_fragment_highlight(
            session,
            user_id,
            fragment_id,
            media_id,
        )
        now = datetime.now(UTC)
        session.execute(
            text("UPDATE media SET created_at = :created_at WHERE id = :media_id"),
            {"media_id": media_id, "created_at": now - timedelta(days=120)},
        )
        session.execute(
            text("""
                INSERT INTO resource_edges (
                    user_id, kind, origin, source_scheme, source_id,
                    target_scheme, target_id, created_at
                ) VALUES (
                    :user_id, 'context', 'user', 'fragment', :fragment_id,
                    'highlight', :highlight_id, :created_at
                )
            """),
            {
                "user_id": user_id,
                "fragment_id": fragment_id,
                "highlight_id": highlight_id,
                "created_at": now,
            },
        )
        session.commit()

    direct_db.register_cleanup("media", "id", media_id)
    direct_db.register_cleanup("resource_edges", "source_id", fragment_id)

    response = auth_client.get("/lectern/slate", headers=auth_headers(user_id))
    assert response.status_code == 200, response.text
    refs = {item["target"]["ref"] for item in response.json()["data"]["items"]}
    assert f"media:{media_id}" not in refs


def test_edge_family_cap_counts_unique_normalized_targets_not_evidence_rows(
    auth_client, direct_db: DirectSessionManager
) -> None:
    user_id = create_test_user_id()
    me = auth_client.get("/me", headers=auth_headers(user_id)).json()["data"]
    with direct_db.session() as session:
        library_id = create_test_library(session, user_id, "Edge crowding")
        anchor_id = create_test_media(session, title="Crowding anchor")
        crowded_id = create_test_media(session, title="Many edges, one target")
        peer_ids = [
            create_test_media(session, title=f"Distinct edge peer {index}") for index in range(20)
        ]
        add_media_to_library(session, library_id, anchor_id)
        for media_id in [crowded_id, *peer_ids]:
            add_media_to_library(session, UUID(me["default_library_id"]), media_id)

        fragment_ids = [uuid4() for _ in range(20)]
        session.execute(
            text("""
                INSERT INTO fragments (
                    id, media_id, idx, canonical_text, html_sanitized
                ) VALUES (
                    :id, :media_id, :idx, :canonical_text, :html_sanitized
                )
            """),
            [
                {
                    "id": fragment_id,
                    "media_id": crowded_id,
                    "idx": index,
                    "canonical_text": f"Fragment {index}",
                    "html_sanitized": f"<p>Fragment {index}</p>",
                }
                for index, fragment_id in enumerate(fragment_ids)
            ],
        )
        fresh = datetime.now(UTC)
        session.execute(
            text("""
                INSERT INTO resource_edges (
                    user_id, kind, origin, source_scheme, source_id,
                    target_scheme, target_id, created_at
                ) VALUES (
                    :user_id, 'context', 'user', 'fragment', :source_id,
                    'media', :anchor_id, :created_at
                )
            """),
            [
                {
                    "user_id": user_id,
                    "source_id": fragment_id,
                    "anchor_id": anchor_id,
                    "created_at": fresh,
                }
                for fragment_id in fragment_ids
            ],
        )
        session.execute(
            text("""
                INSERT INTO resource_edges (
                    user_id, kind, origin, source_scheme, source_id,
                    target_scheme, target_id, created_at
                ) VALUES (
                    :user_id, 'context', 'user', 'media', :source_id,
                    'media', :anchor_id, :created_at
                )
            """),
            [
                {
                    "user_id": user_id,
                    "source_id": peer_id,
                    "anchor_id": anchor_id,
                    "created_at": fresh - timedelta(days=1),
                }
                for peer_id in peer_ids
            ],
        )
        session.commit()

    direct_db.register_cleanup("libraries", "id", library_id)
    direct_db.register_cleanup("memberships", "library_id", library_id)
    for media_id in [anchor_id, crowded_id, *peer_ids]:
        direct_db.register_cleanup("media", "id", media_id)
        direct_db.register_cleanup("library_entries", "media_id", media_id)
    direct_db.register_cleanup("fragments", "media_id", crowded_id)
    direct_db.register_cleanup("resource_edges", "target_id", anchor_id)

    response = auth_client.get(f"/libraries/{library_id}/slate", headers=auth_headers(user_id))
    assert response.status_code == 200, response.text
    refs = [item["target"]["ref"] for item in response.json()["data"]["items"]]
    assert len(refs) == 10
    assert len(set(refs)) == 10
    assert f"media:{crowded_id}" in refs


def test_library_slate_shared_author_requires_author_on_both_sides_and_uses_canonical_name(
    auth_client, direct_db: DirectSessionManager
) -> None:
    user_id = create_test_user_id()
    me = auth_client.get("/me", headers=auth_headers(user_id)).json()["data"]
    contributor_id = uuid4()
    with direct_db.session() as session:
        library_id = create_test_library(session, user_id, "Shared-author Slate")
        anchor_id = create_test_media(session, title="Authored anchor")
        author_peer_id = create_test_media(session, title="Authored peer")
        editor_peer_id = create_test_media(session, title="Editor-only peer")
        add_media_to_library(session, library_id, anchor_id)
        for media_id in (author_peer_id, editor_peer_id):
            add_media_to_library(session, UUID(me["default_library_id"]), media_id)
        session.execute(
            text("""
                INSERT INTO contributors (id, handle, display_name)
                VALUES (:id, :handle, 'Canonical Slate Author')
            """),
            {"id": contributor_id, "handle": f"slate-author-{contributor_id}"},
        )
        session.execute(
            text("""
                INSERT INTO contributor_credits (
                    id, contributor_id, media_id, credited_name,
                    normalized_credited_name, role, ordinal, source
                ) VALUES
                    (:anchor_credit_id, :contributor_id, :anchor_id,
                     'Anchor Byline Variant', 'anchor byline variant',
                     'author', 0, 'manual'),
                    (:peer_credit_id, :contributor_id, :author_peer_id,
                     'Peer Byline Variant', 'peer byline variant',
                     'author', 0, 'manual'),
                    (:editor_credit_id, :contributor_id, :editor_peer_id,
                     'Editor Byline Variant', 'editor byline variant',
                     'editor', 0, 'manual')
            """),
            {
                "anchor_credit_id": uuid4(),
                "peer_credit_id": uuid4(),
                "editor_credit_id": uuid4(),
                "contributor_id": contributor_id,
                "anchor_id": anchor_id,
                "author_peer_id": author_peer_id,
                "editor_peer_id": editor_peer_id,
            },
        )
        session.commit()
    direct_db.register_cleanup("libraries", "id", library_id)
    direct_db.register_cleanup("memberships", "library_id", library_id)
    direct_db.register_cleanup("contributors", "id", contributor_id)
    for media_id in (anchor_id, author_peer_id, editor_peer_id):
        direct_db.register_cleanup("media", "id", media_id)
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("contributor_credits", "media_id", media_id)

    response = auth_client.get(f"/libraries/{library_id}/slate", headers=auth_headers(user_id))
    assert response.status_code == 200, response.text
    items = response.json()["data"]["items"]
    refs = {item["target"]["ref"] for item in items}
    assert f"media:{editor_peer_id}" not in refs
    author_peer = next(item for item in items if item["target"]["ref"] == f"media:{author_peer_id}")
    assert author_peer["reason"]["kind"] == "SharedAuthor"
    assert author_peer["reason"]["authorName"] == "Canonical Slate Author"


def test_library_slate_edge_origin_allowlist_excludes_assistant_in_acquisition(
    auth_client, direct_db: DirectSessionManager
) -> None:
    user_id = create_test_user_id()
    me = auth_client.get("/me", headers=auth_headers(user_id)).json()["data"]
    with direct_db.session() as session:
        library_id = create_test_library(session, user_id, "Edge-origin Slate")
        anchor_id = create_test_media(session, title="Origin anchor")
        synapse_id = create_test_media(session, title="Allowed Synapse peer")
        assistant_id = create_test_media(session, title="Excluded assistant peer")
        add_media_to_library(session, library_id, anchor_id)
        for media_id in (synapse_id, assistant_id):
            add_media_to_library(session, UUID(me["default_library_id"]), media_id)
        session.execute(
            text("""
                INSERT INTO resource_edges (
                    user_id, kind, origin,
                    source_scheme, source_id, target_scheme, target_id, snapshot
                ) VALUES
                    (:user_id, 'context', 'synapse',
                     'media', :anchor_id, 'media', :synapse_id,
                     '{"excerpt":"Allowed persisted Synapse."}'::jsonb),
                    (:user_id, 'context', 'assistant',
                     'media', :anchor_id, 'media', :assistant_id,
                     '{"excerpt":"Excluded assistant edge."}'::jsonb)
            """),
            {
                "user_id": user_id,
                "anchor_id": anchor_id,
                "synapse_id": synapse_id,
                "assistant_id": assistant_id,
            },
        )
        session.commit()
    direct_db.register_cleanup("libraries", "id", library_id)
    direct_db.register_cleanup("memberships", "library_id", library_id)
    for media_id in (anchor_id, synapse_id, assistant_id):
        direct_db.register_cleanup("media", "id", media_id)
        direct_db.register_cleanup("library_entries", "media_id", media_id)
    direct_db.register_cleanup("resource_edges", "source_id", anchor_id)

    response = auth_client.get(f"/libraries/{library_id}/slate", headers=auth_headers(user_id))
    assert response.status_code == 200, response.text
    refs = {item["target"]["ref"] for item in response.json()["data"]["items"]}
    assert f"media:{synapse_id}" in refs
    assert f"media:{assistant_id}" not in refs


def test_library_slate_masks_an_inaccessible_library(auth_client) -> None:
    viewer_id = create_test_user_id()
    auth_client.get("/me", headers=auth_headers(viewer_id))
    response = auth_client.get(f"/libraries/{uuid4()}/slate", headers=auth_headers(viewer_id))
    assert response.status_code == 404, response.text
    assert response.json()["error"]["code"] == "E_LIBRARY_NOT_FOUND"
