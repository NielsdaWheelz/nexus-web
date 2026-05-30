"""Integration tests for the URI-based resource resolver.

Covers one happy-path and one permission/missing-path test per scheme that
takes a UUID identifier in the resolver's dispatch table. Assertions go
through the service surface (``resolve`` / ``resolve_batch``) rather than
raw SQL so the resolver's permission and inline-threshold behavior is part
of the contract under test.
"""

from __future__ import annotations

import hashlib
from uuid import UUID, uuid4

import pytest
from sqlalchemy.orm import Session

from nexus.db.models import (
    EvidenceSpan,
    Fragment,
    Highlight,
    HighlightFragmentAnchor,
    Message,
    NoteBlock,
    Page,
)
from nexus.services.bootstrap import ensure_user_and_default_library
from nexus.services.resource_resolver import (
    INLINE_THRESHOLD_CHARS,
    resolve,
    resolve_batch,
)
from tests.factories import (
    create_test_conversation,
    create_test_library,
    create_test_media_in_library,
    create_test_message,
    get_user_default_library,
)

pytestmark = pytest.mark.integration


# =============================================================================
# Helpers
# =============================================================================


def _make_span(db: Session, media_id: UUID, text: str = "Inline span body.") -> UUID:
    """Create an evidence_span anchored to a media for resolver tests.

    Wires up the minimum block/source_snapshot/index_run scaffolding so the
    span's FKs satisfy the schema. Resolver only reads ``span_text``,
    ``citation_label``, and ``media_id`` via the join.
    """
    from sqlalchemy import text as sql_text

    index_run_id = db.execute(
        sql_text(
            """
            INSERT INTO content_index_runs (
                id, media_id, state, source_version, extractor_version, chunker_version,
                embedding_provider, embedding_model, embedding_version, embedding_config_hash,
                started_at, finished_at, activated_at
            )
            VALUES (
                gen_random_uuid(), :media_id, 'ready', 'v1', '0', '0', 'test', 'test', '0',
                'h', now(), now(), now()
            )
            RETURNING id
            """
        ),
        {"media_id": media_id},
    ).scalar_one()
    source_snapshot_id = db.execute(
        sql_text(
            """
            INSERT INTO source_snapshots (
                id, media_id, index_run_id, source_kind, artifact_kind, artifact_ref,
                content_type, byte_length, source_fingerprint, source_version,
                extractor_version, content_sha256, metadata
            )
            VALUES (
                gen_random_uuid(), :media_id, :index_run_id, 'web_article', 'html',
                :artifact_ref, 'text/html', :byte_length, :source_fingerprint, 'v1',
                '0', :content_sha256, '{}'::jsonb
            )
            RETURNING id
            """
        ),
        {
            "media_id": media_id,
            "index_run_id": index_run_id,
            "artifact_ref": f"resolver-test:{media_id}",
            "byte_length": len(text.encode("utf-8")),
            "source_fingerprint": f"resolver-test:{uuid4()}",
            "content_sha256": hashlib.sha256(text.encode("utf-8")).hexdigest(),
        },
    ).scalar_one()
    block_id = db.execute(
        sql_text(
            """
            INSERT INTO content_blocks (
                media_id, index_run_id, source_snapshot_id, block_idx, block_kind,
                canonical_text, text_sha256, extraction_confidence,
                source_start_offset, source_end_offset,
                heading_path, locator, selector, metadata
            )
            VALUES (
                :media_id, :index_run_id, :source_snapshot_id, 0, 'paragraph',
                :canonical_text, :text_sha256, 1.0, 0, :source_end_offset,
                '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb
            )
            RETURNING id
            """
        ),
        {
            "media_id": media_id,
            "index_run_id": index_run_id,
            "source_snapshot_id": source_snapshot_id,
            "canonical_text": text,
            "text_sha256": hashlib.sha256(text.encode("utf-8")).hexdigest(),
            "source_end_offset": len(text),
        },
    ).scalar_one()
    span = EvidenceSpan(
        id=uuid4(),
        media_id=media_id,
        index_run_id=index_run_id,
        source_snapshot_id=source_snapshot_id,
        start_block_id=block_id,
        end_block_id=block_id,
        start_block_offset=0,
        end_block_offset=len(text),
        span_text=text,
        span_sha256=hashlib.sha256(f"span:{text}".encode()).hexdigest(),
        selector={},
        citation_label="excerpt",
        resolver_kind="web",
    )
    db.add(span)
    db.flush()
    db.commit()
    return span.id


def _make_page(db: Session, user_id: UUID, *, description: str = "Page body.") -> UUID:
    page = Page(id=uuid4(), user_id=user_id, title="Test Page", description=description)
    db.add(page)
    db.commit()
    return page.id


def _make_note_block(db: Session, user_id: UUID, *, body: str = "Note body.") -> UUID:
    page_id = _make_page(db, user_id)
    block = NoteBlock(
        id=uuid4(),
        user_id=user_id,
        page_id=page_id,
        order_key="0000000001",
        block_kind="bullet",
        body_pm_json={"type": "paragraph", "content": [{"type": "text", "text": body}]},
        body_markdown=body,
        body_text=body,
        collapsed=False,
    )
    db.add(block)
    db.commit()
    return block.id


def _make_highlight_with_anchor(db: Session, user_id: UUID, media_id: UUID) -> UUID:
    fragment = (
        db.query(Fragment).filter(Fragment.media_id == media_id).order_by(Fragment.idx).first()
    )
    if fragment is None:
        exact = "some highlighted text"
        fragment = Fragment(
            id=uuid4(),
            media_id=media_id,
            idx=0,
            canonical_text=exact,
            html_sanitized=f"<p>{exact}</p>",
        )
        db.add(fragment)
        db.flush()
    highlight = Highlight(
        id=uuid4(),
        user_id=user_id,
        anchor_kind="fragment_offsets",
        anchor_media_id=media_id,
        color="yellow",
        exact="some highlighted text",
        prefix="",
        suffix="",
    )
    db.add(highlight)
    db.flush()
    db.add(
        HighlightFragmentAnchor(
            highlight_id=highlight.id,
            fragment_id=fragment.id,
            start_offset=0,
            end_offset=len("some highlighted text"),
        )
    )
    db.commit()
    return highlight.id


# =============================================================================
# Tests
# =============================================================================


def test_resolve_media_returns_label_summary_and_pointer_only_body(
    db_session: Session, bootstrapped_user: UUID
):
    library_id = get_user_default_library(db_session, bootstrapped_user)
    assert library_id is not None
    media_id = create_test_media_in_library(db_session, bootstrapped_user, library_id, title="Dune")

    resolved = resolve(db_session, f"media:{media_id}", viewer_id=bootstrapped_user)

    assert not resolved.missing, f"Expected resolved media to be visible, got {resolved}"
    assert resolved.uri == f"media:{media_id}", (
        f"Resolver should echo the input URI; got {resolved.uri}"
    )
    assert "Dune" in resolved.label, f"Expected media title in label; got {resolved.label}"
    assert resolved.inline_body is None, (
        f"Media bodies are always pointer-only; got inline_body={resolved.inline_body!r}"
    )
    assert "app_search" in resolved.fetch_hint, (
        f"Media fetch_hint should direct the model to app_search; got {resolved.fetch_hint}"
    )


def test_resolve_media_unknown_id_returns_missing(db_session: Session, bootstrapped_user: UUID):
    resolved = resolve(db_session, f"media:{uuid4()}", viewer_id=bootstrapped_user)
    assert resolved.missing, (
        f"Unknown media URI must resolve as missing, got missing={resolved.missing}"
    )


def test_resolve_media_no_permission_returns_missing(db_session: Session, bootstrapped_user: UUID):
    """A media row not in any library the viewer can read is `missing` to them."""
    other_user_id = uuid4()
    ensure_user_and_default_library(db_session, other_user_id)
    other_library_id = create_test_library(db_session, other_user_id, "Other Library")
    private_media_id = create_test_media_in_library(
        db_session, other_user_id, other_library_id, title="Private Doc"
    )

    resolved = resolve(db_session, f"media:{private_media_id}", viewer_id=bootstrapped_user)

    assert resolved.missing, (
        f"Viewer without media permission must see missing=True; got {resolved}"
    )


def test_resolve_library_member_returns_summary_pointer(
    db_session: Session, bootstrapped_user: UUID
):
    library_id = create_test_library(db_session, bootstrapped_user, "Reading List")

    resolved = resolve(db_session, f"library:{library_id}", viewer_id=bootstrapped_user)

    assert not resolved.missing, f"Expected member to resolve library, got missing={resolved}"
    assert resolved.label == "Reading List", (
        f"Library label should be the library name; got {resolved.label!r}"
    )
    assert resolved.inline_body is None, "Library bodies are pointer-only"
    assert "app_search" in resolved.fetch_hint, (
        f"Library fetch_hint should direct to app_search; got {resolved.fetch_hint}"
    )


def test_resolve_library_non_member_returns_missing(db_session: Session, bootstrapped_user: UUID):
    other_user_id = uuid4()
    ensure_user_and_default_library(db_session, other_user_id)
    other_library_id = create_test_library(db_session, other_user_id, "Closed Library")

    resolved = resolve(db_session, f"library:{other_library_id}", viewer_id=bootstrapped_user)

    assert resolved.missing, "Non-member must see library as missing"


def test_resolve_span_inlines_body_under_threshold(db_session: Session, bootstrapped_user: UUID):
    library_id = get_user_default_library(db_session, bootstrapped_user)
    assert library_id is not None
    media_id = create_test_media_in_library(
        db_session, bootstrapped_user, library_id, title="Span Source"
    )
    span_id = _make_span(db_session, media_id, text="A short inline span.")

    resolved = resolve(db_session, f"span:{span_id}", viewer_id=bootstrapped_user)

    assert not resolved.missing, f"Expected span visibility, got {resolved}"
    assert resolved.inline_body == "A short inline span.", (
        f"Span body shorter than {INLINE_THRESHOLD_CHARS} chars should be inlined; "
        f"got inline_body={resolved.inline_body!r}"
    )
    assert "Span Source" in resolved.label, (
        f"Span label should include source media title; got {resolved.label}"
    )


def test_resolve_span_unknown_returns_missing(db_session: Session, bootstrapped_user: UUID):
    resolved = resolve(db_session, f"span:{uuid4()}", viewer_id=bootstrapped_user)
    assert resolved.missing, "Unknown span URI must resolve as missing"


def test_resolve_highlight_inlines_text(db_session: Session, bootstrapped_user: UUID):
    library_id = get_user_default_library(db_session, bootstrapped_user)
    assert library_id is not None
    media_id = create_test_media_in_library(
        db_session, bootstrapped_user, library_id, title="Highlight Source"
    )
    # _make_highlight_with_anchor needs a fragment; reuse the helper via _make_span,
    # which inserts a fragment as part of its scaffolding.
    _make_span(db_session, media_id, text="Background span text for highlight.")
    highlight_id = _make_highlight_with_anchor(db_session, bootstrapped_user, media_id)

    resolved = resolve(db_session, f"highlight:{highlight_id}", viewer_id=bootstrapped_user)

    assert not resolved.missing, f"Expected highlight visibility, got {resolved}"
    assert resolved.inline_body == "some highlighted text", (
        f"Highlight bodies are always inline; got inline_body={resolved.inline_body!r}"
    )


def test_resolve_page_owner_inlines_short_description(db_session: Session, bootstrapped_user: UUID):
    page_id = _make_page(db_session, bootstrapped_user, description="Page description body.")
    resolved = resolve(db_session, f"page:{page_id}", viewer_id=bootstrapped_user)

    assert not resolved.missing, f"Owner-resolved page should be visible; got {resolved}"
    assert resolved.label == "Test Page", f"Page label should be the title; got {resolved.label}"
    assert resolved.inline_body == "Page description body.", (
        f"Short page descriptions should inline; got {resolved.inline_body!r}"
    )


def test_resolve_page_non_owner_returns_missing(db_session: Session, bootstrapped_user: UUID):
    other_user_id = uuid4()
    ensure_user_and_default_library(db_session, other_user_id)
    page_id = _make_page(db_session, other_user_id, description="Private page.")

    resolved = resolve(db_session, f"page:{page_id}", viewer_id=bootstrapped_user)

    assert resolved.missing, "Non-owner viewer must see page as missing"


def test_resolve_note_block_owner_inlines_body(db_session: Session, bootstrapped_user: UUID):
    block_id = _make_note_block(db_session, bootstrapped_user, body="Note block body.")

    resolved = resolve(db_session, f"note_block:{block_id}", viewer_id=bootstrapped_user)

    assert not resolved.missing, f"Owner should resolve note_block; got {resolved}"
    assert resolved.inline_body == "Note block body.", (
        f"Note blocks always inline; got inline_body={resolved.inline_body!r}"
    )


def test_resolve_note_block_non_owner_returns_missing(db_session: Session, bootstrapped_user: UUID):
    other_user_id = uuid4()
    ensure_user_and_default_library(db_session, other_user_id)
    block_id = _make_note_block(db_session, other_user_id, body="Private note.")

    resolved = resolve(db_session, f"note_block:{block_id}", viewer_id=bootstrapped_user)

    assert resolved.missing, "Non-owner must see note_block as missing"


def test_resolve_conversation_owner_returns_summary_no_inline(
    db_session: Session, bootstrapped_user: UUID
):
    conversation_id = create_test_conversation(db_session, bootstrapped_user)
    create_test_message(db_session, conversation_id, seq=1, content="Hello")

    resolved = resolve(db_session, f"conversation:{conversation_id}", viewer_id=bootstrapped_user)

    assert not resolved.missing, f"Owner should resolve conversation; got {resolved}"
    assert resolved.inline_body is None, (
        "Conversation bodies are pointer-only (no transcript inline)"
    )
    assert "messages" in resolved.summary, (
        f"Conversation summary should mention message_count; got {resolved.summary!r}"
    )


def test_resolve_conversation_non_owner_returns_missing(
    db_session: Session, bootstrapped_user: UUID
):
    other_user_id = uuid4()
    ensure_user_and_default_library(db_session, other_user_id)
    conversation_id = create_test_conversation(db_session, other_user_id)

    resolved = resolve(db_session, f"conversation:{conversation_id}", viewer_id=bootstrapped_user)

    assert resolved.missing, "Non-owner viewer must see conversation as missing"


def test_resolve_message_visible_inlines_short_body(db_session: Session, bootstrapped_user: UUID):
    conversation_id = create_test_conversation(db_session, bootstrapped_user)
    message_id = create_test_message(
        db_session,
        conversation_id,
        seq=1,
        content="A short user message.",
    )
    msg = db_session.get(Message, message_id)
    assert msg is not None

    resolved = resolve(db_session, f"message:{message_id}", viewer_id=bootstrapped_user)

    assert not resolved.missing, f"Owner should resolve message; got {resolved}"
    assert resolved.inline_body == "A short user message.", (
        f"Short messages should inline; got {resolved.inline_body!r}"
    )


def test_resolve_unknown_scheme_returns_missing(db_session: Session, bootstrapped_user: UUID):
    resolved = resolve(db_session, f"unknown_scheme:{uuid4()}", viewer_id=bootstrapped_user)

    assert resolved.missing, "Unknown URI scheme must resolve as missing"
    assert resolved.label == "(resource unavailable)", (
        f"Missing entries should carry the well-known label; got {resolved.label!r}"
    )


def test_resolve_invalid_uri_format_returns_missing(db_session: Session, bootstrapped_user: UUID):
    resolved = resolve(db_session, "not-a-valid-uri", viewer_id=bootstrapped_user)

    assert resolved.missing, "Malformed URI must resolve as missing without raising"


def test_resolve_batch_groups_by_scheme(db_session: Session, bootstrapped_user: UUID):
    """Batch resolution returns one entry per input URI, preserving input order."""
    library_id = get_user_default_library(db_session, bootstrapped_user)
    assert library_id is not None
    media_id = create_test_media_in_library(
        db_session, bootstrapped_user, library_id, title="Batch Source"
    )
    page_id = _make_page(db_session, bootstrapped_user, description="Batch page.")

    uris = [
        f"media:{media_id}",
        f"page:{page_id}",
        f"media:{uuid4()}",  # missing
    ]
    results = resolve_batch(db_session, uris, viewer_id=bootstrapped_user)

    assert [r.uri for r in results] == uris, (
        f"resolve_batch must preserve input order; got {[r.uri for r in results]}"
    )
    assert results[0].missing is False
    assert results[1].missing is False
    assert results[2].missing is True
