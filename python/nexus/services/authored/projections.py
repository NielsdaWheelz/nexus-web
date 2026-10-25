"""The sole materializer of authored relational rows; canonical state is retained.

Semantic deletion hides rows with authored_visible. No resource teardown runs:
independent notes, anchors and incident canonical links survive revival.
"""

import hashlib
import json
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.schemas.authored import MergeResult, ResourceProjection
from nexus.schemas.retrieval import (
    EpubFragmentOffsetsLocator,
    NoteBlockOffsetsLocator,
    PdfPageGeometryLocator,
    PdfPageLocator,
    PlaybackTimeRangeLocator,
    TranscriptTimeRangeLocator,
    WebTextOffsetsLocator,
)
from nexus.services.resource_graph.refs import require_ref


def project(db: Session, account_id: UUID, result: MergeResult) -> None:
    for item in result.projections:
        ref = require_ref(item.ref)
        existing = db.scalar(
            text(
                "SELECT user_id FROM "
                + {"note": "note_blocks", "page": "pages", "highlight": "highlights"}[item.kind]
                + " WHERE id=:id"
            ),
            {"id": ref.id},
        )
        if existing is not None and existing != account_id:
            from nexus.errors import ApiErrorCode, ConflictError

            raise ConflictError(
                ApiErrorCode.E_RESOURCE_CONFLICT, "Resource id belongs to another account"
            )
        if item.kind == "note":
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
            from nexus.services.note_bodies import project_note_embeds

            project_note_embeds(
                db, viewer_id=account_id, note_id=ref.id, embedded_refs=item.embedded_refs
            )
            if item.visible:
                from nexus.services.note_indexing import enqueue_note_reindex

                enqueue_note_reindex(db, note_block_id=ref.id, reason="authored_merge")
            else:
                from nexus.services.content_indexing import IndexOwner, delete_content_index

                delete_content_index(db, owner=IndexOwner("note_block", ref.id))
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
            _highlight(db, account_id, item)
            if existing is None and item.visible:
                from nexus.services.connection_discovery import queue_connection_discovery_scan

                queue_connection_discovery_scan(
                    db, user_id=account_id, ref=ref, reason="authored_create"
                )
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
            if isinstance(
                locator,
                (WebTextOffsetsLocator, EpubFragmentOffsetsLocator, NoteBlockOffsetsLocator),
            ):
                hint = {
                    "kind": "text",
                    "start_offset": locator.start_offset,
                    "end_offset": locator.end_offset,
                }
                if isinstance(locator, (WebTextOffsetsLocator, EpubFragmentOffsetsLocator)):
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
                "INSERT INTO passage_anchors(id,user_id,owner_scheme,owner_id,anchor_key,selector) "
                "VALUES (:id,:a,:scheme,:owner,:key,CAST(:selector AS jsonb)) ON CONFLICT(id) "
                "DO UPDATE SET selector=excluded.selector"
            ),
            {
                "id": passage.anchor_id,
                "a": account_id,
                "scheme": owner.scheme,
                "owner": owner.id,
                "key": key,
                "selector": json.dumps({"quote": quote, "locator_hint": hint}),
            },
        )
    touched = [item.ref for item in result.projections]
    ids = [str(item.link_id) for item in result.links]
    rows = db.execute(
        text(
            "SELECT state FROM authored_links WHERE account_id=:a AND "
            "(link_id=ANY(:ids) OR state->>'endpoint_a'=ANY(:refs) "
            "OR state->>'endpoint_b'=ANY(:refs))"
        ),
        {"a": account_id, "ids": ids, "refs": touched},
    ).scalars()
    conversation_links = []
    for value in rows:
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


def _highlight(db: Session, account_id: UUID, item: ResourceProjection) -> None:
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
            "INSERT INTO highlights(id,user_id,anchor_kind,anchor_media_id,color,exact,prefix,suffix,authored_visible) "
            "VALUES (:id,:a,:kind,:media,:color,:exact,:prefix,:suffix,:visible) "
            "ON CONFLICT(id) DO UPDATE SET color=excluded.color,exact=excluded.exact, "
            "prefix=excluded.prefix,suffix=excluded.suffix,authored_visible=excluded.authored_visible,updated_at=now()"
        ),
        {
            "id": ref.id,
            "a": account_id,
            "kind": kind,
            "media": source.id,
            "color": item.color,
            "exact": capture.quote_exact,
            "prefix": capture.prefix or "",
            "suffix": capture.suffix or "",
            "visible": item.visible,
        },
    )
    if isinstance(locator, (WebTextOffsetsLocator, EpubFragmentOffsetsLocator)):
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
