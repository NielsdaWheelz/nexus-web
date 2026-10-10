"""Web articles: fetched through the egress, extracted by the node filter, and published.

``publish_article`` is the one publisher for fetched pages, browser captures and
emails; X reuses its primitives ``prepare_article`` and ``replace_article_fragments``.
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from uuid import UUID

from sqlalchemy import delete, select, text
from sqlalchemy.orm import Session, sessionmaker

from nexus.config import get_settings
from nexus.db.models import Fragment, FragmentBlock, Media, MediaKind, MediaSourceAttempt
from nexus.errors import ApiError, ApiErrorCode
from nexus.logging import get_logger
from nexus.schemas.presence import Present, present
from nexus.schemas.publication_dates import normalize_source_publication_date
from nexus.services import contributor_taxonomy as taxonomy
from nexus.services import document_embeds as embeds
from nexus.services import html_apparatus as apparatus
from nexus.services.collection_revisions import CollectionFamily, bump_all_collection_families
from nexus.services.fragment_blocks import insert_fragment_blocks
from nexus.services.media_source_ingest import (
    enqueue_accepted_source_attempt_in_transaction,
    reusable_embedded_source_media_ids,
)
from nexus.services.net.safe_fetch import SafeFetchFailed, safe_stream, source_fetch_error
from nexus.services.reader_apparatus import replace_media_apparatus
from nexus.services.reader_publication import ReplaceSourceIssues, replace_reader_publication
from nexus.services.source_outcome import SourceRunOutcome, source_contributor_observations
from nexus.services.source_publication import SourcePublicationFence, run_source_publication_phase
from nexus.services.url_normalize import normalize_url_for_display
from nexus.services.web_article_structure import (
    WebArticlePreparedFragment,
    document_embed_artifact_occurrences,
    prepare_web_article_fragment,
)

logger = get_logger(__name__)

_MAX_HTML_BYTES = 10 * 1024 * 1024
_REQUEST_HEADERS = {
    "Accept": "text/html,application/xhtml+xml",
    "Accept-Encoding": "gzip, deflate",
    "Accept-Language": "en-US,en;q=0.5",
    "User-Agent": "NexusBot/1.0 (+https://nexus.example.com/bot)",
}
_EXTRACTION_FAILURES = {
    "Readability": (ApiErrorCode.E_SOURCE_NOT_READABLE, "Source has no readable article."),
    "TooLarge": (ApiErrorCode.E_SOURCE_TOO_LARGE, "Source exceeds the import size limit."),
}
_EXTRACTED_FIELDS = (
    "final_url base_url title content_html source_html byline excerpt site_name published_time"
).split()


@dataclass(frozen=True, slots=True)
class ArticleMetadata:
    title: str
    byline: str
    excerpt: str
    site_name: str
    published_time: str


@dataclass(frozen=True, slots=True)
class Article:
    content_html: str  # the readable article
    source_html: str | None  # the page around it: embed and note evidence
    base_url: str  # resolves relative links, honoring an authored <base>
    document_url: str  # the page itself: its fragment targets stay local
    extract_embeds: bool  # False purges the embed artifact
    metadata: ArticleMetadata | None  # None: title, metadata and credits stay as they are


def publish_fetched_article(
    session_factory: sessionmaker[Session],
    *,
    media_id: UUID,
    attempt: MediaSourceAttempt,
    request_id: str | None,
    fence: SourcePublicationFence,
) -> SourceRunOutcome:
    """Fetch the attempt's URL; supersede onto the article holding its final URL, or publish."""
    if not attempt.requested_url:
        raise ApiError(ApiErrorCode.E_INGEST_FAILED, "No requested_url on media")
    page = _fetch(attempt.requested_url)
    canonical_url = normalize_url_for_display(page["final_url"])
    winner_id = run_source_publication_phase(
        session_factory=session_factory,
        label="publish_web_canonical_identity",
        fence=fence,
        media_ids=(media_id,),
        mutate=lambda db, _attempt: _claim_canonical_url(db, media_id, canonical_url),
    )
    if winner_id is not None:
        return SourceRunOutcome(
            diagnostics={"status": "deduped", "canonical_url": canonical_url},
            superseded_by_media_id=present(winner_id),
        )
    metadata = ArticleMetadata(
        page["title"], page["byline"], page["excerpt"], page["site_name"], page["published_time"]
    )
    fragment_id = publish_article(
        session_factory,
        media_id=media_id,
        request_id=request_id,
        fence=fence,
        article=Article(
            content_html=page["content_html"],
            source_html=page["source_html"],
            base_url=page["base_url"],
            document_url=page["final_url"],
            extract_embeds=(attempt.source_payload or {}).get("ingest_purpose")
            != "artifact_research",
            metadata=metadata,
        ),
    )
    return SourceRunOutcome(
        diagnostics={
            "status": "success",
            "canonical_url": canonical_url,
            "title": page["title"],
            "fragment_id": str(fragment_id),
        },
        observations=source_contributor_observations(
            media_id=media_id,
            observation=byline_observation(page["byline"]),
            source="web_article_byline",
        ),
        metadata_enrichment=present(True),
    )


def publish_article(
    session_factory: sessionmaker[Session],
    *,
    media_id: UUID,
    request_id: str | None,
    fence: SourcePublicationFence,
    article: Article,
) -> UUID:
    """Prepare outside any transaction, then replace the reader content in one fenced phase.

    Pre-existing embed children are discovered in the phase's serializable snapshot before
    any lock, so they lock with the media in ascending id order. Returns the fragment id.
    """
    prepared = prepare_article(
        article.content_html,
        base_url=article.base_url,
        document_url=article.document_url,
        extract_embeds=article.extract_embeds,
        embed_source_html=article.source_html,
    )
    embed_urls = [
        embed.detected.canonical_source_url
        for embed in prepared.document_embeds
        if embed.detected.resolution_status == "pending" and embed.detected.canonical_source_url
    ]
    children: list[UUID] = []

    def discover(db: Session) -> list[UUID]:
        children[:] = sorted(reusable_embedded_source_media_ids(db, urls=embed_urls))
        return children

    def project(db: Session, media: Media, attempt: MediaSourceAttempt) -> UUID:
        owner = media.created_by_user_id or attempt.created_by_user_id
        if owner is None:
            raise ApiError(ApiErrorCode.E_INTERNAL, "Web article has no owner.")
        [fragment_id] = replace_article_fragments(
            db, media_id=media.id, fragments=[(prepared, article.content_html)]
        )
        if not article.extract_embeds:
            embeds.delete_document_embed_artifacts(db, owner_user_id=owner, media_id=media.id)
        else:
            queued = embeds.replace_document_embed_artifact(
                db,
                owner_user_id=owner,
                media_id=media.id,
                source_attempt_id=attempt.id,
                occurrences=document_embed_artifact_occurrences(
                    fragment_id=fragment_id, document_embeds=prepared.document_embeds
                ),
                extraction_failed=prepared.document_embed_extraction_failed,
                locked_existing_target_media_ids=frozenset(children),
            )
            for child_media_id, child_attempt_id in queued:
                enqueue_accepted_source_attempt_in_transaction(
                    db,
                    media_id=child_media_id,
                    attempt_id=child_attempt_id,
                    actor_user_id=owner,
                    request_id=request_id,
                )
        if (metadata := article.metadata) is not None:
            title, excerpt = metadata.title.strip(), metadata.excerpt.strip()
            site_name = metadata.site_name.strip()
            if title:
                media.title = title[:255]
            if excerpt and not media.description:
                media.description = excerpt[:2000]
            if site_name and not media.publisher:
                media.publisher = site_name[:255]
            edition = normalize_source_publication_date(metadata.published_time)
            if isinstance(edition, Present):
                media.edition_published_date = edition.value
        bump_all_collection_families(
            db, families=(CollectionFamily.AuthorWorks, CollectionFamily.LibraryEntries)
        )
        return fragment_id

    return run_source_publication_phase(
        session_factory=session_factory,
        label="publish_web_article_artifacts",
        fence=fence,
        media_ids=(media_id,),
        mutate=lambda db, attempt: replace_reader_publication(
            db,
            media_id=media_id,
            expected_kind="web_article",
            issues=ReplaceSourceIssues(issues=()),
            replace_projection=lambda media: project(db, media, attempt),
        ),
        discover=discover,
    )


def prepare_article(
    html: str,
    *,
    base_url: str,
    document_url: str,
    extract_embeds: bool,
    embed_source_html: str | None = None,
    fragment_idx: int = 0,
) -> WebArticlePreparedFragment:
    """Prepare one fragment, refusing what cannot be published.

    Preparation is a pure function of its input, so any failure would recur: each is
    the terminal ``E_SANITIZATION_FAILED``. Blank text is not readable.
    """
    try:
        prepared = prepare_web_article_fragment(
            html=html,
            base_url=base_url,
            document_url=document_url,
            fragment_idx=fragment_idx,
            extract_embeds=extract_embeds,
            embed_source_html=embed_source_html,
        )
    # justify-ignore-error: deterministic preparation; the class is logged, the code is terminal.
    except Exception as exc:
        logger.warning("web_article_prepare_failed", error_class=type(exc).__name__)
        raise ApiError(
            ApiErrorCode.E_SANITIZATION_FAILED, "Article could not be prepared."
        ) from exc
    if not prepared.canonical_text.strip():
        raise ApiError(ApiErrorCode.E_SOURCE_NOT_READABLE, "Article has no readable text.")
    return prepared


def replace_article_fragments(
    db: Session, *, media_id: UUID, fragments: Sequence[tuple[WebArticlePreparedFragment, str]]
) -> list[UUID]:
    """Replace fragments, blocks and apparatus; flush only. Returns the new fragment ids.

    Each fragment pairs with the HTML it was prepared from, its note-group evidence.
    Highlights and credits survive and re-anchor by quote. Embed rows lose only their
    fragment locators: the caller must replace or delete them in the same transaction.
    """
    embeds.prepare_document_embed_artifacts_for_fragment_replacement(db, media_id=media_id)
    old = select(Fragment.id).where(Fragment.media_id == media_id).scalar_subquery()
    db.execute(delete(FragmentBlock).where(FragmentBlock.fragment_id.in_(old)))
    db.execute(delete(Fragment).where(Fragment.media_id == media_id))
    now = datetime.now(UTC)
    rows = [
        Fragment(
            media_id=media_id,
            idx=idx,
            html_sanitized=prepared.html_sanitized,
            canonical_text=prepared.canonical_text,
            created_at=now,
        )
        for idx, (prepared, _html) in enumerate(fragments)
    ]
    db.add_all(rows)
    db.flush()
    items: list[dict[str, object]] = []
    edges: list[dict[str, object]] = []
    note_groups: list[apparatus.NotesGroup] = []
    for row, (prepared, html) in zip(rows, fragments, strict=True):
        insert_fragment_blocks(db, row.id, prepared.fragment_blocks)
        spans = apparatus.accepted_apparatus_spans(prepared.structure, prepared.canonical_text)
        items += apparatus.attach_fragment_locators(
            media_id=media_id,
            fragment_id=row.id,
            media_kind="web_article",
            canonical_text=prepared.canonical_text,
            items=prepared.apparatus_items,
            accepted_spans=spans,
            html_sanitized=prepared.html_sanitized,
        )
        edges += prepared.apparatus_edges
        note_groups += apparatus.derive_fragment_note_groups(
            prepared.html_sanitized,
            prepared.canonical_text,
            row.id,
            structure=prepared.structure,
            accepted_spans=spans,
            source_html=html,
        )
    replace_media_apparatus(
        db, media_id=media_id, items=items, edges=edges, note_groups=note_groups
    )
    return [row.id for row in rows]


def byline_observation(byline: str) -> taxonomy.ContributorObservationBatch:
    """One credited ``author`` per byline name; an empty byline observes nothing."""
    names = re.split(
        r"\s*[,;]\s*|\s+and\s+",
        re.sub(r"^by\s+", "", byline.strip(), flags=re.IGNORECASE),
        flags=re.IGNORECASE,
    )
    entries = [
        taxonomy.RawCreditEntry(credited_name=name.strip()) for name in names if name.strip()
    ]
    if not entries:
        return taxonomy.NOT_OBSERVED
    batch, truncated = taxonomy.build_observation({"author": entries})
    if truncated:
        logger.info("web_article_author_truncated", truncated=truncated)
    return batch


def _fetch(url: str) -> dict[str, str]:
    """The page through the egress, then its article from the node filter (protocol 2:
    final URL and raw Content-Type in argv, bytes on stdin, one JSON result on stdout)."""
    body = bytearray()
    try:
        page = safe_stream(
            url,
            max_bytes=_MAX_HTML_BYTES,
            timeout_s=30.0,
            sink=body.extend,
            headers=_REQUEST_HEADERS,
            max_redirects=5,
            media_types=frozenset({"text/html", "application/xhtml+xml"}),
        )
    except SafeFetchFailed as exc:
        raise source_fetch_error(exc) from exc
    node = shutil.which("node")
    if node is None:
        raise RuntimeError("Node.js executable is unavailable")
    try:
        completed = subprocess.run(
            [node, str(get_settings().node_ingest_script), page.final_url, page.raw_content_type],
            input=bytes(body),
            capture_output=True,
            timeout=40.0,
            env={"LANG": "C.UTF-8", "NODE_ENV": "production"},
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        raise ApiError(ApiErrorCode.E_INGEST_TIMEOUT, "Article extraction timed out.") from exc
    if completed.returncode != 0:
        raise RuntimeError(f"Article extraction failed: {completed.stderr[-2000:]!r}")
    result = json.loads(completed.stdout)
    if not isinstance(result, dict) or result.get("version") != 2:
        raise RuntimeError("Article extraction returned an unsupported protocol version")
    if result.get("tag") == "Failure":
        raise ApiError(*_EXTRACTION_FAILURES[result["failure"]])
    if result.get("tag") != "Success" or not all(
        isinstance(result.get(field), str) for field in _EXTRACTED_FIELDS
    ):
        raise RuntimeError("Article extraction returned an invalid result")
    return {field: result[field] for field in _EXTRACTED_FIELDS}


def _claim_canonical_url(db: Session, media_id: UUID, canonical_url: str) -> UUID | None:
    """Claim the final URL, or name the other article holding it (a racing claim collides
    on ``uix_media_canonical_url`` and the phase retries into this answer)."""
    winner_id = db.scalar(
        text(
            "SELECT id FROM media WHERE kind = :kind AND canonical_url = :url AND id != :media_id"
            " ORDER BY id LIMIT 1"
        ),
        {"kind": MediaKind.web_article.value, "url": canonical_url, "media_id": media_id},
    )
    if winner_id is not None:
        return UUID(str(winner_id))
    db.execute(
        text("UPDATE media SET canonical_url = :url, updated_at = now() WHERE id = :media_id"),
        {"url": canonical_url, "media_id": media_id},
    )
    return None
