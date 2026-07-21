"""Test data factories.

Centralizes helper functions that create database rows for tests.
Each factory knows the full schema requirements for its table,
so individual tests don't need to track NOT NULL constraints.

When a column is added or a constraint changes, update the
relevant factory here — not in N test files.
"""

from datetime import UTC, datetime
from uuid import UUID, uuid4

from sqlalchemy import select, text
from sqlalchemy.orm import Session

from nexus.db.models import (
    Conversation,
    ConversationShare,
    EpubNavLocation,
    EpubTocNode,
    FailureStage,
    Fragment,
    Highlight,
    HighlightFragmentAnchor,
    Library,
    Media,
    MediaFile,
    MediaKind,
    MediaSourceAttempt,
    MediaSourceAttemptStatus,
    Membership,
    Message,
    NoteBlock,
    Page,
    PdfPageTextSpan,
    ProcessingStatus,
    ResourceEdge,
)
from nexus.services.content_indexing import rebuild_fragment_content_index
from nexus.services.fragment_blocks import insert_fragment_blocks, parse_fragment_blocks
from nexus.services.note_indexing import rebuild_note_content_index
from nexus.services.resource_graph.refs import (
    ResourceRef,
    ResourceRefParseFailure,
    parse_resource_ref,
)
from nexus.services.resource_items import versions

# =============================================================================
# Models
# =============================================================================


# =============================================================================
# Conversations & Messages
# =============================================================================


def create_test_conversation(
    session: Session,
    owner_user_id: UUID,
    sharing: str = "private",
) -> UUID:
    """Create a test conversation."""
    conv = Conversation(
        id=uuid4(),
        owner_user_id=owner_user_id,
        sharing=sharing,
        next_seq=1,
    )
    session.add(conv)
    session.commit()
    return conv.id


def add_context_edge(
    session: Session, conversation_id: UUID, uri: str, *, origin: str = "user"
) -> UUID:
    """Attach a bare context edge conversation->uri (test fixture).

    Raw insert keyed by the pair: idempotent, no resolution or owner check.
    """
    ref = parse_resource_ref(uri)
    assert not isinstance(ref, ResourceRefParseFailure), f"malformed test uri: {uri!r}"
    owner_id = session.execute(
        select(Conversation.owner_user_id).where(Conversation.id == conversation_id)
    ).scalar_one()
    existing = session.execute(
        select(ResourceEdge.id).where(
            ResourceEdge.source_scheme == "conversation",
            ResourceEdge.source_id == conversation_id,
            ResourceEdge.target_scheme == ref.scheme,
            ResourceEdge.target_id == ref.id,
            ResourceEdge.ordinal.is_(None),
        )
    ).scalar_one_or_none()
    if existing is not None:
        return existing
    edge = ResourceEdge(
        user_id=owner_id,
        kind="context",
        origin=origin,
        source_scheme="conversation",
        source_id=conversation_id,
        target_scheme=ref.scheme,
        target_id=ref.id,
    )
    session.add(edge)
    session.flush()
    return edge.id


def _message_document(role: str, content: str) -> dict[str, object]:
    text = content.strip()
    return {
        "type": "message_document",
        "blocks": []
        if not text
        else [
            {
                "type": "text",
                "format": "markdown" if role == "assistant" else "plain",
                "text": content,
            }
        ],
    }


def create_test_message(
    session: Session,
    conversation_id: UUID,
    seq: int,
    role: str = "user",
    content: str = "Test message",
    status: str = "complete",
    parent_message_id: UUID | None = None,
) -> UUID:
    """Create a test message and bump the conversation's next_seq."""
    if parent_message_id is None and role in {"user", "assistant"}:
        expected_parent_role = "assistant" if role == "user" else "user"
        previous = (
            session.query(Message)
            .filter(
                Message.conversation_id == conversation_id,
                Message.seq < seq,
                Message.role == expected_parent_role,
            )
            .order_by(Message.seq.desc(), Message.id.desc())
            .first()
        )
        if previous is not None:
            parent_message_id = previous.id
    branch_root_message_id = None
    if role == "user" and parent_message_id is not None:
        branch_root_message_id = parent_message_id
    elif role == "assistant" and parent_message_id is not None:
        parent_message = session.get(Message, parent_message_id)
        branch_root_message_id = parent_message.branch_root_message_id if parent_message else None
    msg = Message(
        id=uuid4(),
        conversation_id=conversation_id,
        seq=seq,
        role=role,
        content=content,
        message_document=_message_document(role, content),
        status=status,
        parent_message_id=parent_message_id,
        branch_root_message_id=branch_root_message_id,
    )
    session.add(msg)
    conv = session.get(Conversation, conversation_id)
    if conv:
        conv.next_seq = seq + 1
    session.commit()
    return msg.id


def create_test_conversation_with_message(
    session: Session,
    user_id: UUID,
    content: str = "Test message content",
    status: str = "complete",
    role: str = "user",
) -> tuple[UUID, UUID]:
    """Create a conversation with a single message.

    Returns (conversation_id, message_id).
    """
    conv = Conversation(
        id=uuid4(),
        owner_user_id=user_id,
        sharing="private",
        next_seq=3 if role == "assistant" else 2,
    )
    session.add(conv)
    session.flush()
    parent_message_id = None
    seq = 1
    if role == "assistant":
        parent = Message(
            id=uuid4(),
            conversation_id=conv.id,
            seq=1,
            role="user",
            content="Test setup message",
            message_document=_message_document("user", "Test setup message"),
            status="complete",
        )
        session.add(parent)
        session.flush()
        parent_message_id = parent.id
        seq = 2
    msg = Message(
        id=uuid4(),
        conversation_id=conv.id,
        seq=seq,
        role=role,
        content=content,
        message_document=_message_document(role, content),
        status=status,
        parent_message_id=parent_message_id,
    )
    session.add(msg)
    session.commit()
    return conv.id, msg.id


# =============================================================================
# Media
# =============================================================================


def create_test_media(
    session: Session,
    *,
    title: str = "Test Article",
    status: str = "ready_for_reading",
) -> UUID:
    """Create a bare media row (not linked to any library)."""
    media = Media(
        id=uuid4(),
        kind=MediaKind.web_article.value,
        title=title,
        canonical_source_url="https://example.com/test",
        processing_status=ProcessingStatus(status),
    )
    session.add(media)
    session.commit()
    return media.id


def add_media_to_library(session: Session, library_id: UUID, media_id: UUID) -> None:
    """Attach media to a library using the mixed library_entries table.

    Idempotent physical-entry insert at the next position. Post-cutover, a
    direct default entry is just a physical `library_entries` row in the
    user's default library — there is no separate provenance table."""
    existing = session.execute(
        text(
            """
            SELECT 1
            FROM library_entries
            WHERE library_id = :library_id
              AND media_id = :media_id
            """
        ),
        {"library_id": library_id, "media_id": media_id},
    ).scalar_one_or_none()
    if existing is None:
        next_position = int(
            session.execute(
                text(
                    """
                    SELECT COALESCE(MAX(position) + 1, 0)
                    FROM library_entries
                    WHERE library_id = :library_id
                    """
                ),
                {"library_id": library_id},
            ).scalar_one()
        )
        session.execute(
            text(
                """
                INSERT INTO library_entries (
                    id,
                    library_id,
                    position,
                    created_at,
                    media_id,
                    podcast_id
                )
                VALUES (
                    :id,
                    :library_id,
                    :position,
                    :created_at,
                    :media_id,
                    NULL
                )
                """
            ),
            {
                "id": uuid4(),
                "library_id": library_id,
                "position": next_position,
                "created_at": datetime.now(UTC),
                "media_id": media_id,
            },
        )


def create_test_media_in_library(
    session: Session,
    user_id: UUID,
    library_id: UUID,
    *,
    title: str = "Test Article",
    status: str = "ready_for_reading",
) -> UUID:
    """Create media and link it to a specific library."""
    media = Media(
        id=uuid4(),
        kind=MediaKind.web_article.value,
        title=title,
        canonical_source_url="https://example.com/article",
        processing_status=ProcessingStatus(status),
        # The passed user owns this media; creator-derived capabilities
        # (can_edit_authors, can_retry_metadata, ...) apply to them.
        created_by_user_id=user_id,
    )
    session.add(media)
    session.flush()
    add_media_to_library(session, library_id, media.id)
    session.commit()
    return media.id


def create_searchable_media(
    session: Session,
    user_id: UUID,
    *,
    title: str = "Test Article",
) -> UUID:
    """Create media with a fragment, linked to the user's default library.

    The fragment includes searchable canonical_text derived from the title.
    Intended for search tests that need full-text content.
    """
    media = Media(
        id=uuid4(),
        kind=MediaKind.web_article.value,
        title=title,
        processing_status=ProcessingStatus.ready_for_reading,
        created_by_user_id=user_id,
    )
    session.add(media)
    session.flush()
    fragment = Fragment(
        id=uuid4(),
        media_id=media.id,
        idx=0,
        html_sanitized="<p>Test content</p>",
        canonical_text=f"This is the canonical text for {title}. It contains searchable content about various topics.",
    )
    session.add(fragment)
    session.flush()
    insert_fragment_blocks(session, fragment.id, parse_fragment_blocks(fragment.canonical_text))
    rebuild_fragment_content_index(
        session,
        media_id=media.id,
        source_kind="web_article",
        fragments=[fragment],
        reason="test_factory",
    )
    default_libs = (
        session.query(Library)
        .filter(
            Library.owner_user_id == user_id,
            Library.is_default.is_(True),
        )
        .all()
    )
    for lib in default_libs:
        add_media_to_library(session, lib.id, media.id)
    session.commit()
    return media.id


# =============================================================================
# Fragments, Highlights, Notes
# =============================================================================


def create_test_fragment(
    session: Session, media_id: UUID, content: str = "Fragment content"
) -> UUID:
    """Create a test fragment for a media item."""
    fragment = Fragment(
        id=uuid4(),
        media_id=media_id,
        idx=0,
        canonical_text=content,
        html_sanitized=f"<p>{content}</p>",
    )
    session.add(fragment)
    session.commit()
    return fragment.id


def create_test_highlight(
    session: Session,
    user_id: UUID,
    fragment_id: UUID,
    exact: str = "highlighted text",
) -> UUID:
    """Create a test highlight on a fragment."""
    fragment = session.get(Fragment, fragment_id)
    assert fragment is not None

    end_offset = len(exact)
    highlight = Highlight(
        id=uuid4(),
        user_id=user_id,
        anchor_kind="fragment_offsets",
        anchor_media_id=fragment.media_id,
        color="yellow",
        exact=exact,
        prefix="",
        suffix="",
    )
    session.add(highlight)
    session.flush()
    session.add(
        HighlightFragmentAnchor(
            highlight_id=highlight.id,
            fragment_id=fragment_id,
            start_offset=0,
            end_offset=end_offset,
        )
    )
    session.commit()
    return highlight.id


def create_test_highlight_note(
    session: Session,
    user_id: UUID,
    media_id: UUID,
    body: str = "Test note body",
) -> tuple[UUID, UUID]:
    """Create a highlight and linked note block for a media item.

    Looks up the first fragment of the media item automatically.
    Returns (highlight_id, note_block_id).
    """
    fragment = session.query(Fragment).filter(Fragment.media_id == media_id).limit(1).first()
    if not fragment:
        raise ValueError(f"No fragment found for media {media_id}")

    highlight = Highlight(
        id=uuid4(),
        user_id=user_id,
        anchor_kind="fragment_offsets",
        anchor_media_id=media_id,
        color="yellow",
        exact="test exact",
        prefix="prefix",
        suffix="suffix",
    )
    session.add(highlight)
    session.flush()
    session.add(
        HighlightFragmentAnchor(
            highlight_id=highlight.id,
            fragment_id=fragment.id,
            start_offset=0,
            end_offset=10,
        )
    )
    page = (
        session.query(Page)
        .filter(Page.user_id == user_id, Page.title == "Notes")
        .order_by(Page.id.asc())
        .first()
    )
    if page is None:
        page = Page(id=uuid4(), user_id=user_id, title="Notes")
        session.add(page)
        session.flush()
    versions.ensure_version(
        session, viewer_id=user_id, ref=ResourceRef(scheme="page", id=page.id), lane="title"
    )
    versions.ensure_version(
        session,
        viewer_id=user_id,
        ref=ResourceRef(scheme="page", id=page.id),
        lane="outgoing_edges",
    )
    next_order = (
        len(
            session.scalars(
                select(ResourceEdge.id).where(
                    ResourceEdge.user_id == user_id,
                    ResourceEdge.origin == "user",
                    ResourceEdge.source_scheme == "page",
                    ResourceEdge.source_id == page.id,
                )
            ).all()
        )
        + 1
    )

    note_block = NoteBlock(
        id=uuid4(),
        user_id=user_id,
        body_pm_json={
            "type": "paragraph",
            "content": [{"type": "text", "text": body}],
        },
        body_text=body,
    )
    session.add(note_block)
    session.flush()
    versions.ensure_version(
        session,
        viewer_id=user_id,
        ref=ResourceRef(scheme="note_block", id=note_block.id),
        lane="body",
    )
    versions.ensure_version(
        session,
        viewer_id=user_id,
        ref=ResourceRef(scheme="note_block", id=note_block.id),
        lane="outgoing_edges",
    )
    session.add(
        ResourceEdge(
            id=uuid4(),
            user_id=user_id,
            kind="context",
            origin="user",
            source_scheme="page",
            source_id=page.id,
            target_scheme="note_block",
            target_id=note_block.id,
            source_order_key=f"{next_order:010d}",
        )
    )
    session.add(
        ResourceEdge(
            id=uuid4(),
            user_id=user_id,
            kind="context",
            origin="highlight_note",
            source_scheme="highlight",
            source_id=highlight.id,
            target_scheme="note_block",
            target_id=note_block.id,
        )
    )
    session.flush()
    rebuild_note_content_index(session, note_block_id=note_block.id, reason="factory")
    session.commit()
    return highlight.id, note_block.id


# =============================================================================
# Libraries
# =============================================================================


def create_test_library(session: Session, user_id: UUID, name: str = "Test Library") -> UUID:
    """Create a non-default library with the user as admin."""
    library = Library(
        id=uuid4(),
        owner_user_id=user_id,
        name=name,
        is_default=False,
    )
    session.add(library)
    session.flush()
    session.add(
        Membership(
            library_id=library.id,
            user_id=user_id,
            role="admin",
        )
    )
    session.commit()
    return library.id


# =============================================================================
# Shared Library / Conversation Topologies (search-test helpers)
# =============================================================================


def add_library_member(
    session: Session,
    library_id: UUID,
    user_id: UUID,
    role: str = "member",
) -> None:
    """Add a user as a member of a library (idempotent)."""
    existing = session.get(Membership, (library_id, user_id))
    if existing:
        session.commit()
        return
    session.add(
        Membership(
            library_id=library_id,
            user_id=user_id,
            role=role,
        )
    )
    session.commit()


def share_conversation_to_library(
    session: Session,
    conversation_id: UUID,
    library_id: UUID,
) -> None:
    """Create a conversation_share row linking a conversation to a library.

    Also sets conversation.sharing = 'library' if not already set.
    Idempotent.
    """
    conv = session.get(Conversation, conversation_id)
    if conv and conv.sharing != "library":
        conv.sharing = "library"
    existing = session.get(ConversationShare, (conversation_id, library_id))
    if not existing:
        session.add(
            ConversationShare(
                conversation_id=conversation_id,
                library_id=library_id,
            )
        )
    session.commit()


def create_searchable_media_in_library(
    session: Session,
    user_id: UUID,
    library_id: UUID,
    *,
    title: str = "Test Article",
) -> UUID:
    """Create media with a fragment, linked to a specific non-default library.

    Unlike create_searchable_media, does not also file a direct entry into the
    user's default library. Visibility comes solely from membership in the
    target library.
    """
    media = Media(
        id=uuid4(),
        kind=MediaKind.web_article.value,
        title=title,
        processing_status=ProcessingStatus.ready_for_reading,
        created_by_user_id=user_id,
    )
    session.add(media)
    session.flush()
    fragment = Fragment(
        id=uuid4(),
        media_id=media.id,
        idx=0,
        html_sanitized="<p>Test content</p>",
        canonical_text=f"This is the canonical text for {title}. It contains searchable content about various topics.",
    )
    session.add(fragment)
    session.flush()
    insert_fragment_blocks(session, fragment.id, parse_fragment_blocks(fragment.canonical_text))
    rebuild_fragment_content_index(
        session,
        media_id=media.id,
        source_kind="web_article",
        fragments=[fragment],
        reason="test_factory",
    )
    add_media_to_library(session, library_id, media.id)
    session.commit()
    return media.id


def get_user_default_library(session: Session, user_id: UUID) -> UUID | None:
    """Get a user's default library ID."""
    lib = (
        session.query(Library)
        .filter(
            Library.owner_user_id == user_id,
            Library.is_default.is_(True),
        )
        .first()
    )
    return lib.id if lib else None


# =============================================================================
# EPUB Media + Fragments
# =============================================================================


def create_epub_media_in_library(
    session: Session,
    user_id: UUID,
    library_id: UUID,
    *,
    title: str = "Test EPUB",
    status: str = "ready_for_reading",
) -> UUID:
    """Create an EPUB media row linked to a library.

    Returns media_id.
    """
    media = Media(
        id=uuid4(),
        kind=MediaKind.epub.value,
        title=title,
        processing_status=ProcessingStatus(status),
        created_by_user_id=user_id,
    )
    session.add(media)
    session.flush()
    add_media_to_library(session, library_id, media.id)
    session.commit()
    return media.id


def create_epub_chapter_fragment(
    session: Session,
    media_id: UUID,
    idx: int,
    canonical_text: str,
    html_sanitized: str | None = None,
) -> UUID:
    """Create a chapter fragment for an EPUB media item.

    Returns fragment_id.
    """
    fragment = Fragment(
        id=uuid4(),
        media_id=media_id,
        idx=idx,
        canonical_text=canonical_text,
        html_sanitized=html_sanitized or f"<section>{canonical_text}</section>",
    )
    session.add(fragment)
    session.commit()
    return fragment.id


def create_failed_epub_media(
    session: Session,
    user_id: UUID,
    *,
    last_error_code: str = "E_EXTRACT_FAILED",
    processing_attempts: int = 1,
) -> UUID:
    """Create a failed EPUB media row with an optional media_file record.

    Used by retry tests. Returns media_id.
    """
    media = Media(
        id=uuid4(),
        kind=MediaKind.epub.value,
        title="Failed EPUB",
        processing_status=ProcessingStatus.failed,
        created_by_user_id=user_id,
        failure_stage=FailureStage.extract,
        last_error_code=last_error_code,
        last_error_message="test failure",
        failed_at=datetime.now(UTC),
        processing_attempts=processing_attempts,
    )
    session.add(media)
    session.flush()

    media_file = MediaFile(
        media_id=media.id,
        storage_path=f"media/{media.id}/original.epub",
        content_type="application/epub+zip",
        size_bytes=1000,
    )
    session.add(media_file)
    session.add(
        MediaSourceAttempt(
            media_id=media.id,
            created_by_user_id=user_id,
            source_type="uploaded_epub_file",
            attempt_no=1,
            status=MediaSourceAttemptStatus.failed.value,
            intent_key=f"test:uploaded_epub_file:{media.id}",
            source_payload={},
            error_code=last_error_code,
            error_message="test failure",
            finished_at=datetime.now(UTC),
        )
    )
    session.commit()
    return media.id


def create_ready_epub_with_chapters(
    session: Session,
    *,
    num_chapters: int = 3,
    with_toc: bool = True,
) -> tuple[UUID, list[UUID]]:
    """Create a ready EPUB with contiguous chapter fragments and optional TOC nodes.

    Returns (media_id, [fragment_ids]).
    """
    media = Media(
        id=uuid4(),
        kind=MediaKind.epub.value,
        title="Test EPUB Book",
        processing_status=ProcessingStatus.ready_for_reading,
    )
    session.add(media)
    session.flush()

    frag_ids: list[UUID] = []
    for i in range(num_chapters):
        html = f"<h2>Chapter {i + 1} Title</h2><p>Sentinel content for chapter {i}.</p>"
        canon = f"Chapter {i + 1} Title\nSentinel content for chapter {i}."
        frag = Fragment(
            id=uuid4(),
            media_id=media.id,
            idx=i,
            html_sanitized=html,
            canonical_text=canon,
        )
        session.add(frag)
        session.flush()
        frag_ids.append(frag.id)

    if with_toc:
        for i in range(num_chapters):
            node = EpubTocNode(
                media_id=media.id,
                node_id=f"ch{i}",
                parent_node_id=None,
                label=f"TOC Chapter {i + 1}",
                href=f"ch{i}.xhtml",
                fragment_idx=i,
                depth=0,
                order_key=f"{i + 1:04d}",
            )
            session.add(node)
        session.flush()

    for i in range(num_chapters):
        href_path = f"ch{i}.xhtml"
        session.add(
            EpubNavLocation(
                media_id=media.id,
                location_id=href_path,
                ordinal=i,
                source_node_id=f"ch{i}" if with_toc else None,
                label=f"TOC Chapter {i + 1}" if with_toc else f"Chapter {i + 1} Title",
                fragment_idx=i,
                href_path=href_path,
                href_fragment=None,
                source="toc" if with_toc else "spine",
            )
        )
    session.flush()

    fragments = (
        session.query(Fragment)
        .filter(Fragment.media_id == media.id)
        .order_by(Fragment.idx.asc())
        .all()
    )
    rebuild_fragment_content_index(
        session,
        media_id=media.id,
        source_kind="epub",
        fragments=fragments,
        reason="test_factory",
    )

    session.commit()
    return media.id, frag_ids


def create_seeded_test_media(
    session: Session,
    *,
    title: str,
    canonical_text: str,
    html_sanitized: str,
    media_id: UUID | None = None,
    fragment_id: UUID | None = None,
) -> UUID:
    """Create media + a single fragment for seeded test data.

    Uses merge() for idempotent inserts (ON CONFLICT DO NOTHING semantics).
    Returns media_id.
    """
    mid = media_id or uuid4()
    fid = fragment_id or uuid4()

    # Use merge to handle ON CONFLICT DO NOTHING semantics
    media = Media(
        id=mid,
        kind=MediaKind.web_article.value,
        title=title,
        canonical_source_url="https://example.com/test-article",
        processing_status=ProcessingStatus.ready_for_reading,
    )
    session.merge(media)
    session.flush()

    fragment = Fragment(
        id=fid,
        media_id=mid,
        idx=0,
        html_sanitized=html_sanitized,
        canonical_text=canonical_text,
    )
    session.merge(fragment)
    session.flush()

    session.commit()
    return mid


# =============================================================================
# Helpers
# =============================================================================


def get_user_library(session: Session, user_id: UUID) -> UUID | None:
    """Get a user's default library ID via their admin membership."""
    membership = (
        session.query(Membership)
        .filter(
            Membership.user_id == user_id,
            Membership.role == "admin",
        )
        .limit(1)
        .first()
    )
    return membership.library_id if membership else None


# =============================================================================
def create_normalized_fragment_highlight(
    session: Session,
    user_id: UUID,
    fragment_id: UUID,
    media_id: UUID,
    start_offset: int = 0,
    end_offset: int = 20,
    exact: str = "highlighted text",
) -> UUID:
    """Create a fully normalized fragment highlight with its subtype row."""
    highlight = Highlight(
        id=uuid4(),
        user_id=user_id,
        anchor_kind="fragment_offsets",
        anchor_media_id=media_id,
        color="yellow",
        exact=exact,
        prefix="",
        suffix="",
    )
    session.add(highlight)
    session.flush()

    fa = HighlightFragmentAnchor(
        highlight_id=highlight.id,
        fragment_id=fragment_id,
        start_offset=start_offset,
        end_offset=end_offset,
    )
    session.add(fa)
    session.commit()
    return highlight.id


def create_pdf_media_with_text(
    session: Session,
    user_id: UUID,
    library_id: UUID,
    *,
    title: str = "Test PDF",
    plain_text: str = "Page one text. Page two text.",
    page_count: int = 2,
    page_spans: list[tuple[int, int]] | None = None,
    status: str = "ready_for_reading",
) -> UUID:
    """Create PDF media with plain_text, page_count, and PdfPageTextSpan rows.

    If page_spans is None, splits plain_text evenly across pages.
    page_spans is a list of (start_offset, end_offset) tuples, one per page.
    """
    media = Media(
        id=uuid4(),
        kind=MediaKind.pdf.value,
        title=title,
        processing_status=ProcessingStatus(status),
        created_by_user_id=user_id,
        plain_text=plain_text,
        page_count=page_count,
    )
    session.add(media)
    session.flush()
    add_media_to_library(session, library_id, media.id)

    if page_spans is None:
        chunk_size = len(plain_text) // page_count
        page_spans = []
        for i in range(page_count):
            start = i * chunk_size
            end = (i + 1) * chunk_size if i < page_count - 1 else len(plain_text)
            page_spans.append((start, end))

    for i, (start, end) in enumerate(page_spans):
        session.add(
            PdfPageTextSpan(
                media_id=media.id,
                page_number=i + 1,
                start_offset=start,
                end_offset=end,
            )
        )

    session.commit()
    return media.id


def create_mismatched_fragment_highlight(
    session: Session,
    user_id: UUID,
    fragment_id: UUID,
    media_id: UUID,
    other_fragment_id: UUID,
    start_offset: int = 0,
    end_offset: int = 20,
) -> UUID:
    """Create a fragment highlight whose subtype row points to another fragment."""
    highlight = Highlight(
        id=uuid4(),
        user_id=user_id,
        anchor_kind="fragment_offsets",
        anchor_media_id=media_id,
        color="yellow",
        exact="mismatched",
        prefix="",
        suffix="",
    )
    session.add(highlight)
    session.flush()

    fa = HighlightFragmentAnchor(
        highlight_id=highlight.id,
        fragment_id=other_fragment_id,
        start_offset=start_offset,
        end_offset=end_offset,
    )
    session.add(fa)
    session.commit()
    return highlight.id
