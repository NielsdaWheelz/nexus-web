"""SQLAlchemy ORM models for Nexus.

The mapped classes the code queries through the ORM, in SQLAlchemy 2.x
declarative form. The schema of record is the live database plus the
hand-written Alembic migrations: constraints and indexes are not mirrored here.
"""

from datetime import date, datetime
from decimal import Decimal
from enum import Enum as PyEnum
from uuid import UUID

from sqlalchemy import (
    BigInteger,
    Boolean,
    Date,
    Enum,
    Float,
    ForeignKey,
    Integer,
    LargeBinary,
    Numeric,
    SmallInteger,
    Text,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB, TIMESTAMP
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship

from nexus.schemas.publication_dates import PublicationDate


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
        failed: Terminal failure recorded
    """

    pending = "pending"
    extracting = "extracting"
    ready_for_reading = "ready_for_reading"
    failed = "failed"


class FailureStage(str, PyEnum):
    """Stage at which processing failed.

    Used to determine reset behavior on retry. `metadata` is a soft warning
    set by enrich_metadata; it coexists with readable media
    rather than implying a terminal failure.
    """

    upload = "upload"
    extract = "extract"
    transcribe = "transcribe"
    embed = "embed"
    metadata = "metadata"
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


class MediaSourceAttemptStatus(str, PyEnum):
    """Durable source-acquisition attempt state."""

    accepted = "accepted"
    queued = "queued"
    running = "running"
    succeeded = "succeeded"
    failed = "failed"
    superseded = "superseded"


class SemanticStatus(str, PyEnum):
    """Semantic index readiness state for transcript chunks."""

    none = "none"
    pending = "pending"
    ready = "ready"
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
    calendar_time_zone: Mapped[str] = mapped_column(
        Text,
        nullable=False,
        server_default="UTC",
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


class ViewerCollectionRevision(Base):
    """Durable optimistic revision for one viewer collection family."""

    __tablename__ = "viewer_collection_revisions"

    viewer_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("users.id"),
        primary_key=True,
    )
    family: Mapped[str] = mapped_column(Text, primary_key=True)
    revision: Mapped[int] = mapped_column(BigInteger, nullable=False)


class Page(Base):
    """Title-only page resource."""

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


class DailyPageBinding(Base):
    """Assign one account-local date to one ordinary Page."""

    __tablename__ = "daily_page_bindings"

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


class DawnWrite(Base):
    """Current-only machine-generated morning block for one user + local date."""

    __tablename__ = "dawn_writes"

    id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()")
    )
    user_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True), ForeignKey("users.id"), nullable=False
    )
    local_date: Mapped[date] = mapped_column(Date, nullable=False)
    body_md: Mapped[str] = mapped_column(Text, nullable=False)
    generated_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True), server_default=text("now()"), nullable=False
    )
    dismissed_at: Mapped[datetime | None] = mapped_column(TIMESTAMP(timezone=True), nullable=True)


class NoteBlock(Base):
    """Body-only note resource."""

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
    body_pm_json: Mapped[dict[str, object]] = mapped_column(JSONB, nullable=False)
    body_text: Mapped[str] = mapped_column(Text, nullable=False)
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


class ResourceVersion(Base):
    """Service-owned concurrency version for one resource lane."""

    __tablename__ = "resource_versions"

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
    resource_scheme: Mapped[str] = mapped_column(Text, nullable=False)
    resource_id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), nullable=False)
    lane: Mapped[str] = mapped_column(Text, nullable=False)
    version: Mapped[int] = mapped_column(Integer, nullable=False, server_default="1")
    content_hash: Mapped[str | None] = mapped_column(Text, nullable=True)
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


class ResourceMutation(Base):
    """Generic idempotency ledger for resource mutations."""

    __tablename__ = "resource_mutations"

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
    mutation_scope: Mapped[str] = mapped_column(Text, nullable=False)
    client_mutation_id: Mapped[str] = mapped_column(Text, nullable=False)
    request_hash: Mapped[str] = mapped_column(Text, nullable=False)
    changed_lanes: Mapped[dict[str, object]] = mapped_column(JSONB, nullable=False)
    response_json: Mapped[dict[str, object]] = mapped_column(JSONB, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True),
        server_default=text("now()"),
        nullable=False,
    )


class ResourceViewState(Base):
    """Surface-specific view state for resource occurrences."""

    __tablename__ = "resource_view_states"

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
    surface_scheme: Mapped[str] = mapped_column(Text, nullable=False)
    surface_id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), nullable=False)
    edge_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("resource_edges.id"),
        nullable=True,
    )
    target_scheme: Mapped[str | None] = mapped_column(Text, nullable=True)
    target_id: Mapped[UUID | None] = mapped_column(PG_UUID(as_uuid=True), nullable=True)
    state: Mapped[dict[str, object]] = mapped_column(JSONB, nullable=False)
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


class ResourceEdge(Base):
    """One directed connection between two ResourceRefs in the provenance graph."""

    __tablename__ = "resource_edges"

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
    kind: Mapped[str] = mapped_column(Text, nullable=False)
    origin: Mapped[str] = mapped_column(Text, nullable=False)
    # Endpoints are polymorphic (scheme + id): deliberately no FKs; cleanup is
    # the graph service's job (database.md: explicit cleanup, no cascades).
    source_scheme: Mapped[str] = mapped_column(Text, nullable=False)
    source_id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), nullable=False)
    target_scheme: Mapped[str] = mapped_column(Text, nullable=False)
    target_id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), nullable=False)
    source_order_key: Mapped[str | None] = mapped_column(Text, nullable=True)
    target_order_key: Mapped[str | None] = mapped_column(Text, nullable=True)
    ordinal: Mapped[int | None] = mapped_column(Integer, nullable=True)
    # none_as_null: a bare edge's None snapshot must persist as SQL NULL, not the
    # JSON 'null' scalar, or it fails ck_resource_edges_snapshot_object (which
    # requires SQL NULL or a jsonb object).
    snapshot: Mapped[dict[str, object] | None] = mapped_column(
        JSONB(none_as_null=True), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True),
        server_default=text("now()"),
        nullable=False,
    )


class ResourceExternalSnapshot(Base):
    """Stable citation target for a public web result or other non-local resource."""

    __tablename__ = "resource_external_snapshots"

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
    provider: Mapped[str] = mapped_column(Text, nullable=False)
    url: Mapped[str] = mapped_column(Text, nullable=False)
    title: Mapped[str] = mapped_column(Text, nullable=False)
    snippet: Mapped[str] = mapped_column(Text, nullable=False)
    source_snapshot: Mapped[dict[str, object]] = mapped_column(JSONB, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True),
        server_default=text("now()"),
        nullable=False,
    )


class PassageAnchor(Base):
    """User-owned durable passage identity within one owner (media or
    note_block), materialized when a Link/stance targets a derived passage
    (universal-link-authoring-hard-cutover.md, Passage Anchor). Owner, version,
    normalized quote, and key are immutable; only the selector's locator_hint
    is replaceable. ``id`` is application-generated. ``owner_id`` is
    polymorphic and deliberately has no FK; owner visibility and explicit
    owner cleanup replace it. Shape is service-validated, not a CHECK/trigger.
    """

    __tablename__ = "passage_anchors"

    id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), primary_key=True)
    user_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("users.id", name="fk_passage_anchors_user"),
        nullable=False,
    )
    owner_scheme: Mapped[str] = mapped_column(Text, nullable=False)
    owner_id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), nullable=False)
    selector_version: Mapped[int] = mapped_column(SmallInteger, nullable=False)
    # sha256 hex of the canonical normalized quote {exact, prefix, suffix}.
    anchor_key: Mapped[str] = mapped_column(Text, nullable=False)
    # Quote identity plus non-identity locator_hint.
    selector: Mapped[dict[str, object]] = mapped_column(JSONB, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True),
        server_default=text("now()"),
        nullable=False,
    )


class SynapseSuppression(Base):
    """A dismissed synapse pair the resonance engine must never re-propose.

    Stored as-dismissed; the miner checks both directions at read time
    (service-level undirectedness). Endpoints are polymorphic refs like
    ResourceEdge: no endpoint FKs; rows are permanent — harmless after
    endpoint deletion (single-user scale).
    """

    __tablename__ = "synapse_suppressions"

    user_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("users.id"),
        primary_key=True,
    )
    source_scheme: Mapped[str] = mapped_column(Text, primary_key=True)
    source_id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), primary_key=True)
    target_scheme: Mapped[str] = mapped_column(Text, primary_key=True)
    target_id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), primary_key=True)
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True),
        server_default=text("now()"),
        nullable=False,
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
    # System-owned identity for non-user-created libraries (e.g. 'oracle_corpus').
    # NULL for ordinary user libraries; protects rename/delete/share/entry edits.
    system_key: Mapped[str | None] = mapped_column(Text, nullable=True)
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

    # Relationships
    owner: Mapped["User"] = relationship("User", back_populates="libraries")
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

    # Relationships
    library: Mapped["Library"] = relationship("Library")
    user: Mapped["User"] = relationship("User")


class MediaUploadSession(Base):
    """Viewer-owned durable intent for one direct PDF/EPUB upload."""

    __tablename__ = "media_upload_sessions"

    id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), primary_key=True)
    created_by_user_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("users.id", name="fk_media_upload_sessions_created_by_user"),
        nullable=False,
    )
    candidate_media_id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), nullable=False)
    kind: Mapped[str] = mapped_column(Text, nullable=False)
    filename: Mapped[str] = mapped_column(Text, nullable=False)
    content_type: Mapped[str] = mapped_column(Text, nullable=False)
    expected_size_bytes: Mapped[int] = mapped_column(BigInteger, nullable=False)
    idempotency_key: Mapped[str] = mapped_column(Text, nullable=False)
    request_id: Mapped[str] = mapped_column(Text, nullable=False)
    upload_generation: Mapped[int] = mapped_column(BigInteger, nullable=False)
    upload_url_expires_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True), nullable=False
    )
    verification_token: Mapped[UUID | None] = mapped_column(PG_UUID(as_uuid=True), nullable=True)
    verification_generation: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    verification_expires_at: Mapped[datetime | None] = mapped_column(
        TIMESTAMP(timezone=True), nullable=True
    )
    transport_failure_kind: Mapped[str | None] = mapped_column(Text, nullable=True)
    transport_http_status: Mapped[int | None] = mapped_column(Integer, nullable=True)
    transport_failed_at: Mapped[datetime | None] = mapped_column(
        TIMESTAMP(timezone=True), nullable=True
    )
    verification_error_code: Mapped[str | None] = mapped_column(Text, nullable=True)
    verification_failed_at: Mapped[datetime | None] = mapped_column(
        TIMESTAMP(timezone=True), nullable=True
    )
    published_media_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("media.id", name="fk_media_upload_sessions_published_media"),
        nullable=True,
    )
    published_source_attempt_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey(
            "media_source_attempts.id",
            name="fk_media_upload_sessions_published_source_attempt",
        ),
        nullable=True,
    )
    published_at: Mapped[datetime | None] = mapped_column(TIMESTAMP(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True), server_default=text("now()"), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True), server_default=text("now()"), nullable=False
    )


class MediaUploadSessionDestination(Base):
    """One normalized library destination carried by upload intent."""

    __tablename__ = "media_upload_session_destinations"

    upload_session_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey(
            "media_upload_sessions.id",
            name="fk_media_upload_session_destinations_session",
        ),
        primary_key=True,
    )
    library_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey(
            "libraries.id",
            name="fk_media_upload_session_destinations_library",
        ),
        primary_key=True,
    )
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True), server_default=text("now()"), nullable=False
    )


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

    # Processing lifecycle fields
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

    # URL and file identity fields
    requested_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    canonical_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    external_playback_url: Mapped[str | None] = mapped_column(Text, nullable=True)

    # Provider identity fields
    provider: Mapped[str | None] = mapped_column(Text, nullable=True)
    provider_id: Mapped[str | None] = mapped_column(Text, nullable=True)

    # Creator tracking
    created_by_user_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )

    # PDF text readiness fields
    plain_text: Mapped[str | None] = mapped_column(Text, nullable=True)
    page_count: Mapped[int | None] = mapped_column(Integer, nullable=True)

    # Document metadata enrichment fields
    # Bibliography dates preserve partial precision ("2023", "2023-01").
    original_published_date: Mapped[PublicationDate | None] = mapped_column(Text, nullable=True)
    edition_published_date: Mapped[PublicationDate | None] = mapped_column(Text, nullable=True)
    edition_isbn: Mapped[str | None] = mapped_column(Text, nullable=True)
    publisher: Mapped[str | None] = mapped_column(Text, nullable=True)
    language: Mapped[str | None] = mapped_column(Text, nullable=True)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    metadata_enriched_at: Mapped[datetime | None] = mapped_column(
        TIMESTAMP(timezone=True), nullable=True
    )

    # Author-pin: when true, automatic lanes never replace the media author slice
    # (including an intentionally empty one). Non-author roles stay machine-owned.
    authors_manually_managed: Mapped[bool] = mapped_column(
        Boolean,
        nullable=False,
        server_default=text("false"),
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

    # Relationships
    fragments: Mapped[list["Fragment"]] = relationship(
        "Fragment", back_populates="media", cascade="all, delete-orphan"
    )
    library_entries: Mapped[list["LibraryEntry"]] = relationship(
        "LibraryEntry", back_populates="media", cascade="all, delete-orphan"
    )
    podcast_episode: Mapped["PodcastEpisode | None"] = relationship(
        "PodcastEpisode", back_populates="media", cascade="all, delete-orphan", uselist=False
    )
    transcript_state: Mapped["MediaTranscriptState | None"] = relationship(
        "MediaTranscriptState",
        back_populates="media",
        cascade="all, delete-orphan",
        uselist=False,
    )
    contributor_credits: Mapped[list["ContributorCredit"]] = relationship(
        "ContributorCredit",
        back_populates="media",
        order_by=lambda: ContributorCredit.ordinal,
    )


class MediaSourceAttempt(Base):
    """Durable record of one accepted source-ingest intent or retry."""

    __tablename__ = "media_source_attempts"

    id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        primary_key=True,
        server_default=text("gen_random_uuid()"),
    )
    media_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("media.id"),
    )
    created_by_user_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )
    source_type: Mapped[str] = mapped_column(Text, nullable=False)
    attempt_no: Mapped[int] = mapped_column(Integer, nullable=False)
    run_count: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    processing_stage: Mapped[str | None] = mapped_column(Text, nullable=True)
    progress_completed: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    progress_total: Mapped[int | None] = mapped_column(Integer, nullable=True)
    progress_unit: Mapped[str | None] = mapped_column(Text, nullable=True)
    progress_updated_at: Mapped[datetime | None] = mapped_column(
        TIMESTAMP(timezone=True), nullable=True
    )
    status: Mapped[str] = mapped_column(Text, nullable=False)
    intent_key: Mapped[str] = mapped_column(Text, nullable=False)
    idempotency_key: Mapped[str | None] = mapped_column(Text, nullable=True)
    requested_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    canonical_source_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    provider: Mapped[str | None] = mapped_column(Text, nullable=True)
    provider_target_ref: Mapped[str | None] = mapped_column(Text, nullable=True)
    source_payload: Mapped[dict[str, object]] = mapped_column(
        JSONB,
        nullable=False,
        server_default=text("'{}'::jsonb"),
    )
    request_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    job_id: Mapped[UUID | None] = mapped_column(PG_UUID(as_uuid=True), nullable=True)
    error_code: Mapped[str | None] = mapped_column(Text, nullable=True)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    retry_after_seconds: Mapped[int | None] = mapped_column(Integer, nullable=True)
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

    media: Mapped["Media"] = relationship("Media")


class MediaTeardownIntent(Base):
    """Durable claim that a media row is being torn down (lectern-player-lifecycle
    hard cutover §3.1).

    Presence excludes the media from every public visibility query and makes new
    references fail with ``E_MEDIA_DELETING``; ordinary reads still return
    non-leaking ``E_NOT_FOUND``. ``id`` is application-generated (``nexus.ids.
    new_uuid7()``), not a database default, because intent creation is the trusted
    id-generation owner in the reference-creation/teardown-claim protocol. A later
    void deletes only the exact matching intent; a committed deletion deletes the
    intent together with the media row it claimed.
    """

    __tablename__ = "media_teardown_intents"

    id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), primary_key=True)
    media_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("media.id", name="fk_media_teardown_intents_media"),
        nullable=False,
    )
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True),
        server_default=text("now()"),
        nullable=False,
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

    contributor_credits: Mapped[list["ContributorCredit"]] = relationship(
        "ContributorCredit",
        order_by=lambda: ContributorCredit.ordinal,
    )


class Contributor(Base):
    """Canonical person, organization, group, or local creator identity.

    Every final contributor is active; there is no kind/status/sort_name/
    disambiguation/merged_into. Duplicate identities are collapsed once in
    migration 0179 and never tombstoned or merged at runtime.
    """

    __tablename__ = "contributors"

    id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        primary_key=True,
        server_default=text("gen_random_uuid()"),
    )
    handle: Mapped[str] = mapped_column(Text, nullable=False)
    display_name: Mapped[str] = mapped_column(Text, nullable=False)
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

    aliases: Mapped[list["ContributorAlias"]] = relationship(
        "ContributorAlias",
        back_populates="contributor",
        order_by=lambda: [
            ContributorAlias.resolves_identity.desc(),
            ContributorAlias.alias.asc(),
        ],
    )
    credits: Mapped[list["ContributorCredit"]] = relationship(
        "ContributorCredit",
        back_populates="contributor",
        order_by=lambda: ContributorCredit.ordinal,
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
    resolves_identity: Mapped[bool] = mapped_column(Boolean, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True),
        server_default=text("now()"),
        nullable=False,
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
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True),
        server_default=text("now()"),
        nullable=False,
    )

    contributor: Mapped["Contributor"] = relationship("Contributor")


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

    # One-target, dense-ordinal, role-vocabulary, and bounded-value invariants are
    # enforced in application code (services), not CHECK constraints. Six partial
    # unique indexes in the database own per-target ordinal and (contributor, role)
    # uniqueness; the whole-operation retry owner names them (services/contributors).

    contributor: Mapped["Contributor"] = relationship("Contributor", back_populates="credits")
    media: Mapped["Media | None"] = relationship("Media", back_populates="contributor_credits")
    podcast: Mapped["Podcast | None"] = relationship(
        "Podcast",
        back_populates="contributor_credits",
    )


class MediaFile(Base):
    """Media file storage metadata (0..1 per media).

    Stores metadata about files uploaded to object storage.
    The actual file is stored outside the database.
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
    source_sha256: Mapped[str] = mapped_column(Text, nullable=False)

    # Relationship
    media: Mapped["Media"] = relationship("Media")


class ReaderPublication(Base):
    """Current document publication generation for offline fencing."""

    __tablename__ = "reader_publications"

    id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), primary_key=True)
    media_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("media.id"),
        nullable=False,
        unique=True,
    )
    generation: Mapped[int] = mapped_column(BigInteger, nullable=False)
    changed_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True),
        server_default=text("now()"),
        nullable=False,
    )


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
    t_start_ms: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    t_end_ms: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    speaker_label: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True),
        server_default=text("now()"),
        nullable=False,
    )

    # Relationships
    media: Mapped["Media"] = relationship("Media", back_populates="fragments", lazy="joined")


class DocumentEmbedArtifactState(Base):
    """Aggregate inline-embed extraction state for one current readable media artifact."""

    __tablename__ = "document_embed_artifact_states"

    id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        primary_key=True,
        server_default=text("gen_random_uuid()"),
    )
    media_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True), ForeignKey("media.id"), nullable=False
    )
    source_attempt_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True), ForeignKey("media_source_attempts.id"), nullable=True
    )
    status: Mapped[str] = mapped_column(Text, nullable=False)
    total_count: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    resolved_count: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    unsupported_count: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    failed_count: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    diagnostics: Mapped[dict[str, object]] = mapped_column(
        JSONB, nullable=False, server_default=text("'{}'::jsonb")
    )
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True), server_default=text("now()"), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True), server_default=text("now()"), nullable=False
    )


class DocumentEmbed(Base):
    """One source-authored inline embed occurrence in the current readable artifact."""

    __tablename__ = "document_embeds"

    id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        primary_key=True,
        server_default=text("gen_random_uuid()"),
    )
    media_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True), ForeignKey("media.id"), nullable=False
    )
    fragment_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True), ForeignKey("fragments.id"), nullable=True
    )
    source_attempt_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True), ForeignKey("media_source_attempts.id"), nullable=True
    )
    ordinal: Mapped[int] = mapped_column(Integer, nullable=False)
    occurrence_key: Mapped[str] = mapped_column(Text, nullable=False)
    provider: Mapped[str] = mapped_column(Text, nullable=False)
    embed_kind: Mapped[str] = mapped_column(Text, nullable=False)
    source_shape: Mapped[str] = mapped_column(Text, nullable=False)
    resolution_status: Mapped[str] = mapped_column(Text, nullable=False)
    source_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    canonical_source_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    provider_target_ref: Mapped[str | None] = mapped_column(Text, nullable=True)
    target_media_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True), ForeignKey("media.id"), nullable=True
    )
    title: Mapped[str | None] = mapped_column(Text, nullable=True)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    thumbnail_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    authored_text: Mapped[str | None] = mapped_column(Text, nullable=True)
    placeholder_text: Mapped[str] = mapped_column(Text, nullable=False)
    source_start_offset: Mapped[int | None] = mapped_column(Integer, nullable=True)
    source_end_offset: Mapped[int | None] = mapped_column(Integer, nullable=True)
    canonical_start_offset: Mapped[int | None] = mapped_column(Integer, nullable=True)
    canonical_end_offset: Mapped[int | None] = mapped_column(Integer, nullable=True)
    document_order_key: Mapped[str] = mapped_column(Text, nullable=False)
    error_code: Mapped[str | None] = mapped_column(Text, nullable=True)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    diagnostics: Mapped[dict[str, object]] = mapped_column(
        JSONB, nullable=False, server_default=text("'{}'::jsonb")
    )
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True), server_default=text("now()"), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True), server_default=text("now()"), nullable=False
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
        ForeignKey("libraries.id", ondelete="CASCADE"),
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
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True),
        server_default=text("now()"),
        nullable=False,
    )
    position: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")

    library: Mapped["Library"] = relationship("Library", back_populates="library_entries")
    media: Mapped["Media | None"] = relationship("Media", back_populates="library_entries")
    podcast: Mapped["Podcast | None"] = relationship("Podcast", back_populates="library_entries")


class SynthesisArtifact(Base):
    """Stable dossier head keyed by resource-plus-audience identity.

    One head per ``(subject_scheme, subject_id, audience_scheme, audience_id)``
    (D-2): a subject resource (or contributor) as seen by a closed
    ``AudienceScope`` — a single user or a whole library. ``subject_id`` is
    deliberately FK-less — a polymorphic subject reference; cleanup on subject
    deletion is the engine's ``on_subject_deleted`` (D-10). No domain-value DB
    checks, no polymorphic subject FK, no cascade; the head promotes at most one
    revision through the nullable ``current_revision_id`` back-pointer.
    """

    __tablename__ = "artifacts"

    id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        primary_key=True,
        server_default=text("gen_random_uuid()"),
    )
    subject_scheme: Mapped[str] = mapped_column(Text, nullable=False)
    subject_id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), nullable=False)
    audience_scheme: Mapped[str] = mapped_column(Text, nullable=False)
    audience_id: Mapped[str] = mapped_column(Text, nullable=False)
    current_revision_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
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


class ArtifactBuild(Base):
    """One dossier generation attempt against a head (D-3).

    The single durable-op / replay identity and generation-ledger
    attribution owner. Active state DERIVES from the absence of a terminal
    child (revision | failure | cancellation) — there is deliberately NO status
    column. Idempotency uniqueness lives here as ``(artifact_id,
    idempotency_key)``.
    """

    __tablename__ = "artifact_builds"

    id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        primary_key=True,
        server_default=text("gen_random_uuid()"),
    )
    artifact_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("artifacts.id"),
        nullable=False,
    )
    requester_user_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("users.id"),
        nullable=True,
    )
    instruction: Mapped[str | None] = mapped_column(Text, nullable=True)
    idempotency_key: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True),
        server_default=text("now()"),
        nullable=False,
    )


class ArtifactBuildEvent(Base):
    """One sequenced, replayable build-event (the dossier run stream, D-3).

    Build-keyed; the strict, ``extra='forbid'`` payload union lives in the
    schema layer. ``event_type`` is the five-value current-write union plus the
    migration-only ``HistoricalFailed`` replay tag; the
    ``(build_id, seq)`` unique + head-lock seq allocation prevent writer
    collisions and crash-replay duplicates.
    """

    __tablename__ = "artifact_build_events"

    id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        primary_key=True,
        server_default=text("gen_random_uuid()"),
    )
    build_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("artifact_builds.id"),
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


class ArtifactIdeaSubject(Base):
    """One user-owned exact Idea identity eligible for a Dossier head."""

    __tablename__ = "artifact_idea_subjects"

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
    idea_key: Mapped[dict[str, object]] = mapped_column(JSONB, nullable=False)
    display_title: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True),
        server_default=text("now()"),
        nullable=False,
    )


class ArtifactIdeaResolution(Base):
    """Immutable mapping from one Highlight occurrence to one Idea subject."""

    __tablename__ = "artifact_idea_resolutions"

    highlight_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("highlights.id"),
        primary_key=True,
    )
    user_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("users.id"),
        nullable=False,
    )
    idea_subject_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("artifact_idea_subjects.id"),
        nullable=False,
    )
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True),
        server_default=text("now()"),
        nullable=False,
    )


class ArtifactIdeaSeed(Base):
    """Generation provenance: one Highlight admitted to one Idea Artifact."""

    __tablename__ = "artifact_idea_seeds"

    id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        primary_key=True,
        server_default=text("gen_random_uuid()"),
    )
    artifact_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("artifacts.id"),
        nullable=False,
    )
    highlight_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("highlights.id"),
        nullable=False,
    )
    added_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True),
        server_default=text("now()"),
        nullable=False,
    )


class ArtifactLearnRequest(Base):
    """Learn-scoped replay identity and billed resolver coordination."""

    __tablename__ = "artifact_learn_requests"

    id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), primary_key=True)
    user_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("users.id"),
        nullable=False,
    )
    idempotency_key: Mapped[str] = mapped_column(Text, nullable=False)
    request_hash: Mapped[str] = mapped_column(Text, nullable=False)
    highlight_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("highlights.id"),
        nullable=False,
    )
    coordination: Mapped[dict[str, object]] = mapped_column(JSONB, nullable=False)
    resolver_lease_expires_at: Mapped[datetime | None] = mapped_column(
        TIMESTAMP(timezone=True),
        nullable=True,
    )
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True),
        server_default=text("now()"),
        nullable=False,
    )


class ArtifactLearnSuccess(Base):
    """The exact successful command outcome memoized for a Learn request."""

    __tablename__ = "artifact_learn_successes"

    request_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("artifact_learn_requests.id"),
        primary_key=True,
    )
    outcome_kind: Mapped[str] = mapped_column(Text, nullable=False)
    artifact_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("artifacts.id"),
        nullable=False,
    )
    build_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("artifact_builds.id"),
        nullable=True,
    )
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True),
        server_default=text("now()"),
        nullable=False,
    )


class ArtifactLearnFailure(Base):
    """The exact modeled terminal failure memoized for a Learn request."""

    __tablename__ = "artifact_learn_failures"

    request_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("artifact_learn_requests.id"),
        primary_key=True,
    )
    error_code: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True),
        server_default=text("now()"),
        nullable=False,
    )


# =============================================================================
# Podcasts
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

    media: Mapped["Media"] = relationship("Media", back_populates="podcast_episode")
    podcast: Mapped["Podcast"] = relationship("Podcast", back_populates="episodes")


class ConsumptionQueueItem(Base):
    """Per-user ordered consumption queue item (any media kind)."""

    __tablename__ = "consumption_queue_items"

    id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        primary_key=True,
        server_default=text("gen_random_uuid()"),
    )
    user_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("users.id", name="fk_consumption_queue_items_user"),
        nullable=False,
    )
    media_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("media.id", name="fk_consumption_queue_items_media"),
        nullable=False,
    )
    position: Mapped[int] = mapped_column(Integer, nullable=False)
    added_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True),
        server_default=text("now()"),
        nullable=False,
    )
    # Internal provenance only (agent undo/trust, auto-subscription diagnostics);
    # intentionally absent from the LecternSnapshot wire contract. The enum
    # vocabulary is owned by persistence adapters, not a database CHECK (spec
    # docs/cutovers/lectern-player-lifecycle-hard-cutover.md §4).
    source: Mapped[str] = mapped_column(Text, nullable=False, server_default="manual")

    user: Mapped["User"] = relationship("User")
    media: Mapped["Media"] = relationship("Media")


class ContentIndexState(Base):
    """Active evidence index pointer for a content owner."""

    __tablename__ = "content_index_states"

    id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        primary_key=True,
        server_default=text("gen_random_uuid()"),
    )
    owner_kind: Mapped[str] = mapped_column(Text, nullable=False)
    owner_id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), nullable=False)
    revision: Mapped[int] = mapped_column(BigInteger, nullable=False, server_default=text("0"))
    status: Mapped[str] = mapped_column(Text, nullable=False)
    status_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    active_embedding_provider: Mapped[str | None] = mapped_column(Text, nullable=True)
    active_embedding_model: Mapped[str | None] = mapped_column(Text, nullable=True)
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


class MediaSummary(Base):
    """Per-media unit head: one current summary + claim set per media (1:1)."""

    __tablename__ = "media_summaries"

    id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        primary_key=True,
        server_default=text("gen_random_uuid()"),
    )
    media_id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), ForeignKey("media.id"))
    content_fingerprint: Mapped[str] = mapped_column(Text, nullable=False)
    summary_md: Mapped[str] = mapped_column(Text, nullable=False)
    model_name: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False)
    error_code: Mapped[str | None] = mapped_column(Text, nullable=True)
    error_detail: Mapped[str | None] = mapped_column(Text, nullable=True)
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
    last_request_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    transcript_origin: Mapped[str | None] = mapped_column(Text, nullable=True)
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

    media: Mapped["Media"] = relationship("Media", back_populates="transcript_state")


# =============================================================================
# Highlights
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
        ForeignKey("users.id"),
        nullable=False,
    )

    # Canonical typed-anchor fields used by all runtime highlight reads.
    anchor_kind: Mapped[str | None] = mapped_column(Text, nullable=True)
    anchor_media_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("media.id"),
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

    # Relationships. No ORM cascade ownership: Highlight deletion is explicit
    # child-first cleanup (universal-link-authoring-hard-cutover.md, Highlight
    # Durability).
    fragment_anchor: Mapped["HighlightFragmentAnchor | None"] = relationship(
        "HighlightFragmentAnchor",
        back_populates="highlight",
        uselist=False,
    )
    pdf_anchor: Mapped["HighlightPdfAnchor | None"] = relationship(
        "HighlightPdfAnchor",
        back_populates="highlight",
        uselist=False,
    )
    pdf_quads: Mapped[list["HighlightPdfQuad"]] = relationship(
        "HighlightPdfQuad",
        back_populates="highlight",
    )


# =============================================================================
# Typed Highlight Anchor Subtypes + PDF Text Artifacts
# =============================================================================


class HighlightFragmentAnchor(Base):
    """Fragment-offset anchor subtype (1:1 with highlights).

    Stores the canonical fragment/offset data for html/epub/transcript
    highlights.
    """

    __tablename__ = "highlight_fragment_anchors"

    highlight_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("highlights.id"),
        primary_key=True,
    )
    # Disposable locator cache pointer: no FK — fragments are replaceable
    # index rows, and a stale fragment_id is an expected state resolved by
    # quote (universal-link-authoring-hard-cutover.md, Highlight Durability).
    fragment_id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), nullable=False)
    start_offset: Mapped[int] = mapped_column(Integer, nullable=False)
    end_offset: Mapped[int] = mapped_column(Integer, nullable=False)

    highlight: Mapped["Highlight"] = relationship("Highlight", back_populates="fragment_anchor")
    fragment: Mapped["Fragment | None"] = relationship(
        "Fragment",
        primaryjoin="foreign(HighlightFragmentAnchor.fragment_id) == Fragment.id",
        viewonly=True,
    )


class HighlightPdfAnchor(Base):
    """PDF geometry anchor subtype (1:1 with highlights).

    Stores page-space geometry metadata and persisted quote-match metadata
    for PDF highlights.
    """

    __tablename__ = "highlight_pdf_anchors"

    highlight_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("highlights.id"),
        primary_key=True,
    )
    media_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("media.id"),
        nullable=False,
    )
    page_number: Mapped[int] = mapped_column(Integer, nullable=False)
    sort_top: Mapped[Decimal] = mapped_column(Numeric, nullable=False)
    sort_left: Mapped[Decimal] = mapped_column(Numeric, nullable=False)
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
        ForeignKey("highlights.id"),
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

    highlight: Mapped["Highlight"] = relationship("Highlight", back_populates="pdf_quads")


class PdfPageTextSpan(Base):
    """Page-indexed offsets into media.plain_text for PDF quote matching.

    Composite PK: (media_id, page_number).
    Offsets are Unicode codepoint spans in the post-normalization plain_text.
    """

    __tablename__ = "pdf_page_text_spans"

    media_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("media.id", name="pdf_page_text_spans_media_id_fkey"),
        primary_key=True,
    )
    page_number: Mapped[int] = mapped_column(Integer, primary_key=True)
    start_offset: Mapped[int] = mapped_column(Integer, nullable=False)
    end_offset: Mapped[int] = mapped_column(Integer, nullable=False)
    page_label: Mapped[str | None] = mapped_column(Text, nullable=True)
    page_width: Mapped[float | None] = mapped_column(Float, nullable=True)
    page_height: Mapped[float | None] = mapped_column(Float, nullable=True)
    page_rotation_degrees: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True),
        server_default=text("now()"),
        nullable=False,
    )


# =============================================================================
# Chat, Conversations, and LLM Infrastructure
# =============================================================================


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

    # Relationships
    owner: Mapped["User"] = relationship("User")
    messages: Mapped[list["Message"]] = relationship(
        "Message", back_populates="conversation", cascade="all, delete-orphan"
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
    conversation: Mapped["Conversation"] = relationship("Conversation")
    library: Mapped["Library"] = relationship("Library")


class LLMCall(Base):
    """One route-neutral product generation (sole writer: ``llm_ledger``)."""

    __tablename__ = "llm_calls"

    id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        primary_key=True,
        server_default=text("gen_random_uuid()"),
    )
    owner_kind: Mapped[str] = mapped_column(Text, nullable=False)
    owner_id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), nullable=False)
    generation_seq: Mapped[int] = mapped_column(Integer, nullable=False)
    generation_spec: Mapped[dict[str, object]] = mapped_column(
        JSONB(none_as_null=True), nullable=False
    )
    generation_fingerprint: Mapped[str] = mapped_column(Text, nullable=False)
    outcome: Mapped[str | None] = mapped_column(Text, nullable=True)
    failure_code: Mapped[str | None] = mapped_column(Text, nullable=True)
    terminal: Mapped[dict[str, object] | None] = mapped_column(
        JSONB(none_as_null=True), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True),
        server_default=text("now()"),
        nullable=False,
    )
    completed_at: Mapped[datetime | None] = mapped_column(TIMESTAMP(timezone=True), nullable=True)


class LLMModelTurn(Base):
    """One independently accepted or billable model call within a generation."""

    __tablename__ = "llm_model_turns"

    id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), primary_key=True)
    generation_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("llm_calls.id"),
        nullable=False,
    )
    turn_seq: Mapped[int] = mapped_column(Integer, nullable=False)
    request_fingerprint: Mapped[str] = mapped_column(Text, nullable=False)
    route_request_identity: Mapped[dict[str, object]] = mapped_column(
        JSONB(none_as_null=True), nullable=False
    )
    terminal: Mapped[dict[str, object] | None] = mapped_column(
        JSONB(none_as_null=True), nullable=True
    )
    usage: Mapped[dict[str, object] | None] = mapped_column(JSONB(none_as_null=True), nullable=True)
    billability: Mapped[dict[str, object] | None] = mapped_column(
        JSONB(none_as_null=True), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True), server_default=text("now()"), nullable=False
    )
    dispatch_started_at: Mapped[datetime | None] = mapped_column(
        TIMESTAMP(timezone=True), nullable=True
    )
    accepted_at: Mapped[datetime | None] = mapped_column(TIMESTAMP(timezone=True), nullable=True)
    completed_at: Mapped[datetime | None] = mapped_column(TIMESTAMP(timezone=True), nullable=True)


class LLMModelTurnContinuation(Base):
    """One sealed provider continuation authorizing an exact successor turn."""

    __tablename__ = "llm_model_turn_continuations"

    id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        primary_key=True,
        server_default=text("gen_random_uuid()"),
    )
    generation_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("llm_calls.id"),
        nullable=False,
    )
    source_model_turn_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("llm_model_turns.id"),
        nullable=False,
    )
    successor_turn_seq: Mapped[int] = mapped_column(Integer, nullable=False)
    target_fingerprint: Mapped[str] = mapped_column(Text, nullable=False)
    codec_id: Mapped[str] = mapped_column(Text, nullable=False)
    policy_revision: Mapped[str] = mapped_column(Text, nullable=False)
    envelope_version: Mapped[str] = mapped_column(Text, nullable=False)
    nonce: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    ciphertext: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True), server_default=text("now()"), nullable=False
    )


class LLMToolPosition(Base):
    """One globally ordered canonical tool position within a generation."""

    __tablename__ = "llm_tool_positions"

    id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), primary_key=True)
    generation_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("llm_calls.id"),
        nullable=False,
    )
    position: Mapped[int] = mapped_column(Integer, nullable=False)
    transport_kind: Mapped[str] = mapped_column(Text, nullable=False)
    model_turn_seq: Mapped[int] = mapped_column(Integer, nullable=False)
    transport_call_id: Mapped[str] = mapped_column(Text, nullable=False)
    canonical_tool_id: Mapped[str] = mapped_column(Text, nullable=False)
    canonical_input_digest: Mapped[str] = mapped_column(Text, nullable=False)
    tool_contract_revision: Mapped[str] = mapped_column(Text, nullable=False)
    plan_revision: Mapped[str] = mapped_column(Text, nullable=False)
    binding_revision: Mapped[str] = mapped_column(Text, nullable=False)
    scope_digest: Mapped[str] = mapped_column(Text, nullable=False)
    budget_digest: Mapped[str] = mapped_column(Text, nullable=False)
    reservation: Mapped[dict[str, object] | None] = mapped_column(
        JSONB(none_as_null=True), nullable=True
    )
    dispatch_claim: Mapped[dict[str, object] | None] = mapped_column(
        JSONB(none_as_null=True), nullable=True
    )
    abandoned_attempts: Mapped[int] = mapped_column(Integer, nullable=False)
    result_evidence: Mapped[dict[str, object] | None] = mapped_column(
        JSONB(none_as_null=True), nullable=True
    )
    effect_identity: Mapped[dict[str, object] | None] = mapped_column(
        JSONB(none_as_null=True), nullable=True
    )
    settlement: Mapped[dict[str, object] | None] = mapped_column(
        JSONB(none_as_null=True), nullable=True
    )
    replay_status: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True), server_default=text("now()"), nullable=False
    )
    completed_at: Mapped[datetime | None] = mapped_column(TIMESTAMP(timezone=True), nullable=True)


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
    message_document: Mapped[dict[str, object]] = mapped_column(
        JSONB,
        nullable=False,
        server_default=text("""'{"type":"message_document","blocks":[]}'::jsonb"""),
    )
    # The immutable per-message reader-quote snapshot (quote-to-chat cutover).
    # Present only on a quoted user message; none_as_null keeps DB NULL (Absent)
    # distinct from a JSON `null` value, which strict decode rejects.
    reader_selection_snapshot: Mapped[dict[str, object] | None] = mapped_column(
        JSONB(none_as_null=True), nullable=True
    )
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default="complete")
    parent_message_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("messages.id"),
        nullable=True,
    )
    branch_root_message_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("messages.id"),
        nullable=True,
    )
    branch_anchor_kind: Mapped[str] = mapped_column(
        Text,
        nullable=False,
        server_default="none",
    )
    branch_anchor: Mapped[dict[str, object]] = mapped_column(
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

    # Relationships
    conversation: Mapped["Conversation"] = relationship("Conversation", back_populates="messages")


class ConversationActivePath(Base):
    """Viewer-local selected branch leaf for a conversation."""

    __tablename__ = "conversation_active_paths"

    id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        primary_key=True,
        server_default=text("gen_random_uuid()"),
    )
    conversation_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("conversations.id"),
        nullable=False,
    )
    viewer_user_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("users.id"),
        nullable=False,
    )
    active_leaf_message_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("messages.id"),
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

    conversation: Mapped["Conversation"] = relationship("Conversation")
    viewer: Mapped["User"] = relationship("User")


class ConversationBranch(Base):
    """Metadata for a user child that starts a branch option."""

    __tablename__ = "conversation_branches"

    id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        primary_key=True,
        server_default=text("gen_random_uuid()"),
    )
    conversation_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("conversations.id"),
        nullable=False,
    )
    branch_user_message_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("messages.id"),
        nullable=False,
    )
    title: Mapped[str | None] = mapped_column(Text, nullable=True)
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

    conversation: Mapped["Conversation"] = relationship("Conversation")


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
        ForeignKey("conversations.id"),
        nullable=False,
    )
    user_message_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("messages.id"),
        nullable=False,
    )
    assistant_message_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("messages.id"),
        nullable=False,
    )
    canonical_tool_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    record_kind: Mapped[str] = mapped_column(Text, nullable=False)
    provider_wire_name: Mapped[str | None] = mapped_column(Text, nullable=True)
    canonical_input_sha256: Mapped[str | None] = mapped_column(Text, nullable=True)
    tool_contract_revision: Mapped[str | None] = mapped_column(Text, nullable=True)
    binding_policy_revision: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Current canonical executions point at the route-neutral generation
    # position that owns ordering, replay, and any stable write-effect identity.
    # Rejected provider calls have no canonical position and remain NULL.
    tool_position_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("llm_tool_positions.id"),
        nullable=True,
    )
    tool_call_index: Mapped[int] = mapped_column(Integer, nullable=False)
    search_query_fingerprint: Mapped[str | None] = mapped_column(Text, nullable=True)
    scope: Mapped[str] = mapped_column(Text, nullable=False, server_default="all")
    requested_types: Mapped[list[str]] = mapped_column(
        JSONB,
        nullable=False,
        server_default=text("'[]'::jsonb"),
    )
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
    # Undo lifecycle state for assistant write tool calls (amanuensis §5.6, D-3):
    # a real column, not a result_refs field, because the per-run write cap counts
    # rows WHERE reverted_at IS NULL (D-6) and undo must be queryable.
    reverted_at: Mapped[datetime | None] = mapped_column(TIMESTAMP(timezone=True), nullable=True)
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

    conversation: Mapped["Conversation"] = relationship("Conversation")
    user_message: Mapped["Message"] = relationship("Message", foreign_keys=[user_message_id])
    assistant_message: Mapped["Message"] = relationship(
        "Message",
        foreign_keys=[assistant_message_id],
    )


class AssistantWriteAuthorship(Base):
    """Durable machine authorship for one concrete additive-write target.

    The generation position is the provenance owner and deliberately outlives
    the optional Chat projection.  ``target_kind`` + ``target_id`` is a
    validated polymorphic pointer rather than a foreign key: Undo or a later
    user deletion may remove the target while its authorship fact remains.
    """

    __tablename__ = "assistant_write_authorships"

    id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), primary_key=True)
    tool_position_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("llm_tool_positions.id"),
        nullable=False,
    )
    target_kind: Mapped[str] = mapped_column(Text, nullable=False)
    target_id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True),
        server_default=text("now()"),
        nullable=False,
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
        ForeignKey("message_tool_calls.id"),
        nullable=False,
    )
    ordinal: Mapped[int] = mapped_column(Integer, nullable=False)
    result_type: Mapped[str] = mapped_column(Text, nullable=False)
    source_id: Mapped[str] = mapped_column(Text, nullable=False)
    media_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("media.id"),
        nullable=True,
    )
    evidence_span_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
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
    citation_candidate_ordinal: Mapped[int | None] = mapped_column(Integer, nullable=True)
    # One-way provenance pointer to the citation resource_edge, set when this
    # result is cited. Deliberately no FK: edge and telemetry rows are cleaned
    # up by different owners (resource provenance graph D6).
    cited_edge_id: Mapped[UUID | None] = mapped_column(PG_UUID(as_uuid=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True),
        server_default=text("now()"),
        nullable=False,
    )

    media: Mapped["Media | None"] = relationship("Media")


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
        ForeignKey("users.id"),
        nullable=False,
    )
    conversation_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("conversations.id"),
        nullable=False,
    )
    user_message_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("messages.id"),
        nullable=False,
    )
    assistant_message_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("messages.id"),
        nullable=False,
    )
    generation_spec: Mapped[dict[str, object]] = mapped_column(
        JSONB(none_as_null=True),
        nullable=False,
    )
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default="queued")
    cancel_requested_at: Mapped[datetime | None] = mapped_column(
        TIMESTAMP(timezone=True),
        nullable=True,
    )
    started_at: Mapped[datetime | None] = mapped_column(TIMESTAMP(timezone=True), nullable=True)
    completed_at: Mapped[datetime | None] = mapped_column(TIMESTAMP(timezone=True), nullable=True)
    error_code: Mapped[str | None] = mapped_column(Text, nullable=True)
    support_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    publication_warning_code: Mapped[str | None] = mapped_column(Text, nullable=True)
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

    owner: Mapped["User"] = relationship("User")
    conversation: Mapped["Conversation"] = relationship("Conversation")
    user_message: Mapped["Message"] = relationship("Message", foreign_keys=[user_message_id])
    assistant_message: Mapped["Message"] = relationship(
        "Message",
        foreign_keys=[assistant_message_id],
    )
    events: Mapped[list["ChatRunEvent"]] = relationship(
        "ChatRunEvent",
        back_populates="run",
        order_by="ChatRunEvent.seq",
        cascade="all, delete-orphan",
    )


class ChatRunTurnContext(Base):
    """Durable answer-determining turn anchors for one chat run."""

    __tablename__ = "chat_run_turn_contexts"

    chat_run_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("chat_runs.id", ondelete="CASCADE"),
        primary_key=True,
    )
    requested_subject_scheme: Mapped[str | None] = mapped_column(Text, nullable=True)
    requested_subject_id: Mapped[UUID | None] = mapped_column(PG_UUID(as_uuid=True), nullable=True)
    subject_scheme: Mapped[str | None] = mapped_column(Text, nullable=True)
    subject_id: Mapped[UUID | None] = mapped_column(PG_UUID(as_uuid=True), nullable=True)
    subject_context_edge_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("resource_edges.id", ondelete="SET NULL"),
        nullable=True,
    )
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True),
        server_default=text("now()"),
        nullable=False,
    )

    chat_run: Mapped["ChatRun"] = relationship("ChatRun")


class ChatPromptAssembly(Base):
    """Prompt assembly ledger persisted before generation execution."""

    __tablename__ = "chat_prompt_assemblies"

    id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        primary_key=True,
        server_default=text("gen_random_uuid()"),
    )
    chat_run_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("chat_runs.id"),
        nullable=False,
    )
    conversation_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("conversations.id"),
        nullable=False,
    )
    assistant_message_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("messages.id"),
        nullable=False,
    )
    prompt_block_manifest: Mapped[dict[str, object]] = mapped_column(
        JSONB,
        nullable=False,
        server_default=text("'{}'::jsonb"),
    )
    generation_intent: Mapped[dict[str, object]] = mapped_column(
        JSONB(none_as_null=True),
        nullable=False,
    )
    generation_intent_digest: Mapped[str] = mapped_column(Text, nullable=False)
    max_context_tokens: Mapped[int] = mapped_column(Integer, nullable=False)
    reserved_output_tokens: Mapped[int] = mapped_column(Integer, nullable=False)
    input_budget_tokens: Mapped[int] = mapped_column(Integer, nullable=False)
    estimated_input_tokens: Mapped[int] = mapped_column(Integer, nullable=False)
    included_message_ids: Mapped[list[str]] = mapped_column(
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

    chat_run: Mapped["ChatRun"] = relationship("ChatRun")
    conversation: Mapped["Conversation"] = relationship("Conversation")
    assistant_message: Mapped["Message"] = relationship("Message")


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
        ForeignKey("chat_runs.id"),
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

    run: Mapped["ChatRun"] = relationship("ChatRun", back_populates="events")


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


class BillingEntitlementOverride(Base):
    """Internal unpaid entitlement grant for one user."""

    __tablename__ = "billing_entitlement_overrides"

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
    plan_tier: Mapped[str] = mapped_column(Text, nullable=False)
    transcription_quota_mode: Mapped[str] = mapped_column(
        Text,
        nullable=False,
        server_default="plan",
    )
    transcription_minutes_limit_monthly: Mapped[int | None] = mapped_column(
        Integer,
        nullable=True,
    )
    expires_at: Mapped[datetime | None] = mapped_column(TIMESTAMP(timezone=True), nullable=True)
    revoked_at: Mapped[datetime | None] = mapped_column(TIMESTAMP(timezone=True), nullable=True)
    reason: Mapped[str] = mapped_column(Text, nullable=False)
    created_by_user_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("users.id"),
        nullable=True,
    )
    updated_by_user_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("users.id"),
        nullable=True,
    )
    created_by_label: Mapped[str | None] = mapped_column(Text, nullable=True)
    updated_by_label: Mapped[str | None] = mapped_column(Text, nullable=True)
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

    user: Mapped["User"] = relationship("User")


class AuthHandoffCode(Base):
    """AuthHandoffCode model - single-use code that hands a Supabase session into the Android WebView."""

    __tablename__ = "auth_handoff_codes"

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
    code_hash: Mapped[str] = mapped_column(Text, nullable=False)
    challenge: Mapped[str] = mapped_column(Text, nullable=False)
    access_token: Mapped[str] = mapped_column(Text, nullable=False)
    refresh_token: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True),
        server_default=text("now()"),
        nullable=False,
    )
    expires_at: Mapped[datetime] = mapped_column(TIMESTAMP(timezone=True), nullable=False)

    user: Mapped["User"] = relationship("User")


# =============================================================================
# Library Sharing
# =============================================================================


class ResourceGrant(Base):
    """One active user or bearer-link path to an exact ResourceRef subject.

    Branch consistency is owned by ``services.resource_grants``. The database
    stores the two nullable audience shapes without a business CHECK so trusted
    row-shape drift defects in the typed owner rather than becoming a second
    policy implementation.
    """

    __tablename__ = "resource_grants"

    id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), primary_key=True)
    subject_scheme: Mapped[str] = mapped_column(Text, nullable=False)
    subject_id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), nullable=False)
    created_by_user_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("users.id"),
        nullable=False,
    )
    grantee_user_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("users.id"),
        nullable=True,
    )
    share_token: Mapped[str | None] = mapped_column(Text, nullable=True)
    share_token_hash: Mapped[bytes | None] = mapped_column(LargeBinary, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True),
        server_default=text("now()"),
        nullable=False,
    )


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


# =============================================================================
# EPUB
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
    target_offset: Mapped[int | None] = mapped_column(Integer, nullable=True)
    depth: Mapped[int] = mapped_column(Integer, nullable=False)
    order_key: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True),
        server_default=text("now()"),
        nullable=False,
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
    parent_section_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    label: Mapped[str] = mapped_column(Text, nullable=False)
    fragment_idx: Mapped[int] = mapped_column(Integer, nullable=False)
    href_path: Mapped[str | None] = mapped_column(Text, nullable=True)
    href_fragment: Mapped[str | None] = mapped_column(Text, nullable=True)
    start_offset: Mapped[int] = mapped_column(Integer, nullable=False)
    end_fragment_idx: Mapped[int | None] = mapped_column(Integer, nullable=True)
    end_offset: Mapped[int | None] = mapped_column(Integer, nullable=True)
    source: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True),
        server_default=text("now()"),
        nullable=False,
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
    package_href: Mapped[str] = mapped_column(Text, nullable=False)
    asset_key: Mapped[str] = mapped_column(Text, nullable=False)
    storage_path: Mapped[str] = mapped_column(Text, nullable=False)
    content_type: Mapped[str] = mapped_column(Text, nullable=False)
    size_bytes: Mapped[int] = mapped_column(BigInteger, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True),
        server_default=text("now()"),
        nullable=False,
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
    theme: Mapped[str] = mapped_column(Text, nullable=False)
    font_size_px: Mapped[int] = mapped_column(Integer, nullable=False)
    line_height: Mapped[float] = mapped_column(Numeric(3, 2), nullable=False)
    font_family: Mapped[str] = mapped_column(Text, nullable=False)
    column_width_ch: Mapped[int] = mapped_column(Integer, nullable=False)
    focus_mode: Mapped[str] = mapped_column(Text, nullable=False)
    hyphenation: Mapped[str] = mapped_column(Text, nullable=False)
    # Creation metadata only; never in the DTO. The service's
    # READER_PROFILE_DEFAULTS is the one preference-default authority.
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True),
        server_default=text("now()"),
        nullable=False,
    )

    # Relationships
    user: Mapped["User"] = relationship("User")


class NexusUsage(Base):
    """Per-user Nexus usage history."""

    __tablename__ = "nexus_usages"

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
    target_href: Mapped[str] = mapped_column(Text, nullable=False)
    label_snapshot: Mapped[str] = mapped_column(Text, nullable=False)
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

    user: Mapped["User"] = relationship("User")


class WorkspaceSession(Base):
    """Per user + device persisted workspace pane set."""

    __tablename__ = "workspace_sessions"

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
    device_id: Mapped[str] = mapped_column(Text, nullable=False)
    state: Mapped[dict[str, object]] = mapped_column(JSONB, nullable=False)
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


class OracleCorpusSource(Base):
    """Maps one curated Oracle corpus work to a real media row + library entry.

    The media row is the authoritative source text owner; corpus text, chunks,
    and embeddings live in the shared content-index substrate, not here.
    """

    __tablename__ = "oracle_corpus_sources"

    id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        primary_key=True,
        server_default=text("gen_random_uuid()"),
    )
    corpus_key: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("'oracle'"))
    work_key: Mapped[str] = mapped_column(Text, nullable=False)
    library_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True), ForeignKey("libraries.id"), nullable=False
    )
    media_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True), ForeignKey("media.id"), nullable=False
    )
    title: Mapped[str] = mapped_column(Text, nullable=False)
    author_text: Mapped[str] = mapped_column(Text, nullable=False)
    source_repository: Mapped[str] = mapped_column(Text, nullable=False)
    source_url: Mapped[str] = mapped_column(Text, nullable=False)
    source_download_url: Mapped[str] = mapped_column(Text, nullable=False)
    source_media_kind: Mapped[str] = mapped_column(Text, nullable=False)
    display_order: Mapped[int] = mapped_column(Integer, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True), server_default=text("now()"), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True), server_default=text("now()"), nullable=False
    )


class OraclePassageAnchor(Base):
    """Stable Oracle curation/concordance identity that resolves to current media evidence.

    ``current_evidence_span_id`` / ``current_content_chunk_id`` are cache pointers
    into the current index generation and deliberately carry no FK — evidence/chunk
    rows are regenerated on reindex and must not block content-index deletion.
    """

    __tablename__ = "oracle_passage_anchors"

    id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        primary_key=True,
        server_default=text("gen_random_uuid()"),
    )
    corpus_source_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True), ForeignKey("oracle_corpus_sources.id"), nullable=False
    )
    passage_key: Mapped[str] = mapped_column(Text, nullable=False)
    display_label: Mapped[str] = mapped_column(Text, nullable=False)
    selector: Mapped[dict[str, object]] = mapped_column(JSONB, nullable=False)
    tags: Mapped[list[str]] = mapped_column(
        JSONB, nullable=False, server_default=text("'[]'::jsonb")
    )
    phase_hints: Mapped[list[str]] = mapped_column(
        JSONB, nullable=False, server_default=text("'[]'::jsonb")
    )
    current_evidence_span_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True), nullable=True
    )
    current_content_chunk_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True), nullable=True
    )
    resolution_status: Mapped[str] = mapped_column(
        Text, nullable=False, server_default=text("'pending'")
    )
    resolution_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    resolved_at: Mapped[datetime | None] = mapped_column(TIMESTAMP(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True), server_default=text("now()"), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True), server_default=text("now()"), nullable=False
    )

    source: Mapped["OracleCorpusSource"] = relationship("OracleCorpusSource")


class OraclePlate(Base):
    """Curated public-domain image plate, a public owned asset under oracle/plates/.

    Plate selection is deterministic over tags/phase hints (no text embeddings).
    """

    __tablename__ = "oracle_plates"

    id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        primary_key=True,
        server_default=text("gen_random_uuid()"),
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
    storage_key: Mapped[str] = mapped_column(Text, nullable=False)
    content_type: Mapped[str] = mapped_column(Text, nullable=False)
    byte_size: Mapped[int] = mapped_column(BigInteger, nullable=False)
    tags: Mapped[list[str]] = mapped_column(
        JSONB, nullable=False, server_default=text("'[]'::jsonb")
    )
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True),
        server_default=text("now()"),
        nullable=False,
    )


class OracleCorpusPublication(Base):
    """Singleton marker whose presence publishes one exact Oracle corpus."""

    __tablename__ = "oracle_corpus_publications"

    corpus_key: Mapped[str] = mapped_column(Text, primary_key=True)
    manifest_digest: Mapped[str] = mapped_column(Text, nullable=False)
    embedding_provider: Mapped[str] = mapped_column(Text, nullable=False)
    embedding_model: Mapped[str] = mapped_column(Text, nullable=False)


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
    folio_number: Mapped[int] = mapped_column(Integer, nullable=False)
    folio_motto: Mapped[str | None] = mapped_column(Text, nullable=True)
    folio_motto_gloss: Mapped[str | None] = mapped_column(Text, nullable=True)
    folio_theme: Mapped[str | None] = mapped_column(Text, nullable=True)
    argument_text: Mapped[str | None] = mapped_column(Text, nullable=True)
    question_text: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("'pending'"))
    image_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("oracle_plates.id"),
        nullable=True,
    )
    interpretation_text: Mapped[str | None] = mapped_column(Text, nullable=True)
    idempotency_key: Mapped[str | None] = mapped_column(Text, nullable=True)
    error_code: Mapped[str | None] = mapped_column(Text, nullable=True)
    error_detail: Mapped[str | None] = mapped_column(Text, nullable=True)
    started_at: Mapped[datetime | None] = mapped_column(TIMESTAMP(timezone=True), nullable=True)
    completed_at: Mapped[datetime | None] = mapped_column(TIMESTAMP(timezone=True), nullable=True)
    failed_at: Mapped[datetime | None] = mapped_column(TIMESTAMP(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True),
        server_default=text("now()"),
        nullable=False,
    )

    image: Mapped["OraclePlate | None"] = relationship("OraclePlate")


class OracleReadingFolio(Base):
    """Generated folio content for one reading phase, referencing its citation edge."""

    __tablename__ = "oracle_reading_folios"

    reading_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("oracle_readings.id"),
        primary_key=True,
    )
    phase: Mapped[str] = mapped_column(Text, primary_key=True)
    edge_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("resource_edges.id"),
        nullable=False,
    )
    source_kind: Mapped[str] = mapped_column(Text, nullable=False)
    locator_label: Mapped[str] = mapped_column(Text, nullable=False)
    attribution_text: Mapped[str] = mapped_column(Text, nullable=False)
    marginalia_text: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True),
        server_default=text("now()"),
        nullable=False,
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
