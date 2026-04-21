"""Integration tests for reader profile and per-media reader state."""

from uuid import UUID, uuid4

import pytest

from nexus.db.models import Fragment, Media, MediaKind, ProcessingStatus, ReaderMediaState
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


def _create_ready_reader_media(
    session,
    *,
    kind: str = MediaKind.epub.value,
    num_fragments: int = 2,
) -> tuple[UUID, list[UUID]]:
    """Create a ready readable media row with contiguous fragments."""
    media = Media(
        id=uuid4(),
        kind=kind,
        title="Reader Test Media",
        processing_status=ProcessingStatus.ready_for_reading,
    )
    session.add(media)
    session.flush()

    fragment_ids: list[UUID] = []
    for idx in range(num_fragments):
        fragment = Fragment(
            id=uuid4(),
            media_id=media.id,
            idx=idx,
            html_sanitized=f"<p>Reader fragment {idx}</p>",
            canonical_text=f"Reader fragment {idx}",
        )
        session.add(fragment)
        session.flush()
        fragment_ids.append(fragment.id)

    session.commit()
    return media.id, fragment_ids


def _register_media_cleanup(direct_db: DirectSessionManager, media_id: UUID) -> None:
    """Register cleanup for media-scoped rows created here."""
    direct_db.register_cleanup("reader_media_state", "media_id", media_id)
    direct_db.register_cleanup("fragments", "media_id", media_id)
    direct_db.register_cleanup("library_entries", "media_id", media_id)
    direct_db.register_cleanup("media", "id", media_id)


class TestGetReaderProfile:
    """GET /me/reader-profile."""

    def test_get_reader_profile_returns_defaults_when_empty(self, auth_client):
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        resp = auth_client.get("/me/reader-profile", headers=auth_headers(user_id))

        assert resp.status_code == 200
        data = resp.json()["data"]
        assert data["theme"] == "light"
        assert data["font_family"] in ("serif", "sans")
        assert 12 <= data["font_size_px"] <= 28
        assert 1.2 <= data["line_height"] <= 2.2
        assert data["focus_mode"] is False
        assert "updated_at" in data

    def test_get_reader_profile_returns_persisted_values(self, auth_client):
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


class TestPatchReaderProfile:
    """PATCH /me/reader-profile."""

    def test_patch_reader_profile_accepts_valid_fields(self, auth_client):
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
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        resp = auth_client.patch(
            "/me/reader-profile",
            json={"theme": "invalid"},
            headers=auth_headers(user_id),
        )

        assert resp.status_code == 400

    def test_patch_reader_profile_rejects_unknown_fields(self, auth_client):
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        resp = auth_client.patch(
            "/me/reader-profile",
            json={"bogus": "paged"},
            headers=auth_headers(user_id),
        )

        assert resp.status_code == 400

    def test_patch_reader_profile_rejects_font_size_out_of_range(self, auth_client):
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        resp = auth_client.patch(
            "/me/reader-profile",
            json={"font_size_px": 8},
            headers=auth_headers(user_id),
        )

        assert resp.status_code == 400

    def test_patch_reader_profile_partial_update(self, auth_client):
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


class TestReaderState:
    """GET/PUT /media/{media_id}/reader-state."""

    def test_get_reader_state_returns_null_when_empty(
        self, auth_client, direct_db: DirectSessionManager
    ):
        user_id = create_test_user_id()
        with direct_db.session() as session:
            media_id, _ = _create_ready_reader_media(session)

        _register_media_cleanup(direct_db, media_id)
        _add_media_to_user_library(auth_client, user_id, media_id)

        resp = auth_client.get(
            f"/media/{media_id}/reader-state",
            headers=auth_headers(user_id),
        )

        assert resp.status_code == 200
        assert resp.json()["data"] is None

    def test_get_reader_state_returns_saved_flat_locator(
        self, auth_client, direct_db: DirectSessionManager
    ):
        user_id = create_test_user_id()
        with direct_db.session() as session:
            media_id, fragment_ids = _create_ready_reader_media(
                session,
                kind=MediaKind.web_article.value,
            )

        _register_media_cleanup(direct_db, media_id)
        _add_media_to_user_library(auth_client, user_id, media_id)

        payload = {
            "source": str(fragment_ids[1]),
            "text_offset": 42,
            "quote": "Reader fragment 1",
            "quote_prefix": "before ",
            "quote_suffix": " after",
            "progression": 0.5,
            "total_progression": 0.75,
            "position": 2,
        }

        put_resp = auth_client.put(
            f"/media/{media_id}/reader-state",
            json=payload,
            headers=auth_headers(user_id),
        )

        assert put_resp.status_code == 200
        assert put_resp.json()["data"] == payload

        get_resp = auth_client.get(
            f"/media/{media_id}/reader-state",
            headers=auth_headers(user_id),
        )

        assert get_resp.status_code == 200
        assert get_resp.json()["data"] == payload

    def test_put_reader_state_persists_pdf_locator(
        self, auth_client, direct_db: DirectSessionManager
    ):
        user_id = create_test_user_id()
        with direct_db.session() as session:
            media_id, _ = _create_ready_reader_media(session, kind=MediaKind.pdf.value)

        _register_media_cleanup(direct_db, media_id)
        _add_media_to_user_library(auth_client, user_id, media_id)

        payload = {
            "page": 4,
            "position": 4,
            "page_progression": 0.6,
            "zoom": 1.25,
        }

        resp = auth_client.put(
            f"/media/{media_id}/reader-state",
            json=payload,
            headers=auth_headers(user_id),
        )

        assert resp.status_code == 200
        assert resp.json()["data"] == payload

        with direct_db.session() as session:
            row = (
                session.query(ReaderMediaState)
                .filter(
                    ReaderMediaState.user_id == user_id,
                    ReaderMediaState.media_id == media_id,
                )
                .one()
            )
            assert row.locator == payload

    def test_put_reader_state_allows_clearing_with_null(
        self, auth_client, direct_db: DirectSessionManager
    ):
        user_id = create_test_user_id()
        with direct_db.session() as session:
            media_id, fragment_ids = _create_ready_reader_media(
                session,
                kind=MediaKind.web_article.value,
            )

        _register_media_cleanup(direct_db, media_id)
        _add_media_to_user_library(auth_client, user_id, media_id)

        set_resp = auth_client.put(
            f"/media/{media_id}/reader-state",
            json={"source": str(fragment_ids[0]), "text_offset": 7, "position": 1},
            headers=auth_headers(user_id),
        )

        assert set_resp.status_code == 200

        clear_resp = auth_client.put(
            f"/media/{media_id}/reader-state",
            json=None,
            headers=auth_headers(user_id),
        )

        assert clear_resp.status_code == 200
        assert clear_resp.json()["data"] is None

        with direct_db.session() as session:
            row = (
                session.query(ReaderMediaState)
                .filter(
                    ReaderMediaState.user_id == user_id,
                    ReaderMediaState.media_id == media_id,
                )
                .one()
            )
            assert row.locator is None

    @pytest.mark.parametrize(
        "payload",
        [
            {"locator": {"source": "legacy", "text_offset": 12}},
            {"locator_kind": "epub_section"},
            {"type": "epub_section", "section_id": "ch01"},
            {"theme": "dark"},
            {},
        ],
    )
    def test_put_reader_state_rejects_removed_payload_shapes(
        self,
        auth_client,
        direct_db: DirectSessionManager,
        payload: dict,
    ):
        user_id = create_test_user_id()
        with direct_db.session() as session:
            media_id, _ = _create_ready_reader_media(session)

        _register_media_cleanup(direct_db, media_id)
        _add_media_to_user_library(auth_client, user_id, media_id)

        resp = auth_client.put(
            f"/media/{media_id}/reader-state",
            json=payload,
            headers=auth_headers(user_id),
        )

        assert resp.status_code == 400

    @pytest.mark.parametrize(
        ("payload", "label"),
        [
            ({"source": None, "text_offset": 12}, "explicit null source is rejected"),
            ({"source": "frag-1"}, "text locator needs an anchor field"),
            ({"text_offset": 12}, "text locator requires source"),
            ({"source": "frag-1", "quote_prefix": "before"}, "quote_prefix requires quote"),
            ({"page_progression": 0.6}, "page_progression requires page"),
            ({"zoom": 1.25}, "zoom requires page"),
            ({"source": "frag-1", "text_offset": -1}, "negative text_offset is rejected"),
            ({"page": 0}, "page must be positive"),
            ({"page": 3, "zoom": 5.0}, "zoom range is enforced"),
        ],
    )
    def test_put_reader_state_rejects_invalid_flat_locator_payloads(
        self,
        auth_client,
        direct_db: DirectSessionManager,
        payload: dict,
        label: str,
    ):
        user_id = create_test_user_id()
        with direct_db.session() as session:
            media_id, _ = _create_ready_reader_media(session, kind=MediaKind.web_article.value)

        _register_media_cleanup(direct_db, media_id)
        _add_media_to_user_library(auth_client, user_id, media_id)

        resp = auth_client.put(
            f"/media/{media_id}/reader-state",
            json=payload,
            headers=auth_headers(user_id),
        )

        assert resp.status_code == 400, (
            f"Expected 400 for invalid locator payload ({label}) but got {resp.status_code}: {resp.json()}"
        )

    def test_put_reader_state_rejects_text_fields_for_pdf(
        self, auth_client, direct_db: DirectSessionManager
    ):
        user_id = create_test_user_id()
        with direct_db.session() as session:
            media_id, _ = _create_ready_reader_media(session, kind=MediaKind.pdf.value)

        _register_media_cleanup(direct_db, media_id)
        _add_media_to_user_library(auth_client, user_id, media_id)

        resp = auth_client.put(
            f"/media/{media_id}/reader-state",
            json={"page": 1, "source": "frag-1", "text_offset": 12},
            headers=auth_headers(user_id),
        )

        assert resp.status_code == 400
        assert resp.json()["error"]["code"] == "E_INVALID_REQUEST"

    def test_put_reader_state_rejects_pdf_fields_for_text_media(
        self, auth_client, direct_db: DirectSessionManager
    ):
        user_id = create_test_user_id()
        with direct_db.session() as session:
            media_id, _ = _create_ready_reader_media(session, kind=MediaKind.epub.value)

        _register_media_cleanup(direct_db, media_id)
        _add_media_to_user_library(auth_client, user_id, media_id)

        resp = auth_client.put(
            f"/media/{media_id}/reader-state",
            json={"source": "chapter-1.xhtml", "text_offset": 12, "page": 1},
            headers=auth_headers(user_id),
        )

        assert resp.status_code == 400
        assert resp.json()["error"]["code"] == "E_INVALID_REQUEST"

    def test_patch_reader_state_method_is_not_supported(
        self, auth_client, direct_db: DirectSessionManager
    ):
        user_id = create_test_user_id()
        with direct_db.session() as session:
            media_id, _ = _create_ready_reader_media(session)

        _register_media_cleanup(direct_db, media_id)
        _add_media_to_user_library(auth_client, user_id, media_id)

        resp = auth_client.patch(
            f"/media/{media_id}/reader-state",
            json={"source": "chapter-1.xhtml", "text_offset": 12},
            headers=auth_headers(user_id),
        )

        assert resp.status_code == 405

    def test_reader_state_masks_unreadable_media(
        self, auth_client, direct_db: DirectSessionManager
    ):
        user_a = create_test_user_id()
        user_b = create_test_user_id()

        with direct_db.session() as session:
            media_id, _ = _create_ready_reader_media(session, kind=MediaKind.epub.value)

        _register_media_cleanup(direct_db, media_id)
        _add_media_to_user_library(auth_client, user_a, media_id)
        auth_client.get("/me", headers=auth_headers(user_b))

        get_resp = auth_client.get(
            f"/media/{media_id}/reader-state",
            headers=auth_headers(user_b),
        )
        put_resp = auth_client.put(
            f"/media/{media_id}/reader-state",
            json={"source": "chapter-1.xhtml", "text_offset": 12},
            headers=auth_headers(user_b),
        )

        assert get_resp.status_code == 404
        assert put_resp.status_code == 404
