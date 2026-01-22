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

    # Relationship
    media: Mapped["Media"] = relationship("Media", back_populates="fragments")


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

    # Note: Relationships deferred to PR-06 per PR-01 spec (keep schema-only)


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

    # Note: Relationships deferred to PR-06 per PR-01 spec (keep schema-only)
