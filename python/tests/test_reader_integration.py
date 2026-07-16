"""Integration tests for reader profile and per-media reader state."""

from collections.abc import Callable
from uuid import UUID, uuid4

import pytest
import structlog
from sqlalchemy import event, text
from sqlalchemy.engine import Engine

import nexus.app as app_module
from nexus.db.models import Fragment, Media, MediaKind, ProcessingStatus, ReaderMediaState
from nexus.errors import ApiErrorCode, ConflictError, NotFoundError
from nexus.schemas.reader import CursorWrite
from nexus.services import reader as reader_service
from tests.helpers import auth_headers, create_test_user_id
from tests.utils.db import DirectSessionManager

pytestmark = pytest.mark.integration

READER_STATE_NO_STORE = "private, no-store"


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
    """Register cleanup for media-scoped rows created here.

    Cleanup runs in reverse registration order; the media row must go last
    because the reader-state media FK is deliberately non-cascading."""
    direct_db.register_cleanup("media", "id", media_id)
    direct_db.register_cleanup("library_entries", "media_id", media_id)
    direct_db.register_cleanup("fragments", "media_id", media_id)
    direct_db.register_cleanup("reader_media_state", "media_id", media_id)


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
        assert data["focus_mode"] == "off"
        assert data["hyphenation"] == "auto"
        assert "updated_at" in data

    def test_get_reader_profile_returns_persisted_values(self, auth_client):
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        auth_client.patch(
            "/me/reader-profile",
            json={
                "theme": "dark",
                "font_size_px": 18,
                "focus_mode": "paragraph",
                "hyphenation": "off",
            },
            headers=auth_headers(user_id),
        )

        resp = auth_client.get("/me/reader-profile", headers=auth_headers(user_id))

        assert resp.status_code == 200
        data = resp.json()["data"]
        assert data["theme"] == "dark"
        assert data["font_size_px"] == 18
        assert data["focus_mode"] == "paragraph"
        assert data["hyphenation"] == "off"


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
                "focus_mode": "sentence",
                "hyphenation": "off",
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
        assert data["focus_mode"] == "sentence"
        assert data["hyphenation"] == "off"

    def test_patch_reader_profile_round_trips_hyphenation_only(self, auth_client):
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        resp = auth_client.patch(
            "/me/reader-profile",
            json={"hyphenation": "off"},
            headers=auth_headers(user_id),
        )

        assert resp.status_code == 200
        data = resp.json()["data"]
        assert data["hyphenation"] == "off"
        assert data["focus_mode"] == "off"

    def test_patch_reader_profile_rejects_invalid_focus_mode(self, auth_client):
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        resp = auth_client.patch(
            "/me/reader-profile",
            json={"focus_mode": "always"},
            headers=auth_headers(user_id),
        )

        assert resp.status_code == 400

    def test_patch_reader_profile_rejects_invalid_hyphenation(self, auth_client):
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        resp = auth_client.patch(
            "/me/reader-profile",
            json={"hyphenation": "soft"},
            headers=auth_headers(user_id),
        )

        assert resp.status_code == 400

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


def _cursor_body(locator: dict, base_revision: int) -> dict:
    return {"cursor": {"locator": locator, "base_revision": base_revision}}


def _attention_body(
    dwell_ms: int = 1_000,
    progression: float | None = 0.5,
) -> dict:
    return {
        "dwell_ms_delta": dwell_ms,
        "device_id": "device-test",
        "spans_touched": [],
        "progression": progression,
    }


def _session_count(direct_db: DirectSessionManager, user_id: UUID, media_id: UUID) -> int:
    with direct_db.session() as session:
        return session.execute(
            text("""
                SELECT COUNT(*) FROM reading_sessions
                WHERE user_id = :user_id AND media_id = :media_id
            """),
            {"user_id": user_id, "media_id": media_id},
        ).scalar_one()


def _cursor_row(
    direct_db: DirectSessionManager, user_id: UUID, media_id: UUID
) -> tuple[dict, int] | None:
    with direct_db.session() as session:
        row = session.execute(
            text("""
                SELECT locator, revision FROM reader_media_state
                WHERE user_id = :user_id AND media_id = :media_id
            """),
            {"user_id": user_id, "media_id": media_id},
        ).first()
    return None if row is None else (row.locator, row.revision)


def _one_shot_before_execute(
    engine: Engine, statement_marker: str, callback: Callable[[], None]
) -> Callable[[], None]:
    """Run ``callback`` once, immediately before the first statement containing
    ``statement_marker`` executes. Returns a remover for the hook."""
    fired = {"done": False}

    def hook(conn, cursor, statement, parameters, context, executemany):
        if fired["done"] or statement_marker not in statement:
            return
        fired["done"] = True
        callback()

    event.listen(engine, "before_cursor_execute", hook)
    return lambda: event.remove(engine, "before_cursor_execute", hook)


class TestReaderCursorGet:
    """GET /media/{media_id}/reader-state."""

    def test_get_returns_empty_snapshot_when_no_cursor(
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
        assert resp.json()["data"] == {"state": "Empty", "revision": 0}
        assert resp.headers["cache-control"] == READER_STATE_NO_STORE

    def test_get_fails_loudly_for_invalid_stored_locator(
        self, auth_client, direct_db: DirectSessionManager
    ):
        user_id = create_test_user_id()
        with direct_db.session() as session:
            media_id, _ = _create_ready_reader_media(
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
                    locator={"source": "fragment-2", "text_offset": 84},
                )
            )
            session.commit()

        resp = auth_client.get(
            f"/media/{media_id}/reader-state",
            headers=auth_headers(user_id),
        )

        assert resp.status_code == 500
        assert resp.json()["error"]["code"] == "E_INTERNAL"
        assert resp.headers["cache-control"] == READER_STATE_NO_STORE

    def test_get_fails_loudly_for_persisted_kind_mismatch(
        self, auth_client, direct_db: DirectSessionManager
    ):
        user_id = create_test_user_id()
        with direct_db.session() as session:
            media_id, fragment_ids = _create_ready_reader_media(
                session,
                kind=MediaKind.pdf.value,
            )

        _register_media_cleanup(direct_db, media_id)
        _add_media_to_user_library(auth_client, user_id, media_id)

        with direct_db.session() as session:
            session.add(
                ReaderMediaState(
                    user_id=user_id,
                    media_id=media_id,
                    locator=_build_reader_state_payload(MediaKind.web_article.value, fragment_ids),
                )
            )
            session.commit()

        resp = auth_client.get(
            f"/media/{media_id}/reader-state",
            headers=auth_headers(user_id),
        )

        assert resp.status_code == 500
        assert resp.json()["error"]["code"] == "E_INTERNAL"

    def test_get_fails_loudly_for_non_positive_stored_revision(
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
        with direct_db.session() as session:
            session.add(ReaderMediaState(user_id=user_id, media_id=media_id, locator=payload))
            session.flush()
            session.execute(
                text("""
                    UPDATE reader_media_state SET revision = 0
                    WHERE user_id = :user_id AND media_id = :media_id
                """),
                {"user_id": user_id, "media_id": media_id},
            )
            session.commit()

        resp = auth_client.get(
            f"/media/{media_id}/reader-state",
            headers=auth_headers(user_id),
        )

        assert resp.status_code == 500
        assert resp.json()["error"]["code"] == "E_INTERNAL"


class TestReaderCursorPut:
    """PUT /media/{media_id}/reader-state cursor semantics."""

    @pytest.mark.parametrize(
        "media_kind",
        [
            MediaKind.web_article.value,
            MediaKind.epub.value,
            MediaKind.pdf.value,
            MediaKind.video.value,
        ],
    )
    def test_put_creates_cursor_at_revision_one_and_round_trips(
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
            json=_cursor_body(payload, 0),
            headers=auth_headers(user_id),
        )

        assert put_resp.status_code == 200
        assert put_resp.json()["data"] == {
            "state": "Positioned",
            "revision": 1,
            "locator": payload,
        }
        assert put_resp.headers["cache-control"] == READER_STATE_NO_STORE

        get_resp = auth_client.get(
            f"/media/{media_id}/reader-state",
            headers=auth_headers(user_id),
        )

        assert get_resp.status_code == 200
        assert get_resp.json()["data"] == {
            "state": "Positioned",
            "revision": 1,
            "locator": payload,
        }

    def test_put_with_current_base_increments_once(
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

        payload_a = _build_reader_state_payload(MediaKind.web_article.value, fragment_ids)
        payload_b = {
            **payload_a,
            "locations": {**payload_a["locations"], "text_offset": 99, "position": 3},
        }

        first = auth_client.put(
            f"/media/{media_id}/reader-state",
            json=_cursor_body(payload_a, 0),
            headers=auth_headers(user_id),
        )
        second = auth_client.put(
            f"/media/{media_id}/reader-state",
            json=_cursor_body(payload_b, 1),
            headers=auth_headers(user_id),
        )

        assert first.status_code == 200
        assert second.status_code == 200
        assert second.json()["data"] == {
            "state": "Positioned",
            "revision": 2,
            "locator": payload_b,
        }

    def test_put_equal_locator_is_idempotent_at_any_base(
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
        auth_client.put(
            f"/media/{media_id}/reader-state",
            json=_cursor_body(payload, 0),
            headers=auth_headers(user_id),
        )

        retry = auth_client.put(
            f"/media/{media_id}/reader-state",
            json=_cursor_body(payload, 999),
            headers=auth_headers(user_id),
        )

        assert retry.status_code == 200
        assert retry.json()["data"] == {
            "state": "Positioned",
            "revision": 1,
            "locator": payload,
        }
        assert _cursor_row(direct_db, user_id, media_id) == (payload, 1)

    def test_put_stale_base_conflicts_with_current_snapshot_and_mutates_nothing(
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

        payload_a = _build_reader_state_payload(MediaKind.web_article.value, fragment_ids)
        payload_b = {
            **payload_a,
            "locations": {**payload_a["locations"], "text_offset": 7, "position": 1},
        }
        auth_client.put(
            f"/media/{media_id}/reader-state",
            json=_cursor_body(payload_a, 0),
            headers=auth_headers(user_id),
        )

        stale = auth_client.put(
            f"/media/{media_id}/reader-state",
            json=_cursor_body(payload_b, 0),
            headers=auth_headers(user_id),
        )

        assert stale.status_code == 409
        error = stale.json()["error"]
        assert error["code"] == "E_READER_STATE_CONFLICT"
        assert error["details"]["current"] == {
            "state": "Positioned",
            "revision": 1,
            "locator": payload_a,
        }
        assert stale.headers["cache-control"] == READER_STATE_NO_STORE
        assert _cursor_row(direct_db, user_id, media_id) == (payload_a, 1)

    def test_put_positive_base_against_empty_conflicts_with_empty_snapshot(
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
        resp = auth_client.put(
            f"/media/{media_id}/reader-state",
            json=_cursor_body(payload, 3),
            headers=auth_headers(user_id),
        )

        assert resp.status_code == 409
        assert resp.json()["error"]["details"]["current"] == {"state": "Empty", "revision": 0}
        assert _cursor_row(direct_db, user_id, media_id) is None

    @pytest.mark.parametrize(
        ("body_builder", "label"),
        [
            (lambda payload: payload, "old bare locator body"),
            (lambda payload: {"locator": payload}, "old flat envelope"),
            (lambda payload: None, "top-level null (removed public clear)"),
            (
                lambda payload: {"cursor": {"locator": payload}},
                "missing base revision",
            ),
            (
                lambda payload: {"cursor": {"locator": None, "base_revision": 0}},
                "null cursor locator",
            ),
            (
                lambda payload: {"cursor": {"locator": payload, "base_revision": -1}},
                "negative base revision",
            ),
            (
                lambda payload: {
                    "cursor": {"locator": payload, "base_revision": 0},
                    "unexpected": True,
                },
                "extra envelope fields",
            ),
            (
                lambda payload: {"cursor": {"locator": payload, "base_revision": 0, "extra": 1}},
                "extra cursor fields",
            ),
            (lambda payload: {}, "empty envelope (no block)"),
            (
                lambda payload: {"cursor": None, "attention": None},
                "both blocks null",
            ),
        ],
    )
    def test_put_rejects_removed_and_malformed_envelopes(
        self,
        auth_client,
        direct_db: DirectSessionManager,
        body_builder,
        label: str,
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
        auth_client.put(
            f"/media/{media_id}/reader-state",
            json=_cursor_body(payload, 0),
            headers=auth_headers(user_id),
        )

        resp = auth_client.put(
            f"/media/{media_id}/reader-state",
            json=body_builder(payload),
            headers=auth_headers(user_id),
        )

        assert resp.status_code == 400, (
            f"Expected 400 for {label} but got {resp.status_code}: {resp.json()}"
        )
        assert resp.headers["cache-control"] == READER_STATE_NO_STORE
        assert _cursor_row(direct_db, user_id, media_id) == (payload, 1)

    def test_put_rejects_missing_body_without_writing(
        self, auth_client, direct_db: DirectSessionManager
    ):
        user_id = create_test_user_id()
        with direct_db.session() as session:
            media_id, _ = _create_ready_reader_media(
                session,
                kind=MediaKind.web_article.value,
            )

        _register_media_cleanup(direct_db, media_id)
        _add_media_to_user_library(auth_client, user_id, media_id)

        resp = auth_client.put(
            f"/media/{media_id}/reader-state",
            headers=auth_headers(user_id),
        )

        assert resp.status_code == 400
        assert _cursor_row(direct_db, user_id, media_id) is None

    @pytest.mark.parametrize(
        ("quote_field", "length", "label"),
        [
            ("quote", 257, "quote above 256 code points"),
            ("quote_prefix", 129, "quote_prefix above 128 code points"),
            ("quote_suffix", 129, "quote_suffix above 128 code points"),
        ],
    )
    def test_put_rejects_oversized_quote_context(
        self,
        auth_client,
        direct_db: DirectSessionManager,
        quote_field: str,
        length: int,
        label: str,
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
        # Astral (non-BMP) characters: the bound counts code points, not bytes.
        payload["text"] = {
            "quote": "q",
            "quote_prefix": None,
            "quote_suffix": None,
            quote_field: "\U0001f4d6" * length,
        }

        resp = auth_client.put(
            f"/media/{media_id}/reader-state",
            json=_cursor_body(payload, 0),
            headers=auth_headers(user_id),
        )

        assert resp.status_code == 400, (
            f"Expected 400 for {label} but got {resp.status_code}: {resp.json()}"
        )
        assert _cursor_row(direct_db, user_id, media_id) is None

    def test_put_accepts_quote_context_at_exact_bounds(
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
        payload["text"] = {
            "quote": "\U0001f4d6" * 256,
            "quote_prefix": "p" * 128,
            "quote_suffix": "s" * 128,
        }

        resp = auth_client.put(
            f"/media/{media_id}/reader-state",
            json=_cursor_body(payload, 0),
            headers=auth_headers(user_id),
        )

        assert resp.status_code == 200

    @pytest.mark.parametrize(
        ("media_kind", "payload_kind"),
        [
            (MediaKind.pdf.value, MediaKind.web_article.value),
            (MediaKind.epub.value, MediaKind.pdf.value),
            (MediaKind.video.value, MediaKind.epub.value),
        ],
    )
    def test_put_rejects_kind_mismatch_for_media(
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
            json=_cursor_body(payload, 0),
            headers=auth_headers(user_id),
        )

        assert resp.status_code == 400
        assert resp.json()["error"]["code"] == "E_INVALID_REQUEST"

    def test_patch_method_is_not_supported(self, auth_client, direct_db: DirectSessionManager):
        user_id = create_test_user_id()
        with direct_db.session() as session:
            media_id, fragment_ids = _create_ready_reader_media(session)

        _register_media_cleanup(direct_db, media_id)
        _add_media_to_user_library(auth_client, user_id, media_id)

        resp = auth_client.patch(
            f"/media/{media_id}/reader-state",
            json=_cursor_body(_build_reader_state_payload(MediaKind.epub.value, fragment_ids), 0),
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
            json=_cursor_body(_build_reader_state_payload(MediaKind.epub.value, fragment_ids), 0),
            headers=auth_headers(user_b),
        )
        attention_resp = auth_client.put(
            f"/media/{media_id}/reader-state",
            json={"attention": _attention_body()},
            headers=auth_headers(user_b),
        )

        assert get_resp.status_code == 404
        assert put_resp.status_code == 404
        assert attention_resp.status_code == 404
        assert get_resp.headers["cache-control"] == READER_STATE_NO_STORE
        assert put_resp.headers["cache-control"] == READER_STATE_NO_STORE

    def test_validation_logs_redact_request_values(
        self,
        auth_client,
        direct_db: DirectSessionManager,
        log_sink: list[dict],
        monkeypatch,
    ):
        user_id = create_test_user_id()
        with direct_db.session() as session:
            media_id, fragment_ids = _create_ready_reader_media(
                session,
                kind=MediaKind.web_article.value,
            )

        _register_media_cleanup(direct_db, media_id)
        _add_media_to_user_library(auth_client, user_id, media_id)

        # The module-level logger proxy was cached before log_sink reconfigured
        # structlog; rebind so the validation handler routes into the sink.
        monkeypatch.setattr(app_module, "logger", structlog.get_logger("nexus.app"))

        sentinel = "REDACTION-SENTINEL-QUOTE"
        payload = _build_reader_state_payload(MediaKind.web_article.value, fragment_ids)
        payload["text"] = {
            "quote": sentinel + "x" * 300,
            "quote_prefix": None,
            "quote_suffix": None,
        }

        resp = auth_client.put(
            f"/media/{media_id}/reader-state",
            json=_cursor_body(payload, 0),
            headers=auth_headers(user_id),
        )

        assert resp.status_code == 400
        validation_events = [
            event_dict
            for event_dict in log_sink
            if event_dict.get("event") == "request_validation_failed"
        ]
        assert validation_events, "validation failure must be logged"
        assert sentinel not in str(log_sink)


class TestReaderAttentionIsolation:
    """Attention writes never create, revise, or replace cursor state."""

    def test_attention_only_returns_204_and_never_touches_cursor(
        self, auth_client, direct_db: DirectSessionManager
    ):
        user_id = create_test_user_id()
        with direct_db.session() as session:
            media_id, _ = _create_ready_reader_media(
                session,
                kind=MediaKind.web_article.value,
            )

        _register_media_cleanup(direct_db, media_id)
        direct_db.register_cleanup("reading_sessions", "media_id", media_id)
        _add_media_to_user_library(auth_client, user_id, media_id)

        resp = auth_client.put(
            f"/media/{media_id}/reader-state",
            json={"attention": _attention_body(dwell_ms=5_000)},
            headers=auth_headers(user_id),
        )

        assert resp.status_code == 204
        assert resp.headers["cache-control"] == READER_STATE_NO_STORE
        assert _cursor_row(direct_db, user_id, media_id) is None
        assert _session_count(direct_db, user_id, media_id) == 1

    def test_attention_only_does_not_revise_existing_cursor(
        self, auth_client, direct_db: DirectSessionManager
    ):
        user_id = create_test_user_id()
        with direct_db.session() as session:
            media_id, fragment_ids = _create_ready_reader_media(
                session,
                kind=MediaKind.web_article.value,
            )

        _register_media_cleanup(direct_db, media_id)
        direct_db.register_cleanup("reading_sessions", "media_id", media_id)
        _add_media_to_user_library(auth_client, user_id, media_id)

        payload = _build_reader_state_payload(MediaKind.web_article.value, fragment_ids)
        auth_client.put(
            f"/media/{media_id}/reader-state",
            json=_cursor_body(payload, 0),
            headers=auth_headers(user_id),
        )
        with direct_db.session() as session:
            updated_at_before = session.execute(
                text("""
                    SELECT updated_at FROM reader_media_state
                    WHERE user_id = :user_id AND media_id = :media_id
                """),
                {"user_id": user_id, "media_id": media_id},
            ).scalar_one()

        resp = auth_client.put(
            f"/media/{media_id}/reader-state",
            json={"attention": _attention_body(dwell_ms=5_000)},
            headers=auth_headers(user_id),
        )

        assert resp.status_code == 204
        assert _cursor_row(direct_db, user_id, media_id) == (payload, 1)
        with direct_db.session() as session:
            updated_at_after = session.execute(
                text("""
                    SELECT updated_at FROM reader_media_state
                    WHERE user_id = :user_id AND media_id = :media_id
                """),
                {"user_id": user_id, "media_id": media_id},
            ).scalar_one()
        assert updated_at_after == updated_at_before

    def test_combined_write_records_cursor_and_attention(
        self, auth_client, direct_db: DirectSessionManager
    ):
        user_id = create_test_user_id()
        with direct_db.session() as session:
            media_id, fragment_ids = _create_ready_reader_media(
                session,
                kind=MediaKind.web_article.value,
            )

        _register_media_cleanup(direct_db, media_id)
        direct_db.register_cleanup("reading_sessions", "media_id", media_id)
        _add_media_to_user_library(auth_client, user_id, media_id)

        payload = _build_reader_state_payload(MediaKind.web_article.value, fragment_ids)
        resp = auth_client.put(
            f"/media/{media_id}/reader-state",
            json={
                **_cursor_body(payload, 0),
                "attention": _attention_body(dwell_ms=7_000),
            },
            headers=auth_headers(user_id),
        )

        assert resp.status_code == 200
        assert resp.json()["data"]["revision"] == 1
        assert _session_count(direct_db, user_id, media_id) == 1

    def test_combined_write_with_cursor_conflict_records_no_attention(
        self, auth_client, direct_db: DirectSessionManager
    ):
        user_id = create_test_user_id()
        with direct_db.session() as session:
            media_id, fragment_ids = _create_ready_reader_media(
                session,
                kind=MediaKind.web_article.value,
            )

        _register_media_cleanup(direct_db, media_id)
        direct_db.register_cleanup("reading_sessions", "media_id", media_id)
        _add_media_to_user_library(auth_client, user_id, media_id)

        payload_a = _build_reader_state_payload(MediaKind.web_article.value, fragment_ids)
        payload_b = {
            **payload_a,
            "locations": {**payload_a["locations"], "text_offset": 7, "position": 1},
        }
        auth_client.put(
            f"/media/{media_id}/reader-state",
            json=_cursor_body(payload_a, 0),
            headers=auth_headers(user_id),
        )

        resp = auth_client.put(
            f"/media/{media_id}/reader-state",
            json={
                **_cursor_body(payload_b, 0),
                "attention": _attention_body(dwell_ms=7_000),
            },
            headers=auth_headers(user_id),
        )

        assert resp.status_code == 409
        assert _session_count(direct_db, user_id, media_id) == 0

    def test_combined_write_returns_cursor_success_when_attention_fails(
        self, auth_client, direct_db: DirectSessionManager, engine: Engine
    ):
        user_id = create_test_user_id()
        with direct_db.session() as session:
            media_id, fragment_ids = _create_ready_reader_media(
                session,
                kind=MediaKind.web_article.value,
            )

        _register_media_cleanup(direct_db, media_id)
        direct_db.register_cleanup("reading_sessions", "media_id", media_id)
        _add_media_to_user_library(auth_client, user_id, media_id)

        payload = _build_reader_state_payload(MediaKind.web_article.value, fragment_ids)

        def fail_attention_write() -> None:
            raise RuntimeError("injected attention write failure")

        remove_hook = _one_shot_before_execute(
            engine, "INSERT INTO reading_sessions", fail_attention_write
        )
        try:
            resp = auth_client.put(
                f"/media/{media_id}/reader-state",
                json={
                    **_cursor_body(payload, 0),
                    "attention": _attention_body(dwell_ms=7_000),
                },
                headers=auth_headers(user_id),
            )
        finally:
            remove_hook()

        assert resp.status_code == 200
        assert resp.json()["data"] == {
            "state": "Positioned",
            "revision": 1,
            "locator": payload,
        }
        assert _cursor_row(direct_db, user_id, media_id) == (payload, 1)
        assert _session_count(direct_db, user_id, media_id) == 0


class TestReaderCursorConcurrency:
    """Real concurrent first inserts, updates, and delete-vs-first-save."""

    def _seed(self, auth_client, direct_db, *, kind=MediaKind.web_article.value):
        user_id = create_test_user_id()
        with direct_db.session() as session:
            media_id, fragment_ids = _create_ready_reader_media(session, kind=kind)
        _register_media_cleanup(direct_db, media_id)
        _add_media_to_user_library(auth_client, user_id, media_id)
        return user_id, media_id, fragment_ids

    def test_concurrent_first_inserts_same_locator_are_idempotent(
        self, auth_client, direct_db: DirectSessionManager, engine: Engine
    ):
        user_id, media_id, fragment_ids = self._seed(auth_client, direct_db)
        payload = _build_reader_state_payload(MediaKind.web_article.value, fragment_ids)

        def competing_insert() -> None:
            with direct_db.session() as session:
                session.execute(
                    text("""
                        INSERT INTO reader_media_state (user_id, media_id, locator, revision)
                        VALUES (:user_id, :media_id, CAST(:locator AS jsonb), 1)
                    """),
                    {
                        "user_id": user_id,
                        "media_id": media_id,
                        "locator": reader_service.READER_RESUME_STATE_ADAPTER.dump_json(
                            reader_service.READER_RESUME_STATE_ADAPTER.validate_python(payload)
                        ).decode(),
                    },
                )
                session.commit()

        remove_hook = _one_shot_before_execute(
            engine, "INSERT INTO reader_media_state", competing_insert
        )
        try:
            resp = auth_client.put(
                f"/media/{media_id}/reader-state",
                json=_cursor_body(payload, 0),
                headers=auth_headers(user_id),
            )
        finally:
            remove_hook()

        assert resp.status_code == 200
        assert resp.json()["data"] == {
            "state": "Positioned",
            "revision": 1,
            "locator": payload,
        }
        assert _cursor_row(direct_db, user_id, media_id) == (payload, 1)

    def test_concurrent_first_inserts_different_locator_conflict(
        self, auth_client, direct_db: DirectSessionManager, engine: Engine
    ):
        user_id, media_id, fragment_ids = self._seed(auth_client, direct_db)
        payload_ours = _build_reader_state_payload(MediaKind.web_article.value, fragment_ids)
        payload_winner = {
            **payload_ours,
            "locations": {**payload_ours["locations"], "text_offset": 1, "position": 1},
        }

        def competing_insert() -> None:
            with direct_db.session() as session:
                session.execute(
                    text("""
                        INSERT INTO reader_media_state (user_id, media_id, locator, revision)
                        VALUES (:user_id, :media_id, CAST(:locator AS jsonb), 1)
                    """),
                    {
                        "user_id": user_id,
                        "media_id": media_id,
                        "locator": reader_service.READER_RESUME_STATE_ADAPTER.dump_json(
                            reader_service.READER_RESUME_STATE_ADAPTER.validate_python(
                                payload_winner
                            )
                        ).decode(),
                    },
                )
                session.commit()

        remove_hook = _one_shot_before_execute(
            engine, "INSERT INTO reader_media_state", competing_insert
        )
        try:
            resp = auth_client.put(
                f"/media/{media_id}/reader-state",
                json=_cursor_body(payload_ours, 0),
                headers=auth_headers(user_id),
            )
        finally:
            remove_hook()

        assert resp.status_code == 409
        assert resp.json()["error"]["details"]["current"] == {
            "state": "Positioned",
            "revision": 1,
            "locator": payload_winner,
        }
        assert _cursor_row(direct_db, user_id, media_id) == (payload_winner, 1)

    def test_concurrent_update_yields_one_accepted_and_one_conflict(
        self, auth_client, direct_db: DirectSessionManager, engine: Engine
    ):
        user_id, media_id, fragment_ids = self._seed(auth_client, direct_db)
        payload_a = _build_reader_state_payload(MediaKind.web_article.value, fragment_ids)
        payload_b = {
            **payload_a,
            "locations": {**payload_a["locations"], "text_offset": 11, "position": 1},
        }
        payload_c = {
            **payload_a,
            "locations": {**payload_a["locations"], "text_offset": 22, "position": 2},
        }
        seeded = auth_client.put(
            f"/media/{media_id}/reader-state",
            json=_cursor_body(payload_a, 0),
            headers=auth_headers(user_id),
        )
        assert seeded.status_code == 200

        def competing_update() -> None:
            with direct_db.session() as session:
                session.execute(
                    text("""
                        UPDATE reader_media_state
                        SET locator = CAST(:locator AS jsonb),
                            revision = revision + 1,
                            updated_at = now()
                        WHERE user_id = :user_id AND media_id = :media_id
                    """),
                    {
                        "user_id": user_id,
                        "media_id": media_id,
                        "locator": reader_service.READER_RESUME_STATE_ADAPTER.dump_json(
                            reader_service.READER_RESUME_STATE_ADAPTER.validate_python(payload_c)
                        ).decode(),
                    },
                )
                session.commit()

        remove_hook = _one_shot_before_execute(
            engine, "UPDATE reader_media_state", competing_update
        )
        try:
            resp = auth_client.put(
                f"/media/{media_id}/reader-state",
                json=_cursor_body(payload_b, 1),
                headers=auth_headers(user_id),
            )
        finally:
            remove_hook()

        assert resp.status_code == 409
        assert resp.json()["error"]["details"]["current"] == {
            "state": "Positioned",
            "revision": 2,
            "locator": payload_c,
        }
        assert _cursor_row(direct_db, user_id, media_id) == (payload_c, 2)

    def test_delete_racing_first_save_returns_masked_404(
        self, auth_client, direct_db: DirectSessionManager, engine: Engine
    ):
        user_id, media_id, fragment_ids = self._seed(auth_client, direct_db)
        payload = _build_reader_state_payload(MediaKind.web_article.value, fragment_ids)

        def competing_media_delete() -> None:
            with direct_db.session() as session:
                for table in ("library_entries", "fragments"):
                    session.execute(
                        text(f"DELETE FROM {table} WHERE media_id = :media_id"),  # noqa: S608
                        {"media_id": media_id},
                    )
                session.execute(
                    text("DELETE FROM media WHERE id = :media_id"),
                    {"media_id": media_id},
                )
                session.commit()

        remove_hook = _one_shot_before_execute(
            engine, "INSERT INTO reader_media_state", competing_media_delete
        )
        try:
            resp = auth_client.put(
                f"/media/{media_id}/reader-state",
                json=_cursor_body(payload, 0),
                headers=auth_headers(user_id),
            )
        finally:
            remove_hook()

        assert resp.status_code == 404
        assert resp.json()["error"]["code"] == "E_MEDIA_NOT_FOUND"
        assert _cursor_row(direct_db, user_id, media_id) is None

    def test_unique_race_normalization_at_read_committed_isolation(
        self, auth_client, direct_db: DirectSessionManager, engine: Engine
    ):
        """Exercise the named-constraint IntegrityError branch directly: with an
        outer transaction already open the serializable upgrade is skipped, so
        the racing insert surfaces as the unique violation itself."""
        user_id, media_id, fragment_ids = self._seed(auth_client, direct_db)
        payload = _build_reader_state_payload(MediaKind.web_article.value, fragment_ids)
        locator = reader_service.READER_RESUME_STATE_ADAPTER.validate_python(payload)
        payload_winner = {
            **payload,
            "locations": {**payload["locations"], "text_offset": 1, "position": 1},
        }

        def competing_insert() -> None:
            with direct_db.session() as session:
                session.execute(
                    text("""
                        INSERT INTO reader_media_state (user_id, media_id, locator, revision)
                        VALUES (:user_id, :media_id, CAST(:locator AS jsonb), 1)
                    """),
                    {
                        "user_id": user_id,
                        "media_id": media_id,
                        "locator": reader_service.READER_RESUME_STATE_ADAPTER.dump_json(
                            reader_service.READER_RESUME_STATE_ADAPTER.validate_python(
                                payload_winner
                            )
                        ).decode(),
                    },
                )
                session.commit()

        remove_hook = _one_shot_before_execute(
            engine, "INSERT INTO reader_media_state", competing_insert
        )
        try:
            with direct_db.session() as session:
                # Open the transaction first so retry_serializable cannot
                # upgrade isolation; the INSERT then raises the unique
                # violation that production normalizes by constraint name.
                session.execute(text("SELECT 1"))
                with pytest.raises(ConflictError) as excinfo:
                    reader_service.put_reader_cursor(
                        session,
                        user_id,
                        media_id,
                        CursorWrite(locator=locator, base_revision=0),
                    )
        finally:
            remove_hook()

        assert excinfo.value.code == ApiErrorCode.E_READER_STATE_CONFLICT
        assert excinfo.value.details["current"]["revision"] == 1
        assert excinfo.value.details["current"]["locator"] == payload_winner

    def test_media_fk_race_normalization_at_read_committed_isolation(
        self, auth_client, direct_db: DirectSessionManager, engine: Engine
    ):
        user_id, media_id, fragment_ids = self._seed(auth_client, direct_db)
        payload = _build_reader_state_payload(MediaKind.web_article.value, fragment_ids)
        locator = reader_service.READER_RESUME_STATE_ADAPTER.validate_python(payload)

        def competing_media_delete() -> None:
            with direct_db.session() as session:
                for table in ("library_entries", "fragments"):
                    session.execute(
                        text(f"DELETE FROM {table} WHERE media_id = :media_id"),  # noqa: S608
                        {"media_id": media_id},
                    )
                session.execute(
                    text("DELETE FROM media WHERE id = :media_id"),
                    {"media_id": media_id},
                )
                session.commit()

        remove_hook = _one_shot_before_execute(
            engine, "INSERT INTO reader_media_state", competing_media_delete
        )
        try:
            with direct_db.session() as session:
                session.execute(text("SELECT 1"))
                with pytest.raises(NotFoundError) as excinfo:
                    reader_service.put_reader_cursor(
                        session,
                        user_id,
                        media_id,
                        CursorWrite(locator=locator, base_revision=0),
                    )
        finally:
            remove_hook()

        assert excinfo.value.code == ApiErrorCode.E_MEDIA_NOT_FOUND
