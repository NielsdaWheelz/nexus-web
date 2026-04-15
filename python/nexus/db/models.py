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
    library_media: Mapped[list["LibraryMedia"]] = relationship(
        "LibraryMedia", back_populates="media", cascade="all, delete-orphan"
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
    transcript_request_audits: Mapped[list["PodcastTranscriptRequestAudit"]] = relationship(
        "PodcastTranscriptRequestAudit",
        back_populates="media",
        cascade="all, delete-orphan",
    )
    authors: Mapped[list["MediaAuthor"]] = relationship(
        "MediaAuthor",
        back_populates="media",
        cascade="all, delete-orphan",
        order_by=lambda: MediaAuthor.sort_order,
    )


class MediaAuthor(Base):
    """Author/creator associated with a media item."""

    __tablename__ = "media_authors"

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
    name: Mapped[str] = mapped_column(Text, nullable=False)
    role: Mapped[str | None] = mapped_column(Text, nullable=True)
    sort_order: Mapped[int] = mapped_column(Integer, server_default="0", nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True),
        server_default=text("now()"),
        nullable=False,
    )

    __table_args__ = (Index("ix_media_authors_media_id", "media_id"),)

    # Relationship
    media: Mapped["Media"] = relationship("Media", back_populates="authors")


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
    position: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")

    __table_args__ = (
        CheckConstraint("position >= 0", name="ck_library_media_position_non_negative"),
        Index("ix_library_media_library_position", "library_id", "position"),
    )

    # Relationships
    library: Mapped["Library"] = relationship("Library", back_populates="library_media")
    media: Mapped["Media"] = relationship("Media", back_populates="library_media")


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
    author: Mapped[str | None] = mapped_column(Text, nullable=True)
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


class PodcastSubscriptionCategory(Base):
    """Per-user subscription grouping category (folder-like)."""

    __tablename__ = "podcast_subscription_categories"

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
    name: Mapped[str] = mapped_column(Text, nullable=False)
    position: Mapped[int] = mapped_column(Integer, nullable=False)
    color: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True),
        server_default=text("now()"),
        nullable=False,
    )

    __table_args__ = (
        UniqueConstraint(
            "user_id",
            "name",
            name="uq_podcast_subscription_categories_user_name",
        ),
        Index("ix_podcast_subscription_categories_user_position", "user_id", "position"),
    )

    subscriptions: Mapped[list["PodcastSubscription"]] = relationship(
        "PodcastSubscription",
        back_populates="category",
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
    unsubscribe_mode: Mapped[int] = mapped_column(Integer, nullable=False, server_default="1")
    auto_queue: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default="false")
    default_playback_speed: Mapped[float | None] = mapped_column(Float, nullable=True)
    category_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("podcast_subscription_categories.id", ondelete="SET NULL"),
        nullable=True,
    )
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
            "unsubscribe_mode IN (1, 2, 3)",
            name="ck_podcast_subscriptions_unsubscribe_mode_valid",
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
    category: Mapped["PodcastSubscriptionCategory | None"] = relationship(
        "PodcastSubscriptionCategory",
        back_populates="subscriptions",
    )


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
    user: Mapped["User"] = relationship("User")


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


class PodcastUserPlan(Base):
    """Manual plan overrides used for podcast quota and ingest-window policy."""

    __tablename__ = "podcast_user_plans"

    user_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        primary_key=True,
    )
    plan_tier: Mapped[str] = mapped_column(Text, nullable=False)
    daily_transcription_minutes: Mapped[int | None] = mapped_column(Integer, nullable=True)
    initial_episode_window: Mapped[int] = mapped_column(Integer, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True),
        server_default=text("now()"),
        nullable=False,
    )

    __table_args__ = (
        CheckConstraint(
            "plan_tier IN ('free', 'paid')",
            name="ck_podcast_user_plans_plan_tier",
        ),
        CheckConstraint(
            "daily_transcription_minutes IS NULL OR daily_transcription_minutes >= 0",
            name="ck_podcast_user_plans_daily_minutes_non_negative",
        ),
        CheckConstraint(
            "initial_episode_window >= 1",
            name="ck_podcast_user_plans_initial_episode_window_positive",
        ),
    )


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
    chunks: Mapped[list["PodcastTranscriptChunk"]] = relationship(
        "PodcastTranscriptChunk",
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


class PodcastTranscriptChunk(Base):
    """Chunk + embedding artifact persisted per transcript version."""

    __tablename__ = "podcast_transcript_chunks"

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
    chunk_idx: Mapped[int] = mapped_column(Integer, nullable=False)
    chunk_text: Mapped[str] = mapped_column(Text, nullable=False)
    t_start_ms: Mapped[int] = mapped_column(BigInteger, nullable=False)
    t_end_ms: Mapped[int] = mapped_column(BigInteger, nullable=False)
    embedding: Mapped[list[float]] = mapped_column(JSONB, nullable=False)
    embedding_model: Mapped[str] = mapped_column(Text, nullable=False, server_default="hash_v1")
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True),
        server_default=text("now()"),
        nullable=False,
    )

    __table_args__ = (
        UniqueConstraint(
            "transcript_version_id",
            "chunk_idx",
            name="uq_podcast_transcript_chunks_version_idx",
        ),
        CheckConstraint(
            "chunk_idx >= 0",
            name="ck_podcast_transcript_chunks_chunk_idx_non_negative",
        ),
        CheckConstraint(
            "t_start_ms >= 0 AND t_end_ms > t_start_ms",
            name="ck_podcast_transcript_chunks_time_offsets_valid",
        ),
        Index(
            "ix_podcast_transcript_chunks_media_start",
            "media_id",
            "t_start_ms",
            "chunk_idx",
        ),
    )

    transcript_version: Mapped["PodcastTranscriptVersion"] = relationship(
        "PodcastTranscriptVersion", back_populates="chunks"
    )
    media: Mapped["Media"] = relationship("Media")


class MediaTranscriptState(Base):
    """Dedicated transcript-state bridge for media capabilities/search readiness."""

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
# Slice 2: Highlights + Annotations
# =============================================================================


class Highlight(Base):
    """Highlight model - a user-owned selection anchored to media content.

    Supports typed anchor subtypes:
    - fragment_offsets: half-open [start_offset, end_offset) over canonical_text
    - pdf_page_geometry: page-space geometry (quads/rects) on a PDF page

    Legacy fragment columns (fragment_id, start_offset, end_offset) are a
    transitional nullable bridge.  For fragment-backed highlights all three
    are non-NULL; for non-fragment highlights all three are NULL.

    The anchor_kind / anchor_media_id fields are dormant until pr-02 kernel
    adoption and are NULL for rows created through legacy fragment codepaths.
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

    # Legacy fragment columns — nullable bridge (S6 pr-01)
    fragment_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("fragments.id", ondelete="CASCADE"),
        nullable=True,
    )
    start_offset: Mapped[int | None] = mapped_column(Integer, nullable=True)
    end_offset: Mapped[int | None] = mapped_column(Integer, nullable=True)

    # S6 typed-highlight logical fields (dormant until pr-02)
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
            "(fragment_id IS NOT NULL AND start_offset IS NOT NULL "
            "AND end_offset IS NOT NULL AND start_offset >= 0 "
            "AND end_offset > start_offset) "
            "OR (fragment_id IS NULL AND start_offset IS NULL "
            "AND end_offset IS NULL)",
            name="ck_highlights_fragment_bridge",
        ),
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
        UniqueConstraint(
            "user_id",
            "fragment_id",
            "start_offset",
            "end_offset",
            name="uix_highlights_user_fragment_offsets",
        ),
    )

    # Relationships
    fragment: Mapped["Fragment | None"] = relationship(
        "Fragment", back_populates="highlights", lazy="joined"
    )
    annotation: Mapped["Annotation | None"] = relationship(
        "Annotation",
        uselist=False,
        back_populates="highlight",
        lazy="joined",
        passive_deletes=True,
    )
    fragment_anchor: Mapped["HighlightFragmentAnchor | None"] = relationship(
        "HighlightFragmentAnchor",
        back_populates="highlight",
        uselist=False,
        cascade="all, delete-orphan",
        passive_deletes=True,
    )
    transcript_anchor: Mapped["HighlightTranscriptAnchor | None"] = relationship(
        "HighlightTranscriptAnchor",
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
    )

    highlight: Mapped["Highlight"] = relationship("Highlight", back_populates="fragment_anchor")
    fragment: Mapped["Fragment"] = relationship("Fragment")


class HighlightTranscriptAnchor(Base):
    """Transcript-version aware anchor subtype for transcript highlights."""

    __tablename__ = "highlight_transcript_anchors"

    highlight_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("highlights.id", ondelete="CASCADE"),
        primary_key=True,
    )
    transcript_version_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("podcast_transcript_versions.id", ondelete="CASCADE"),
        nullable=False,
    )
    transcript_segment_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("podcast_transcript_segments.id", ondelete="SET NULL"),
        nullable=True,
    )
    t_start_ms: Mapped[int] = mapped_column(BigInteger, nullable=False)
    t_end_ms: Mapped[int] = mapped_column(BigInteger, nullable=False)
    start_offset: Mapped[int] = mapped_column(Integer, nullable=False)
    end_offset: Mapped[int] = mapped_column(Integer, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True),
        server_default=text("now()"),
        nullable=False,
    )

    __table_args__ = (
        CheckConstraint(
            "t_start_ms >= 0 AND t_end_ms > t_start_ms",
            name="ck_highlight_transcript_anchors_time_offsets_valid",
        ),
        CheckConstraint(
            "start_offset >= 0 AND end_offset > start_offset",
            name="ck_highlight_transcript_anchors_text_offsets_valid",
        ),
        Index("ix_highlight_transcript_anchors_version", "transcript_version_id"),
    )

    highlight: Mapped["Highlight"] = relationship("Highlight", back_populates="transcript_anchor")
    transcript_version: Mapped["PodcastTranscriptVersion"] = relationship(
        "PodcastTranscriptVersion"
    )
    transcript_segment: Mapped["PodcastTranscriptSegment | None"] = relationship(
        "PodcastTranscriptSegment"
    )


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
    )

    media: Mapped["Media"] = relationship("Media", back_populates="pdf_page_text_spans")


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
    title: Mapped[str] = mapped_column(Text, nullable=False, server_default="Chat")
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
        CheckConstraint(
            "length(btrim(title)) > 0",
            name="ck_conversations_title_not_blank",
        ),
        CheckConstraint(
            "char_length(title) <= 120",
            name="ck_conversations_title_max_length",
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
    context_items: Mapped[list[dict]] = mapped_column(
        JSONB,
        nullable=False,
        server_default=text("'[]'::jsonb"),
    )
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
    provider_request_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    prompt_version: Mapped[str] = mapped_column(Text, nullable=False)
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

    Created when an invite is accepted.  A worker picks up pending jobs and
    materializes closure edges + default library_media rows.
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
    """Persisted TOC snapshot for EPUB media.

    Immutable after media reaches ready_for_reading (except full rebuild on retry).
    Node ordering is deterministic via order_key (dddd(.dddd)* format).
    """

    __tablename__ = "epub_toc_nodes"

    media_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("media.id", ondelete="CASCADE"),
        nullable=False,
        primary_key=True,
    )
    node_id: Mapped[str] = mapped_column(Text, nullable=False, primary_key=True)
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
    )

    # Relationships
    media: Mapped["Media"] = relationship("Media")


class EpubNavLocation(Base):
    """Canonical EPUB navigation location targets.

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
            "source IN ('toc', 'fragment_fallback')",
            name="ck_epub_nav_locations_source_valid",
        ),
        UniqueConstraint("media_id", "ordinal", name="uix_epub_nav_locations_media_ordinal"),
        UniqueConstraint("media_id", "source_node_id", name="uix_epub_nav_locations_media_source"),
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


class ReaderMediaState(Base):
    """Per user + media reader resume state."""

    __tablename__ = "reader_media_state"

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
    locator_kind: Mapped[str | None] = mapped_column(Text, nullable=True)
    fragment_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("fragments.id", ondelete="SET NULL"),
        nullable=True,
    )
    offset: Mapped[int | None] = mapped_column(Integer, nullable=True)
    section_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    page: Mapped[int | None] = mapped_column(Integer, nullable=True)
    zoom: Mapped[float | None] = mapped_column(Numeric(5, 2), nullable=True)
    updated_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True),
        server_default=text("now()"),
        nullable=False,
    )

    __table_args__ = (
        CheckConstraint(
            "locator_kind IS NULL OR locator_kind IN ('fragment_offset', 'epub_section', 'pdf_page')",
            name="ck_reader_media_state_locator_kind",
        ),
        CheckConstraint(
            '"offset" IS NULL OR "offset" >= 0',
            name="ck_reader_media_state_offset",
        ),
        CheckConstraint(
            "page IS NULL OR page >= 1",
            name="ck_reader_media_state_page",
        ),
        CheckConstraint(
            "zoom IS NULL OR (zoom BETWEEN 0.25 AND 4.0)",
            name="ck_reader_media_state_zoom",
        ),
    )

    # Relationships
    user: Mapped["User"] = relationship("User")
    media: Mapped["Media"] = relationship("Media")
