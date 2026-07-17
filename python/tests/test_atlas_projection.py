"""Unit + integration tests for the grand atlas projection service."""

from uuid import UUID, uuid4

import pytest
from sqlalchemy import text

from nexus.db.models import Media, MediaKind, ProcessingStatus
from nexus.services.atlas_projection import (
    count_unpositioned,
    fetch_mean_embeddings,
    list_projectable_user_ids,
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


def _add_media(direct_db: DirectSessionManager, library_id: UUID, media_id: UUID) -> None:
    """Attach media to a library as a direct physical entry.

    Fixture setup only — bypasses the actor filing command's
    readable-or-restorable precondition (spec S4.3 rule 1), which post-cutover
    means the *first* time media lands anywhere is through ingest, not this
    endpoint. These tests exercise projection, not filing, so they seed state
    the way ingest would.
    """
    from tests.factories import add_media_to_library

    with direct_db.session() as session:
        add_media_to_library(session, library_id, media_id)
        session.commit()


@pytest.mark.integration
class TestRunProjectionIntegration:
    def test_projects_visible_media_into_positions(self, auth_client, direct_db):
        user_id = create_test_user_id()
        library_id = _bootstrap_default_library(auth_client, user_id)
        media_ids = [
            _seed_media_with_embedding(direct_db, axis=i, title=f"Work {i}") for i in range(3)
        ]
        for media_id in media_ids:
            _add_media(direct_db, library_id, media_id)

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
        _add_media(direct_db, library_id, media_id)

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
        _add_media(direct_db, library_id, visible)
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
        _add_media(direct_db, library_id, media_id)

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


@pytest.mark.integration
class TestPersonalDefaultVirtualRelation:
    """AC2: Oracle system-only works never enter the embedding-aggregation
    pipeline even when the user holds a system-library membership; the
    periodic sweep (list_projectable_user_ids) considers non-system
    membership, not ownership (spec S4.1)."""

    def test_fetch_mean_embeddings_excludes_system_only_media(self, auth_client, direct_db):
        from nexus.services import library_governance

        user_id = create_test_user_id()
        _bootstrap_default_library(auth_client, user_id)

        system_media = _seed_media_with_embedding(direct_db, axis=3, title="System Work")
        with direct_db.session() as session:
            system_lib = library_governance.ensure_system_library(
                session,
                system_key=f"test_atlas_proj_system_{user_id.hex[:12]}",
                name="Oracle Corpus",
                owner_user_id=user_id,
            )
        direct_db.register_cleanup("memberships", "library_id", system_lib)
        direct_db.register_cleanup("libraries", "id", system_lib)
        with direct_db.session() as session:
            session.execute(
                text(
                    "INSERT INTO library_entries (library_id, position, media_id) "
                    "VALUES (:lib, 0, :media)"
                ),
                {"lib": system_lib, "media": system_media},
            )
            session.commit()

        with direct_db.session() as session:
            means = fetch_mean_embeddings(session, user_id)
            unpositioned = count_unpositioned(session, user_id)
        assert system_media not in {media_id for media_id, _ in means}
        assert unpositioned == 0

    def test_list_projectable_user_ids_includes_non_owner_membership(self, auth_client, direct_db):
        """M5: the periodic sweep must not undercount a viewer whose only
        media access is membership in someone else's shared library — they
        own no library themselves (beyond their own empty Default) yet still
        need re-projection when the shared library's contents change."""
        from tests.factories import add_library_member, create_test_library

        owner_id = create_test_user_id()
        member_id = create_test_user_id()
        _bootstrap_default_library(auth_client, owner_id)
        _bootstrap_default_library(auth_client, member_id)

        with direct_db.session() as session:
            shared_lib = create_test_library(session, owner_id, "Shared Shelf")
            add_library_member(session, shared_lib, member_id, role="member")
        direct_db.register_cleanup("memberships", "library_id", shared_lib)
        direct_db.register_cleanup("libraries", "id", shared_lib)

        with direct_db.session() as session:
            projectable = set(list_projectable_user_ids(session))

        # member_id holds zero owned libraries with entries but a non-system
        # membership — still swept (fixes the pre-cutover owner-only
        # undercount, M5).
        assert member_id in projectable
        assert owner_id in projectable

    def test_list_projectable_user_ids_excludes_system_only_membership(
        self, auth_client, direct_db
    ):
        """AC2: a viewer whose only membership anywhere is a system library
        (e.g. Oracle Corpus) is never swept — a pure system-library
        membership grants no personal projectable surface. Bypasses
        ``/me`` bootstrap deliberately, since every bootstrapped user
        automatically holds a non-system Default membership, which would
        mask this exclusion."""
        from nexus.services import library_governance

        owner_id = create_test_user_id()
        _bootstrap_default_library(auth_client, owner_id)

        system_only_id = create_test_user_id()
        with direct_db.session() as session:
            session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": system_only_id})
            session.commit()
        direct_db.register_cleanup("users", "id", system_only_id)

        with direct_db.session() as session:
            system_lib = library_governance.ensure_system_library(
                session,
                system_key=f"test_atlas_proj_sweep_system_{owner_id.hex[:12]}",
                name="Oracle Corpus",
                owner_user_id=owner_id,
            )
        direct_db.register_cleanup("memberships", "library_id", system_lib)
        direct_db.register_cleanup("libraries", "id", system_lib)

        with direct_db.session() as session:
            session.execute(
                text(
                    "INSERT INTO memberships (library_id, user_id, role)"
                    " VALUES (:lib, :uid, 'member')"
                ),
                {"lib": system_lib, "uid": system_only_id},
            )
            session.commit()

        with direct_db.session() as session:
            projectable = set(list_projectable_user_ids(session))

        assert system_only_id not in projectable
        assert owner_id in projectable
