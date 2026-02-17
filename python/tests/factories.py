"""Test data factories.

Centralizes helper functions that create database rows for tests.
Each factory knows the full schema requirements for its table,
so individual tests don't need to track NOT NULL constraints.

When a column is added or a constraint changes, update the
relevant factory here — not in N test files.
"""

from uuid import UUID, uuid4

from sqlalchemy import text
from sqlalchemy.orm import Session

# =============================================================================
# Models
# =============================================================================


def create_test_model(session: Session) -> UUID:
    """Get or create a test model.

    Uses the migration-seeded gpt-4o row if it exists,
    otherwise inserts a complete row with all NOT NULL columns.
    """
    result = session.execute(
        text("SELECT id FROM models WHERE provider = 'openai' AND model_name = 'gpt-4o'")
    )
    row = result.fetchone()
    if row:
        return row[0]

    model_id = uuid4()
    session.execute(
        text("""
            INSERT INTO models (id, provider, model_name, max_context_tokens, is_available)
            VALUES (:id, 'openai', 'gpt-4o', 128000, true)
        """),
        {"id": model_id},
    )
    session.commit()
    return model_id


def seed_test_models(session: Session) -> None:
    """Seed the full set of test models if none exist."""
    result = session.execute(text("SELECT COUNT(*) FROM models"))
    if result.scalar() > 0:
        return

    session.execute(
        text("""
            INSERT INTO models (id, provider, model_name, max_context_tokens, is_available)
            VALUES
                (gen_random_uuid(), 'openai', 'gpt-4o-mini', 128000, true),
                (gen_random_uuid(), 'openai', 'gpt-4o', 128000, true),
                (gen_random_uuid(), 'anthropic', 'claude-sonnet-4-20250514', 200000, true),
                (gen_random_uuid(), 'anthropic', 'claude-haiku-4-20250514', 200000, true),
                (gen_random_uuid(), 'gemini', 'gemini-2.0-flash', 1000000, true)
            ON CONFLICT DO NOTHING
        """)
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
    conversation_id = uuid4()
    session.execute(
        text("""
            INSERT INTO conversations (id, owner_user_id, sharing, next_seq)
            VALUES (:id, :owner_user_id, :sharing, 1)
        """),
        {"id": conversation_id, "owner_user_id": owner_user_id, "sharing": sharing},
    )
    session.commit()
    return conversation_id


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
    message_id = uuid4()
    session.execute(
        text("""
            INSERT INTO messages (id, conversation_id, seq, role, content, status, model_id)
            VALUES (:id, :conversation_id, :seq, :role, :content, :status, :model_id)
        """),
        {
            "id": message_id,
            "conversation_id": conversation_id,
            "seq": seq,
            "role": role,
            "content": content,
            "status": status,
            "model_id": model_id,
        },
    )
    session.execute(
        text("UPDATE conversations SET next_seq = :next_seq WHERE id = :id"),
        {"next_seq": seq + 1, "id": conversation_id},
    )
    session.commit()
    return message_id


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
    conversation_id = uuid4()
    message_id = uuid4()

    session.execute(
        text("""
            INSERT INTO conversations (id, owner_user_id, sharing, next_seq)
            VALUES (:id, :user_id, 'private', 2)
        """),
        {"id": conversation_id, "user_id": user_id},
    )
    session.execute(
        text("""
            INSERT INTO messages (id, conversation_id, seq, role, content, status)
            VALUES (:id, :conversation_id, 1, :role, :content, :status)
        """),
        {
            "id": message_id,
            "conversation_id": conversation_id,
            "content": content,
            "status": status,
            "role": role,
        },
    )
    session.commit()
    return conversation_id, message_id


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
    media_id = uuid4()
    session.execute(
        text("""
            INSERT INTO media (id, kind, title, canonical_source_url, processing_status)
            VALUES (:id, 'web_article', :title, 'https://example.com/test', :status)
        """),
        {"id": media_id, "title": title, "status": status},
    )
    session.commit()
    return media_id


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
    media_id = uuid4()
    session.execute(
        text("""
            INSERT INTO media (id, kind, title, canonical_source_url, processing_status)
            VALUES (:id, 'web_article', :title, 'https://example.com/article', :status)
        """),
        {"id": media_id, "title": title, "status": status},
    )
    session.execute(
        text("""
            INSERT INTO library_media (library_id, media_id)
            VALUES (:library_id, :media_id)
        """),
        {"library_id": library_id, "media_id": media_id},
    )
    session.execute(
        text("""
            INSERT INTO default_library_intrinsics (default_library_id, media_id)
            SELECT :library_id, :media_id
            WHERE EXISTS (
                SELECT 1 FROM libraries WHERE id = :library_id AND is_default = true
            )
            ON CONFLICT DO NOTHING
        """),
        {"library_id": library_id, "media_id": media_id},
    )
    session.commit()
    return media_id


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
    media_id = uuid4()
    fragment_id = uuid4()

    session.execute(
        text("""
            INSERT INTO media (id, kind, title, processing_status, created_by_user_id)
            VALUES (:id, 'web_article', :title, 'ready_for_reading', :user_id)
        """),
        {"id": media_id, "title": title, "user_id": user_id},
    )
    session.execute(
        text("""
            INSERT INTO fragments (id, media_id, idx, html_sanitized, canonical_text)
            VALUES (:id, :media_id, 0, '<p>Test content</p>', :text)
        """),
        {
            "id": fragment_id,
            "media_id": media_id,
            "text": f"This is the canonical text for {title}. It contains searchable content about various topics.",
        },
    )
    session.execute(
        text("""
            INSERT INTO library_media (library_id, media_id)
            SELECT l.id, :media_id
            FROM libraries l
            WHERE l.owner_user_id = :user_id AND l.is_default = true
            ON CONFLICT DO NOTHING
        """),
        {"media_id": media_id, "user_id": user_id},
    )
    session.execute(
        text("""
            INSERT INTO default_library_intrinsics (default_library_id, media_id)
            SELECT l.id, :media_id
            FROM libraries l
            WHERE l.owner_user_id = :user_id AND l.is_default = true
            ON CONFLICT DO NOTHING
        """),
        {"media_id": media_id, "user_id": user_id},
    )
    session.commit()
    return media_id


# =============================================================================
# Fragments, Highlights, Annotations
# =============================================================================


def create_test_fragment(
    session: Session, media_id: UUID, content: str = "Fragment content"
) -> UUID:
    """Create a test fragment for a media item."""
    fragment_id = uuid4()
    session.execute(
        text("""
            INSERT INTO fragments (id, media_id, idx, canonical_text, html_sanitized)
            VALUES (:id, :media_id, 0, :content, :html)
        """),
        {"id": fragment_id, "media_id": media_id, "content": content, "html": f"<p>{content}</p>"},
    )
    session.commit()
    return fragment_id


def create_test_highlight(
    session: Session,
    user_id: UUID,
    fragment_id: UUID,
    exact: str = "highlighted text",
) -> UUID:
    """Create a test highlight on a fragment."""
    highlight_id = uuid4()
    session.execute(
        text("""
            INSERT INTO highlights (id, user_id, fragment_id, start_offset, end_offset,
                                    color, exact, prefix, suffix)
            VALUES (:id, :user_id, :fragment_id, 0, 20, 'yellow', :exact, '', '')
        """),
        {"id": highlight_id, "user_id": user_id, "fragment_id": fragment_id, "exact": exact},
    )
    session.commit()
    return highlight_id


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
    highlight_id = uuid4()
    annotation_id = uuid4()

    result = session.execute(
        text("SELECT id FROM fragments WHERE media_id = :media_id LIMIT 1"),
        {"media_id": media_id},
    )
    row = result.fetchone()
    if not row:
        raise ValueError(f"No fragment found for media {media_id}")
    fragment_id = row[0]

    session.execute(
        text("""
            INSERT INTO highlights (id, user_id, fragment_id, start_offset, end_offset,
                                    color, exact, prefix, suffix)
            VALUES (:id, :user_id, :fragment_id, 0, 10, 'yellow', 'test exact', 'prefix', 'suffix')
        """),
        {"id": highlight_id, "user_id": user_id, "fragment_id": fragment_id},
    )
    session.execute(
        text("""
            INSERT INTO annotations (id, highlight_id, body)
            VALUES (:id, :highlight_id, :body)
        """),
        {"id": annotation_id, "highlight_id": highlight_id, "body": body},
    )
    session.commit()
    return highlight_id, annotation_id


# =============================================================================
# Libraries
# =============================================================================


def create_test_library(session: Session, user_id: UUID, name: str = "Test Library") -> UUID:
    """Create a non-default library with the user as admin."""
    library_id = uuid4()

    session.execute(
        text("""
            INSERT INTO libraries (id, owner_user_id, name, is_default)
            VALUES (:id, :user_id, :name, false)
        """),
        {"id": library_id, "user_id": user_id, "name": name},
    )
    session.execute(
        text("""
            INSERT INTO memberships (library_id, user_id, role)
            VALUES (:library_id, :user_id, 'admin')
        """),
        {"library_id": library_id, "user_id": user_id},
    )
    session.commit()
    return library_id


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
    session.execute(
        text("""
            INSERT INTO memberships (library_id, user_id, role)
            VALUES (:library_id, :user_id, :role)
            ON CONFLICT DO NOTHING
        """),
        {"library_id": library_id, "user_id": user_id, "role": role},
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
    session.execute(
        text("""
            UPDATE conversations SET sharing = 'library'
            WHERE id = :conversation_id AND sharing != 'library'
        """),
        {"conversation_id": conversation_id},
    )
    session.execute(
        text("""
            INSERT INTO conversation_shares (conversation_id, library_id)
            VALUES (:conversation_id, :library_id)
            ON CONFLICT DO NOTHING
        """),
        {"conversation_id": conversation_id, "library_id": library_id},
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
    media_id = uuid4()
    fragment_id = uuid4()

    session.execute(
        text("""
            INSERT INTO media (id, kind, title, processing_status, created_by_user_id)
            VALUES (:id, 'web_article', :title, 'ready_for_reading', :user_id)
        """),
        {"id": media_id, "title": title, "user_id": user_id},
    )
    session.execute(
        text("""
            INSERT INTO fragments (id, media_id, idx, html_sanitized, canonical_text)
            VALUES (:id, :media_id, 0, '<p>Test content</p>', :text)
        """),
        {
            "id": fragment_id,
            "media_id": media_id,
            "text": f"This is the canonical text for {title}. It contains searchable content about various topics.",
        },
    )
    session.execute(
        text("""
            INSERT INTO library_media (library_id, media_id)
            VALUES (:library_id, :media_id)
            ON CONFLICT DO NOTHING
        """),
        {"library_id": library_id, "media_id": media_id},
    )
    session.commit()
    return media_id


def get_user_default_library(session: Session, user_id: UUID) -> UUID:
    """Get a user's default library ID."""
    result = session.execute(
        text("""
            SELECT id FROM libraries
            WHERE owner_user_id = :user_id AND is_default = true
        """),
        {"user_id": user_id},
    )
    row = result.fetchone()
    return row[0] if row else None


# =============================================================================
# Helpers
# =============================================================================


def get_user_library(session: Session, user_id: UUID) -> UUID:
    """Get a user's default library ID via their admin membership."""
    result = session.execute(
        text("""
            SELECT library_id FROM memberships
            WHERE user_id = :user_id AND role = 'admin'
            LIMIT 1
        """),
        {"user_id": user_id},
    )
    row = result.fetchone()
    return row[0] if row else None
