import threading
from uuid import UUID, uuid4

import pytest
from sqlalchemy import text

from nexus.db.models import Fragment, Media, MediaKind, ProcessingStatus
from nexus.errors import ApiError, ApiErrorCode
from nexus.services.bootstrap import ensure_user_and_default_library
from nexus.services.media_deletion import delete_document_media_if_unreferenced
from nexus.services.reader_apparatus import (
    get_media_apparatus,
    replace_media_apparatus,
    source_fingerprint,
)
from tests.factories import add_media_to_library
from tests.helpers import auth_headers, create_test_user_id
from tests.utils.db import DirectSessionManager

pytestmark = pytest.mark.integration


def _add_media_to_default_library(
    auth_client, direct_db: DirectSessionManager, user_id: UUID, media_id: UUID
) -> None:
    """Seed a direct default-library entry for `media_id`.

    Production ingest always auto-files new media into the creator's default
    library (`ensure_media_in_default_library`), so freshly created media is
    always reachable there. Fixtures that create a bare `media` row must
    mirror that by seeding the physical entry directly rather than going
    through the authorization-gated `POST /libraries/{id}/media` filing
    endpoint, which requires the media to already be reachable.
    """
    me = auth_client.get("/me", headers=auth_headers(user_id))
    library_id = UUID(me.json()["data"]["default_library_id"])
    with direct_db.session() as session:
        add_media_to_library(session, library_id, media_id)
        session.commit()


def _get_apparatus_data(direct_db: DirectSessionManager, user_id: UUID, media_id: UUID):
    with direct_db.session() as session:
        return get_media_apparatus(session, user_id, media_id).model_dump(mode="json")


def _create_media(session, *, kind: str = MediaKind.web_article.value) -> tuple[UUID, UUID]:
    media = Media(
        id=uuid4(),
        kind=kind,
        title="Reader apparatus test",
        processing_status=ProcessingStatus.ready_for_reading,
    )
    session.add(media)
    session.flush()
    fragment = Fragment(
        id=uuid4(),
        media_id=media.id,
        idx=0,
        html_sanitized='<p>Claim<a data-reader-apparatus-item-id="m1">1</a></p>',
        canonical_text="Claim1\n1. Source note.",
    )
    session.add(fragment)
    session.commit()
    return media.id, fragment.id


def _apparatus_item(
    media_id: UUID,
    fragment_id: UUID,
    *,
    stable_key: str = "marker",
    kind: str = "footnote_ref",
    locator: dict[str, object] | None = None,
    locator_status: str | None = None,
) -> dict[str, object]:
    return {
        "stable_key": stable_key,
        "kind": kind,
        "label": "1",
        "body_text": None if kind.endswith("_ref") else "1. Source note.",
        "body_html_sanitized": None,
        "locator": locator
        if locator is not None
        else {
            "type": "web_text_offsets",
            "media_id": str(media_id),
            "fragment_id": str(fragment_id),
            "start_offset": 5,
            "end_offset": 6,
            "media_kind": "web_article",
            "text_quote_selector": {"exact": "1"},
        },
        "locator_status": locator_status or ("exact" if locator is not None else "exact"),
        "confidence": "exact",
        "extraction_method": "html_semantic",
        "source_ref": {"format": "html", "target_id": "fn1"},
        "sort_key": f"000000.{stable_key}",
    }


def _register_cleanup(direct_db: DirectSessionManager, media_id: UUID) -> None:
    direct_db.register_cleanup("media", "id", media_id)
    direct_db.register_cleanup("library_entries", "media_id", media_id)
    direct_db.register_cleanup("fragments", "media_id", media_id)
    direct_db.register_cleanup("reader_apparatus_states", "media_id", media_id)
    direct_db.register_cleanup("reader_apparatus_items", "media_id", media_id)
    direct_db.register_cleanup("reader_apparatus_edges", "media_id", media_id)


def test_get_reader_apparatus_returns_source_authored_items(auth_client, direct_db):
    user_id = create_test_user_id()
    with direct_db.session() as session:
        media_id, fragment_id = _create_media(session)
        replace_media_apparatus(
            session,
            media_id=media_id,
            media_kind="web_article",
            source_fingerprint_value=source_fingerprint("test", media_id),
            items=[
                {
                    "stable_key": "target",
                    "kind": "footnote",
                    "label": "1.",
                    "body_text": "1. Source note.",
                    "body_html_sanitized": None,
                    "locator": {
                        "type": "web_text_offsets",
                        "media_id": str(media_id),
                        "fragment_id": str(fragment_id),
                        "start_offset": 7,
                        "end_offset": 22,
                        "media_kind": "web_article",
                        "text_quote_selector": {"exact": "1. Source note."},
                    },
                    "confidence": "exact",
                    "extraction_method": "html_semantic",
                    "source_ref": {"format": "html", "target_id": "fn1"},
                    "sort_key": "000000.target",
                },
                {
                    "stable_key": "marker",
                    "kind": "footnote_ref",
                    "label": "1",
                    "body_text": None,
                    "body_html_sanitized": None,
                    "locator": {
                        "type": "web_text_offsets",
                        "media_id": str(media_id),
                        "fragment_id": str(fragment_id),
                        "start_offset": 5,
                        "end_offset": 6,
                        "media_kind": "web_article",
                        "text_quote_selector": {"exact": "1"},
                    },
                    "confidence": "exact",
                    "extraction_method": "html_semantic",
                    "source_ref": {"format": "html", "target_id": "fn1"},
                    "sort_key": "000000.marker",
                },
            ],
            edges=[
                {
                    "stable_key": "marker->target",
                    "from_stable_key": "marker",
                    "to_stable_key": "target",
                    "relation": "points_to_note",
                    "confidence": "exact",
                    "extraction_method": "html_semantic",
                    "source_ref": {"format": "html", "target_id": "fn1"},
                    "sort_key": "000000.edge",
                }
            ],
        )
        session.commit()

    _register_cleanup(direct_db, media_id)
    _add_media_to_default_library(auth_client, direct_db, user_id, media_id)

    data = _get_apparatus_data(direct_db, user_id, media_id)
    assert data["status"] == "ready"
    assert data["capabilities"]["has_inline_markers"] is True
    assert [item["kind"] for item in data["items"]] == ["footnote_ref", "footnote"]
    assert [item["stable_key"] for item in data["items"]] == ["marker", "target"]
    for item in data["items"]:
        UUID(item["id"])
        assert item["resource_ref"] == f"reader_apparatus_item:{item['id']}"
    assert data["edges"][0]["relation"] == "points_to_note"
    assert data["edges"][0]["from_stable_key"] == "marker"
    assert data["edges"][0]["to_stable_key"] == "target"
    assert "id" not in data["edges"][0]
    assert "from_item_id" not in data["edges"][0]


def test_get_reader_apparatus_returns_sidenotes_and_target_only_margin_notes(
    auth_client,
    direct_db,
):
    user_id = create_test_user_id()
    with direct_db.session() as session:
        media_id, fragment_id = _create_media(session)
        replace_media_apparatus(
            session,
            media_id=media_id,
            media_kind="web_article",
            source_fingerprint_value=source_fingerprint("test-sidenote", media_id),
            items=[
                _apparatus_item(
                    media_id,
                    fragment_id,
                    stable_key="sidenote-target",
                    kind="sidenote",
                ),
                _apparatus_item(
                    media_id,
                    fragment_id,
                    stable_key="sidenote-marker",
                    kind="sidenote_ref",
                ),
                _apparatus_item(
                    media_id,
                    fragment_id,
                    stable_key="margin-target",
                    kind="margin_note",
                ),
                _apparatus_item(
                    media_id,
                    fragment_id,
                    stable_key="margin-marker",
                    kind="margin_note_ref",
                ),
                _apparatus_item(
                    media_id,
                    fragment_id,
                    stable_key="standalone-margin",
                    kind="margin_note",
                ),
            ],
            edges=[
                {
                    "stable_key": "sidenote-marker->sidenote-target",
                    "from_stable_key": "sidenote-marker",
                    "to_stable_key": "sidenote-target",
                    "relation": "points_to_sidenote",
                    "confidence": "strong",
                    "extraction_method": "tufte_sidenote",
                    "source_ref": {"format": "html", "toggle_id": "sn1"},
                    "sort_key": "000000.edge.sidenote",
                },
                {
                    "stable_key": "margin-marker->margin-target",
                    "from_stable_key": "margin-marker",
                    "to_stable_key": "margin-target",
                    "relation": "points_to_margin_note",
                    "confidence": "strong",
                    "extraction_method": "tufte_margin_note",
                    "source_ref": {"format": "html", "toggle_id": "mn1"},
                    "sort_key": "000000.edge.margin",
                },
            ],
        )
        session.commit()

    _register_cleanup(direct_db, media_id)
    _add_media_to_default_library(auth_client, direct_db, user_id, media_id)

    data = _get_apparatus_data(direct_db, user_id, media_id)
    assert data["status"] == "ready"
    assert {item["kind"] for item in data["items"]} == {
        "sidenote",
        "sidenote_ref",
        "margin_note",
        "margin_note_ref",
    }
    assert {edge["relation"] for edge in data["edges"]} == {
        "points_to_sidenote",
        "points_to_margin_note",
    }
    assert data["capabilities"]["has_sidecar_items"] is True
    assert data["capabilities"]["supports_jump_to_target"] is True


def test_get_reader_apparatus_missing_state_fails_loudly(auth_client, direct_db):
    user_id = create_test_user_id()
    with direct_db.session() as session:
        media_id, _fragment_id = _create_media(session)

    _register_cleanup(direct_db, media_id)
    _add_media_to_default_library(auth_client, direct_db, user_id, media_id)

    with pytest.raises(ApiError) as exc:
        _get_apparatus_data(direct_db, user_id, media_id)
    assert exc.value.code == ApiErrorCode.E_READER_APPARATUS_STATE_MISSING


def test_concurrent_initial_replacements_linearize_on_the_media_row(
    direct_db: DirectSessionManager,
) -> None:
    with direct_db.session() as session:
        media_id, fragment_id = _create_media(session)
    _register_cleanup(direct_db, media_id)

    barrier = threading.Barrier(2)
    errors: list[BaseException] = []
    errors_lock = threading.Lock()

    def replace_once(label: str) -> None:
        try:
            with direct_db.session() as session:
                item = _apparatus_item(media_id, fragment_id)
                item["label"] = label
                barrier.wait(timeout=10)
                replace_media_apparatus(
                    session,
                    media_id=media_id,
                    media_kind="web_article",
                    source_fingerprint_value=source_fingerprint("concurrent-initial", label),
                    items=[item],
                    edges=[],
                )
                session.commit()
        except BaseException as exc:  # pragma: no cover - asserted by the parent thread
            with errors_lock:
                errors.append(exc)

    threads = [
        threading.Thread(target=replace_once, args=(label,), daemon=True)
        for label in ("First", "Second")
    ]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=20)

    assert all(not thread.is_alive() for thread in threads)
    assert errors == []
    with direct_db.session() as session:
        assert (
            session.scalar(
                text("SELECT count(*) FROM reader_apparatus_states WHERE media_id = :media_id"),
                {"media_id": media_id},
            )
            == 1
        )
        assert (
            session.scalar(
                text("SELECT count(*) FROM reader_apparatus_items WHERE media_id = :media_id"),
                {"media_id": media_id},
            )
            == 1
        )
        assert session.scalar(
            text("SELECT label FROM reader_apparatus_items WHERE media_id = :media_id"),
            {"media_id": media_id},
        ) in {"First", "Second"}


def test_apparatus_read_holds_one_generation_against_concurrent_replacement(
    direct_db: DirectSessionManager,
) -> None:
    user_id = create_test_user_id()
    with direct_db.session() as session:
        library_id = ensure_user_and_default_library(session, user_id)
        media_id, fragment_id = _create_media(session)
        add_media_to_library(session, library_id, media_id)
        replace_media_apparatus(
            session,
            media_id=media_id,
            media_kind="web_article",
            source_fingerprint_value=source_fingerprint("read-generation", "before"),
            items=[_apparatus_item(media_id, fragment_id)],
            edges=[],
        )
        session.commit()
    _register_cleanup(direct_db, media_id)

    read_locked = threading.Event()
    release_read = threading.Event()
    writer_started = threading.Event()
    writer_finished = threading.Event()
    errors: list[BaseException] = []
    errors_lock = threading.Lock()

    def read_generation() -> None:
        try:
            with direct_db.session() as session:
                result = get_media_apparatus(session, user_id, media_id)
                assert result.items[0].label == "1"
                read_locked.set()
                assert release_read.wait(timeout=10)
                session.commit()
        except BaseException as exc:  # pragma: no cover - asserted by parent thread
            with errors_lock:
                errors.append(exc)
            read_locked.set()

    def replace_generation() -> None:
        try:
            assert read_locked.wait(timeout=10)
            with direct_db.session() as session:
                replacement = _apparatus_item(media_id, fragment_id)
                replacement["label"] = "2"
                writer_started.set()
                replace_media_apparatus(
                    session,
                    media_id=media_id,
                    media_kind="web_article",
                    source_fingerprint_value=source_fingerprint("read-generation", "after"),
                    items=[replacement],
                    edges=[],
                )
                session.commit()
                writer_finished.set()
        except BaseException as exc:  # pragma: no cover - asserted by parent thread
            with errors_lock:
                errors.append(exc)
            writer_finished.set()

    reader = threading.Thread(target=read_generation, daemon=True)
    writer = threading.Thread(target=replace_generation, daemon=True)
    reader.start()
    writer.start()
    assert writer_started.wait(timeout=10)
    assert not writer_finished.wait(timeout=0.25)
    release_read.set()
    reader.join(timeout=10)
    writer.join(timeout=10)

    assert not reader.is_alive()
    assert not writer.is_alive()
    assert errors == []
    with direct_db.session() as session:
        result = get_media_apparatus(session, user_id, media_id)
        assert result.items[0].label == "2"


def test_get_reader_apparatus_returns_empty_failed_and_unsupported_states(auth_client, direct_db):
    user_id = create_test_user_id()
    seen_statuses: list[str] = []
    for status in ("empty", "failed"):
        with direct_db.session() as session:
            media_id, _fragment_id = _create_media(session)
            replace_media_apparatus(
                session,
                media_id=media_id,
                media_kind="web_article",
                source_fingerprint_value=source_fingerprint("test", media_id, status),
                items=[],
                edges=[],
                status=status,
            )
            session.commit()

        _register_cleanup(direct_db, media_id)
        _add_media_to_default_library(auth_client, direct_db, user_id, media_id)
        data = _get_apparatus_data(direct_db, user_id, media_id)
        seen_statuses.append(data["status"])
        assert data["items"] == []
        assert data["edges"] == []

    with direct_db.session() as session:
        media_id, _fragment_id = _create_media(session, kind=MediaKind.video.value)
        session.commit()

    _register_cleanup(direct_db, media_id)
    _add_media_to_default_library(auth_client, direct_db, user_id, media_id)
    data = _get_apparatus_data(direct_db, user_id, media_id)
    seen_statuses.append(data["status"])
    assert data["items"] == []
    assert data["edges"] == []
    assert seen_statuses == ["empty", "failed", "unsupported"]


def test_get_reader_apparatus_returns_partial_state_with_valid_rows(auth_client, direct_db):
    user_id = create_test_user_id()
    with direct_db.session() as session:
        media_id, fragment_id = _create_media(session)
        item = _apparatus_item(media_id, fragment_id, stable_key="probable-marker")
        item["confidence"] = "probable"
        item["locator"] = None
        item["locator_status"] = "missing"
        replace_media_apparatus(
            session,
            media_id=media_id,
            media_kind="web_article",
            source_fingerprint_value=source_fingerprint("test", media_id, "partial"),
            items=[item],
            edges=[],
            status="partial",
            diagnostics={"missing_targets": ["fn1"]},
        )
        session.commit()

    _register_cleanup(direct_db, media_id)
    _add_media_to_default_library(auth_client, direct_db, user_id, media_id)

    data = _get_apparatus_data(direct_db, user_id, media_id)
    assert data["status"] == "partial"
    assert data["diagnostics"] == {"missing_targets": ["fn1"]}
    assert [item["stable_key"] for item in data["items"]] == ["probable-marker"]
    assert data["items"][0]["confidence"] == "probable"
    assert data["items"][0]["locator"] is None
    assert data["edges"] == []
    assert data["capabilities"]["has_sidecar_items"] is True
    assert data["capabilities"]["has_probable_items"] is True
    assert data["capabilities"]["supports_hover_preview"] is False


def test_get_reader_apparatus_masks_invisible_media(auth_client, direct_db):
    owner_id = create_test_user_id()
    outsider_id = create_test_user_id()
    auth_client.get("/me", headers=auth_headers(owner_id))
    auth_client.get("/me", headers=auth_headers(outsider_id))
    with direct_db.session() as session:
        media_id, _fragment_id = _create_media(session)
        replace_media_apparatus(
            session,
            media_id=media_id,
            media_kind="web_article",
            source_fingerprint_value=source_fingerprint("test", media_id, "empty"),
            items=[],
            edges=[],
            status="empty",
        )
        session.commit()

    _register_cleanup(direct_db, media_id)
    _add_media_to_default_library(auth_client, direct_db, owner_id, media_id)

    with pytest.raises(ApiError) as exc:
        _get_apparatus_data(direct_db, outsider_id, media_id)
    assert exc.value.code == ApiErrorCode.E_MEDIA_NOT_FOUND


def test_replace_reader_apparatus_replaces_rows_and_rejects_invalid_empty_state(direct_db):
    with direct_db.session() as session:
        media_id, fragment_id = _create_media(session)
        replace_media_apparatus(
            session,
            media_id=media_id,
            media_kind="web_article",
            source_fingerprint_value=source_fingerprint("test", media_id, "ready"),
            items=[
                _apparatus_item(media_id, fragment_id, stable_key="target", kind="footnote"),
                _apparatus_item(media_id, fragment_id, stable_key="marker"),
            ],
            edges=[
                {
                    "stable_key": "marker->target",
                    "from_stable_key": "marker",
                    "to_stable_key": "target",
                    "relation": "points_to_note",
                    "confidence": "exact",
                    "extraction_method": "html_semantic",
                    "source_ref": {"format": "html"},
                    "sort_key": "000000.edge",
                }
            ],
        )
        state_id = session.execute(
            text("SELECT id FROM reader_apparatus_states WHERE media_id = :id"),
            {"id": media_id},
        ).scalar_one()

        with pytest.raises(ApiError):
            replace_media_apparatus(
                session,
                media_id=media_id,
                media_kind="web_article",
                source_fingerprint_value=source_fingerprint("test", media_id, "bad-empty"),
                items=[_apparatus_item(media_id, fragment_id, stable_key="bad")],
                edges=[],
                status="empty",
            )

        assert (
            session.execute(
                text("SELECT id FROM reader_apparatus_states WHERE media_id = :id"),
                {"id": media_id},
            ).scalar_one()
            == state_id
        )

        replace_media_apparatus(
            session,
            media_id=media_id,
            media_kind="web_article",
            source_fingerprint_value=source_fingerprint("test", media_id, "empty"),
            items=[],
            edges=[],
            status="empty",
        )
        assert (
            session.execute(
                text("SELECT count(*) FROM reader_apparatus_items WHERE media_id = :id"),
                {"id": media_id},
            ).scalar_one()
            == 0
        )
        assert (
            session.execute(
                text("SELECT status FROM reader_apparatus_states WHERE media_id = :id"),
                {"id": media_id},
            ).scalar_one()
            == "empty"
        )
        session.commit()

    _register_cleanup(direct_db, media_id)


def test_replace_reader_apparatus_preserves_surviving_ids_and_graph_edges(direct_db):
    user_id = create_test_user_id()
    with direct_db.session() as session:
        session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
        media_id, fragment_id = _create_media(session)
        initial_items = [
            _apparatus_item(media_id, fragment_id, stable_key="marker"),
            _apparatus_item(media_id, fragment_id, stable_key="target", kind="footnote"),
        ]
        initial_edge = {
            "stable_key": "marker->target",
            "from_stable_key": "marker",
            "to_stable_key": "target",
            "relation": "points_to_note",
            "confidence": "exact",
            "extraction_method": "html_semantic",
            "source_ref": {"format": "html"},
            "sort_key": "000000.edge",
        }
        replace_media_apparatus(
            session,
            media_id=media_id,
            media_kind="web_article",
            source_fingerprint_value=source_fingerprint("initial", media_id),
            items=initial_items,
            edges=[initial_edge],
        )
        ids = dict(
            session.execute(
                text("SELECT stable_key, id FROM reader_apparatus_items WHERE media_id = :id"),
                {"id": media_id},
            ).all()
        )
        graph_edge_id = session.execute(
            text(
                """
                INSERT INTO resource_edges (
                    user_id, kind, origin, source_scheme, source_id,
                    target_scheme, target_id
                )
                VALUES (
                    :user_id, 'context', 'user', 'media', :media_id,
                    'reader_apparatus_item', :target_id
                )
                RETURNING id
                """
            ),
            {
                "user_id": user_id,
                "media_id": media_id,
                "target_id": ids["target"],
            },
        ).scalar_one()

        refreshed_items = [dict(item) for item in initial_items]
        refreshed_items[1]["body_text"] = "Updated source note."
        replace_media_apparatus(
            session,
            media_id=media_id,
            media_kind="web_article",
            source_fingerprint_value=source_fingerprint("refresh", media_id),
            items=refreshed_items,
            edges=[initial_edge],
        )
        refreshed_ids = dict(
            session.execute(
                text("SELECT stable_key, id FROM reader_apparatus_items WHERE media_id = :id"),
                {"id": media_id},
            ).all()
        )
        assert refreshed_ids == ids
        assert (
            session.scalar(
                text("SELECT count(*) FROM resource_edges WHERE id = :id"),
                {"id": graph_edge_id},
            )
            == 1
        )

        replace_media_apparatus(
            session,
            media_id=media_id,
            media_kind="web_article",
            source_fingerprint_value=source_fingerprint("remove-target", media_id),
            items=[initial_items[0]],
            edges=[],
        )
        assert (
            session.scalar(
                text(
                    "SELECT id FROM reader_apparatus_items "
                    "WHERE media_id = :id AND stable_key = 'marker'"
                ),
                {"id": media_id},
            )
            == ids["marker"]
        )
        assert (
            session.scalar(
                text("SELECT count(*) FROM resource_edges WHERE id = :id"),
                {"id": graph_edge_id},
            )
            == 0
        )
        session.commit()

    _register_cleanup(direct_db, media_id)
    direct_db.register_cleanup("resource_edges", "user_id", user_id)
    direct_db.register_cleanup("users", "id", user_id)


@pytest.mark.parametrize("media_kind", ["web_article", "pdf", "epub"])
def test_refresh_cleanup_preserves_apparatus_for_stable_key_reconciliation(
    direct_db, media_kind: str
):
    user_id = create_test_user_id()
    with direct_db.session() as session:
        session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
        media_id, fragment_id = _create_media(session, kind=media_kind)
        item = _apparatus_item(media_id, fragment_id, stable_key="survivor")
        item["locator"] = None
        item["locator_status"] = "missing"
        replace_media_apparatus(
            session,
            media_id=media_id,
            media_kind=media_kind,
            source_fingerprint_value=source_fingerprint("before-refresh", media_id),
            items=[item],
            edges=[],
        )
        item_id = session.scalar(
            text(
                "SELECT id FROM reader_apparatus_items "
                "WHERE media_id = :id AND stable_key = 'survivor'"
            ),
            {"id": media_id},
        )

        if media_kind == "web_article":
            from nexus.services.web_article_artifacts import delete_web_article_artifacts

            delete_web_article_artifacts(
                session,
                owner_user_id=user_id,
                media_id=media_id,
                include_content_index=False,
            )
        elif media_kind == "pdf":
            from nexus.services.pdf_ingest import delete_pdf_text_artifacts

            delete_pdf_text_artifacts(session, media_id)
        else:
            from nexus.services.epub_lifecycle import delete_extraction_artifacts

            delete_extraction_artifacts(session, media_id)

        assert (
            session.scalar(
                text("SELECT id FROM reader_apparatus_items WHERE id = :id"),
                {"id": item_id},
            )
            == item_id
        )
        assert (
            session.scalar(
                text("SELECT count(*) FROM reader_apparatus_states WHERE media_id = :id"),
                {"id": media_id},
            )
            == 1
        )
        session.commit()

    _register_cleanup(direct_db, media_id)
    direct_db.register_cleanup("users", "id", user_id)


def test_reader_apparatus_missing_locator_persists_as_sql_null(direct_db):
    with direct_db.session() as session:
        media_id, fragment_id = _create_media(session)
        missing_locator_item = _apparatus_item(
            media_id,
            fragment_id,
            stable_key="target",
            kind="footnote",
        )
        missing_locator_item["locator"] = None
        missing_locator_item["locator_status"] = "missing"
        replace_media_apparatus(
            session,
            media_id=media_id,
            media_kind="web_article",
            source_fingerprint_value=source_fingerprint("test", media_id, "null-locator"),
            items=[missing_locator_item],
            edges=[],
        )
        assert (
            session.execute(
                text("SELECT locator IS NULL FROM reader_apparatus_items WHERE media_id = :id"),
                {"id": media_id},
            ).scalar_one()
            is True
        )
        session.commit()

    _register_cleanup(direct_db, media_id)


def test_delete_media_apparatus_removes_child_rows(direct_db):
    with direct_db.session() as session:
        media_id, fragment_id = _create_media(session)
        replace_media_apparatus(
            session,
            media_id=media_id,
            media_kind="web_article",
            source_fingerprint_value=source_fingerprint("test", media_id, "delete"),
            items=[
                {
                    "stable_key": "target",
                    "kind": "footnote",
                    "label": "1.",
                    "body_text": "1. Source note.",
                    "body_html_sanitized": None,
                    "locator": None,
                    "locator_status": "missing",
                    "confidence": "exact",
                    "extraction_method": "html_semantic",
                    "source_ref": {"format": "html"},
                    "sort_key": "000000.target",
                },
                _apparatus_item(media_id, fragment_id, stable_key="marker"),
            ],
            edges=[
                {
                    "stable_key": "marker->target",
                    "from_stable_key": "marker",
                    "to_stable_key": "target",
                    "relation": "points_to_note",
                    "confidence": "exact",
                    "extraction_method": "html_semantic",
                    "source_ref": {"format": "html"},
                    "sort_key": "000000.edge",
                }
            ],
        )
        assert delete_document_media_if_unreferenced(session, media_id) == []
        session.commit()

    with direct_db.session() as session:
        assert (
            session.execute(
                text("SELECT count(*) FROM reader_apparatus_states WHERE media_id = :id"),
                {"id": media_id},
            ).scalar()
            == 0
        )
        assert (
            session.execute(
                text("SELECT count(*) FROM reader_apparatus_items WHERE media_id = :id"),
                {"id": media_id},
            ).scalar()
            == 0
        )
        assert (
            session.execute(
                text("SELECT count(*) FROM reader_apparatus_edges WHERE media_id = :id"),
                {"id": media_id},
            ).scalar()
            == 0
        )
