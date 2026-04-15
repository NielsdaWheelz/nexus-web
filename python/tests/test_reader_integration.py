"""Integration tests for reader profile and per-media reader resume state.

Tests cover:
- GET /me/reader-profile
- PATCH /me/reader-profile
- GET /media/{media_id}/reader-state
- PATCH /media/{media_id}/reader-state
- Media visibility enforcement (404 masking for unreadable media)
- Resume-only media state and locator reset behavior
"""

from concurrent.futures import ThreadPoolExecutor
from threading import Barrier, BrokenBarrierError

import pytest
from sqlalchemy.sql.dml import Insert

from nexus.db.models import ReaderMediaState
from nexus.schemas.reader import ReaderResumeStatePatch
from nexus.services import reader as reader_service
from tests.factories import create_ready_epub_with_chapters
from tests.helpers import auth_headers, create_test_user_id
from tests.utils.db import DirectSessionManager

pytestmark = pytest.mark.integration


def _add_media_to_user_library(auth_client, user_id, media_id):
    """Bootstrap user and add media to their default library. Returns library_id."""
    me_resp = auth_client.get("/me", headers=auth_headers(user_id))
    library_id = me_resp.json()["data"]["default_library_id"]
    auth_client.post(
        f"/libraries/{library_id}/media",
        json={"media_id": str(media_id)},
        headers=auth_headers(user_id),
    )
    return library_id


# =============================================================================
# GET /me/reader-profile
# =============================================================================


class TestGetReaderProfile:
    """Tests for GET /me/reader-profile."""

    def test_get_reader_profile_returns_defaults_when_empty(self, auth_client):
        """GET /me/reader-profile returns sensible defaults when no profile exists."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        resp = auth_client.get("/me/reader-profile", headers=auth_headers(user_id))

        assert resp.status_code == 200, f"Expected 200 but got {resp.status_code}: {resp.json()}"
        data = resp.json()["data"]
        assert "theme" in data
        assert "font_size_px" in data
        assert "line_height" in data
        assert "font_family" in data
        assert "column_width_ch" in data
        assert "focus_mode" in data
        assert data["theme"] == "light"
        assert 12 <= data["font_size_px"] <= 28
        assert 1.2 <= data["line_height"] <= 2.2
        assert data["font_family"] in ("serif", "sans")
        assert "updated_at" in data

    def test_get_reader_profile_returns_persisted_values(self, auth_client):
        """GET /me/reader-profile returns values after PATCH."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        auth_client.patch(
            "/me/reader-profile",
            json={"theme": "dark", "font_size_px": 18, "focus_mode": True},
            headers=auth_headers(user_id),
        )

        resp = auth_client.get("/me/reader-profile", headers=auth_headers(user_id))
        assert resp.status_code == 200
        data = resp.json()["data"]
        assert data["theme"] == "dark"
        assert data["font_size_px"] == 18
        assert data["focus_mode"] is True


# =============================================================================
# PATCH /me/reader-profile
# =============================================================================


class TestPatchReaderProfile:
    """Tests for PATCH /me/reader-profile."""

    def test_patch_reader_profile_accepts_valid_fields(self, auth_client):
        """PATCH /me/reader-profile accepts valid theme, font_size_px, line_height, etc."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        resp = auth_client.patch(
            "/me/reader-profile",
            json={
                "theme": "dark",
                "font_size_px": 16,
                "line_height": 1.5,
                "font_family": "serif",
                "column_width_ch": 65,
                "focus_mode": True,
            },
            headers=auth_headers(user_id),
        )

        assert resp.status_code == 200
        data = resp.json()["data"]
        assert data["theme"] == "dark"
        assert data["font_size_px"] == 16
        assert data["line_height"] == 1.5
        assert data["font_family"] == "serif"
        assert data["column_width_ch"] == 65
        assert data["focus_mode"] is True

    def test_patch_reader_profile_rejects_invalid_theme(self, auth_client):
        """PATCH /me/reader-profile rejects invalid theme."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        resp = auth_client.patch(
            "/me/reader-profile",
            json={"theme": "invalid"},
            headers=auth_headers(user_id),
        )

        assert resp.status_code == 400

    def test_patch_reader_profile_rejects_unknown_fields(self, auth_client):
        """PATCH /me/reader-profile rejects unknown payload keys."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        resp = auth_client.patch(
            "/me/reader-profile",
            json={"bogus": "paged"},
            headers=auth_headers(user_id),
        )

        assert resp.status_code == 400

    def test_patch_reader_profile_rejects_font_size_out_of_range(self, auth_client):
        """PATCH /me/reader-profile rejects font_size_px outside 12-28."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        resp = auth_client.patch(
            "/me/reader-profile",
            json={"font_size_px": 8},
            headers=auth_headers(user_id),
        )

        assert resp.status_code == 400

    def test_patch_reader_profile_partial_update(self, auth_client):
        """PATCH /me/reader-profile allows partial updates."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        auth_client.patch(
            "/me/reader-profile",
            json={"theme": "dark"},
            headers=auth_headers(user_id),
        )

        resp = auth_client.patch(
            "/me/reader-profile",
            json={"font_size_px": 20},
            headers=auth_headers(user_id),
        )

        assert resp.status_code == 200
        data = resp.json()["data"]
        assert data["theme"] == "dark"
        assert data["font_size_px"] == 20


# =============================================================================
# GET /media/{media_id}/reader-state
# =============================================================================


class TestGetMediaReaderState:
    """Tests for GET /media/{media_id}/reader-state."""

    def test_get_reader_state_returns_resume_shape(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """GET /media/{media_id}/reader-state returns resume-only fields."""
        user_id = create_test_user_id()
        with direct_db.session() as session:
            media_id, _ = create_ready_epub_with_chapters(session, num_chapters=2)

        direct_db.register_cleanup("epub_toc_nodes", "media_id", media_id)
        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        _add_media_to_user_library(auth_client, user_id, media_id)

        resp = auth_client.get(
            f"/media/{media_id}/reader-state",
            headers=auth_headers(user_id),
        )

        assert resp.status_code == 200
        data = resp.json()["data"]
        assert "locator_kind" in data
        assert data["locator_kind"] is None
        assert data["fragment_id"] is None
        assert data["offset"] is None
        assert data["section_id"] is None
        assert data["page"] is None
        assert data["zoom"] is None
        assert "updated_at" in data

    def test_get_reader_state_returns_saved_locator(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """GET /media/{media_id}/reader-state returns saved resume state."""
        user_id = create_test_user_id()
        with direct_db.session() as session:
            media_id, _ = create_ready_epub_with_chapters(session, num_chapters=2)

        # reader_media_state CASCADE-deletes with media; no explicit cleanup needed
        direct_db.register_cleanup("epub_toc_nodes", "media_id", media_id)
        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        _add_media_to_user_library(auth_client, user_id, media_id)

        auth_client.patch(
            f"/media/{media_id}/reader-state",
            json={
                "locator_kind": "epub_section",
                "section_id": "ch01",
            },
            headers=auth_headers(user_id),
        )

        resp = auth_client.get(
            f"/media/{media_id}/reader-state",
            headers=auth_headers(user_id),
        )

        assert resp.status_code == 200
        data = resp.json()["data"]
        assert data["locator_kind"] == "epub_section"
        assert data["section_id"] == "ch01"
        assert data["fragment_id"] is None
        assert data["offset"] is None
        assert data["page"] is None
        assert data["zoom"] is None

    def test_get_reader_state_unreadable_media_returns_404(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """GET /media/{media_id}/reader-state returns 404 for unreadable media (visibility masking)."""
        user_a = create_test_user_id()
        user_b = create_test_user_id()

        with direct_db.session() as session:
            media_id, _ = create_ready_epub_with_chapters(session, num_chapters=2)

        direct_db.register_cleanup("epub_toc_nodes", "media_id", media_id)
        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        _add_media_to_user_library(auth_client, user_a, media_id)
        auth_client.get("/me", headers=auth_headers(user_b))

        resp = auth_client.get(
            f"/media/{media_id}/reader-state",
            headers=auth_headers(user_b),
        )

        assert resp.status_code == 404
        body = resp.json()
        assert body["error"]["code"] == "E_MEDIA_NOT_FOUND"


# =============================================================================
# PATCH /media/{media_id}/reader-state
# =============================================================================


class TestPatchMediaReaderState:
    """Tests for PATCH /media/{media_id}/reader-state."""

    def test_patch_reader_state_accepts_valid_fields(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """PATCH /media/{media_id}/reader-state accepts resume locator fields."""
        user_id = create_test_user_id()
        with direct_db.session() as session:
            media_id, _frag_ids = create_ready_epub_with_chapters(session, num_chapters=2)

        direct_db.register_cleanup("epub_toc_nodes", "media_id", media_id)
        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        _add_media_to_user_library(auth_client, user_id, media_id)

        resp = auth_client.patch(
            f"/media/{media_id}/reader-state",
            json={
                "locator_kind": "epub_section",
                "section_id": "ch01",
            },
            headers=auth_headers(user_id),
        )

        assert resp.status_code == 200
        data = resp.json()["data"]
        assert data.get("locator_kind") == "epub_section"
        assert data.get("section_id") == "ch01"
        assert data.get("fragment_id") is None
        assert data.get("offset") is None
        assert data.get("page") is None
        assert data.get("zoom") is None

    @pytest.mark.parametrize(
        "payload",
        [
            {"theme": "dark"},
            {"font_size_px": 18},
            {"line_height": 1.5},
            {"font_family": "serif"},
            {"column_width_ch": 65},
            {"focus_mode": True},
        ],
    )
    def test_patch_reader_state_rejects_removed_appearance_fields(
        self,
        auth_client,
        direct_db: DirectSessionManager,
        payload: dict,
    ):
        """PATCH /media/{media_id}/reader-state rejects removed appearance fields."""
        user_id = create_test_user_id()
        with direct_db.session() as session:
            media_id, _ = create_ready_epub_with_chapters(session, num_chapters=2)

        direct_db.register_cleanup("epub_toc_nodes", "media_id", media_id)
        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        _add_media_to_user_library(auth_client, user_id, media_id)

        resp = auth_client.patch(
            f"/media/{media_id}/reader-state",
            json=payload,
            headers=auth_headers(user_id),
        )

        assert resp.status_code == 400

    def test_patch_reader_state_unreadable_media_returns_404(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """PATCH /media/{media_id}/reader-state returns 404 for unreadable media."""
        user_a = create_test_user_id()
        user_b = create_test_user_id()

        with direct_db.session() as session:
            media_id, _ = create_ready_epub_with_chapters(session, num_chapters=2)

        direct_db.register_cleanup("epub_toc_nodes", "media_id", media_id)
        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        _add_media_to_user_library(auth_client, user_a, media_id)
        auth_client.get("/me", headers=auth_headers(user_b))

        resp = auth_client.patch(
            f"/media/{media_id}/reader-state",
            json={"locator_kind": "epub_section", "section_id": "ch01"},
            headers=auth_headers(user_b),
        )

        assert resp.status_code == 404
        assert resp.json()["error"]["code"] == "E_MEDIA_NOT_FOUND"

    def test_patch_reader_state_fragment_offset_locator(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """PATCH /media/{media_id}/reader-state accepts fragment_offset locator."""
        user_id = create_test_user_id()
        with direct_db.session() as session:
            media_id, frag_ids = create_ready_epub_with_chapters(session, num_chapters=2)

        direct_db.register_cleanup("epub_toc_nodes", "media_id", media_id)
        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        _add_media_to_user_library(auth_client, user_id, media_id)

        resp = auth_client.patch(
            f"/media/{media_id}/reader-state",
            json={
                "locator_kind": "fragment_offset",
                "fragment_id": str(frag_ids[0]),
                "offset": 42,
            },
            headers=auth_headers(user_id),
        )

        assert resp.status_code == 200
        data = resp.json()["data"]
        assert data.get("locator_kind") == "fragment_offset"
        assert data.get("fragment_id") == str(frag_ids[0])
        assert data.get("offset") == 42

    def test_patch_reader_state_allows_clearing_locator_with_null_kind(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """PATCH /media/{media_id}/reader-state supports clearing locator state with locator_kind=null."""
        user_id = create_test_user_id()
        with direct_db.session() as session:
            media_id, frag_ids = create_ready_epub_with_chapters(session, num_chapters=2)

        direct_db.register_cleanup("epub_toc_nodes", "media_id", media_id)
        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        _add_media_to_user_library(auth_client, user_id, media_id)

        set_locator = auth_client.patch(
            f"/media/{media_id}/reader-state",
            json={
                "locator_kind": "fragment_offset",
                "fragment_id": str(frag_ids[0]),
                "offset": 42,
            },
            headers=auth_headers(user_id),
        )
        assert set_locator.status_code == 200
        assert set_locator.json()["data"]["locator_kind"] == "fragment_offset"

        clear_locator = auth_client.patch(
            f"/media/{media_id}/reader-state",
            json={"locator_kind": None},
            headers=auth_headers(user_id),
        )
        assert clear_locator.status_code == 200
        data = clear_locator.json()["data"]
        assert data["locator_kind"] is None
        assert data["fragment_id"] is None
        assert data["offset"] is None
        assert data["section_id"] is None
        assert data["page"] is None
        assert data["zoom"] is None

    @pytest.mark.parametrize(
        ("payload", "label"),
        [
            ({"locator_kind": "pdf_page"}, "pdf_page requires page"),
            ({"locator_kind": "epub_section"}, "epub_section requires section_id"),
            (
                {"locator_kind": "fragment_offset", "fragment_id": None},
                "fragment_offset requires offset",
            ),
        ],
    )
    def test_patch_reader_state_rejects_incomplete_locator_payload(
        self,
        auth_client,
        direct_db: DirectSessionManager,
        payload: dict,
        label: str,
    ):
        """PATCH /media/{media_id}/reader-state rejects incomplete locator payloads."""
        user_id = create_test_user_id()
        with direct_db.session() as session:
            media_id, _ = create_ready_epub_with_chapters(session, num_chapters=2)

        direct_db.register_cleanup("epub_toc_nodes", "media_id", media_id)
        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        _add_media_to_user_library(auth_client, user_id, media_id)

        resp = auth_client.patch(
            f"/media/{media_id}/reader-state",
            json=payload,
            headers=auth_headers(user_id),
        )
        assert resp.status_code == 400, (
            f"Expected 400 for invalid locator payload ({label}) but got "
            f"{resp.status_code}: {resp.json()}"
        )

    def test_patch_reader_state_rejects_negative_fragment_offset(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """PATCH /media/{media_id}/reader-state rejects negative fragment offsets."""
        user_id = create_test_user_id()
        with direct_db.session() as session:
            media_id, frag_ids = create_ready_epub_with_chapters(session, num_chapters=2)

        direct_db.register_cleanup("epub_toc_nodes", "media_id", media_id)
        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        _add_media_to_user_library(auth_client, user_id, media_id)

        resp = auth_client.patch(
            f"/media/{media_id}/reader-state",
            json={
                "locator_kind": "fragment_offset",
                "fragment_id": str(frag_ids[0]),
                "offset": -1,
            },
            headers=auth_headers(user_id),
        )
        assert resp.status_code == 400

    def test_patch_reader_state_concurrent_first_write_is_race_safe(
        self,
        auth_client,
        direct_db: DirectSessionManager,
        monkeypatch,
    ):
        """Concurrent first-write PATCH calls should not raise duplicate-key errors."""
        user_id = create_test_user_id()
        with direct_db.session() as session:
            media_id, _ = create_ready_epub_with_chapters(session, num_chapters=2)

        direct_db.register_cleanup("reader_media_state", "media_id", media_id)
        direct_db.register_cleanup("epub_toc_nodes", "media_id", media_id)
        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        _add_media_to_user_library(auth_client, user_id, media_id)

        # Scope this test to service-layer race behavior by bypassing visibility checks.
        monkeypatch.setattr(reader_service, "can_read_media", lambda *_args, **_kwargs: True)

        payload = ReaderResumeStatePatch(locator_kind="epub_section", section_id="ch01")
        sync_insert_barrier = Barrier(2)
        sessions = [direct_db.session(), direct_db.session()]

        for session in sessions:
            original_execute = session.execute

            def execute_with_barrier(
                statement, *args, _original_execute=original_execute, **kwargs
            ):
                is_reader_state_insert = (
                    isinstance(statement, Insert)
                    and getattr(statement, "table", None) is ReaderMediaState.__table__
                )
                if is_reader_state_insert:
                    try:
                        sync_insert_barrier.wait(timeout=5)
                    except BrokenBarrierError:
                        pass
                return _original_execute(statement, *args, **kwargs)

            monkeypatch.setattr(session, "execute", execute_with_barrier)

        def run_patch(session):
            try:
                result = reader_service.patch_reader_resume_state(
                    db=session,
                    viewer_id=user_id,
                    media_id=media_id,
                    patch=payload,
                )
                return ("ok", result.locator_kind, result.section_id)
            except Exception as exc:  # pragma: no cover - exercised by red phase
                return ("error", repr(exc))
            finally:
                session.close()

        with ThreadPoolExecutor(max_workers=2) as executor:
            outcomes = list(executor.map(run_patch, sessions))

        errors = [outcome for outcome in outcomes if outcome[0] == "error"]
        assert not errors, (
            "Expected concurrent patch_reader_resume_state first writes to avoid duplicate-key "
            f"failures, but saw errors: {errors}"
        )

        with direct_db.session() as verify_session:
            rows = (
                verify_session.query(ReaderMediaState)
                .filter(
                    ReaderMediaState.user_id == user_id,
                    ReaderMediaState.media_id == media_id,
                )
                .all()
            )

        assert len(rows) == 1, (
            "Expected exactly one reader_media_state row for concurrent first write, "
            f"found {len(rows)} rows."
        )
        assert rows[0].locator_kind == "epub_section"
        assert rows[0].section_id == "ch01"
