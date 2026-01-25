"""SQLAlchemy ORM models for Nexus.

Defines all database tables using SQLAlchemy 2.x declarative patterns.
Enums are defined as Python enums and mapped to PostgreSQL enum types.
"""

from datetime import datetime
from enum import Enum as PyEnum
from uuid import UUID

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    Enum,
    ForeignKey,
    Integer,
    Text,
    UniqueConstraint,
    text,
)
from sqlalchemy.dialects.postgresql import TIMESTAMP
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


class Base(DeclarativeBase):
    """Base class for all ORM models."""

    pass


# =============================================================================
# Enums
# =============================================================================


class ProcessingStatus(str, PyEnum):
    """Media processing lifecycle states.

    States:
        pending: Created, waiting for job pickup
        extracting: Extraction requested and in-flight or queued
        ready_for_reading: Minimum readable artifacts exist
        embedding: Readable; embedding job in-flight or queued
        ready: All processing complete
        failed: Terminal failure recorded
    """

    pending = "pending"
    extracting = "extracting"
    ready_for_reading = "ready_for_reading"
    embedding = "embedding"
    ready = "ready"
    failed = "failed"


class FailureStage(str, PyEnum):
    """Stage at which processing failed.

    Used to determine reset behavior on retry.
    """

    upload = "upload"
    extract = "extract"
    transcribe = "transcribe"
    embed = "embed"
    other = "other"


class MediaKind(str, PyEnum):
    """Types of media that can be ingested."""

    web_article = "web_article"
    epub = "epub"
    pdf = "pdf"
    video = "video"
    podcast_episode = "podcast_episode"


class MembershipRole(str, PyEnum):
    """Roles a user can have in a library."""

    admin = "admin"
    member = "member"


# =============================================================================
# Models
# =============================================================================


class User(Base):
    """User account model.

    The user ID matches the Supabase auth user ID (sub claim).
    """

    __tablename__ = "users"

    id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        primary_key=True,
        server_default=text("gen_random_uuid()"),
    )
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True),
        server_default=text("now()"),
        nullable=False,
    )

    # Relationships
    libraries: Mapped[list["Library"]] = relationship(
        "Library", back_populates="owner", cascade="all, delete-orphan"
    )
    memberships: Mapped[list["Membership"]] = relationship(
        "Membership", back_populates="user", cascade="all, delete-orphan"
    )


class Library(Base):
    """Library model - an access-control group + view over media."""

    __tablename__ = "libraries"

    id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        primary_key=True,
        server_default=text("gen_random_uuid()"),
    )
    owner_user_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
    )
    name: Mapped[str] = mapped_column(Text, nullable=False)
    is_default: Mapped[bool] = mapped_column(Boolean, server_default="false", nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True),
        server_default=text("now()"),
        nullable=False,
    )
    updated_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True),
        server_default=text("now()"),
        nullable=False,
    )

    __table_args__ = (
        CheckConstraint(
            "char_length(name) BETWEEN 1 AND 100",
            name="ck_libraries_name_length",
        ),
    )

    # Relationships
    owner: Mapped["User"] = relationship("User", back_populates="libraries")
    memberships: Mapped[list["Membership"]] = relationship(
        "Membership", back_populates="library", cascade="all, delete-orphan"
    )
    library_media: Mapped[list["LibraryMedia"]] = relationship(
        "LibraryMedia", back_populates="library", cascade="all, delete-orphan"
    )


class Membership(Base):
    """Library membership model - user's role in a library."""

    __tablename__ = "memberships"

    library_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("libraries.id", ondelete="CASCADE"),
        primary_key=True,
    )
    user_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        primary_key=True,
    )
    role: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True),
        server_default=text("now()"),
        nullable=False,
    )

    __table_args__ = (
        CheckConstraint(
            "role IN ('admin', 'member')",
            name="ck_memberships_role",
        ),
    )

    # Relationships
    library: Mapped["Library"] = relationship("Library", back_populates="memberships")
    user: Mapped["User"] = relationship("User", back_populates="memberships")


class Media(Base):
    """Media model - a readable item (article, book, podcast, video, etc.)."""

    __tablename__ = "media"

    id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        primary_key=True,
        server_default=text("gen_random_uuid()"),
    )
    kind: Mapped[str] = mapped_column(Text, nullable=False)
    title: Mapped[str] = mapped_column(Text, nullable=False)
    canonical_source_url: Mapped[str | None] = mapped_column(Text, nullable=True)

    # S1 processing lifecycle fields
    processing_status: Mapped[ProcessingStatus] = mapped_column(
        Enum(
            ProcessingStatus,
            name="processing_status_enum",
            create_type=False,  # Type created in migration
        ),
        server_default="pending",
        nullable=False,
    )
    failure_stage: Mapped[FailureStage | None] = mapped_column(
        Enum(
            FailureStage,
            name="failure_stage_enum",
            create_type=False,  # Type created in migration
        ),
        nullable=True,
    )
    last_error_code: Mapped[str | None] = mapped_column(Text, nullable=True)
    last_error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    processing_attempts: Mapped[int] = mapped_column(Integer, server_default="0", nullable=False)
    processing_started_at: Mapped[datetime | None] = mapped_column(
        TIMESTAMP(timezone=True), nullable=True
    )
    processing_completed_at: Mapped[datetime | None] = mapped_column(
        TIMESTAMP(timezone=True), nullable=True
    )
    failed_at: Mapped[datetime | None] = mapped_column(TIMESTAMP(timezone=True), nullable=True)

    # S1 URL/file identity fields
    requested_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    canonical_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    file_sha256: Mapped[str | None] = mapped_column(Text, nullable=True)
    external_playback_url: Mapped[str | None] = mapped_column(Text, nullable=True)

    # S1 provider fields (for future S7/S8)
    provider: Mapped[str | None] = mapped_column(Text, nullable=True)
    provider_id: Mapped[str | None] = mapped_column(Text, nullable=True)

    # S1 creator tracking
    created_by_user_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )

    # Timestamps
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True),
        server_default=text("now()"),
        nullable=False,
    )
    updated_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True),
        server_default=text("now()"),
        nullable=False,
    )

    __table_args__ = (
        CheckConstraint(
            "kind IN ('web_article', 'epub', 'pdf', 'video', 'podcast_episode')",
            name="ck_media_kind",
        ),
        # Note: processing_status and failure_stage use PostgreSQL enum types,
        # so CHECK constraints are not needed - the enum enforces valid values.
        CheckConstraint(
            "requested_url IS NULL OR char_length(requested_url) <= 2048",
            name="ck_media_requested_url_length",
        ),
        CheckConstraint(
            "canonical_url IS NULL OR char_length(canonical_url) <= 2048",
            name="ck_media_canonical_url_length",
        ),
    )

    # Relationships
    created_by: Mapped["User | None"] = relationship("User")
    fragments: Mapped[list["Fragment"]] = relationship(
        "Fragment", back_populates="media", cascade="all, delete-orphan"
    )
    library_media: Mapped[list["LibraryMedia"]] = relationship(
        "LibraryMedia", back_populates="media", cascade="all, delete-orphan"
    )
    media_file: Mapped["MediaFile | None"] = relationship(
        "MediaFile", back_populates="media", cascade="all, delete-orphan", uselist=False
    )


class MediaFile(Base):
    """Media file storage metadata (0..1 per media).

    Stores metadata about files uploaded to Supabase Storage.
    The actual file is stored in storage, not in the database.
    """

    __tablename__ = "media_file"

    media_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("media.id", ondelete="CASCADE"),
        primary_key=True,
    )
    storage_path: Mapped[str] = mapped_column(Text, nullable=False)
    content_type: Mapped[str] = mapped_column(Text, nullable=False)
    size_bytes: Mapped[int] = mapped_column(BigInteger, nullable=False)

    # Relationship
    media: Mapped["Media"] = relationship("Media", back_populates="media_file")


class Fragment(Base):
    """Fragment model - an immutable render unit of a media item."""

    __tablename__ = "fragments"

    id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        primary_key=True,
        server_default=text("gen_random_uuid()"),
    )
    media_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("media.id", ondelete="CASCADE"),
        nullable=False,
    )
    idx: Mapped[int] = mapped_column(Integer, nullable=False)
    canonical_text: Mapped[str] = mapped_column(Text, nullable=False)
    html_sanitized: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True),
        server_default=text("now()"),
        nullable=False,
    )

    __table_args__ = (UniqueConstraint("media_id", "idx", name="uq_fragments_media_idx"),)

    # Relationships
    media: Mapped["Media"] = relationship("Media", back_populates="fragments", lazy="joined")
    highlights: Mapped[list["Highlight"]] = relationship(
        "Highlight", back_populates="fragment", cascade="all, delete-orphan"
    )


class LibraryMedia(Base):
    """Association between libraries and media."""

    __tablename__ = "library_media"

    library_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("libraries.id", ondelete="CASCADE"),
        primary_key=True,
    )
    media_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("media.id", ondelete="CASCADE"),
        primary_key=True,
    )
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True),
        server_default=text("now()"),
        nullable=False,
    )

    # Relationships
    library: Mapped["Library"] = relationship("Library", back_populates="library_media")
    media: Mapped["Media"] = relationship("Media", back_populates="library_media")


# =============================================================================
# Slice 2: Highlights + Annotations
# =============================================================================


class Highlight(Base):
    """Highlight model - a user-owned selection in a fragment.

    Offsets are half-open [start_offset, end_offset) in Unicode codepoints
    over fragment.canonical_text. Overlapping highlights are allowed.
    Duplicate highlights at the exact same span by the same user are forbidden.

    The exact, prefix, and suffix fields are server-derived and persisted for:
    - Cheap reads
    - Debugging
    - Future repair tooling (out of scope for v1)
    """

    __tablename__ = "highlights"

    id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        primary_key=True,
        server_default=text("gen_random_uuid()"),
    )
    user_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
    )
    fragment_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("fragments.id", ondelete="CASCADE"),
        nullable=False,
    )
    start_offset: Mapped[int] = mapped_column(Integer, nullable=False)
    end_offset: Mapped[int] = mapped_column(Integer, nullable=False)
    color: Mapped[str] = mapped_column(Text, nullable=False)
    exact: Mapped[str] = mapped_column(Text, nullable=False)
    prefix: Mapped[str] = mapped_column(Text, nullable=False)
    suffix: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True),
        server_default=text("now()"),
        nullable=False,
    )
    updated_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True),
        server_default=text("now()"),
        nullable=False,
    )

    __table_args__ = (
        CheckConstraint(
            "start_offset >= 0 AND end_offset > start_offset",
            name="ck_highlights_offsets_valid",
        ),
        CheckConstraint(
            "color IN ('yellow','green','blue','pink','purple')",
            name="ck_highlights_color",
        ),
        UniqueConstraint(
            "user_id",
            "fragment_id",
            "start_offset",
            "end_offset",
            name="uix_highlights_user_fragment_offsets",
        ),
    )

    # Relationships (PR-06)
    fragment: Mapped["Fragment"] = relationship(
        "Fragment", back_populates="highlights", lazy="joined"
    )
    annotation: Mapped["Annotation | None"] = relationship(
        "Annotation",
        uselist=False,
        back_populates="highlight",
        lazy="joined",
        passive_deletes=True,  # Let database handle ON DELETE CASCADE
    )


class Annotation(Base):
    """Annotation model - optional note attached to a highlight (0..1).

    An annotation does not have its own user_id; ownership is derived via
    highlights.user_id to avoid ownership drift.

    Deleting a highlight cascades to delete its annotation.
    Deleting an annotation leaves the highlight intact (service behavior).
    """

    __tablename__ = "annotations"

    id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        primary_key=True,
        server_default=text("gen_random_uuid()"),
    )
    highlight_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("highlights.id", ondelete="CASCADE"),
        nullable=False,
    )
    body: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True),
        server_default=text("now()"),
        nullable=False,
    )
    updated_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True),
        server_default=text("now()"),
        nullable=False,
    )

    __table_args__ = (
        UniqueConstraint(
            "highlight_id",
            name="uix_annotations_one_per_highlight",
        ),
    )

    # Relationships (PR-06)
    highlight: Mapped["Highlight"] = relationship("Highlight", back_populates="annotation")


# =============================================================================
# Slice 3: Chat + Conversations + LLM Infrastructure
# =============================================================================


class SharingMode(str, PyEnum):
    """Sharing modes for social objects (conversations, highlights, annotations)."""

    private = "private"
    library = "library"
    public = "public"


class MessageRole(str, PyEnum):
    """Roles for messages in a conversation."""

    user = "user"
    assistant = "assistant"
    system = "system"


class MessageStatus(str, PyEnum):
    """Status of a message."""

    pending = "pending"
    complete = "complete"
    error = "error"


class LLMProvider(str, PyEnum):
    """Supported LLM providers."""

    openai = "openai"
    anthropic = "anthropic"
    gemini = "gemini"


class KeyModeRequested(str, PyEnum):
    """Requested key mode for LLM calls."""

    auto = "auto"
    byok_only = "byok_only"
    platform_only = "platform_only"


class KeyModeUsed(str, PyEnum):
    """Actual key mode used for LLM calls."""

    platform = "platform"
    byok = "byok"


class ApiKeyStatus(str, PyEnum):
    """Status of a user API key."""

    untested = "untested"
    valid = "valid"
    invalid = "invalid"
    revoked = "revoked"


class ContextTargetType(str, PyEnum):
    """Types of context targets for message_context."""

    media = "media"
    highlight = "highlight"
    annotation = "annotation"


class Conversation(Base):
    """Conversation model - a thread of messages owned by one user."""

    __tablename__ = "conversations"

    id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        primary_key=True,
        server_default=text("gen_random_uuid()"),
    )
    owner_user_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
    )
    sharing: Mapped[str] = mapped_column(Text, nullable=False, server_default="private")
    next_seq: Mapped[int] = mapped_column(Integer, nullable=False, server_default="1")
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True),
        server_default=text("now()"),
        nullable=False,
    )
    updated_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True),
        server_default=text("now()"),
        nullable=False,
    )

    __table_args__ = (
        CheckConstraint(
            "sharing IN ('private', 'library', 'public')",
            name="ck_conversations_sharing",
        ),
        CheckConstraint(
            "next_seq >= 1",
            name="ck_conversations_next_seq_positive",
        ),
    )

    # Relationships
    owner: Mapped["User"] = relationship("User")
    messages: Mapped[list["Message"]] = relationship(
        "Message", back_populates="conversation", cascade="all, delete-orphan"
    )
    shares: Mapped[list["ConversationShare"]] = relationship(
        "ConversationShare", back_populates="conversation", cascade="all, delete-orphan"
    )
    conversation_media: Mapped[list["ConversationMedia"]] = relationship(
        "ConversationMedia", back_populates="conversation", cascade="all, delete-orphan"
    )


class ConversationShare(Base):
    """ConversationShare model - links conversations to libraries for sharing."""

    __tablename__ = "conversation_shares"

    conversation_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("conversations.id", ondelete="CASCADE"),
        primary_key=True,
    )
    library_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("libraries.id", ondelete="CASCADE"),
        primary_key=True,
    )
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True),
        server_default=text("now()"),
        nullable=False,
    )

    # Relationships
    conversation: Mapped["Conversation"] = relationship("Conversation", back_populates="shares")
    library: Mapped["Library"] = relationship("Library")


class Model(Base):
    """Model registry for LLM models."""

    __tablename__ = "models"

    id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        primary_key=True,
        server_default=text("gen_random_uuid()"),
    )
    provider: Mapped[str] = mapped_column(Text, nullable=False)
    model_name: Mapped[str] = mapped_column(Text, nullable=False)
    max_context_tokens: Mapped[int] = mapped_column(Integer, nullable=False)
    cost_per_1k_input_tokens_usd: Mapped[int | None] = mapped_column(Integer, nullable=True)
    cost_per_1k_output_tokens_usd: Mapped[int | None] = mapped_column(Integer, nullable=True)
    is_available: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default="true")

    __table_args__ = (
        CheckConstraint(
            "provider IN ('openai', 'anthropic', 'gemini')",
            name="ck_models_provider",
        ),
        CheckConstraint(
            "max_context_tokens > 0",
            name="ck_models_max_context_positive",
        ),
        UniqueConstraint("provider", "model_name", name="uix_models_provider_model_name"),
    )


class Message(Base):
    """Message model - a single message in a conversation."""

    __tablename__ = "messages"

    id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        primary_key=True,
        server_default=text("gen_random_uuid()"),
    )
    conversation_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("conversations.id", ondelete="CASCADE"),
        nullable=False,
    )
    seq: Mapped[int] = mapped_column(Integer, nullable=False)
    role: Mapped[str] = mapped_column(Text, nullable=False)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default="complete")
    error_code: Mapped[str | None] = mapped_column(Text, nullable=True)
    model_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("models.id", ondelete="SET NULL"),
        nullable=True,
    )
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True),
        server_default=text("now()"),
        nullable=False,
    )
    updated_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True),
        server_default=text("now()"),
        nullable=False,
    )

    __table_args__ = (
        CheckConstraint("seq >= 1", name="ck_messages_seq_positive"),
        CheckConstraint(
            "role IN ('user', 'assistant', 'system')",
            name="ck_messages_role",
        ),
        CheckConstraint(
            "status IN ('pending', 'complete', 'error')",
            name="ck_messages_status",
        ),
        CheckConstraint(
            "(status != 'pending' OR role = 'assistant')",
            name="ck_messages_pending_only_assistant",
        ),
        UniqueConstraint("conversation_id", "seq", name="uix_messages_conversation_seq"),
    )

    # Relationships
    conversation: Mapped["Conversation"] = relationship("Conversation", back_populates="messages")
    model: Mapped["Model | None"] = relationship("Model")
    llm_metadata: Mapped["MessageLLM | None"] = relationship(
        "MessageLLM",
        back_populates="message",
        uselist=False,
        cascade="all, delete-orphan",
    )
    contexts: Mapped[list["MessageContext"]] = relationship(
        "MessageContext", back_populates="message", cascade="all, delete-orphan"
    )


class MessageLLM(Base):
    """MessageLLM model - LLM execution metadata for assistant messages."""

    __tablename__ = "message_llm"

    message_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("messages.id", ondelete="CASCADE"),
        primary_key=True,
    )
    provider: Mapped[str] = mapped_column(Text, nullable=False)
    model_name: Mapped[str] = mapped_column(Text, nullable=False)
    prompt_tokens: Mapped[int | None] = mapped_column(Integer, nullable=True)
    completion_tokens: Mapped[int | None] = mapped_column(Integer, nullable=True)
    total_tokens: Mapped[int | None] = mapped_column(Integer, nullable=True)
    key_mode_requested: Mapped[str] = mapped_column(Text, nullable=False)
    key_mode_used: Mapped[str] = mapped_column(Text, nullable=False)
    cost_usd_micros: Mapped[int | None] = mapped_column(Integer, nullable=True)
    latency_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    error_class: Mapped[str | None] = mapped_column(Text, nullable=True)
    prompt_version: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True),
        server_default=text("now()"),
        nullable=False,
    )

    __table_args__ = (
        CheckConstraint(
            "provider IN ('openai', 'anthropic', 'gemini')",
            name="ck_message_llm_provider",
        ),
        CheckConstraint(
            "key_mode_requested IN ('auto', 'byok_only', 'platform_only')",
            name="ck_message_llm_key_mode_requested",
        ),
        CheckConstraint(
            "key_mode_used IN ('platform', 'byok')",
            name="ck_message_llm_key_mode_used",
        ),
        CheckConstraint(
            "prompt_tokens IS NULL OR prompt_tokens >= 0",
            name="ck_message_llm_prompt_tokens",
        ),
        CheckConstraint(
            "completion_tokens IS NULL OR completion_tokens >= 0",
            name="ck_message_llm_completion_tokens",
        ),
        CheckConstraint(
            "total_tokens IS NULL OR total_tokens >= 0",
            name="ck_message_llm_total_tokens",
        ),
        CheckConstraint(
            "cost_usd_micros IS NULL OR cost_usd_micros >= 0",
            name="ck_message_llm_cost",
        ),
        CheckConstraint(
            "latency_ms IS NULL OR latency_ms >= 0",
            name="ck_message_llm_latency",
        ),
    )

    # Relationships
    message: Mapped["Message"] = relationship("Message", back_populates="llm_metadata")


class UserApiKey(Base):
    """UserApiKey model - encrypted BYOK API keys per provider."""

    __tablename__ = "user_api_keys"

    id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        primary_key=True,
        server_default=text("gen_random_uuid()"),
    )
    user_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
    )
    provider: Mapped[str] = mapped_column(Text, nullable=False)
    # These fields are nullable to support secure revocation (wipe to NULL)
    encrypted_key: Mapped[bytes | None] = mapped_column(nullable=True)
    key_nonce: Mapped[bytes | None] = mapped_column(nullable=True)
    master_key_version: Mapped[int | None] = mapped_column(
        Integer, nullable=True, server_default="1"
    )
    key_fingerprint: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default="untested")
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True),
        server_default=text("now()"),
        nullable=False,
    )
    last_tested_at: Mapped[datetime | None] = mapped_column(TIMESTAMP(timezone=True), nullable=True)
    revoked_at: Mapped[datetime | None] = mapped_column(TIMESTAMP(timezone=True), nullable=True)

    __table_args__ = (
        CheckConstraint(
            "provider IN ('openai', 'anthropic', 'gemini')",
            name="ck_user_api_keys_provider",
        ),
        CheckConstraint(
            "master_key_version IS NULL OR master_key_version > 0",
            name="ck_user_api_keys_master_key_version",
        ),
        CheckConstraint(
            "status IN ('untested', 'valid', 'invalid', 'revoked')",
            name="ck_user_api_keys_status",
        ),
        CheckConstraint(
            "key_nonce IS NULL OR octet_length(key_nonce) = 24",
            name="ck_user_api_keys_nonce_len",
        ),
        UniqueConstraint("user_id", "provider", name="uix_user_api_keys_user_provider"),
    )

    # Relationships
    user: Mapped["User"] = relationship("User")


class IdempotencyKey(Base):
    """IdempotencyKey model - request deduplication for message sends."""

    __tablename__ = "idempotency_keys"

    user_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        primary_key=True,
    )
    key: Mapped[str] = mapped_column(Text, primary_key=True)
    payload_hash: Mapped[str] = mapped_column(Text, nullable=False)
    user_message_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("messages.id", ondelete="CASCADE"),
        nullable=False,
    )
    assistant_message_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("messages.id", ondelete="CASCADE"),
        nullable=False,
    )
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True),
        server_default=text("now()"),
        nullable=False,
    )
    expires_at: Mapped[datetime] = mapped_column(TIMESTAMP(timezone=True), nullable=False)

    __table_args__ = (
        CheckConstraint(
            "length(key) >= 1 AND length(key) <= 128",
            name="ck_idempotency_keys_key_length",
        ),
    )

    # Relationships
    user: Mapped["User"] = relationship("User")
    user_message: Mapped["Message"] = relationship("Message", foreign_keys=[user_message_id])
    assistant_message: Mapped["Message"] = relationship(
        "Message", foreign_keys=[assistant_message_id]
    )


class MessageContext(Base):
    """MessageContext model - links messages to context objects."""

    __tablename__ = "message_contexts"

    id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        primary_key=True,
        server_default=text("gen_random_uuid()"),
    )
    message_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("messages.id", ondelete="CASCADE"),
        nullable=False,
    )
    target_type: Mapped[str] = mapped_column(Text, nullable=False)
    ordinal: Mapped[int] = mapped_column(Integer, nullable=False)
    media_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("media.id", ondelete="CASCADE"),
        nullable=True,
    )
    highlight_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("highlights.id", ondelete="CASCADE"),
        nullable=True,
    )
    annotation_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("annotations.id", ondelete="CASCADE"),
        nullable=True,
    )
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True),
        server_default=text("now()"),
        nullable=False,
    )

    __table_args__ = (
        CheckConstraint(
            "target_type IN ('media', 'highlight', 'annotation')",
            name="ck_message_contexts_target_type",
        ),
        CheckConstraint(
            "ordinal >= 0",
            name="ck_message_contexts_ordinal_non_negative",
        ),
        CheckConstraint(
            """(
                (CASE WHEN media_id IS NOT NULL THEN 1 ELSE 0 END) +
                (CASE WHEN highlight_id IS NOT NULL THEN 1 ELSE 0 END) +
                (CASE WHEN annotation_id IS NOT NULL THEN 1 ELSE 0 END)
            ) = 1""",
            name="ck_message_contexts_one_target",
        ),
        UniqueConstraint("message_id", "ordinal", name="uix_message_contexts_message_ordinal"),
    )

    # Relationships
    message: Mapped["Message"] = relationship("Message", back_populates="contexts")
    media: Mapped["Media | None"] = relationship("Media")
    highlight: Mapped["Highlight | None"] = relationship("Highlight")
    annotation: Mapped["Annotation | None"] = relationship("Annotation")


class ConversationMedia(Base):
    """ConversationMedia model - derived table linking conversations to media."""

    __tablename__ = "conversation_media"

    conversation_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("conversations.id", ondelete="CASCADE"),
        primary_key=True,
    )
    media_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("media.id", ondelete="CASCADE"),
        primary_key=True,
    )
    last_message_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True),
        server_default=text("now()"),
        nullable=False,
    )

    # Relationships
    conversation: Mapped["Conversation"] = relationship(
        "Conversation", back_populates="conversation_media"
    )
    media: Mapped["Media"] = relationship("Media")


class FragmentBlock(Base):
    """FragmentBlock model - block boundary index for context window computation.

    Blocks are contiguous and non-overlapping within a fragment.
    Block offsets are codepoint indices in canonical_text.
    Delimiter (\n\n) is included at the END of the preceding block's range.
    """

    __tablename__ = "fragment_blocks"

    id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        primary_key=True,
        server_default=text("gen_random_uuid()"),
    )
    fragment_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("fragments.id", ondelete="CASCADE"),
        nullable=False,
    )
    block_idx: Mapped[int] = mapped_column(Integer, nullable=False)
    start_offset: Mapped[int] = mapped_column(Integer, nullable=False)
    end_offset: Mapped[int] = mapped_column(Integer, nullable=False)
    block_type: Mapped[str | None] = mapped_column(Text, nullable=True)
    is_empty: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default="false")

    __table_args__ = (
        CheckConstraint("block_idx >= 0", name="ck_fragment_blocks_block_idx"),
        CheckConstraint("start_offset >= 0", name="ck_fragment_blocks_start_offset"),
        CheckConstraint("end_offset >= start_offset", name="ck_fragment_blocks_offsets"),
        UniqueConstraint("fragment_id", "block_idx", name="uix_fragment_blocks_fragment_idx"),
    )

    # Relationships
    fragment: Mapped["Fragment"] = relationship("Fragment")
