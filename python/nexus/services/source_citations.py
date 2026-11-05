"""Imported occurrences publish ordinary citations and complete only unobserved evidence.

The source owns existence and its binding. An independently admitted exact capture
may fill blanks; neither operation changes source composition or grants access.
"""

from __future__ import annotations

import json
from collections.abc import Sequence
from typing import TYPE_CHECKING
from uuid import UUID

from pydantic import TypeAdapter
from sqlalchemy import select, text
from sqlalchemy.orm import Session

from nexus.db.models import (
    DocumentEmbed,
    Fragment,
    ResourceEdge,
    ResourceExternalSnapshot,
    XPostCapture,
    XPostCaptureContext,
)
from nexus.ids import new_uuid7
from nexus.schemas.contributor_credit import ContributorCreditOut
from nexus.schemas.resource_evidence import (
    CapturedEvidence,
    CapturedPassageTarget,
    CapturedQuote,
    CapturedResourceTarget,
    CapturedSource,
)
from nexus.schemas.resource_graph import CitationSnapshot
from nexus.schemas.retrieval import XCaptureOffsetsLocator
from nexus.schemas.x_source import RevisionId, XArticleExcerptCapture, XCompletePostCapture
from nexus.services.canonicalize import generate_canonical_text
from nexus.services.reader_excerpts import plain_excerpt
from nexus.services.resource_graph.refs import ResourceRef, assert_resource_ref
from nexus.services.x_identity import canonical_x_post_url
from nexus.services.x_rendering import render_post_text

if TYPE_CHECKING:
    from nexus.services.resource_graph.citations import CitationInput

_REVISION = TypeAdapter(RevisionId)


def x_capture_evidence(db: Session, *, capture_id: UUID) -> CapturedEvidence:
    """Observe validated retained bytes, including an honestly empty captured body."""
    capture, fragment = db.execute(
        select(XPostCapture, Fragment)
        .join(Fragment, Fragment.x_post_capture_id == XPostCapture.id)
        .where(XPostCapture.id == capture_id)
    ).one()
    owner = f"fragment:{fragment.id}"
    credits: list[ContributorCreditOut] | None = None
    attribution = None
    words = fragment.canonical_text
    if capture.payload["kind"] == "complete_post":
        payload = XCompletePostCapture.model_validate_json(json.dumps(capture.payload))
        words = generate_canonical_text(render_post_text(payload.content))
        if not fragment.canonical_text.startswith(words):
            raise ValueError("captured post text must prove its original fragment extent")
        credits = [
            ContributorCreditOut(
                contributor_handle=None,
                contributor_display_name=None,
                href=None,
                credited_name=payload.content.author.name,
                role="author",
                raw_role=None,
                ordinal=0,
            )
        ]
    else:
        excerpt = XArticleExcerptCapture.model_validate_json(json.dumps(capture.payload))
        attribution = excerpt.attribution_text
    return CapturedEvidence(
        completion_ref=None,
        quote=CapturedQuote(
            exact=words,
            prefix=None,
            suffix=None,
            color=None,
            excerpt=plain_excerpt(words).model_copy(update={"structure": "unknown"}),
        )
        if words
        else None,
        source=CapturedSource(
            ref=owner,
            title=None,
            media_kind=None,
            contributors=credits,
            attribution_text=attribution,
            location_label=None,
        ),
        target=CapturedPassageTarget(
            owner_ref=owner,
            field=None,
            precision="exact",
            source_identity=str(capture_id),
            locator=XCaptureOffsetsLocator(
                type="x_capture_offsets",
                capture_id=capture_id,
                fragment_id=fragment.id,
                start_offset=0,
                end_offset=len(words),
                text_quote_selector={"exact": words, "prefix": None, "suffix": None},
            ),
        )
        if words
        else CapturedResourceTarget(owner_ref=owner, field=None),
    )


def source_citation_input(
    db: Session,
    *,
    revision_id: str,
    capture_id: UUID | None,
    ordinal: int,
    title: str | None = None,
    attribution_text: str | None = None,
) -> CitationInput:
    """Freeze the occurrence's observation; a permalink is a real external target."""
    from nexus.services.resource_graph.citations import CitationInput

    revision_id = _REVISION.validate_python(revision_id)
    if capture_id is not None:
        capture = db.get(XPostCapture, capture_id)
        if capture is None or capture.source_revision_id != revision_id:
            raise ValueError("citation capture must prove the declared exact revision")
        evidence = x_capture_evidence(db, capture_id=capture_id)
        evidence = evidence.model_copy(
            update={
                "source": evidence.source.model_copy(
                    update={
                        **({"title": title} if title is not None else {}),
                        **(
                            {"attribution_text": attribution_text}
                            if attribution_text is not None
                            else {}
                        ),
                    }
                )
            }
        )
        assert evidence.target.owner_ref is not None
        target = ResourceRef("fragment", UUID(evidence.target.owner_ref.removeprefix("fragment:")))
    else:
        url = canonical_x_post_url(revision_id)
        external = ResourceExternalSnapshot(
            id=new_uuid7(),
            user_id=None,
            provider="x",
            url=url,
            title=title or url,
            snippet="",
        )
        db.add(external)
        db.flush()
        target = ResourceRef("external_snapshot", external.id)
        evidence = CapturedEvidence(
            completion_ref=None,
            quote=None,
            source=CapturedSource(
                ref=target.uri,
                title=title,
                media_kind=None,
                contributors=None,
                attribution_text=attribution_text,
                location_label=None,
            ),
            target=CapturedResourceTarget(owner_ref=target.uri, field=None),
        )
    return CitationInput(
        target=target, ordinal=ordinal, snapshot=CitationSnapshot(evidence=evidence)
    )


def complete_source_citations(
    db: Session,
    *,
    account_ids: Sequence[UUID],
    capture_ids: Sequence[UUID] = (),
    media_ids: Sequence[UUID] = (),
) -> None:
    """Complete matching live bindings after admission and source visibility take effect.

    The caller owns a serializable mutation and its normal admission proof. This
    function takes only occurrence/edge locks, never late source/media locks.
    """
    from nexus.services.resource_graph.citations import (
        citation_source_visible_sql,
        complete_citation_evidence,
    )
    from nexus.services.x_source import readable_x_capture_ids_sql, x_evidence_capture_match_sql

    if not account_ids or not (capture_ids or media_ids):
        return
    db.flush()
    sources = set(capture_ids)
    if media_ids:
        media_sources = set(
            db.scalars(
                text(f"""
            SELECT capture_id FROM x_post_media WHERE media_id=ANY(:media_ids)
            UNION SELECT capture_id FROM x_thread_posts WHERE thread_media_id=ANY(:media_ids)
            UNION SELECT target_x_post_capture_id FROM document_embeds
                WHERE media_id=ANY(:media_ids) AND target_x_post_capture_id IS NOT NULL
            UNION SELECT f.x_post_capture_id FROM document_embeds de
                JOIN resource_edges e ON e.id=de.citation_id
                JOIN fragments f ON {x_evidence_capture_match_sql("e.snapshot->'evidence'", "f")}
                WHERE de.media_id=ANY(:media_ids)
        """),
                {"media_ids": list(media_ids)},
            )
        )
        sources.update(media_sources)
        sources.update(
            db.scalars(
                text(f"""
            SELECT context.target_capture_id FROM x_post_capture_contexts context
            WHERE context.capture_id=ANY(:roots) AND context.target_capture_id IS NOT NULL
            UNION SELECT f.x_post_capture_id FROM x_post_capture_contexts context
            JOIN resource_edges e ON e.id=context.citation_id
            JOIN fragments f ON {x_evidence_capture_match_sql("e.snapshot->'evidence'", "f")}
            WHERE context.capture_id=ANY(:roots) AND context.relation='quoted'
        """),
                {"roots": list(media_sources)},
            )
        )
    new_revisions = list(
        db.scalars(select(XPostCapture.source_revision_id).where(XPostCapture.id.in_(sources)))
    )
    candidates: dict[UUID, tuple[UUID, UUID, str]] = {}
    for account_id in sorted(set(account_ids)):
        captures = db.execute(
            text(f"""
            SELECT c.id,c.source_revision_id FROM x_post_captures c
            WHERE c.payload->>'kind'='complete_post' AND c.id IN ({readable_x_capture_ids_sql()})
            ORDER BY c.captured_at NULLS LAST,c.id
        """),
            {"viewer_id": account_id},
        ).all()
        available: dict[str, UUID] = {}
        for capture in captures:
            available.setdefault(capture.source_revision_id, capture.id)
        if not available:
            continue
        rows = db.execute(
            text(f"""
            WITH bindings AS (
                SELECT c.citation_id,c.referenced_revision_id AS revision,c.capture_id,
                       NULL::uuid AS media_id
                FROM x_post_capture_contexts c WHERE c.relation='quoted' AND c.citation_id IS NOT NULL
                UNION ALL
                SELECT d.citation_id,d.provider_target_ref,NULL::uuid,d.media_id
                FROM document_embeds d WHERE d.provider='x' AND d.embed_kind='post' AND d.citation_id IS NOT NULL
            )
            SELECT e.id,b.revision FROM bindings b JOIN resource_edges e ON e.id=b.citation_id
            WHERE b.revision=ANY(:available) AND {citation_source_visible_sql("e")}
              AND (b.revision=ANY(:revisions) OR b.capture_id=ANY(:captures) OR b.media_id=ANY(:media_ids))
            ORDER BY e.id
        """),
            {
                "viewer_id": account_id,
                "available": list(available),
                "revisions": new_revisions,
                "captures": list(sources),
                "media_ids": list(media_ids),
            },
        ).all()
        for row in rows:
            candidates.setdefault(row.id, (account_id, available[row.revision], row.revision))
    if not candidates:
        return
    contexts = list(
        db.scalars(
            select(XPostCaptureContext)
            .where(XPostCaptureContext.citation_id.in_(candidates))
            .order_by(XPostCaptureContext.id)
            .with_for_update()
        )
    )
    embeds = list(
        db.scalars(
            select(DocumentEmbed)
            .where(DocumentEmbed.citation_id.in_(candidates))
            .order_by(DocumentEmbed.id)
            .with_for_update()
        )
    )
    revisions = {
        row.citation_id: row.referenced_revision_id
        for row in contexts
        if row.citation_id is not None
    }
    for row in embeds:
        if row.citation_id is None or row.provider_target_ref is None:
            raise ValueError("bound source citation requires a declared exact revision")
        revisions[row.citation_id] = row.provider_target_ref
    changed: list[ResourceEdge] = []
    for edge in db.scalars(
        select(ResourceEdge)
        .where(ResourceEdge.id.in_(candidates))
        .order_by(ResourceEdge.id)
        .with_for_update()
    ):
        _account, capture_id, revision = candidates[edge.id]
        if revisions.get(edge.id) != revision:
            continue
        if complete_citation_evidence(edge, x_capture_evidence(db, capture_id=capture_id)):
            changed.append(edge)
    if changed:
        db.flush()
        invalidate_source_citations(db, edges=changed)


def invalidate_source_citations(db: Session, *, edges: Sequence[ResourceEdge]) -> None:
    """Wake readable source audiences through the existing remote-evidence owner."""
    from nexus.services.resource_grants import media_audience_account_ids
    from nexus.services.resource_items.versions import invalidate_evidence
    from nexus.services.x_source import readable_x_capture_ids_sql

    audience: set[tuple[UUID, ResourceRef]] = set()
    for edge in edges:
        source = assert_resource_ref(f"{edge.source_scheme}:{edge.source_id}")
        if source.scheme == "media":
            audience.update(
                (account, source)
                for account in media_audience_account_ids(db, media_ids=[source.id])
            )
        elif source.scheme == "fragment":
            capture_id = db.scalar(
                select(Fragment.x_post_capture_id).where(Fragment.id == source.id)
            )
            if capture_id is None:
                raise ValueError("imported citation source must belong to a capture")
            accounts = list(
                db.scalars(
                    text("SELECT user_id FROM x_post_capture_admissions WHERE capture_id=:id"),
                    {"id": capture_id},
                )
            )
            for account in accounts:
                readable = db.scalar(
                    text(
                        f"SELECT EXISTS(SELECT 1 FROM ({readable_x_capture_ids_sql()}) r WHERE r.capture_id=:id)"
                    ),
                    {"viewer_id": account, "id": capture_id},
                )
                if not readable:
                    continue
                audience.add((account, source))
                from nexus.auth.permissions import visible_media_ids_cte_sql

                media = db.scalars(
                    text(f"""
                    SELECT media_id FROM x_post_media WHERE capture_id=:capture
                        AND media_id IN ({visible_media_ids_cte_sql()})
                    UNION SELECT thread_media_id FROM x_thread_posts WHERE capture_id=:capture
                        AND thread_media_id IN ({visible_media_ids_cte_sql()})
                """),
                    {"viewer_id": account, "capture": capture_id},
                )
                audience.update((account, ResourceRef("media", id_)) for id_ in media)
    invalidate_evidence(db, projections=audience)


def complete_media_citations(db: Session, *, media_ids: Sequence[UUID]) -> None:
    """The containing mutation calls after its new media audience is effective."""
    from nexus.services.resource_grants import media_audience_account_ids

    complete_source_citations(
        db,
        account_ids=media_audience_account_ids(db, media_ids=media_ids),
        media_ids=media_ids,
    )
