"""Publication replacement preserves source notes and authored relationships."""

from tempfile import TemporaryFile
from uuid import UUID, uuid4

import fitz
from sqlalchemy import Engine, select
from sqlalchemy.orm import Session, sessionmaker

from nexus.config import ReaderPublicationLimits
from nexus.db.models import (
    Media,
    ReaderApparatusItem,
    ReaderPublicationApparatusEdge,
    ReaderPublicationApparatusItem,
    ResourceEdge,
)
from nexus.schemas.reader_publication import (
    ReaderPublicationApparatusRequest,
    ReaderPublicationApparatusTextRequest,
)
from nexus.services.bootstrap import ensure_user_and_default_library
from nexus.services.library_entries import (
    delete_all_entries_for_media,
    ensure_media_in_default_library,
)
from nexus.services.media_deletion import delete_document_media_if_unreferenced
from nexus.services.reader_apparatus import replace_media_apparatus
from nexus.services.reader_publication import (
    ReaderPublicationSourceFile,
    replace_reader_document_title,
    replace_reader_publication,
)
from nexus.services.reader_publication_apparatus import (
    list_reader_publication_apparatus,
    locate_reader_publication_apparatus,
    lookup_reader_publication_apparatus,
    read_reader_publication_apparatus_text,
    verify_current_reader_publication_apparatus,
)
from nexus.services.reader_publication_artifacts import (
    prepare_pdf_reader_publication,
    prepare_reader_publication_title,
    verify_reader_publication_asset,
)
from nexus.services.resource_graph.connections import query_connections
from nexus.services.resource_graph.refs import ResourceRef
from nexus.services.resource_graph.schemas import ConnectionFilters, ConnectionQuery
from nexus.storage.client import get_storage_client
from nexus.storage.paths import build_source_artifact_storage_path


def test_replaced_apparatus_keeps_exact_source_links_and_final_delete_ownership(
    engine: Engine,
) -> None:
    user_id, media_id, link_id, link_source_id = uuid4(), uuid4(), uuid4(), uuid4()
    factory = sessionmaker(engine, expire_on_commit=False)
    storage = get_storage_client()
    with Session(engine) as db:
        ensure_user_and_default_library(db, user_id, f"apparatus-{user_id}@example.invalid")
        db.add(
            Media(
                id=media_id,
                kind="pdf",
                title="Source",
                page_count=1,
                processing_status="ready_for_reading",
                created_by_user_id=user_id,
            )
        )
        db.add(
            Media(
                id=link_source_id,
                kind="web_article",
                title="Linked from",
                processing_status="ready_for_reading",
                created_by_user_id=user_id,
            )
        )
        db.flush()
        ensure_media_in_default_library(db, user_id, media_id)
        ensure_media_in_default_library(db, user_id, link_source_id)
        db.commit()
    with fitz.open() as document:
        document.new_page().insert_text((72, 72), "Source note")
        source = document.tobytes()
    path = build_source_artifact_storage_path(media_id, uuid4(), "pdf")
    storage.put_object(path, source, "application/pdf")
    member = verify_reader_publication_asset(
        storage,
        key="assets/source.pdf",
        storage_path=path,
        media_type="application/pdf",
        expected_size_bytes=len(source),
    )
    limits = ReaderPublicationLimits(
        unit_bytes=4096,
        unit_codepoints=160,
        unit_dom_nodes=30,
        index_bytes=4096,
        descriptor_bytes=1600,
    )
    old_text = "café 🧠 original " * 30_000
    identities: dict[str, UUID] = {}
    quads = [
        {"x1": 0.1, "y1": 0.2, "x2": 0.3, "y2": 0.2, "x3": 0.1, "y3": 0.4, "x4": 0.3, "y4": 0.4}
    ]
    with TemporaryFile(mode="w+b") as search_file:
        for generation, target, body in ((1, "old-note", old_text), (2, "new-note", "new text")):
            prepared = prepare_pdf_reader_publication(
                factory,
                storage,
                media_id=media_id,
                expected_generation=generation - 1 or None,
                generation=generation,
                title="Source",
                page_count=1,
                plain_text="",
                page_spans=(),
                page_heights=(),
                search_projection_file=search_file,
                document=member,
                limits=limits,
            )
            with Session(engine) as db:

                def replace_source(
                    _media: Media,
                    generation: int = generation,
                    target: str = target,
                    body: str = body,
                ) -> None:
                    replace_media_apparatus(
                        db,
                        media_id=media_id,
                        media_kind="pdf",
                        source_fingerprint_value=f"source-{generation}",
                        items=[
                            {
                                "stable_key": key,
                                "kind": kind,
                                "label": None if kind == "footnote_ref" else "1",
                                "body_text": content,
                                "locator": {
                                    "type": "pdf_page_geometry",
                                    "media_id": str(media_id),
                                    "page_number": 1,
                                    "quads": quads,
                                    "exact": content,
                                }
                                if kind == "footnote"
                                else None,
                                "locator_status": "exact" if kind == "footnote" else "missing",
                                "confidence": "exact",
                                "extraction_method": "source",
                                "source_ref": {},
                                "sort_key": order,
                            }
                            for key, kind, content, order in (
                                ("marker", "footnote_ref", f"marker {generation}", "0"),
                                (target, "footnote", body, "1"),
                            )
                        ],
                        edges=[
                            {
                                "stable_key": "reference",
                                "from_stable_key": "marker",
                                "to_stable_key": target,
                                "relation": "points_to_note",
                                "confidence": "exact",
                                "extraction_method": "source",
                                "source_ref": {},
                                "sort_key": "0",
                            }
                        ],
                    )

                replace_reader_publication(
                    db,
                    media_id=media_id,
                    expected_kind="pdf",
                    prepared=prepared,
                    source_file=ReaderPublicationSourceFile(
                        path, "application/pdf", len(source), member.ref.sha256
                    ),
                    replace_projection=replace_source,
                )
                if generation == 1:
                    identities = dict(
                        db.execute(
                            select(ReaderApparatusItem.stable_key, ReaderApparatusItem.id).where(
                                ReaderApparatusItem.media_id == media_id
                            )
                        ).all()
                    )
                    db.add(
                        ResourceEdge(
                            id=link_id,
                            user_id=user_id,
                            kind="context",
                            origin="user",
                            source_scheme="media",
                            source_id=link_source_id,
                            target_scheme="reader_apparatus_item",
                            target_id=identities["old-note"],
                        )
                    )
                db.commit()
        with Session(engine) as db:
            assert db.get(ReaderApparatusItem, identities["old-note"]) is None
            assert db.get(ResourceEdge, link_id) is not None
            connections = query_connections(
                db,
                viewer_id=user_id,
                query=ConnectionQuery(
                    refs=(ResourceRef(scheme="media", id=media_id),),
                    direction="both",
                    rollup="owner",
                    filters=ConnectionFilters(origins=("user",)),
                    limit=20,
                ),
            )
            connection = next(
                connection for connection in connections.items if connection.edge_id == link_id
            )
            # A bare historical logical ref is still associated with this media;
            # without a source attestation it must not borrow a retained body/locator.
            assert connection.target.missing
            old = db.get(ReaderPublicationApparatusItem, (media_id, 1, identities["old-note"]))
            assert old.body_text == old_text
            assert (
                db.get(
                    ReaderPublicationApparatusItem, (media_id, 1, identities["marker"])
                ).body_text
                == "marker 1"
            )
            assert (
                db.get(
                    ReaderPublicationApparatusItem, (media_id, 2, identities["marker"])
                ).body_text
                == "marker 2"
            )
            edge = db.scalars(
                select(ReaderPublicationApparatusEdge).where(
                    ReaderPublicationApparatusEdge.media_id == media_id,
                    ReaderPublicationApparatusEdge.generation == 1,
                )
            ).one()
            assert (edge.from_item_id, edge.to_item_id, edge.relation) == (
                identities["marker"],
                identities["old-note"],
                "points_to_note",
            )
            verify_current_reader_publication_apparatus(db, media_id=media_id, generation=2)
            page = list_reader_publication_apparatus(
                db,
                viewer_id=user_id,
                media_id=media_id,
                generation=1,
                request=ReaderPublicationApparatusRequest(after=None, limit=1),
                limits=limits,
            )
            assert len(page.items) == 1 and page.next_cursor is None
            summary = page.items[0]
            assert summary.id == identities["marker"] and summary.stable_key == "marker"
            target_lookup = lookup_reader_publication_apparatus(
                db, viewer_id=user_id, media_id=media_id, generation=1, stable_key="old-note"
            )
            assert target_lookup.id == identities["old-note"]
            assert target_lookup.stable_key == "old-note"
            assert (
                summary.label_excerpt == "1" and summary.label_source_id == identities["old-note"]
            )
            targets = list_reader_publication_apparatus(
                db,
                viewer_id=user_id,
                media_id=media_id,
                generation=1,
                from_item_id=summary.id,
                request=ReaderPublicationApparatusRequest(after=None, limit=1),
                limits=limits,
            )
            assert len(targets.items) == 1 and targets.items[0].target.id == identities["old-note"]
            assert targets.items[0].target.body_excerpt == old_text[:300]
            assert targets.items[0].target.body_codepoints == len(old_text)
            assert targets.items[0].target.pdf_page == 1
            assert locate_reader_publication_apparatus(
                db,
                viewer_id=user_id,
                media_id=media_id,
                generation=1,
                item_id=identities["old-note"],
            ).model_dump() == {"kind": "Pdf", "page": 1, "quads": tuple(quads)}
            first = read_reader_publication_apparatus_text(
                db,
                viewer_id=user_id,
                media_id=media_id,
                generation=1,
                item_id=identities["old-note"],
                request=ReaderPublicationApparatusTextRequest(field="Body", offset_cp=0),
                limits=limits,
            )
            assert first.text == old_text[: len(first.text)] and first.next_offset_cp == len(
                first.text
            )
            assert (
                0 < len(first.model_dump_json().encode()) + len(b'{"data":}') <= limits.index_bytes
            )
            last = read_reader_publication_apparatus_text(
                db,
                viewer_id=user_id,
                media_id=media_id,
                generation=1,
                item_id=identities["old-note"],
                request=ReaderPublicationApparatusTextRequest(
                    field="Body", offset_cp=len(old_text) - 7
                ),
                limits=limits,
            )
            assert last.text == old_text[-7:] and last.next_offset_cp is None
        title = prepare_reader_publication_title(
            factory, storage, media_id=media_id, title="New title", limits=limits
        )
        with Session(engine) as db:
            assert replace_reader_document_title(
                db, media=db.get(Media, media_id), title="New title", prepared=title
            )
            assert (
                db.get(
                    ReaderPublicationApparatusItem, (media_id, 3, identities["marker"])
                ).body_text
                == "marker 2"
            )
            verify_current_reader_publication_apparatus(db, media_id=media_id, generation=3)
            db.commit()
        with Session(engine) as db:
            delete_all_entries_for_media(db, media_id)
            delete_document_media_if_unreferenced(db, media_id=media_id)
            db.commit()
            assert db.get(ResourceEdge, link_id) is None
            delete_all_entries_for_media(db, link_source_id)
            delete_document_media_if_unreferenced(db, media_id=link_source_id)
            db.commit()
            assert (
                db.scalars(
                    select(ReaderPublicationApparatusItem).where(
                        ReaderPublicationApparatusItem.media_id == media_id,
                    )
                ).first()
                is None
            )
