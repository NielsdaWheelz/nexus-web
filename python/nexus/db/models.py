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
    ForeignKeyConstraint,
    Index,
    Integer,
    Numeric,
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


class MembershipRole(str, PyEnum):
    """Roles a user can have in a library."""

    admin = "admin"
    member = "member"


# Library sharing enums


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
    """Title-only page resource."""

    __tablename__ = "pages"

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

    __table_args__ = (
        CheckConstraint(
            "jsonb_typeof(body_pm_json) = 'object'", name="ck_note_blocks_pm_json_object"
        ),
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

    __table_args__ = (
        CheckConstraint(
            """
            resource_scheme IN (
                'media', 'library', 'evidence_span', 'content_chunk',
                'highlight', 'page', 'note_block', 'fragment',
                'conversation', 'message', 'oracle_reading',
                'oracle_passage_anchor', 'library_intelligence_artifact',
                'library_intelligence_revision',
                'external_snapshot', 'contributor', 'podcast',
                'reader_apparatus_item'
            )
            """,
            name="ck_resource_versions_resource_scheme",
        ),
        CheckConstraint(
            "lane IN ('title', 'body', 'outgoing_edges')",
            name="ck_resource_versions_lane",
        ),
        CheckConstraint("version >= 1", name="ck_resource_versions_version_positive"),
        CheckConstraint(
            "content_hash IS NULL OR char_length(content_hash) = 64",
            name="ck_resource_versions_content_hash_length",
        ),
        UniqueConstraint(
            "user_id",
            "resource_scheme",
            "resource_id",
            "lane",
            name="uix_resource_versions_lane",
        ),
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

    __table_args__ = (
        CheckConstraint(
            "char_length(mutation_scope) BETWEEN 1 AND 300",
            name="ck_resource_mutations_scope_length",
        ),
        CheckConstraint(
            "char_length(client_mutation_id) BETWEEN 1 AND 120",
            name="ck_resource_mutations_client_mutation_id_length",
        ),
        CheckConstraint(
            "char_length(request_hash) = 64",
            name="ck_resource_mutations_request_hash_length",
        ),
        CheckConstraint(
            "jsonb_typeof(changed_lanes) = 'object'",
            name="ck_resource_mutations_changed_lanes_object",
        ),
        CheckConstraint(
            "jsonb_typeof(response_json) = 'object'",
            name="ck_resource_mutations_response_json_object",
        ),
        UniqueConstraint(
            "user_id",
            "mutation_scope",
            "client_mutation_id",
            name="uix_resource_mutations_client_id",
        ),
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

    __table_args__ = (
        CheckConstraint(
            """
            surface_scheme IN (
                'media', 'library', 'evidence_span', 'content_chunk',
                'highlight', 'page', 'note_block', 'fragment',
                'conversation', 'message', 'oracle_reading',
                'oracle_passage_anchor', 'library_intelligence_artifact',
                'library_intelligence_revision',
                'external_snapshot', 'contributor', 'podcast',
                'reader_apparatus_item'
            )
            """,
            name="ck_resource_view_states_surface_scheme",
        ),
        CheckConstraint(
            """
            target_scheme IS NULL OR target_scheme IN (
                'media', 'library', 'evidence_span', 'content_chunk',
                'highlight', 'page', 'note_block', 'fragment',
                'conversation', 'message', 'oracle_reading',
                'oracle_passage_anchor', 'library_intelligence_artifact',
                'library_intelligence_revision',
                'external_snapshot', 'contributor', 'podcast',
                'reader_apparatus_item'
            )
            """,
            name="ck_resource_view_states_target_scheme",
        ),
        CheckConstraint(
            "(target_scheme IS NULL) = (target_id IS NULL)",
            name="ck_resource_view_states_target_pair",
        ),
        CheckConstraint(
            "jsonb_typeof(state) = 'object'",
            name="ck_resource_view_states_state_object",
        ),
        Index(
            "uix_resource_view_states_edge_occurrence",
            "user_id",
            "surface_scheme",
            "surface_id",
            "edge_id",
            unique=True,
            postgresql_where=text("edge_id IS NOT NULL"),
        ),
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

    __table_args__ = (
        CheckConstraint(
            "kind IN ('context', 'supports', 'contradicts')",
            name="ck_resource_edges_kind",
        ),
        CheckConstraint(
            """
            origin IN (
                'user', 'citation', 'system', 'note_body', 'highlight_note',
                'synapse'
            )
            """,
            name="ck_resource_edges_origin",
        ),
        CheckConstraint(
            """
            source_scheme IN (
                'media', 'library', 'evidence_span', 'content_chunk',
                'highlight', 'page', 'note_block', 'fragment',
                'conversation', 'message', 'oracle_reading',
                'oracle_passage_anchor', 'library_intelligence_artifact',
                'library_intelligence_revision',
                'external_snapshot', 'contributor', 'podcast',
                'reader_apparatus_item'
            )
            """,
            name="ck_resource_edges_source_scheme",
        ),
        CheckConstraint(
            """
            target_scheme IN (
                'media', 'library', 'evidence_span', 'content_chunk',
                'highlight', 'page', 'note_block', 'fragment',
                'conversation', 'message', 'oracle_reading',
                'oracle_passage_anchor', 'library_intelligence_artifact',
                'library_intelligence_revision',
                'external_snapshot', 'contributor', 'podcast',
                'reader_apparatus_item'
            )
            """,
            name="ck_resource_edges_target_scheme",
        ),
        CheckConstraint(
            "NOT (source_scheme = target_scheme AND source_id = target_id)",
            name="ck_resource_edges_no_self_edge",
        ),
        CheckConstraint(
            "source_order_key IS NULL OR char_length(source_order_key) BETWEEN 1 AND 64",
            name="ck_resource_edges_source_order_key_length",
        ),
        CheckConstraint(
            """
            source_order_key IS NULL
            OR (
                kind = 'context'
                AND origin = 'user'
                AND ordinal IS NULL
                AND snapshot IS NULL
            )
            OR (
                kind = 'context'
                AND origin IN ('citation', 'system')
                AND source_scheme = 'conversation'
                AND ordinal IS NULL
                AND snapshot IS NULL
            )
            """,
            name="ck_resource_edges_source_order_key_shape",
        ),
        CheckConstraint(
            "target_order_key IS NULL",
            name="ck_resource_edges_target_order_key_reserved",
        ),
        CheckConstraint(
            """
            origin != 'synapse'
            OR (
                snapshot IS NOT NULL
                AND snapshot ? 'excerpt'
                AND jsonb_typeof(snapshot->'excerpt') = 'string'
                AND btrim(snapshot->>'excerpt') <> ''
            )
            """,
            name="ck_resource_edges_synapse_snapshot_excerpt",
        ),
        CheckConstraint(
            """
            origin != 'citation'
            OR (
                ordinal IS NULL
                AND kind = 'context'
                AND source_scheme = 'conversation'
                AND snapshot IS NULL
            )
            OR (
                ordinal IS NOT NULL
                AND source_scheme IN (
                    'message', 'oracle_reading', 'library_intelligence_revision'
                )
            )
            """,
            name="ck_resource_edges_citation_shape",
        ),
        CheckConstraint(
            """
            origin != 'system'
            OR (
                kind = 'context'
                AND source_scheme = 'conversation'
                AND ordinal IS NULL
                AND snapshot IS NULL
            )
            """,
            name="ck_resource_edges_system_shape",
        ),
        CheckConstraint(
            """
            origin != 'note_body'
            OR (
                kind = 'context'
                AND source_scheme = 'note_block'
                AND source_order_key IS NULL
                AND target_order_key IS NULL
                AND ordinal IS NULL
                AND snapshot IS NULL
            )
            """,
            name="ck_resource_edges_note_body_shape",
        ),
        CheckConstraint(
            """
            origin != 'synapse'
            OR (
                source_scheme IN ('media', 'page', 'note_block', 'highlight')
                AND target_scheme IN ('media', 'note_block')
                AND source_order_key IS NULL
                AND target_order_key IS NULL
                AND ordinal IS NULL
            )
            """,
            name="ck_resource_edges_synapse_shape",
        ),
        CheckConstraint("ordinal >= 1", name="ck_resource_edges_ordinal_positive"),
        CheckConstraint(
            "ordinal IS NULL OR snapshot IS NOT NULL",
            name="ck_resource_edges_citation_has_snapshot",
        ),
        CheckConstraint(
            "snapshot IS NULL OR jsonb_typeof(snapshot) = 'object'",
            name="ck_resource_edges_snapshot_object",
        ),
        CheckConstraint(
            # A citation edge carries its snapshot beside an ordinal; a synapse
            # edge (origin='synapse') carries a bare-edge rationale snapshot with
            # no ordinal (spec §13.3). Both are the snapshot's only writers.
            "snapshot IS NULL OR ordinal IS NOT NULL OR origin = 'synapse'",
            name="ck_resource_edges_snapshot_has_ordinal",
        ),
        CheckConstraint(
            "snapshot IS NULL OR origin IN ('citation', 'synapse')",
            name="ck_resource_edges_snapshot_origin",
        ),
        CheckConstraint(
            "ordinal IS NULL OR origin = 'citation'",
            name="ck_resource_edges_ordinal_origin",
        ),
        CheckConstraint(
            "ordinal IS NULL OR (source_order_key IS NULL AND target_order_key IS NULL)",
            name="ck_resource_edges_citation_no_order",
        ),
        CheckConstraint(
            """
            origin != 'highlight_note'
            OR (
                kind = 'context'
                AND source_scheme = 'highlight'
                AND target_scheme = 'note_block'
                AND source_order_key IS NULL
                AND target_order_key IS NULL
                AND ordinal IS NULL
                AND snapshot IS NULL
            )
            """,
            name="ck_resource_edges_highlight_note_shape",
        ),
        Index(
            "uq_resource_edges_citation_ordinal",
            "user_id",
            "source_scheme",
            "source_id",
            "ordinal",
            unique=True,
            postgresql_where=text("ordinal IS NOT NULL"),
        ),
        Index(
            "uq_resource_edges_context_pair",
            "user_id",
            "origin",
            "source_scheme",
            "source_id",
            "target_scheme",
            "target_id",
            unique=True,
            postgresql_where=text("ordinal IS NULL"),
        ),
        Index(
            "uq_resource_edges_source_order",
            "user_id",
            "source_scheme",
            "source_id",
            "source_order_key",
            unique=True,
            postgresql_where=text("source_order_key IS NOT NULL"),
        ),
        Index(
            "ix_resource_edges_user_source",
            "user_id",
            "source_scheme",
            "source_id",
            "source_order_key",
            "id",
        ),
        Index(
            "ix_resource_edges_user_target",
            "user_id",
            "target_scheme",
            "target_id",
            "created_at",
            "id",
        ),
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

    __table_args__ = (
        CheckConstraint(
            "jsonb_typeof(source_snapshot) = 'object'",
            name="ck_resource_external_snapshots_source_object",
        ),
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

    __table_args__ = (
        CheckConstraint(
            """
            source_scheme IN (
                'media', 'library', 'evidence_span', 'content_chunk',
                'highlight', 'page', 'note_block', 'fragment',
                'conversation', 'message', 'oracle_reading',
                'oracle_passage_anchor', 'library_intelligence_artifact',
                'external_snapshot', 'contributor', 'podcast'
            )
            """,
            name="ck_synapse_suppressions_source_scheme",
        ),
        CheckConstraint(
            """
            target_scheme IN (
                'media', 'library', 'evidence_span', 'content_chunk',
                'highlight', 'page', 'note_block', 'fragment',
                'conversation', 'message', 'oracle_reading',
                'oracle_passage_anchor', 'library_intelligence_artifact',
                'external_snapshot', 'contributor', 'podcast'
            )
            """,
            name="ck_synapse_suppressions_target_scheme",
        ),
        Index(
            "ix_synapse_suppressions_user_target",
            "user_id",
            "target_scheme",
            "target_id",
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
            "'message', 'podcast', 'content_chunk', 'fragment', 'contributor', "
            "'evidence_span', 'reader_apparatus_item')",
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
        Index(
            "ix_user_pinned_objects_active_order",
            "user_id",
            "surface_key",
            "order_key",
            "created_at",
            "id",
            postgresql_where=text("deleted_at IS NULL"),
        ),
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

    __table_args__ = (
        CheckConstraint(
            "char_length(name) BETWEEN 1 AND 100",
            name="ck_libraries_name_length",
        ),
        CheckConstraint(
            "system_key IS NULL OR char_length(system_key) BETWEEN 1 AND 80",
            name="ck_libraries_system_key",
        ),
        Index(
            "uix_libraries_system_key",
            "system_key",
            unique=True,
            postgresql_where=text("system_key IS NOT NULL"),
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
        Index(
            "idx_media_stale_extracting_recovery",
            "processing_started_at",
            "id",
            postgresql_where=text(
                "processing_status = 'extracting' "
                "AND kind IN ('web_article', 'pdf', 'epub', 'podcast_episode') "
                "AND processing_started_at IS NOT NULL"
            ),
        ),
        Index(
            "idx_media_stale_pending_upload_cleanup",
            "created_at",
            "processing_started_at",
            "id",
            postgresql_where=text(
                "processing_status = 'pending' AND kind IN ('pdf', 'epub') AND file_sha256 IS NULL"
            ),
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
    source_attempts: Mapped[list["MediaSourceAttempt"]] = relationship(
        "MediaSourceAttempt", back_populates="media"
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

    media: Mapped["Media"] = relationship("Media", back_populates="source_attempts")

    __table_args__ = (
        CheckConstraint(
            """
            source_type IN (
                'generic_web_url',
                'x_author_thread',
                'youtube_video',
                'remote_pdf_url',
                'remote_epub_url',
                'uploaded_pdf_file',
                'uploaded_epub_file',
                'browser_article_capture',
                'browser_pdf_capture',
                'browser_epub_capture',
                'podcast_episode_transcript',
                'video_transcript'
            )
            """,
            name="ck_media_source_attempts_source_type",
        ),
        CheckConstraint(
            "status IN ('accepted', 'queued', 'running', 'succeeded', 'failed', 'superseded')",
            name="ck_media_source_attempts_status",
        ),
        CheckConstraint("attempt_no >= 1", name="ck_media_source_attempts_attempt_no"),
        CheckConstraint("run_count >= 0", name="ck_media_source_attempts_run_count"),
        CheckConstraint(
            "jsonb_typeof(source_payload) = 'object'",
            name="ck_media_source_attempts_source_payload",
        ),
        CheckConstraint(
            "idempotency_key IS NULL OR created_by_user_id IS NOT NULL",
            name="ck_media_source_attempts_idempotency_user",
        ),
        CheckConstraint(
            "requested_url IS NULL OR char_length(requested_url) <= 2048",
            name="ck_media_source_attempts_requested_url_length",
        ),
        CheckConstraint(
            "canonical_source_url IS NULL OR char_length(canonical_source_url) <= 2048",
            name="ck_media_source_attempts_canonical_source_url_length",
        ),
        CheckConstraint(
            "retry_after_seconds IS NULL OR retry_after_seconds >= 0",
            name="ck_media_source_attempts_retry_after",
        ),
        UniqueConstraint("media_id", "attempt_no", name="uq_media_source_attempts_media_attempt"),
        Index(
            "idx_media_source_attempts_media_created",
            "media_id",
            text("created_at DESC"),
            text("id DESC"),
        ),
        Index(
            "idx_media_source_attempts_status_updated",
            "status",
            "updated_at",
            "id",
        ),
        Index(
            "idx_media_source_attempts_request_id",
            "request_id",
            postgresql_where=text("request_id IS NOT NULL"),
        ),
        Index(
            "idx_media_source_attempts_source_type_status_updated",
            "source_type",
            "status",
            "updated_at",
            "id",
        ),
        Index(
            "idx_media_source_attempts_provider_target",
            "provider",
            "provider_target_ref",
            "created_at",
            "id",
            postgresql_where=text("provider IS NOT NULL AND provider_target_ref IS NOT NULL"),
        ),
        Index(
            "uq_media_source_attempts_idempotency",
            "created_by_user_id",
            "idempotency_key",
            unique=True,
            postgresql_where=text("idempotency_key IS NOT NULL"),
        ),
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
    sort_name: Mapped[str] = mapped_column(Text, nullable=False)
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

    __table_args__ = (
        CheckConstraint(
            "(media_id IS NOT NULL AND podcast_id IS NULL) "
            "OR (media_id IS NULL AND podcast_id IS NOT NULL)",
            name="ck_library_entries_exactly_one_target",
        ),
        CheckConstraint("position >= 0", name="ck_library_entries_position_non_negative"),
        UniqueConstraint("library_id", "media_id", name="uq_library_entries_library_media"),
        UniqueConstraint("library_id", "podcast_id", name="uq_library_entries_library_podcast"),
        UniqueConstraint(
            "library_id",
            "position",
            name="uq_library_entries_library_position",
            deferrable=True,
            initially="DEFERRED",
        ),
        Index("idx_library_entries_media_library", "media_id", "library_id"),
        Index("idx_library_entries_podcast_library", "podcast_id", "library_id"),
        Index(
            "ix_library_entries_library_order",
            "library_id",
            "position",
            text("created_at DESC"),
            text("id DESC"),
        ),
    )

    library: Mapped["Library"] = relationship("Library", back_populates="library_entries")
    media: Mapped["Media | None"] = relationship("Media", back_populates="library_entries")
    podcast: Mapped["Podcast | None"] = relationship("Podcast", back_populates="library_entries")


class LibraryIntelligenceArtifact(Base):
    """Stable library-intelligence head: one per library, promoting one revision."""

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
    user_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("users.id"),
        nullable=False,
    )
    current_revision_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey(
            "library_intelligence_artifact_revisions.id",
            name="fk_li_artifacts_current_revision",
            use_alter=True,
        ),
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
        UniqueConstraint(
            "library_id",
            name="uq_library_intelligence_artifacts_library",
        ),
    )


class LibraryIntelligenceArtifactRevision(Base):
    """Immutable generated synthesis snapshot; a revision IS its generation run."""

    __tablename__ = "library_intelligence_artifact_revisions"

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
    content_md: Mapped[str] = mapped_column(Text, nullable=False, server_default="")
    covered_targets: Mapped[list[dict[str, object]]] = mapped_column(JSONB, nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False)
    custom_instruction: Mapped[str | None] = mapped_column(Text, nullable=True)
    error_code: Mapped[str | None] = mapped_column(Text, nullable=True)
    error_detail: Mapped[str | None] = mapped_column(Text, nullable=True)
    idempotency_key: Mapped[str | None] = mapped_column(Text, nullable=True)
    completed_at: Mapped[datetime | None] = mapped_column(TIMESTAMP(timezone=True), nullable=True)
    promoted_at: Mapped[datetime | None] = mapped_column(TIMESTAMP(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True),
        server_default=text("now()"),
        nullable=False,
    )

    __table_args__ = (
        CheckConstraint(
            "status IN ('building', 'ready', 'failed')",
            name="ck_li_revisions_status",
        ),
        CheckConstraint(
            "jsonb_typeof(covered_targets) = 'array'",
            name="ck_li_revisions_covered_targets_array",
        ),
        Index(
            "ix_li_revisions_artifact_created",
            "artifact_id",
            text("created_at DESC"),
            text("id DESC"),
        ),
        Index(
            "uq_li_revisions_artifact_idempotency_key",
            "artifact_id",
            "idempotency_key",
            unique=True,
            postgresql_where=text("idempotency_key IS NOT NULL"),
        ),
    )


class LibraryIntelligenceRevisionEvent(Base):
    """One run_kit event for a revision generation run (the LI run stream)."""

    __tablename__ = "library_intelligence_revision_events"

    id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        primary_key=True,
        server_default=text("gen_random_uuid()"),
    )
    revision_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("library_intelligence_artifact_revisions.id"),
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
        CheckConstraint("seq >= 1", name="ck_li_revision_events_seq_positive"),
        CheckConstraint(
            "event_type IN ('meta', 'progress', 'delta', 'done')",
            name="ck_li_revision_events_type",
        ),
        UniqueConstraint("revision_id", "seq", name="uq_li_revision_events_seq"),
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


class PodcastSubscriptionLibrary(Base):
    """Join row attaching a podcast subscription to a non-default library."""

    __tablename__ = "podcast_subscription_libraries"

    subscription_user_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        primary_key=True,
    )
    subscription_podcast_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
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

    __table_args__ = (
        ForeignKeyConstraint(
            ["subscription_user_id", "subscription_podcast_id"],
            ["podcast_subscriptions.user_id", "podcast_subscriptions.podcast_id"],
            ondelete="CASCADE",
        ),
        Index("ix_podcast_subscription_libraries_library_id", "library_id"),
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


class PodcastTranscriptSegment(Base):
    """Current transcript segment persisted for a media item."""

    __tablename__ = "podcast_transcript_segments"

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
            "media_id",
            "segment_idx",
            name="uq_podcast_transcript_segments_media_idx",
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

    media: Mapped["Media"] = relationship("Media")


class ContentBlock(Base):
    """Format-aware block of canonical source text."""

    __tablename__ = "content_blocks"

    id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        primary_key=True,
        server_default=text("gen_random_uuid()"),
    )
    owner_kind: Mapped[str] = mapped_column(Text, nullable=False)
    owner_id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), nullable=False)
    block_idx: Mapped[int] = mapped_column(Integer, nullable=False)
    block_kind: Mapped[str] = mapped_column(Text, nullable=False)
    canonical_text: Mapped[str] = mapped_column(Text, nullable=False)
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
        CheckConstraint("jsonb_typeof(heading_path) = 'array'", name="ck_content_blocks_heading"),
        CheckConstraint("jsonb_typeof(locator) = 'object'", name="ck_content_blocks_locator"),
        CheckConstraint("jsonb_typeof(selector) = 'object'", name="ck_content_blocks_selector"),
        CheckConstraint("jsonb_typeof(metadata) = 'object'", name="ck_content_blocks_metadata"),
        CheckConstraint(
            "extraction_confidence IS NULL OR "
            "(extraction_confidence >= 0 AND extraction_confidence <= 1)",
            name="ck_content_blocks_extraction_confidence",
        ),
        CheckConstraint(
            "owner_kind IN ('media', 'note_block')",
            name="ck_content_blocks_owner_kind",
        ),
        UniqueConstraint("owner_kind", "owner_id", "block_idx", name="uq_content_blocks_owner_idx"),
        Index("ix_content_blocks_owner_idx", "owner_kind", "owner_id", "block_idx"),
    )


class EvidenceSpan(Base):
    """Durable citeable span over content blocks."""

    __tablename__ = "evidence_spans"

    id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        primary_key=True,
        server_default=text("gen_random_uuid()"),
    )
    owner_kind: Mapped[str] = mapped_column(Text, nullable=False)
    owner_id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), nullable=False)
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
        CheckConstraint("jsonb_typeof(selector) = 'object'", name="ck_evidence_spans_selector"),
        CheckConstraint(
            "resolver_kind IN ('web', 'epub', 'pdf', 'transcript', 'note')",
            name="ck_evidence_spans_resolver",
        ),
        CheckConstraint(
            "owner_kind IN ('media', 'note_block')",
            name="ck_evidence_spans_owner_kind",
        ),
        Index("ix_evidence_spans_owner", "owner_kind", "owner_id"),
    )


class ContentChunk(Base):
    """Retrieval chunk built from content blocks."""

    __tablename__ = "content_chunks"

    id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        primary_key=True,
        server_default=text("gen_random_uuid()"),
    )
    owner_kind: Mapped[str] = mapped_column(Text, nullable=False)
    owner_id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), nullable=False)
    primary_evidence_span_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("evidence_spans.id"),
        nullable=True,
    )
    chunk_idx: Mapped[int] = mapped_column(Integer, nullable=False)
    source_kind: Mapped[str] = mapped_column(Text, nullable=False)
    chunk_text: Mapped[str] = mapped_column(Text, nullable=False)
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
            "source_kind IN ('web_article', 'epub', 'pdf', 'transcript', 'note')",
            name="ck_content_chunks_source_kind",
        ),
        CheckConstraint("token_count >= 0", name="ck_content_chunks_token_count"),
        CheckConstraint("jsonb_typeof(heading_path) = 'array'", name="ck_content_chunks_heading"),
        CheckConstraint(
            "jsonb_typeof(summary_locator) = 'object'", name="ck_content_chunks_locator"
        ),
        CheckConstraint(
            "owner_kind IN ('media', 'note_block')",
            name="ck_content_chunks_owner_kind",
        ),
        UniqueConstraint("owner_kind", "owner_id", "chunk_idx", name="uq_content_chunks_owner_idx"),
        Index("ix_content_chunks_owner_idx", "owner_kind", "owner_id", "chunk_idx"),
    )


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
    embedding_dimensions: Mapped[int] = mapped_column(Integer, nullable=False)
    embedding_vector: Mapped[list[float] | None] = mapped_column(PGVector(256), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True),
        server_default=text("now()"),
        nullable=False,
    )

    __table_args__ = (
        CheckConstraint("embedding_dimensions > 0", name="ck_content_embeddings_dimensions"),
        Index(
            "ix_content_embeddings_model",
            "embedding_provider",
            "embedding_model",
        ),
    )


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

    __table_args__ = (
        UniqueConstraint("owner_kind", "owner_id", name="uq_content_index_states_owner"),
        CheckConstraint(
            "owner_kind IN ('media', 'note_block')",
            name="ck_content_index_states_owner_kind",
        ),
        CheckConstraint(
            "status IN ('pending', 'indexing', 'ready', 'no_text', 'ocr_required', 'failed')",
            name="ck_content_index_states_status",
        ),
        Index(
            "ix_content_index_states_repair_waiting",
            "updated_at",
            "owner_kind",
            "owner_id",
            postgresql_where=text("status IN ('pending', 'failed')"),
        ),
        Index(
            "ix_content_index_states_repair_indexing",
            "updated_at",
            "owner_kind",
            "owner_id",
            postgresql_where=text("status = 'indexing'"),
        ),
    )


class ReaderApparatusState(Base):
    """Extraction state for source-authored reader apparatus."""

    __tablename__ = "reader_apparatus_states"

    id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        primary_key=True,
        server_default=text("gen_random_uuid()"),
    )
    media_id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), ForeignKey("media.id"))
    media_kind: Mapped[str] = mapped_column(Text, nullable=False)
    source_fingerprint: Mapped[str] = mapped_column(Text, nullable=False)
    extractor_version: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False)
    item_count: Mapped[int] = mapped_column(Integer, nullable=False)
    edge_count: Mapped[int] = mapped_column(Integer, nullable=False)
    diagnostics: Mapped[dict[str, object]] = mapped_column(
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
            "status IN ('ready', 'empty', 'partial', 'unsupported', 'failed')",
            name="ck_reader_apparatus_states_status",
        ),
        CheckConstraint("item_count >= 0", name="ck_reader_apparatus_states_item_count"),
        CheckConstraint("edge_count >= 0", name="ck_reader_apparatus_states_edge_count"),
        CheckConstraint(
            "(status IN ('ready', 'partial') AND item_count > 0) "
            "OR (status IN ('empty', 'unsupported', 'failed') "
            "AND item_count = 0 AND edge_count = 0)",
            name="ck_reader_apparatus_states_status_counts",
        ),
        CheckConstraint(
            "jsonb_typeof(diagnostics) = 'object'",
            name="ck_reader_apparatus_states_diagnostics",
        ),
        UniqueConstraint("media_id", name="uq_reader_apparatus_states_media"),
        UniqueConstraint("media_id", "id", name="uq_reader_apparatus_states_media_id"),
    )


class ReaderApparatusItem(Base):
    """Source-authored apparatus marker or target."""

    __tablename__ = "reader_apparatus_items"

    id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        primary_key=True,
        server_default=text("gen_random_uuid()"),
    )
    media_id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), ForeignKey("media.id"))
    state_id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True))
    stable_key: Mapped[str] = mapped_column(Text, nullable=False)
    kind: Mapped[str] = mapped_column(Text, nullable=False)
    label: Mapped[str | None] = mapped_column(Text, nullable=True)
    body_text: Mapped[str | None] = mapped_column(Text, nullable=True)
    body_html_sanitized: Mapped[str | None] = mapped_column(Text, nullable=True)
    locator: Mapped[dict[str, object] | None] = mapped_column(
        JSONB(none_as_null=True),
        nullable=True,
    )
    locator_status: Mapped[str] = mapped_column(Text, nullable=False)
    confidence: Mapped[str] = mapped_column(Text, nullable=False)
    extraction_method: Mapped[str] = mapped_column(Text, nullable=False)
    source_ref: Mapped[dict[str, object]] = mapped_column(JSONB, nullable=False)
    sort_key: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True),
        server_default=text("now()"),
        nullable=False,
    )

    __table_args__ = (
        CheckConstraint(
            "kind IN ('footnote_ref', 'endnote_ref', 'bibliography_ref', "
            "'sidenote_ref', 'margin_note_ref', 'footnote', 'endnote', "
            "'bibliography_entry', 'sidenote', 'margin_note', 'reference_section')",
            name="ck_reader_apparatus_items_kind",
        ),
        CheckConstraint(
            "locator_status IN ('exact', 'container', 'missing')",
            name="ck_reader_apparatus_items_locator_status",
        ),
        CheckConstraint(
            "confidence IN ('exact', 'strong', 'probable')",
            name="ck_reader_apparatus_items_confidence",
        ),
        CheckConstraint(
            "locator IS NULL OR jsonb_typeof(locator) = 'object'",
            name="ck_reader_apparatus_items_locator",
        ),
        CheckConstraint(
            "jsonb_typeof(source_ref) = 'object'",
            name="ck_reader_apparatus_items_source_ref",
        ),
        CheckConstraint(
            "body_html_sanitized IS NULL OR kind IN ('footnote', 'endnote', "
            "'bibliography_entry', 'sidenote', 'margin_note', 'reference_section')",
            name="ck_reader_apparatus_items_body_html_target",
        ),
        ForeignKeyConstraint(
            ["media_id", "state_id"],
            ["reader_apparatus_states.media_id", "reader_apparatus_states.id"],
        ),
        UniqueConstraint("media_id", "stable_key", name="uq_reader_apparatus_items_key"),
        UniqueConstraint(
            "media_id",
            "state_id",
            "id",
            name="uq_reader_apparatus_items_media_state_id",
        ),
    )


class ReaderApparatusEdge(Base):
    """Source-authored relationship between reader apparatus items."""

    __tablename__ = "reader_apparatus_edges"

    id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        primary_key=True,
        server_default=text("gen_random_uuid()"),
    )
    media_id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), ForeignKey("media.id"))
    state_id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True))
    stable_key: Mapped[str] = mapped_column(Text, nullable=False)
    from_item_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
    )
    to_item_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
    )
    relation: Mapped[str] = mapped_column(Text, nullable=False)
    confidence: Mapped[str] = mapped_column(Text, nullable=False)
    extraction_method: Mapped[str] = mapped_column(Text, nullable=False)
    source_ref: Mapped[dict[str, object]] = mapped_column(JSONB, nullable=False)
    sort_key: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True),
        server_default=text("now()"),
        nullable=False,
    )

    __table_args__ = (
        CheckConstraint(
            "relation IN ('points_to_note', 'points_to_endnote', "
            "'points_to_sidenote', 'points_to_margin_note', "
            "'cites_bibliography_entry', 'backlink_to_marker', 'contains_reference')",
            name="ck_reader_apparatus_edges_relation",
        ),
        CheckConstraint(
            "confidence IN ('exact', 'strong', 'probable')",
            name="ck_reader_apparatus_edges_confidence",
        ),
        CheckConstraint("from_item_id <> to_item_id", name="ck_reader_apparatus_edges_not_self"),
        CheckConstraint(
            "jsonb_typeof(source_ref) = 'object'",
            name="ck_reader_apparatus_edges_source_ref",
        ),
        ForeignKeyConstraint(
            ["media_id", "state_id"],
            ["reader_apparatus_states.media_id", "reader_apparatus_states.id"],
        ),
        ForeignKeyConstraint(
            ["media_id", "state_id", "from_item_id"],
            [
                "reader_apparatus_items.media_id",
                "reader_apparatus_items.state_id",
                "reader_apparatus_items.id",
            ],
        ),
        ForeignKeyConstraint(
            ["media_id", "state_id", "to_item_id"],
            [
                "reader_apparatus_items.media_id",
                "reader_apparatus_items.state_id",
                "reader_apparatus_items.id",
            ],
        ),
        UniqueConstraint("media_id", "stable_key", name="uq_reader_apparatus_edges_key"),
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

    __table_args__ = (
        CheckConstraint(
            "status IN ('building', 'ready', 'failed')",
            name="ck_media_summaries_status",
        ),
        UniqueConstraint("media_id", name="uq_media_summaries_media"),
    )


class MediaClaim(Base):
    """One grounded per-media claim bound to an existing evidence span."""

    __tablename__ = "media_claims"

    id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        primary_key=True,
        server_default=text("gen_random_uuid()"),
    )
    media_id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), ForeignKey("media.id"))
    summary_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True), ForeignKey("media_summaries.id")
    )
    claim_text: Mapped[str] = mapped_column(Text, nullable=False)
    evidence_span_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True), ForeignKey("evidence_spans.id")
    )
    ordinal: Mapped[int] = mapped_column(Integer, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True),
        server_default=text("now()"),
        nullable=False,
    )

    __table_args__ = (
        CheckConstraint("ordinal >= 0", name="ck_media_claims_ordinal_non_negative"),
        UniqueConstraint("summary_id", "ordinal", name="uq_media_claims_summary_ordinal"),
        Index("ix_media_claims_media", "media_id"),
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
            "'episode_open', 'search', 'highlight', 'quote', 'background_warming', "
            "'operator_requeue', 'rss_feed'"
            ")",
            name="ck_media_transcript_states_last_request_reason",
        ),
        Index("ix_media_transcript_states_semantic_status", "semantic_status"),
        Index(
            "ix_media_transcript_states_semantic_repair",
            "updated_at",
            "media_id",
            postgresql_where=text(
                "transcript_state IN ('ready', 'partial') "
                "AND transcript_coverage IN ('partial', 'full') "
                "AND semantic_status IN ('pending', 'failed', 'ready')"
            ),
        ),
    )

    media: Mapped["Media"] = relationship("Media", back_populates="transcript_state")


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
            "'episode_open', 'search', 'highlight', 'quote', 'background_warming', "
            "'operator_requeue', 'rss_feed'"
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

    Stores page-space geometry metadata and persisted quote-match metadata
    for PDF highlights.
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

    __table_args__ = (
        CheckConstraint("page_number >= 1", name="ck_hpa_page_number"),
        CheckConstraint("rect_count >= 1", name="ck_hpa_rect_count"),
        CheckConstraint(
            "plain_text_match_status IN "
            "('pending', 'unique', 'ambiguous', 'no_match', 'empty_exact')",
            name="ck_hpa_match_status",
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
        CheckConstraint("page_width IS NULL OR page_width > 0", name="ck_ppts_page_width"),
        CheckConstraint("page_height IS NULL OR page_height > 0", name="ck_ppts_page_height"),
        CheckConstraint(
            "page_rotation_degrees IS NULL OR page_rotation_degrees >= 0",
            name="ck_ppts_page_rotation",
        ),
    )

    media: Mapped["Media"] = relationship("Media", back_populates="pdf_page_text_spans")


# =============================================================================
# Chat, Conversations, and LLM Infrastructure
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


class BranchAnchorKind(str, PyEnum):
    """Anchor kinds for a user message's branch edge."""

    none = "none"
    assistant_message = "assistant_message"
    assistant_selection = "assistant_selection"


class LLMProvider(str, PyEnum):
    """Supported LLM providers."""

    openai = "openai"
    anthropic = "anthropic"
    gemini = "gemini"
    openrouter = "openrouter"
    cloudflare = "cloudflare"


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
    """User-visible event types persisted for chat run replay.

    Mirrors the ``ck_chat_run_events_event_type`` CHECK exactly.
    """

    meta = "meta"
    tool_call = "tool_call"
    retrieval_result = "retrieval_result"
    citation_index = "citation_index"
    context_ref_added = "context_ref_added"
    delta = "delta"
    done = "done"


class AppSearchResultType(str, PyEnum):
    """Typed app-search result classes surfaced to assistant retrieval."""

    page = "page"
    note_block = "note_block"
    highlight = "highlight"
    media = "media"
    podcast = "podcast"
    episode = "episode"
    video = "video"
    content_chunk = "content_chunk"
    fragment = "fragment"
    message = "message"
    contributor = "contributor"
    evidence_span = "evidence_span"
    conversation = "conversation"
    web_result = "web_result"


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
            "provider IN ('openai', 'anthropic', 'gemini', 'openrouter', 'cloudflare')",
            name="ck_models_provider",
        ),
        CheckConstraint(
            "max_context_tokens > 0",
            name="ck_models_max_context_positive",
        ),
        UniqueConstraint("provider", "model_name", name="uix_models_provider_model_name"),
    )


class LLMCall(Base):
    """One provider LLM call in the polymorphic ledger (sole writer: llm_ledger)."""

    __tablename__ = "llm_calls"

    id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        primary_key=True,
        server_default=text("gen_random_uuid()"),
    )
    owner_kind: Mapped[str] = mapped_column(Text, nullable=False)
    owner_id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), nullable=False)
    call_seq: Mapped[int] = mapped_column(Integer, nullable=False)
    provider: Mapped[str] = mapped_column(Text, nullable=False)
    provider_route: Mapped[str] = mapped_column(Text, nullable=False)
    model_name: Mapped[str] = mapped_column(Text, nullable=False)
    llm_operation: Mapped[str] = mapped_column(Text, nullable=False)
    streaming: Mapped[bool] = mapped_column(Boolean, nullable=False)
    reasoning_effort: Mapped[str] = mapped_column(Text, nullable=False)
    key_mode_requested: Mapped[str] = mapped_column(Text, nullable=False)
    key_mode_used: Mapped[str] = mapped_column(Text, nullable=False)
    input_tokens: Mapped[int | None] = mapped_column(Integer, nullable=True)
    output_tokens: Mapped[int | None] = mapped_column(Integer, nullable=True)
    total_tokens: Mapped[int | None] = mapped_column(Integer, nullable=True)
    reasoning_tokens: Mapped[int | None] = mapped_column(Integer, nullable=True)
    cache_write_input_tokens: Mapped[int | None] = mapped_column(Integer, nullable=True)
    cache_read_input_tokens: Mapped[int | None] = mapped_column(Integer, nullable=True)
    cached_input_tokens: Mapped[int | None] = mapped_column(Integer, nullable=True)
    latency_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    error_class: Mapped[str | None] = mapped_column(Text, nullable=True)
    error_detail: Mapped[str | None] = mapped_column(Text, nullable=True)
    provider_request_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    input_cost_usd_micros: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    output_cost_usd_micros: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    cache_write_cost_usd_micros: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    cache_read_cost_usd_micros: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    reasoning_cost_usd_micros: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    total_cost_usd_micros: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    cost_status: Mapped[str] = mapped_column(Text, nullable=False)
    pricing_snapshot: Mapped[dict[str, object] | None] = mapped_column(
        JSONB(none_as_null=True), nullable=True
    )
    attempt_count: Mapped[int] = mapped_column(Integer, nullable=False, server_default=text("1"))
    retry_count: Mapped[int] = mapped_column(Integer, nullable=False, server_default=text("0"))
    terminal_attempt_status: Mapped[str] = mapped_column(
        Text, nullable=False, server_default=text("'success'")
    )
    provider_attempts: Mapped[list[dict[str, object]] | None] = mapped_column(
        JSONB(none_as_null=True), nullable=True
    )
    provider_usage: Mapped[dict[str, object] | None] = mapped_column(
        JSONB(none_as_null=True), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True),
        server_default=text("now()"),
        nullable=False,
    )

    __table_args__ = (
        CheckConstraint(
            "owner_kind IN ('chat_run', 'oracle_reading', 'li_revision', "
            "'media_summary', 'media_enrichment', 'synapse_scan')",
            name="ck_llm_calls_owner_kind",
        ),
        CheckConstraint("call_seq >= 1", name="ck_llm_calls_call_seq_positive"),
        CheckConstraint(
            "provider IN ('openai', 'anthropic', 'gemini', 'openrouter', 'cloudflare')",
            name="ck_llm_calls_provider",
        ),
        CheckConstraint(
            "provider_route IN ('openai', 'anthropic', 'gemini', 'openrouter', 'cloudflare')",
            name="ck_llm_calls_provider_route",
        ),
        CheckConstraint(
            "input_tokens >= 0 AND output_tokens >= 0 AND total_tokens >= 0 "
            "AND reasoning_tokens >= 0 AND cache_write_input_tokens >= 0 "
            "AND cache_read_input_tokens >= 0 AND cached_input_tokens >= 0",
            name="ck_llm_calls_token_counts_non_negative",
        ),
        CheckConstraint(
            "provider_usage IS NULL OR jsonb_typeof(provider_usage) = 'object'",
            name="ck_llm_calls_provider_usage_object",
        ),
        CheckConstraint(
            "attempt_count >= 1 AND retry_count >= 0 AND retry_count <= attempt_count - 1",
            name="ck_llm_calls_attempt_counts",
        ),
        CheckConstraint(
            "terminal_attempt_status IN ('success', 'retryable_error', 'terminal_error', 'abandoned')",
            name="ck_llm_calls_terminal_attempt_status",
        ),
        CheckConstraint(
            "provider_attempts IS NULL OR jsonb_typeof(provider_attempts) = 'array'",
            name="ck_llm_calls_provider_attempts_array",
        ),
        CheckConstraint(
            "cost_status IN ('estimated', 'missing_pricing', 'missing_usage', 'not_token_priced')",
            name="ck_llm_calls_cost_status",
        ),
        CheckConstraint(
            "input_cost_usd_micros IS NULL OR input_cost_usd_micros >= 0",
            name="ck_llm_calls_input_cost_non_negative",
        ),
        CheckConstraint(
            "output_cost_usd_micros IS NULL OR output_cost_usd_micros >= 0",
            name="ck_llm_calls_output_cost_non_negative",
        ),
        CheckConstraint(
            "cache_write_cost_usd_micros IS NULL OR cache_write_cost_usd_micros >= 0",
            name="ck_llm_calls_cache_write_cost_non_negative",
        ),
        CheckConstraint(
            "cache_read_cost_usd_micros IS NULL OR cache_read_cost_usd_micros >= 0",
            name="ck_llm_calls_cache_read_cost_non_negative",
        ),
        CheckConstraint(
            "reasoning_cost_usd_micros IS NULL OR reasoning_cost_usd_micros >= 0",
            name="ck_llm_calls_reasoning_cost_non_negative",
        ),
        CheckConstraint(
            "total_cost_usd_micros IS NULL OR total_cost_usd_micros >= 0",
            name="ck_llm_calls_total_cost_non_negative",
        ),
        CheckConstraint(
            "pricing_snapshot IS NULL OR jsonb_typeof(pricing_snapshot) = 'object'",
            name="ck_llm_calls_pricing_snapshot_object",
        ),
        UniqueConstraint("owner_kind", "owner_id", "call_seq", name="uq_llm_calls_owner_call_seq"),
        Index("ix_llm_calls_owner", "owner_kind", "owner_id"),
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
    message_document: Mapped[dict[str, object]] = mapped_column(
        JSONB,
        nullable=False,
        server_default=text("""'{"type":"message_document","blocks":[]}'::jsonb"""),
    )
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default="complete")
    error_code: Mapped[str | None] = mapped_column(Text, nullable=True)
    model_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("models.id", ondelete="SET NULL"),
        nullable=True,
    )
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
        CheckConstraint(
            "branch_anchor_kind IN ('none', 'assistant_message', 'assistant_selection')",
            name="ck_messages_branch_anchor_kind",
        ),
        CheckConstraint(
            "jsonb_typeof(branch_anchor) = 'object'",
            name="ck_messages_branch_anchor_object",
        ),
        CheckConstraint(
            "jsonb_typeof(message_document) = 'object'",
            name="ck_messages_message_document_object",
        ),
        CheckConstraint(
            "(role = 'user' AND parent_message_id IS NULL) "
            "OR (role IN ('user', 'assistant') AND parent_message_id IS NOT NULL) "
            "OR (role = 'system')",
            name="ck_messages_parent_role_shape",
        ),
        UniqueConstraint("conversation_id", "seq", name="uix_messages_conversation_seq"),
        Index("idx_messages_parent_message_id", "parent_message_id"),
    )

    # Relationships
    conversation: Mapped["Conversation"] = relationship("Conversation", back_populates="messages")
    model: Mapped["Model | None"] = relationship("Model")
    parent_message: Mapped["Message | None"] = relationship(
        "Message",
        foreign_keys=[parent_message_id],
        remote_side=[id],
    )
    branch_root_message: Mapped["Message | None"] = relationship(
        "Message",
        foreign_keys=[branch_root_message_id],
        remote_side=[id],
    )


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

    __table_args__ = (
        UniqueConstraint(
            "conversation_id",
            "viewer_user_id",
            name="uix_conversation_active_paths_conversation_viewer",
        ),
    )

    conversation: Mapped["Conversation"] = relationship("Conversation")
    viewer: Mapped["User"] = relationship("User")
    active_leaf_message: Mapped["Message"] = relationship("Message")


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

    __table_args__ = (
        UniqueConstraint(
            "branch_user_message_id",
            name="uix_conversation_branches_user_message",
        ),
        CheckConstraint(
            "title IS NULL OR char_length(btrim(title)) BETWEEN 1 AND 120",
            name="ck_conversation_branches_title_length",
        ),
        Index("idx_conversation_branches_conversation", "conversation_id"),
    )

    conversation: Mapped["Conversation"] = relationship("Conversation")
    branch_user_message: Mapped["Message"] = relationship("Message")


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
    tool_name: Mapped[str] = mapped_column(Text, nullable=False)
    tool_call_index: Mapped[int] = mapped_column(Integer, nullable=False)
    query_hash: Mapped[str | None] = mapped_column(Text, nullable=True)
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
            "status IN ('pending', 'running', 'complete', 'error', 'cancelled')",
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
    # One-way provenance pointer to the citation resource_edge, set when this
    # result is cited. Deliberately no FK: edge and telemetry rows are cleaned
    # up by different owners (resource provenance graph D6).
    cited_edge_id: Mapped[UUID | None] = mapped_column(PG_UUID(as_uuid=True), nullable=True)
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
                'highlight',
                'media',
                'podcast',
                'episode',
                'video',
                'content_chunk',
                'fragment',
                'message',
                'contributor',
                'evidence_span',
                'conversation',
                'web_result',
                'reader_apparatus_item'
            )
            """,
            name="ck_message_retrievals_result_type",
        ),
        CheckConstraint(
            "char_length(source_id) BETWEEN 1 AND 128",
            name="ck_message_retrievals_source_id_length",
        ),
        CheckConstraint(
            """
            result_type <> 'web_result'
            OR source_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
            """,
            name="ck_message_retrievals_web_source_snapshot_uuid",
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


class MessageRetrievalCandidateLedger(Base):
    """Durable ledger row for one retrieval candidate and its selection outcome."""

    __tablename__ = "message_retrieval_candidate_ledgers"

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
    retrieval_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("message_retrievals.id"),
        nullable=True,
    )
    ordinal: Mapped[int] = mapped_column(Integer, nullable=False)
    result_type: Mapped[str] = mapped_column(Text, nullable=False)
    source_id: Mapped[str] = mapped_column(Text, nullable=False)
    score: Mapped[float | None] = mapped_column(Float, nullable=True)
    selected: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default="false")
    included_in_prompt: Mapped[bool] = mapped_column(
        Boolean,
        nullable=False,
        server_default="false",
    )
    selection_status: Mapped[str] = mapped_column(Text, nullable=False)
    selection_reason: Mapped[str] = mapped_column(Text, nullable=False)
    result_ref: Mapped[dict[str, object]] = mapped_column(JSONB, nullable=False)
    locator: Mapped[dict[str, object] | None] = mapped_column(JSONB, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True),
        server_default=text("now()"),
        nullable=False,
    )

    __table_args__ = (
        CheckConstraint("ordinal >= 0", name="ck_retrieval_candidate_ledgers_ordinal"),
        CheckConstraint(
            "char_length(result_type) BETWEEN 1 AND 64",
            name="ck_retrieval_candidate_ledgers_result_type",
        ),
        CheckConstraint(
            "char_length(source_id) BETWEEN 1 AND 256",
            name="ck_retrieval_candidate_ledgers_source_id",
        ),
        CheckConstraint(
            "score IS NULL OR score >= 0",
            name="ck_retrieval_candidate_ledgers_score",
        ),
        CheckConstraint(
            """
            selection_status IN (
                'retrieved',
                'selected',
                'included_in_prompt',
                'excluded_by_budget',
                'excluded_by_scope',
                'web_result'
            )
            """,
            name="ck_retrieval_candidate_ledgers_status",
        ),
        CheckConstraint(
            "char_length(selection_reason) BETWEEN 1 AND 128",
            name="ck_retrieval_candidate_ledgers_reason",
        ),
        CheckConstraint(
            "jsonb_typeof(result_ref) = 'object'",
            name="ck_retrieval_candidate_ledgers_result_ref_object",
        ),
        CheckConstraint(
            "locator IS NULL OR locator = 'null'::jsonb OR jsonb_typeof(locator) = 'object'",
            name="ck_retrieval_candidate_ledgers_locator_object",
        ),
        Index(
            "idx_retrieval_candidate_ledgers_tool_call",
            "tool_call_id",
            "ordinal",
        ),
        Index("idx_retrieval_candidate_ledgers_retrieval", "retrieval_id"),
    )

    tool_call: Mapped["MessageToolCall"] = relationship("MessageToolCall")
    retrieval: Mapped["MessageRetrieval | None"] = relationship("MessageRetrieval")


class MessageRerankLedger(Base):
    """Durable ledger row for the selection/rerank pass of one retrieval tool call."""

    __tablename__ = "message_rerank_ledgers"

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
    strategy: Mapped[str] = mapped_column(Text, nullable=False)
    input_count: Mapped[int] = mapped_column(Integer, nullable=False)
    selected_count: Mapped[int] = mapped_column(Integer, nullable=False)
    budget_chars: Mapped[int | None] = mapped_column(Integer, nullable=True)
    selected_chars: Mapped[int] = mapped_column(Integer, nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False)
    metadata_: Mapped[dict[str, object]] = mapped_column(
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
            "char_length(strategy) BETWEEN 1 AND 128",
            name="ck_message_rerank_ledgers_strategy",
        ),
        CheckConstraint(
            "input_count >= 0 AND selected_count >= 0 AND selected_chars >= 0",
            name="ck_message_rerank_ledgers_counts",
        ),
        CheckConstraint(
            "budget_chars IS NULL OR budget_chars >= 0",
            name="ck_message_rerank_ledgers_budget_chars",
        ),
        CheckConstraint(
            "char_length(status) BETWEEN 1 AND 64",
            name="ck_message_rerank_ledgers_status",
        ),
        CheckConstraint(
            "jsonb_typeof(metadata) = 'object'",
            name="ck_message_rerank_ledgers_metadata_object",
        ),
        Index("idx_message_rerank_ledgers_tool_call", "tool_call_id", "created_at", "id"),
    )

    tool_call: Mapped["MessageToolCall"] = relationship("MessageToolCall")


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
    cancel_requested_at: Mapped[datetime | None] = mapped_column(
        TIMESTAMP(timezone=True),
        nullable=True,
    )
    started_at: Mapped[datetime | None] = mapped_column(TIMESTAMP(timezone=True), nullable=True)
    completed_at: Mapped[datetime | None] = mapped_column(TIMESTAMP(timezone=True), nullable=True)
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

    __table_args__ = (
        CheckConstraint(
            "status IN ('queued', 'running', 'complete', 'error', 'cancelled')",
            name="ck_chat_runs_status",
        ),
        CheckConstraint(
            "length(idempotency_key) >= 1 AND length(idempotency_key) <= 128",
            name="ck_chat_runs_idempotency_key_length",
        ),
        CheckConstraint(
            "reasoning IN ('default', 'none', 'minimal', 'low', 'medium', 'high', 'max')",
            name="ck_chat_runs_reasoning",
        ),
        CheckConstraint(
            "key_mode IN ('auto', 'byok_only', 'platform_only')",
            name="ck_chat_runs_key_mode",
        ),
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
    )
    prompt_assembly: Mapped["ChatPromptAssembly | None"] = relationship(
        "ChatPromptAssembly",
        back_populates="chat_run",
        uselist=False,
        cascade="all, delete-orphan",
    )
    turn_context: Mapped["ChatRunTurnContext | None"] = relationship(
        "ChatRunTurnContext",
        back_populates="chat_run",
        uselist=False,
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
    reader_selection_media_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True), nullable=True
    )
    reader_selection_highlight_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True),
        server_default=text("now()"),
        nullable=False,
    )

    __table_args__ = (
        CheckConstraint(
            "(requested_subject_scheme IS NULL) = (requested_subject_id IS NULL)",
            name="ck_chat_run_turn_contexts_requested_subject_pair",
        ),
        CheckConstraint(
            "(subject_scheme IS NULL) = (subject_id IS NULL)",
            name="ck_chat_run_turn_contexts_subject_pair",
        ),
        CheckConstraint(
            "(reader_selection_media_id IS NULL) = (reader_selection_highlight_id IS NULL)",
            name="ck_chat_run_turn_contexts_reader_selection_pair",
        ),
        CheckConstraint(
            "subject_id IS NOT NULL OR reader_selection_highlight_id IS NOT NULL",
            name="ck_chat_run_turn_contexts_has_anchor",
        ),
        CheckConstraint(
            "requested_subject_scheme IS NULL OR requested_subject_scheme IN ("
            "'media', 'library', 'evidence_span', 'content_chunk', 'highlight', 'page', "
            "'note_block', 'fragment', 'conversation', 'message', 'oracle_reading', "
            "'oracle_passage_anchor', 'library_intelligence_artifact', "
            "'library_intelligence_revision', 'external_snapshot', 'contributor', "
            "'podcast', 'reader_apparatus_item')",
            name="ck_chat_run_turn_contexts_requested_subject_scheme",
        ),
        CheckConstraint(
            "subject_scheme IS NULL OR subject_scheme IN ("
            "'media', 'library', 'evidence_span', 'content_chunk', 'highlight', 'page', "
            "'note_block', 'fragment', 'conversation', 'message', 'oracle_reading', "
            "'oracle_passage_anchor', 'library_intelligence_artifact', "
            "'library_intelligence_revision', 'external_snapshot', 'contributor', "
            "'podcast', 'reader_apparatus_item')",
            name="ck_chat_run_turn_contexts_subject_scheme",
        ),
        Index("idx_chat_run_turn_contexts_subject", "subject_scheme", "subject_id"),
    )

    chat_run: Mapped["ChatRun"] = relationship("ChatRun", back_populates="turn_context")
    subject_context_edge: Mapped["ResourceEdge | None"] = relationship("ResourceEdge")


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
    model_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("models.id"),
        nullable=False,
    )
    cacheable_input_tokens_estimate: Mapped[int] = mapped_column(Integer, nullable=False)
    prompt_block_manifest: Mapped[dict[str, object]] = mapped_column(
        JSONB,
        nullable=False,
        server_default=text("'{}'::jsonb"),
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
        Index(
            "idx_chat_prompt_assemblies_assistant_message",
            "assistant_message_id",
        ),
    )

    chat_run: Mapped["ChatRun"] = relationship("ChatRun", back_populates="prompt_assembly")
    conversation: Mapped["Conversation"] = relationship(
        "Conversation",
        back_populates="prompt_assemblies",
    )
    assistant_message: Mapped["Message"] = relationship("Message")
    model: Mapped["Model"] = relationship("Model")


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

    __table_args__ = (
        CheckConstraint("seq >= 1", name="ck_chat_run_events_seq_positive"),
        CheckConstraint(
            "event_type IN ('meta', 'tool_call', 'retrieval_result', "
            "'citation_index', 'context_ref_added', 'delta', 'done')",
            name="ck_chat_run_events_event_type",
        ),
        UniqueConstraint("run_id", "seq", name="uix_chat_run_events_run_seq"),
        Index("idx_chat_run_events_run_seq", "run_id", "seq"),
        Index("idx_chat_run_events_run_event_type_seq", "run_id", "event_type", "seq"),
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
            "provider IN ('openai', 'anthropic', 'gemini', 'openrouter')",
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
    platform_token_quota_mode: Mapped[str] = mapped_column(
        Text,
        nullable=False,
        server_default="plan",
    )
    platform_token_limit_monthly: Mapped[int | None] = mapped_column(Integer, nullable=True)
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

    __table_args__ = (
        CheckConstraint(
            "plan_tier IN ('plus', 'ai_plus', 'ai_pro')",
            name="ck_billing_entitlement_overrides_plan_tier",
        ),
        CheckConstraint(
            "platform_token_quota_mode IN ('plan', 'custom', 'unlimited')",
            name="ck_billing_entitlement_overrides_platform_token_quota_mode",
        ),
        CheckConstraint(
            """
            (
                platform_token_quota_mode = 'custom'
                AND platform_token_limit_monthly IS NOT NULL
                AND platform_token_limit_monthly >= 0
            )
            OR (
                platform_token_quota_mode <> 'custom'
                AND platform_token_limit_monthly IS NULL
            )
            """,
            name="ck_billing_entitlement_overrides_platform_token_limit",
        ),
        CheckConstraint(
            "transcription_quota_mode IN ('plan', 'custom', 'unlimited')",
            name="ck_billing_entitlement_overrides_transcription_quota_mode",
        ),
        CheckConstraint(
            """
            (
                transcription_quota_mode = 'custom'
                AND transcription_minutes_limit_monthly IS NOT NULL
                AND transcription_minutes_limit_monthly >= 0
            )
            OR (
                transcription_quota_mode <> 'custom'
                AND transcription_minutes_limit_monthly IS NULL
            )
            """,
            name="ck_billing_entitlement_overrides_transcription_limit",
        ),
        CheckConstraint(
            "char_length(btrim(reason)) > 0",
            name="ck_billing_entitlement_overrides_reason_present",
        ),
        UniqueConstraint("user_id", name="uq_billing_entitlement_overrides_user_id"),
    )


class BillingEntitlementOverrideEvent(Base):
    """Audit event for an internal entitlement grant mutation."""

    __tablename__ = "billing_entitlement_override_events"

    id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        primary_key=True,
        server_default=text("gen_random_uuid()"),
    )
    override_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("billing_entitlement_overrides.id"),
        nullable=True,
    )
    user_id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), ForeignKey("users.id"))
    event_type: Mapped[str] = mapped_column(Text, nullable=False)
    actor_user_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("users.id"),
        nullable=True,
    )
    actor_label: Mapped[str | None] = mapped_column(Text, nullable=True)
    reason: Mapped[str] = mapped_column(Text, nullable=False)
    before_state: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    after_state: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True),
        server_default=text("now()"),
        nullable=False,
    )

    __table_args__ = (
        CheckConstraint(
            "event_type IN ('created', 'updated', 'revoked')",
            name="ck_billing_entitlement_override_events_event_type",
        ),
        CheckConstraint(
            "char_length(btrim(reason)) > 0",
            name="ck_billing_entitlement_override_events_reason_present",
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

    __table_args__ = (
        CheckConstraint("char_length(code_hash) = 64", name="ck_auth_handoff_codes_code_hash_len"),
        CheckConstraint("char_length(challenge) = 64", name="ck_auth_handoff_codes_challenge_len"),
        CheckConstraint(
            "expires_at > created_at", name="ck_auth_handoff_codes_expires_after_created"
        ),
        UniqueConstraint("code_hash", name="uix_auth_handoff_codes_code_hash"),
    )

    user: Mapped["User"] = relationship("User")


# =============================================================================
# Library Sharing
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
    from-url creation, or media captured by default-library backfill).
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
    focus_mode: Mapped[str] = mapped_column(Text, nullable=False, server_default="off")
    hyphenation: Mapped[str] = mapped_column(Text, nullable=False, server_default="auto")
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
        CheckConstraint(
            "focus_mode IN ('off', 'distraction_free', 'paragraph', 'sentence')",
            name="ck_reader_profiles_focus_mode",
        ),
        CheckConstraint(
            "hyphenation IN ('auto', 'off')",
            name="ck_reader_profiles_hyphenation",
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

    __table_args__ = (
        UniqueConstraint("user_id", "device_id", name="uq_workspace_sessions_user_device"),
        CheckConstraint(
            "jsonb_typeof(state) = 'object'",
            name="ck_workspace_sessions_state_object",
        ),
        Index(
            "ix_workspace_sessions_user_updated",
            "user_id",
            text("updated_at DESC"),
            text("id DESC"),
        ),
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

    __table_args__ = (
        CheckConstraint(
            "char_length(work_key) BETWEEN 1 AND 160", name="ck_oracle_corpus_sources_key"
        ),
        CheckConstraint(
            "source_media_kind IN ('epub', 'web_article', 'pdf')",
            name="ck_oracle_corpus_sources_kind",
        ),
        UniqueConstraint("corpus_key", "work_key", name="uix_oracle_corpus_sources_work"),
        UniqueConstraint("media_id", name="uix_oracle_corpus_sources_media"),
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

    __table_args__ = (
        CheckConstraint(
            "jsonb_typeof(selector) = 'object'", name="ck_oracle_passage_anchors_selector"
        ),
        CheckConstraint("jsonb_typeof(tags) = 'array'", name="ck_oracle_passage_anchors_tags"),
        CheckConstraint(
            "jsonb_typeof(phase_hints) = 'array'", name="ck_oracle_passage_anchors_phase_hints"
        ),
        CheckConstraint(
            "resolution_status IN ('pending', 'resolved', 'failed')",
            name="ck_oracle_passage_anchors_status",
        ),
        CheckConstraint(
            """
            (
                resolution_status = 'pending'
                AND current_evidence_span_id IS NULL
                AND current_content_chunk_id IS NULL
                AND resolved_at IS NULL
                AND resolution_error IS NULL
            )
            OR (
                resolution_status = 'resolved'
                AND current_content_chunk_id IS NOT NULL
                AND resolved_at IS NOT NULL
                AND resolution_error IS NULL
            )
            OR (
                resolution_status = 'failed'
                AND current_evidence_span_id IS NULL
                AND current_content_chunk_id IS NULL
                AND resolved_at IS NULL
                AND resolution_error IS NOT NULL
            )
            """,
            name="ck_oracle_passage_anchors_resolution_state",
        ),
        UniqueConstraint("corpus_source_id", "passage_key", name="uix_oracle_passage_anchors_key"),
    )


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

    __table_args__ = (
        CheckConstraint("width > 0", name="ck_oracle_plates_width_positive"),
        CheckConstraint("width <= 4096", name="ck_oracle_plates_width_safe"),
        CheckConstraint("height > 0", name="ck_oracle_plates_height_positive"),
        CheckConstraint("height <= 4096", name="ck_oracle_plates_height_safe"),
        CheckConstraint("jsonb_typeof(tags) = 'array'", name="ck_oracle_plates_tags_array"),
        CheckConstraint(
            r"storage_key ~ '^oracle/plates/[a-z0-9][a-z0-9._-]{0,191}\.(jpg|png|webp)$'",
            name="ck_oracle_plates_storage_key_shape",
        ),
        CheckConstraint(
            "content_type IN ('image/jpeg', 'image/png', 'image/webp')",
            name="ck_oracle_plates_content_type",
        ),
        CheckConstraint("byte_size > 0", name="ck_oracle_plates_byte_size_positive"),
        CheckConstraint("byte_size <= 10485760", name="ck_oracle_plates_byte_size_safe"),
        CheckConstraint(
            """(
                (content_type = 'image/jpeg' AND storage_key LIKE '%.jpg')
                OR (content_type = 'image/png' AND storage_key LIKE '%.png')
                OR (content_type = 'image/webp' AND storage_key LIKE '%.webp')
            )""",
            name="ck_oracle_plates_storage_key_content_type_match",
        ),
        UniqueConstraint("source_url", name="uix_oracle_plates_source_url"),
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
        Index(
            "uq_oracle_readings_user_idempotency_key",
            "user_id",
            "idempotency_key",
            unique=True,
            postgresql_where=text("idempotency_key IS NOT NULL"),
        ),
        Index("idx_oracle_readings_user_created", "user_id", text("created_at DESC")),
        Index("idx_oracle_readings_user_image", "user_id", "image_id"),
        Index("idx_oracle_readings_user_theme", "user_id", "folio_theme"),
    )


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

    __table_args__ = (
        CheckConstraint(
            "phase IN ('descent', 'ordeal', 'ascent')",
            name="ck_oracle_reading_folios_phase",
        ),
        CheckConstraint(
            "source_kind IN ('user_media', 'public_domain')",
            name="ck_oracle_reading_folios_source_kind",
        ),
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
            "'meta', 'bind', 'argument', 'plate', 'passage', 'delta', 'omens', 'done'"
            ")",
            name="ck_oracle_reading_events_type",
        ),
        UniqueConstraint("reading_id", "seq", name="uix_oracle_reading_events_seq"),
        Index("idx_oracle_reading_events_reading_seq", "reading_id", "seq"),
    )
