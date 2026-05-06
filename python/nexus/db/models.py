"""SQLAlchemy ORM models for Nexus.

Defines all database tables using SQLAlchemy 2.x declarative patterns.
Enums are defined as Python enums and mapped to PostgreSQL enum types.
"""

from datetime import date, datetime
from decimal import Decimal
from enum import Enum as PyEnum
from uuid import UUID

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    Date,
    Enum,
    Float,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    SmallInteger,
    Text,
    UniqueConstraint,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB, TIMESTAMP
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship
from sqlalchemy.types import UserDefinedType


class Base(DeclarativeBase):
    """Base class for all ORM models."""

    pass


class PGVector(UserDefinedType):
    """PostgreSQL pgvector column type."""

    cache_ok = True

    def __init__(self, dimensions: int):
        self.dimensions = dimensions

    def get_col_spec(self, **_kw: object) -> str:
        return f"vector({self.dimensions})"


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


class TranscriptState(str, PyEnum):
    """Lifecycle state for transcript availability."""

    not_requested = "not_requested"
    queued = "queued"
    running = "running"
    ready = "ready"
    partial = "partial"
    unavailable = "unavailable"
    failed_quota = "failed_quota"
    failed_provider = "failed_provider"


class TranscriptCoverage(str, PyEnum):
    """Coverage quality for transcript artifacts."""

    none = "none"
    partial = "partial"
    full = "full"


class SemanticStatus(str, PyEnum):
    """Semantic index readiness state for transcript chunks."""

    none = "none"
    pending = "pending"
    ready = "ready"
    failed = "failed"


class MembershipRole(str, PyEnum):
    """Roles a user can have in a library."""

    admin = "admin"
    member = "member"


# --- Slice 4: Library Sharing Enums ---


class LibraryInvitationRole(str, PyEnum):
    """Role assigned to a library invitation."""

    admin = "admin"
    member = "member"


class LibraryInvitationStatus(str, PyEnum):
    """Lifecycle states for a library invitation."""

    pending = "pending"
    accepted = "accepted"
    declined = "declined"
    revoked = "revoked"


class DefaultLibraryBackfillJobStatus(str, PyEnum):
    """States for default-library closure backfill jobs."""

    pending = "pending"
    running = "running"
    completed = "completed"
    failed = "failed"


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
    email: Mapped[str | None] = mapped_column(Text, nullable=True, unique=True)
    display_name: Mapped[str | None] = mapped_column(Text, nullable=True)
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
    playback_queue_items: Mapped[list["PlaybackQueueItem"]] = relationship(
        "PlaybackQueueItem", back_populates="user", cascade="all, delete-orphan"
    )
    podcast_listening_states: Mapped[list["PodcastListeningState"]] = relationship(
        "PodcastListeningState", back_populates="user", cascade="all, delete-orphan"
    )
    command_palette_usages: Mapped[list["CommandPaletteUsage"]] = relationship(
        "CommandPaletteUsage", back_populates="user"
    )


class Page(Base):
    """User-owned note page."""

    __tablename__ = "pages"

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
    title: Mapped[str] = mapped_column(Text, nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
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
        CheckConstraint("char_length(title) BETWEEN 1 AND 200", name="ck_pages_title_length"),
    )


class DailyNotePage(Base):
    """Durable daily-date identity for an ordinary note page."""

    __tablename__ = "daily_note_pages"

    id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        primary_key=True,
        server_default=text("gen_random_uuid()"),
    )
    user_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("users.id"),
        nullable=False,
    )
    local_date: Mapped[date] = mapped_column(Date, nullable=False)
    time_zone: Mapped[str] = mapped_column(Text, nullable=False, server_default="UTC")
    page_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("pages.id"),
        nullable=False,
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
    deleted_at: Mapped[datetime | None] = mapped_column(TIMESTAMP(timezone=True), nullable=True)

    __table_args__ = (
        CheckConstraint(
            "char_length(time_zone) BETWEEN 1 AND 100",
            name="ck_daily_note_pages_time_zone_length",
        ),
        UniqueConstraint("user_id", "local_date", name="uix_daily_note_pages_user_date"),
        UniqueConstraint("user_id", "page_id", name="uix_daily_note_pages_user_page"),
    )


class NoteBlock(Base):
    """Smallest editable note unit in a page or focused note pane."""

    __tablename__ = "note_blocks"

    id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        primary_key=True,
        server_default=text("gen_random_uuid()"),
    )
    user_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("users.id"),
        nullable=False,
    )
    page_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("pages.id"),
        nullable=False,
    )
    parent_block_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("note_blocks.id"),
        nullable=True,
    )
    order_key: Mapped[str] = mapped_column(Text, nullable=False)
    block_kind: Mapped[str] = mapped_column(Text, nullable=False, server_default="bullet")
    body_pm_json: Mapped[dict[str, object]] = mapped_column(JSONB, nullable=False)
    body_markdown: Mapped[str] = mapped_column(Text, nullable=False, server_default="")
    body_text: Mapped[str] = mapped_column(Text, nullable=False)
    collapsed: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default="false")
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
            "block_kind IN ('bullet', 'heading', 'todo', 'quote', 'code', 'image', 'embed')",
            name="ck_note_blocks_kind",
        ),
        CheckConstraint(
            "jsonb_typeof(body_pm_json) = 'object'", name="ck_note_blocks_pm_json_object"
        ),
        CheckConstraint(
            "char_length(order_key) BETWEEN 1 AND 64",
            name="ck_note_blocks_order_key_length",
        ),
    )


class ObjectLink(Base):
    """User-owned relationship between two typed object refs."""

    __tablename__ = "object_links"

    id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        primary_key=True,
        server_default=text("gen_random_uuid()"),
    )
    user_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("users.id"),
        nullable=False,
    )
    relation_type: Mapped[str] = mapped_column(Text, nullable=False)
    a_type: Mapped[str] = mapped_column(Text, nullable=False)
    a_id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), nullable=False)
    b_type: Mapped[str] = mapped_column(Text, nullable=False)
    b_id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), nullable=False)
    a_order_key: Mapped[str | None] = mapped_column(Text, nullable=True)
    b_order_key: Mapped[str | None] = mapped_column(Text, nullable=True)
    a_locator_json: Mapped[dict[str, object] | None] = mapped_column(
        "a_locator", JSONB(none_as_null=True), nullable=True
    )
    b_locator_json: Mapped[dict[str, object] | None] = mapped_column(
        "b_locator", JSONB(none_as_null=True), nullable=True
    )
    metadata_json: Mapped[dict[str, object]] = mapped_column(
        "metadata",
        JSONB,
        nullable=False,
        server_default=text("'{}'::jsonb"),
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
        CheckConstraint(
            "a_type IN ('page', 'note_block', 'media', 'highlight', 'conversation', "
            "'message', 'podcast', 'content_chunk', 'contributor')",
            name="ck_object_links_a_type",
        ),
        CheckConstraint(
            "b_type IN ('page', 'note_block', 'media', 'highlight', 'conversation', "
            "'message', 'podcast', 'content_chunk', 'contributor')",
            name="ck_object_links_b_type",
        ),
        CheckConstraint(
            "relation_type IN ('references', 'embeds', 'note_about', 'used_as_context', "
            "'derived_from', 'related')",
            name="ck_object_links_relation",
        ),
        CheckConstraint(
            "a_order_key IS NULL OR char_length(a_order_key) BETWEEN 1 AND 64",
            name="ck_object_links_a_order_key_length",
        ),
        CheckConstraint(
            "b_order_key IS NULL OR char_length(b_order_key) BETWEEN 1 AND 64",
            name="ck_object_links_b_order_key_length",
        ),
        CheckConstraint(
            "a_locator IS NULL OR jsonb_typeof(a_locator) = 'object'",
            name="ck_object_links_a_locator",
        ),
        CheckConstraint(
            "b_locator IS NULL OR jsonb_typeof(b_locator) = 'object'",
            name="ck_object_links_b_locator",
        ),
        CheckConstraint("jsonb_typeof(metadata) = 'object'", name="ck_object_links_metadata"),
        Index(
            "uix_object_links_unlocated_pair",
            "user_id",
            "relation_type",
            text("LEAST(a_type || ':' || a_id::text, b_type || ':' || b_id::text)"),
            text("GREATEST(a_type || ':' || a_id::text, b_type || ':' || b_id::text)"),
            unique=True,
            postgresql_where=text("a_locator IS NULL AND b_locator IS NULL"),
        ),
    )


class PinnedObjectRef(Base):
    """User-pinned navigation item backed by a hydrated ObjectRef."""

    __tablename__ = "user_pinned_objects"

    id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        primary_key=True,
        server_default=text("gen_random_uuid()"),
    )
    user_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("users.id"),
        nullable=False,
    )
    object_type: Mapped[str] = mapped_column(Text, nullable=False)
    object_id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), nullable=False)
    surface_key: Mapped[str] = mapped_column(Text, nullable=False)
    order_key: Mapped[str] = mapped_column(Text, nullable=False)
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
    deleted_at: Mapped[datetime | None] = mapped_column(TIMESTAMP(timezone=True), nullable=True)

    __table_args__ = (
        CheckConstraint(
            "object_type IN ('page', 'note_block', 'media', 'highlight', 'conversation', "
            "'message', 'podcast', 'content_chunk', 'contributor')",
            name="ck_user_pinned_objects_type",
        ),
        CheckConstraint(
            "char_length(surface_key) BETWEEN 1 AND 64",
            name="ck_user_pinned_objects_surface_key_length",
        ),
        CheckConstraint(
            "char_length(order_key) BETWEEN 1 AND 64",
            name="ck_user_pinned_objects_order_key_length",
        ),
        UniqueConstraint(
            "user_id",
            "surface_key",
            "object_type",
            "object_id",
            name="uix_user_pinned_objects_surface_ref",
        ),
    )


class ObjectSearchDocument(Base):
    """Searchable projection for ObjectRef-backed knowledge objects."""

    __tablename__ = "object_search_documents"

    id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        primary_key=True,
        server_default=text("gen_random_uuid()"),
    )
    user_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("users.id"),
        nullable=False,
    )
    object_type: Mapped[str] = mapped_column(Text, nullable=False)
    object_id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), nullable=False)
    parent_object_type: Mapped[str | None] = mapped_column(Text, nullable=True)
    parent_object_id: Mapped[UUID | None] = mapped_column(PG_UUID(as_uuid=True), nullable=True)
    title_text: Mapped[str] = mapped_column(Text, nullable=False)
    body_text: Mapped[str] = mapped_column(Text, nullable=False, server_default="")
    search_text: Mapped[str] = mapped_column(Text, nullable=False)
    route_path: Mapped[str] = mapped_column(Text, nullable=False)
    content_hash: Mapped[str] = mapped_column(Text, nullable=False)
    index_version: Mapped[int] = mapped_column(Integer, nullable=False, server_default="1")
    index_status: Mapped[str] = mapped_column(
        Text,
        nullable=False,
        server_default="pending_embedding",
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
    deleted_at: Mapped[datetime | None] = mapped_column(TIMESTAMP(timezone=True), nullable=True)

    __table_args__ = (
        CheckConstraint(
            "object_type IN ('page', 'note_block')",
            name="ck_object_search_documents_type",
        ),
        CheckConstraint(
            "parent_object_type IS NULL OR parent_object_type IN ('page')",
            name="ck_osd_parent_object_type",
        ),
        CheckConstraint(
            "(parent_object_type IS NULL) = (parent_object_id IS NULL)",
            name="ck_osd_parent_shape",
        ),
        CheckConstraint(
            "char_length(title_text) BETWEEN 1 AND 300",
            name="ck_osd_title_text_length",
        ),
        CheckConstraint("char_length(search_text) >= 1", name="ck_osd_search_text_length"),
        CheckConstraint(
            "char_length(route_path) BETWEEN 1 AND 500",
            name="ck_osd_route_path_length",
        ),
        CheckConstraint(
            "char_length(content_hash) BETWEEN 1 AND 128",
            name="ck_osd_content_hash_length",
        ),
        CheckConstraint("index_version > 0", name="ck_osd_index_version"),
        CheckConstraint(
            "index_status IN ('pending_embedding', 'ready')",
            name="ck_osd_index_status",
        ),
        UniqueConstraint(
            "user_id",
            "object_type",
            "object_id",
            "index_version",
            name="uix_osd_object_ref_version",
        ),
    )


class ObjectSearchEmbedding(Base):
    """Optional semantic embedding for an object-search document."""

    __tablename__ = "object_search_embeddings"

    id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        primary_key=True,
        server_default=text("gen_random_uuid()"),
    )
    user_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("users.id"),
        nullable=False,
    )
    search_document_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("object_search_documents.id"),
        nullable=False,
    )
    object_type: Mapped[str] = mapped_column(Text, nullable=False)
    object_id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), nullable=False)
    embedding_model: Mapped[str] = mapped_column(Text, nullable=False)
    embedding_dimensions: Mapped[int] = mapped_column(Integer, nullable=False)
    content_hash: Mapped[str] = mapped_column(Text, nullable=False)
    index_version: Mapped[int] = mapped_column(Integer, nullable=False)
    embedding: Mapped[list[float] | None] = mapped_column(PGVector(256), nullable=True)
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
    deleted_at: Mapped[datetime | None] = mapped_column(TIMESTAMP(timezone=True), nullable=True)

    __table_args__ = (
        CheckConstraint(
            "object_type IN ('page', 'note_block')",
            name="ck_ose_object_type",
        ),
        CheckConstraint(
            "char_length(embedding_model) BETWEEN 1 AND 128",
            name="ck_ose_model_length",
        ),
        CheckConstraint("embedding_dimensions > 0", name="ck_ose_dimensions"),
        CheckConstraint(
            "char_length(content_hash) BETWEEN 1 AND 128",
            name="ck_ose_content_hash_length",
        ),
        CheckConstraint("index_version > 0", name="ck_ose_index_version"),
        UniqueConstraint(
            "search_document_id",
            "embedding_model",
            "index_version",
            name="uix_ose_document_model_version",
        ),
        Index("ix_ose_model", "user_id", "embedding_model"),
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
    color: Mapped[str | None] = mapped_column(Text, nullable=True)
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
    library_entries: Mapped[list["LibraryEntry"]] = relationship(
        "LibraryEntry", back_populates="library", cascade="all, delete-orphan"
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

    # S6 PDF text readiness fields
    plain_text: Mapped[str | None] = mapped_column(Text, nullable=True)
    page_count: Mapped[int | None] = mapped_column(Integer, nullable=True)

    # Document metadata enrichment fields
    # published_date is TEXT (not DATE) because source data is often partial ("2023", "2023-01")
    published_date: Mapped[str | None] = mapped_column(Text, nullable=True)
    publisher: Mapped[str | None] = mapped_column(Text, nullable=True)
    language: Mapped[str | None] = mapped_column(Text, nullable=True)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    metadata_enriched_at: Mapped[datetime | None] = mapped_column(
        TIMESTAMP(timezone=True), nullable=True
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
        CheckConstraint(
            "page_count IS NULL OR page_count >= 1",
            name="ck_media_page_count_positive",
        ),
        Index(
            "uix_media_x_provider_id",
            "provider",
            "provider_id",
            unique=True,
            postgresql_where=text("provider = 'x' AND provider_id IS NOT NULL"),
        ),
    )

    # Relationships
    created_by: Mapped["User | None"] = relationship("User")
    fragments: Mapped[list["Fragment"]] = relationship(
        "Fragment", back_populates="media", cascade="all, delete-orphan"
    )
    library_entries: Mapped[list["LibraryEntry"]] = relationship(
        "LibraryEntry", back_populates="media", cascade="all, delete-orphan"
    )
    media_file: Mapped["MediaFile | None"] = relationship(
        "MediaFile", back_populates="media", cascade="all, delete-orphan", uselist=False
    )
    pdf_page_text_spans: Mapped[list["PdfPageTextSpan"]] = relationship(
        "PdfPageTextSpan", back_populates="media", cascade="all, delete-orphan"
    )
    podcast_episode: Mapped["PodcastEpisode | None"] = relationship(
        "PodcastEpisode", back_populates="media", cascade="all, delete-orphan", uselist=False
    )
    podcast_episode_chapters: Mapped[list["PodcastEpisodeChapter"]] = relationship(
        "PodcastEpisodeChapter",
        back_populates="media",
        cascade="all, delete-orphan",
        order_by=lambda: PodcastEpisodeChapter.chapter_idx,
    )
    podcast_listening_states: Mapped[list["PodcastListeningState"]] = relationship(
        "PodcastListeningState",
        back_populates="media",
        cascade="all, delete-orphan",
    )
    playback_queue_items: Mapped[list["PlaybackQueueItem"]] = relationship(
        "PlaybackQueueItem",
        back_populates="media",
        cascade="all, delete-orphan",
    )
    podcast_transcription_job: Mapped["PodcastTranscriptionJob | None"] = relationship(
        "PodcastTranscriptionJob",
        back_populates="media",
        cascade="all, delete-orphan",
        uselist=False,
    )
    transcript_state: Mapped["MediaTranscriptState | None"] = relationship(
        "MediaTranscriptState",
        back_populates="media",
        cascade="all, delete-orphan",
        uselist=False,
    )
    transcript_versions: Mapped[list["PodcastTranscriptVersion"]] = relationship(
        "PodcastTranscriptVersion",
        back_populates="media",
        cascade="all, delete-orphan",
    )
    content_chunks: Mapped[list["ContentChunk"]] = relationship(
        "ContentChunk",
        back_populates="media",
    )
    source_snapshots: Mapped[list["SourceSnapshot"]] = relationship(
        "SourceSnapshot",
        back_populates="media",
    )
    content_index_runs: Mapped[list["ContentIndexRun"]] = relationship(
        "ContentIndexRun",
        back_populates="media",
    )
    content_index_state: Mapped["MediaContentIndexState | None"] = relationship(
        "MediaContentIndexState",
        back_populates="media",
        uselist=False,
    )
    transcript_request_audits: Mapped[list["PodcastTranscriptRequestAudit"]] = relationship(
        "PodcastTranscriptRequestAudit",
        back_populates="media",
        cascade="all, delete-orphan",
    )
    contributor_credits: Mapped[list["ContributorCredit"]] = relationship(
        "ContributorCredit",
        back_populates="media",
        order_by=lambda: ContributorCredit.ordinal,
    )


class ProjectGutenbergCatalogEntry(Base):
    """Local mirror of the Project Gutenberg catalog metadata feed."""

    __tablename__ = "project_gutenberg_catalog"

    ebook_id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    title: Mapped[str] = mapped_column(Text, nullable=False)
    gutenberg_type: Mapped[str | None] = mapped_column(Text, nullable=True)
    issued: Mapped[date | None] = mapped_column(Date, nullable=True)
    language: Mapped[str | None] = mapped_column(Text, nullable=True)
    subjects: Mapped[str | None] = mapped_column(Text, nullable=True)
    locc: Mapped[str | None] = mapped_column(Text, nullable=True)
    bookshelves: Mapped[str | None] = mapped_column(Text, nullable=True)
    copyright_status: Mapped[str | None] = mapped_column(Text, nullable=True)
    download_count: Mapped[int | None] = mapped_column(Integer, nullable=True)
    raw_metadata: Mapped[dict[str, str]] = mapped_column(
        JSONB,
        nullable=False,
        server_default=text("'{}'::jsonb"),
    )
    synced_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True),
        server_default=text("now()"),
        nullable=False,
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
        CheckConstraint("ebook_id > 0", name="ck_project_gutenberg_catalog_ebook_id_positive"),
        Index("ix_project_gutenberg_catalog_language", "language"),
        Index("ix_project_gutenberg_catalog_title", "title"),
    )

    contributor_credits: Mapped[list["ContributorCredit"]] = relationship(
        "ContributorCredit",
        back_populates="project_gutenberg_catalog_entry",
        order_by=lambda: ContributorCredit.ordinal,
    )


class Contributor(Base):
    """Canonical person, organization, group, or local creator identity."""

    __tablename__ = "contributors"

    id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        primary_key=True,
        server_default=text("gen_random_uuid()"),
    )
    handle: Mapped[str] = mapped_column(Text, nullable=False)
    display_name: Mapped[str] = mapped_column(Text, nullable=False)
    sort_name: Mapped[str | None] = mapped_column(Text, nullable=True)
    kind: Mapped[str] = mapped_column(Text, nullable=False, server_default="unknown")
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default="unverified")
    disambiguation: Mapped[str | None] = mapped_column(Text, nullable=True)
    merged_into_contributor_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("contributors.id"),
        nullable=True,
    )
    merged_at: Mapped[datetime | None] = mapped_column(TIMESTAMP(timezone=True), nullable=True)
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
            "kind IN ('person', 'organization', 'group', 'unknown')",
            name="ck_contributors_kind",
        ),
        CheckConstraint(
            "status IN ('unverified', 'verified', 'tombstoned', 'merged')",
            name="ck_contributors_status",
        ),
        UniqueConstraint("handle", name="uq_contributors_handle"),
    )

    aliases: Mapped[list["ContributorAlias"]] = relationship(
        "ContributorAlias",
        back_populates="contributor",
        order_by=lambda: [ContributorAlias.is_primary.desc(), ContributorAlias.alias.asc()],
    )
    external_ids: Mapped[list["ContributorExternalId"]] = relationship(
        "ContributorExternalId",
        back_populates="contributor",
        order_by=lambda: [
            ContributorExternalId.authority.asc(),
            ContributorExternalId.external_key.asc(),
        ],
    )
    credits: Mapped[list["ContributorCredit"]] = relationship(
        "ContributorCredit",
        back_populates="contributor",
        order_by=lambda: ContributorCredit.ordinal,
    )
    merged_into_contributor: Mapped["Contributor | None"] = relationship(
        "Contributor",
        remote_side=lambda: Contributor.id,
    )


class ContributorAlias(Base):
    """Searchable name associated with a contributor."""

    __tablename__ = "contributor_aliases"

    id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        primary_key=True,
        server_default=text("gen_random_uuid()"),
    )
    contributor_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("contributors.id"),
        nullable=False,
    )
    alias: Mapped[str] = mapped_column(Text, nullable=False)
    normalized_alias: Mapped[str] = mapped_column(Text, nullable=False)
    sort_name: Mapped[str | None] = mapped_column(Text, nullable=True)
    alias_kind: Mapped[str] = mapped_column(Text, nullable=False, server_default="credited")
    locale: Mapped[str | None] = mapped_column(Text, nullable=True)
    script: Mapped[str | None] = mapped_column(Text, nullable=True)
    source: Mapped[str] = mapped_column(Text, nullable=False)
    confidence: Mapped[Decimal | None] = mapped_column(Numeric, nullable=True)
    is_primary: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default="false")
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True),
        server_default=text("now()"),
        nullable=False,
    )

    __table_args__ = (
        CheckConstraint(
            "alias_kind IN ('display', 'credited', 'legal', 'pseudonym', 'transliteration', 'search')",
            name="ck_contributor_aliases_kind",
        ),
        Index("ix_contributor_aliases_contributor_id", "contributor_id"),
        Index("ix_contributor_aliases_normalized_alias", "normalized_alias"),
    )

    contributor: Mapped["Contributor"] = relationship("Contributor", back_populates="aliases")


class ContributorExternalId(Base):
    """Provider or authority identifier for a contributor."""

    __tablename__ = "contributor_external_ids"

    id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        primary_key=True,
        server_default=text("gen_random_uuid()"),
    )
    contributor_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("contributors.id"),
        nullable=False,
    )
    authority: Mapped[str] = mapped_column(Text, nullable=False)
    external_key: Mapped[str] = mapped_column(Text, nullable=False)
    external_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    source: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True),
        server_default=text("now()"),
        nullable=False,
    )

    __table_args__ = (
        CheckConstraint(
            "authority IN ('orcid', 'isni', 'viaf', 'wikidata', 'openalex', 'lcnaf', "
            "'podcast_index', 'rss', 'youtube', 'gutenberg')",
            name="ck_contributor_external_ids_authority",
        ),
        UniqueConstraint(
            "authority",
            "external_key",
            name="uq_contributor_external_ids_authority_key",
        ),
        Index("ix_contributor_external_ids_contributor_id", "contributor_id"),
    )

    contributor: Mapped["Contributor"] = relationship(
        "Contributor",
        back_populates="external_ids",
    )


class ContributorCredit(Base):
    """Ordered contributor credit on a media item, podcast, or catalog item."""

    __tablename__ = "contributor_credits"

    id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        primary_key=True,
        server_default=text("gen_random_uuid()"),
    )
    contributor_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("contributors.id"),
        nullable=False,
    )
    media_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("media.id"),
        nullable=True,
    )
    podcast_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("podcasts.id"),
        nullable=True,
    )
    project_gutenberg_catalog_ebook_id: Mapped[int | None] = mapped_column(
        BigInteger,
        ForeignKey("project_gutenberg_catalog.ebook_id"),
        nullable=True,
    )
    credited_name: Mapped[str] = mapped_column(Text, nullable=False)
    normalized_credited_name: Mapped[str] = mapped_column(Text, nullable=False)
    role: Mapped[str] = mapped_column(Text, nullable=False)
    raw_role: Mapped[str | None] = mapped_column(Text, nullable=True)
    ordinal: Mapped[int] = mapped_column(Integer, nullable=False)
    source: Mapped[str] = mapped_column(Text, nullable=False)
    source_ref: Mapped[dict[str, object]] = mapped_column(
        JSONB,
        nullable=False,
        server_default=text("'{}'::jsonb"),
    )
    resolution_status: Mapped[str] = mapped_column(Text, nullable=False)
    confidence: Mapped[Decimal | None] = mapped_column(Numeric, nullable=True)
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
            "num_nonnulls(media_id, podcast_id, project_gutenberg_catalog_ebook_id) = 1",
            name="ck_contributor_credits_one_target",
        ),
        CheckConstraint(
            "role IN ('author', 'editor', 'translator', 'host', 'guest', 'narrator', "
            "'creator', 'producer', 'publisher', 'channel', 'organization', 'unknown')",
            name="ck_contributor_credits_role",
        ),
        CheckConstraint(
            "resolution_status IN ('external_id', 'manual', 'confirmed_alias', 'unverified')",
            name="ck_contributor_credits_resolution_status",
        ),
        CheckConstraint("ordinal >= 0", name="ck_contributor_credits_ordinal"),
        CheckConstraint(
            "jsonb_typeof(source_ref) = 'object'",
            name="ck_contributor_credits_source_ref",
        ),
        Index("ix_contributor_credits_contributor_id", "contributor_id"),
        Index("ix_contributor_credits_media_id", "media_id"),
        Index("ix_contributor_credits_podcast_id", "podcast_id"),
        Index(
            "ix_contributor_credits_gutenberg_ebook_id",
            "project_gutenberg_catalog_ebook_id",
        ),
    )

    contributor: Mapped["Contributor"] = relationship("Contributor", back_populates="credits")
    media: Mapped["Media | None"] = relationship("Media", back_populates="contributor_credits")
    podcast: Mapped["Podcast | None"] = relationship(
        "Podcast",
        back_populates="contributor_credits",
    )
    project_gutenberg_catalog_entry: Mapped["ProjectGutenbergCatalogEntry | None"] = relationship(
        "ProjectGutenbergCatalogEntry",
        back_populates="contributor_credits",
    )


class ContributorIdentityEvent(Base):
    """Audit trail for contributor identity changes."""

    __tablename__ = "contributor_identity_events"

    id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        primary_key=True,
        server_default=text("gen_random_uuid()"),
    )
    event_type: Mapped[str] = mapped_column(Text, nullable=False)
    actor_user_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("users.id"),
        nullable=True,
    )
    source_contributor_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("contributors.id"),
        nullable=True,
    )
    target_contributor_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("contributors.id"),
        nullable=True,
    )
    payload: Mapped[dict[str, object]] = mapped_column(
        JSONB,
        nullable=False,
        server_default=text("'{}'::jsonb"),
    )
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True),
        server_default=text("now()"),
        nullable=False,
    )

    __table_args__ = (
        CheckConstraint(
            "event_type IN ('create', 'alias_add', 'alias_remove', 'external_id_add', "
            "'external_id_remove', 'merge', 'split', 'tombstone')",
            name="ck_contributor_identity_events_type",
        ),
        CheckConstraint(
            "jsonb_typeof(payload) = 'object'",
            name="ck_contributor_identity_events_payload",
        ),
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
    transcript_version_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("podcast_transcript_versions.id", ondelete="SET NULL"),
        nullable=True,
    )
    idx: Mapped[int] = mapped_column(Integer, nullable=False)
    canonical_text: Mapped[str] = mapped_column(Text, nullable=False)
    html_sanitized: Mapped[str] = mapped_column(Text, nullable=False)
    t_start_ms: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    t_end_ms: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    speaker_label: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True),
        server_default=text("now()"),
        nullable=False,
    )

    __table_args__ = (
        UniqueConstraint("media_id", "idx", name="uq_fragments_media_idx"),
        CheckConstraint(
            "(t_start_ms IS NULL AND t_end_ms IS NULL) "
            "OR (t_start_ms IS NOT NULL AND t_end_ms IS NOT NULL)",
            name="ck_fragments_time_offsets_paired_null",
        ),
        CheckConstraint(
            "(t_start_ms IS NULL OR t_start_ms >= 0) "
            "AND (t_end_ms IS NULL OR t_end_ms >= 0) "
            "AND (t_start_ms IS NULL OR t_end_ms > t_start_ms)",
            name="ck_fragments_time_offsets_valid",
        ),
    )

    # Relationships
    media: Mapped["Media"] = relationship("Media", back_populates="fragments", lazy="joined")
    transcript_version: Mapped["PodcastTranscriptVersion | None"] = relationship(
        "PodcastTranscriptVersion",
        back_populates="fragments",
    )


class LibraryEntry(Base):
    """Association between a library and exactly one content target."""

    __tablename__ = "library_entries"

    id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        primary_key=True,
        server_default=text("gen_random_uuid()"),
    )
    library_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("libraries.id"),
        nullable=False,
    )
    media_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("media.id", ondelete="CASCADE"),
        nullable=True,
    )
    podcast_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("podcasts.id", ondelete="CASCADE"),
        nullable=True,
    )
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True),
        server_default=text("now()"),
        nullable=False,
    )
    position: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")

    __table_args__ = (
        CheckConstraint(
            "(media_id IS NOT NULL AND podcast_id IS NULL) "
            "OR (media_id IS NULL AND podcast_id IS NOT NULL)",
            name="ck_library_entries_exactly_one_target",
        ),
        CheckConstraint("position >= 0", name="ck_library_entries_position_non_negative"),
        UniqueConstraint("library_id", "media_id", name="uq_library_entries_library_media"),
        UniqueConstraint("library_id", "podcast_id", name="uq_library_entries_library_podcast"),
        Index("idx_library_entries_media_library", "media_id", "library_id"),
        Index("idx_library_entries_podcast_library", "podcast_id", "library_id"),
        Index("ix_library_entries_library_position", "library_id", "position"),
    )

    library: Mapped["Library"] = relationship("Library", back_populates="library_entries")
    media: Mapped["Media | None"] = relationship("Media", back_populates="library_entries")
    podcast: Mapped["Podcast | None"] = relationship("Podcast", back_populates="library_entries")


class LibrarySourceSetVersion(Base):
    """Versioned source inventory snapshot for library intelligence."""

    __tablename__ = "library_source_set_versions"

    id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        primary_key=True,
        server_default=text("gen_random_uuid()"),
    )
    library_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("libraries.id"),
        nullable=False,
    )
    source_set_hash: Mapped[str] = mapped_column(Text, nullable=False)
    source_count: Mapped[int] = mapped_column(Integer, nullable=False)
    chunk_count: Mapped[int] = mapped_column(Integer, nullable=False)
    prompt_version: Mapped[str] = mapped_column(Text, nullable=False)
    schema_version: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True),
        server_default=text("now()"),
        nullable=False,
    )

    __table_args__ = (
        CheckConstraint("source_count >= 0", name="ck_library_source_sets_source_count"),
        CheckConstraint("chunk_count >= 0", name="ck_library_source_sets_chunk_count"),
        CheckConstraint(
            "char_length(source_set_hash) BETWEEN 1 AND 128",
            name="ck_library_source_sets_hash_length",
        ),
        CheckConstraint(
            "char_length(prompt_version) BETWEEN 1 AND 128",
            name="ck_library_source_sets_prompt_version_length",
        ),
        CheckConstraint(
            "char_length(schema_version) BETWEEN 1 AND 128",
            name="ck_library_source_sets_schema_version_length",
        ),
        UniqueConstraint(
            "library_id",
            "source_set_hash",
            "prompt_version",
            "schema_version",
            name="uix_library_source_sets_version",
        ),
        Index("idx_library_source_sets_library_created", "library_id", "created_at"),
    )

    items: Mapped[list["LibrarySourceSetItem"]] = relationship(
        "LibrarySourceSetItem",
        back_populates="source_set_version",
    )


class LibrarySourceSetItem(Base):
    """One source row captured in a library source-set version."""

    __tablename__ = "library_source_set_items"

    id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        primary_key=True,
        server_default=text("gen_random_uuid()"),
    )
    source_set_version_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("library_source_set_versions.id"),
        nullable=False,
    )
    media_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        nullable=True,
    )
    podcast_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        nullable=True,
    )
    source_kind: Mapped[str] = mapped_column(Text, nullable=False)
    title: Mapped[str] = mapped_column(Text, nullable=False)
    media_kind: Mapped[str | None] = mapped_column(Text, nullable=True)
    readiness_state: Mapped[str] = mapped_column(Text, nullable=False)
    chunk_count: Mapped[int] = mapped_column(Integer, nullable=False)
    included: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default="false")
    exclusion_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    source_updated_at: Mapped[datetime | None] = mapped_column(
        TIMESTAMP(timezone=True), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True),
        server_default=text("now()"),
        nullable=False,
    )

    __table_args__ = (
        CheckConstraint(
            "(media_id IS NOT NULL AND podcast_id IS NULL) "
            "OR (media_id IS NULL AND podcast_id IS NOT NULL)",
            name="ck_library_source_set_items_one_source",
        ),
        CheckConstraint(
            "source_kind IN ('media', 'podcast')",
            name="ck_library_source_set_items_source_kind",
        ),
        CheckConstraint("chunk_count >= 0", name="ck_library_source_set_items_chunk_count"),
        CheckConstraint(
            "(included = true AND exclusion_reason IS NULL) "
            "OR (included = false AND exclusion_reason IS NOT NULL)",
            name="ck_library_source_set_items_inclusion_reason",
        ),
        UniqueConstraint(
            "source_set_version_id",
            "media_id",
            name="uix_library_source_set_items_media",
        ),
        UniqueConstraint(
            "source_set_version_id",
            "podcast_id",
            name="uix_library_source_set_items_podcast",
        ),
        Index(
            "idx_library_source_set_items_version_included",
            "source_set_version_id",
            "included",
        ),
    )

    source_set_version: Mapped["LibrarySourceSetVersion"] = relationship(
        "LibrarySourceSetVersion",
        back_populates="items",
    )


class LibraryIntelligenceArtifact(Base):
    """Current artifact pointer for one library intelligence artifact kind."""

    __tablename__ = "library_intelligence_artifacts"

    id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        primary_key=True,
        server_default=text("gen_random_uuid()"),
    )
    library_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("libraries.id"),
        nullable=False,
    )
    artifact_kind: Mapped[str] = mapped_column(Text, nullable=False)
    active_version_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("library_intelligence_versions.id", deferrable=True, initially="DEFERRED"),
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
        CheckConstraint(
            "artifact_kind IN ('overview')",
            name="ck_library_intelligence_artifacts_kind",
        ),
        UniqueConstraint(
            "library_id",
            "artifact_kind",
            name="uix_library_intelligence_artifacts_library_kind",
        ),
    )


class LibraryIntelligenceVersion(Base):
    """Published or attempted version of a library intelligence artifact."""

    __tablename__ = "library_intelligence_versions"

    id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        primary_key=True,
        server_default=text("gen_random_uuid()"),
    )
    artifact_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("library_intelligence_artifacts.id"),
        nullable=False,
    )
    library_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("libraries.id"),
        nullable=False,
    )
    source_set_version_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("library_source_set_versions.id"),
        nullable=False,
    )
    status: Mapped[str] = mapped_column(Text, nullable=False)
    artifact_version: Mapped[int] = mapped_column(Integer, nullable=False)
    prompt_version: Mapped[str] = mapped_column(Text, nullable=False)
    generator_model_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("models.id"),
        nullable=True,
    )
    published_at: Mapped[datetime | None] = mapped_column(TIMESTAMP(timezone=True), nullable=True)
    invalidated_at: Mapped[datetime | None] = mapped_column(TIMESTAMP(timezone=True), nullable=True)
    invalid_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
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
            "status IN ('building', 'active', 'failed', 'superseded', 'stale')",
            name="ck_library_intelligence_versions_status",
        ),
        CheckConstraint(
            "artifact_version >= 1",
            name="ck_library_intelligence_versions_version_positive",
        ),
        CheckConstraint(
            "char_length(prompt_version) BETWEEN 1 AND 128",
            name="ck_library_intelligence_versions_prompt_version_length",
        ),
        CheckConstraint(
            "(status = 'active' AND published_at IS NOT NULL) OR (status != 'active')",
            name="ck_library_intelligence_versions_active_published",
        ),
        CheckConstraint(
            "(invalid_reason IS NULL AND invalidated_at IS NULL) "
            "OR (invalid_reason IS NOT NULL AND invalidated_at IS NOT NULL)",
            name="ck_library_intelligence_versions_invalid_pair",
        ),
        UniqueConstraint(
            "artifact_id",
            "artifact_version",
            name="uix_library_intelligence_versions_artifact_version",
        ),
        UniqueConstraint(
            "artifact_id",
            "source_set_version_id",
            "prompt_version",
            name="uix_library_intelligence_versions_source_prompt",
        ),
        Index(
            "idx_library_intelligence_versions_library_status",
            "library_id",
            "status",
        ),
    )


class LibraryIntelligenceSection(Base):
    """Rendered section in one library intelligence version."""

    __tablename__ = "library_intelligence_sections"

    id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        primary_key=True,
        server_default=text("gen_random_uuid()"),
    )
    version_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("library_intelligence_versions.id"),
        nullable=False,
    )
    section_kind: Mapped[str] = mapped_column(Text, nullable=False)
    title: Mapped[str] = mapped_column(Text, nullable=False)
    body: Mapped[str] = mapped_column(Text, nullable=False)
    ordinal: Mapped[int] = mapped_column(Integer, nullable=False)
    metadata_json: Mapped[dict[str, object]] = mapped_column(
        "metadata",
        JSONB,
        nullable=False,
        server_default=text("'{}'::jsonb"),
    )
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True),
        server_default=text("now()"),
        nullable=False,
    )

    __table_args__ = (
        CheckConstraint("ordinal >= 0", name="ck_library_intelligence_sections_ordinal"),
        CheckConstraint(
            "section_kind IN ('overview', 'key_topics', 'key_sources', 'tensions', "
            "'open_questions', 'reading_path', 'recent_changes')",
            name="ck_library_intelligence_sections_kind",
        ),
        CheckConstraint(
            "jsonb_typeof(metadata) = 'object'",
            name="ck_library_intelligence_sections_metadata_object",
        ),
        UniqueConstraint(
            "version_id",
            "section_kind",
            name="uix_library_intelligence_sections_kind",
        ),
        UniqueConstraint(
            "version_id",
            "ordinal",
            name="uix_library_intelligence_sections_ordinal",
        ),
    )


class LibraryIntelligenceNode(Base):
    """Topic, source, tension, or question node in one artifact version."""

    __tablename__ = "library_intelligence_nodes"

    id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        primary_key=True,
        server_default=text("gen_random_uuid()"),
    )
    version_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("library_intelligence_versions.id"),
        nullable=False,
    )
    node_type: Mapped[str] = mapped_column(Text, nullable=False)
    slug: Mapped[str] = mapped_column(Text, nullable=False)
    title: Mapped[str] = mapped_column(Text, nullable=False)
    body: Mapped[str] = mapped_column(Text, nullable=False)
    metadata_json: Mapped[dict[str, object]] = mapped_column(
        "metadata",
        JSONB,
        nullable=False,
        server_default=text("'{}'::jsonb"),
    )
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True),
        server_default=text("now()"),
        nullable=False,
    )

    __table_args__ = (
        CheckConstraint(
            "node_type IN ('topic', 'entity', 'source', 'tension', 'open_question')",
            name="ck_library_intelligence_nodes_type",
        ),
        CheckConstraint(
            "char_length(slug) BETWEEN 1 AND 160",
            name="ck_library_intelligence_nodes_slug_length",
        ),
        CheckConstraint(
            "jsonb_typeof(metadata) = 'object'",
            name="ck_library_intelligence_nodes_metadata_object",
        ),
        UniqueConstraint("version_id", "slug", name="uix_library_intelligence_nodes_slug"),
        Index(
            "idx_library_intelligence_nodes_version_type",
            "version_id",
            "node_type",
        ),
    )


class LibraryIntelligenceClaim(Base):
    """Evidence-verifiable claim in one library intelligence artifact."""

    __tablename__ = "library_intelligence_claims"

    id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        primary_key=True,
        server_default=text("gen_random_uuid()"),
    )
    version_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("library_intelligence_versions.id"),
        nullable=False,
    )
    node_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("library_intelligence_nodes.id"),
        nullable=True,
    )
    section_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("library_intelligence_sections.id"),
        nullable=True,
    )
    claim_text: Mapped[str] = mapped_column(Text, nullable=False)
    support_state: Mapped[str] = mapped_column(Text, nullable=False)
    confidence: Mapped[float | None] = mapped_column(Float, nullable=True)
    ordinal: Mapped[int] = mapped_column(Integer, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True),
        server_default=text("now()"),
        nullable=False,
    )

    __table_args__ = (
        CheckConstraint(
            "node_id IS NOT NULL OR section_id IS NOT NULL",
            name="ck_library_intelligence_claims_parent",
        ),
        CheckConstraint(
            "char_length(btrim(claim_text)) BETWEEN 1 AND 50000",
            name="ck_library_intelligence_claims_text_length",
        ),
        CheckConstraint(
            """
            support_state IN (
                'supported',
                'partially_supported',
                'contradicted',
                'not_enough_evidence',
                'out_of_scope',
                'not_source_grounded'
            )
            """,
            name="ck_library_intelligence_claims_support_state",
        ),
        CheckConstraint(
            "confidence IS NULL OR (confidence >= 0 AND confidence <= 1)",
            name="ck_library_intelligence_claims_confidence",
        ),
        CheckConstraint("ordinal >= 0", name="ck_library_intelligence_claims_ordinal"),
        UniqueConstraint(
            "version_id",
            "ordinal",
            name="uix_library_intelligence_claims_version_ordinal",
        ),
    )


class LibraryIntelligenceEvidence(Base):
    """Exact source evidence for one library intelligence claim."""

    __tablename__ = "library_intelligence_evidence"

    id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        primary_key=True,
        server_default=text("gen_random_uuid()"),
    )
    claim_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("library_intelligence_claims.id"),
        nullable=False,
    )
    source_ref: Mapped[dict[str, object]] = mapped_column(JSONB, nullable=False)
    snippet: Mapped[str] = mapped_column(Text, nullable=False)
    locator: Mapped[dict[str, object] | None] = mapped_column(JSONB, nullable=True)
    support_role: Mapped[str] = mapped_column(Text, nullable=False)
    retrieval_status: Mapped[str] = mapped_column(Text, nullable=False)
    score: Mapped[float | None] = mapped_column(Float, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True),
        server_default=text("now()"),
        nullable=False,
    )

    __table_args__ = (
        CheckConstraint(
            "jsonb_typeof(source_ref) = 'object'",
            name="ck_library_intelligence_evidence_source_ref_object",
        ),
        CheckConstraint(
            "locator IS NULL OR locator = 'null'::jsonb OR jsonb_typeof(locator) = 'object'",
            name="ck_library_intelligence_evidence_locator_object",
        ),
        CheckConstraint(
            "support_role IN ('supports', 'contradicts', 'context')",
            name="ck_library_intelligence_evidence_support_role",
        ),
        CheckConstraint(
            "retrieval_status IN ('retrieved', 'selected', 'included_in_artifact', "
            "'excluded_by_scope', 'excluded_by_source_state')",
            name="ck_library_intelligence_evidence_retrieval_status",
        ),
        CheckConstraint(
            "score IS NULL OR score >= 0",
            name="ck_library_intelligence_evidence_score",
        ),
        Index("idx_library_intelligence_evidence_claim", "claim_id"),
    )


class LibraryIntelligenceBuild(Base):
    """Durable build record for a library intelligence artifact."""

    __tablename__ = "library_intelligence_builds"

    id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        primary_key=True,
        server_default=text("gen_random_uuid()"),
    )
    library_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("libraries.id"),
        nullable=False,
    )
    source_set_version_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("library_source_set_versions.id"),
        nullable=False,
    )
    artifact_kind: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False)
    idempotency_key: Mapped[str] = mapped_column(Text, nullable=False)
    phase: Mapped[str] = mapped_column(Text, nullable=False)
    error_code: Mapped[str | None] = mapped_column(Text, nullable=True)
    diagnostics: Mapped[dict[str, object]] = mapped_column(
        JSONB,
        nullable=False,
        server_default=text("'{}'::jsonb"),
    )
    started_at: Mapped[datetime | None] = mapped_column(TIMESTAMP(timezone=True), nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column(TIMESTAMP(timezone=True), nullable=True)
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
            "artifact_kind IN ('overview')",
            name="ck_library_intelligence_builds_kind",
        ),
        CheckConstraint(
            "status IN ('pending', 'running', 'succeeded', 'failed')",
            name="ck_library_intelligence_builds_status",
        ),
        CheckConstraint(
            "phase IN ('queued', 'source_set', 'synthesis', 'evidence', "
            "'publish', 'complete', 'failed')",
            name="ck_library_intelligence_builds_phase",
        ),
        CheckConstraint(
            "jsonb_typeof(diagnostics) = 'object'",
            name="ck_library_intelligence_builds_diagnostics_object",
        ),
        CheckConstraint(
            "(status = 'failed' AND error_code IS NOT NULL) OR (status != 'failed')",
            name="ck_library_intelligence_builds_failed_error",
        ),
        UniqueConstraint(
            "idempotency_key",
            name="uix_library_intelligence_builds_idempotency_key",
        ),
        Index(
            "idx_library_intelligence_builds_library_status",
            "library_id",
            "status",
        ),
    )


# =============================================================================
# Slice 7: Podcasts
# =============================================================================


class Podcast(Base):
    """Global podcast metadata from discovery providers."""

    __tablename__ = "podcasts"

    id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        primary_key=True,
        server_default=text("gen_random_uuid()"),
    )
    provider: Mapped[str] = mapped_column(Text, nullable=False)
    provider_podcast_id: Mapped[str] = mapped_column(Text, nullable=False)
    title: Mapped[str] = mapped_column(Text, nullable=False)
    feed_url: Mapped[str] = mapped_column(Text, nullable=False)
    website_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    image_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
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
            "provider",
            "provider_podcast_id",
            name="uq_podcasts_provider_provider_podcast_id",
        ),
        UniqueConstraint("feed_url", name="uq_podcasts_feed_url"),
    )

    episodes: Mapped[list["PodcastEpisode"]] = relationship(
        "PodcastEpisode", back_populates="podcast", cascade="all, delete-orphan"
    )
    library_entries: Mapped[list["LibraryEntry"]] = relationship(
        "LibraryEntry", back_populates="podcast", cascade="all, delete-orphan"
    )
    contributor_credits: Mapped[list["ContributorCredit"]] = relationship(
        "ContributorCredit",
        back_populates="podcast",
        order_by=lambda: ContributorCredit.ordinal,
    )


class PodcastSubscription(Base):
    """Per-user subscription to a global podcast."""

    __tablename__ = "podcast_subscriptions"

    user_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        primary_key=True,
    )
    podcast_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("podcasts.id", ondelete="CASCADE"),
        primary_key=True,
    )
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default="active")
    auto_queue: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default="false")
    default_playback_speed: Mapped[float | None] = mapped_column(Float, nullable=True)
    sync_status: Mapped[str] = mapped_column(Text, nullable=False, server_default="pending")
    sync_error_code: Mapped[str | None] = mapped_column(Text, nullable=True)
    sync_error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    sync_attempts: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    sync_started_at: Mapped[datetime | None] = mapped_column(
        TIMESTAMP(timezone=True), nullable=True
    )
    sync_completed_at: Mapped[datetime | None] = mapped_column(
        TIMESTAMP(timezone=True), nullable=True
    )
    last_synced_at: Mapped[datetime | None] = mapped_column(TIMESTAMP(timezone=True), nullable=True)
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
            "status IN ('active', 'unsubscribed')",
            name="ck_podcast_subscriptions_status",
        ),
        CheckConstraint(
            "sync_status IN ('pending', 'running', 'partial', 'complete', 'source_limited', 'failed')",
            name="ck_podcast_subscriptions_sync_status",
        ),
        CheckConstraint(
            "sync_attempts >= 0",
            name="ck_podcast_subscriptions_sync_attempts_non_negative",
        ),
        CheckConstraint(
            "default_playback_speed IS NULL OR (default_playback_speed >= 0.5 AND default_playback_speed <= 3.0)",
            name="ck_podcast_subscriptions_default_playback_speed_range",
        ),
    )

    podcast: Mapped["Podcast"] = relationship("Podcast")


class PodcastSubscriptionPollRun(Base):
    """Durable telemetry row for one scheduled active-subscription poll run."""

    __tablename__ = "podcast_subscription_poll_runs"

    id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        primary_key=True,
        server_default=text("gen_random_uuid()"),
    )
    orchestration_source: Mapped[str] = mapped_column(
        Text, nullable=False, server_default="scheduled"
    )
    scheduler_identity: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default="running")
    run_limit: Mapped[int] = mapped_column(Integer, nullable=False)
    started_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True),
        nullable=False,
        server_default=text("now()"),
    )
    completed_at: Mapped[datetime | None] = mapped_column(TIMESTAMP(timezone=True), nullable=True)
    lease_expires_at: Mapped[datetime] = mapped_column(TIMESTAMP(timezone=True), nullable=False)
    processed_count: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    failed_count: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    skipped_count: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    scanned_count: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    error_code: Mapped[str | None] = mapped_column(Text, nullable=True)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
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
            "status IN ('running', 'completed', 'failed', 'expired')",
            name="ck_podcast_subscription_poll_runs_status",
        ),
        CheckConstraint(
            "run_limit >= 1",
            name="ck_podcast_subscription_poll_runs_run_limit_positive",
        ),
        CheckConstraint(
            "processed_count >= 0 AND failed_count >= 0 AND skipped_count >= 0 AND scanned_count >= 0",
            name="ck_podcast_subscription_poll_runs_counters_non_negative",
        ),
    )

    failure_breakdown: Mapped[list["PodcastSubscriptionPollRunFailure"]] = relationship(
        "PodcastSubscriptionPollRunFailure",
        back_populates="run",
        cascade="all, delete-orphan",
    )


class PodcastSubscriptionPollRunFailure(Base):
    """Per-run stable failure-code breakdown for scheduled podcast polling."""

    __tablename__ = "podcast_subscription_poll_run_failures"

    run_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("podcast_subscription_poll_runs.id", ondelete="CASCADE"),
        primary_key=True,
    )
    error_code: Mapped[str] = mapped_column(Text, primary_key=True)
    failure_count: Mapped[int] = mapped_column(Integer, nullable=False)

    __table_args__ = (
        CheckConstraint(
            "failure_count >= 1",
            name="ck_podcast_subscription_poll_run_failures_count_positive",
        ),
    )

    run: Mapped["PodcastSubscriptionPollRun"] = relationship(
        "PodcastSubscriptionPollRun",
        back_populates="failure_breakdown",
    )


class PodcastEpisode(Base):
    """Global episode identity and metadata for podcast media rows."""

    __tablename__ = "podcast_episodes"

    media_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("media.id", ondelete="CASCADE"),
        primary_key=True,
    )
    podcast_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("podcasts.id", ondelete="CASCADE"),
        nullable=False,
    )
    provider_episode_id: Mapped[str] = mapped_column(Text, nullable=False)
    guid: Mapped[str | None] = mapped_column(Text, nullable=True)
    fallback_identity: Mapped[str] = mapped_column(Text, nullable=False)
    published_at: Mapped[datetime | None] = mapped_column(TIMESTAMP(timezone=True), nullable=True)
    duration_seconds: Mapped[int | None] = mapped_column(Integer, nullable=True)
    description_html: Mapped[str | None] = mapped_column(Text, nullable=True)
    description_text: Mapped[str | None] = mapped_column(Text, nullable=True)
    rss_transcript_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True),
        server_default=text("now()"),
        nullable=False,
    )

    __table_args__ = (
        UniqueConstraint(
            "podcast_id",
            "provider_episode_id",
            name="uq_podcast_episodes_podcast_provider_episode_id",
        ),
        UniqueConstraint(
            "podcast_id",
            "fallback_identity",
            name="uq_podcast_episodes_podcast_fallback_identity",
        ),
        CheckConstraint(
            "duration_seconds IS NULL OR duration_seconds > 0",
            name="ck_podcast_episodes_duration_positive",
        ),
        Index(
            "uq_podcast_episodes_podcast_guid_not_null",
            "podcast_id",
            "guid",
            unique=True,
            postgresql_where=text("guid IS NOT NULL"),
        ),
    )

    media: Mapped["Media"] = relationship("Media", back_populates="podcast_episode")
    podcast: Mapped["Podcast"] = relationship("Podcast", back_populates="episodes")


class PodcastEpisodeChapter(Base):
    """Episode-level chapter markers extracted from RSS metadata."""

    __tablename__ = "podcast_episode_chapters"

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
    chapter_idx: Mapped[int] = mapped_column(Integer, nullable=False)
    title: Mapped[str] = mapped_column(Text, nullable=False)
    t_start_ms: Mapped[int] = mapped_column(Integer, nullable=False)
    t_end_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    url: Mapped[str | None] = mapped_column(Text, nullable=True)
    image_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    source: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True),
        server_default=text("now()"),
        nullable=False,
    )

    __table_args__ = (
        UniqueConstraint(
            "media_id",
            "chapter_idx",
            name="uq_podcast_episode_chapters_media_idx",
        ),
        CheckConstraint(
            "chapter_idx >= 0",
            name="ck_podcast_episode_chapters_idx_non_negative",
        ),
        CheckConstraint(
            "t_start_ms >= 0",
            name="ck_podcast_episode_chapters_start_non_negative",
        ),
        CheckConstraint(
            "t_end_ms IS NULL OR t_end_ms >= t_start_ms",
            name="ck_podcast_episode_chapters_end_not_before_start",
        ),
        CheckConstraint(
            "source IN ('rss_podcasting20', 'rss_podlove', 'embedded_mp4', 'embedded_id3')",
            name="ck_podcast_episode_chapters_source",
        ),
        Index(
            "ix_podcast_episode_chapters_media_t_start_ms",
            "media_id",
            "t_start_ms",
        ),
    )

    media: Mapped["Media"] = relationship("Media", back_populates="podcast_episode_chapters")


class PodcastListeningState(Base):
    """Per-user playback state for podcast/audio media resume."""

    __tablename__ = "podcast_listening_states"

    user_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        primary_key=True,
    )
    media_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("media.id", ondelete="CASCADE"),
        primary_key=True,
    )
    position_ms: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    duration_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    playback_speed: Mapped[float] = mapped_column(Float, nullable=False, server_default="1.0")
    is_completed: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default="false")
    updated_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True),
        server_default=text("now()"),
        nullable=False,
    )

    __table_args__ = (
        CheckConstraint(
            "position_ms >= 0",
            name="ck_podcast_listening_states_position_ms_non_negative",
        ),
        CheckConstraint(
            "duration_ms IS NULL OR duration_ms >= 0",
            name="ck_podcast_listening_states_duration_ms_non_negative",
        ),
        CheckConstraint(
            "playback_speed > 0",
            name="ck_podcast_listening_states_playback_speed_positive",
        ),
        Index("ix_podcast_listening_states_media_id", "media_id"),
    )

    media: Mapped["Media"] = relationship("Media", back_populates="podcast_listening_states")
    user: Mapped["User"] = relationship("User", back_populates="podcast_listening_states")


class PlaybackQueueItem(Base):
    """Per-user ordered playback queue item."""

    __tablename__ = "playback_queue_items"

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
    media_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("media.id", ondelete="CASCADE"),
        nullable=False,
    )
    position: Mapped[int] = mapped_column(Integer, nullable=False)
    added_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True),
        server_default=text("now()"),
        nullable=False,
    )
    source: Mapped[str] = mapped_column(Text, nullable=False, server_default="manual")

    __table_args__ = (
        UniqueConstraint("user_id", "media_id", name="uq_playback_queue_items_user_media"),
        CheckConstraint(
            "position >= 0",
            name="ck_playback_queue_items_position_non_negative",
        ),
        CheckConstraint(
            "source IN ('manual', 'auto_subscription', 'auto_playlist')",
            name="ck_playback_queue_items_source",
        ),
        Index("ix_playback_queue_items_user_position", "user_id", "position"),
    )

    user: Mapped["User"] = relationship("User", back_populates="playback_queue_items")
    media: Mapped["Media"] = relationship("Media", back_populates="playback_queue_items")


class PodcastTranscriptionJob(Base):
    """One transcription-work record per globally ingested podcast episode."""

    __tablename__ = "podcast_transcription_jobs"

    media_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("media.id", ondelete="CASCADE"),
        primary_key=True,
    )
    requested_by_user_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )
    request_reason: Mapped[str] = mapped_column(Text, nullable=False, server_default="episode_open")
    reserved_minutes: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    reservation_usage_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default="pending")
    error_code: Mapped[str | None] = mapped_column(Text, nullable=True)
    attempts: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    started_at: Mapped[datetime | None] = mapped_column(TIMESTAMP(timezone=True), nullable=True)
    completed_at: Mapped[datetime | None] = mapped_column(TIMESTAMP(timezone=True), nullable=True)
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
            "status IN ('pending', 'running', 'completed', 'failed')",
            name="ck_podcast_transcription_jobs_status",
        ),
        CheckConstraint(
            "attempts >= 0",
            name="ck_podcast_transcription_jobs_attempts_non_negative",
        ),
        CheckConstraint(
            "reserved_minutes >= 0",
            name="ck_podcast_transcription_jobs_reserved_minutes_non_negative",
        ),
        CheckConstraint(
            "request_reason IN ("
            "'episode_open', 'search', 'highlight', 'quote', 'background_warming', 'operator_requeue', 'rss_feed'"
            ")",
            name="ck_podcast_transcription_jobs_request_reason",
        ),
    )

    media: Mapped["Media"] = relationship("Media", back_populates="podcast_transcription_job")


class PodcastTranscriptionUsageDaily(Base):
    """Per-user UTC-day transcription usage ledger."""

    __tablename__ = "podcast_transcription_usage_daily"

    user_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        primary_key=True,
    )
    usage_date: Mapped[date] = mapped_column(Date, primary_key=True)
    minutes_used: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    minutes_reserved: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    updated_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True),
        server_default=text("now()"),
        nullable=False,
    )

    __table_args__ = (
        CheckConstraint(
            "minutes_used >= 0 AND minutes_reserved >= 0",
            name="ck_podcast_transcription_usage_daily_non_negative",
        ),
    )


class PodcastTranscriptVersion(Base):
    """Immutable transcript artifact version for a media item."""

    __tablename__ = "podcast_transcript_versions"

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
    version_no: Mapped[int] = mapped_column(Integer, nullable=False)
    transcript_coverage: Mapped[str] = mapped_column(
        Text,
        nullable=False,
        server_default=TranscriptCoverage.full.value,
    )
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default="false")
    request_reason: Mapped[str] = mapped_column(Text, nullable=False, server_default="episode_open")
    created_by_user_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="SET NULL"),
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
        UniqueConstraint("media_id", "version_no", name="uq_podcast_transcript_versions_media_no"),
        CheckConstraint(
            "version_no >= 1",
            name="ck_podcast_transcript_versions_version_no_positive",
        ),
        CheckConstraint(
            "transcript_coverage IN ('none', 'partial', 'full')",
            name="ck_podcast_transcript_versions_coverage",
        ),
        CheckConstraint(
            "request_reason IN ("
            "'episode_open', 'search', 'highlight', 'quote', 'background_warming', 'operator_requeue', 'rss_feed'"
            ")",
            name="ck_podcast_transcript_versions_request_reason",
        ),
        Index(
            "uix_podcast_transcript_versions_media_active",
            "media_id",
            unique=True,
            postgresql_where=text("is_active"),
        ),
    )

    media: Mapped["Media"] = relationship("Media", back_populates="transcript_versions")
    segments: Mapped[list["PodcastTranscriptSegment"]] = relationship(
        "PodcastTranscriptSegment",
        back_populates="transcript_version",
        cascade="all, delete-orphan",
    )
    fragments: Mapped[list["Fragment"]] = relationship(
        "Fragment",
        back_populates="transcript_version",
    )


class PodcastTranscriptSegment(Base):
    """Segment artifact persisted per transcript version."""

    __tablename__ = "podcast_transcript_segments"

    id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        primary_key=True,
        server_default=text("gen_random_uuid()"),
    )
    transcript_version_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("podcast_transcript_versions.id", ondelete="CASCADE"),
        nullable=False,
    )
    media_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("media.id", ondelete="CASCADE"),
        nullable=False,
    )
    segment_idx: Mapped[int] = mapped_column(Integer, nullable=False)
    canonical_text: Mapped[str] = mapped_column(Text, nullable=False)
    t_start_ms: Mapped[int] = mapped_column(BigInteger, nullable=False)
    t_end_ms: Mapped[int] = mapped_column(BigInteger, nullable=False)
    speaker_label: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True),
        server_default=text("now()"),
        nullable=False,
    )

    __table_args__ = (
        UniqueConstraint(
            "transcript_version_id",
            "segment_idx",
            name="uq_podcast_transcript_segments_version_idx",
        ),
        CheckConstraint(
            "segment_idx >= 0",
            name="ck_podcast_transcript_segments_segment_idx_non_negative",
        ),
        CheckConstraint(
            "t_start_ms >= 0 AND t_end_ms > t_start_ms",
            name="ck_podcast_transcript_segments_time_offsets_valid",
        ),
        Index(
            "ix_podcast_transcript_segments_media_start",
            "media_id",
            "t_start_ms",
            "segment_idx",
        ),
    )

    transcript_version: Mapped["PodcastTranscriptVersion"] = relationship(
        "PodcastTranscriptVersion", back_populates="segments"
    )
    media: Mapped["Media"] = relationship("Media")


class ContentIndexRun(Base):
    """One versioned evidence-index attempt for a media item."""

    __tablename__ = "content_index_runs"

    id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        primary_key=True,
        server_default=text("gen_random_uuid()"),
    )
    media_id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), ForeignKey("media.id"))
    state: Mapped[str] = mapped_column(Text, nullable=False)
    source_version: Mapped[str] = mapped_column(Text, nullable=False)
    extractor_version: Mapped[str] = mapped_column(Text, nullable=False)
    chunker_version: Mapped[str] = mapped_column(Text, nullable=False)
    embedding_provider: Mapped[str] = mapped_column(Text, nullable=False)
    embedding_model: Mapped[str] = mapped_column(Text, nullable=False)
    embedding_version: Mapped[str] = mapped_column(Text, nullable=False)
    embedding_config_hash: Mapped[str] = mapped_column(Text, nullable=False)
    started_at: Mapped[datetime] = mapped_column(TIMESTAMP(timezone=True), nullable=False)
    finished_at: Mapped[datetime | None] = mapped_column(TIMESTAMP(timezone=True), nullable=True)
    failure_code: Mapped[str | None] = mapped_column(Text, nullable=True)
    failure_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    activated_at: Mapped[datetime | None] = mapped_column(TIMESTAMP(timezone=True), nullable=True)
    deactivated_at: Mapped[datetime | None] = mapped_column(TIMESTAMP(timezone=True), nullable=True)
    superseded_by_run_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("content_index_runs.id"),
        nullable=True,
    )
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True),
        server_default=text("now()"),
        nullable=False,
    )

    __table_args__ = (
        CheckConstraint(
            "state IN ('pending', 'extracting', 'indexing', 'embedding', 'ready', "
            "'no_text', 'ocr_required', 'failed')",
            name="ck_content_index_runs_state",
        ),
        Index("ix_content_index_runs_media", "media_id"),
    )

    media: Mapped["Media"] = relationship("Media", back_populates="content_index_runs")


class SourceSnapshot(Base):
    """Immutable source artifact used by a content index run."""

    __tablename__ = "source_snapshots"

    id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        primary_key=True,
        server_default=text("gen_random_uuid()"),
    )
    media_id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), ForeignKey("media.id"))
    index_run_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("content_index_runs.id"),
    )
    source_kind: Mapped[str] = mapped_column(Text, nullable=False)
    artifact_kind: Mapped[str] = mapped_column(Text, nullable=False)
    artifact_ref: Mapped[str] = mapped_column(Text, nullable=False)
    content_type: Mapped[str] = mapped_column(Text, nullable=False)
    byte_length: Mapped[int] = mapped_column(BigInteger, nullable=False)
    source_fingerprint: Mapped[str] = mapped_column(Text, nullable=False)
    source_version: Mapped[str] = mapped_column(Text, nullable=False)
    extractor_version: Mapped[str] = mapped_column(Text, nullable=False)
    content_sha256: Mapped[str] = mapped_column(Text, nullable=False)
    parent_snapshot_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("source_snapshots.id"),
        nullable=True,
    )
    language: Mapped[str | None] = mapped_column(Text, nullable=True)
    snapshot_metadata: Mapped[dict[str, object]] = mapped_column(
        "metadata",
        JSONB,
        nullable=False,
    )
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True),
        server_default=text("now()"),
        nullable=False,
    )

    __table_args__ = (
        CheckConstraint("byte_length >= 0", name="ck_source_snapshots_byte_length"),
        CheckConstraint(
            "char_length(btrim(source_fingerprint)) > 0",
            name="ck_source_snapshots_fingerprint",
        ),
        CheckConstraint("char_length(content_sha256) = 64", name="ck_source_snapshots_sha"),
        CheckConstraint("jsonb_typeof(metadata) = 'object'", name="ck_source_snapshots_metadata"),
        Index("ix_source_snapshots_media_run", "media_id", "index_run_id"),
    )

    media: Mapped["Media"] = relationship("Media", back_populates="source_snapshots")


class ContentBlock(Base):
    """Format-aware block of canonical source text."""

    __tablename__ = "content_blocks"

    id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        primary_key=True,
        server_default=text("gen_random_uuid()"),
    )
    media_id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), ForeignKey("media.id"))
    index_run_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("content_index_runs.id"),
    )
    source_snapshot_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("source_snapshots.id"),
    )
    block_idx: Mapped[int] = mapped_column(Integer, nullable=False)
    block_kind: Mapped[str] = mapped_column(Text, nullable=False)
    canonical_text: Mapped[str] = mapped_column(Text, nullable=False)
    text_sha256: Mapped[str] = mapped_column(Text, nullable=False)
    extraction_confidence: Mapped[float | None] = mapped_column(Float, nullable=True)
    source_start_offset: Mapped[int] = mapped_column(Integer, nullable=False)
    source_end_offset: Mapped[int] = mapped_column(Integer, nullable=False)
    parent_block_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("content_blocks.id"),
        nullable=True,
    )
    heading_path: Mapped[list[str]] = mapped_column(JSONB, nullable=False)
    locator: Mapped[dict[str, object]] = mapped_column(JSONB, nullable=False)
    selector: Mapped[dict[str, object]] = mapped_column(JSONB, nullable=False)
    metadata_json: Mapped[dict[str, object]] = mapped_column(
        "metadata",
        JSONB,
        nullable=False,
    )
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True),
        server_default=text("now()"),
        nullable=False,
    )

    __table_args__ = (
        CheckConstraint("block_idx >= 0", name="ck_content_blocks_block_idx"),
        CheckConstraint("source_start_offset >= 0", name="ck_content_blocks_start"),
        CheckConstraint(
            "source_end_offset >= source_start_offset", name="ck_content_blocks_offsets"
        ),
        CheckConstraint("char_length(text_sha256) = 64", name="ck_content_blocks_sha"),
        CheckConstraint("jsonb_typeof(heading_path) = 'array'", name="ck_content_blocks_heading"),
        CheckConstraint("jsonb_typeof(locator) = 'object'", name="ck_content_blocks_locator"),
        CheckConstraint("jsonb_typeof(selector) = 'object'", name="ck_content_blocks_selector"),
        CheckConstraint("jsonb_typeof(metadata) = 'object'", name="ck_content_blocks_metadata"),
        CheckConstraint(
            "extraction_confidence IS NULL OR "
            "(extraction_confidence >= 0 AND extraction_confidence <= 1)",
            name="ck_content_blocks_extraction_confidence",
        ),
        UniqueConstraint("index_run_id", "block_idx", name="uq_content_blocks_run_idx"),
        Index("ix_content_blocks_media_run", "media_id", "index_run_id"),
    )


class EvidenceSpan(Base):
    """Durable citeable span over content blocks."""

    __tablename__ = "evidence_spans"

    id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        primary_key=True,
        server_default=text("gen_random_uuid()"),
    )
    media_id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), ForeignKey("media.id"))
    index_run_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("content_index_runs.id"),
    )
    source_snapshot_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("source_snapshots.id"),
    )
    start_block_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("content_blocks.id"),
    )
    end_block_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("content_blocks.id"),
    )
    start_block_offset: Mapped[int] = mapped_column(Integer, nullable=False)
    end_block_offset: Mapped[int] = mapped_column(Integer, nullable=False)
    span_text: Mapped[str] = mapped_column(Text, nullable=False)
    span_sha256: Mapped[str] = mapped_column(Text, nullable=False)
    selector: Mapped[dict[str, object]] = mapped_column(JSONB, nullable=False)
    citation_label: Mapped[str] = mapped_column(Text, nullable=False)
    resolver_kind: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True),
        server_default=text("now()"),
        nullable=False,
    )

    __table_args__ = (
        CheckConstraint("start_block_offset >= 0", name="ck_evidence_spans_start"),
        CheckConstraint(
            "start_block_id <> end_block_id OR end_block_offset >= start_block_offset",
            name="ck_evidence_spans_offsets",
        ),
        CheckConstraint("char_length(span_sha256) = 64", name="ck_evidence_spans_sha"),
        CheckConstraint("jsonb_typeof(selector) = 'object'", name="ck_evidence_spans_selector"),
        CheckConstraint(
            "resolver_kind IN ('web', 'epub', 'pdf', 'transcript')",
            name="ck_evidence_spans_resolver",
        ),
        Index("ix_evidence_spans_media_run", "media_id", "index_run_id"),
    )


class ContentChunk(Base):
    """Retrieval chunk built from content blocks."""

    __tablename__ = "content_chunks"

    id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        primary_key=True,
        server_default=text("gen_random_uuid()"),
    )
    media_id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), ForeignKey("media.id"))
    index_run_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("content_index_runs.id"),
    )
    source_snapshot_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("source_snapshots.id"),
    )
    primary_evidence_span_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("evidence_spans.id"),
        nullable=True,
    )
    chunk_idx: Mapped[int] = mapped_column(Integer, nullable=False)
    source_kind: Mapped[str] = mapped_column(Text, nullable=False)
    chunk_text: Mapped[str] = mapped_column(Text, nullable=False)
    chunk_sha256: Mapped[str] = mapped_column(Text, nullable=False)
    chunker_version: Mapped[str] = mapped_column(Text, nullable=False)
    token_count: Mapped[int] = mapped_column(Integer, nullable=False)
    heading_path: Mapped[list[str]] = mapped_column(JSONB, nullable=False)
    summary_locator: Mapped[dict[str, object]] = mapped_column(JSONB, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True),
        server_default=text("now()"),
        nullable=False,
    )

    __table_args__ = (
        CheckConstraint("chunk_idx >= 0", name="ck_content_chunks_chunk_idx_non_negative"),
        CheckConstraint(
            "source_kind IN ('web_article', 'epub', 'pdf', 'transcript')",
            name="ck_content_chunks_source_kind",
        ),
        CheckConstraint("char_length(chunk_sha256) = 64", name="ck_content_chunks_sha"),
        CheckConstraint("token_count >= 0", name="ck_content_chunks_token_count"),
        CheckConstraint("jsonb_typeof(heading_path) = 'array'", name="ck_content_chunks_heading"),
        CheckConstraint(
            "jsonb_typeof(summary_locator) = 'object'", name="ck_content_chunks_locator"
        ),
        UniqueConstraint("index_run_id", "chunk_idx", name="uq_content_chunks_run_idx"),
        Index("ix_content_chunks_media_run", "media_id", "index_run_id"),
        Index("ix_content_chunks_run_idx", "index_run_id", "chunk_idx"),
    )

    media: Mapped["Media"] = relationship("Media", back_populates="content_chunks")


class ContentChunkPart(Base):
    """Exact block slice that composes a content chunk."""

    __tablename__ = "content_chunk_parts"

    id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        primary_key=True,
        server_default=text("gen_random_uuid()"),
    )
    chunk_id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), ForeignKey("content_chunks.id"))
    part_idx: Mapped[int] = mapped_column(Integer, nullable=False)
    block_id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), ForeignKey("content_blocks.id"))
    block_start_offset: Mapped[int] = mapped_column(Integer, nullable=False)
    block_end_offset: Mapped[int] = mapped_column(Integer, nullable=False)
    chunk_start_offset: Mapped[int] = mapped_column(Integer, nullable=False)
    chunk_end_offset: Mapped[int] = mapped_column(Integer, nullable=False)
    separator_before: Mapped[str] = mapped_column(Text, nullable=False, server_default="")
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True),
        server_default=text("now()"),
        nullable=False,
    )

    __table_args__ = (
        CheckConstraint("part_idx >= 0", name="ck_content_chunk_parts_part_idx"),
        CheckConstraint("block_start_offset >= 0", name="ck_content_chunk_parts_block_start"),
        CheckConstraint(
            "block_end_offset >= block_start_offset",
            name="ck_content_chunk_parts_block_offsets",
        ),
        CheckConstraint("chunk_start_offset >= 0", name="ck_content_chunk_parts_chunk_start"),
        CheckConstraint(
            "chunk_end_offset >= chunk_start_offset",
            name="ck_content_chunk_parts_chunk_offsets",
        ),
        UniqueConstraint("chunk_id", "part_idx", name="uq_content_chunk_parts_chunk_part"),
        Index("ix_content_chunk_parts_chunk", "chunk_id"),
    )


class ContentEmbedding(Base):
    """Model-specific embedding for one content chunk."""

    __tablename__ = "content_embeddings"

    id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        primary_key=True,
        server_default=text("gen_random_uuid()"),
    )
    chunk_id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), ForeignKey("content_chunks.id"))
    embedding_provider: Mapped[str] = mapped_column(Text, nullable=False)
    embedding_model: Mapped[str] = mapped_column(Text, nullable=False)
    embedding_version: Mapped[str] = mapped_column(Text, nullable=False)
    embedding_config_hash: Mapped[str] = mapped_column(Text, nullable=False)
    embedding_dimensions: Mapped[int] = mapped_column(Integer, nullable=False)
    embedding_vector: Mapped[list[float] | None] = mapped_column(PGVector(256), nullable=True)
    embedding_sha256: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True),
        server_default=text("now()"),
        nullable=False,
    )

    __table_args__ = (
        CheckConstraint("embedding_dimensions > 0", name="ck_content_embeddings_dimensions"),
        CheckConstraint("char_length(embedding_sha256) = 64", name="ck_content_embeddings_sha"),
        Index(
            "ix_content_embeddings_model",
            "embedding_provider",
            "embedding_model",
            "embedding_version",
            "embedding_config_hash",
        ),
    )


class MediaContentIndexState(Base):
    """Active evidence index pointer for a media item."""

    __tablename__ = "media_content_index_states"

    id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        primary_key=True,
        server_default=text("gen_random_uuid()"),
    )
    media_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("media.id"),
        nullable=False,
    )
    active_run_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("content_index_runs.id"),
        nullable=True,
    )
    latest_run_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("content_index_runs.id"),
        nullable=True,
    )
    status: Mapped[str] = mapped_column(Text, nullable=False)
    status_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    active_embedding_provider: Mapped[str | None] = mapped_column(Text, nullable=True)
    active_embedding_model: Mapped[str | None] = mapped_column(Text, nullable=True)
    active_embedding_version: Mapped[str | None] = mapped_column(Text, nullable=True)
    active_embedding_config_hash: Mapped[str | None] = mapped_column(Text, nullable=True)
    updated_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True),
        server_default=text("now()"),
        nullable=False,
    )
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True),
        server_default=text("now()"),
        nullable=False,
    )

    __table_args__ = (
        UniqueConstraint("media_id", name="uq_media_content_index_states_media"),
        CheckConstraint(
            "status IN ('pending', 'indexing', 'ready', 'no_text', 'ocr_required', 'failed')",
            name="ck_media_content_index_states_status",
        ),
    )

    media: Mapped["Media"] = relationship("Media", back_populates="content_index_state")


class MediaTranscriptState(Base):
    """Dedicated transcript-state table for media capabilities/search readiness."""

    __tablename__ = "media_transcript_states"

    media_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("media.id", ondelete="CASCADE"),
        primary_key=True,
    )
    transcript_state: Mapped[str] = mapped_column(
        Text,
        nullable=False,
        server_default=TranscriptState.not_requested.value,
    )
    transcript_coverage: Mapped[str] = mapped_column(
        Text,
        nullable=False,
        server_default=TranscriptCoverage.none.value,
    )
    semantic_status: Mapped[str] = mapped_column(
        Text,
        nullable=False,
        server_default=SemanticStatus.none.value,
    )
    active_transcript_version_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("podcast_transcript_versions.id", ondelete="SET NULL"),
        nullable=True,
    )
    last_request_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    last_error_code: Mapped[str | None] = mapped_column(Text, nullable=True)
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
            "transcript_state IN ("
            "'not_requested', 'queued', 'running', 'ready', 'partial', "
            "'unavailable', 'failed_quota', 'failed_provider'"
            ")",
            name="ck_media_transcript_states_state",
        ),
        CheckConstraint(
            "transcript_coverage IN ('none', 'partial', 'full')",
            name="ck_media_transcript_states_coverage",
        ),
        CheckConstraint(
            "semantic_status IN ('none', 'pending', 'ready', 'failed')",
            name="ck_media_transcript_states_semantic_status",
        ),
        CheckConstraint(
            "last_request_reason IS NULL OR last_request_reason IN ("
            "'episode_open', 'search', 'highlight', 'quote', 'background_warming', 'operator_requeue'"
            ")",
            name="ck_media_transcript_states_last_request_reason",
        ),
        Index("ix_media_transcript_states_semantic_status", "semantic_status"),
    )

    media: Mapped["Media"] = relationship("Media", back_populates="transcript_state")
    active_transcript_version: Mapped["PodcastTranscriptVersion | None"] = relationship(
        "PodcastTranscriptVersion"
    )


class PodcastTranscriptRequestAudit(Base):
    """Immutable audit log for each transcript request attempt."""

    __tablename__ = "podcast_transcript_request_audits"

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
    requested_by_user_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )
    request_reason: Mapped[str] = mapped_column(Text, nullable=False)
    dry_run: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default="false")
    outcome: Mapped[str] = mapped_column(Text, nullable=False)
    required_minutes: Mapped[int | None] = mapped_column(Integer, nullable=True)
    remaining_minutes: Mapped[int | None] = mapped_column(Integer, nullable=True)
    fits_budget: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True),
        server_default=text("now()"),
        nullable=False,
    )

    __table_args__ = (
        CheckConstraint(
            "request_reason IN ("
            "'episode_open', 'search', 'highlight', 'quote', 'background_warming', 'operator_requeue'"
            ")",
            name="ck_podcast_transcript_request_audits_reason",
        ),
        CheckConstraint(
            "outcome IN ('forecast', 'queued', 'idempotent', 'rejected_quota', 'enqueue_failed')",
            name="ck_podcast_transcript_request_audits_outcome",
        ),
        CheckConstraint(
            "required_minutes IS NULL OR required_minutes >= 0",
            name="ck_podcast_transcript_request_audits_required_non_negative",
        ),
        CheckConstraint(
            "remaining_minutes IS NULL OR remaining_minutes >= 0",
            name="ck_podcast_transcript_request_audits_remaining_non_negative",
        ),
        Index(
            "ix_podcast_transcript_request_audits_media_created",
            "media_id",
            "created_at",
        ),
    )

    media: Mapped["Media"] = relationship("Media", back_populates="transcript_request_audits")


# =============================================================================
# Slice 2: Highlights
# =============================================================================


class Highlight(Base):
    """Highlight model - a user-owned selection anchored to media content.

    Supports typed anchor subtypes:
    - fragment_offsets: half-open [start_offset, end_offset) over canonical_text
    - pdf_page_geometry: page-space geometry (quads/rects) on a PDF page
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

    # Canonical typed-anchor fields used by all runtime highlight reads.
    anchor_kind: Mapped[str | None] = mapped_column(Text, nullable=True)
    anchor_media_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("media.id", ondelete="CASCADE"),
        nullable=True,
    )

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
            "color IN ('yellow','green','blue','pink','purple')",
            name="ck_highlights_color",
        ),
        CheckConstraint(
            "(anchor_kind IS NULL AND anchor_media_id IS NULL) "
            "OR (anchor_kind IS NOT NULL AND anchor_media_id IS NOT NULL)",
            name="ck_highlights_anchor_fields_paired_null",
        ),
        CheckConstraint(
            "anchor_kind IS NULL OR anchor_kind IN ('fragment_offsets', 'pdf_page_geometry')",
            name="ck_highlights_anchor_kind_valid",
        ),
    )

    # Relationships
    fragment_anchor: Mapped["HighlightFragmentAnchor | None"] = relationship(
        "HighlightFragmentAnchor",
        back_populates="highlight",
        uselist=False,
        cascade="all, delete-orphan",
        passive_deletes=True,
    )
    pdf_anchor: Mapped["HighlightPdfAnchor | None"] = relationship(
        "HighlightPdfAnchor",
        back_populates="highlight",
        uselist=False,
        cascade="all, delete-orphan",
        passive_deletes=True,
    )
    pdf_quads: Mapped[list["HighlightPdfQuad"]] = relationship(
        "HighlightPdfQuad",
        back_populates="highlight",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )


# =============================================================================
# Slice 6: Typed Highlight Anchor Subtypes + PDF Text Artifacts
# =============================================================================


class HighlightFragmentAnchor(Base):
    """Fragment-offset anchor subtype (1:1 with highlights).

    Stores the canonical fragment/offset data for html/epub/transcript
    highlights.  Dormant in pr-01; pr-02 adopts typed-write paths.
    """

    __tablename__ = "highlight_fragment_anchors"

    highlight_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("highlights.id", ondelete="CASCADE"),
        primary_key=True,
    )
    fragment_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("fragments.id", ondelete="CASCADE"),
        nullable=False,
    )
    start_offset: Mapped[int] = mapped_column(Integer, nullable=False)
    end_offset: Mapped[int] = mapped_column(Integer, nullable=False)

    __table_args__ = (
        CheckConstraint(
            "start_offset >= 0 AND end_offset > start_offset",
            name="ck_hfa_offsets_valid",
        ),
        Index("ix_hfa_fragment_offsets", "fragment_id", "start_offset", "end_offset"),
    )

    highlight: Mapped["Highlight"] = relationship("Highlight", back_populates="fragment_anchor")
    fragment: Mapped["Fragment"] = relationship("Fragment")


class HighlightPdfAnchor(Base):
    """PDF geometry anchor subtype (1:1 with highlights).

    Stores page-space geometry metadata, duplicate-detection fingerprint,
    and persisted quote-match metadata for PDF highlights.
    """

    __tablename__ = "highlight_pdf_anchors"

    highlight_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("highlights.id", ondelete="CASCADE"),
        primary_key=True,
    )
    media_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("media.id", ondelete="CASCADE"),
        nullable=False,
    )
    page_number: Mapped[int] = mapped_column(Integer, nullable=False)
    geometry_version: Mapped[int] = mapped_column(SmallInteger, nullable=False)
    geometry_fingerprint: Mapped[str] = mapped_column(Text, nullable=False)
    sort_top: Mapped[Decimal] = mapped_column(Numeric, nullable=False)
    sort_left: Mapped[Decimal] = mapped_column(Numeric, nullable=False)
    plain_text_match_version: Mapped[int | None] = mapped_column(SmallInteger, nullable=True)
    plain_text_match_status: Mapped[str] = mapped_column(
        Text, nullable=False, server_default="pending"
    )
    plain_text_start_offset: Mapped[int | None] = mapped_column(Integer, nullable=True)
    plain_text_end_offset: Mapped[int | None] = mapped_column(Integer, nullable=True)
    rect_count: Mapped[int] = mapped_column(Integer, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True),
        server_default=text("now()"),
        nullable=False,
    )

    __table_args__ = (
        CheckConstraint("page_number >= 1", name="ck_hpa_page_number"),
        CheckConstraint("geometry_version >= 1", name="ck_hpa_geometry_version"),
        CheckConstraint("rect_count >= 1", name="ck_hpa_rect_count"),
        CheckConstraint(
            "plain_text_match_status IN "
            "('pending', 'unique', 'ambiguous', 'no_match', 'empty_exact')",
            name="ck_hpa_match_status",
        ),
        CheckConstraint(
            "plain_text_match_version IS NULL OR plain_text_match_version >= 1",
            name="ck_hpa_match_version",
        ),
        CheckConstraint(
            "(plain_text_start_offset IS NULL OR plain_text_start_offset >= 0) "
            "AND (plain_text_end_offset IS NULL OR plain_text_end_offset >= 0)",
            name="ck_hpa_match_offsets_non_negative",
        ),
        CheckConstraint(
            "(plain_text_start_offset IS NULL AND plain_text_end_offset IS NULL) "
            "OR (plain_text_start_offset IS NOT NULL "
            "AND plain_text_end_offset IS NOT NULL)",
            name="ck_hpa_match_offsets_paired_null",
        ),
    )

    highlight: Mapped["Highlight"] = relationship("Highlight", back_populates="pdf_anchor")
    media: Mapped["Media"] = relationship("Media")


class HighlightPdfQuad(Base):
    """PDF geometry segment (quad/rect) for a PDF highlight.

    Composite PK: (highlight_id, quad_idx).
    Coordinates are in canonical page-space points.
    """

    __tablename__ = "highlight_pdf_quads"

    highlight_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("highlights.id", ondelete="CASCADE"),
        primary_key=True,
    )
    quad_idx: Mapped[int] = mapped_column(Integer, primary_key=True)
    x1: Mapped[Decimal] = mapped_column(Numeric, nullable=False)
    y1: Mapped[Decimal] = mapped_column(Numeric, nullable=False)
    x2: Mapped[Decimal] = mapped_column(Numeric, nullable=False)
    y2: Mapped[Decimal] = mapped_column(Numeric, nullable=False)
    x3: Mapped[Decimal] = mapped_column(Numeric, nullable=False)
    y3: Mapped[Decimal] = mapped_column(Numeric, nullable=False)
    x4: Mapped[Decimal] = mapped_column(Numeric, nullable=False)
    y4: Mapped[Decimal] = mapped_column(Numeric, nullable=False)

    __table_args__ = (CheckConstraint("quad_idx >= 0", name="ck_hpq_quad_idx"),)

    highlight: Mapped["Highlight"] = relationship("Highlight", back_populates="pdf_quads")


class PdfPageTextSpan(Base):
    """Page-indexed offsets into media.plain_text for PDF quote matching.

    Composite PK: (media_id, page_number).
    Offsets are Unicode codepoint spans in the post-normalization plain_text.
    """

    __tablename__ = "pdf_page_text_spans"

    media_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("media.id", ondelete="CASCADE"),
        primary_key=True,
    )
    page_number: Mapped[int] = mapped_column(Integer, primary_key=True)
    start_offset: Mapped[int] = mapped_column(Integer, nullable=False)
    end_offset: Mapped[int] = mapped_column(Integer, nullable=False)
    text_extract_version: Mapped[int] = mapped_column(SmallInteger, nullable=False)
    page_label: Mapped[str | None] = mapped_column(Text, nullable=True)
    page_width: Mapped[float | None] = mapped_column(Float, nullable=True)
    page_height: Mapped[float | None] = mapped_column(Float, nullable=True)
    page_rotation_degrees: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True),
        server_default=text("now()"),
        nullable=False,
    )

    __table_args__ = (
        CheckConstraint("page_number >= 1", name="ck_ppts_page_number"),
        CheckConstraint("start_offset >= 0", name="ck_ppts_start_offset"),
        CheckConstraint("end_offset >= start_offset", name="ck_ppts_offsets_valid"),
        CheckConstraint("text_extract_version >= 1", name="ck_ppts_extract_version"),
        CheckConstraint("page_width IS NULL OR page_width > 0", name="ck_ppts_page_width"),
        CheckConstraint("page_height IS NULL OR page_height > 0", name="ck_ppts_page_height"),
        CheckConstraint(
            "page_rotation_degrees IS NULL OR page_rotation_degrees >= 0",
            name="ck_ppts_page_rotation",
        ),
    )

    media: Mapped["Media"] = relationship("Media", back_populates="pdf_page_text_spans")


# =============================================================================
# Slice 3: Chat + Conversations + LLM Infrastructure
# =============================================================================


class SharingMode(str, PyEnum):
    """Sharing modes for social objects."""

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
    deepseek = "deepseek"


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
    """Types of universal message context targets."""

    media = "media"
    highlight = "highlight"
    page = "page"
    note_block = "note_block"
    conversation = "conversation"
    message = "message"
    podcast = "podcast"
    content_chunk = "content_chunk"
    contributor = "contributor"


class MessageToolStatus(str, PyEnum):
    """Lifecycle states for assistant tool-call persistence."""

    pending = "pending"
    complete = "complete"
    error = "error"


class ChatRunStatus(str, PyEnum):
    """Lifecycle states for a durable chat run."""

    queued = "queued"
    running = "running"
    complete = "complete"
    error = "error"
    cancelled = "cancelled"


class ChatRunEventType(str, PyEnum):
    """User-visible event types persisted for chat run replay."""

    meta = "meta"
    tool_call = "tool_call"
    tool_result = "tool_result"
    citation = "citation"
    delta = "delta"
    done = "done"


class AppSearchResultType(str, PyEnum):
    """Typed app-search result classes surfaced to assistant retrieval."""

    page = "page"
    note_block = "note_block"
    media = "media"
    podcast = "podcast"
    content_chunk = "content_chunk"
    message = "message"
    contributor = "contributor"
    web_result = "web_result"


class SourceRefType(str, PyEnum):
    """Resolvable source reference classes for conversation memory."""

    message = "message"
    message_context = "message_context"
    message_retrieval = "message_retrieval"
    app_context_ref = "app_context_ref"
    web_result = "web_result"


class AssistantClaimSupportStatus(str, PyEnum):
    """Final support states for assistant message claims."""

    supported = "supported"
    partially_supported = "partially_supported"
    contradicted = "contradicted"
    not_enough_evidence = "not_enough_evidence"
    out_of_scope = "out_of_scope"
    not_source_grounded = "not_source_grounded"


class AssistantClaimVerifierStatus(str, PyEnum):
    """Verifier lifecycle states for persisted assistant evidence."""

    pending = "pending"
    complete = "complete"
    failed = "failed"


class AssistantEvidenceRole(str, PyEnum):
    """Roles for evidence linked to assistant claims."""

    supports = "supports"
    contradicts = "contradicts"
    context = "context"
    scope_boundary = "scope_boundary"


class RetrievalEvidenceStatus(str, PyEnum):
    """Durable retrieval statuses for candidate evidence rows."""

    attached_context = "attached_context"
    retrieved = "retrieved"
    selected = "selected"
    included_in_prompt = "included_in_prompt"
    excluded_by_budget = "excluded_by_budget"
    excluded_by_scope = "excluded_by_scope"
    web_result = "web_result"


class ConversationMemoryKind(str, PyEnum):
    """Typed conversation memory item classes."""

    goal = "goal"
    constraint = "constraint"
    decision = "decision"
    correction = "correction"
    open_question = "open_question"
    task = "task"
    assistant_commitment = "assistant_commitment"
    user_preference = "user_preference"
    source_claim = "source_claim"


class ConversationMemoryStatus(str, PyEnum):
    """Lifecycle states for memory items and snapshots."""

    active = "active"
    superseded = "superseded"
    invalid = "invalid"


class ConversationMemoryInvalidReason(str, PyEnum):
    """Finite invalidation reasons for memory items and snapshots."""

    prompt_version_changed = "prompt_version_changed"
    source_deleted = "source_deleted"
    source_permission_changed = "source_permission_changed"
    source_stale = "source_stale"
    validation_failed = "validation_failed"


class ConversationMemoryEvidenceRole(str, PyEnum):
    """Evidence role for a memory source reference."""

    supports = "supports"
    contradicts = "contradicts"
    supersedes = "supersedes"
    context = "context"


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
    title: Mapped[str] = mapped_column(Text, nullable=False, server_default="Chat")
    sharing: Mapped[str] = mapped_column(Text, nullable=False, server_default="private")
    scope_type: Mapped[str] = mapped_column(Text, nullable=False, server_default="general")
    scope_media_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("media.id"),
        nullable=True,
    )
    scope_library_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("libraries.id"),
        nullable=True,
    )
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
            "scope_type IN ('general', 'media', 'library')",
            name="ck_conversations_scope_type",
        ),
        CheckConstraint(
            """
            (
                scope_type = 'general'
                AND scope_media_id IS NULL
                AND scope_library_id IS NULL
            )
            OR (
                scope_type = 'media'
                AND scope_media_id IS NOT NULL
                AND scope_library_id IS NULL
            )
            OR (
                scope_type = 'library'
                AND scope_media_id IS NULL
                AND scope_library_id IS NOT NULL
            )
            """,
            name="ck_conversations_scope_targets",
        ),
        CheckConstraint(
            "next_seq >= 1",
            name="ck_conversations_next_seq_positive",
        ),
        CheckConstraint(
            "length(btrim(title)) > 0",
            name="ck_conversations_title_not_blank",
        ),
        CheckConstraint(
            "char_length(title) <= 120",
            name="ck_conversations_title_max_length",
        ),
        Index(
            "uix_conversations_owner_scope_media",
            "owner_user_id",
            "scope_media_id",
            unique=True,
            postgresql_where=text("scope_type = 'media'"),
        ),
        Index(
            "uix_conversations_owner_scope_library",
            "owner_user_id",
            "scope_library_id",
            unique=True,
            postgresql_where=text("scope_type = 'library'"),
        ),
    )

    # Relationships
    owner: Mapped["User"] = relationship("User")
    scope_media: Mapped["Media | None"] = relationship("Media", foreign_keys=[scope_media_id])
    scope_library: Mapped["Library | None"] = relationship(
        "Library", foreign_keys=[scope_library_id]
    )
    messages: Mapped[list["Message"]] = relationship(
        "Message", back_populates="conversation", cascade="all, delete-orphan"
    )
    shares: Mapped[list["ConversationShare"]] = relationship(
        "ConversationShare", back_populates="conversation", cascade="all, delete-orphan"
    )
    conversation_media: Mapped[list["ConversationMedia"]] = relationship(
        "ConversationMedia", back_populates="conversation", cascade="all, delete-orphan"
    )
    memory_items: Mapped[list["ConversationMemoryItem"]] = relationship(
        "ConversationMemoryItem",
        back_populates="conversation",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )
    state_snapshots: Mapped[list["ConversationStateSnapshot"]] = relationship(
        "ConversationStateSnapshot",
        back_populates="conversation",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )
    prompt_assemblies: Mapped[list["ChatPromptAssembly"]] = relationship(
        "ChatPromptAssembly",
        back_populates="conversation",
        cascade="all, delete-orphan",
        passive_deletes=True,
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
            "provider IN ('openai', 'anthropic', 'gemini', 'deepseek')",
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
    contexts: Mapped[list["MessageContextItem"]] = relationship(
        "MessageContextItem",
        back_populates="message",
        cascade="all, delete-orphan",
        order_by="MessageContextItem.ordinal",
    )
    evidence_summary: Mapped["AssistantMessageEvidenceSummary | None"] = relationship(
        "AssistantMessageEvidenceSummary",
        back_populates="message",
        uselist=False,
        cascade="all, delete-orphan",
    )
    claims: Mapped[list["AssistantMessageClaim"]] = relationship(
        "AssistantMessageClaim",
        back_populates="message",
        cascade="all, delete-orphan",
        order_by="AssistantMessageClaim.ordinal",
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
    input_tokens: Mapped[int | None] = mapped_column(Integer, nullable=True)
    output_tokens: Mapped[int | None] = mapped_column(Integer, nullable=True)
    total_tokens: Mapped[int | None] = mapped_column(Integer, nullable=True)
    reasoning_tokens: Mapped[int | None] = mapped_column(Integer, nullable=True)
    cache_write_input_tokens: Mapped[int | None] = mapped_column(Integer, nullable=True)
    cache_read_input_tokens: Mapped[int | None] = mapped_column(Integer, nullable=True)
    cached_input_tokens: Mapped[int | None] = mapped_column(Integer, nullable=True)
    key_mode_requested: Mapped[str] = mapped_column(Text, nullable=False)
    key_mode_used: Mapped[str] = mapped_column(Text, nullable=False)
    cost_usd_micros: Mapped[int | None] = mapped_column(Integer, nullable=True)
    latency_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    error_class: Mapped[str | None] = mapped_column(Text, nullable=True)
    provider_request_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    prompt_version: Mapped[str] = mapped_column(Text, nullable=False)
    prompt_plan_version: Mapped[str | None] = mapped_column(Text, nullable=True)
    stable_prefix_hash: Mapped[str | None] = mapped_column(Text, nullable=True)
    provider_usage: Mapped[dict[str, object] | None] = mapped_column(JSONB, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True),
        server_default=text("now()"),
        nullable=False,
    )

    __table_args__ = (
        CheckConstraint(
            "provider IN ('openai', 'anthropic', 'gemini', 'deepseek')",
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
            "total_tokens IS NULL OR total_tokens >= 0",
            name="ck_message_llm_total_tokens",
        ),
        CheckConstraint(
            "input_tokens IS NULL OR input_tokens >= 0",
            name="ck_message_llm_input_tokens",
        ),
        CheckConstraint(
            "output_tokens IS NULL OR output_tokens >= 0",
            name="ck_message_llm_output_tokens",
        ),
        CheckConstraint(
            "reasoning_tokens IS NULL OR reasoning_tokens >= 0",
            name="ck_message_llm_reasoning_tokens",
        ),
        CheckConstraint(
            "cache_write_input_tokens IS NULL OR cache_write_input_tokens >= 0",
            name="ck_message_llm_cache_write_tokens",
        ),
        CheckConstraint(
            "cache_read_input_tokens IS NULL OR cache_read_input_tokens >= 0",
            name="ck_message_llm_cache_read_tokens",
        ),
        CheckConstraint(
            "cached_input_tokens IS NULL OR cached_input_tokens >= 0",
            name="ck_message_llm_cached_input_tokens",
        ),
        CheckConstraint(
            "provider_usage IS NULL OR jsonb_typeof(provider_usage) = 'object'",
            name="ck_message_llm_provider_usage_object",
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


class MessageToolCall(Base):
    """Durable assistant tool-call metadata for a message pair."""

    __tablename__ = "message_tool_calls"

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
    tool_name: Mapped[str] = mapped_column(Text, nullable=False)
    tool_call_index: Mapped[int] = mapped_column(Integer, nullable=False)
    query_hash: Mapped[str | None] = mapped_column(Text, nullable=True)
    scope: Mapped[str] = mapped_column(Text, nullable=False, server_default="all")
    requested_types: Mapped[list[str]] = mapped_column(
        JSONB,
        nullable=False,
        server_default=text("'[]'::jsonb"),
    )
    semantic: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default="false")
    result_refs: Mapped[list[dict[str, object]]] = mapped_column(
        JSONB,
        nullable=False,
        server_default=text("'[]'::jsonb"),
    )
    selected_context_refs: Mapped[list[dict[str, object]]] = mapped_column(
        JSONB,
        nullable=False,
        server_default=text("'[]'::jsonb"),
    )
    provider_request_ids: Mapped[list[str]] = mapped_column(
        JSONB,
        nullable=False,
        server_default=text("'[]'::jsonb"),
    )
    latency_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default="pending")
    error_code: Mapped[str | None] = mapped_column(Text, nullable=True)
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
            "char_length(tool_name) BETWEEN 1 AND 128",
            name="ck_message_tool_calls_tool_name_length",
        ),
        CheckConstraint(
            "tool_call_index >= 0",
            name="ck_message_tool_calls_index_non_negative",
        ),
        CheckConstraint(
            "query_hash IS NULL OR char_length(query_hash) BETWEEN 1 AND 128",
            name="ck_message_tool_calls_query_hash_length",
        ),
        CheckConstraint(
            "char_length(scope) BETWEEN 1 AND 256",
            name="ck_message_tool_calls_scope_length",
        ),
        CheckConstraint(
            "jsonb_typeof(requested_types) = 'array'",
            name="ck_message_tool_calls_requested_types_array",
        ),
        CheckConstraint(
            "jsonb_typeof(result_refs) = 'array'",
            name="ck_message_tool_calls_result_refs_array",
        ),
        CheckConstraint(
            "jsonb_typeof(selected_context_refs) = 'array'",
            name="ck_message_tool_calls_selected_context_refs_array",
        ),
        CheckConstraint(
            "jsonb_typeof(provider_request_ids) = 'array'",
            name="ck_message_tool_calls_provider_request_ids_array",
        ),
        CheckConstraint(
            "latency_ms IS NULL OR latency_ms >= 0",
            name="ck_message_tool_calls_latency_non_negative",
        ),
        CheckConstraint(
            "status IN ('pending', 'complete', 'error')",
            name="ck_message_tool_calls_status",
        ),
        UniqueConstraint(
            "assistant_message_id",
            "tool_call_index",
            name="uix_message_tool_calls_assistant_index",
        ),
        Index(
            "idx_message_tool_calls_conversation_created",
            "conversation_id",
            "created_at",
        ),
        Index(
            "idx_message_tool_calls_user_message",
            "user_message_id",
            "tool_call_index",
        ),
        Index(
            "idx_message_tool_calls_assistant_message",
            "assistant_message_id",
            "tool_call_index",
        ),
        Index(
            "idx_message_tool_calls_tool_status",
            "tool_name",
            "status",
        ),
    )

    conversation: Mapped["Conversation"] = relationship("Conversation")
    user_message: Mapped["Message"] = relationship("Message", foreign_keys=[user_message_id])
    assistant_message: Mapped["Message"] = relationship(
        "Message",
        foreign_keys=[assistant_message_id],
    )
    retrievals: Mapped[list["MessageRetrieval"]] = relationship(
        "MessageRetrieval",
        back_populates="tool_call",
        cascade="all, delete-orphan",
        order_by="MessageRetrieval.ordinal",
    )


class MessageRetrieval(Base):
    """One app-search result retrieved for an assistant tool call."""

    __tablename__ = "message_retrievals"

    id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        primary_key=True,
        server_default=text("gen_random_uuid()"),
    )
    tool_call_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("message_tool_calls.id", ondelete="CASCADE"),
        nullable=False,
    )
    ordinal: Mapped[int] = mapped_column(Integer, nullable=False)
    result_type: Mapped[str] = mapped_column(Text, nullable=False)
    source_id: Mapped[str] = mapped_column(Text, nullable=False)
    media_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("media.id", ondelete="SET NULL"),
        nullable=True,
    )
    evidence_span_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("evidence_spans.id"),
        nullable=True,
    )
    scope: Mapped[str] = mapped_column(Text, nullable=False, server_default="all")
    context_ref: Mapped[dict[str, object]] = mapped_column(JSONB, nullable=False)
    result_ref: Mapped[dict[str, object]] = mapped_column(JSONB, nullable=False)
    deep_link: Mapped[str | None] = mapped_column(Text, nullable=True)
    score: Mapped[float | None] = mapped_column(Float, nullable=True)
    selected: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default="false")
    source_title: Mapped[str | None] = mapped_column(Text, nullable=True)
    section_label: Mapped[str | None] = mapped_column(Text, nullable=True)
    exact_snippet: Mapped[str | None] = mapped_column(Text, nullable=True)
    snippet_prefix: Mapped[str | None] = mapped_column(Text, nullable=True)
    snippet_suffix: Mapped[str | None] = mapped_column(Text, nullable=True)
    locator: Mapped[dict[str, object] | None] = mapped_column(JSONB, nullable=True)
    retrieval_status: Mapped[str] = mapped_column(
        Text,
        nullable=False,
        server_default="retrieved",
    )
    included_in_prompt: Mapped[bool] = mapped_column(
        Boolean,
        nullable=False,
        server_default="false",
    )
    source_version: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True),
        server_default=text("now()"),
        nullable=False,
    )

    __table_args__ = (
        CheckConstraint(
            "ordinal >= 0",
            name="ck_message_retrievals_ordinal_non_negative",
        ),
        CheckConstraint(
            """
            result_type IN (
                'page',
                'note_block',
                'media',
                'podcast',
                'content_chunk',
                'message',
                'contributor',
                'web_result'
            )
            """,
            name="ck_message_retrievals_result_type",
        ),
        CheckConstraint(
            "char_length(source_id) BETWEEN 1 AND 128",
            name="ck_message_retrievals_source_id_length",
        ),
        CheckConstraint(
            "char_length(scope) BETWEEN 1 AND 256",
            name="ck_message_retrievals_scope_length",
        ),
        CheckConstraint(
            "jsonb_typeof(context_ref) = 'object'",
            name="ck_message_retrievals_context_ref_object",
        ),
        CheckConstraint(
            "jsonb_typeof(result_ref) = 'object'",
            name="ck_message_retrievals_result_ref_object",
        ),
        CheckConstraint(
            "score IS NULL OR score >= 0",
            name="ck_message_retrievals_score_non_negative",
        ),
        CheckConstraint(
            "locator IS NULL OR locator = 'null'::jsonb OR jsonb_typeof(locator) = 'object'",
            name="ck_message_retrievals_locator_object",
        ),
        CheckConstraint(
            """
            retrieval_status IN (
                'attached_context',
                'retrieved',
                'selected',
                'included_in_prompt',
                'excluded_by_budget',
                'excluded_by_scope',
                'web_result'
            )
            """,
            name="ck_message_retrievals_status",
        ),
        UniqueConstraint(
            "tool_call_id",
            "ordinal",
            name="uix_message_retrievals_tool_call_ordinal",
        ),
        Index(
            "idx_message_retrievals_tool_call_selected",
            "tool_call_id",
            "selected",
            "ordinal",
        ),
        Index("idx_message_retrievals_media", "media_id"),
        Index("idx_message_retrievals_result_type", "result_type"),
        Index("idx_message_retrievals_evidence_span", "evidence_span_id"),
    )

    tool_call: Mapped["MessageToolCall"] = relationship(
        "MessageToolCall",
        back_populates="retrievals",
    )
    media: Mapped["Media | None"] = relationship("Media")


class AssistantMessageEvidenceSummary(Base):
    """Final evidence status for one assistant message."""

    __tablename__ = "assistant_message_evidence_summaries"

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
    scope_type: Mapped[str] = mapped_column(Text, nullable=False)
    scope_ref: Mapped[dict[str, object] | None] = mapped_column(JSONB, nullable=True)
    retrieval_status: Mapped[str] = mapped_column(Text, nullable=False)
    support_status: Mapped[str] = mapped_column(Text, nullable=False)
    verifier_status: Mapped[str] = mapped_column(Text, nullable=False)
    claim_count: Mapped[int] = mapped_column(Integer, nullable=False)
    supported_claim_count: Mapped[int] = mapped_column(Integer, nullable=False)
    unsupported_claim_count: Mapped[int] = mapped_column(Integer, nullable=False)
    not_enough_evidence_count: Mapped[int] = mapped_column(Integer, nullable=False)
    prompt_assembly_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("chat_prompt_assemblies.id", ondelete="SET NULL"),
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
        CheckConstraint(
            "scope_type IN ('general', 'media', 'library')",
            name="ck_assistant_evidence_summaries_scope_type",
        ),
        CheckConstraint(
            "scope_ref IS NULL OR scope_ref = 'null'::jsonb OR jsonb_typeof(scope_ref) = 'object'",
            name="ck_assistant_evidence_summaries_scope_ref_object",
        ),
        CheckConstraint(
            """
            retrieval_status IN (
                'attached_context',
                'retrieved',
                'selected',
                'included_in_prompt',
                'excluded_by_budget',
                'excluded_by_scope',
                'web_result'
            )
            """,
            name="ck_assistant_evidence_summaries_retrieval_status",
        ),
        CheckConstraint(
            """
            support_status IN (
                'supported',
                'partially_supported',
                'contradicted',
                'not_enough_evidence',
                'out_of_scope',
                'not_source_grounded'
            )
            """,
            name="ck_assistant_evidence_summaries_support_status",
        ),
        CheckConstraint(
            "verifier_status IN ('verified', 'failed')",
            name="ck_assistant_evidence_summaries_verifier_status",
        ),
        CheckConstraint(
            """
            claim_count >= 0
            AND supported_claim_count >= 0
            AND unsupported_claim_count >= 0
            AND not_enough_evidence_count >= 0
            """,
            name="ck_assistant_evidence_summaries_counts",
        ),
        UniqueConstraint("message_id", name="uix_assistant_evidence_summaries_message"),
    )

    message: Mapped["Message"] = relationship("Message", back_populates="evidence_summary")


class AssistantMessageClaim(Base):
    """One persisted claim from a completed assistant message."""

    __tablename__ = "assistant_message_claims"

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
    ordinal: Mapped[int] = mapped_column(Integer, nullable=False)
    claim_text: Mapped[str] = mapped_column(Text, nullable=False)
    answer_start_offset: Mapped[int | None] = mapped_column(Integer, nullable=True)
    answer_end_offset: Mapped[int | None] = mapped_column(Integer, nullable=True)
    claim_kind: Mapped[str] = mapped_column(Text, nullable=False)
    support_status: Mapped[str] = mapped_column(Text, nullable=False)
    verifier_status: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True),
        server_default=text("now()"),
        nullable=False,
    )

    __table_args__ = (
        CheckConstraint("ordinal >= 0", name="ck_assistant_claims_ordinal"),
        CheckConstraint(
            "char_length(btrim(claim_text)) BETWEEN 1 AND 50000",
            name="ck_assistant_claims_text_length",
        ),
        CheckConstraint(
            """
            (
                answer_start_offset IS NULL
                AND answer_end_offset IS NULL
            )
            OR (
                answer_start_offset >= 0
                AND answer_end_offset > answer_start_offset
            )
            """,
            name="ck_assistant_claims_offsets",
        ),
        CheckConstraint(
            "claim_kind IN ('answer', 'insufficient_evidence')",
            name="ck_assistant_claims_kind",
        ),
        CheckConstraint(
            """
            support_status IN (
                'supported',
                'partially_supported',
                'contradicted',
                'not_enough_evidence',
                'out_of_scope',
                'not_source_grounded'
            )
            """,
            name="ck_assistant_claims_support_status",
        ),
        CheckConstraint(
            "verifier_status IN ('verified', 'failed')",
            name="ck_assistant_claims_verifier_status",
        ),
        UniqueConstraint("message_id", "ordinal", name="uix_assistant_claims_message_ordinal"),
        Index("idx_assistant_claims_message", "message_id", "ordinal"),
    )

    message: Mapped["Message"] = relationship("Message", back_populates="claims")
    evidence: Mapped[list["AssistantMessageClaimEvidence"]] = relationship(
        "AssistantMessageClaimEvidence",
        back_populates="claim",
        cascade="all, delete-orphan",
        order_by="AssistantMessageClaimEvidence.ordinal",
    )


class AssistantMessageClaimEvidence(Base):
    """One source snapshot linked to an assistant claim."""

    __tablename__ = "assistant_message_claim_evidence"

    id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        primary_key=True,
        server_default=text("gen_random_uuid()"),
    )
    claim_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("assistant_message_claims.id", ondelete="CASCADE"),
        nullable=False,
    )
    ordinal: Mapped[int] = mapped_column(Integer, nullable=False)
    evidence_role: Mapped[str] = mapped_column(Text, nullable=False)
    source_ref: Mapped[dict[str, object]] = mapped_column(JSONB, nullable=False)
    retrieval_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("message_retrievals.id", ondelete="SET NULL"),
        nullable=True,
    )
    evidence_span_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("evidence_spans.id"),
        nullable=True,
    )
    context_ref: Mapped[dict[str, object] | None] = mapped_column(JSONB, nullable=True)
    result_ref: Mapped[dict[str, object] | None] = mapped_column(JSONB, nullable=True)
    exact_snippet: Mapped[str | None] = mapped_column(Text, nullable=True)
    snippet_prefix: Mapped[str | None] = mapped_column(Text, nullable=True)
    snippet_suffix: Mapped[str | None] = mapped_column(Text, nullable=True)
    locator: Mapped[dict[str, object] | None] = mapped_column(JSONB, nullable=True)
    deep_link: Mapped[str | None] = mapped_column(Text, nullable=True)
    score: Mapped[float | None] = mapped_column(Float, nullable=True)
    retrieval_status: Mapped[str] = mapped_column(Text, nullable=False)
    selected: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default="false")
    included_in_prompt: Mapped[bool] = mapped_column(
        Boolean,
        nullable=False,
        server_default="false",
    )
    source_version: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True),
        server_default=text("now()"),
        nullable=False,
    )

    __table_args__ = (
        CheckConstraint("ordinal >= 0", name="ck_assistant_claim_evidence_ordinal"),
        CheckConstraint(
            "evidence_role IN ('supports', 'contradicts', 'context', 'scope_boundary')",
            name="ck_assistant_claim_evidence_role",
        ),
        CheckConstraint(
            "jsonb_typeof(source_ref) = 'object'",
            name="ck_assistant_claim_evidence_source_ref_object",
        ),
        CheckConstraint(
            "context_ref IS NULL OR context_ref = 'null'::jsonb OR jsonb_typeof(context_ref) = 'object'",
            name="ck_assistant_claim_evidence_context_ref_object",
        ),
        CheckConstraint(
            "result_ref IS NULL OR result_ref = 'null'::jsonb OR jsonb_typeof(result_ref) = 'object'",
            name="ck_assistant_claim_evidence_result_ref_object",
        ),
        CheckConstraint(
            "locator IS NULL OR locator = 'null'::jsonb OR jsonb_typeof(locator) = 'object'",
            name="ck_assistant_claim_evidence_locator_object",
        ),
        CheckConstraint(
            "score IS NULL OR score >= 0",
            name="ck_assistant_claim_evidence_score",
        ),
        CheckConstraint(
            """
            retrieval_status IN (
                'attached_context',
                'retrieved',
                'selected',
                'included_in_prompt',
                'excluded_by_budget',
                'excluded_by_scope',
                'web_result'
            )
            """,
            name="ck_assistant_claim_evidence_retrieval_status",
        ),
        CheckConstraint(
            """
            evidence_role NOT IN ('supports', 'contradicts')
            OR exact_snippet IS NOT NULL
            """,
            name="ck_assistant_claim_evidence_snippet_required",
        ),
        UniqueConstraint("claim_id", "ordinal", name="uix_assistant_claim_evidence_ordinal"),
        Index("idx_assistant_claim_evidence_claim", "claim_id", "ordinal"),
        Index("idx_assistant_claim_evidence_retrieval", "retrieval_id"),
        Index("idx_assistant_claim_evidence_evidence_span", "evidence_span_id"),
    )

    claim: Mapped["AssistantMessageClaim"] = relationship(
        "AssistantMessageClaim",
        back_populates="evidence",
    )


class ConversationMemoryItem(Base):
    """Durable typed conversation memory item."""

    __tablename__ = "conversation_memory_items"

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
    kind: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default="active")
    body: Mapped[str] = mapped_column(Text, nullable=False)
    source_required: Mapped[bool] = mapped_column(
        Boolean,
        nullable=False,
        server_default="false",
    )
    confidence: Mapped[float] = mapped_column(Float, nullable=False)
    valid_from_seq: Mapped[int | None] = mapped_column(Integer, nullable=True)
    valid_through_seq: Mapped[int | None] = mapped_column(Integer, nullable=True)
    supersedes_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("conversation_memory_items.id", ondelete="SET NULL"),
        nullable=True,
    )
    created_by_message_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("messages.id", ondelete="SET NULL"),
        nullable=True,
    )
    prompt_version: Mapped[str] = mapped_column(Text, nullable=False)
    memory_version: Mapped[int] = mapped_column(Integer, nullable=False, server_default="1")
    invalid_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
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
            """
            kind IN (
                'goal',
                'constraint',
                'decision',
                'correction',
                'open_question',
                'task',
                'assistant_commitment',
                'user_preference',
                'source_claim'
            )
            """,
            name="ck_conversation_memory_items_kind",
        ),
        CheckConstraint(
            "status IN ('active', 'superseded', 'invalid')",
            name="ck_conversation_memory_items_status",
        ),
        CheckConstraint(
            "char_length(btrim(body)) BETWEEN 1 AND 4000",
            name="ck_conversation_memory_items_body_length",
        ),
        CheckConstraint(
            "confidence >= 0 AND confidence <= 1",
            name="ck_conversation_memory_items_confidence",
        ),
        CheckConstraint(
            """
            (valid_from_seq IS NULL OR valid_from_seq >= 1)
            AND (valid_through_seq IS NULL OR valid_through_seq >= 1)
            AND (
                valid_from_seq IS NULL
                OR valid_through_seq IS NULL
                OR valid_from_seq <= valid_through_seq
            )
            """,
            name="ck_conversation_memory_items_valid_seq",
        ),
        CheckConstraint(
            "supersedes_id IS NULL OR supersedes_id != id",
            name="ck_conversation_memory_items_not_self_supersedes",
        ),
        CheckConstraint(
            "kind != 'source_claim' OR source_required",
            name="ck_conversation_memory_items_source_claim_requires_source",
        ),
        CheckConstraint(
            "char_length(prompt_version) BETWEEN 1 AND 128",
            name="ck_conversation_memory_items_prompt_version_length",
        ),
        CheckConstraint(
            "memory_version >= 1",
            name="ck_conversation_memory_items_memory_version",
        ),
        CheckConstraint(
            """
            (
                status = 'invalid'
                AND invalid_reason IN (
                    'prompt_version_changed',
                    'source_deleted',
                    'source_permission_changed',
                    'source_stale',
                    'validation_failed'
                )
            )
            OR (
                status != 'invalid'
                AND invalid_reason IS NULL
            )
            """,
            name="ck_conversation_memory_items_invalid_reason",
        ),
        Index(
            "idx_conversation_memory_items_active",
            "conversation_id",
            "status",
            "prompt_version",
            "valid_from_seq",
        ),
    )

    conversation: Mapped["Conversation"] = relationship(
        "Conversation",
        back_populates="memory_items",
    )
    supersedes: Mapped["ConversationMemoryItem | None"] = relationship(
        "ConversationMemoryItem",
        remote_side=[id],
    )
    created_by_message: Mapped["Message | None"] = relationship("Message")
    sources: Mapped[list["ConversationMemoryItemSource"]] = relationship(
        "ConversationMemoryItemSource",
        back_populates="memory_item",
        order_by="ConversationMemoryItemSource.ordinal",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )


class ConversationMemoryItemSource(Base):
    """Normalized source reference supporting a conversation memory item."""

    __tablename__ = "conversation_memory_item_sources"

    id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        primary_key=True,
        server_default=text("gen_random_uuid()"),
    )
    memory_item_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("conversation_memory_items.id", ondelete="CASCADE"),
        nullable=False,
    )
    ordinal: Mapped[int] = mapped_column(Integer, nullable=False)
    source_ref: Mapped[dict[str, object]] = mapped_column(JSONB, nullable=False)
    evidence_role: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True),
        server_default=text("now()"),
        nullable=False,
    )

    __table_args__ = (
        CheckConstraint(
            "ordinal >= 0",
            name="ck_conversation_memory_item_sources_ordinal",
        ),
        CheckConstraint(
            "jsonb_typeof(source_ref) = 'object'",
            name="ck_conversation_memory_item_sources_source_ref_object",
        ),
        CheckConstraint(
            """
            source_ref ? 'type'
            AND source_ref ->> 'type' IN (
                'message',
                'message_context',
                'message_retrieval',
                'app_context_ref',
                'web_result'
            )
            """,
            name="ck_conversation_memory_item_sources_source_ref_type",
        ),
        CheckConstraint(
            """
            source_ref ? 'id'
            AND jsonb_typeof(source_ref -> 'id') = 'string'
            AND char_length(source_ref ->> 'id') BETWEEN 1 AND 256
            """,
            name="ck_conversation_memory_item_sources_source_ref_id",
        ),
        CheckConstraint(
            "evidence_role IN ('supports', 'contradicts', 'supersedes', 'context')",
            name="ck_conversation_memory_item_sources_evidence_role",
        ),
        UniqueConstraint(
            "memory_item_id",
            "ordinal",
            name="uix_conversation_memory_item_sources_item_ordinal",
        ),
    )

    memory_item: Mapped["ConversationMemoryItem"] = relationship(
        "ConversationMemoryItem",
        back_populates="sources",
    )


class ConversationStateSnapshot(Base):
    """Compact auditable state snapshot for older conversation turns."""

    __tablename__ = "conversation_state_snapshots"

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
    covered_through_seq: Mapped[int] = mapped_column(Integer, nullable=False)
    state_text: Mapped[str] = mapped_column(Text, nullable=False)
    state_json: Mapped[dict[str, object]] = mapped_column(
        JSONB,
        nullable=False,
        server_default=text("'{}'::jsonb"),
    )
    source_refs: Mapped[list[dict[str, object]]] = mapped_column(
        JSONB,
        nullable=False,
        server_default=text("'[]'::jsonb"),
    )
    memory_item_ids: Mapped[list[str]] = mapped_column(
        JSONB,
        nullable=False,
        server_default=text("'[]'::jsonb"),
    )
    prompt_version: Mapped[str] = mapped_column(Text, nullable=False)
    snapshot_version: Mapped[int] = mapped_column(Integer, nullable=False, server_default="1")
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default="active")
    invalid_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
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
            "covered_through_seq >= 1",
            name="ck_conversation_state_snapshots_covered_seq",
        ),
        CheckConstraint(
            "char_length(btrim(state_text)) BETWEEN 1 AND 20000",
            name="ck_conversation_state_snapshots_state_text_length",
        ),
        CheckConstraint(
            "jsonb_typeof(state_json) = 'object'",
            name="ck_conversation_state_snapshots_state_json_object",
        ),
        CheckConstraint(
            "jsonb_typeof(source_refs) = 'array'",
            name="ck_conversation_state_snapshots_source_refs_array",
        ),
        CheckConstraint(
            "jsonb_typeof(memory_item_ids) = 'array'",
            name="ck_conversation_state_snapshots_memory_item_ids_array",
        ),
        CheckConstraint(
            "char_length(prompt_version) BETWEEN 1 AND 128",
            name="ck_conversation_state_snapshots_prompt_version_length",
        ),
        CheckConstraint(
            "snapshot_version >= 1",
            name="ck_conversation_state_snapshots_snapshot_version",
        ),
        CheckConstraint(
            "status IN ('active', 'superseded', 'invalid')",
            name="ck_conversation_state_snapshots_status",
        ),
        CheckConstraint(
            """
            (
                status = 'invalid'
                AND invalid_reason IN (
                    'prompt_version_changed',
                    'source_deleted',
                    'source_permission_changed',
                    'source_stale',
                    'validation_failed'
                )
            )
            OR (
                status != 'invalid'
                AND invalid_reason IS NULL
            )
            """,
            name="ck_conversation_state_snapshots_invalid_reason",
        ),
        Index(
            "uix_conversation_state_snapshots_active",
            "conversation_id",
            unique=True,
            postgresql_where=text("status = 'active'"),
        ),
    )

    conversation: Mapped["Conversation"] = relationship(
        "Conversation",
        back_populates="state_snapshots",
    )


class ChatRun(Base):
    """Durable lifecycle row for one user chat send."""

    __tablename__ = "chat_runs"

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
    conversation_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("conversations.id", ondelete="CASCADE"),
        nullable=False,
    )
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
    idempotency_key: Mapped[str] = mapped_column(Text, nullable=False)
    payload_hash: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default="queued")
    model_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("models.id"),
        nullable=False,
    )
    reasoning: Mapped[str] = mapped_column(Text, nullable=False)
    key_mode: Mapped[str] = mapped_column(Text, nullable=False)
    web_search: Mapped[dict[str, object]] = mapped_column(JSONB, nullable=False)
    next_event_seq: Mapped[int] = mapped_column(Integer, nullable=False, server_default="1")
    cancel_requested_at: Mapped[datetime | None] = mapped_column(
        TIMESTAMP(timezone=True),
        nullable=True,
    )
    started_at: Mapped[datetime | None] = mapped_column(TIMESTAMP(timezone=True), nullable=True)
    completed_at: Mapped[datetime | None] = mapped_column(TIMESTAMP(timezone=True), nullable=True)
    error_code: Mapped[str | None] = mapped_column(Text, nullable=True)
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
            "status IN ('queued', 'running', 'complete', 'error', 'cancelled')",
            name="ck_chat_runs_status",
        ),
        CheckConstraint(
            "length(idempotency_key) >= 1 AND length(idempotency_key) <= 128",
            name="ck_chat_runs_idempotency_key_length",
        ),
        CheckConstraint("next_event_seq >= 1", name="ck_chat_runs_next_event_seq_positive"),
        UniqueConstraint(
            "owner_user_id",
            "idempotency_key",
            name="uix_chat_runs_owner_idempotency_key",
        ),
        Index("idx_chat_runs_owner_created", "owner_user_id", "created_at", "id"),
    )

    owner: Mapped["User"] = relationship("User")
    conversation: Mapped["Conversation"] = relationship("Conversation")
    user_message: Mapped["Message"] = relationship("Message", foreign_keys=[user_message_id])
    assistant_message: Mapped["Message"] = relationship(
        "Message",
        foreign_keys=[assistant_message_id],
    )
    model: Mapped["Model"] = relationship("Model")
    events: Mapped[list["ChatRunEvent"]] = relationship(
        "ChatRunEvent",
        back_populates="run",
        order_by="ChatRunEvent.seq",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )
    prompt_assembly: Mapped["ChatPromptAssembly | None"] = relationship(
        "ChatPromptAssembly",
        back_populates="chat_run",
        uselist=False,
        cascade="all, delete-orphan",
        passive_deletes=True,
    )


class ChatPromptAssembly(Base):
    """Prompt assembly ledger persisted before provider execution."""

    __tablename__ = "chat_prompt_assemblies"

    id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        primary_key=True,
        server_default=text("gen_random_uuid()"),
    )
    chat_run_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("chat_runs.id", ondelete="CASCADE"),
        nullable=False,
    )
    conversation_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("conversations.id", ondelete="CASCADE"),
        nullable=False,
    )
    assistant_message_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("messages.id", ondelete="CASCADE"),
        nullable=False,
    )
    model_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("models.id"),
        nullable=False,
    )
    prompt_version: Mapped[str] = mapped_column(Text, nullable=False)
    prompt_plan_version: Mapped[str] = mapped_column(Text, nullable=False)
    assembler_version: Mapped[str] = mapped_column(Text, nullable=False)
    stable_prefix_hash: Mapped[str] = mapped_column(Text, nullable=False)
    cacheable_input_tokens_estimate: Mapped[int] = mapped_column(Integer, nullable=False)
    prompt_block_manifest: Mapped[dict[str, object]] = mapped_column(
        JSONB,
        nullable=False,
        server_default=text("'{}'::jsonb"),
    )
    provider_request_hash: Mapped[str] = mapped_column(Text, nullable=False)
    snapshot_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("conversation_state_snapshots.id", ondelete="SET NULL"),
        nullable=True,
    )
    max_context_tokens: Mapped[int] = mapped_column(Integer, nullable=False)
    reserved_output_tokens: Mapped[int] = mapped_column(Integer, nullable=False)
    reserved_reasoning_tokens: Mapped[int] = mapped_column(Integer, nullable=False)
    input_budget_tokens: Mapped[int] = mapped_column(Integer, nullable=False)
    estimated_input_tokens: Mapped[int] = mapped_column(Integer, nullable=False)
    included_message_ids: Mapped[list[str]] = mapped_column(
        JSONB,
        nullable=False,
        server_default=text("'[]'::jsonb"),
    )
    included_memory_item_ids: Mapped[list[str]] = mapped_column(
        JSONB,
        nullable=False,
        server_default=text("'[]'::jsonb"),
    )
    included_retrieval_ids: Mapped[list[str]] = mapped_column(
        JSONB,
        nullable=False,
        server_default=text("'[]'::jsonb"),
    )
    included_context_refs: Mapped[list[dict[str, object]]] = mapped_column(
        JSONB,
        nullable=False,
        server_default=text("'[]'::jsonb"),
    )
    dropped_items: Mapped[list[dict[str, object]]] = mapped_column(
        JSONB,
        nullable=False,
        server_default=text("'[]'::jsonb"),
    )
    budget_breakdown: Mapped[dict[str, object]] = mapped_column(
        JSONB,
        nullable=False,
        server_default=text("'{}'::jsonb"),
    )
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True),
        server_default=text("now()"),
        nullable=False,
    )

    __table_args__ = (
        CheckConstraint(
            "char_length(prompt_version) BETWEEN 1 AND 128",
            name="ck_chat_prompt_assemblies_prompt_version_length",
        ),
        CheckConstraint(
            "char_length(prompt_plan_version) BETWEEN 1 AND 128",
            name="ck_chat_prompt_assemblies_prompt_plan_version_length",
        ),
        CheckConstraint(
            "char_length(assembler_version) BETWEEN 1 AND 128",
            name="ck_chat_prompt_assemblies_assembler_version_length",
        ),
        CheckConstraint(
            "char_length(stable_prefix_hash) BETWEEN 1 AND 128",
            name="ck_chat_prompt_assemblies_stable_prefix_hash_length",
        ),
        CheckConstraint(
            "char_length(provider_request_hash) BETWEEN 1 AND 128",
            name="ck_chat_prompt_assemblies_provider_request_hash_length",
        ),
        CheckConstraint(
            """
            max_context_tokens > 0
            AND reserved_output_tokens >= 0
            AND reserved_reasoning_tokens >= 0
            AND input_budget_tokens >= 0
            AND estimated_input_tokens >= 0
            AND input_budget_tokens + reserved_output_tokens + reserved_reasoning_tokens
                <= max_context_tokens
            AND estimated_input_tokens <= input_budget_tokens
            """,
            name="ck_chat_prompt_assemblies_token_budget",
        ),
        CheckConstraint(
            "cacheable_input_tokens_estimate >= 0",
            name="ck_chat_prompt_assemblies_cacheable_tokens",
        ),
        CheckConstraint(
            "jsonb_typeof(included_message_ids) = 'array'",
            name="ck_chat_prompt_assemblies_message_ids_array",
        ),
        CheckConstraint(
            "jsonb_typeof(included_memory_item_ids) = 'array'",
            name="ck_chat_prompt_assemblies_memory_item_ids_array",
        ),
        CheckConstraint(
            "jsonb_typeof(included_retrieval_ids) = 'array'",
            name="ck_chat_prompt_assemblies_retrieval_ids_array",
        ),
        CheckConstraint(
            "jsonb_typeof(included_context_refs) = 'array'",
            name="ck_chat_prompt_assemblies_context_refs_array",
        ),
        CheckConstraint(
            "jsonb_typeof(dropped_items) = 'array'",
            name="ck_chat_prompt_assemblies_dropped_items_array",
        ),
        CheckConstraint(
            "jsonb_typeof(budget_breakdown) = 'object'",
            name="ck_chat_prompt_assemblies_budget_breakdown_object",
        ),
        CheckConstraint(
            "jsonb_typeof(prompt_block_manifest) = 'object'",
            name="ck_chat_prompt_assemblies_prompt_block_manifest_object",
        ),
        UniqueConstraint("chat_run_id", name="uix_chat_prompt_assemblies_chat_run"),
    )

    chat_run: Mapped["ChatRun"] = relationship("ChatRun", back_populates="prompt_assembly")
    conversation: Mapped["Conversation"] = relationship(
        "Conversation",
        back_populates="prompt_assemblies",
    )
    assistant_message: Mapped["Message"] = relationship("Message")
    model: Mapped["Model"] = relationship("Model")
    snapshot: Mapped["ConversationStateSnapshot | None"] = relationship(
        "ConversationStateSnapshot",
    )


class ChatRunEvent(Base):
    """Append-only replay event for a chat run."""

    __tablename__ = "chat_run_events"

    id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        primary_key=True,
        server_default=text("gen_random_uuid()"),
    )
    run_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("chat_runs.id", ondelete="CASCADE"),
        nullable=False,
    )
    seq: Mapped[int] = mapped_column(Integer, nullable=False)
    event_type: Mapped[str] = mapped_column(Text, nullable=False)
    payload: Mapped[dict[str, object]] = mapped_column(JSONB, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True),
        server_default=text("now()"),
        nullable=False,
    )

    __table_args__ = (
        CheckConstraint("seq >= 1", name="ck_chat_run_events_seq_positive"),
        CheckConstraint(
            "event_type IN ('meta', 'tool_call', 'tool_result', 'citation', 'delta', 'done')",
            name="ck_chat_run_events_event_type",
        ),
        UniqueConstraint("run_id", "seq", name="uix_chat_run_events_run_seq"),
        Index("idx_chat_run_events_run_seq", "run_id", "seq"),
    )

    run: Mapped["ChatRun"] = relationship("ChatRun", back_populates="events")


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
    last_used_at: Mapped[datetime | None] = mapped_column(TIMESTAMP(timezone=True), nullable=True)
    revoked_at: Mapped[datetime | None] = mapped_column(TIMESTAMP(timezone=True), nullable=True)

    __table_args__ = (
        CheckConstraint(
            "provider IN ('openai', 'anthropic', 'gemini', 'deepseek')",
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


class BillingAccount(Base):
    """Current Stripe subscription snapshot for one user."""

    __tablename__ = "billing_accounts"

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
    stripe_customer_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    stripe_subscription_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    stripe_price_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    plan_tier: Mapped[str] = mapped_column(Text, nullable=False, server_default="free")
    subscription_status: Mapped[str | None] = mapped_column(Text, nullable=True)
    current_period_start: Mapped[datetime | None] = mapped_column(
        TIMESTAMP(timezone=True),
        nullable=True,
    )
    current_period_end: Mapped[datetime | None] = mapped_column(
        TIMESTAMP(timezone=True),
        nullable=True,
    )
    cancel_at_period_end: Mapped[bool] = mapped_column(
        Boolean,
        nullable=False,
        server_default="false",
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
        CheckConstraint(
            "plan_tier IN ('free', 'plus', 'ai_plus', 'ai_pro')",
            name="ck_billing_accounts_plan_tier",
        ),
        CheckConstraint(
            """
            subscription_status IS NULL OR subscription_status IN (
                'incomplete',
                'incomplete_expired',
                'trialing',
                'active',
                'past_due',
                'canceled',
                'unpaid',
                'paused'
            )
            """,
            name="ck_billing_accounts_subscription_status",
        ),
        UniqueConstraint("user_id", name="uq_billing_accounts_user_id"),
        UniqueConstraint("stripe_customer_id", name="uq_billing_accounts_stripe_customer_id"),
        UniqueConstraint(
            "stripe_subscription_id",
            name="uq_billing_accounts_stripe_subscription_id",
        ),
    )


class StripeWebhookEvent(Base):
    """Processed Stripe webhook event id for idempotency."""

    __tablename__ = "stripe_webhook_events"

    id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        primary_key=True,
        server_default=text("gen_random_uuid()"),
    )
    stripe_event_id: Mapped[str] = mapped_column(Text, nullable=False)
    event_type: Mapped[str] = mapped_column(Text, nullable=False)
    processed_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True),
        server_default=text("now()"),
        nullable=False,
    )
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True),
        server_default=text("now()"),
        nullable=False,
    )

    __table_args__ = (
        UniqueConstraint("stripe_event_id", name="uq_stripe_webhook_events_stripe_event_id"),
    )


class ExtensionSession(Base):
    """ExtensionSession model - opaque bearer token for browser capture."""

    __tablename__ = "extension_sessions"

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
    token_hash: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True),
        server_default=text("now()"),
        nullable=False,
    )
    last_used_at: Mapped[datetime | None] = mapped_column(TIMESTAMP(timezone=True), nullable=True)
    revoked_at: Mapped[datetime | None] = mapped_column(TIMESTAMP(timezone=True), nullable=True)

    __table_args__ = (
        CheckConstraint(
            "char_length(token_hash) = 64", name="ck_extension_sessions_token_hash_len"
        ),
        UniqueConstraint("token_hash", name="uix_extension_sessions_token_hash"),
        Index(
            "idx_extension_sessions_user_active",
            "user_id",
            "created_at",
            postgresql_where=text("revoked_at IS NULL"),
        ),
    )

    user: Mapped["User"] = relationship("User")


class MessageContextItem(Base):
    """Universal context object attached to one message."""

    __tablename__ = "message_context_items"

    id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        primary_key=True,
        server_default=text("gen_random_uuid()"),
    )
    message_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("messages.id"),
        nullable=False,
    )
    user_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("users.id"),
        nullable=False,
    )
    context_kind: Mapped[str] = mapped_column(
        Text,
        nullable=False,
        server_default="object_ref",
    )
    object_type: Mapped[str | None] = mapped_column(Text, nullable=True)
    object_id: Mapped[UUID | None] = mapped_column(PG_UUID(as_uuid=True), nullable=True)
    source_media_id: Mapped[UUID | None] = mapped_column(PG_UUID(as_uuid=True), nullable=True)
    locator_json: Mapped[dict[str, object] | None] = mapped_column(
        JSONB(none_as_null=True), nullable=True
    )
    ordinal: Mapped[int] = mapped_column(Integer, nullable=False)
    context_snapshot_json: Mapped[dict[str, object]] = mapped_column(
        "context_snapshot",
        JSONB,
        nullable=False,
        server_default=text("'{}'::jsonb"),
    )
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True),
        server_default=text("now()"),
        nullable=False,
    )

    __table_args__ = (
        CheckConstraint(
            "context_kind IN ('object_ref', 'reader_selection')",
            name="ck_message_context_items_context_kind",
        ),
        CheckConstraint(
            "object_type IS NULL OR object_type IN ('page', 'note_block', 'media', "
            "'highlight', 'conversation', 'message', 'podcast', 'content_chunk', "
            "'contributor')",
            name="ck_message_context_items_object_type",
        ),
        CheckConstraint(
            "((context_kind = 'object_ref' AND object_type IS NOT NULL "
            "AND object_id IS NOT NULL AND locator_json IS NULL) OR "
            "(context_kind = 'reader_selection' AND object_type IS NULL "
            "AND object_id IS NULL AND source_media_id IS NOT NULL "
            "AND locator_json IS NOT NULL))",
            name="ck_message_context_items_kind_shape",
        ),
        CheckConstraint(
            "locator_json IS NULL OR jsonb_typeof(locator_json) = 'object'",
            name="ck_message_context_items_locator_json",
        ),
        CheckConstraint(
            "ordinal >= 0",
            name="ck_message_context_items_ordinal_non_negative",
        ),
        CheckConstraint(
            "jsonb_typeof(context_snapshot) = 'object'",
            name="ck_message_context_items_snapshot",
        ),
        UniqueConstraint(
            "message_id",
            "ordinal",
            name="uix_message_context_items_message_ordinal",
        ),
    )

    # Relationships
    message: Mapped["Message"] = relationship("Message", back_populates="contexts")


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


# =============================================================================
# Slice 4: Library Sharing
# =============================================================================


class LibraryInvitation(Base):
    """Library invitation model - user-id invite for library membership."""

    __tablename__ = "library_invitations"

    id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        primary_key=True,
        server_default=text("gen_random_uuid()"),
    )
    library_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("libraries.id", ondelete="CASCADE"),
        nullable=False,
    )
    inviter_user_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
    )
    invitee_user_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
    )
    role: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default="pending")
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True),
        server_default=text("now()"),
        nullable=False,
    )
    responded_at: Mapped[datetime | None] = mapped_column(
        TIMESTAMP(timezone=True),
        nullable=True,
    )

    __table_args__ = (
        CheckConstraint(
            "role IN ('admin', 'member')",
            name="ck_library_invitations_role",
        ),
        CheckConstraint(
            "status IN ('pending', 'accepted', 'declined', 'revoked')",
            name="ck_library_invitations_status",
        ),
        CheckConstraint(
            "inviter_user_id <> invitee_user_id",
            name="ck_library_invitations_not_self",
        ),
        CheckConstraint(
            "(status = 'pending' AND responded_at IS NULL) "
            "OR (status <> 'pending' AND responded_at IS NOT NULL)",
            name="ck_library_invitations_responded_at",
        ),
    )

    # Relationships
    library: Mapped["Library"] = relationship("Library")
    inviter: Mapped["User"] = relationship("User", foreign_keys=[inviter_user_id])
    invitee: Mapped["User"] = relationship("User", foreign_keys=[invitee_user_id])


class UserMediaDeletion(Base):
    """Viewer-specific tombstone for media hidden after delete."""

    __tablename__ = "user_media_deletions"

    id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        primary_key=True,
        server_default=text("gen_random_uuid()"),
    )
    user_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("users.id"),
        nullable=False,
    )
    media_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("media.id"),
        nullable=False,
    )
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True),
        server_default=text("now()"),
        nullable=False,
    )

    __table_args__ = (
        UniqueConstraint("user_id", "media_id", name="uix_user_media_deletions_user_media"),
    )


class DefaultLibraryIntrinsic(Base):
    """Tracks media intentionally present in a user's default library.

    Independent of closure edges — represents direct user intent (e.g. upload,
    from-url creation, or legacy pre-S4 presence).
    """

    __tablename__ = "default_library_intrinsics"

    default_library_id: Mapped[UUID] = mapped_column(
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


class DefaultLibraryClosureEdge(Base):
    """Tracks which shared libraries justify default-library materialization.

    An edge (default_library_id, media_id, source_library_id) means: media_id
    should be materialized in default_library_id because source_library_id
    contains media_id and the default library's owner is a member of
    source_library_id.
    """

    __tablename__ = "default_library_closure_edges"

    default_library_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("libraries.id", ondelete="CASCADE"),
        primary_key=True,
    )
    media_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("media.id", ondelete="CASCADE"),
        primary_key=True,
    )
    source_library_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("libraries.id", ondelete="CASCADE"),
        primary_key=True,
    )
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True),
        server_default=text("now()"),
        nullable=False,
    )


class DefaultLibraryBackfillJob(Base):
    """Durable backfill intent for default-library closure materialization.

    Created when an invite is accepted. A worker picks up pending jobs and
    materializes closure edges + default library entry rows.
    """

    __tablename__ = "default_library_backfill_jobs"

    default_library_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("libraries.id", ondelete="CASCADE"),
        primary_key=True,
    )
    source_library_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("libraries.id", ondelete="CASCADE"),
        primary_key=True,
    )
    user_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        primary_key=True,
    )
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default="pending")
    attempts: Mapped[int] = mapped_column(Integer, server_default="0", nullable=False)
    last_error_code: Mapped[str | None] = mapped_column(Text, nullable=True)
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
    finished_at: Mapped[datetime | None] = mapped_column(
        TIMESTAMP(timezone=True),
        nullable=True,
    )

    __table_args__ = (
        CheckConstraint(
            "status IN ('pending', 'running', 'completed', 'failed')",
            name="ck_default_library_backfill_jobs_status",
        ),
        CheckConstraint(
            "attempts >= 0",
            name="ck_default_library_backfill_jobs_attempts",
        ),
        CheckConstraint(
            "(status IN ('pending', 'running') AND finished_at IS NULL) "
            "OR (status IN ('completed', 'failed') AND finished_at IS NOT NULL)",
            name="ck_default_library_backfill_jobs_finished_at_state",
        ),
    )


# =============================================================================
# Slice 5: EPUB
# =============================================================================


class EpubTocNode(Base):
    """Persisted EPUB navigation node."""

    __tablename__ = "epub_toc_nodes"

    media_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("media.id", ondelete="CASCADE"),
        nullable=False,
        primary_key=True,
    )
    node_id: Mapped[str] = mapped_column(Text, nullable=False, primary_key=True)
    nav_type: Mapped[str] = mapped_column(Text, nullable=False, server_default="toc")
    parent_node_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    label: Mapped[str] = mapped_column(Text, nullable=False)
    href: Mapped[str | None] = mapped_column(Text, nullable=True)
    fragment_idx: Mapped[int | None] = mapped_column(Integer, nullable=True)
    depth: Mapped[int] = mapped_column(Integer, nullable=False)
    order_key: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True),
        server_default=text("now()"),
        nullable=False,
    )

    __table_args__ = (
        CheckConstraint(
            "char_length(node_id) BETWEEN 1 AND 255",
            name="ck_epub_toc_nodes_node_id_nonempty",
        ),
        CheckConstraint(
            "nav_type IN ('toc', 'landmarks', 'page_list')",
            name="ck_epub_toc_nodes_nav_type",
        ),
        CheckConstraint(
            "parent_node_id IS NULL OR parent_node_id <> node_id",
            name="ck_epub_toc_nodes_parent_nonself",
        ),
        CheckConstraint(
            "char_length(trim(label)) BETWEEN 1 AND 512",
            name="ck_epub_toc_nodes_label_nonempty",
        ),
        CheckConstraint(
            "depth >= 0 AND depth <= 16",
            name="ck_epub_toc_nodes_depth_range",
        ),
        CheckConstraint(
            "fragment_idx IS NULL OR fragment_idx >= 0",
            name="ck_epub_toc_nodes_fragment_idx_nonneg",
        ),
        CheckConstraint(
            r"order_key ~ '^[0-9]{4}([.][0-9]{4})*$'",
            name="ck_epub_toc_nodes_order_key_format",
        ),
        UniqueConstraint(
            "media_id",
            "nav_type",
            "order_key",
            name="uix_epub_toc_nodes_media_nav_order",
        ),
    )

    # Relationships
    media: Mapped["Media"] = relationship("Media")


class EpubNavLocation(Base):
    """Canonical EPUB section/navigation targets.

    Persisted, deterministic section targets consumed by reader navigation UI.
    """

    __tablename__ = "epub_nav_locations"

    media_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("media.id", ondelete="CASCADE"),
        nullable=False,
        primary_key=True,
    )
    location_id: Mapped[str] = mapped_column(Text, nullable=False, primary_key=True)
    ordinal: Mapped[int] = mapped_column(Integer, nullable=False)
    source_node_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    label: Mapped[str] = mapped_column(Text, nullable=False)
    fragment_idx: Mapped[int] = mapped_column(Integer, nullable=False)
    href_path: Mapped[str | None] = mapped_column(Text, nullable=True)
    href_fragment: Mapped[str | None] = mapped_column(Text, nullable=True)
    source: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True),
        server_default=text("now()"),
        nullable=False,
    )

    __table_args__ = (
        CheckConstraint(
            "char_length(location_id) BETWEEN 1 AND 255",
            name="ck_epub_nav_locations_location_id_nonempty",
        ),
        CheckConstraint(
            "char_length(trim(label)) BETWEEN 1 AND 512",
            name="ck_epub_nav_locations_label_nonempty",
        ),
        CheckConstraint(
            "fragment_idx >= 0",
            name="ck_epub_nav_locations_fragment_idx_nonneg",
        ),
        CheckConstraint(
            "ordinal >= 0",
            name="ck_epub_nav_locations_ordinal_nonneg",
        ),
        CheckConstraint(
            "source IN ('toc', 'spine')",
            name="ck_epub_nav_locations_source_valid",
        ),
        UniqueConstraint("media_id", "ordinal", name="uix_epub_nav_locations_media_ordinal"),
        UniqueConstraint("media_id", "source_node_id", name="uix_epub_nav_locations_media_source"),
    )

    media: Mapped["Media"] = relationship("Media")


class EpubFragmentSource(Base):
    """EPUB package source metadata for one persisted fragment."""

    __tablename__ = "epub_fragment_sources"

    id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        primary_key=True,
        server_default=text("gen_random_uuid()"),
    )
    media_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("media.id"),
        nullable=False,
    )
    fragment_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("fragments.id"),
        nullable=False,
    )
    package_href: Mapped[str] = mapped_column(Text, nullable=False)
    manifest_item_id: Mapped[str] = mapped_column(Text, nullable=False)
    spine_itemref_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    media_type: Mapped[str] = mapped_column(Text, nullable=False)
    linear: Mapped[bool] = mapped_column(Boolean, nullable=False)
    reading_order: Mapped[int] = mapped_column(Integer, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True),
        server_default=text("now()"),
        nullable=False,
    )

    __table_args__ = (
        UniqueConstraint("media_id", "fragment_id", name="uq_epub_fragment_sources_fragment"),
        UniqueConstraint("media_id", "package_href", name="uq_epub_fragment_sources_href"),
        CheckConstraint(
            "char_length(package_href) BETWEEN 1 AND 2048",
            name="ck_epub_fragment_sources_href_length",
        ),
        CheckConstraint(
            "char_length(manifest_item_id) BETWEEN 1 AND 255",
            name="ck_epub_fragment_sources_manifest_id_length",
        ),
        CheckConstraint(
            "spine_itemref_id IS NULL OR char_length(spine_itemref_id) BETWEEN 1 AND 255",
            name="ck_epub_fragment_sources_itemref_id_length",
        ),
        CheckConstraint("reading_order >= 0", name="ck_epub_fragment_sources_reading_order"),
        Index("ix_epub_fragment_sources_media_order", "media_id", "reading_order"),
    )

    media: Mapped["Media"] = relationship("Media")
    fragment: Mapped["Fragment"] = relationship("Fragment")


class EpubResource(Base):
    """Stored EPUB package resource owned by one media row."""

    __tablename__ = "epub_resources"

    id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        primary_key=True,
        server_default=text("gen_random_uuid()"),
    )
    media_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("media.id"),
        nullable=False,
    )
    manifest_item_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    package_href: Mapped[str] = mapped_column(Text, nullable=False)
    asset_key: Mapped[str] = mapped_column(Text, nullable=False)
    storage_path: Mapped[str] = mapped_column(Text, nullable=False)
    content_type: Mapped[str] = mapped_column(Text, nullable=False)
    size_bytes: Mapped[int] = mapped_column(BigInteger, nullable=False)
    sha256: Mapped[str] = mapped_column(Text, nullable=False)
    fallback_item_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    properties: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True),
        server_default=text("now()"),
        nullable=False,
    )

    __table_args__ = (
        UniqueConstraint("media_id", "package_href", name="uq_epub_resources_href"),
        UniqueConstraint("media_id", "asset_key", name="uq_epub_resources_asset_key"),
        CheckConstraint(
            "char_length(package_href) BETWEEN 1 AND 2048",
            name="ck_epub_resources_href_length",
        ),
        CheckConstraint(
            "char_length(asset_key) BETWEEN 1 AND 2048",
            name="ck_epub_resources_asset_key_length",
        ),
        CheckConstraint("size_bytes >= 0", name="ck_epub_resources_size_non_negative"),
        CheckConstraint("char_length(sha256) = 64", name="ck_epub_resources_sha256_length"),
        Index("ix_epub_resources_media", "media_id"),
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


class ReaderProfile(Base):
    """Per-user reader defaults."""

    __tablename__ = "reader_profiles"

    user_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        primary_key=True,
    )
    theme: Mapped[str] = mapped_column(Text, nullable=False, server_default="light")
    font_size_px: Mapped[int] = mapped_column(Integer, nullable=False, server_default="16")
    line_height: Mapped[float] = mapped_column(Numeric(3, 2), nullable=False, server_default="1.5")
    font_family: Mapped[str] = mapped_column(Text, nullable=False, server_default="serif")
    column_width_ch: Mapped[int] = mapped_column(Integer, nullable=False, server_default="65")
    focus_mode: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default="false")
    updated_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True),
        server_default=text("now()"),
        nullable=False,
    )

    __table_args__ = (
        CheckConstraint(
            "theme IN ('light', 'dark')",
            name="ck_reader_profiles_theme",
        ),
        CheckConstraint(
            "font_size_px BETWEEN 12 AND 28",
            name="ck_reader_profiles_font_size_px",
        ),
        CheckConstraint(
            "line_height BETWEEN 1.2 AND 2.2",
            name="ck_reader_profiles_line_height",
        ),
        CheckConstraint(
            "font_family IN ('serif', 'sans')",
            name="ck_reader_profiles_font_family",
        ),
        CheckConstraint(
            "column_width_ch BETWEEN 40 AND 120",
            name="ck_reader_profiles_column_width_ch",
        ),
    )

    # Relationships
    user: Mapped["User"] = relationship("User")


class CommandPaletteUsage(Base):
    """Per-user command palette usage history."""

    __tablename__ = "command_palette_usages"

    id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        primary_key=True,
        server_default=text("gen_random_uuid()"),
    )
    user_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("users.id"),
        nullable=False,
    )
    query_normalized: Mapped[str] = mapped_column(Text, nullable=False)
    target_key: Mapped[str] = mapped_column(Text, nullable=False)
    target_kind: Mapped[str] = mapped_column(Text, nullable=False)
    target_href: Mapped[str | None] = mapped_column(Text, nullable=True)
    title_snapshot: Mapped[str] = mapped_column(Text, nullable=False)
    source: Mapped[str] = mapped_column(Text, nullable=False)
    use_count: Mapped[int] = mapped_column(Integer, nullable=False, server_default=text("1"))
    visit_timestamps: Mapped[list[str]] = mapped_column(JSONB, nullable=False)
    last_used_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True),
        server_default=text("now()"),
        nullable=False,
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
        UniqueConstraint(
            "user_id",
            "query_normalized",
            "target_key",
            name="uq_command_palette_usages_user_query_target",
        ),
        CheckConstraint("use_count >= 1", name="ck_command_palette_usages_use_count"),
        CheckConstraint(
            "target_kind IN ('href', 'action', 'prefill')",
            name="ck_command_palette_usages_target_kind",
        ),
        CheckConstraint(
            "source IN ('static', 'workspace', 'recent', 'oracle', 'search', 'ai')",
            name="ck_command_palette_usages_source",
        ),
        CheckConstraint(
            "(target_kind = 'href' AND target_href IS NOT NULL) OR "
            "(target_kind <> 'href' AND target_href IS NULL)",
            name="ck_command_palette_usages_target_href",
        ),
        Index(
            "ix_command_palette_usages_user_last_used_at_id",
            "user_id",
            text("last_used_at DESC"),
            text("id DESC"),
        ),
        Index(
            "ix_command_palette_usages_user_query_last_used_at",
            "user_id",
            "query_normalized",
            text("last_used_at DESC"),
        ),
    )

    user: Mapped["User"] = relationship("User", back_populates="command_palette_usages")


class ReaderMediaState(Base):
    """Per user + media reader state."""

    __tablename__ = "reader_media_state"

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
    media_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("media.id", ondelete="CASCADE"),
        nullable=False,
    )
    locator: Mapped[dict[str, object] | None] = mapped_column(JSONB, nullable=True)
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
        UniqueConstraint("user_id", "media_id", name="uq_reader_media_state_user_media"),
        CheckConstraint(
            "locator IS NULL OR (jsonb_typeof(locator) = 'object' AND locator <> '{}'::jsonb)",
            name="ck_reader_media_state_locator",
        ),
        Index("idx_reader_media_state_media", "media_id"),
    )

    # Relationships
    user: Mapped["User"] = relationship("User")
    media: Mapped["Media"] = relationship("Media")


class OracleCorpusSetVersion(Base):
    """Versioned, immutable oracle corpus release."""

    __tablename__ = "oracle_corpus_set_versions"

    id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        primary_key=True,
        server_default=text("gen_random_uuid()"),
    )
    version: Mapped[str] = mapped_column(Text, nullable=False)
    label: Mapped[str] = mapped_column(Text, nullable=False)
    embedding_model: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True),
        server_default=text("now()"),
        nullable=False,
    )

    __table_args__ = (
        CheckConstraint(
            "char_length(version) BETWEEN 1 AND 128",
            name="ck_oracle_corpus_versions_version_length",
        ),
        CheckConstraint(
            "char_length(label) BETWEEN 1 AND 200",
            name="ck_oracle_corpus_versions_label_length",
        ),
        CheckConstraint(
            "char_length(embedding_model) BETWEEN 1 AND 128",
            name="ck_oracle_corpus_versions_embedding_model_length",
        ),
        UniqueConstraint("version", name="uix_oracle_corpus_versions_version"),
    )


class OracleCorpusWork(Base):
    """Curated public-domain work in the oracle corpus."""

    __tablename__ = "oracle_corpus_works"

    id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        primary_key=True,
        server_default=text("gen_random_uuid()"),
    )
    corpus_set_version_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("oracle_corpus_set_versions.id"),
        nullable=False,
    )
    slug: Mapped[str] = mapped_column(Text, nullable=False)
    title: Mapped[str] = mapped_column(Text, nullable=False)
    author: Mapped[str] = mapped_column(Text, nullable=False)
    year: Mapped[str | None] = mapped_column(Text, nullable=True)
    edition_label: Mapped[str] = mapped_column(Text, nullable=False)
    source_repository: Mapped[str] = mapped_column(Text, nullable=False)
    source_url: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True),
        server_default=text("now()"),
        nullable=False,
    )

    __table_args__ = (
        CheckConstraint("char_length(slug) BETWEEN 1 AND 160", name="ck_oracle_works_slug_length"),
        UniqueConstraint(
            "corpus_set_version_id",
            "slug",
            name="uix_oracle_works_version_slug",
        ),
    )


class OracleCorpusPassage(Base):
    """One indexed passage of a public-domain work in the oracle corpus."""

    __tablename__ = "oracle_corpus_passages"

    id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        primary_key=True,
        server_default=text("gen_random_uuid()"),
    )
    corpus_set_version_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("oracle_corpus_set_versions.id"),
        nullable=False,
    )
    work_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("oracle_corpus_works.id"),
        nullable=False,
    )
    passage_index: Mapped[int] = mapped_column(Integer, nullable=False)
    canonical_text: Mapped[str] = mapped_column(Text, nullable=False)
    locator_label: Mapped[str] = mapped_column(Text, nullable=False)
    locator: Mapped[dict[str, object]] = mapped_column(
        JSONB, nullable=False, server_default=text("'{}'::jsonb")
    )
    source: Mapped[dict[str, object]] = mapped_column(
        JSONB, nullable=False, server_default=text("'{}'::jsonb")
    )
    tags: Mapped[list[str]] = mapped_column(
        JSONB, nullable=False, server_default=text("'[]'::jsonb")
    )
    embedding_model: Mapped[str | None] = mapped_column(Text, nullable=True)
    embedding: Mapped[list[float] | None] = mapped_column(PGVector(256), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True),
        server_default=text("now()"),
        nullable=False,
    )

    work: Mapped["OracleCorpusWork"] = relationship("OracleCorpusWork")

    __table_args__ = (
        CheckConstraint(
            "char_length(canonical_text) BETWEEN 1 AND 4000",
            name="ck_oracle_passages_text_length",
        ),
        CheckConstraint("passage_index >= 0", name="ck_oracle_passages_index"),
        CheckConstraint(
            "jsonb_typeof(locator) = 'object'", name="ck_oracle_passages_locator_object"
        ),
        CheckConstraint("jsonb_typeof(source) = 'object'", name="ck_oracle_passages_source_object"),
        CheckConstraint("jsonb_typeof(tags) = 'array'", name="ck_oracle_passages_tags_array"),
        CheckConstraint(
            "embedding_model IS NULL OR char_length(embedding_model) BETWEEN 1 AND 128",
            name="ck_oracle_passages_embedding_model_length",
        ),
        UniqueConstraint("work_id", "passage_index", name="uix_oracle_passages_work_index"),
        Index("idx_oracle_passages_version_embedding", "corpus_set_version_id", "embedding_model"),
    )


class OracleCorpusImage(Base):
    """Curated public-domain image plate in the oracle corpus."""

    __tablename__ = "oracle_corpus_images"

    id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        primary_key=True,
        server_default=text("gen_random_uuid()"),
    )
    corpus_set_version_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("oracle_corpus_set_versions.id"),
        nullable=False,
    )
    source_repository: Mapped[str] = mapped_column(Text, nullable=False)
    source_page_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    source_url: Mapped[str] = mapped_column(Text, nullable=False)
    license_text: Mapped[str | None] = mapped_column(Text, nullable=True)
    artist: Mapped[str] = mapped_column(Text, nullable=False)
    work_title: Mapped[str] = mapped_column(Text, nullable=False)
    year: Mapped[str | None] = mapped_column(Text, nullable=True)
    attribution_text: Mapped[str] = mapped_column(Text, nullable=False)
    width: Mapped[int] = mapped_column(Integer, nullable=False)
    height: Mapped[int] = mapped_column(Integer, nullable=False)
    tags: Mapped[list[str]] = mapped_column(
        JSONB, nullable=False, server_default=text("'[]'::jsonb")
    )
    embedding_model: Mapped[str | None] = mapped_column(Text, nullable=True)
    embedding: Mapped[list[float] | None] = mapped_column(PGVector(256), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True),
        server_default=text("now()"),
        nullable=False,
    )

    __table_args__ = (
        CheckConstraint("width > 0", name="ck_oracle_images_width_positive"),
        CheckConstraint("height > 0", name="ck_oracle_images_height_positive"),
        CheckConstraint("jsonb_typeof(tags) = 'array'", name="ck_oracle_images_tags_array"),
        CheckConstraint(
            "embedding_model IS NULL OR char_length(embedding_model) BETWEEN 1 AND 128",
            name="ck_oracle_images_embedding_model_length",
        ),
        UniqueConstraint(
            "corpus_set_version_id",
            "source_url",
            name="uix_oracle_images_version_source_url",
        ),
        Index("idx_oracle_images_version_embedding", "corpus_set_version_id", "embedding_model"),
    )


class OracleReading(Base):
    """One oracle reading: a question, retrieved sources, generated interpretation."""

    __tablename__ = "oracle_readings"

    id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        primary_key=True,
        server_default=text("gen_random_uuid()"),
    )
    user_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("users.id"),
        nullable=False,
    )
    corpus_set_version_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("oracle_corpus_set_versions.id"),
        nullable=False,
    )
    folio_number: Mapped[int] = mapped_column(Integer, nullable=False)
    folio_motto: Mapped[str | None] = mapped_column(Text, nullable=True)
    folio_motto_gloss: Mapped[str | None] = mapped_column(Text, nullable=True)
    folio_theme: Mapped[str | None] = mapped_column(Text, nullable=True)
    argument_text: Mapped[str | None] = mapped_column(Text, nullable=True)
    question_text: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("'pending'"))
    prompt_version: Mapped[str] = mapped_column(Text, nullable=False)
    provider_request_hash: Mapped[str | None] = mapped_column(Text, nullable=True)
    generator_model_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("models.id"),
        nullable=True,
    )
    image_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("oracle_corpus_images.id"),
        nullable=True,
    )
    error_code: Mapped[str | None] = mapped_column(Text, nullable=True)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    started_at: Mapped[datetime | None] = mapped_column(TIMESTAMP(timezone=True), nullable=True)
    completed_at: Mapped[datetime | None] = mapped_column(TIMESTAMP(timezone=True), nullable=True)
    failed_at: Mapped[datetime | None] = mapped_column(TIMESTAMP(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True),
        server_default=text("now()"),
        nullable=False,
    )

    image: Mapped["OracleCorpusImage | None"] = relationship("OracleCorpusImage")

    __table_args__ = (
        CheckConstraint("folio_number > 0", name="ck_oracle_readings_folio_positive"),
        CheckConstraint(
            "status IN ('pending', 'streaming', 'complete', 'failed')",
            name="ck_oracle_readings_status",
        ),
        CheckConstraint(
            "char_length(btrim(question_text)) BETWEEN 1 AND 280",
            name="ck_oracle_readings_question_length",
        ),
        CheckConstraint(
            "char_length(prompt_version) BETWEEN 1 AND 64",
            name="ck_oracle_readings_prompt_version_length",
        ),
        CheckConstraint(
            "provider_request_hash IS NULL OR char_length(provider_request_hash) BETWEEN 1 AND 128",
            name="ck_oracle_readings_provider_request_hash_length",
        ),
        CheckConstraint(
            "(status = 'complete' AND completed_at IS NOT NULL) OR status != 'complete'",
            name="ck_oracle_readings_complete_has_timestamp",
        ),
        CheckConstraint(
            "(status = 'failed' AND failed_at IS NOT NULL AND error_code IS NOT NULL) "
            "OR status != 'failed'",
            name="ck_oracle_readings_failed_has_error",
        ),
        CheckConstraint(
            "folio_motto IS NULL OR char_length(folio_motto) BETWEEN 1 AND 80",
            name="ck_oracle_readings_motto_length",
        ),
        CheckConstraint(
            "folio_motto_gloss IS NULL OR char_length(folio_motto_gloss) BETWEEN 1 AND 120",
            name="ck_oracle_readings_motto_gloss_length",
        ),
        CheckConstraint(
            "folio_theme IS NULL OR folio_theme IN ("
            "'Of Time','Of Death','Of the Threshold','Of Vanity','Of Solitude','Of Love',"
            "'Of Fortune','Of Memory','Of the Self','Of the Other','Of Fear','Of Courage',"
            "'Of Faith','Of Doubt','Of Power','Of Wisdom','Of the Body','Of the Soul',"
            "'Of Origins','Of Endings','Of Silence','Of the Word','Of Justice','Of Mercy'"
            ")",
            name="ck_oracle_readings_theme",
        ),
        UniqueConstraint("user_id", "folio_number", name="uix_oracle_readings_user_folio"),
        Index("idx_oracle_readings_user_created", "user_id", text("created_at DESC")),
        Index("idx_oracle_readings_user_image", "user_id", "image_id"),
        Index("idx_oracle_readings_user_theme", "user_id", "folio_theme"),
    )


class OracleReadingPassage(Base):
    """One persisted citation in an oracle reading, library or public-domain."""

    __tablename__ = "oracle_reading_passages"

    id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        primary_key=True,
        server_default=text("gen_random_uuid()"),
    )
    reading_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("oracle_readings.id"),
        nullable=False,
    )
    phase: Mapped[str] = mapped_column(Text, nullable=False)
    source_kind: Mapped[str] = mapped_column(Text, nullable=False)
    source_ref: Mapped[dict[str, object]] = mapped_column(JSONB, nullable=False)
    exact_snippet: Mapped[str] = mapped_column(Text, nullable=False)
    locator_label: Mapped[str] = mapped_column(Text, nullable=False)
    locator: Mapped[dict[str, object]] = mapped_column(
        JSONB, nullable=False, server_default=text("'{}'::jsonb")
    )
    source: Mapped[dict[str, object]] = mapped_column(
        JSONB, nullable=False, server_default=text("'{}'::jsonb")
    )
    attribution_text: Mapped[str] = mapped_column(Text, nullable=False)
    marginalia_text: Mapped[str] = mapped_column(Text, nullable=False)
    deep_link: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True),
        server_default=text("now()"),
        nullable=False,
    )

    __table_args__ = (
        CheckConstraint(
            "source_kind IN ('user_media', 'public_domain')",
            name="ck_oracle_reading_passages_source_kind",
        ),
        CheckConstraint(
            "phase IN ('descent', 'ordeal', 'ascent')",
            name="ck_oracle_reading_passages_phase",
        ),
        CheckConstraint(
            "jsonb_typeof(source_ref) = 'object'",
            name="ck_oracle_reading_passages_source_ref_object",
        ),
        CheckConstraint(
            "jsonb_typeof(locator) = 'object'",
            name="ck_oracle_reading_passages_locator_object",
        ),
        CheckConstraint(
            "jsonb_typeof(source) = 'object'",
            name="ck_oracle_reading_passages_source_object",
        ),
        UniqueConstraint("reading_id", "phase", name="uix_oracle_reading_passages_phase"),
    )


class OracleReadingEvent(Base):
    """Append-only SSE replay event for an oracle reading."""

    __tablename__ = "oracle_reading_events"

    id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        primary_key=True,
        server_default=text("gen_random_uuid()"),
    )
    reading_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("oracle_readings.id"),
        nullable=False,
    )
    seq: Mapped[int] = mapped_column(Integer, nullable=False)
    event_type: Mapped[str] = mapped_column(Text, nullable=False)
    payload: Mapped[dict[str, object]] = mapped_column(JSONB, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True),
        server_default=text("now()"),
        nullable=False,
    )

    __table_args__ = (
        CheckConstraint("seq >= 1", name="ck_oracle_reading_events_seq_positive"),
        CheckConstraint(
            "event_type IN ("
            "'meta', 'bind', 'argument', 'plate', 'passage', 'delta', 'omens', 'error', 'done'"
            ")",
            name="ck_oracle_reading_events_type",
        ),
        UniqueConstraint("reading_id", "seq", name="uix_oracle_reading_events_seq"),
        Index("idx_oracle_reading_events_reading_seq", "reading_id", "seq"),
    )
