"""Test data factories.

Centralizes helper functions that create database rows for tests.
Each factory knows the full schema requirements for its table,
so individual tests don't need to track NOT NULL constraints.

When a column is added or a constraint changes, update the
relevant factory here — not in N test files.
"""

from datetime import UTC, datetime
from uuid import UUID, uuid4

from sqlalchemy.orm import Session

from nexus.db.models import (
    Annotation,
    Conversation,
    ConversationShare,
    DefaultLibraryIntrinsic,
    EpubTocNode,
    FailureStage,
    Fragment,
    Highlight,
    HighlightFragmentAnchor,
    Library,
    LibraryMedia,
    Media,
    MediaFile,
    MediaKind,
    Membership,
    Message,
    Model,
    PdfPageTextSpan,
    ProcessingStatus,
)

# =============================================================================
# Models
# =============================================================================


def create_test_model(session: Session) -> UUID:
    """Get or create a test model.

    Uses the migration-seeded gpt-5.4-mini row if it exists,
    otherwise inserts a complete row with all NOT NULL columns.
    """
    existing = (
        session.query(Model)
        .filter(Model.provider == "openai", Model.model_name == "gpt-5.4-mini")
        .first()
    )
    if existing:
        return existing.id

    model = Model(
        id=uuid4(),
        provider="openai",
        model_name="gpt-5.4-mini",
        max_context_tokens=400000,
        is_available=True,
    )
    session.add(model)
    session.commit()
    return model.id


def seed_test_models(session: Session) -> None:
    """Seed the full set of test models if none exist."""
    if session.query(Model).count() > 0:
        return

    for provider, model_name, max_tokens in [
        ("openai", "gpt-5.4-mini", 400000),
        ("openai", "gpt-4.1-nano", 1047576),
        ("anthropic", "claude-opus-4-6", 1000000),
        ("anthropic", "claude-sonnet-4-6", 1000000),
        ("anthropic", "claude-haiku-4-5-20251001", 200000),
        ("gemini", "gemini-2.5-pro", 1048576),
        ("gemini", "gemini-2.5-flash", 1048576),
        ("deepseek", "deepseek-chat", 128000),
        ("deepseek", "deepseek-reasoner", 128000),
    ]:
        session.add(
            Model(
                provider=provider,
                model_name=model_name,
                max_context_tokens=max_tokens,
                is_available=True,
            )
        )
    session.commit()


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


def create_test_message(
    session: Session,
    conversation_id: UUID,
    seq: int,
    role: str = "user",
    content: str = "Test message",
    status: str = "complete",
    model_id: UUID | None = None,
) -> UUID:
    """Create a test message and bump the conversation's next_seq."""
    msg = Message(
        id=uuid4(),
        conversation_id=conversation_id,
        seq=seq,
        role=role,
        content=content,
        status=status,
        model_id=model_id,
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
        next_seq=2,
    )
    session.add(conv)
    session.flush()
    msg = Message(
        id=uuid4(),
        conversation_id=conv.id,
        seq=1,
        role=role,
        content=content,
        status=status,
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


def create_test_media_in_library(
    session: Session,
    user_id: UUID,
    library_id: UUID,
    *,
    title: str = "Test Article",
    status: str = "ready_for_reading",
) -> UUID:
    """Create media and link it to a specific library.

    Also seeds default_library_intrinsics if the library is a default library.
    """
    media = Media(
        id=uuid4(),
        kind=MediaKind.web_article.value,
        title=title,
        canonical_source_url="https://example.com/article",
        processing_status=ProcessingStatus(status),
    )
    session.add(media)
    session.flush()
    session.add(LibraryMedia(library_id=library_id, media_id=media.id))
    lib = session.get(Library, library_id)
    if lib and lib.is_default:
        session.add(
            DefaultLibraryIntrinsic(
                default_library_id=library_id,
                media_id=media.id,
            )
        )
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
    default_libs = (
        session.query(Library)
        .filter(
            Library.owner_user_id == user_id,
            Library.is_default.is_(True),
        )
        .all()
    )
    for lib in default_libs:
        session.merge(LibraryMedia(library_id=lib.id, media_id=media.id))
        session.merge(
            DefaultLibraryIntrinsic(
                default_library_id=lib.id,
                media_id=media.id,
            )
        )
    session.commit()
    return media.id


# =============================================================================
# Fragments, Highlights, Annotations
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
    highlight = Highlight(
        id=uuid4(),
        user_id=user_id,
        fragment_id=fragment_id,
        start_offset=0,
        end_offset=20,
        color="yellow",
        exact=exact,
        prefix="",
        suffix="",
    )
    session.add(highlight)
    session.commit()
    return highlight.id


def create_test_annotation(
    session: Session,
    user_id: UUID,
    media_id: UUID,
    body: str = "Test annotation body",
) -> tuple[UUID, UUID]:
    """Create a highlight and annotation for a media item.

    Looks up the first fragment of the media item automatically.
    Returns (highlight_id, annotation_id).
    """
    fragment = session.query(Fragment).filter(Fragment.media_id == media_id).limit(1).first()
    if not fragment:
        raise ValueError(f"No fragment found for media {media_id}")

    highlight = Highlight(
        id=uuid4(),
        user_id=user_id,
        fragment_id=fragment.id,
        start_offset=0,
        end_offset=10,
        color="yellow",
        exact="test exact",
        prefix="prefix",
        suffix="suffix",
    )
    session.add(highlight)
    session.flush()
    annotation = Annotation(
        id=uuid4(),
        highlight_id=highlight.id,
        body=body,
    )
    session.add(annotation)
    session.commit()
    return highlight.id, annotation.id


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

    Unlike create_searchable_media, does NOT create intrinsic rows for the
    user's default library.  Visibility comes solely from membership in
    the target library.
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
    session.merge(LibraryMedia(library_id=library_id, media_id=media.id))
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
    session.add(LibraryMedia(library_id=library_id, media_id=media.id))
    lib = session.get(Library, library_id)
    if lib and lib.is_default:
        session.add(
            DefaultLibraryIntrinsic(
                default_library_id=library_id,
                media_id=media.id,
            )
        )
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
    file_sha256: str | None = None,
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
        file_sha256=file_sha256,
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
# S6 PR-02: Typed-Highlight Test Factories
# =============================================================================


def create_dormant_fragment_highlight(
    session: Session,
    user_id: UUID,
    fragment_id: UUID,
    start_offset: int = 0,
    end_offset: int = 20,
    exact: str = "highlighted text",
) -> UUID:
    """Create a highlight in pr-01 dormant-window shape.

    Legacy bridge fields populated, anchor_kind/anchor_media_id NULL,
    no highlight_fragment_anchors subtype row.
    """
    highlight = Highlight(
        id=uuid4(),
        user_id=user_id,
        fragment_id=fragment_id,
        start_offset=start_offset,
        end_offset=end_offset,
        anchor_kind=None,
        anchor_media_id=None,
        color="yellow",
        exact=exact,
        prefix="",
        suffix="",
    )
    session.add(highlight)
    session.commit()
    return highlight.id


def create_normalized_fragment_highlight(
    session: Session,
    user_id: UUID,
    fragment_id: UUID,
    media_id: UUID,
    start_offset: int = 0,
    end_offset: int = 20,
    exact: str = "highlighted text",
) -> UUID:
    """Create a fully normalized fragment highlight (pr-02 canonical shape).

    Logical fields set, legacy bridge populated, fragment_anchor subtype row present.
    """
    highlight = Highlight(
        id=uuid4(),
        user_id=user_id,
        fragment_id=fragment_id,
        start_offset=start_offset,
        end_offset=end_offset,
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
    session.add(LibraryMedia(library_id=library_id, media_id=media.id))
    lib = session.get(Library, library_id)
    if lib and lib.is_default:
        session.add(
            DefaultLibraryIntrinsic(
                default_library_id=library_id,
                media_id=media.id,
            )
        )

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
                text_extract_version=1,
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
    """Create a fragment highlight with irreconcilable bridge-vs-subtype mismatch.

    Legacy bridge points to fragment_id but subtype row points to other_fragment_id.
    """
    highlight = Highlight(
        id=uuid4(),
        user_id=user_id,
        fragment_id=fragment_id,
        start_offset=start_offset,
        end_offset=end_offset,
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
