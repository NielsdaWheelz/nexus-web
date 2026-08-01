"""Focused canonical-position contracts for Reader navigation."""

from uuid import UUID

import pytest
from sqlalchemy import text

from tests.factories import add_media_to_library, create_ready_epub_with_chapters
from tests.helpers import auth_headers, create_test_user_id
from tests.utils.db import DirectSessionManager

pytestmark = pytest.mark.integration


def test_epub_navigation_counts_one_fragment_and_locates_each_named_anchor(
    auth_client,
    direct_db: DirectSessionManager,
) -> None:
    user_id = create_test_user_id()
    me = auth_client.get("/me", headers=auth_headers(user_id))
    library_id = UUID(me.json()["data"]["default_library_id"])
    html = '<p id="opening">Opening line.</p><h2 id="second">Second heading</h2><p>Closing.</p>'
    canonical_text = "Opening line.\nSecond heading\nClosing."

    with direct_db.session() as session:
        media_id, fragment_ids = create_ready_epub_with_chapters(
            session,
            num_chapters=1,
            with_toc=False,
        )
        session.execute(
            text(
                """
                UPDATE fragments
                SET html_sanitized = :html_sanitized,
                    canonical_text = :canonical_text
                WHERE media_id = :media_id AND idx = 0
                """
            ),
            {
                "media_id": media_id,
                "html_sanitized": html,
                "canonical_text": canonical_text,
            },
        )
        session.execute(
            text(
                """
                UPDATE epub_nav_locations
                SET end_offset = :end_offset
                WHERE media_id = :media_id AND fragment_idx = 0
                """
            ),
            {"media_id": media_id, "end_offset": 14},
        )
        session.execute(
            text(
                """
                INSERT INTO epub_nav_locations (
                    media_id, location_id, ordinal, source_node_id, label,
                    fragment_idx, href_path, href_fragment,
                    start_offset, end_offset, source
                )
                VALUES (
                    :media_id, 'chapter.xhtml#second', 1, NULL, 'Second heading',
                    0, 'chapter.xhtml', 'second', 14, 37, 'toc'
                )
                """
            ),
            {"media_id": media_id},
        )
        add_media_to_library(session, library_id, media_id)
        session.commit()

    direct_db.register_cleanup("epub_nav_locations", "media_id", media_id)
    direct_db.register_cleanup("content_blocks", "owner_id", media_id)
    direct_db.register_cleanup("content_index_states", "owner_id", media_id)
    direct_db.register_cleanup("fragment_blocks", "fragment_id", fragment_ids[0])
    direct_db.register_cleanup("fragments", "media_id", media_id)
    direct_db.register_cleanup("library_entries", "media_id", media_id)
    direct_db.register_cleanup("media", "id", media_id)

    response = auth_client.get(
        f"/media/{media_id}/navigation",
        headers=auth_headers(user_id),
    )

    assert response.status_code == 200, response.text
    navigation = response.json()["data"]
    assert navigation["fragments"] == [
        {
            "fragment_id": str(fragment_ids[0]),
            "fragment_idx": 0,
            "char_count": 37,
        }
    ]
    assert [
        (section["start_offset"], section["end_offset"]) for section in navigation["sections"]
    ] == [(0, 14), (14, 37)]
    assert all("char_count" not in section for section in navigation["sections"])


def test_epub_section_end_uses_the_next_same_fragment_anchor_across_interleaved_rows(
    auth_client,
    direct_db: DirectSessionManager,
) -> None:
    user_id = create_test_user_id()
    me = auth_client.get("/me", headers=auth_headers(user_id))
    library_id = UUID(me.json()["data"]["default_library_id"])
    canonical_text = "Opening line.\nSecond heading\nClosing."

    with direct_db.session() as session:
        media_id, fragment_ids = create_ready_epub_with_chapters(
            session,
            num_chapters=2,
            with_toc=False,
        )
        session.execute(
            text(
                """
                UPDATE fragments
                SET html_sanitized = :html_sanitized,
                    canonical_text = :canonical_text
                WHERE media_id = :media_id AND idx = 0
                """
            ),
            {
                "media_id": media_id,
                "html_sanitized": (
                    '<p id="opening">Opening line.</p>'
                    '<h2 id="second">Second heading</h2>'
                    "<p>Closing.</p>"
                ),
                "canonical_text": canonical_text,
            },
        )
        session.execute(
            text(
                """
                UPDATE epub_nav_locations
                SET end_offset = :end_offset
                WHERE media_id = :media_id AND fragment_idx = 0
                """
            ),
            {"media_id": media_id, "end_offset": 14},
        )
        session.execute(
            text(
                """
                INSERT INTO epub_nav_locations (
                    media_id, location_id, ordinal, source_node_id, label,
                    fragment_idx, href_path, href_fragment,
                    start_offset, end_offset, source
                )
                VALUES (
                    :media_id, 'chapter.xhtml#second', 2, NULL, 'Second heading',
                    0, 'chapter.xhtml', 'second', 14, 37, 'toc'
                )
                """
            ),
            {"media_id": media_id},
        )
        add_media_to_library(session, library_id, media_id)
        session.commit()

    direct_db.register_cleanup("epub_nav_locations", "media_id", media_id)
    direct_db.register_cleanup("content_blocks", "owner_id", media_id)
    direct_db.register_cleanup("content_index_states", "owner_id", media_id)
    for fragment_id in fragment_ids:
        direct_db.register_cleanup("fragment_blocks", "fragment_id", fragment_id)
    direct_db.register_cleanup("fragments", "media_id", media_id)
    direct_db.register_cleanup("library_entries", "media_id", media_id)
    direct_db.register_cleanup("media", "id", media_id)

    response = auth_client.get(
        f"/media/{media_id}/navigation",
        headers=auth_headers(user_id),
    )

    assert response.status_code == 200, response.text
    sections = response.json()["data"]["sections"]
    assert [
        (
            section["fragment_idx"],
            section["start_offset"],
            section["end_offset"],
        )
        for section in sections
    ] == [
        (0, 0, 14),
        (1, 0, 47),
        (0, 14, 37),
    ]


def test_epub_navigation_preserves_source_order_with_document_order_intervals(
    auth_client,
    direct_db: DirectSessionManager,
) -> None:
    user_id = create_test_user_id()
    me = auth_client.get("/me", headers=auth_headers(user_id))
    library_id = UUID(me.json()["data"]["default_library_id"])
    canonical_text = "Opening line.\nSecond heading\nClosing."

    with direct_db.session() as session:
        media_id, fragment_ids = create_ready_epub_with_chapters(
            session,
            num_chapters=1,
            with_toc=False,
        )
        session.execute(
            text(
                """
                UPDATE fragments
                SET canonical_text = :canonical_text
                WHERE media_id = :media_id AND idx = 0
                """
            ),
            {"media_id": media_id, "canonical_text": canonical_text},
        )
        session.execute(
            text(
                """
                UPDATE epub_nav_locations
                SET ordinal = 1,
                    start_offset = 0,
                    end_offset = 14
                WHERE media_id = :media_id AND fragment_idx = 0
                """
            ),
            {"media_id": media_id},
        )
        session.execute(
            text(
                """
                INSERT INTO epub_nav_locations (
                    media_id, location_id, ordinal, source_node_id, label,
                    fragment_idx, href_path, href_fragment,
                    start_offset, end_offset, source
                ) VALUES (
                    :media_id, 'chapter.xhtml#second', 0, NULL, 'Second heading',
                    0, 'chapter.xhtml', 'second', 14, 37, 'toc'
                )
                """
            ),
            {"media_id": media_id},
        )
        add_media_to_library(session, library_id, media_id)
        session.commit()

    direct_db.register_cleanup("epub_nav_locations", "media_id", media_id)
    direct_db.register_cleanup("content_blocks", "owner_id", media_id)
    direct_db.register_cleanup("content_index_states", "owner_id", media_id)
    direct_db.register_cleanup("fragment_blocks", "fragment_id", fragment_ids[0])
    direct_db.register_cleanup("fragments", "media_id", media_id)
    direct_db.register_cleanup("library_entries", "media_id", media_id)
    direct_db.register_cleanup("media", "id", media_id)

    response = auth_client.get(
        f"/media/{media_id}/navigation",
        headers=auth_headers(user_id),
    )

    assert response.status_code == 200, response.text
    sections = response.json()["data"]["sections"]
    assert [(section["start_offset"], section["end_offset"]) for section in sections] == [
        (14, 37),
        (0, 14),
    ]
