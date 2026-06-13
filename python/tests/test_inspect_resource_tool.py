"""Integration tests for the ``inspect_resource`` agent tool (document map).

``inspect_resource`` returns navigation, not evidence: an ordered section list
whose ``read_uri``s point at text the read tool can actually open. Covered here
via the PDF stack (self-contained — no content-index navigation fixture), plus
the round-trip that a section pointer the map returns is readable.
"""

from __future__ import annotations

from uuid import UUID, uuid4

import pytest
from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.services.agent_tools.inspect_resource import (
    InspectResourceResult,
    execute_inspect_resource,
)
from nexus.services.agent_tools.read_resource import execute_read_resource
from nexus.services.media_document_map import DocumentMapSection, MediaDocumentMap
from tests.factories import (
    create_test_conversation,
    create_test_media_in_library,
    get_user_default_library,
)
from tests.test_read_resource_tool import _admit_reference
from tests.test_resource_graph_resolve import _make_pdf

pytestmark = pytest.mark.integration


def test_inspect_resource_tool_output_escapes_attribute_quotes():
    media_id = uuid4()
    result = InspectResourceResult(
        uri='media:"quoted"',
        status="complete",
        body="",
        document_map=MediaDocumentMap(
            media_id=media_id,
            kind='pdf"kind',
            title='Title "Quoted"',
            total_sections=1,
            sections=[
                DocumentMapSection(
                    ordinal=1,
                    label='Pages "1"',
                    section_kind='page"_range',
                    read_uri=f'page_range:{media_id}:"1"-1',
                    preview='Preview "quoted" <text>',
                )
            ],
        ),
    )

    output = result.tool_output()

    assert 'uri="media:&quot;quoted&quot;"' in output
    assert 'title="Title &quot;Quoted&quot;"' in output
    assert 'media_kind="pdf&quot;kind"' in output
    assert 'label="Pages &quot;1&quot;"' in output
    assert 'section_kind="page&quot;_range"' in output
    assert f'read_uri="page_range:{media_id}:&quot;1&quot;-1"' in output
    assert 'Preview "quoted" &lt;text&gt;' in output


def test_inspect_resource_pdf_returns_document_map(db_session: Session, bootstrapped_user: UUID):
    conversation_id = create_test_conversation(db_session, bootstrapped_user)
    library_id = get_user_default_library(db_session, bootstrapped_user)
    assert library_id is not None
    media_id = _make_pdf(db_session, library_id, pages=["A" * 3000, "B" * 3000, "C" * 3000])
    db_session.execute(
        text(
            """
            UPDATE pdf_page_text_spans
            SET page_label = CASE page_number
                WHEN 1 THEN 'A-7'
                WHEN 2 THEN 'A-8'
                ELSE NULL
            END
            WHERE media_id = :media_id
            """
        ),
        {"media_id": media_id},
    )
    db_session.commit()
    uri = f"media:{media_id}"
    _admit_reference(db_session, conversation_id, uri)

    result = execute_inspect_resource(
        db_session, viewer_id=bootstrapped_user, conversation_id=conversation_id, uri=uri
    )

    assert not result.is_error, f"Inspecting a referenced media should succeed; got {result}"
    document_map = result.document_map
    assert document_map is not None
    # 6000-char page groups: pages 1-2 fill one section, page 3 the next.
    assert document_map.total_sections == 2
    assert [s.read_uri for s in document_map.sections] == [
        f"page_range:{media_id}:1-2",
        f"page_range:{media_id}:3-3",
    ]
    assert document_map.sections[0].ordinal == 1
    assert document_map.sections[0].section_kind == "page_range"
    assert document_map.sections[0].label == "Pages A-7-A-8"
    output = result.tool_output()
    assert "<document_map" in output
    assert 'kind="document_map"' in output
    assert 'media_kind="pdf"' in output
    assert 'ordinal="1"' in output
    assert 'section_kind="page_range"' in output
    assert 'page_start="1"' in output
    assert 'page_end="2"' in output
    assert 'read_uri="page_range:' in output
    assert ' n="' not in output


@pytest.mark.parametrize("media_kind", ["podcast_episode", "video"])
def test_inspect_resource_audio_video_uses_active_transcript_timecodes(
    db_session: Session, bootstrapped_user: UUID, media_kind: str
):
    conversation_id = create_test_conversation(db_session, bootstrapped_user)
    library_id = get_user_default_library(db_session, bootstrapped_user)
    assert library_id is not None
    media_id = create_test_media_in_library(
        db_session, bootstrapped_user, library_id, title="Talk Episode"
    )
    first_fragment_id = uuid4()
    second_fragment_id = uuid4()
    db_session.execute(
        text("UPDATE media SET kind = :kind WHERE id = :media_id"),
        {"media_id": media_id, "kind": media_kind},
    )
    db_session.execute(
        text(
            """
            INSERT INTO media_transcript_states (
                media_id, transcript_state, transcript_coverage, semantic_status,
                last_request_reason
            )
            VALUES (:media_id, 'ready', 'full', 'ready', 'episode_open')
            """
        ),
        {"media_id": media_id},
    )
    db_session.execute(
        text(
            """
            INSERT INTO podcast_episode_chapters
                (media_id, chapter_idx, title, t_start_ms, t_end_ms, source)
            VALUES
                (:media_id, 0, 'Opening', 0, 10000, 'rss_podcasting20'),
                (:media_id, 1, 'Deep Dive', 10000, 20000, 'rss_podcasting20')
            """
        ),
        {"media_id": media_id},
    )
    db_session.execute(
        text(
            """
            INSERT INTO fragments (
                id, media_id, idx, canonical_text,
                html_sanitized, t_start_ms, t_end_ms
            )
            VALUES
                (:first_id, :media_id, 0, 'Opening transcript.',
                 '<p>Opening transcript.</p>', 1000, 3000),
                (:second_id, :media_id, 1, 'Detailed transcript.',
                 '<p>Detailed transcript.</p>', 12000, 15000)
            """
        ),
        {
            "first_id": first_fragment_id,
            "second_id": second_fragment_id,
            "media_id": media_id,
        },
    )
    db_session.commit()
    _admit_reference(db_session, conversation_id, f"media:{media_id}")

    result = execute_inspect_resource(
        db_session,
        viewer_id=bootstrapped_user,
        conversation_id=conversation_id,
        uri=f"media:{media_id}",
    )

    assert not result.is_error, f"Inspecting an active transcript should succeed; got {result}"
    document_map = result.document_map
    assert document_map is not None
    assert [section.read_uri for section in document_map.sections] == [
        f"fragment:{first_fragment_id}",
        f"fragment:{second_fragment_id}",
    ]
    assert [section.parent_label for section in document_map.sections] == [
        "Opening",
        "Deep Dive",
    ]
    assert document_map.sections[1].t_start_ms == 12000
    assert document_map.sections[1].t_end_ms == 15000
    output = result.tool_output()
    assert f'media_kind="{media_kind}"' in output
    assert 'section_kind="transcript_segment"' in output
    assert 'chapter="Deep Dive"' in output
    assert 't_start_ms="12000"' in output
    assert 't_end_ms="15000"' in output
    assert ' n="' not in output


def test_inspect_resource_section_pointer_is_readable(db_session: Session, bootstrapped_user: UUID):
    """Every read_uri the map hands out must point at openable evidence."""
    conversation_id = create_test_conversation(db_session, bootstrapped_user)
    library_id = get_user_default_library(db_session, bootstrapped_user)
    assert library_id is not None
    media_id = _make_pdf(db_session, library_id, pages=["A" * 3000, "B" * 3000, "C" * 3000])
    _admit_reference(db_session, conversation_id, f"media:{media_id}")

    document_map = execute_inspect_resource(
        db_session,
        viewer_id=bootstrapped_user,
        conversation_id=conversation_id,
        uri=f"media:{media_id}",
    ).document_map
    assert document_map is not None

    read = execute_read_resource(
        db_session,
        viewer_id=bootstrapped_user,
        conversation_id=conversation_id,
        uri=document_map.sections[0].read_uri,
    )

    assert not read.is_error, f"A read_uri from the map must be readable; got {read}"
    assert read.kind == "page_range"
    assert read.body == "A" * 3000 + "B" * 3000


def test_inspect_resource_non_media_is_not_inspectable(
    db_session: Session, bootstrapped_user: UUID
):
    conversation_id = create_test_conversation(db_session, bootstrapped_user)
    uri = f"highlight:{uuid4()}"
    _admit_reference(db_session, conversation_id, uri)

    result = execute_inspect_resource(
        db_session, viewer_id=bootstrapped_user, conversation_id=conversation_id, uri=uri
    )

    assert result.is_error
    assert result.error_code == "not_inspectable"


def test_inspect_resource_media_not_in_context_refs_errors(
    db_session: Session, bootstrapped_user: UUID
):
    conversation_id = create_test_conversation(db_session, bootstrapped_user)
    library_id = get_user_default_library(db_session, bootstrapped_user)
    assert library_id is not None
    media_id = _make_pdf(db_session, library_id, pages=["only page"])

    result = execute_inspect_resource(
        db_session,
        viewer_id=bootstrapped_user,
        conversation_id=conversation_id,
        uri=f"media:{media_id}",
    )

    assert result.is_error
    assert result.error_code == "not_in_context_refs"
