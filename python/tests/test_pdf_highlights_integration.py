"""Integration tests for PDF highlight API endpoints (S6 PR-04).

Covers:
- POST /media/{media_id}/pdf-highlights (create with geometry + match metadata)
- GET  /media/{media_id}/pdf-highlights (page-scoped list)
- PATCH /highlights/{id} with pdf_bounds (geometry replacement)
- PATCH /highlights/{id} color-only on PDF
- D16: anchor-kind mismatch rejection
- D17: duplicate detection (create and update)
- D20: no-op short-circuit
- Generic GET/DELETE compat for PDF highlights
"""

from uuid import UUID, uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

from tests.factories import (
    create_pdf_media_with_text,
    get_user_default_library,
)
from tests.helpers import auth_headers, create_test_user_id
from tests.utils.db import DirectSessionManager

pytestmark = pytest.mark.integration


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

PDF_PLAIN_TEXT = "This is page one content. And this is page two content here."
PDF_PAGE_SPANS = [(0, 26), (26, 60)]  # page 1: 0..26, page 2: 26..60

SAMPLE_QUADS = [
    {
        "x1": 72.0,
        "y1": 700.0,
        "x2": 200.0,
        "y2": 700.0,
        "x3": 200.0,
        "y3": 712.0,
        "x4": 72.0,
        "y4": 712.0,
    },
]

DIFFERENT_QUADS = [
    {
        "x1": 72.0,
        "y1": 500.0,
        "x2": 200.0,
        "y2": 500.0,
        "x3": 200.0,
        "y3": 512.0,
        "x4": 72.0,
        "y4": 512.0,
    },
]


def _add_media_to_library(client: TestClient, user_id: UUID, media_id: UUID) -> None:
    """Add media to a user's default library via API."""
    me_resp = client.get("/me", headers=auth_headers(user_id))
    library_id = me_resp.json()["data"]["default_library_id"]
    client.post(
        f"/libraries/{library_id}/media",
        json={"media_id": str(media_id)},
        headers=auth_headers(user_id),
    )


def _setup_pdf_media(
    auth_client: TestClient,
    direct_db: DirectSessionManager,
    user_id: UUID,
    *,
    plain_text: str = PDF_PLAIN_TEXT,
    page_count: int = 2,
    page_spans: list[tuple[int, int]] | None = None,
    status: str = "ready_for_reading",
) -> UUID:
    """Bootstrap user, create PDF media in their default library."""
    auth_client.get("/me", headers=auth_headers(user_id))
    with direct_db.session() as session:
        lib_id = get_user_default_library(session, user_id)
        assert lib_id is not None
        media_id = create_pdf_media_with_text(
            session,
            user_id,
            lib_id,
            plain_text=plain_text,
            page_count=page_count,
            page_spans=page_spans or PDF_PAGE_SPANS[:page_count],
            status=status,
        )
    direct_db.register_cleanup("media", "id", media_id)
    direct_db.register_cleanup("library_entries", "media_id", media_id)
    direct_db.register_cleanup("pdf_page_text_spans", "media_id", media_id)
    direct_db.register_cleanup("highlight_pdf_anchors", "media_id", media_id)
    direct_db.register_cleanup("highlights", "anchor_media_id", media_id)
    return media_id


def _create_shared_library(session, owner_id: UUID) -> UUID:
    """Create non-default shared library with owner admin membership."""
    library_id = uuid4()
    session.execute(
        text("""
            INSERT INTO libraries (id, name, owner_user_id, is_default)
            VALUES (:id, 'S6 Shared PDF Library', :owner, false)
        """),
        {"id": library_id, "owner": owner_id},
    )
    session.execute(
        text("""
            INSERT INTO memberships (library_id, user_id, role)
            VALUES (:library_id, :user_id, 'admin')
            ON CONFLICT DO NOTHING
        """),
        {"library_id": library_id, "user_id": owner_id},
    )
    return library_id


def _add_library_member(session, library_id: UUID, user_id: UUID, role: str = "member") -> None:
    session.execute(
        text("""
            INSERT INTO memberships (library_id, user_id, role)
            VALUES (:library_id, :user_id, :role)
            ON CONFLICT DO NOTHING
        """),
        {"library_id": library_id, "user_id": user_id, "role": role},
    )


# ---------------------------------------------------------------------------
# POST /media/{media_id}/pdf-highlights
# ---------------------------------------------------------------------------


class TestCreatePdfHighlight:
    """Tests for POST /media/{media_id}/pdf-highlights."""

    def test_create_success_unique_match(self, auth_client, direct_db: DirectSessionManager):
        """Create PDF highlight with unique text match → exact/prefix/suffix derived."""
        user_id = create_test_user_id()
        media_id = _setup_pdf_media(auth_client, direct_db, user_id)

        resp = auth_client.post(
            f"/media/{media_id}/pdf-highlights",
            json={
                "page_number": 1,
                "quads": SAMPLE_QUADS,
                "exact": "page one",
                "color": "yellow",
            },
            headers=auth_headers(user_id),
        )

        assert resp.status_code == 201
        data = resp.json()["data"]
        assert data["anchor"]["type"] == "pdf_page_geometry"
        assert data["anchor"]["media_id"] == str(media_id)
        assert data["anchor"]["page_number"] == 1
        assert len(data["anchor"]["quads"]) == 1
        assert data["color"] == "yellow"
        assert data["exact"] == "page one"
        assert data["author_user_id"] == str(user_id)
        assert data["is_owner"] is True
        assert data["annotation"] is None

    def test_create_empty_exact_pending_match(self, auth_client, direct_db: DirectSessionManager):
        """Empty exact → match_status=empty_exact, prefix/suffix empty."""
        user_id = create_test_user_id()
        media_id = _setup_pdf_media(auth_client, direct_db, user_id)

        resp = auth_client.post(
            f"/media/{media_id}/pdf-highlights",
            json={
                "page_number": 1,
                "quads": SAMPLE_QUADS,
                "exact": "",
                "color": "blue",
            },
            headers=auth_headers(user_id),
        )

        assert resp.status_code == 201
        data = resp.json()["data"]
        assert data["exact"] == ""
        assert data["prefix"] == ""
        assert data["suffix"] == ""

    def test_create_duplicate_conflict(self, auth_client, direct_db: DirectSessionManager):
        """Same user + same geometry → 409 E_HIGHLIGHT_CONFLICT."""
        user_id = create_test_user_id()
        media_id = _setup_pdf_media(auth_client, direct_db, user_id)

        payload = {
            "page_number": 1,
            "quads": SAMPLE_QUADS,
            "exact": "page one",
            "color": "yellow",
        }

        resp1 = auth_client.post(
            f"/media/{media_id}/pdf-highlights",
            json=payload,
            headers=auth_headers(user_id),
        )
        assert resp1.status_code == 201

        resp2 = auth_client.post(
            f"/media/{media_id}/pdf-highlights",
            json=payload,
            headers=auth_headers(user_id),
        )
        assert resp2.status_code == 409
        assert resp2.json()["error"]["code"] == "E_HIGHLIGHT_CONFLICT"

    def test_create_invalid_page_number(self, auth_client, direct_db: DirectSessionManager):
        """page_number > page_count → 400."""
        user_id = create_test_user_id()
        media_id = _setup_pdf_media(auth_client, direct_db, user_id)

        resp = auth_client.post(
            f"/media/{media_id}/pdf-highlights",
            json={
                "page_number": 99,
                "quads": SAMPLE_QUADS,
                "exact": "test",
                "color": "yellow",
            },
            headers=auth_headers(user_id),
        )
        assert resp.status_code == 400

    def test_create_non_pdf_media_rejected(self, auth_client, direct_db: DirectSessionManager):
        """Non-PDF media → 400 E_INVALID_KIND."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        mid = uuid4()
        with direct_db.session() as session:
            session.execute(
                text("""
                    INSERT INTO media (id, kind, title, processing_status)
                    VALUES (:id, 'web_article', 'Article', 'ready_for_reading')
                """),
                {"id": mid},
            )
            session.commit()

        direct_db.register_cleanup("media", "id", mid)
        direct_db.register_cleanup("library_entries", "media_id", mid)

        _add_media_to_library(auth_client, user_id, mid)

        resp = auth_client.post(
            f"/media/{mid}/pdf-highlights",
            json={
                "page_number": 1,
                "quads": SAMPLE_QUADS,
                "exact": "test",
                "color": "yellow",
            },
            headers=auth_headers(user_id),
        )
        assert resp.status_code == 400
        assert resp.json()["error"]["code"] == "E_INVALID_KIND"

    def test_create_media_not_ready_rejected(self, auth_client, direct_db: DirectSessionManager):
        """Media in pending state → 409 E_MEDIA_NOT_READY."""
        user_id = create_test_user_id()
        media_id = _setup_pdf_media(
            auth_client,
            direct_db,
            user_id,
            status="pending",
        )

        resp = auth_client.post(
            f"/media/{media_id}/pdf-highlights",
            json={
                "page_number": 1,
                "quads": SAMPLE_QUADS,
                "exact": "test",
                "color": "yellow",
            },
            headers=auth_headers(user_id),
        )
        assert resp.status_code == 409
        assert resp.json()["error"]["code"] == "E_MEDIA_NOT_READY"

    def test_create_degenerate_geometry_rejected(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """Zero-area quad → 400."""
        user_id = create_test_user_id()
        media_id = _setup_pdf_media(auth_client, direct_db, user_id)

        degenerate_quad = {
            "x1": 72.0,
            "y1": 700.0,
            "x2": 72.0,
            "y2": 700.0,
            "x3": 72.0,
            "y3": 700.0,
            "x4": 72.0,
            "y4": 700.0,
        }
        resp = auth_client.post(
            f"/media/{media_id}/pdf-highlights",
            json={
                "page_number": 1,
                "quads": [degenerate_quad],
                "exact": "test",
                "color": "yellow",
            },
            headers=auth_headers(user_id),
        )
        assert resp.status_code == 400

    def test_create_match_metadata_persisted(self, auth_client, direct_db: DirectSessionManager):
        """Verify match metadata written to highlight_pdf_anchors."""
        user_id = create_test_user_id()
        media_id = _setup_pdf_media(auth_client, direct_db, user_id)

        resp = auth_client.post(
            f"/media/{media_id}/pdf-highlights",
            json={
                "page_number": 1,
                "quads": SAMPLE_QUADS,
                "exact": "page one",
                "color": "yellow",
            },
            headers=auth_headers(user_id),
        )
        assert resp.status_code == 201
        h_id = resp.json()["data"]["id"]

        with direct_db.session() as session:
            row = session.execute(
                text("""
                    SELECT plain_text_match_status, plain_text_start_offset,
                           plain_text_end_offset, geometry_fingerprint
                    FROM highlight_pdf_anchors
                    WHERE highlight_id = :id
                """),
                {"id": h_id},
            ).fetchone()
            assert row is not None
            assert row[0] == "unique"
            assert row[1] is not None
            assert row[2] is not None
            assert row[3] is not None and len(row[3]) == 64


# ---------------------------------------------------------------------------
# GET /media/{media_id}/pdf-highlights
# ---------------------------------------------------------------------------


class TestListPdfHighlights:
    """Tests for GET /media/{media_id}/pdf-highlights."""

    def test_list_page_scoped(self, auth_client, direct_db: DirectSessionManager):
        """Lists only highlights for the requested page."""
        user_id = create_test_user_id()
        media_id = _setup_pdf_media(auth_client, direct_db, user_id)

        auth_client.post(
            f"/media/{media_id}/pdf-highlights",
            json={"page_number": 1, "quads": SAMPLE_QUADS, "exact": "p1", "color": "yellow"},
            headers=auth_headers(user_id),
        )
        auth_client.post(
            f"/media/{media_id}/pdf-highlights",
            json={"page_number": 2, "quads": SAMPLE_QUADS, "exact": "p2", "color": "green"},
            headers=auth_headers(user_id),
        )

        resp = auth_client.get(
            f"/media/{media_id}/pdf-highlights?page_number=1",
            headers=auth_headers(user_id),
        )
        assert resp.status_code == 200
        data = resp.json()["data"]
        assert data["page_number"] == 1
        assert len(data["highlights"]) == 1
        assert data["highlights"][0]["exact"] == "p1"

    def test_list_requires_page_number(self, auth_client, direct_db: DirectSessionManager):
        """Missing page_number query param → 400."""
        user_id = create_test_user_id()
        media_id = _setup_pdf_media(auth_client, direct_db, user_id)

        resp = auth_client.get(
            f"/media/{media_id}/pdf-highlights",
            headers=auth_headers(user_id),
        )
        assert resp.status_code == 400
        assert resp.json()["error"]["code"] == "E_INVALID_REQUEST"

    def test_list_deterministic_ordering(self, auth_client, direct_db: DirectSessionManager):
        """Highlights ordered by sort_top ASC, sort_left ASC."""
        user_id = create_test_user_id()
        media_id = _setup_pdf_media(auth_client, direct_db, user_id)

        top_quad = [
            {
                "x1": 72.0,
                "y1": 100.0,
                "x2": 200.0,
                "y2": 100.0,
                "x3": 200.0,
                "y3": 112.0,
                "x4": 72.0,
                "y4": 112.0,
            }
        ]
        bottom_quad = [
            {
                "x1": 72.0,
                "y1": 500.0,
                "x2": 200.0,
                "y2": 500.0,
                "x3": 200.0,
                "y3": 512.0,
                "x4": 72.0,
                "y4": 512.0,
            }
        ]

        auth_client.post(
            f"/media/{media_id}/pdf-highlights",
            json={"page_number": 1, "quads": bottom_quad, "exact": "bottom", "color": "yellow"},
            headers=auth_headers(user_id),
        )
        auth_client.post(
            f"/media/{media_id}/pdf-highlights",
            json={"page_number": 1, "quads": top_quad, "exact": "top", "color": "green"},
            headers=auth_headers(user_id),
        )

        resp = auth_client.get(
            f"/media/{media_id}/pdf-highlights?page_number=1",
            headers=auth_headers(user_id),
        )
        highlights = resp.json()["data"]["highlights"]
        assert len(highlights) == 2
        assert highlights[0]["exact"] == "top"
        assert highlights[1]["exact"] == "bottom"


class TestListPdfHighlightsIndex:
    """Tests for GET /media/{media_id}/pdf-highlights/index."""

    def test_list_index_returns_cross_page_order_with_cursor_pagination(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """Lists deterministic document-wide order and supports cursor pagination."""
        user_id = create_test_user_id()
        media_id = _setup_pdf_media(
            auth_client,
            direct_db,
            user_id,
            page_count=3,
            page_spans=[(0, 20), (20, 40), (40, 60)],
        )

        page_one_top = [
            {
                "x1": 72.0,
                "y1": 100.0,
                "x2": 200.0,
                "y2": 100.0,
                "x3": 200.0,
                "y3": 112.0,
                "x4": 72.0,
                "y4": 112.0,
            }
        ]
        page_two_mid = [
            {
                "x1": 72.0,
                "y1": 240.0,
                "x2": 200.0,
                "y2": 240.0,
                "x3": 200.0,
                "y3": 252.0,
                "x4": 72.0,
                "y4": 252.0,
            }
        ]
        page_three_top = [
            {
                "x1": 72.0,
                "y1": 80.0,
                "x2": 200.0,
                "y2": 80.0,
                "x3": 200.0,
                "y3": 92.0,
                "x4": 72.0,
                "y4": 92.0,
            }
        ]

        for payload in (
            {"page_number": 3, "quads": page_three_top, "exact": "p3 top", "color": "blue"},
            {"page_number": 1, "quads": page_one_top, "exact": "p1 top", "color": "yellow"},
            {"page_number": 2, "quads": page_two_mid, "exact": "p2 middle", "color": "green"},
        ):
            create_resp = auth_client.post(
                f"/media/{media_id}/pdf-highlights",
                json=payload,
                headers=auth_headers(user_id),
            )
            assert create_resp.status_code == 201, (
                "Expected highlight create to succeed while preparing index test, "
                f"got {create_resp.status_code}: {create_resp.json()}"
            )

        first_page_resp = auth_client.get(
            f"/media/{media_id}/pdf-highlights/index?limit=2&mine_only=false",
            headers=auth_headers(user_id),
        )
        assert first_page_resp.status_code == 200, (
            f"Expected 200 for index page 1, got {first_page_resp.status_code}: "
            f"{first_page_resp.json()}"
        )

        first_page_data = first_page_resp.json()["data"]
        first_page_highlights = first_page_data["highlights"]
        assert [h["exact"] for h in first_page_highlights] == ["p1 top", "p2 middle"], (
            "Expected document-wide ordering by page_number then geometry sort keys, "
            f"got {[h['exact'] for h in first_page_highlights]}"
        )
        assert first_page_data["page"]["has_more"] is True
        assert first_page_data["page"]["next_cursor"] is not None

        second_page_resp = auth_client.get(
            (
                f"/media/{media_id}/pdf-highlights/index?limit=2&mine_only=false"
                f"&cursor={first_page_data['page']['next_cursor']}"
            ),
            headers=auth_headers(user_id),
        )
        assert second_page_resp.status_code == 200, (
            f"Expected 200 for index page 2, got {second_page_resp.status_code}: "
            f"{second_page_resp.json()}"
        )
        second_page_data = second_page_resp.json()["data"]
        assert [h["exact"] for h in second_page_data["highlights"]] == ["p3 top"], (
            "Expected second page to contain final remaining highlight only, "
            f"got {[h['exact'] for h in second_page_data['highlights']]}"
        )
        assert second_page_data["page"]["has_more"] is False
        assert second_page_data["page"]["next_cursor"] is None

    def test_list_index_supports_mine_only_visibility_split(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """mine_only=false includes visible shared highlights; default mine_only=true does not."""
        author_id = create_test_user_id()
        reader_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(author_id))
        auth_client.get("/me", headers=auth_headers(reader_id))

        with direct_db.session() as session:
            shared_library_id = _create_shared_library(session, author_id)
            _add_library_member(session, shared_library_id, reader_id)
            media_id = create_pdf_media_with_text(
                session,
                author_id,
                shared_library_id,
                plain_text=PDF_PLAIN_TEXT,
                page_count=2,
                page_spans=PDF_PAGE_SPANS,
                status="ready_for_reading",
            )
            session.commit()

        direct_db.register_cleanup("highlights", "anchor_media_id", media_id)
        direct_db.register_cleanup("highlight_pdf_anchors", "media_id", media_id)
        direct_db.register_cleanup("pdf_page_text_spans", "media_id", media_id)
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)
        direct_db.register_cleanup("memberships", "library_id", shared_library_id)
        direct_db.register_cleanup("libraries", "id", shared_library_id)

        create_resp = auth_client.post(
            f"/media/{media_id}/pdf-highlights",
            json={"page_number": 1, "quads": SAMPLE_QUADS, "exact": "shared", "color": "yellow"},
            headers=auth_headers(author_id),
        )
        assert create_resp.status_code == 201, (
            "Expected author create to succeed, "
            f"got {create_resp.status_code}: {create_resp.json()}"
        )

        visible_resp = auth_client.get(
            f"/media/{media_id}/pdf-highlights/index?mine_only=false",
            headers=auth_headers(reader_id),
        )
        assert visible_resp.status_code == 200, (
            f"Expected shared reader list to succeed, got {visible_resp.status_code}: "
            f"{visible_resp.json()}"
        )
        assert len(visible_resp.json()["data"]["highlights"]) == 1

        mine_only_resp = auth_client.get(
            f"/media/{media_id}/pdf-highlights/index",
            headers=auth_headers(reader_id),
        )
        assert mine_only_resp.status_code == 200, (
            f"Expected mine_only list to succeed, got {mine_only_resp.status_code}: "
            f"{mine_only_resp.json()}"
        )
        assert mine_only_resp.json()["data"]["highlights"] == []

    def test_page_and_index_include_linked_conversations(
        self, auth_client, direct_db: DirectSessionManager
    ):
        user_id = create_test_user_id()
        media_id = _setup_pdf_media(auth_client, direct_db, user_id)

        create_resp = auth_client.post(
            f"/media/{media_id}/pdf-highlights",
            json={"page_number": 1, "quads": SAMPLE_QUADS, "exact": "linked", "color": "yellow"},
            headers=auth_headers(user_id),
        )
        assert create_resp.status_code == 201
        highlight_id = create_resp.json()["data"]["id"]

        conversation_id = uuid4()
        message_id = uuid4()
        context_id = uuid4()
        with direct_db.session() as session:
            session.execute(
                text("""
                    INSERT INTO conversations (id, owner_user_id, title, sharing, next_seq)
                    VALUES (:id, :owner_user_id, 'Linked chat', 'private', 2)
                """),
                {"id": conversation_id, "owner_user_id": user_id},
            )
            session.execute(
                text("""
                    INSERT INTO messages (id, conversation_id, seq, role, content, status)
                    VALUES (:id, :conversation_id, 1, 'user', 'hello', 'complete')
                """),
                {"id": message_id, "conversation_id": conversation_id},
            )
            session.execute(
                text("""
                    INSERT INTO message_contexts (id, message_id, ordinal, target_type, highlight_id)
                    VALUES (:id, :message_id, 0, 'highlight', :highlight_id)
                """),
                {
                    "id": context_id,
                    "message_id": message_id,
                    "highlight_id": highlight_id,
                },
            )
            session.commit()

        direct_db.register_cleanup("message_contexts", "id", context_id)
        direct_db.register_cleanup("messages", "id", message_id)
        direct_db.register_cleanup("conversations", "id", conversation_id)

        page_resp = auth_client.get(
            f"/media/{media_id}/pdf-highlights?page_number=1&mine_only=false",
            headers=auth_headers(user_id),
        )
        assert page_resp.status_code == 200
        page_highlights = page_resp.json()["data"]["highlights"]
        assert page_highlights[0]["linked_conversations"] == [
            {"conversation_id": str(conversation_id), "title": "Linked chat"}
        ]

        index_resp = auth_client.get(
            f"/media/{media_id}/pdf-highlights/index?mine_only=false",
            headers=auth_headers(user_id),
        )
        assert index_resp.status_code == 200
        index_highlights = index_resp.json()["data"]["highlights"]
        assert index_highlights[0]["linked_conversations"] == [
            {"conversation_id": str(conversation_id), "title": "Linked chat"}
        ]

    def test_list_index_is_deterministic_for_tied_sort_keys_and_cursor(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """Deterministic ordering and cursor slicing when page/sort_top/sort_left/created_at tie."""
        user_id = create_test_user_id()
        media_id = _setup_pdf_media(
            auth_client,
            direct_db,
            user_id,
            page_count=1,
            page_spans=[(0, 40)],
        )

        tied_left = 72.0
        tied_top = 120.0
        first_quad = [
            {
                "x1": tied_left,
                "y1": tied_top,
                "x2": tied_left + 100.0,
                "y2": tied_top,
                "x3": tied_left + 100.0,
                "y3": tied_top + 12.0,
                "x4": tied_left,
                "y4": tied_top + 12.0,
            }
        ]
        second_quad = [
            {
                "x1": tied_left,
                "y1": tied_top,
                "x2": tied_left + 140.0,
                "y2": tied_top,
                "x3": tied_left + 140.0,
                "y3": tied_top + 18.0,
                "x4": tied_left,
                "y4": tied_top + 18.0,
            }
        ]

        first_create = auth_client.post(
            f"/media/{media_id}/pdf-highlights",
            json={"page_number": 1, "quads": first_quad, "exact": "tie-a", "color": "yellow"},
            headers=auth_headers(user_id),
        )
        second_create = auth_client.post(
            f"/media/{media_id}/pdf-highlights",
            json={"page_number": 1, "quads": second_quad, "exact": "tie-b", "color": "green"},
            headers=auth_headers(user_id),
        )
        assert first_create.status_code == 201, first_create.json()
        assert second_create.status_code == 201, second_create.json()
        first_id = first_create.json()["data"]["id"]
        second_id = second_create.json()["data"]["id"]

        tied_created_at = "2026-01-01T00:00:00+00:00"
        with direct_db.session() as session:
            session.execute(
                text("UPDATE highlights SET created_at = :ts WHERE id = :id"),
                {"ts": tied_created_at, "id": first_id},
            )
            session.execute(
                text("UPDATE highlights SET created_at = :ts WHERE id = :id"),
                {"ts": tied_created_at, "id": second_id},
            )
            session.commit()

        base_url = f"/media/{media_id}/pdf-highlights/index?mine_only=false&limit=10"
        first_full = auth_client.get(base_url, headers=auth_headers(user_id))
        second_full = auth_client.get(base_url, headers=auth_headers(user_id))
        assert first_full.status_code == 200, first_full.json()
        assert second_full.status_code == 200, second_full.json()

        first_order = [h["id"] for h in first_full.json()["data"]["highlights"]]
        second_order = [h["id"] for h in second_full.json()["data"]["highlights"]]
        assert first_order == second_order, (
            "Expected repeated index calls to preserve deterministic tie ordering, "
            f"got first={first_order}, second={second_order}"
        )
        assert set(first_order) == {first_id, second_id}

        page_one = auth_client.get(
            f"/media/{media_id}/pdf-highlights/index?mine_only=false&limit=1",
            headers=auth_headers(user_id),
        )
        assert page_one.status_code == 200, page_one.json()
        page_one_data = page_one.json()["data"]
        assert page_one_data["page"]["has_more"] is True
        assert page_one_data["page"]["next_cursor"] is not None
        page_one_ids = [h["id"] for h in page_one_data["highlights"]]

        page_two = auth_client.get(
            (
                f"/media/{media_id}/pdf-highlights/index?mine_only=false&limit=1"
                f"&cursor={page_one_data['page']['next_cursor']}"
            ),
            headers=auth_headers(user_id),
        )
        assert page_two.status_code == 200, page_two.json()
        page_two_data = page_two.json()["data"]
        page_two_ids = [h["id"] for h in page_two_data["highlights"]]
        assert page_two_data["page"]["has_more"] is False
        assert page_two_data["page"]["next_cursor"] is None

        assert page_one_ids + page_two_ids == first_order, (
            "Expected cursor pagination to preserve deterministic full-order sequence, "
            f"full={first_order}, cursor_pages={page_one_ids + page_two_ids}"
        )


class TestPdfHighlightVisibilityRegression:
    """S6 PR-08 visibility regression coverage for PDF highlight surfaces."""

    def test_shared_reader_can_list_and_get_pdf_highlights_with_mine_only_split(
        self, auth_client, direct_db: DirectSessionManager
    ):
        author_id = create_test_user_id()
        reader_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(author_id))
        auth_client.get("/me", headers=auth_headers(reader_id))

        with direct_db.session() as session:
            shared_library_id = _create_shared_library(session, author_id)
            _add_library_member(session, shared_library_id, reader_id)
            media_id = create_pdf_media_with_text(
                session,
                author_id,
                shared_library_id,
                plain_text=PDF_PLAIN_TEXT,
                page_count=2,
                page_spans=PDF_PAGE_SPANS,
                status="ready_for_reading",
            )
            session.commit()

        direct_db.register_cleanup("highlights", "anchor_media_id", media_id)
        direct_db.register_cleanup("highlight_pdf_anchors", "media_id", media_id)
        direct_db.register_cleanup("pdf_page_text_spans", "media_id", media_id)
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)
        direct_db.register_cleanup("memberships", "library_id", shared_library_id)
        direct_db.register_cleanup("libraries", "id", shared_library_id)

        create_resp = auth_client.post(
            f"/media/{media_id}/pdf-highlights",
            json={"page_number": 1, "quads": SAMPLE_QUADS, "exact": "page one", "color": "yellow"},
            headers=auth_headers(author_id),
        )
        assert create_resp.status_code == 201
        highlight_id = create_resp.json()["data"]["id"]

        shared_list_resp = auth_client.get(
            f"/media/{media_id}/pdf-highlights?page_number=1&mine_only=false",
            headers=auth_headers(reader_id),
        )
        assert shared_list_resp.status_code == 200
        shared_data = shared_list_resp.json()["data"]["highlights"]
        assert len(shared_data) == 1
        assert shared_data[0]["id"] == highlight_id
        assert shared_data[0]["is_owner"] is False
        assert shared_data[0]["author_user_id"] == str(author_id)

        mine_only_resp = auth_client.get(
            f"/media/{media_id}/pdf-highlights?page_number=1",
            headers=auth_headers(reader_id),
        )
        assert mine_only_resp.status_code == 200
        assert mine_only_resp.json()["data"]["highlights"] == []

        get_resp = auth_client.get(
            f"/highlights/{highlight_id}",
            headers=auth_headers(reader_id),
        )
        assert get_resp.status_code == 200
        assert get_resp.json()["data"]["is_owner"] is False

    def test_non_owner_and_non_visible_paths_remain_masked_for_pdf_highlights(
        self, auth_client, direct_db: DirectSessionManager
    ):
        author_id = create_test_user_id()
        reader_id = create_test_user_id()
        outsider_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(author_id))
        auth_client.get("/me", headers=auth_headers(reader_id))
        auth_client.get("/me", headers=auth_headers(outsider_id))

        with direct_db.session() as session:
            shared_library_id = _create_shared_library(session, author_id)
            _add_library_member(session, shared_library_id, reader_id)
            media_id = create_pdf_media_with_text(
                session,
                author_id,
                shared_library_id,
                plain_text=PDF_PLAIN_TEXT,
                page_count=2,
                page_spans=PDF_PAGE_SPANS,
                status="ready_for_reading",
            )
            session.commit()

        direct_db.register_cleanup("highlights", "anchor_media_id", media_id)
        direct_db.register_cleanup("highlight_pdf_anchors", "media_id", media_id)
        direct_db.register_cleanup("pdf_page_text_spans", "media_id", media_id)
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)
        direct_db.register_cleanup("memberships", "library_id", shared_library_id)
        direct_db.register_cleanup("libraries", "id", shared_library_id)

        create_resp = auth_client.post(
            f"/media/{media_id}/pdf-highlights",
            json={"page_number": 1, "quads": SAMPLE_QUADS, "exact": "page one", "color": "yellow"},
            headers=auth_headers(author_id),
        )
        assert create_resp.status_code == 201
        highlight_id = create_resp.json()["data"]["id"]

        non_owner_patch_resp = auth_client.patch(
            f"/highlights/{highlight_id}",
            json={"color": "green"},
            headers=auth_headers(reader_id),
        )
        assert non_owner_patch_resp.status_code == 404
        assert non_owner_patch_resp.json()["error"]["code"] == "E_MEDIA_NOT_FOUND"

        outsider_list_resp = auth_client.get(
            f"/media/{media_id}/pdf-highlights?page_number=1&mine_only=false",
            headers=auth_headers(outsider_id),
        )
        assert outsider_list_resp.status_code == 404
        assert outsider_list_resp.json()["error"]["code"] == "E_MEDIA_NOT_FOUND"

        with direct_db.session() as session:
            session.execute(
                text(
                    "DELETE FROM memberships WHERE library_id = :library_id AND user_id = :user_id"
                ),
                {"library_id": shared_library_id, "user_id": reader_id},
            )
            session.commit()

        revoked_list_resp = auth_client.get(
            f"/media/{media_id}/pdf-highlights?page_number=1&mine_only=false",
            headers=auth_headers(reader_id),
        )
        assert revoked_list_resp.status_code == 404
        assert revoked_list_resp.json()["error"]["code"] == "E_MEDIA_NOT_FOUND"

        revoked_get_resp = auth_client.get(
            f"/highlights/{highlight_id}",
            headers=auth_headers(reader_id),
        )
        assert revoked_get_resp.status_code == 404
        assert revoked_get_resp.json()["error"]["code"] == "E_MEDIA_NOT_FOUND"


# ---------------------------------------------------------------------------
# PATCH /highlights/{id} (PDF bounds and color-only)
# ---------------------------------------------------------------------------


class TestUpdatePdfHighlight:
    """Tests for PATCH /highlights/{id} with pdf_bounds or color-only."""

    def test_update_pdf_bounds_success(self, auth_client, direct_db: DirectSessionManager):
        """Replace geometry via pdf_bounds → new anchor data."""
        user_id = create_test_user_id()
        media_id = _setup_pdf_media(auth_client, direct_db, user_id)

        create_resp = auth_client.post(
            f"/media/{media_id}/pdf-highlights",
            json={"page_number": 1, "quads": SAMPLE_QUADS, "exact": "page one", "color": "yellow"},
            headers=auth_headers(user_id),
        )
        h_id = create_resp.json()["data"]["id"]

        update_resp = auth_client.patch(
            f"/highlights/{h_id}",
            json={
                "pdf_bounds": {
                    "page_number": 1,
                    "quads": DIFFERENT_QUADS,
                    "exact": "page one",
                },
            },
            headers=auth_headers(user_id),
        )
        assert update_resp.status_code == 200
        data = update_resp.json()["data"]
        assert data["anchor"]["type"] == "pdf_page_geometry"
        quad = data["anchor"]["quads"][0]
        assert quad["y1"] == 500.0

    def test_update_pdf_color_only(self, auth_client, direct_db: DirectSessionManager):
        """Color-only PATCH on PDF highlight."""
        user_id = create_test_user_id()
        media_id = _setup_pdf_media(auth_client, direct_db, user_id)

        create_resp = auth_client.post(
            f"/media/{media_id}/pdf-highlights",
            json={"page_number": 1, "quads": SAMPLE_QUADS, "exact": "page one", "color": "yellow"},
            headers=auth_headers(user_id),
        )
        h_id = create_resp.json()["data"]["id"]

        update_resp = auth_client.patch(
            f"/highlights/{h_id}",
            json={"color": "green"},
            headers=auth_headers(user_id),
        )
        assert update_resp.status_code == 200
        assert update_resp.json()["data"]["color"] == "green"

    def test_d16_pdf_bounds_on_fragment_rejected(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """pdf_bounds on fragment highlight → 400."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        mid = uuid4()
        fid = uuid4()
        with direct_db.session() as session:
            session.execute(
                text("""
                    INSERT INTO media (id, kind, title, processing_status)
                    VALUES (:mid, 'web_article', 'Article', 'ready_for_reading')
                """),
                {"mid": mid},
            )
            session.execute(
                text("""
                    INSERT INTO fragments (id, media_id, idx, canonical_text, html_sanitized)
                    VALUES (:fid, :mid, 0, 'Hello World', '<p>Hello World</p>')
                """),
                {"fid": fid, "mid": mid},
            )
            session.commit()

        direct_db.register_cleanup("media", "id", mid)
        direct_db.register_cleanup("library_entries", "media_id", mid)
        direct_db.register_cleanup("fragments", "id", fid)
        direct_db.register_cleanup("highlight_fragment_anchors", "fragment_id", fid)
        direct_db.register_cleanup("highlights", "fragment_id", fid)

        _add_media_to_library(auth_client, user_id, mid)

        create_resp = auth_client.post(
            f"/fragments/{fid}/highlights",
            json={"start_offset": 0, "end_offset": 5, "color": "yellow"},
            headers=auth_headers(user_id),
        )
        assert create_resp.status_code == 201, f"Unexpected: {create_resp.json()}"
        h_id = create_resp.json()["data"]["id"]

        update_resp = auth_client.patch(
            f"/highlights/{h_id}",
            json={
                "pdf_bounds": {
                    "page_number": 1,
                    "quads": SAMPLE_QUADS,
                    "exact": "test",
                },
            },
            headers=auth_headers(user_id),
        )
        assert update_resp.status_code == 400

    def test_d16_fragment_offsets_on_pdf_rejected(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """Fragment offsets on PDF highlight → 400."""
        user_id = create_test_user_id()
        media_id = _setup_pdf_media(auth_client, direct_db, user_id)

        create_resp = auth_client.post(
            f"/media/{media_id}/pdf-highlights",
            json={"page_number": 1, "quads": SAMPLE_QUADS, "exact": "p1", "color": "yellow"},
            headers=auth_headers(user_id),
        )
        h_id = create_resp.json()["data"]["id"]

        update_resp = auth_client.patch(
            f"/highlights/{h_id}",
            json={"start_offset": 0, "end_offset": 5},
            headers=auth_headers(user_id),
        )
        assert update_resp.status_code == 400

    def test_d17_update_duplicate_excludes_self(self, auth_client, direct_db: DirectSessionManager):
        """Updating to same geometry as self → no conflict (no-op or success)."""
        user_id = create_test_user_id()
        media_id = _setup_pdf_media(auth_client, direct_db, user_id)

        create_resp = auth_client.post(
            f"/media/{media_id}/pdf-highlights",
            json={"page_number": 1, "quads": SAMPLE_QUADS, "exact": "page one", "color": "yellow"},
            headers=auth_headers(user_id),
        )
        h_id = create_resp.json()["data"]["id"]

        update_resp = auth_client.patch(
            f"/highlights/{h_id}",
            json={
                "pdf_bounds": {
                    "page_number": 1,
                    "quads": SAMPLE_QUADS,
                    "exact": "page one",
                },
            },
            headers=auth_headers(user_id),
        )
        assert update_resp.status_code == 200

    def test_d17_update_duplicate_conflicts_with_other(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """Updating to another highlight's geometry → 409."""
        user_id = create_test_user_id()
        media_id = _setup_pdf_media(auth_client, direct_db, user_id)

        auth_client.post(
            f"/media/{media_id}/pdf-highlights",
            json={"page_number": 1, "quads": SAMPLE_QUADS, "exact": "p1", "color": "yellow"},
            headers=auth_headers(user_id),
        )

        create_resp2 = auth_client.post(
            f"/media/{media_id}/pdf-highlights",
            json={"page_number": 1, "quads": DIFFERENT_QUADS, "exact": "p2", "color": "green"},
            headers=auth_headers(user_id),
        )
        h_id2 = create_resp2.json()["data"]["id"]

        update_resp = auth_client.patch(
            f"/highlights/{h_id2}",
            json={
                "pdf_bounds": {
                    "page_number": 1,
                    "quads": SAMPLE_QUADS,
                    "exact": "conflict",
                },
            },
            headers=auth_headers(user_id),
        )
        assert update_resp.status_code == 409
        assert update_resp.json()["error"]["code"] == "E_HIGHLIGHT_CONFLICT"


# ---------------------------------------------------------------------------
# Generic GET/DELETE compat
# ---------------------------------------------------------------------------


class TestGenericPdfHighlightCompat:
    """Generic routes work correctly with PDF highlights."""

    def test_get_returns_typed_pdf_anchor(self, auth_client, direct_db: DirectSessionManager):
        """GET /highlights/{id} returns TypedHighlightOut with PDF anchor."""
        user_id = create_test_user_id()
        media_id = _setup_pdf_media(auth_client, direct_db, user_id)

        create_resp = auth_client.post(
            f"/media/{media_id}/pdf-highlights",
            json={"page_number": 1, "quads": SAMPLE_QUADS, "exact": "page one", "color": "yellow"},
            headers=auth_headers(user_id),
        )
        h_id = create_resp.json()["data"]["id"]

        get_resp = auth_client.get(
            f"/highlights/{h_id}",
            headers=auth_headers(user_id),
        )
        assert get_resp.status_code == 200
        data = get_resp.json()["data"]
        assert data["anchor"]["type"] == "pdf_page_geometry"
        assert data["anchor"]["media_id"] == str(media_id)
        assert data["anchor"]["page_number"] == 1

    def test_delete_cascades_pdf_highlight(self, auth_client, direct_db: DirectSessionManager):
        """DELETE /highlights/{id} removes PDF highlight + anchor + quads."""
        user_id = create_test_user_id()
        media_id = _setup_pdf_media(auth_client, direct_db, user_id)

        create_resp = auth_client.post(
            f"/media/{media_id}/pdf-highlights",
            json={"page_number": 1, "quads": SAMPLE_QUADS, "exact": "page one", "color": "yellow"},
            headers=auth_headers(user_id),
        )
        h_id = create_resp.json()["data"]["id"]

        del_resp = auth_client.delete(
            f"/highlights/{h_id}",
            headers=auth_headers(user_id),
        )
        assert del_resp.status_code == 204

        get_resp = auth_client.get(
            f"/highlights/{h_id}",
            headers=auth_headers(user_id),
        )
        assert get_resp.status_code == 404

        with direct_db.session() as session:
            anchor = session.execute(
                text("SELECT 1 FROM highlight_pdf_anchors WHERE highlight_id = :id"),
                {"id": h_id},
            ).fetchone()
            assert anchor is None

            quads = session.execute(
                text("SELECT 1 FROM highlight_pdf_quads WHERE highlight_id = :id"),
                {"id": h_id},
            ).fetchone()
            assert quads is None

    def test_annotation_on_pdf_highlight(self, auth_client, direct_db: DirectSessionManager):
        """PUT/DELETE annotation works on PDF highlight."""
        user_id = create_test_user_id()
        media_id = _setup_pdf_media(auth_client, direct_db, user_id)

        create_resp = auth_client.post(
            f"/media/{media_id}/pdf-highlights",
            json={"page_number": 1, "quads": SAMPLE_QUADS, "exact": "page one", "color": "yellow"},
            headers=auth_headers(user_id),
        )
        h_id = create_resp.json()["data"]["id"]

        ann_resp = auth_client.put(
            f"/highlights/{h_id}/annotation",
            json={"body": "My note"},
            headers=auth_headers(user_id),
        )
        assert ann_resp.status_code == 201
        assert ann_resp.json()["data"]["body"] == "My note"

        del_ann = auth_client.delete(
            f"/highlights/{h_id}/annotation",
            headers=auth_headers(user_id),
        )
        assert del_ann.status_code == 204
