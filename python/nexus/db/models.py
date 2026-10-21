"""The ORM mapping: one class per table that services query through the ORM.

The baseline SQL and the migrations after it are the only DDL. A class maps every column of
its table except generated ones. The annotation is the python type; an explicit SQL type
appears only where the annotation cannot imply it (bigint, jsonb, arrays, the enum, closed
text sets). Beyond that a class states its primary key and marks with
`server_default=FetchedValue()` each column the database fills when an insert omits it (the
ORM leaves it out of the INSERT and reads it back). No foreign key, constraint, index, delete
rule, precision or nullability is restated.

Runtime facts: nullable JSONB columns persist python None as SQL NULL (`none_as_null`), never
the JSON 'null' scalar; numeric columns read as Decimal. No class has a relationship except
Highlight's three anchors (and the pdf anchor's way back), so a flush inserts unrelated
classes in class-name order: flush a parent before adding its child.
"""

from datetime import date, datetime
from decimal import Decimal
from enum import Enum as PyEnum
from typing import Any, Literal
from uuid import UUID

from sqlalchemy import BigInteger, Enum, FetchedValue, ForeignKey, Text
from sqlalchemy.dialects.postgresql import ARRAY, JSONB, TIMESTAMP
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


class Base(DeclarativeBase):
    type_annotation_map = {
        UUID: PG_UUID(as_uuid=True),
        datetime: TIMESTAMP(timezone=True),
        str: Text(),
    }


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
    failed_provider = "failed_provider"


class TranscriptCoverage(str, PyEnum):
    """Coverage quality for transcript artifacts."""

    none = "none"
    partial = "partial"
    full = "full"


class SuggestionFeed(Base):
    """A requested viewer/destination and its one unfinished queue operation."""

    __tablename__ = "suggestion_feeds"
    id: Mapped[UUID] = mapped_column(primary_key=True)
    user_id: Mapped[UUID]
    library_id: Mapped[UUID | None]
    created_at: Mapped[datetime] = mapped_column(server_default=FetchedValue())
    current_job_id: Mapped[UUID | None]


class SuggestionShortlist(Base):
    """One successful, latest-only ranking publication; empty refs are a success."""

    __tablename__ = "suggestion_shortlists"
    id: Mapped[UUID] = mapped_column(primary_key=True)
    feed_id: Mapped[UUID]
    created_at: Mapped[datetime] = mapped_column(server_default=FetchedValue())
    ranked_at: Mapped[datetime]
    ranked_revision: Mapped[int] = mapped_column(BigInteger)
    target_refs: Mapped[list[str]] = mapped_column(JSONB)


class User(Base):
    """A user account; ``id`` is the Supabase auth user id (the token's ``sub``)."""

    __tablename__ = "users"
    id: Mapped[UUID] = mapped_column(primary_key=True, server_default=FetchedValue())
    email: Mapped[str | None]
    display_name: Mapped[str | None]
    calendar_time_zone: Mapped[str] = mapped_column(server_default=FetchedValue())
    lectern_order_revision: Mapped[int] = mapped_column(BigInteger, server_default=FetchedValue())
    created_at: Mapped[datetime] = mapped_column(server_default=FetchedValue())


class Page(Base):
    """Title-only page resource."""

    __tablename__ = "pages"
    id: Mapped[UUID] = mapped_column(primary_key=True, server_default=FetchedValue())
    user_id: Mapped[UUID]
    title: Mapped[str]
    created_at: Mapped[datetime] = mapped_column(server_default=FetchedValue())
    updated_at: Mapped[datetime] = mapped_column(server_default=FetchedValue())
    last_activity_at: Mapped[datetime] = mapped_column(server_default=FetchedValue())


class DailyPageBinding(Base):
    """Assign one account-local date to one ordinary Page."""

    __tablename__ = "daily_page_bindings"
    id: Mapped[UUID] = mapped_column(primary_key=True, server_default=FetchedValue())
    user_id: Mapped[UUID]
    local_date: Mapped[date]
    page_id: Mapped[UUID]
    created_at: Mapped[datetime] = mapped_column(server_default=FetchedValue())


class NoteBlock(Base):
    """Body-only note resource."""

    __tablename__ = "note_blocks"
    id: Mapped[UUID] = mapped_column(primary_key=True, server_default=FetchedValue())
    user_id: Mapped[UUID]
    body_pm_json: Mapped[dict[str, object]] = mapped_column(JSONB)
    body_text: Mapped[str]
    created_at: Mapped[datetime] = mapped_column(server_default=FetchedValue())
    updated_at: Mapped[datetime] = mapped_column(server_default=FetchedValue())
    last_activity_at: Mapped[datetime] = mapped_column(server_default=FetchedValue())


class ResourceVersion(Base):
    """Service-owned concurrency version for one resource lane."""

    __tablename__ = "resource_versions"
    id: Mapped[UUID] = mapped_column(primary_key=True, server_default=FetchedValue())
    user_id: Mapped[UUID]
    resource_scheme: Mapped[str]
    resource_id: Mapped[UUID]
    lane: Mapped[str]
    version: Mapped[int] = mapped_column(server_default=FetchedValue())
    created_at: Mapped[datetime] = mapped_column(server_default=FetchedValue())
    updated_at: Mapped[datetime] = mapped_column(server_default=FetchedValue())


class ResourceViewState(Base):
    """One link's rank at one endpoint: dense ``%010d`` display ``order_key`` and the
    conversation's independent admission ``context_order_key``.
    """

    __tablename__ = "resource_view_states"
    id: Mapped[UUID] = mapped_column(primary_key=True, server_default=FetchedValue())
    user_id: Mapped[UUID]
    surface_scheme: Mapped[str]
    surface_id: Mapped[UUID]
    edge_id: Mapped[UUID | None]
    target_scheme: Mapped[str | None]
    target_id: Mapped[UUID | None]
    order_key: Mapped[str | None]
    context_order_key: Mapped[str | None]
    created_at: Mapped[datetime] = mapped_column(server_default=FetchedValue())
    updated_at: Mapped[datetime] = mapped_column(server_default=FetchedValue())


class ResourceEdge(Base):
    """A provenance edge or undirected user link retaining its insertion endpoints."""

    __tablename__ = "resource_edges"
    id: Mapped[UUID] = mapped_column(primary_key=True, server_default=FetchedValue())
    user_id: Mapped[UUID]
    kind: Mapped[str]
    origin: Mapped[str]
    source_scheme: Mapped[str]
    source_id: Mapped[UUID]
    target_scheme: Mapped[str]
    target_id: Mapped[UUID]
    source_order_key: Mapped[str | None]
    ordinal: Mapped[int | None]
    snapshot: Mapped[dict[str, object] | None] = mapped_column(JSONB(none_as_null=True))
    created_at: Mapped[datetime] = mapped_column(server_default=FetchedValue())


class ResourceExternalSnapshot(Base):
    """Stable citation target for a public web result or other non-local resource."""

    __tablename__ = "resource_external_snapshots"
    id: Mapped[UUID] = mapped_column(primary_key=True, server_default=FetchedValue())
    user_id: Mapped[UUID]
    provider: Mapped[str]
    url: Mapped[str]
    title: Mapped[str]
    snippet: Mapped[str]
    created_at: Mapped[datetime] = mapped_column(server_default=FetchedValue())


class PassageAnchor(Base):
    """A user-owned durable passage identity within one owner (media or note_block). Owner,
    normalized quote and key are immutable; only the selector's locator_hint is replaceable.
    """

    __tablename__ = "passage_anchors"
    id: Mapped[UUID] = mapped_column(primary_key=True)
    user_id: Mapped[UUID]
    owner_scheme: Mapped[str]
    owner_id: Mapped[UUID]
    # sha256 hex of the canonical normalized quote {exact, prefix, suffix}.
    anchor_key: Mapped[str]
    # the quote identity plus a non-identity locator_hint.
    selector: Mapped[dict[str, object]] = mapped_column(JSONB)
    created_at: Mapped[datetime] = mapped_column(server_default=FetchedValue())


class Library(Base):
    """An access-control group + view over media."""

    __tablename__ = "libraries"
    id: Mapped[UUID] = mapped_column(primary_key=True, server_default=FetchedValue())
    owner_user_id: Mapped[UUID]
    name: Mapped[str]
    is_default: Mapped[bool] = mapped_column(server_default=FetchedValue())
    # a system library's identity ('oracle_corpus'); null for user libraries. it refuses rename,
    # delete, share and entry edits.
    system_key: Mapped[str | None]
    order_revision: Mapped[int] = mapped_column(BigInteger, server_default=FetchedValue())
    created_at: Mapped[datetime] = mapped_column(server_default=FetchedValue())
    updated_at: Mapped[datetime] = mapped_column(server_default=FetchedValue())


class Membership(Base):
    """User's role in a library."""

    __tablename__ = "memberships"
    library_id: Mapped[UUID] = mapped_column(primary_key=True)
    user_id: Mapped[UUID] = mapped_column(primary_key=True)
    role: Mapped[str]
    created_at: Mapped[datetime] = mapped_column(server_default=FetchedValue())


class MediaUploadSession(Base):
    """Viewer-owned durable intent for one upload: a local PDF/EPUB or a browser capture."""

    __tablename__ = "media_upload_sessions"
    id: Mapped[UUID] = mapped_column(primary_key=True)
    created_by_user_id: Mapped[UUID]
    candidate_media_id: Mapped[UUID]
    kind: Mapped[str]
    filename: Mapped[str]
    content_type: Mapped[str]
    expected_size_bytes: Mapped[int] = mapped_column(BigInteger)
    input_origin: Mapped[dict[str, object]] = mapped_column(JSONB)
    upload_generation: Mapped[int] = mapped_column(BigInteger)
    upload_url_expires_at: Mapped[datetime]
    verification_error_code: Mapped[str | None]
    verification_failed_at: Mapped[datetime | None]
    published_media_id: Mapped[UUID | None]
    published_source_attempt_id: Mapped[UUID | None]
    published_at: Mapped[datetime | None]
    created_at: Mapped[datetime] = mapped_column(server_default=FetchedValue())
    updated_at: Mapped[datetime] = mapped_column(server_default=FetchedValue())


class MediaUploadSessionDestination(Base):
    """One normalized library destination carried by upload intent."""

    __tablename__ = "media_upload_session_destinations"
    upload_session_id: Mapped[UUID] = mapped_column(primary_key=True)
    library_id: Mapped[UUID] = mapped_column(primary_key=True)
    created_at: Mapped[datetime] = mapped_column(server_default=FetchedValue())


class Media(Base):
    """A readable item (article, book, podcast, video, etc.)."""

    __tablename__ = "media"
    id: Mapped[UUID] = mapped_column(primary_key=True, server_default=FetchedValue())
    kind: Mapped[str]
    title: Mapped[str]
    canonical_source_url: Mapped[str | None]
    processing_status: Mapped[ProcessingStatus] = mapped_column(
        Enum(ProcessingStatus, name="processing_status_enum"), server_default=FetchedValue()
    )
    last_error_code: Mapped[str | None]
    last_error_message: Mapped[str | None]
    requested_url: Mapped[str | None]
    canonical_url: Mapped[str | None]
    external_playback_url: Mapped[str | None]
    provider: Mapped[str | None]
    provider_id: Mapped[str | None]
    # the captured bytes of a new browser capture, reused within the account.
    browser_capture_sha256: Mapped[str | None]
    created_by_user_id: Mapped[UUID | None]
    plain_text: Mapped[str | None]
    page_count: Mapped[int | None]
    # bibliography dates keep partial precision ("2023", "2023-01").
    original_published_date: Mapped[str | None]
    edition_published_date: Mapped[str | None]
    edition_isbn: Mapped[str | None]
    publisher: Mapped[str | None]
    language: Mapped[str | None]
    description: Mapped[str | None]
    metadata_enriched_at: Mapped[datetime | None]
    # author pin: automatic lanes never replace the author slice, even an empty one.
    authors_manually_managed: Mapped[bool] = mapped_column(server_default=FetchedValue())
    created_at: Mapped[datetime] = mapped_column(server_default=FetchedValue())
    updated_at: Mapped[datetime] = mapped_column(server_default=FetchedValue())


class MediaSourceAttempt(Base):
    """One link of a media's source chain (``services/source_attempts.py``)."""

    __tablename__ = "media_source_attempts"
    id: Mapped[UUID] = mapped_column(primary_key=True, server_default=FetchedValue())
    media_id: Mapped[UUID]
    created_by_user_id: Mapped[UUID | None]
    source_type: Mapped[str]
    attempt_no: Mapped[int]
    processing_stage: Mapped[str | None]
    progress_completed: Mapped[int] = mapped_column(server_default=FetchedValue())
    progress_total: Mapped[int | None]
    progress_unit: Mapped[str | None]
    progress_updated_at: Mapped[datetime | None]
    status: Mapped[str]
    requested_url: Mapped[str | None]
    canonical_source_url: Mapped[str | None]
    provider: Mapped[str | None]
    provider_target_ref: Mapped[str | None]
    source_payload: Mapped[dict[str, object]] = mapped_column(JSONB, server_default=FetchedValue())
    job_id: Mapped[UUID | None]
    error_code: Mapped[str | None]
    error_message: Mapped[str | None]
    finished_at: Mapped[datetime | None]
    created_at: Mapped[datetime] = mapped_column(server_default=FetchedValue())
    updated_at: Mapped[datetime] = mapped_column(server_default=FetchedValue())


class XPostSource(Base):
    """One canonical post's current body; its provider revisions are aliases."""

    __tablename__ = "x_post_sources"
    id: Mapped[UUID] = mapped_column(primary_key=True)
    media_id: Mapped[UUID]
    source_attempt_id: Mapped[UUID]
    source_revision_id: Mapped[str]
    logical_post_id: Mapped[str | None]
    edit_history_ids: Mapped[list[str] | None] = mapped_column(JSONB(none_as_null=True))
    payload: Mapped[dict[str, object]] = mapped_column(JSONB)
    availability: Mapped[str]
    body_captured_at: Mapped[datetime | None]
    checked_at: Mapped[datetime | None]


class XPostAlias(Base):
    """An exact provider revision belongs to one canonical post."""

    __tablename__ = "x_post_aliases"
    id: Mapped[UUID] = mapped_column(primary_key=True)
    revision_id: Mapped[str]
    post_media_id: Mapped[UUID]


class XThreadSource(Base):
    """A thread owns composition and the facts of its last membership capture."""

    __tablename__ = "x_thread_sources"
    id: Mapped[UUID] = mapped_column(primary_key=True)
    media_id: Mapped[UUID]
    source_attempt_id: Mapped[UUID]
    author_id: Mapped[str]
    root_post_media_id: Mapped[UUID | None]
    published_at: Mapped[datetime] = mapped_column(server_default=FetchedValue())
    membership_checked_at: Mapped[datetime | None]
    coverage: Mapped[dict[str, object]] = mapped_column(JSONB)


class XThreadPost(Base):
    """An ordered primary occurrence; published partial threads may overlap."""

    __tablename__ = "x_thread_posts"
    id: Mapped[UUID] = mapped_column(primary_key=True)
    thread_media_id: Mapped[UUID]
    post_media_id: Mapped[UUID]
    ordinal: Mapped[int]


class XArticleInspection(Base):
    """Current carrier inspection; no row means the carrier has not been inspected."""

    __tablename__ = "x_article_inspections"
    thread_media_id: Mapped[UUID] = mapped_column(primary_key=True)
    carrier_post_id: Mapped[str] = mapped_column(primary_key=True)
    article_id: Mapped[str | None]
    article_media_id: Mapped[UUID | None]


class XArticleSource(Base):
    """The attempt and completeness claim of a native article's current body."""

    __tablename__ = "x_article_sources"
    media_id: Mapped[UUID] = mapped_column(primary_key=True)
    source_attempt_id: Mapped[UUID]
    completeness: Mapped[Literal["unknown", "incomplete"]] = mapped_column(Text)


class MediaTeardownIntent(Base):
    """A durable claim that a media row is being torn down: its presence hides the media from every
    public visibility query and makes new references fail with ``E_MEDIA_DELETING``.
    """

    __tablename__ = "media_teardown_intents"
    id: Mapped[UUID] = mapped_column(primary_key=True)
    media_id: Mapped[UUID]
    created_at: Mapped[datetime] = mapped_column(server_default=FetchedValue())


class ProjectGutenbergCatalogEntry(Base):
    """Local mirror of the Project Gutenberg catalog metadata feed."""

    __tablename__ = "project_gutenberg_catalog"
    ebook_id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    title: Mapped[str]
    subjects: Mapped[str | None]
    bookshelves: Mapped[str | None]
    download_count: Mapped[int | None]
    created_at: Mapped[datetime] = mapped_column(server_default=FetchedValue())
    updated_at: Mapped[datetime] = mapped_column(server_default=FetchedValue())


class Contributor(Base):
    """Canonical person, organization, group, or local creator identity."""

    __tablename__ = "contributors"
    id: Mapped[UUID] = mapped_column(primary_key=True, server_default=FetchedValue())
    handle: Mapped[str]
    display_name: Mapped[str]
    created_at: Mapped[datetime] = mapped_column(server_default=FetchedValue())
    updated_at: Mapped[datetime] = mapped_column(server_default=FetchedValue())


class ContributorAlias(Base):
    """Searchable name associated with a contributor."""

    __tablename__ = "contributor_aliases"
    id: Mapped[UUID] = mapped_column(primary_key=True, server_default=FetchedValue())
    contributor_id: Mapped[UUID]
    alias: Mapped[str]
    normalized_alias: Mapped[str]
    resolves_identity: Mapped[bool]
    created_at: Mapped[datetime] = mapped_column(server_default=FetchedValue())


class ContributorExternalId(Base):
    """Provider or authority identifier for a contributor."""

    __tablename__ = "contributor_external_ids"
    id: Mapped[UUID] = mapped_column(primary_key=True, server_default=FetchedValue())
    contributor_id: Mapped[UUID]
    authority: Mapped[str]
    external_key: Mapped[str]
    created_at: Mapped[datetime] = mapped_column(server_default=FetchedValue())


class ContributorCredit(Base):
    """Ordered contributor credit on a media item, podcast, or catalog item."""

    __tablename__ = "contributor_credits"
    id: Mapped[UUID] = mapped_column(primary_key=True, server_default=FetchedValue())
    contributor_id: Mapped[UUID]
    media_id: Mapped[UUID | None]
    podcast_id: Mapped[UUID | None]
    project_gutenberg_catalog_ebook_id: Mapped[int | None] = mapped_column(BigInteger)
    credited_name: Mapped[str]
    role: Mapped[str]
    raw_role: Mapped[str | None]
    ordinal: Mapped[int]
    source: Mapped[str]
    created_at: Mapped[datetime] = mapped_column(server_default=FetchedValue())
    updated_at: Mapped[datetime] = mapped_column(server_default=FetchedValue())


class MediaFile(Base):
    """Media file storage metadata (0..1 per media)."""

    __tablename__ = "media_file"
    media_id: Mapped[UUID] = mapped_column(primary_key=True)
    storage_path: Mapped[str]
    content_type: Mapped[str]
    size_bytes: Mapped[int] = mapped_column(BigInteger)
    source_sha256: Mapped[str]


class ReaderPublication(Base):
    """Current document publication generation for offline fencing."""

    __tablename__ = "reader_publications"
    id: Mapped[UUID] = mapped_column(primary_key=True)
    media_id: Mapped[UUID]
    generation: Mapped[int] = mapped_column(BigInteger)
    source_issues: Mapped[list[dict[str, object]]] = mapped_column(
        JSONB, server_default=FetchedValue()
    )
    changed_at: Mapped[datetime] = mapped_column(server_default=FetchedValue())


class Fragment(Base):
    """An immutable render unit of a media item."""

    __tablename__ = "fragments"
    id: Mapped[UUID] = mapped_column(primary_key=True, server_default=FetchedValue())
    media_id: Mapped[UUID]
    idx: Mapped[int]
    canonical_text: Mapped[str]
    html_sanitized: Mapped[str]
    t_start_ms: Mapped[int | None] = mapped_column(BigInteger)
    t_end_ms: Mapped[int | None] = mapped_column(BigInteger)
    speaker_label: Mapped[str | None]
    created_at: Mapped[datetime] = mapped_column(server_default=FetchedValue())


class DocumentEmbedArtifactState(Base):
    """Aggregate inline-embed extraction state for one current readable media artifact."""

    __tablename__ = "document_embed_artifact_states"
    id: Mapped[UUID] = mapped_column(primary_key=True, server_default=FetchedValue())
    media_id: Mapped[UUID]
    source_attempt_id: Mapped[UUID | None]
    status: Mapped[str]
    total_count: Mapped[int] = mapped_column(server_default=FetchedValue())
    resolved_count: Mapped[int] = mapped_column(server_default=FetchedValue())
    unsupported_count: Mapped[int] = mapped_column(server_default=FetchedValue())
    failed_count: Mapped[int] = mapped_column(server_default=FetchedValue())
    diagnostics: Mapped[dict[str, object]] = mapped_column(JSONB, server_default=FetchedValue())
    created_at: Mapped[datetime] = mapped_column(server_default=FetchedValue())
    updated_at: Mapped[datetime] = mapped_column(server_default=FetchedValue())


class DocumentEmbed(Base):
    """One source-authored inline embed occurrence in the current readable artifact."""

    __tablename__ = "document_embeds"
    id: Mapped[UUID] = mapped_column(primary_key=True, server_default=FetchedValue())
    media_id: Mapped[UUID]
    fragment_id: Mapped[UUID | None]
    source_attempt_id: Mapped[UUID | None]
    ordinal: Mapped[int]
    occurrence_key: Mapped[str]
    provider: Mapped[str]
    embed_kind: Mapped[str]
    source_shape: Mapped[str]
    resolution_status: Mapped[str]
    source_url: Mapped[str | None]
    canonical_source_url: Mapped[str | None]
    provider_target_ref: Mapped[str | None]
    target_media_id: Mapped[UUID | None]
    title: Mapped[str | None]
    description: Mapped[str | None]
    thumbnail_url: Mapped[str | None]
    authored_text: Mapped[str | None]
    placeholder_text: Mapped[str]
    source_start_offset: Mapped[int | None]
    source_end_offset: Mapped[int | None]
    canonical_start_offset: Mapped[int | None]
    canonical_end_offset: Mapped[int | None]
    document_order_key: Mapped[str]
    error_code: Mapped[str | None]
    error_message: Mapped[str | None]
    diagnostics: Mapped[dict[str, object]] = mapped_column(JSONB, server_default=FetchedValue())
    created_at: Mapped[datetime] = mapped_column(server_default=FetchedValue())
    updated_at: Mapped[datetime] = mapped_column(server_default=FetchedValue())


class LibraryEntry(Base):
    """Association between a library and exactly one content target."""

    __tablename__ = "library_entries"
    id: Mapped[UUID] = mapped_column(primary_key=True, server_default=FetchedValue())
    library_id: Mapped[UUID]
    media_id: Mapped[UUID | None]
    podcast_id: Mapped[UUID | None]
    created_at: Mapped[datetime] = mapped_column(server_default=FetchedValue())
    position: Mapped[int] = mapped_column(server_default=FetchedValue())


class Podcast(Base):
    """Global podcast metadata from discovery providers."""

    __tablename__ = "podcasts"
    id: Mapped[UUID] = mapped_column(primary_key=True, server_default=FetchedValue())
    provider: Mapped[str]
    provider_podcast_id: Mapped[str]
    title: Mapped[str]
    feed_url: Mapped[str]
    website_url: Mapped[str | None]
    image_url: Mapped[str | None]
    description: Mapped[str | None]
    created_at: Mapped[datetime] = mapped_column(server_default=FetchedValue())
    updated_at: Mapped[datetime] = mapped_column(server_default=FetchedValue())


class Highlight(Base):
    """A user-owned selection anchored to media content: ``fragment_offsets`` (half-open over
    canonical_text) or ``pdf_page_geometry``.
    """

    __tablename__ = "highlights"
    id: Mapped[UUID] = mapped_column(primary_key=True, server_default=FetchedValue())
    user_id: Mapped[UUID]
    anchor_kind: Mapped[str | None]
    anchor_media_id: Mapped[UUID | None]
    color: Mapped[str]
    exact: Mapped[str]
    prefix: Mapped[str]
    suffix: Mapped[str]
    created_at: Mapped[datetime] = mapped_column(server_default=FetchedValue())
    updated_at: Mapped[datetime] = mapped_column(server_default=FetchedValue())
    fragment_anchor: Mapped["HighlightFragmentAnchor | None"] = relationship()
    pdf_anchor: Mapped["HighlightPdfAnchor | None"] = relationship(back_populates="highlight")
    pdf_quads: Mapped[list["HighlightPdfQuad"]] = relationship()


class HighlightFragmentAnchor(Base):
    """Fragment-offset anchor subtype (1:1 with highlights)."""

    __tablename__ = "highlight_fragment_anchors"
    highlight_id: Mapped[UUID] = mapped_column(ForeignKey("highlights.id"), primary_key=True)
    fragment_id: Mapped[UUID]
    start_offset: Mapped[int]
    end_offset: Mapped[int]


class HighlightPdfAnchor(Base):
    """PDF geometry anchor subtype (1:1 with highlights): page-space geometry metadata."""

    __tablename__ = "highlight_pdf_anchors"
    highlight_id: Mapped[UUID] = mapped_column(ForeignKey("highlights.id"), primary_key=True)
    media_id: Mapped[UUID]
    page_number: Mapped[int]
    sort_top: Mapped[Decimal]
    sort_left: Mapped[Decimal]
    rect_count: Mapped[int]
    created_at: Mapped[datetime] = mapped_column(server_default=FetchedValue())
    highlight: Mapped["Highlight"] = relationship(back_populates="pdf_anchor")


class HighlightPdfQuad(Base):
    """PDF geometry segment (quad/rect) for a PDF highlight."""

    __tablename__ = "highlight_pdf_quads"
    highlight_id: Mapped[UUID] = mapped_column(ForeignKey("highlights.id"), primary_key=True)
    quad_idx: Mapped[int] = mapped_column(primary_key=True)
    x1: Mapped[Decimal]
    y1: Mapped[Decimal]
    x2: Mapped[Decimal]
    y2: Mapped[Decimal]
    x3: Mapped[Decimal]
    y3: Mapped[Decimal]
    x4: Mapped[Decimal]
    y4: Mapped[Decimal]


class PdfPageTextSpan(Base):
    """Page-indexed offsets into media.plain_text for PDF quote matching."""

    __tablename__ = "pdf_page_text_spans"
    media_id: Mapped[UUID] = mapped_column(primary_key=True)
    page_number: Mapped[int] = mapped_column(primary_key=True)
    start_offset: Mapped[int]
    end_offset: Mapped[int]
    page_label: Mapped[str | None]
    page_width: Mapped[float | None]
    page_height: Mapped[float | None]
    page_rotation_degrees: Mapped[int | None]
    created_at: Mapped[datetime] = mapped_column(server_default=FetchedValue())


class Conversation(Base):
    """A thread of messages owned by one user."""

    __tablename__ = "conversations"
    id: Mapped[UUID] = mapped_column(primary_key=True, server_default=FetchedValue())
    owner_user_id: Mapped[UUID]
    title: Mapped[str] = mapped_column(server_default=FetchedValue())
    next_seq: Mapped[int] = mapped_column(server_default=FetchedValue())
    branch_revision: Mapped[int] = mapped_column(server_default=FetchedValue())
    # null exactly when empty; admission, selection and deletion keep a leaf.
    active_leaf_message_id: Mapped[UUID | None]
    created_at: Mapped[datetime] = mapped_column(server_default=FetchedValue())
    updated_at: Mapped[datetime] = mapped_column(server_default=FetchedValue())


class LLMCall(Base):
    """One generation, opened before dispatch and closed once (sole writer: the ledger)."""

    __tablename__ = "llm_calls"
    id: Mapped[UUID] = mapped_column(primary_key=True, server_default=FetchedValue())
    owner_kind: Mapped[str]
    owner_id: Mapped[UUID]
    generation_seq: Mapped[int]
    generation_spec: Mapped[dict[str, object]] = mapped_column(JSONB(none_as_null=True))
    # the job attempt that runs it; finished jobs are pruned, so it may dangle.
    job_id: Mapped[UUID | None]
    outcome: Mapped[str | None]
    failure_code: Mapped[str | None]
    terminal: Mapped[dict[str, object] | None] = mapped_column(JSONB(none_as_null=True))
    usage: Mapped[dict[str, object] | None] = mapped_column(JSONB(none_as_null=True))
    created_at: Mapped[datetime] = mapped_column(server_default=FetchedValue())
    completed_at: Mapped[datetime | None]


class Message(Base):
    """A single message in a conversation."""

    __tablename__ = "messages"
    id: Mapped[UUID] = mapped_column(primary_key=True, server_default=FetchedValue())
    conversation_id: Mapped[UUID]
    seq: Mapped[int]
    role: Mapped[Literal["user", "assistant"]] = mapped_column(Text)
    content: Mapped[str]
    # the immutable reader-quote snapshot of a quoted user message.
    reader_selection_snapshot: Mapped[dict[str, object] | None] = mapped_column(
        JSONB(none_as_null=True)
    )
    status: Mapped[Literal["pending", "complete", "error", "cancelled"]] = mapped_column(
        Text, server_default=FetchedValue()
    )
    parent_message_id: Mapped[UUID | None]
    branch_anchor_kind: Mapped[str] = mapped_column(server_default=FetchedValue())
    branch_anchor: Mapped[dict[str, object]] = mapped_column(JSONB, server_default=FetchedValue())
    # a user turn's optional fork name (the Forks outline title).
    fork_title: Mapped[str | None]
    created_at: Mapped[datetime] = mapped_column(server_default=FetchedValue())
    updated_at: Mapped[datetime] = mapped_column(server_default=FetchedValue())


class ToolCall(Base):
    """One model tool call that reached dispatch (sole writer: ``services.tools.run``)."""

    __tablename__ = "tool_calls"
    id: Mapped[UUID] = mapped_column(primary_key=True)
    generation_id: Mapped[UUID]
    generation_seq: Mapped[int]
    position: Mapped[int]
    principal_user_id: Mapped[UUID]
    assistant_message_id: Mapped[UUID | None]
    tool_id: Mapped[str]
    arguments: Mapped[object | None] = mapped_column(JSONB(none_as_null=True))
    result: Mapped[dict[str, Any] | None] = mapped_column(JSONB(none_as_null=True))
    created_refs: Mapped[list[dict[str, Any]]] = mapped_column(JSONB, server_default=FetchedValue())
    status: Mapped[str]
    created_at: Mapped[datetime] = mapped_column(server_default=FetchedValue())
    reverted_at: Mapped[datetime | None]


class MessageRetrieval(Base):
    """One result an answer retrieved: by a tool call, or attached as context."""

    __tablename__ = "message_retrievals"
    id: Mapped[UUID] = mapped_column(primary_key=True, server_default=FetchedValue())
    assistant_message_id: Mapped[UUID]
    # null: the answer's attached context, retrieved by no call.
    tool_call_id: Mapped[UUID | None]
    ordinal: Mapped[int]
    result_type: Mapped[str]
    source_id: Mapped[str]
    media_id: Mapped[UUID | None]
    evidence_span_id: Mapped[UUID | None]
    context_ref: Mapped[dict[str, object]] = mapped_column(JSONB)
    captured_evidence: Mapped[dict[str, Any]] = mapped_column(JSONB)
    result_ref: Mapped[dict[str, object]] = mapped_column(JSONB)
    selected: Mapped[bool] = mapped_column(server_default=FetchedValue())
    locator: Mapped[dict[str, object] | None] = mapped_column(JSONB(none_as_null=True))
    citation_candidate_ordinal: Mapped[int | None]
    # the citation edge, set when this result is cited; may dangle.
    cited_edge_id: Mapped[UUID | None]
    created_at: Mapped[datetime] = mapped_column(server_default=FetchedValue())


class ChatRun(Base):
    """Durable lifecycle row for one user chat send."""

    __tablename__ = "chat_runs"
    id: Mapped[UUID] = mapped_column(primary_key=True, server_default=FetchedValue())
    owner_user_id: Mapped[UUID]
    conversation_id: Mapped[UUID]
    user_message_id: Mapped[UUID]
    assistant_message_id: Mapped[UUID]
    generation_spec: Mapped[dict[str, object]] = mapped_column(JSONB(none_as_null=True))
    # the frozen prompt (GenerationIntent) the worker runs; never re-read live.
    generation_intent: Mapped[dict[str, object]] = mapped_column(JSONB(none_as_null=True))
    admitted_context_version: Mapped[int | None]
    status: Mapped[str] = mapped_column(server_default=FetchedValue())
    cancel_requested_at: Mapped[datetime | None]
    started_at: Mapped[datetime | None]
    completed_at: Mapped[datetime | None]
    error_code: Mapped[str | None]
    support_id: Mapped[str | None]
    publication_warning_code: Mapped[str | None]
    created_at: Mapped[datetime] = mapped_column(server_default=FetchedValue())
    updated_at: Mapped[datetime] = mapped_column(server_default=FetchedValue())


class ChatRunEvent(Base):
    """Append-only replay event for a chat run."""

    __tablename__ = "chat_run_events"
    id: Mapped[UUID] = mapped_column(primary_key=True, server_default=FetchedValue())
    run_id: Mapped[UUID]
    seq: Mapped[int]
    event_type: Mapped[str]
    payload: Mapped[dict[str, object]] = mapped_column(JSONB)
    created_at: Mapped[datetime] = mapped_column(server_default=FetchedValue())


class ExtensionSession(Base):
    """Opaque bearer token for browser capture."""

    __tablename__ = "extension_sessions"
    id: Mapped[UUID] = mapped_column(primary_key=True, server_default=FetchedValue())
    user_id: Mapped[UUID]
    token_hash: Mapped[str]
    created_at: Mapped[datetime] = mapped_column(server_default=FetchedValue())
    last_used_at: Mapped[datetime | None]
    revoked_at: Mapped[datetime | None]


class AuthHandoffCode(Base):
    """A single-use code that hands a Supabase session into the Android WebView."""

    __tablename__ = "auth_handoff_codes"
    id: Mapped[UUID] = mapped_column(primary_key=True, server_default=FetchedValue())
    user_id: Mapped[UUID]
    code_hash: Mapped[str]
    challenge: Mapped[str]
    access_token: Mapped[str]
    refresh_token: Mapped[str]
    created_at: Mapped[datetime] = mapped_column(server_default=FetchedValue())
    expires_at: Mapped[datetime]


class ResourceGrant(Base):
    """One active user or bearer-link path to an exact ResourceRef subject."""

    __tablename__ = "resource_grants"
    id: Mapped[UUID] = mapped_column(primary_key=True)
    subject_scheme: Mapped[str]
    subject_id: Mapped[UUID]
    created_by_user_id: Mapped[UUID]
    grantee_user_id: Mapped[UUID | None]
    # as the creator typed it; null when they found the grantee by name.
    grantee_email: Mapped[str | None]
    share_token: Mapped[str | None]
    created_at: Mapped[datetime] = mapped_column(server_default=FetchedValue())


class EpubTocNode(Base):
    """Persisted EPUB navigation node."""

    __tablename__ = "epub_toc_nodes"
    media_id: Mapped[UUID] = mapped_column(primary_key=True)
    node_id: Mapped[str] = mapped_column(primary_key=True)
    nav_type: Mapped[str] = mapped_column(server_default=FetchedValue())
    parent_node_id: Mapped[str | None]
    label: Mapped[str]
    href: Mapped[str | None]
    fragment_idx: Mapped[int | None]
    target_offset: Mapped[int | None]
    section_id: Mapped[str | None]
    resolution: Mapped[str]
    depth: Mapped[int]
    order_key: Mapped[str]
    created_at: Mapped[datetime] = mapped_column(server_default=FetchedValue())


class EpubNavLocation(Base):
    """Canonical EPUB section/navigation targets."""

    __tablename__ = "epub_nav_locations"
    media_id: Mapped[UUID] = mapped_column(primary_key=True)
    location_id: Mapped[str] = mapped_column(primary_key=True)
    ordinal: Mapped[int]
    parent_section_id: Mapped[str | None]
    label: Mapped[str]
    fragment_idx: Mapped[int]
    href_path: Mapped[str | None]
    href_fragment: Mapped[str | None]
    start_offset: Mapped[int]
    end_fragment_idx: Mapped[int | None]
    end_offset: Mapped[int | None]
    source: Mapped[str]
    created_at: Mapped[datetime] = mapped_column(server_default=FetchedValue())


class EpubFragmentSource(Base):
    """EPUB package source metadata for one persisted fragment."""

    __tablename__ = "epub_fragment_sources"
    id: Mapped[UUID] = mapped_column(primary_key=True, server_default=FetchedValue())
    media_id: Mapped[UUID]
    fragment_id: Mapped[UUID]
    package_href: Mapped[str]
    created_at: Mapped[datetime] = mapped_column(server_default=FetchedValue())


class EpubResource(Base):
    """Stored EPUB package resource owned by one media row."""

    __tablename__ = "epub_resources"
    id: Mapped[UUID] = mapped_column(primary_key=True, server_default=FetchedValue())
    media_id: Mapped[UUID]
    package_href: Mapped[str]
    asset_key: Mapped[str]
    storage_path: Mapped[str]
    content_type: Mapped[str]
    size_bytes: Mapped[int] = mapped_column(BigInteger)
    created_at: Mapped[datetime] = mapped_column(server_default=FetchedValue())


class FragmentBlock(Base):
    """Block boundary index for context window computation."""

    __tablename__ = "fragment_blocks"
    id: Mapped[UUID] = mapped_column(primary_key=True, server_default=FetchedValue())
    fragment_id: Mapped[UUID]
    block_idx: Mapped[int]
    start_offset: Mapped[int]
    end_offset: Mapped[int]


class ReaderProfile(Base):
    """Per-user reader defaults."""

    __tablename__ = "reader_profiles"
    user_id: Mapped[UUID] = mapped_column(primary_key=True)
    theme: Mapped[str]
    font_size_px: Mapped[int]
    line_height: Mapped[Decimal]
    font_family: Mapped[str]
    column_width_ch: Mapped[int]
    focus_mode: Mapped[str]
    hyphenation: Mapped[str]
    # creation metadata only; READER_PROFILE_DEFAULTS owns preference defaults.
    created_at: Mapped[datetime] = mapped_column(server_default=FetchedValue())


class WorkspaceSession(Base):
    """Per user + device persisted workspace pane set."""

    __tablename__ = "workspace_sessions"
    id: Mapped[UUID] = mapped_column(primary_key=True, server_default=FetchedValue())
    user_id: Mapped[UUID]
    device_id: Mapped[str]
    state: Mapped[dict[str, object]] = mapped_column(JSONB)
    created_at: Mapped[datetime] = mapped_column(server_default=FetchedValue())
    updated_at: Mapped[datetime] = mapped_column(server_default=FetchedValue())


class OracleCorpusSource(Base):
    """One corpus work (``corpus.json`` key) and the system media that holds its text."""

    __tablename__ = "oracle_corpus_sources"
    id: Mapped[UUID] = mapped_column(primary_key=True, server_default=FetchedValue())
    work_key: Mapped[str]
    media_id: Mapped[UUID]
    title: Mapped[str]
    author_text: Mapped[str]
    source_download_url: Mapped[str]
    source_media_kind: Mapped[str]
    created_at: Mapped[datetime] = mapped_column(server_default=FetchedValue())


class OraclePassageAnchor(Base):
    """One curated passage and its cache pointers into its work's current index."""

    __tablename__ = "oracle_passage_anchors"
    id: Mapped[UUID] = mapped_column(primary_key=True, server_default=FetchedValue())
    corpus_source_id: Mapped[UUID]
    passage_key: Mapped[str]
    display_label: Mapped[str]
    quote: Mapped[str]
    tags: Mapped[list[str]] = mapped_column(JSONB, server_default=FetchedValue())
    current_evidence_span_id: Mapped[UUID | None]
    current_content_chunk_id: Mapped[UUID | None]
    resolution_status: Mapped[str] = mapped_column(server_default=FetchedValue())
    created_at: Mapped[datetime] = mapped_column(server_default=FetchedValue())


class OracleReading(Base):
    """One reading: pending until one transaction makes it complete or failed; history folded in by
    0262 may be partial or ``streaming``.
    """

    __tablename__ = "oracle_readings"
    id: Mapped[UUID] = mapped_column(primary_key=True)
    user_id: Mapped[UUID]
    folio_number: Mapped[int]
    question_text: Mapped[str]
    status: Mapped[str] = mapped_column(server_default=FetchedValue())
    folio_motto: Mapped[str | None]
    folio_motto_gloss: Mapped[str | None]
    folio_theme: Mapped[str | None]
    argument_text: Mapped[str | None]
    interpretation_text: Mapped[str | None]
    omens: Mapped[list[str]] = mapped_column(ARRAY(Text), server_default=FetchedValue())
    plate_key: Mapped[str | None]
    # schemas.oracle.OraclePlateOut as publication (or history) showed it.
    plate: Mapped[dict[str, object] | None] = mapped_column(JSONB(none_as_null=True))
    # OracleStoredPassage list: descent, ordeal, ascent.
    passages: Mapped[list[dict[str, object]]] = mapped_column(JSONB, server_default=FetchedValue())
    error_code: Mapped[str | None]
    error_detail: Mapped[str | None]
    # set by the retired streaming writers; a pending reading with it shows `streaming`.
    started_at: Mapped[datetime | None]
    completed_at: Mapped[datetime | None]
    failed_at: Mapped[datetime | None]
    created_at: Mapped[datetime] = mapped_column(server_default=FetchedValue())
