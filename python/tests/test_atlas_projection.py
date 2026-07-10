"""Unit + integration tests for the grand atlas projection service."""

from uuid import UUID, uuid4

import pytest
from sqlalchemy import text

from nexus.db.models import Media, MediaKind, ProcessingStatus
from nexus.services.atlas_projection import (
    fetch_mean_embeddings,
    pca_2d,
    repulse,
    run_projection,
    upsert_positions,
)
from nexus.services.semantic_chunks import to_pgvector_literal
from tests.helpers import auth_headers, create_test_user_id
from tests.utils.db import DirectSessionManager

# ---------- pure unit: pca_2d + repulse -------------------------------------


def _orthogonal_vectors() -> list[list[float]]:
    """Three vectors spread along distinct 256-dim axes (high variance on 0,1,2)."""
    a = [0.0] * 256
    b = [0.0] * 256
    c = [0.0] * 256
    a[0] = 1.0
    b[1] = 1.0
    c[2] = 1.0
    return [a, b, c]


class TestPca2d:
    def test_all_positions_normalized_into_unit_square(self):
        coords = pca_2d(_orthogonal_vectors())
        assert len(coords) == 3
        for x, y in coords:
            assert 0.0 <= x <= 1.0
            assert 0.0 <= y <= 1.0

    def test_high_variance_axes_separate_points(self):
        coords = pca_2d(_orthogonal_vectors())
        # The three orthogonal points must not collapse onto one another.
        assert len({(round(x, 3), round(y, 3)) for x, y in coords}) == 3

    def test_deterministic_across_runs(self):
        vectors = _orthogonal_vectors()
        assert pca_2d(vectors) == pca_2d(vectors)

    def test_two_vectors_use_ring_fallback(self):
        coords = pca_2d([[1.0] + [0.0] * 255, [0.0, 1.0] + [0.0] * 254])
        assert len(coords) == 2
        for x, y in coords:
            assert 0.0 <= x <= 1.0
            assert 0.0 <= y <= 1.0
        # Ring fallback keeps the two apart.
        assert coords[0] != coords[1]

    def test_empty_input(self):
        assert pca_2d([]) == []


class TestRepulse:
    def test_overlapping_pair_pushed_apart(self):
        pushed = repulse([(0.5, 0.5), (0.505, 0.5)], min_dist=0.05)
        dx = pushed[1][0] - pushed[0][0]
        dy = pushed[1][1] - pushed[0][1]
        assert (dx**2 + dy**2) ** 0.5 >= 0.05 - 1e-6

    def test_non_overlapping_pair_unchanged(self):
        original = [(0.1, 0.1), (0.9, 0.9)]
        assert repulse(original, min_dist=0.02) == original

    def test_stays_in_unit_square(self):
        pushed = repulse([(0.0, 0.0), (0.001, 0.0)], min_dist=0.1)
        for x, y in pushed:
            assert 0.0 <= x <= 1.0
            assert 0.0 <= y <= 1.0


# ---------- integration: full job run against a real DB ---------------------

pytestmark_integration = pytest.mark.integration


def _seed_media_with_embedding(
    direct_db: DirectSessionManager,
    *,
    axis: int,
    title: str,
) -> UUID:
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
        session.flush()
        chunk_id = uuid4()
        session.execute(
            text(
                """
                INSERT INTO content_chunks
                    (id, owner_kind, owner_id, chunk_idx, source_kind, chunk_text,
                     token_count, heading_path, summary_locator)
                VALUES
                    (:id, 'media', :owner_id, 0, 'web_article', 'body',
                     3, '[]'::jsonb, '{}'::jsonb)
                """
            ),
            {"id": chunk_id, "owner_id": media_id},
        )
        vector = [0.0] * 256
        vector[axis] = 1.0
        session.execute(
            text(
                """
                INSERT INTO content_embeddings
                    (id, chunk_id, embedding_provider, embedding_model,
                     embedding_dimensions, embedding_vector)
                VALUES
                    (gen_random_uuid(), :chunk_id, 'openai', 'text-embedding-3-small',
                     256, CAST(:vec AS vector(256)))
                """
            ),
            {"chunk_id": chunk_id, "vec": to_pgvector_literal(vector)},
        )
        session.commit()
    direct_db.register_cleanup("media_atlas_positions", "media_id", media_id)
    direct_db.register_cleanup("media", "id", media_id)
    return media_id


def _bootstrap_default_library(auth_client, user_id: UUID) -> UUID:
    response = auth_client.get("/me", headers=auth_headers(user_id))
    assert response.status_code == 200, response.text
    return UUID(response.json()["data"]["default_library_id"])


def _add_media(auth_client, user_id: UUID, library_id: UUID, media_id: UUID) -> None:
    response = auth_client.post(
        f"/libraries/{library_id}/media",
        headers=auth_headers(user_id),
        json={"media_id": str(media_id)},
    )
    assert response.status_code == 201, response.text


@pytest.mark.integration
class TestRunProjectionIntegration:
    def test_projects_visible_media_into_positions(self, auth_client, direct_db):
        user_id = create_test_user_id()
        library_id = _bootstrap_default_library(auth_client, user_id)
        media_ids = [
            _seed_media_with_embedding(direct_db, axis=i, title=f"Work {i}") for i in range(3)
        ]
        for media_id in media_ids:
            _add_media(auth_client, user_id, library_id, media_id)

        with direct_db.session() as session:
            result = run_projection(session, user_id)
            session.commit()

        assert result["positioned"] == 3
        with direct_db.session() as session:
            rows = session.execute(
                text(
                    "SELECT media_id, x, y, projection_version"
                    " FROM media_atlas_positions WHERE media_id = ANY(:ids)"
                ),
                {"ids": media_ids},
            ).all()
        assert len(rows) == 3
        for row in rows:
            assert 0.0 <= row.x <= 1.0
            assert 0.0 <= row.y <= 1.0
            assert row.projection_version == 1

    def test_second_run_bumps_projection_version(self, auth_client, direct_db):
        user_id = create_test_user_id()
        library_id = _bootstrap_default_library(auth_client, user_id)
        media_id = _seed_media_with_embedding(direct_db, axis=5, title="Solo")
        _add_media(auth_client, user_id, library_id, media_id)

        with direct_db.session() as session:
            run_projection(session, user_id)
            session.commit()
            run_projection(session, user_id)
            session.commit()
            version = session.execute(
                text("SELECT projection_version FROM media_atlas_positions WHERE media_id = :id"),
                {"id": media_id},
            ).scalar_one()
        assert version == 2

    def test_fetch_mean_embeddings_returns_only_visible(self, auth_client, direct_db):
        user_id = create_test_user_id()
        library_id = _bootstrap_default_library(auth_client, user_id)
        visible = _seed_media_with_embedding(direct_db, axis=1, title="Visible")
        _add_media(auth_client, user_id, library_id, visible)
        # An unshared work (no library entry) must not appear.
        _seed_media_with_embedding(direct_db, axis=2, title="Hidden")

        with direct_db.session() as session:
            means = fetch_mean_embeddings(session, user_id)
        media_ids = {media_id for media_id, _ in means}
        assert visible in media_ids
        assert len(media_ids) == 1

    def test_upsert_positions_roundtrip(self, auth_client, direct_db):
        user_id = create_test_user_id()
        library_id = _bootstrap_default_library(auth_client, user_id)
        media_id = _seed_media_with_embedding(direct_db, axis=7, title="Round")
        _add_media(auth_client, user_id, library_id, media_id)

        with direct_db.session() as session:
            written = upsert_positions(session, {media_id: (0.25, 0.75)})
            session.commit()
            row = session.execute(
                text("SELECT x, y FROM media_atlas_positions WHERE media_id = :id"),
                {"id": media_id},
            ).one()
        assert written == 1
        assert abs(row.x - 0.25) < 1e-5
        assert abs(row.y - 0.75) < 1e-5
