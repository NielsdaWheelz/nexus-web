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
    direct_db.register_cleanup("library_media", "media_id", media_id)
    direct_db.register_cleanup("pdf_page_text_spans", "media_id", media_id)
    direct_db.register_cleanup("highlight_pdf_anchors", "media_id", media_id)
    direct_db.register_cleanup("highlights", "anchor_media_id", media_id)
    return media_id


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
        direct_db.register_cleanup("library_media", "media_id", mid)

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
        direct_db.register_cleanup("library_media", "media_id", mid)
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
