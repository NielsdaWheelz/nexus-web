"""The sole materializer of authored relational rows; canonical state is retained.

Semantic deletion hides rows with authored_visible. Independent notes, anchors and
canonical links survive revival; sources lose retention only after their last root.
"""

import hashlib
import json
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.schemas.authored import MergeResult, ResourceProjection
from nexus.schemas.retrieval import (
    EpubFragmentOffsetsLocator,
    HighlightAnnotationOffsetsLocator,
    NoteBlockOffsetsLocator,
    PdfPageGeometryLocator,
    PdfPageLocator,
    PlaybackTimeRangeLocator,
    TranscriptTimeRangeLocator,
    WebTextOffsetsLocator,
    XCaptureOffsetsLocator,
)
from nexus.services.resource_graph.refs import require_ref


def project(
    db: Session, account_id: UUID, result: MergeResult, *, public_highlight_changes: set[UUID]
) -> None:
    from nexus.services.media_deletion import lock_highlight_sources, release_highlight_sources

    hiding = [
        require_ref(item.ref).id
        for item in result.projections
        if item.kind == "highlight" and not item.visible
    ]
    previously_visible = (
        list(
            db.scalars(
                text(
                    "SELECT id FROM highlights WHERE user_id=:a AND authored_visible AND id=ANY(CAST(:ids AS uuid[]))"
                ),
                {"a": account_id, "ids": hiding},
            )
        )
        if hiding
        else []
    )
    locked_sources = lock_highlight_sources(db, previously_visible)
    visibility_changes = []
    changed_notes = []
    for item in result.projections:
        if item.kind == "source":
            continue
        ref = require_ref(item.ref)
        scalar = {"note": "body_text", "highlight": "annotation_body_text", "page": "NULL"}[
            item.kind
        ]
        previous = db.execute(
            text(
                f"SELECT user_id,authored_visible,{scalar} FROM "
                + {"note": "note_blocks", "page": "pages", "highlight": "highlights"}[item.kind]
                + " WHERE id=:id"
            ),
            {"id": ref.id},
        ).one_or_none()
        existing = previous[0] if previous is not None else None
        if (bool(previous[1]) if previous is not None else False) != item.visible:
            visibility_changes.append(item.ref)
        if existing is not None and existing != account_id:
            from nexus.errors import ApiErrorCode, ConflictError

            raise ConflictError(
                ApiErrorCode.E_RESOURCE_CONFLICT, "Resource id belongs to another account"
            )
        if item.kind == "note":
            words_changed = previous is None or previous[2] != item.body_text
            if words_changed or item.ref in visibility_changes:
                changed_notes.append(ref.id)
            db.execute(
                text(
                    "INSERT INTO note_blocks(id,user_id,body_pm_json,body_text,authored_visible) "
                    "VALUES (:id,:a,CAST(:body AS jsonb),:words,:visible) "
                    "ON CONFLICT(id) DO UPDATE SET body_pm_json=excluded.body_pm_json, "
                    "body_text=excluded.body_text,authored_visible=excluded.authored_visible,updated_at=now()"
                ),
                {
                    "id": ref.id,
                    "a": account_id,
                    "body": json.dumps(item.body_pm_json),
                    "words": item.body_text,
                    "visible": item.visible,
                },
            )
            from nexus.services.note_bodies import project_body_embeds

            project_body_embeds(
                db, viewer_id=account_id, owner=ref, embedded_refs=item.embedded_refs
            )
        elif item.kind == "page":
            db.execute(
                text(
                    "INSERT INTO pages(id,user_id,title,authored_visible) VALUES (:id,:a,:t,:v) "
                    "ON CONFLICT(id) DO UPDATE SET title=excluded.title, "
                    "authored_visible=excluded.authored_visible,updated_at=now()"
                ),
                {
                    "id": ref.id,
                    "a": account_id,
                    "t": item.title or "",
                    "v": item.visible,
                },
            )
            if item.local_date is not None:
                db.execute(
                    text(
                        "INSERT INTO daily_page_bindings(user_id,local_date,page_id) "
                        "VALUES (:a,CAST(:d AS date),:p) ON CONFLICT DO NOTHING"
                    ),
                    {"a": account_id, "d": item.local_date, "p": ref.id},
                )
        else:
            _highlight(db, account_id, item, public_changed=ref.id in public_highlight_changes)
            if existing is None and item.visible:
                from nexus.services.connection_discovery import queue_connection_discovery_scan

                queue_connection_discovery_scan(
                    db, user_id=account_id, ref=ref, reason="authored_create"
                )
            from nexus.services.note_bodies import project_body_embeds

            project_body_embeds(
                db, viewer_id=account_id, owner=ref, embedded_refs=item.embedded_refs
            )
        if item.kind in ("note", "highlight"):
            from nexus.services.authored_text_indexing import (
                enqueue_authored_text_reindex,
                hide_authored_text_index,
            )

            owner_kind = "note_block" if item.kind == "note" else "highlight"
            if not item.visible or item.body_pm_json is None:
                if (
                    previous is not None
                    and previous[2] is not None
                    and (previous[2] != item.body_text or item.ref in visibility_changes)
                ):
                    hide_authored_text_index(db, owner_kind=owner_kind, owner_id=ref.id)
            elif (
                previous is None or previous[2] != item.body_text or item.ref in visibility_changes
            ):
                enqueue_authored_text_reindex(
                    db, owner_kind=owner_kind, owner_id=ref.id, reason="authored_merge"
                )
    passage_previews = {
        item.ref: {
            "excerpt": item.excerpt.model_dump(mode="json"),
            "capture_revision": item.capture_revision,
        }
        for item in result.projections
        if item.kind == "source" and item.excerpt is not None
    }
    for passage in result.passages:
        owner = require_ref(passage.source_ref)
        quote = {
            "exact": passage.normalized_exact,
            "prefix": passage.prefix,
            "suffix": passage.suffix,
        }
        key = hashlib.sha256(
            json.dumps(quote, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
        ).hexdigest()
        locator = passage.capture.value.locator
        hint = None
        if locator is not None:
            if isinstance(locator, HighlightAnnotationOffsetsLocator):
                hint = {
                    "kind": "highlight_annotation_text",
                    "highlight_id": str(locator.highlight_id),
                    "start_offset": locator.start_offset,
                    "end_offset": locator.end_offset,
                    "body_sha256": locator.body_sha256,
                }
            elif isinstance(
                locator,
                (
                    WebTextOffsetsLocator,
                    EpubFragmentOffsetsLocator,
                    XCaptureOffsetsLocator,
                    NoteBlockOffsetsLocator,
                ),
            ):
                hint = {
                    "kind": "text",
                    "start_offset": locator.start_offset,
                    "end_offset": locator.end_offset,
                }
                if isinstance(
                    locator,
                    (WebTextOffsetsLocator, EpubFragmentOffsetsLocator, XCaptureOffsetsLocator),
                ):
                    hint["fragment_id"] = str(locator.fragment_id)
                if isinstance(locator, EpubFragmentOffsetsLocator):
                    hint["section_id"] = str(locator.section_id) if locator.section_id else None
            elif isinstance(locator, (PdfPageGeometryLocator, PdfPageLocator)):
                hint = {"kind": "pdf", "page_number": locator.page_number}
                if isinstance(locator, PdfPageGeometryLocator):
                    hint["quads"] = [q.model_dump() for q in locator.quads]
            elif isinstance(locator, (TranscriptTimeRangeLocator, PlaybackTimeRangeLocator)):
                hint = {
                    "kind": "time",
                    "t_start_ms": locator.t_start_ms,
                    "t_end_ms": locator.t_end_ms,
                }
        db.execute(
            text(
                "INSERT INTO passage_anchors(id,user_id,owner_scheme,owner_id,anchor_key,selector,excerpt_preview) "
                "VALUES (:id,:a,:scheme,:owner,:key,CAST(:selector AS jsonb),CAST(:preview AS jsonb)) ON CONFLICT(id) "
                "DO UPDATE SET selector=excluded.selector,excerpt_preview=excluded.excerpt_preview"
            ),
            {
                "id": passage.anchor_id,
                "a": account_id,
                "scheme": owner.scheme,
                "owner": owner.id,
                "key": key,
                "selector": json.dumps({"quote": quote, "locator_hint": hint}),
                "preview": json.dumps(passage_previews[f"passage_anchor:{passage.anchor_id}"]),
            },
        )
    _project_links(db, account_id, result, visibility_changes)
    private_highlight_changes = {
        require_ref(item.ref).id for item in result.projections if item.kind == "highlight"
    } - public_highlight_changes
    if public_highlight_changes or private_highlight_changes:
        from nexus.services.highlights import annotations_changed

        annotations_changed(db, public_highlight_changes)
        annotations_changed(db, private_highlight_changes, viewer_id=account_id)
    from nexus.services.search import projection
    from nexus.services.suggestion_changes import record_input_change

    families = {"note": "note_block", "page": "page", "highlight": "highlight"}
    for kind, family in families.items():
        projection.refresh(
            db,
            family,
            changed_notes
            if kind == "note"
            else [require_ref(item.ref).id for item in result.projections if item.kind == kind],
        )
    projection.refresh(
        db,
        "highlight_annotation",
        [require_ref(item.ref).id for item in result.projections if item.kind == "highlight"],
    )
    projection.refresh(db, "passage_anchor", [passage.anchor_id for passage in result.passages])
    captures = [
        item.source_ref
        for item in result.projections
        if item.kind == "highlight" and item.ref in visibility_changes
    ]
    captures += [passage.source_ref for passage in result.passages]
    retained_x_source = bool(captures) and db.scalar(
        text(
            "SELECT EXISTS (SELECT 1 FROM fragments WHERE x_post_capture_id IS NOT NULL AND id=ANY(CAST(:ids AS uuid[])))"
        ),
        {
            "ids": [
                require_ref(ref).id
                for ref in captures
                if ref is not None and ref.startswith("fragment:")
            ]
        },
    )
    if retained_x_source:
        projection.refresh_viewer_contributors(db, [account_id])
    owners = {item.ref for item in result.projections}
    owners |= {endpoint for link in result.links for endpoint in (link.endpoint_a, link.endpoint_b)}
    owners |= {f"passage_anchor:{passage.anchor_id}" for passage in result.passages}
    if owners:
        record_input_change(db, owners=owners)
    release_highlight_sources(db, locked_sources)


def _project_links(
    db: Session, account_id: UUID, result: MergeResult, visibility_changes: list[str]
) -> None:
    """Project explicit link edits; bulk-propagate only changed endpoint liveness."""
    ids = [str(item.link_id) for item in result.links]
    conversation_links: list[tuple[UUID, bool | None, bool]] = []
    if visibility_changes:
        changed = db.execute(
            text("""WITH old AS MATERIALIZED (
            SELECT e.id,e.authored_visible AS before,l.state,
                EXISTS (SELECT 1 FROM jsonb_each_text(l.state->'add_vv') dot
                    WHERE dot.value::bigint>COALESCE((l.state->'remove_vv'->>dot.key)::bigint,0))
                AND NOT EXISTS (SELECT 1 FROM authored_resources r WHERE r.account_id=:a AND NOT r.visible
                    AND r.ref IN (l.state->>'endpoint_a',l.state->>'endpoint_b')) AS visible
            FROM authored_links l JOIN resource_edges e ON e.id=l.link_id::uuid AND e.user_id=:a
            WHERE l.account_id=:a AND NOT l.link_id=ANY(:ids)
              AND (l.state->>'endpoint_a'=ANY(:refs) OR l.state->>'endpoint_b'=ANY(:refs))
        ), changed AS (
            UPDATE resource_edges e SET authored_visible=old.visible FROM old
            WHERE e.id=old.id AND e.authored_visible IS DISTINCT FROM old.visible
            RETURNING e.id,old.before,e.authored_visible AS after,old.state
        ) SELECT id,before,after FROM changed
            WHERE state->>'endpoint_a' LIKE 'conversation:%' OR state->>'endpoint_b' LIKE 'conversation:%'"""),
            {"a": account_id, "ids": ids, "refs": visibility_changes},
        ).tuples()
        for identity, before, after in changed:
            conversation_links.append((identity, before, after))
    for link in result.links:
        value = link.model_dump(mode="json")
        a, b = require_ref(value["endpoint_a"]), require_ref(value["endpoint_b"])
        visible = any(
            int(seq) > int(value["remove_vv"].get(replica, "0"))
            for replica, seq in value["add_vv"].items()
        )
        for endpoint in (a, b):
            live = db.scalar(
                text("SELECT visible FROM authored_resources WHERE account_id=:a AND ref=:r"),
                {"a": account_id, "r": endpoint.uri},
            )
            if live is False:
                visible = False
        if a.scheme == "conversation" or b.scheme == "conversation":
            before = db.scalar(
                text("SELECT authored_visible FROM resource_edges WHERE id=:id"),
                {"id": value["link_id"]},
            )
            conversation_links.append((UUID(value["link_id"]), before, visible))
        db.execute(
            text(
                "INSERT INTO resource_edges(id,user_id,kind,origin,source_scheme,source_id,"
                "target_scheme,target_id,authored_visible) VALUES "
                "(:id,:a,'context','user',:ss,:si,:ts,:ti,:visible) ON CONFLICT(id) "
                "DO UPDATE SET authored_visible=excluded.authored_visible"
            ),
            {
                "id": value["link_id"],
                "a": account_id,
                "ss": a.scheme,
                "si": a.id,
                "ts": b.scheme,
                "ti": b.id,
                "visible": visible,
            },
        )
        for endpoint, position in ((a, value["position_a"]), (b, value["position_b"])):
            if position is not None:
                db.execute(
                    text(
                        "INSERT INTO resource_view_states(user_id,surface_scheme,surface_id,edge_id,order_key) "
                        "VALUES (:a,:s,:id,:edge,:position) ON CONFLICT "
                        "(user_id,surface_scheme,surface_id,edge_id) WHERE edge_id IS NOT NULL "
                        "DO UPDATE SET order_key=excluded.order_key"
                    ),
                    {
                        "a": account_id,
                        "s": endpoint.scheme,
                        "id": endpoint.id,
                        "edge": value["link_id"],
                        "position": position["value"],
                    },
                )
    if conversation_links:
        from nexus.services.resource_graph.context import project_conversation_links

        project_conversation_links(db, viewer_id=account_id, links=conversation_links)


def _highlight(
    db: Session, account_id: UUID, item: ResourceProjection, *, public_changed: bool
) -> None:
    capture = item.selection
    assert capture is not None and item.source_ref is not None
    ref = require_ref(item.ref)
    source = require_ref(item.source_ref)
    locator = capture.locator
    kind = (
        "pdf_page_geometry"
        if locator.type in ("pdf_page_geometry", "pdf_page")
        else "fragment_offsets"
    )
    db.execute(
        text(
            "INSERT INTO highlights(id,user_id,anchor_kind,anchor_media_id,color,exact,prefix,suffix,authored_visible,annotation_body_pm_json,annotation_body_text,excerpt_preview) "
            "VALUES (:id,:a,:kind,:media,:color,:exact,:prefix,:suffix,:visible,CAST(:body AS jsonb),:words,CAST(:preview AS jsonb)) "
            "ON CONFLICT(id) DO UPDATE SET color=excluded.color,exact=excluded.exact, "
            "prefix=excluded.prefix,suffix=excluded.suffix,authored_visible=excluded.authored_visible, "
            "annotation_body_pm_json=excluded.annotation_body_pm_json,annotation_body_text=excluded.annotation_body_text, "
            "excerpt_preview=excluded.excerpt_preview, "
            "updated_at=CASE WHEN :public_changed THEN now() ELSE highlights.updated_at END"
        ),
        {
            "id": ref.id,
            "a": account_id,
            "kind": kind,
            "media": None if isinstance(locator, XCaptureOffsetsLocator) else source.id,
            "color": item.color,
            "exact": capture.quote_exact,
            "body": json.dumps(item.body_pm_json) if item.body_pm_json is not None else None,
            "words": item.body_text,
            "public_changed": public_changed,
            "prefix": capture.prefix or "",
            "suffix": capture.suffix or "",
            "visible": item.visible,
            "preview": json.dumps(
                {
                    "excerpt": item.excerpt.model_dump(mode="json") if item.excerpt else None,
                    "capture_revision": item.capture_revision,
                }
            ),
        },
    )
    if isinstance(
        locator, (WebTextOffsetsLocator, EpubFragmentOffsetsLocator, XCaptureOffsetsLocator)
    ):
        db.execute(
            text(
                "INSERT INTO highlight_fragment_anchors(highlight_id,fragment_id,start_offset,end_offset) "
                "VALUES (:id,:f,:s,:e) ON CONFLICT(highlight_id) DO UPDATE SET "
                "fragment_id=excluded.fragment_id,start_offset=excluded.start_offset,end_offset=excluded.end_offset"
            ),
            {
                "id": ref.id,
                "f": locator.fragment_id,
                "s": locator.start_offset,
                "e": locator.end_offset,
            },
        )
    elif isinstance(locator, PdfPageGeometryLocator):
        quads = locator.quads
        db.execute(
            text(
                "INSERT INTO highlight_pdf_anchors(highlight_id,media_id,page_number,sort_top,sort_left,rect_count) "
                "VALUES (:id,:m,:p,:top,:left,:n) ON CONFLICT(highlight_id) DO UPDATE SET "
                "page_number=excluded.page_number,sort_top=excluded.sort_top,sort_left=excluded.sort_left,rect_count=excluded.rect_count"
            ),
            {
                "id": ref.id,
                "m": source.id,
                "p": locator.page_number,
                "top": min(min(q.y1, q.y2, q.y3, q.y4) for q in quads),
                "left": min(min(q.x1, q.x2, q.x3, q.x4) for q in quads),
                "n": len(quads),
            },
        )
        db.execute(text("DELETE FROM highlight_pdf_quads WHERE highlight_id=:id"), {"id": ref.id})
        for index, quad in enumerate(quads):
            db.execute(
                text(
                    "INSERT INTO highlight_pdf_quads(highlight_id,quad_idx,x1,y1,x2,y2,x3,y3,x4,y4) "
                    "VALUES (:id,:i,:x1,:y1,:x2,:y2,:x3,:y3,:x4,:y4)"
                ),
                {"id": ref.id, "i": index, **quad.model_dump()},
            )
