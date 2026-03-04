"""Integration tests for aggregated media listing endpoint."""

from uuid import uuid4

import pytest

from nexus.db.models import (
    DefaultLibraryIntrinsic,
    LibraryMedia,
    Media,
    MediaKind,
    ProcessingStatus,
)
from tests.factories import create_test_media_in_library, get_user_default_library
from tests.helpers import auth_headers, create_test_user_id
from tests.utils.db import DirectSessionManager

pytestmark = pytest.mark.integration


class TestListVisibleMedia:
    """Tests for GET /media aggregated visibility list."""

    def test_list_media_returns_only_viewer_visible_media(
        self, auth_client, direct_db: DirectSessionManager
    ):
        user_a = create_test_user_id()
        user_b = create_test_user_id()

        auth_client.get("/me", headers=auth_headers(user_a))
        auth_client.get("/me", headers=auth_headers(user_b))

        with direct_db.session() as session:
            default_a = get_user_default_library(session, user_a)
            default_b = get_user_default_library(session, user_b)
            assert default_a is not None
            assert default_b is not None

            media_a = create_test_media_in_library(
                session,
                user_a,
                default_a,
                title="Visible to A",
            )
            media_b = create_test_media_in_library(
                session,
                user_b,
                default_b,
                title="Hidden from A",
            )

        for media_id in (media_a, media_b):
            direct_db.register_cleanup("default_library_intrinsics", "media_id", media_id)
            direct_db.register_cleanup("library_media", "media_id", media_id)
            direct_db.register_cleanup("media", "id", media_id)

        response = auth_client.get("/media", headers=auth_headers(user_a))
        assert response.status_code == 200
        payload = response.json()
        ids = {row["id"] for row in payload["data"]}
        assert str(media_a) in ids
        assert str(media_b) not in ids
        assert "page" in payload
        assert "next_cursor" in payload["page"]

    def test_list_media_kind_filter(self, auth_client, direct_db: DirectSessionManager):
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        with direct_db.session() as session:
            default_library_id = get_user_default_library(session, user_id)
            assert default_library_id is not None

            article_id = create_test_media_in_library(
                session,
                user_id,
                default_library_id,
                title="Web article item",
            )

            pdf_id = uuid4()
            session.add(
                Media(
                    id=pdf_id,
                    kind=MediaKind.pdf.value,
                    title="PDF item",
                    canonical_source_url="https://example.com/pdf",
                    processing_status=ProcessingStatus.ready_for_reading,
                    created_by_user_id=user_id,
                )
            )
            session.flush()
            session.add(LibraryMedia(library_id=default_library_id, media_id=pdf_id))
            session.add(
                DefaultLibraryIntrinsic(
                    default_library_id=default_library_id,
                    media_id=pdf_id,
                )
            )
            session.commit()

        for media_id in (article_id, pdf_id):
            direct_db.register_cleanup("default_library_intrinsics", "media_id", media_id)
            direct_db.register_cleanup("library_media", "media_id", media_id)
            direct_db.register_cleanup("media", "id", media_id)

        response = auth_client.get("/media?kind=pdf", headers=auth_headers(user_id))
        assert response.status_code == 200
        payload = response.json()
        returned_ids = {row["id"] for row in payload["data"]}
        assert returned_ids == {str(pdf_id)}

    def test_list_media_pagination_cursor(self, auth_client, direct_db: DirectSessionManager):
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        with direct_db.session() as session:
            default_library_id = get_user_default_library(session, user_id)
            assert default_library_id is not None

            media_ids = [
                create_test_media_in_library(
                    session,
                    user_id,
                    default_library_id,
                    title=f"Paged item {idx}",
                )
                for idx in range(3)
            ]

        for media_id in media_ids:
            direct_db.register_cleanup("default_library_intrinsics", "media_id", media_id)
            direct_db.register_cleanup("library_media", "media_id", media_id)
            direct_db.register_cleanup("media", "id", media_id)

        page_one = auth_client.get("/media?limit=2", headers=auth_headers(user_id))
        assert page_one.status_code == 200
        page_one_body = page_one.json()
        assert len(page_one_body["data"]) == 2
        cursor = page_one_body["page"]["next_cursor"]
        assert cursor is not None

        page_two = auth_client.get(
            f"/media?limit=2&cursor={cursor}",
            headers=auth_headers(user_id),
        )
        assert page_two.status_code == 200
        page_two_body = page_two.json()
        assert len(page_two_body["data"]) == 1

        first_ids = {row["id"] for row in page_one_body["data"]}
        second_ids = {row["id"] for row in page_two_body["data"]}
        assert first_ids.isdisjoint(second_ids)

    def test_list_media_rejects_invalid_cursor(self, auth_client):
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        response = auth_client.get(
            "/media?cursor=not-a-valid-cursor", headers=auth_headers(user_id)
        )
        assert response.status_code == 400
        assert response.json()["error"]["code"] == "E_INVALID_CURSOR"

    def test_list_media_rejects_invalid_kind_filter(self, auth_client):
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        response = auth_client.get("/media?kind=invalid_kind", headers=auth_headers(user_id))
        assert response.status_code == 400
        assert response.json()["error"]["code"] == "E_INVALID_REQUEST"

    def test_list_media_search_matches_title_only(
        self, auth_client, direct_db: DirectSessionManager
    ):
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        with direct_db.session() as session:
            default_library_id = get_user_default_library(session, user_id)
            assert default_library_id is not None

            match_id = create_test_media_in_library(
                session,
                user_id,
                default_library_id,
                title="Distributed Systems Handbook",
            )
            non_match_id = create_test_media_in_library(
                session,
                user_id,
                default_library_id,
                title="Organic Chemistry Intro",
            )

        for media_id in (match_id, non_match_id):
            direct_db.register_cleanup("default_library_intrinsics", "media_id", media_id)
            direct_db.register_cleanup("library_media", "media_id", media_id)
            direct_db.register_cleanup("media", "id", media_id)

        response = auth_client.get("/media?search=Distributed", headers=auth_headers(user_id))
        assert response.status_code == 200
        body = response.json()
        returned_ids = {row["id"] for row in body["data"]}
        assert str(match_id) in returned_ids
        assert str(non_match_id) not in returned_ids
