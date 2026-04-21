"""Integration tests for reader profile and per-media reader state."""

from uuid import UUID, uuid4

import pytest
from sqlalchemy import text

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


def _build_reader_state_payload(media_kind: str, fragment_ids: list[UUID]) -> dict:
    """Build a valid reader-state payload for the requested media kind."""

    fragment_id = str(fragment_ids[-1])
    if media_kind == MediaKind.web_article.value:
        return {
            "kind": "web",
            "target": {"fragment_id": fragment_id},
            "locations": {
                "text_offset": 42,
                "progression": None,
                "total_progression": 0.75,
                "position": 2,
            },
            "text": {
                "quote": "Reader fragment 1",
                "quote_prefix": None,
                "quote_suffix": " after",
            },
        }
    if media_kind == MediaKind.epub.value:
        return {
            "kind": "epub",
            "target": {
                "section_id": "chapter-2",
                "href_path": "chapter-2.xhtml",
                "anchor_id": None,
            },
            "locations": {
                "text_offset": 12,
                "progression": 0.5,
                "total_progression": 0.75,
                "position": 2,
            },
            "text": {
                "quote": "Reader fragment 1",
                "quote_prefix": "before ",
                "quote_suffix": None,
            },
        }
    if media_kind == MediaKind.pdf.value:
        return {
            "kind": "pdf",
            "page": 4,
            "page_progression": None,
            "zoom": 1.25,
            "position": None,
        }
    if media_kind in {MediaKind.video.value, MediaKind.podcast_episode.value}:
        return {
            "kind": "transcript",
            "target": {"fragment_id": fragment_id},
            "locations": {
                "text_offset": 7,
                "progression": 0.25,
                "total_progression": 0.4,
                "position": 1,
            },
            "text": {
                "quote": "Reader fragment 1",
                "quote_prefix": None,
                "quote_suffix": None,
            },
        }
    raise ValueError(f"Unsupported media kind for reader-state tests: {media_kind}")


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

    @pytest.mark.parametrize(
        "media_kind",
        [
            MediaKind.web_article.value,
            MediaKind.epub.value,
            MediaKind.pdf.value,
            MediaKind.video.value,
        ],
    )
    def test_put_reader_state_round_trips_new_resume_state(
        self,
        auth_client,
        direct_db: DirectSessionManager,
        media_kind: str,
    ):
        user_id = create_test_user_id()
        with direct_db.session() as session:
            media_id, fragment_ids = _create_ready_reader_media(session, kind=media_kind)

        _register_media_cleanup(direct_db, media_id)
        _add_media_to_user_library(auth_client, user_id, media_id)

        payload = _build_reader_state_payload(media_kind, fragment_ids)

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

        payload = _build_reader_state_payload(MediaKind.web_article.value, fragment_ids)
        set_resp = auth_client.put(
            f"/media/{media_id}/reader-state",
            json=payload,
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
            is_sql_null = session.execute(
                text(
                    """
                    SELECT locator IS NULL
                    FROM reader_media_state
                    WHERE id = :state_id
                    """
                ),
                {"state_id": row.id},
            ).scalar_one()
            assert is_sql_null is True

    def test_get_reader_state_returns_null_for_removed_locator_payloads(
        self,
        auth_client,
        direct_db: DirectSessionManager,
    ):
        user_id = create_test_user_id()
        with direct_db.session() as session:
            media_id, _ = _create_ready_reader_media(session, kind=MediaKind.epub.value)

        _register_media_cleanup(direct_db, media_id)
        _add_media_to_user_library(auth_client, user_id, media_id)

        with direct_db.session() as session:
            session.add(
                ReaderMediaState(
                    user_id=user_id,
                    media_id=media_id,
                    locator={"source": "legacy", "text_offset": 12},
                )
            )
            session.commit()

        resp = auth_client.get(
            f"/media/{media_id}/reader-state",
            headers=auth_headers(user_id),
        )

        assert resp.status_code == 200
        assert resp.json()["data"] is None

    def test_get_reader_state_returns_null_for_kind_mismatched_resume_state(
        self,
        auth_client,
        direct_db: DirectSessionManager,
    ):
        user_id = create_test_user_id()
        with direct_db.session() as session:
            media_id, fragment_ids = _create_ready_reader_media(
                session,
                kind=MediaKind.web_article.value,
            )

        _register_media_cleanup(direct_db, media_id)
        _add_media_to_user_library(auth_client, user_id, media_id)

        with direct_db.session() as session:
            session.add(
                ReaderMediaState(
                    user_id=user_id,
                    media_id=media_id,
                    locator=_build_reader_state_payload(MediaKind.video.value, fragment_ids),
                )
            )
            session.commit()

        resp = auth_client.get(
            f"/media/{media_id}/reader-state",
            headers=auth_headers(user_id),
        )

        assert resp.status_code == 200
        assert resp.json()["data"] is None

    @pytest.mark.parametrize(
        "payload",
        [
            {"source": "legacy", "text_offset": 12},
            {"page": 4, "position": 4},
            {"locator": {"kind": "pdf", "page": 1}},
            {"kind": "epub", "section_id": "ch01", "href_path": "ch01.xhtml"},
            {"kind": "web", "target": {"fragment_id": "frag-1"}},
            {
                "kind": "transcript",
                "target": {"fragment_id": "frag-1"},
                "locations": {
                    "text_offset": 12,
                    "progression": 0.1,
                    "total_progression": 0.2,
                    "position": 1,
                },
                "text": {"quote": "q", "quote_prefix": None, "quote_suffix": None},
                "source": "legacy",
            },
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
            media_id, _ = _create_ready_reader_media(session, kind=MediaKind.epub.value)

        _register_media_cleanup(direct_db, media_id)
        _add_media_to_user_library(auth_client, user_id, media_id)

        resp = auth_client.put(
            f"/media/{media_id}/reader-state",
            json=payload,
            headers=auth_headers(user_id),
        )

        assert resp.status_code == 400

    @pytest.mark.parametrize(
        ("media_kind", "payload", "label"),
        [
            (
                MediaKind.web_article.value,
                {
                    "kind": "web",
                    "target": {"fragment_id": "   "},
                    "locations": {
                        "text_offset": 12,
                        "progression": 0.1,
                        "total_progression": 0.2,
                        "position": 1,
                    },
                    "text": {"quote": "q", "quote_prefix": None, "quote_suffix": None},
                },
                "blank fragment ids are rejected",
            ),
            (
                MediaKind.web_article.value,
                {
                    "kind": "web",
                    "target": {"fragment_id": "frag-1"},
                    "locations": {
                        "text_offset": 12,
                        "progression": 0.1,
                        "total_progression": 0.2,
                        "position": 1,
                    },
                    "text": {"quote": None, "quote_prefix": "before ", "quote_suffix": None},
                },
                "quote context requires quote text",
            ),
            (
                MediaKind.epub.value,
                {
                    "kind": "epub",
                    "target": {
                        "section_id": "chapter-1",
                        "href_path": "   ",
                        "anchor_id": None,
                    },
                    "locations": {
                        "text_offset": 12,
                        "progression": 0.1,
                        "total_progression": 0.2,
                        "position": 1,
                    },
                    "text": {"quote": "q", "quote_prefix": None, "quote_suffix": None},
                },
                "blank href_path is rejected",
            ),
            (
                MediaKind.epub.value,
                {
                    "kind": "epub",
                    "target": {
                        "section_id": "chapter-1",
                        "href_path": "chapter-1.xhtml",
                        "anchor_id": "   ",
                    },
                    "locations": {
                        "text_offset": 12,
                        "progression": 0.1,
                        "total_progression": 0.2,
                        "position": 1,
                    },
                    "text": {"quote": "q", "quote_prefix": None, "quote_suffix": None},
                },
                "blank anchor ids are rejected",
            ),
            (
                MediaKind.video.value,
                {
                    "kind": "transcript",
                    "target": {"fragment_id": "frag-1"},
                    "locations": {
                        "text_offset": -1,
                        "progression": 0.1,
                        "total_progression": 0.2,
                        "position": 1,
                    },
                    "text": {"quote": "q", "quote_prefix": None, "quote_suffix": None},
                },
                "negative text offsets are rejected",
            ),
            (
                MediaKind.pdf.value,
                {
                    "kind": "pdf",
                    "page": 0,
                    "page_progression": None,
                    "zoom": 1.25,
                    "position": None,
                },
                "page must be positive",
            ),
            (
                MediaKind.pdf.value,
                {
                    "kind": "pdf",
                    "page": 3,
                    "page_progression": 1.2,
                    "zoom": 1.25,
                    "position": None,
                },
                "page progression range is enforced",
            ),
        ],
    )
    def test_put_reader_state_rejects_invalid_resume_payloads(
        self,
        auth_client,
        direct_db: DirectSessionManager,
        media_kind: str,
        payload: dict,
        label: str,
    ):
        user_id = create_test_user_id()
        with direct_db.session() as session:
            media_id, _ = _create_ready_reader_media(session, kind=media_kind)

        _register_media_cleanup(direct_db, media_id)
        _add_media_to_user_library(auth_client, user_id, media_id)

        resp = auth_client.put(
            f"/media/{media_id}/reader-state",
            json=payload,
            headers=auth_headers(user_id),
        )

        assert resp.status_code == 400, (
            f"Expected 400 for invalid reader-state payload ({label}) but got "
            f"{resp.status_code}: {resp.json()}"
        )

    @pytest.mark.parametrize(
        ("media_kind", "payload_kind"),
        [
            (MediaKind.pdf.value, MediaKind.web_article.value),
            (MediaKind.epub.value, MediaKind.pdf.value),
            (MediaKind.video.value, MediaKind.epub.value),
        ],
    )
    def test_put_reader_state_rejects_kind_mismatch_for_media(
        self,
        auth_client,
        direct_db: DirectSessionManager,
        media_kind: str,
        payload_kind: str,
    ):
        user_id = create_test_user_id()
        with direct_db.session() as session:
            media_id, fragment_ids = _create_ready_reader_media(session, kind=media_kind)

        _register_media_cleanup(direct_db, media_id)
        _add_media_to_user_library(auth_client, user_id, media_id)

        payload = _build_reader_state_payload(payload_kind, fragment_ids)
        resp = auth_client.put(
            f"/media/{media_id}/reader-state",
            json=payload,
            headers=auth_headers(user_id),
        )

        assert resp.status_code == 400
        assert resp.json()["error"]["code"] == "E_INVALID_REQUEST"

    def test_patch_reader_state_method_is_not_supported(
        self, auth_client, direct_db: DirectSessionManager
    ):
        user_id = create_test_user_id()
        with direct_db.session() as session:
            media_id, fragment_ids = _create_ready_reader_media(session)

        _register_media_cleanup(direct_db, media_id)
        _add_media_to_user_library(auth_client, user_id, media_id)

        resp = auth_client.patch(
            f"/media/{media_id}/reader-state",
            json=_build_reader_state_payload(MediaKind.epub.value, fragment_ids),
            headers=auth_headers(user_id),
        )

        assert resp.status_code == 405

    def test_reader_state_masks_unreadable_media(
        self, auth_client, direct_db: DirectSessionManager
    ):
        user_a = create_test_user_id()
        user_b = create_test_user_id()

        with direct_db.session() as session:
            media_id, fragment_ids = _create_ready_reader_media(
                session,
                kind=MediaKind.epub.value,
            )

        _register_media_cleanup(direct_db, media_id)
        _add_media_to_user_library(auth_client, user_a, media_id)
        auth_client.get("/me", headers=auth_headers(user_b))

        get_resp = auth_client.get(
            f"/media/{media_id}/reader-state",
            headers=auth_headers(user_b),
        )
        put_resp = auth_client.put(
            f"/media/{media_id}/reader-state",
            json=_build_reader_state_payload(MediaKind.epub.value, fragment_ids),
            headers=auth_headers(user_b),
        )

        assert get_resp.status_code == 404
        assert put_resp.status_code == 404
