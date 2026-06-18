"""Resource route and activation policy."""

from __future__ import annotations

from typing import assert_never
from urllib.parse import quote, urlencode
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.auth.permissions import visible_media_ids_cte_sql
from nexus.schemas.resource_items import ResourceActivationOut
from nexus.services.resource_graph.refs import ResourceRef
from nexus.services.resource_graph.resolve import (
    oracle_anchor_current_target,
    reader_target_for_citation_target,
)


def resource_activation_for_ref(
    db: Session, *, viewer_id: UUID, ref: ResourceRef, missing: bool = False
) -> ResourceActivationOut:
    if missing:
        return ResourceActivationOut(
            resource_ref=ref.uri,
            kind="none",
            href=None,
            unresolved_reason="missing",
        )

    if ref.scheme == "external_snapshot":
        url = db.scalar(
            text(
                """
                SELECT url
                FROM resource_external_snapshots
                WHERE id = :id AND user_id = :viewer_id
                """
            ),
            {"id": ref.id, "viewer_id": viewer_id},
        )
        return ResourceActivationOut(
            resource_ref=ref.uri,
            kind="external" if isinstance(url, str) and url else "none",
            href=url if isinstance(url, str) and url else None,
            unresolved_reason=None if isinstance(url, str) and url else "not_routeable",
        )

    route = route_for_ref(db, viewer_id=viewer_id, ref=ref)
    return ResourceActivationOut(
        resource_ref=ref.uri,
        kind="route" if route is not None else "none",
        href=route,
        unresolved_reason=None if route is not None else "not_routeable",
    )


def route_for_ref(db: Session, *, viewer_id: UUID, ref: ResourceRef) -> str | None:
    if ref.scheme == "page":
        return f"/pages/{ref.id}"
    if ref.scheme == "note_block":
        return f"/notes/{ref.id}"
    if ref.scheme == "media":
        return f"/media/{ref.id}"
    if ref.scheme == "conversation":
        return f"/conversations/{ref.id}"
    if ref.scheme == "library":
        return f"/libraries/{ref.id}"
    if ref.scheme == "oracle_reading":
        return f"/oracle/{ref.id}"
    if ref.scheme == "podcast":
        return f"/podcasts/{ref.id}"
    if ref.scheme == "highlight":
        media_id = db.scalar(
            text("SELECT anchor_media_id FROM highlights WHERE id = :id"),
            {"id": ref.id},
        )
        return f"/media/{media_id}#highlight-{ref.id}" if media_id is not None else None
    if ref.scheme == "message":
        conversation_id = db.scalar(
            text("SELECT conversation_id FROM messages WHERE id = :id"),
            {"id": ref.id},
        )
        return f"/conversations/{conversation_id}" if conversation_id is not None else None
    if ref.scheme == "fragment":
        media_id = db.scalar(text("SELECT media_id FROM fragments WHERE id = :id"), {"id": ref.id})
        return f"/media/{media_id}#fragment-{ref.id}" if media_id is not None else None
    if ref.scheme == "content_chunk":
        span_id = db.scalar(
            text("SELECT primary_evidence_span_id FROM content_chunks WHERE id = :id"),
            {"id": ref.id},
        )
        if span_id is not None:
            return route_for_ref(
                db,
                viewer_id=viewer_id,
                ref=ResourceRef(scheme="evidence_span", id=span_id),
            )
        media_id, locator = reader_target_for_citation_target(db, viewer_id=viewer_id, target=ref)
        if media_id is not None:
            if isinstance(locator, dict) and isinstance(locator.get("fragment_id"), str):
                return f"/media/{media_id}#fragment-{locator['fragment_id']}"
            return f"/media/{media_id}"
        if isinstance(locator, dict) and isinstance(locator.get("block_id"), str):
            return f"/notes/{locator['block_id']}"
        return None
    if ref.scheme == "evidence_span":
        media_id, locator = reader_target_for_citation_target(db, viewer_id=viewer_id, target=ref)
        if media_id is not None:
            return f"/media/{media_id}#evidence-{ref.id}"
        if isinstance(locator, dict) and isinstance(locator.get("block_id"), str):
            return f"/notes/{locator['block_id']}"
        return None
    if ref.scheme == "reader_apparatus_item":
        row = db.execute(
            text(
                f"""
                WITH visible_media AS ({visible_media_ids_cte_sql()})
                SELECT rai.media_id, rai.stable_key
                FROM reader_apparatus_items rai
                JOIN reader_apparatus_states ras ON ras.id = rai.state_id
                JOIN visible_media vm ON vm.media_id = rai.media_id
                WHERE rai.id = :id
                  AND ras.status IN ('ready', 'partial')
                  AND rai.locator IS NOT NULL
                  AND rai.locator_status != 'missing'
                """
            ),
            {"id": ref.id, "viewer_id": viewer_id},
        ).first()
        if row is None:
            return None
        params = urlencode({"apparatus": str(row[1]), "apparatus_id": str(ref.id)})
        return f"/media/{row[0]}?{params}"
    if ref.scheme == "library_intelligence_artifact":
        library_id = db.scalar(
            text("SELECT library_id FROM library_intelligence_artifacts WHERE id = :id"),
            {"id": ref.id},
        )
        return f"/libraries/{library_id}?tab=intelligence" if library_id is not None else None
    if ref.scheme == "library_intelligence_revision":
        library_id = db.scalar(
            text(
                """
                SELECT a.library_id
                FROM library_intelligence_artifact_revisions r
                JOIN library_intelligence_artifacts a ON a.id = r.artifact_id
                WHERE r.id = :id
                """
            ),
            {"id": ref.id},
        )
        return (
            f"/libraries/{library_id}?tab=intelligence&revision={ref.id}"
            if library_id is not None
            else None
        )
    if ref.scheme == "contributor":
        handle = db.scalar(text("SELECT handle FROM contributors WHERE id = :id"), {"id": ref.id})
        return f"/authors/{quote(str(handle), safe='')}" if handle is not None else None
    if ref.scheme == "oracle_passage_anchor":
        current = oracle_anchor_current_target(db, ref.id)
        return route_for_ref(db, viewer_id=viewer_id, ref=current) if current is not None else None
    if ref.scheme == "external_snapshot":
        return None
    assert_never(ref.scheme)
