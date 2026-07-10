"""Integration tests for the grand atlas read model (GET /atlas)."""

from uuid import UUID, uuid4

import pytest
from sqlalchemy import text

from nexus.db.models import Media, MediaKind, ProcessingStatus
from tests.helpers import auth_headers, create_test_user_id
from tests.utils.db import DirectSessionManager

pytestmark = pytest.mark.integration


def _bootstrap_default_library(auth_client, user_id: UUID) -> UUID:
    response = auth_client.get("/me", headers=auth_headers(user_id))
    assert response.status_code == 200, response.text
    return UUID(response.json()["data"]["default_library_id"])


def _create_library(auth_client, user_id: UUID, name: str) -> UUID:
    response = auth_client.post("/libraries", headers=auth_headers(user_id), json={"name": name})
    assert response.status_code == 201, response.text
    return UUID(response.json()["data"]["id"])


def _create_media(direct_db: DirectSessionManager, *, title: str) -> UUID:
    media_id = uuid4()
    with direct_db.session() as session:
        session.add(
            Media(
                id=media_id,
                kind=MediaKind.web_article.value,
                title=title,
                canonical_source_url=f"https://example.com/{media_id}",
                processing_status=ProcessingStatus.ready_for_reading,
            )
        )
        session.commit()
    direct_db.register_cleanup("resource_edges", "source_id", media_id)
    direct_db.register_cleanup("highlights", "anchor_media_id", media_id)
    direct_db.register_cleanup("media_atlas_positions", "media_id", media_id)
    direct_db.register_cleanup("library_entries", "media_id", media_id)
    direct_db.register_cleanup("media", "id", media_id)
    return media_id


def _add_media(auth_client, user_id: UUID, library_id: UUID, media_id: UUID) -> None:
    response = auth_client.post(
        f"/libraries/{library_id}/media",
        headers=auth_headers(user_id),
        json={"media_id": str(media_id)},
    )
    assert response.status_code == 201, response.text


def _set_position(direct_db: DirectSessionManager, media_id: UUID, x: float, y: float) -> None:
    with direct_db.session() as session:
        session.execute(
            text("INSERT INTO media_atlas_positions (media_id, x, y) VALUES (:id, :x, :y)"),
            {"id": media_id, "x": x, "y": y},
        )
        session.commit()


def _seed_synapse_context_edge(
    direct_db: DirectSessionManager,
    *,
    user_id: UUID,
    source_media_id: UUID,
    target_media_id: UUID,
) -> None:
    with direct_db.session() as session:
        session.execute(
            text(
                """
                INSERT INTO resource_edges (
                    user_id, kind, origin, source_scheme, source_id,
                    target_scheme, target_id, snapshot
                )
                VALUES (
                    :user_id, 'context', 'synapse', 'media', :source_id,
                    'media', :target_id, '{"excerpt": "resonates"}'::jsonb
                )
                """
            ),
            {"user_id": user_id, "source_id": source_media_id, "target_id": target_media_id},
        )
        session.commit()


def _seed_highlights(
    direct_db: DirectSessionManager, *, user_id: UUID, media_id: UUID, count: int
) -> None:
    with direct_db.session() as session:
        for i in range(count):
            session.execute(
                text(
                    """
                    INSERT INTO highlights (
                        id, user_id, anchor_kind, anchor_media_id,
                        color, exact, prefix, suffix
                    )
                    VALUES (
                        gen_random_uuid(), :user_id, 'fragment_offsets', :media_id,
                        'yellow', :exact, '', ''
                    )
                    """
                ),
                {"user_id": user_id, "media_id": media_id, "exact": f"note {i}"},
            )
        session.commit()
    direct_db.register_cleanup("highlights", "user_id", user_id)


class TestAtlasReadModel:
    def test_read_model_shape_positions_constellations_edges_magnitude(
        self, auth_client, direct_db
    ):
        user_id = create_test_user_id()
        default_lib = _bootstrap_default_library(auth_client, user_id)
        second_lib = _create_library(auth_client, user_id, "Second Shelf")

        m_positioned = _create_media(direct_db, title="Positioned")
        m_nebula = _create_media(direct_db, title="Nebula")
        m_other = _create_media(direct_db, title="Other Shelf")

        _add_media(auth_client, user_id, default_lib, m_positioned)
        _add_media(auth_client, user_id, default_lib, m_nebula)
        _add_media(auth_client, user_id, second_lib, m_other)

        _set_position(direct_db, m_positioned, 0.3, 0.6)
        _seed_synapse_context_edge(
            direct_db, user_id=user_id, source_media_id=m_positioned, target_media_id=m_nebula
        )
        _seed_highlights(direct_db, user_id=user_id, media_id=m_positioned, count=2)

        response = auth_client.get("/atlas", headers=auth_headers(user_id))
        assert response.status_code == 200, response.text
        data = response.json()["data"]

        stars = {UUID(s["media_id"]): s for s in data["stars"]}
        assert set(stars) == {m_positioned, m_nebula, m_other}
        assert stars[m_positioned]["x"] == pytest.approx(0.3, abs=1e-5)
        assert stars[m_positioned]["y"] == pytest.approx(0.6, abs=1e-5)
        assert stars[m_positioned]["magnitude"] == 2
        assert stars[m_nebula]["x"] is None
        assert stars[m_nebula]["y"] is None
        assert stars[m_nebula]["magnitude"] == 0

        constellations = {UUID(c["library_id"]): c for c in data["constellations"]}
        # The default library is a closure over all the user's media.
        assert {m_positioned, m_nebula, m_other}.issubset(
            {UUID(m) for m in constellations[default_lib]["member_media_ids"]}
        )
        assert [UUID(m) for m in constellations[second_lib]["member_media_ids"]] == [m_other]

        assert len(data["edges"]) == 1
        edge = data["edges"][0]
        assert UUID(edge["source_media_id"]) == m_positioned
        assert UUID(edge["target_media_id"]) == m_nebula
        assert edge["kind"] == "context"
        assert edge["origin"] == "synapse"

    def test_etag_roundtrip_returns_304(self, auth_client, direct_db):
        user_id = create_test_user_id()
        default_lib = _bootstrap_default_library(auth_client, user_id)
        media_id = _create_media(direct_db, title="One")
        _add_media(auth_client, user_id, default_lib, media_id)
        _set_position(direct_db, media_id, 0.5, 0.5)

        first = auth_client.get("/atlas", headers=auth_headers(user_id))
        assert first.status_code == 200
        etag = first.headers["ETag"]
        assert etag

        second = auth_client.get("/atlas", headers={**auth_headers(user_id), "If-None-Match": etag})
        assert second.status_code == 304
        assert second.content == b""

    def test_all_nebula_response_valid_etag_all_null(self, auth_client, direct_db):
        user_id = create_test_user_id()
        default_lib = _bootstrap_default_library(auth_client, user_id)
        media_id = _create_media(direct_db, title="Unplaced")
        _add_media(auth_client, user_id, default_lib, media_id)

        response = auth_client.get("/atlas", headers=auth_headers(user_id))
        assert response.status_code == 200, response.text
        assert response.headers["ETag"]
        stars = response.json()["data"]["stars"]
        assert all(star["x"] is None and star["y"] is None for star in stars)

    def test_status_reports_coverage(self, auth_client, direct_db):
        user_id = create_test_user_id()
        default_lib = _bootstrap_default_library(auth_client, user_id)
        positioned = _create_media(direct_db, title="P")
        unpositioned = _create_media(direct_db, title="U")
        _add_media(auth_client, user_id, default_lib, positioned)
        _add_media(auth_client, user_id, default_lib, unpositioned)
        _set_position(direct_db, positioned, 0.2, 0.2)

        response = auth_client.get("/atlas/status", headers=auth_headers(user_id))
        assert response.status_code == 200, response.text
        data = response.json()["data"]
        assert data["total_count"] == 2
        assert data["positioned_count"] == 1
        assert data["stale_count"] == 1
        assert data["projection_version"] == 1

    def test_project_enqueues_job(self, auth_client, direct_db):
        user_id = create_test_user_id()
        _bootstrap_default_library(auth_client, user_id)
        direct_db.register_cleanup("background_jobs", "dedupe_key", f"atlas_project:{user_id}")

        response = auth_client.post("/atlas/project", headers=auth_headers(user_id))
        assert response.status_code == 202, response.text
        assert response.json()["queued"] is True

        with direct_db.session() as session:
            row = session.execute(
                text(
                    "SELECT payload FROM background_jobs"
                    " WHERE dedupe_key = :k AND kind = 'atlas_project_job'"
                ),
                {"k": f"atlas_project:{user_id}"},
            ).one()
        assert row.payload["user_id"] == str(user_id)
