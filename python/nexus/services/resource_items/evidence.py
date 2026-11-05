"""Captured evidence: freezing words with their location, projecting frozen words as an
occurrence, and resolving a source-target key.

Capture happens when words enter a candidate or quote; publication only copies it. A
historical read never asks the current target for replacement words or attribution:
current state can only make the location or the source unavailable (I6). Where words
land now is ``locations``'s proof.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any
from uuid import UUID

from pydantic import TypeAdapter
from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.auth.permissions import can_read_media
from nexus.errors import ApiErrorCode, ConflictError, InvalidRequestError, NotFoundError
from nexus.schemas.authored import SelectionCapture
from nexus.schemas.resource_evidence import (
    CapturedEvidence,
    CapturedPassageTarget,
    CapturedQuote,
    CapturedResourceTarget,
    CapturedSource,
    CapturedTarget,
    CapturedUnavailableTarget,
    ResourceField,
    validate_resource_field,
)
from nexus.schemas.resource_items import (
    CitationSourceTargetKey,
    LocatedSourceLocationOut,
    NamedResourceBodyOut,
    ReaderQuoteSourceTargetKey,
    ResourceActivationOut,
    ResourceItemOut,
    ResourcePreviewOut,
    ResourceSourceTargetKey,
    RetrievalSourceTargetKey,
    SourceAttributionOut,
    SourceTargetKey,
    SourceTargetOut,
    UnavailableSourceLocationOut,
    WholeSourceLocationOut,
)
from nexus.schemas.retrieval import (
    EpubFragmentOffsetsLocator,
    LocationPrecision,
    PdfPageGeometryLocator,
    RetrievalLocator,
    WebTextOffsetsLocator,
    XCaptureOffsetsLocator,
)
from nexus.services.generation.policy import policy
from nexus.services.reader_excerpts import (
    capture_proof,
    contains_table,
    plain_excerpt,
    project_excerpts,
    read_captures,
    scope_excerpts,
)
from nexus.services.resource_graph.liveness import edge_live_sql
from nexus.services.resource_graph.refs import ResourceRef, assert_resource_ref, require_ref
from nexus.services.resource_items.items import (
    passage_body,
    passage_label,
    ref_visible,
    resource_item_out,
    source_attributions,
)
from nexus.services.resource_items.locations import (
    TIMED_KINDS,
    captured_quote,
    current_locator,
    current_passages,
    location_reads,
    media_passages,
    resolve_quote,
    source_identities,
)

_LOCATOR = TypeAdapter(RetrievalLocator)
# Schemes a source-target key opens whole: they have no extent inside a source.
_WHOLE = frozenset(
    {
        "media",
        "note_block",
        "page",
        "conversation",
        "library",
        "podcast",
        "contributor",
        "oracle_reading",
        "external_snapshot",
    }
)
_UNAVAILABLE_SOURCE = SourceTargetOut(
    source_activation=None, location=UnavailableSourceLocationOut(reason="source_unavailable")
)


def capture_reader_selection(
    db: Session,
    *,
    viewer_id: UUID,
    reading_ref: ResourceRef,
    source_ref: ResourceRef,
    capture: SelectionCapture,
) -> CapturedEvidence:
    """Prove one unsaved reader capture using bounded canonical source substrings.

    Media coordinates belong to the canonical source; authority and tool scope
    belong to the requested reading. PDF words remain the reader's captured words.
    The caller holds the media reference barrier and owns the admission transaction.
    """
    locator = capture.locator
    invalid = ApiErrorCode.E_INVALID_REQUEST
    stale = ApiErrorCode.E_READER_SELECTION_STALE
    if capture.passage_ref is not None or not isinstance(
        locator,
        (
            WebTextOffsetsLocator,
            EpubFragmentOffsetsLocator,
            XCaptureOffsetsLocator,
            PdfPageGeometryLocator,
        ),
    ):
        raise InvalidRequestError(invalid, "Unsupported reader capture")
    if not isinstance(locator, PdfPageGeometryLocator):
        require_ref(f"fragment:{locator.fragment_id}")
    proof = capture_proof(capture.excerpt)
    if not capture.quote_exact.strip() or not proof.text_parts.exact.strip():
        raise InvalidRequestError(
            ApiErrorCode.E_READER_SELECTION_GEOMETRY_ONLY, "Select text to quote"
        )
    extent = capture.excerpt.source_extent
    source_identity: str | None
    if isinstance(locator, XCaptureOffsetsLocator):
        from nexus.services.media_text_scope import x_capture_scope_rows_sql
        from nexus.services.x_source import readable_x_capture_ids_sql

        if (
            source_ref != ResourceRef("fragment", locator.fragment_id)
            or capture.publication is None
            or capture.publication.kind != "x_capture"
            or capture.publication.capture_id != locator.capture_id
        ):
            raise InvalidRequestError(invalid, "Capture source disagrees with its locator")
        if reading_ref != source_ref:
            if reading_ref.scheme != "media" or not can_read_media(db, viewer_id, reading_ref.id):
                raise NotFoundError(ApiErrorCode.E_READER_SELECTION_NOT_FOUND, "Reading not found")
            if not db.scalar(
                text(
                    f"SELECT EXISTS (SELECT 1 FROM ({x_capture_scope_rows_sql('SELECT CAST(:reading AS uuid) AS media_id')}) occurrence WHERE occurrence.capture_id=:capture AND occurrence.fragment_id=:fragment)"
                ),
                {
                    "reading": reading_ref.id,
                    "capture": locator.capture_id,
                    "fragment": locator.fragment_id,
                },
            ):
                raise NotFoundError(
                    ApiErrorCode.E_READER_SELECTION_NOT_FOUND, "Capture is outside this reading"
                )
        if not db.scalar(
            text(
                f"SELECT EXISTS (SELECT 1 FROM ({readable_x_capture_ids_sql()}) readable WHERE readable.capture_id=:capture)"
            ),
            {"viewer_id": viewer_id, "capture": locator.capture_id},
        ):
            raise NotFoundError(ApiErrorCode.E_READER_SELECTION_NOT_FOUND, "Capture not found")
        owner = source_ref
        source_identity = str(locator.capture_id)
        expected_extent_identity = f"capture:{locator.capture_id}"
        expected_extent_ref = source_ref.uri
        bounds = None
    else:
        if (
            reading_ref.scheme != "media"
            or source_ref.scheme != "media"
            or str(locator.media_id) != str(source_ref.id)
        ):
            raise InvalidRequestError(invalid, "Reader source disagrees with its locator")
        if not can_read_media(db, viewer_id, reading_ref.id):
            raise NotFoundError(ApiErrorCode.E_READER_SELECTION_NOT_FOUND, "Reading not found")
        row = db.execute(
            text("""SELECT reading.kind,COALESCE(part.source_media_id,reading.id) AS source_id,
                part.source_generation AS pinned_generation,source.kind AS source_kind,
                own.generation AS reading_generation,publication.generation AS source_generation,
                source.processing_status,source.page_count,
                transcript.transcript_state,transcript.transcript_coverage
                FROM media reading LEFT JOIN media_parts part ON part.media_id=reading.id
                JOIN media source ON source.id=COALESCE(part.source_media_id,reading.id)
                LEFT JOIN reader_publications own ON own.media_id=reading.id
                LEFT JOIN reader_publications publication ON publication.media_id=source.id
                LEFT JOIN media_transcript_states transcript ON transcript.media_id=source.id
                WHERE reading.id=:reading"""),
            {"reading": reading_ref.id},
        ).one()
        if row.source_id != source_ref.id:
            raise InvalidRequestError(invalid, "Reading does not belong to this source")
        if row.source_kind in ("web_article", "epub", "pdf"):
            from nexus.services.capabilities import quotable_document_rows_sql

            if (
                capture.publication is None
                or capture.publication.kind != "reader"
                or capture.publication.generation != row.source_generation
                or row.processing_status != "ready_for_reading"
                or row.kind == "text_part"
                and row.pinned_generation != row.source_generation
                or not db.scalar(
                    text(
                        f"SELECT EXISTS (SELECT 1 FROM ({quotable_document_rows_sql()}) readable WHERE readable.media_id=:reading)"
                    ),
                    {"reading": reading_ref.id},
                )
            ):
                raise ConflictError(stale, "Reader publication changed")
            source_identity = f"g{row.source_generation}"
            expected_extent_identity = f"g{row.reading_generation}"
        elif row.source_kind in ("podcast_episode", "video") and capture.publication is None:
            from nexus.services.capabilities import is_text_document_ready

            if not is_text_document_ready(
                row.source_kind,
                row.processing_status,
                row.transcript_state,
                row.transcript_coverage,
            ):
                raise ConflictError(stale, "Transcript is not readable")
            source_identity = None
            expected_extent_identity = None
        else:
            raise InvalidRequestError(invalid, "Source has no supported reader capture")
        owner = reading_ref
        expected_extent_ref = reading_ref.uri
        if isinstance(locator, PdfPageGeometryLocator):
            from nexus.services.pdf_highlight_geometry import (
                GeometryValidationError,
                canonicalize_geometry,
            )

            if (
                row.source_kind != "pdf"
                or row.page_count is None
                or locator.page_number > row.page_count
            ):
                raise ConflictError(stale, "PDF page is unavailable")
            if len(capture.quote_exact) > 2000:
                raise InvalidRequestError(
                    ApiErrorCode.E_READER_SELECTION_TOO_LARGE, "PDF quote exceeds 2000 codepoints"
                )
            try:
                geometry = canonicalize_geometry(
                    locator.page_number, [quad.model_dump() for quad in locator.quads]
                )
            except GeometryValidationError as error:
                raise InvalidRequestError(invalid, "Invalid PDF selection geometry") from error
            for actual, expected in zip(locator.quads, geometry.quads, strict=True):
                if any(
                    getattr(actual, field) != float(getattr(expected, field))
                    for field in type(actual).model_fields
                ):
                    raise InvalidRequestError(invalid, "PDF geometry is not canonical")
            if (
                locator.exact != capture.quote_exact
                or proof.text_parts.exact != capture.quote_exact
                or capture.excerpt.structure != "plain"
                or extent is not None
                or capture.prefix is not None
                or capture.suffix is not None
                or proof.text_parts.prefix
                or proof.text_parts.suffix
                or locator.prefix is not None
                or locator.suffix is not None
                or locator.projection is not None
                or locator.text_quote_selector
                != {"exact": capture.quote_exact, "prefix": None, "suffix": None}
            ):
                raise InvalidRequestError(invalid, "PDF quote disagrees with its captured text")
            return CapturedEvidence(
                quote=CapturedQuote(
                    excerpt=capture.excerpt,
                    exact=capture.quote_exact,
                    prefix=None,
                    suffix=None,
                    color=None,
                ),
                source=_reader_source(
                    db, viewer_id, owner, location_label=f"page {locator.page_number}"
                ),
                target=CapturedPassageTarget(
                    owner_ref=owner.uri,
                    field=None,
                    locator=locator,
                    precision="exact",
                    source_identity=source_identity,
                ),
            )
        if row.source_kind == "pdf" or isinstance(locator, EpubFragmentOffsetsLocator) != (
            row.source_kind == "epub"
        ):
            raise InvalidRequestError(invalid, "Text locator disagrees with source format")
        from nexus.services.media_text_scope import passage_scope_rows_sql

        bounds = db.execute(
            text(
                f"SELECT start_offset,end_offset FROM ({passage_scope_rows_sql('SELECT CAST(:reading AS uuid) AS media_id')}) scope WHERE source_media_id=:source AND fragment_id=:fragment AND start_offset<=:start AND end_offset>=:end"
            ),
            {
                "reading": reading_ref.id,
                "source": source_ref.id,
                "fragment": UUID(str(locator.fragment_id)),
                "start": locator.start_offset,
                "end": locator.end_offset,
            },
        ).first()
        if bounds is None:
            raise ConflictError(stale, "Selected passage is outside this reading")
    if (
        extent is None
        or proof.selection is None
        or extent.reading_ref != expected_extent_ref
        or extent.fragment_id != str(locator.fragment_id)
        or expected_extent_identity is not None
        and extent.document_identity != expected_extent_identity
        or extent.start_offset + proof.selection.start_offset != locator.start_offset
        or extent.start_offset + proof.selection.end_offset != locator.end_offset
        or extent.end_offset - extent.start_offset != proof.length
        or extent.start_offset < 0
        or bounds is not None
        and not bounds.start_offset <= extent.start_offset < extent.end_offset <= bounds.end_offset
    ):
        raise ConflictError(stale, "Captured excerpt no longer names this reading")
    prefix, suffix = capture.prefix or "", capture.suffix or ""
    if bounds is not None and (
        locator.start_offset - len(prefix) < bounds.start_offset
        or locator.end_offset + len(suffix) > bounds.end_offset
    ):
        raise InvalidRequestError(invalid, "Quote context is outside this reading")
    row = db.execute(
        text("""SELECT media_id,x_post_capture_id,char_length(canonical_text) AS length,
            substring(canonical_text FROM :start+1 FOR :size) AS exact,
            substring(canonical_text FROM :extent_start+1 FOR :extent_size) AS excerpt,
            substring(canonical_text FROM :start-:prefix+1 FOR :prefix) AS prefix,
            substring(canonical_text FROM :end+1 FOR :suffix) AS suffix
            FROM fragments WHERE id=:fragment"""),
        {
            "fragment": UUID(str(locator.fragment_id)),
            "start": locator.start_offset,
            "end": locator.end_offset,
            "size": locator.end_offset - locator.start_offset,
            "extent_start": extent.start_offset,
            "extent_size": proof.length,
            "prefix": len(prefix),
            "suffix": len(suffix),
        },
    ).first()
    if (
        row is None
        or row.exact != capture.quote_exact
        or row.excerpt != proof.emitted
        or row.prefix != prefix
        or row.suffix != suffix
        or extent.end_offset > row.length
        or isinstance(locator, XCaptureOffsetsLocator)
        and row.x_post_capture_id != locator.capture_id
        or not isinstance(locator, XCaptureOffsetsLocator)
        and row.media_id != source_ref.id
        or locator.text_quote_selector is None
        or locator.text_quote_selector.get("exact") != capture.quote_exact
        or locator.text_quote_selector.get("prefix") != capture.prefix
        or locator.text_quote_selector.get("suffix") != capture.suffix
    ):
        raise ConflictError(stale, "Selected words no longer match the source")
    if owner.scheme == "media" and contains_table(capture.excerpt):
        incomplete = _incomplete_quote_tables(db, owner.id, UUID(str(locator.fragment_id)))
        accepted = scope_excerpts(
            [{"excerpt": capture.excerpt.model_dump(mode="json"), "scope": {"kind": "capture"}}],
            incomplete_tables=[incomplete],
        )[0]
        if accepted is None:
            raise InvalidRequestError(invalid, "A partial table cannot be quoted")
    return CapturedEvidence(
        quote=CapturedQuote(
            excerpt=capture.excerpt,
            exact=capture.quote_exact,
            prefix=capture.prefix,
            suffix=capture.suffix,
            color=None,
        ),
        source=_reader_source(db, viewer_id, owner),
        target=CapturedPassageTarget(
            owner_ref=owner.uri,
            field=None,
            locator=locator,
            precision="exact",
            source_identity=source_identity,
        ),
    )


def _incomplete_quote_tables(
    db: Session, reading: UUID, fragment: UUID
) -> tuple[tuple[int, int], ...]:
    from nexus.services.media_text_scope import incomplete_table_rows_sql

    return tuple(
        (row.start_offset, row.end_offset)
        for row in db.execute(
            text(
                f"SELECT start_offset,end_offset FROM ({incomplete_table_rows_sql('SELECT CAST(:reading AS uuid) AS media_id')}) cuts WHERE fragment_id=:fragment"
            ),
            {"reading": reading, "fragment": fragment},
        )
    )


def _reader_source(
    db: Session, viewer_id: UUID, owner: ResourceRef, *, location_label: str | None = None
) -> CapturedSource:
    """Attribution for an already authorized reader; captured fragments need no body."""
    if owner.scheme == "fragment":
        title = db.scalar(
            text("""SELECT COALESCE(c.payload #>> '{content,author,name}',
            c.payload->>'attribution_text',c.payload->>'parent_title')
            FROM fragments f JOIN x_post_captures c ON c.id=f.x_post_capture_id WHERE f.id=:id"""),
            {"id": owner.id},
        )
        return CapturedSource(
            ref=owner.uri,
            title=title,
            media_kind=None,
            contributors=None,
            location_label=location_label,
        )
    source = source_attributions(db, viewer_id=viewer_id, refs=[owner]).get(owner.uri)
    if source is None:
        raise NotFoundError(ApiErrorCode.E_READER_SELECTION_NOT_FOUND, "Reading not found")
    return CapturedSource(
        **source.model_dump(exclude={"activation", "location_label"}), location_label=location_label
    )


class PromptEvidenceTooLarge(ValueError):
    """Selected evidence exceeds the remaining prompt materialization budget."""


def capture_prompt_evidence(
    db: Session,
    *,
    viewer_id: UUID,
    ref: ResourceRef,
    byte_limit: int,
) -> CapturedEvidence:
    """Freeze one explicitly attached passage without discovering or loading its source.

    Stored locators and bounded canonical substrings prove current placement. Native
    saved captures retain their rich excerpt; index-selected bodies are plain text.
    The identity gate alone never authorizes a piece's neighbouring source words.
    """
    from nexus.auth.permissions import requested_media_ids_cte_sql
    from nexus.services import locator_resolver
    from nexus.services.media_text_scope import apparatus_scope_rows_sql
    from nexus.services.resource_items.locations import passage_owner_sql

    missing = NotFoundError(ApiErrorCode.E_NOT_FOUND, "Source passage not found")
    if not ref_visible(db, viewer_id=viewer_id, ref=ref):
        raise missing
    if ref.scheme in ("highlight", "passage_anchor"):
        sql = (
            "SELECT octet_length((r.state #> '{selection,value}')::text) FROM authored_resources r JOIN highlights h ON r.account_id=h.user_id AND r.ref='highlight:' || h.id::text WHERE h.id=:id"
            if ref.scheme == "highlight"
            else "SELECT octet_length((p.state #> '{capture,value}')::text) FROM authored_passages p JOIN passage_anchors a ON a.user_id=p.account_id AND p.anchor_id=a.id::text WHERE a.id=:id"
        )
        size = db.scalar(text(sql), {"id": ref.id})
        if size is None:
            raise missing
        if size > byte_limit:
            raise PromptEvidenceTooLarge(ref.uri)
        stored = read_captures(db, [ref.uri]).get(ref.uri)
        if stored is not None and require_ref(stored["source_ref"]).scheme not in (
            "media",
            "fragment",
        ):
            owner = require_ref(stored["source_ref"])
            raw = stored["capture"]["value"]
            locator = _LOCATOR.validate_python(raw["locator"])
            located = _bounded_locator(
                db,
                viewer_id=viewer_id,
                owner=owner,
                locator=locator,
                exact=raw["quote_exact"],
                byte_limit=byte_limit,
            )
            field = "annotation" if locator.type == "highlight_annotation_offsets" else None
            return CapturedEvidence(
                quote=CapturedQuote(
                    excerpt=raw["excerpt"],
                    exact=raw["quote_exact"],
                    prefix=raw.get("prefix"),
                    suffix=raw.get("suffix"),
                    color=None,
                ),
                source=CapturedSource(
                    ref=owner.uri,
                    title="annotation" if field else "Note",
                    media_kind=None,
                    contributors=None,
                    location_label=None,
                ),
                target=CapturedPassageTarget(
                    owner_ref=owner.uri,
                    field=field,
                    locator=located,
                    precision="exact",
                    source_identity=None,
                )
                if located is not None
                else CapturedUnavailableTarget(owner_ref=owner.uri, field=field),
            )
        return capture_evidence(db, viewer_id=viewer_id, ref=ref)
    queries = {
        "content_chunk": "SELECT c.owner_kind,c.owner_id,c.chunk_text AS body,c.summary_locator AS locator,NULL::text AS resolver_kind,NULL::jsonb AS selector,NULL::text AS label FROM content_chunks c WHERE c.id=:id",
        "evidence_span": "SELECT owner_kind,owner_id,span_text AS body,NULL::jsonb AS locator,resolver_kind,selector,citation_label AS label FROM evidence_spans WHERE id=:id",
        "fragment": "SELECT CASE WHEN x_post_capture_id IS NULL THEN 'media' ELSE 'fragment' END AS owner_kind,COALESCE(media_id,id) AS owner_id,canonical_text AS body, jsonb_build_object('fragment_id',id,'capture_id',x_post_capture_id) AS locator,NULL::text AS resolver_kind,NULL::jsonb AS selector,NULL::text AS label FROM fragments WHERE id=:id",
        "reader_apparatus_item": "SELECT 'media' AS owner_kind,item.media_id AS owner_id,COALESCE(item.body_text,item.label,'') AS body,item.locator,NULL::text AS resolver_kind,NULL::jsonb AS selector,item.label FROM reader_apparatus_items item JOIN reader_apparatus_states s ON s.id=item.state_id WHERE item.id=:id AND s.status IN ('ready','partial')",
        "oracle_passage_anchor": "SELECT 'media' AS owner_kind,s.media_id AS owner_id,COALESCE(es.span_text,cc.chunk_text,a.quote) AS body,NULL::jsonb AS locator,NULL::text AS resolver_kind,NULL::jsonb AS selector,a.display_label AS label FROM oracle_passage_anchors a JOIN oracle_corpus_sources s ON s.id=a.corpus_source_id LEFT JOIN evidence_spans es ON es.id=a.current_evidence_span_id AND a.resolution_status='resolved' AND es.owner_id=s.media_id LEFT JOIN content_chunks cc ON cc.id=a.current_content_chunk_id AND a.resolution_status='resolved' AND cc.owner_id=s.media_id WHERE a.id=:id",
    }
    sql = queries.get(ref.scheme)
    if sql is None:
        return capture_evidence(db, viewer_id=viewer_id, ref=ref)
    size = db.scalar(
        text(
            f"SELECT octet_length(body)+COALESCE(octet_length(locator::text),0)+COALESCE(octet_length(selector::text),0) FROM ({sql}) candidate"
        ),
        {"id": ref.id},
    )
    if size is None:
        raise missing
    if size > byte_limit:
        raise PromptEvidenceTooLarge(ref.uri)
    row = db.execute(text(sql), {"id": ref.id}).one()
    owner = assert_resource_ref(f"{row.owner_kind}:{row.owner_id}")
    words = row.body
    locator = row.locator
    media_kind = (
        db.scalar(text("SELECT kind FROM media WHERE id=:id"), {"id": owner.id})
        if owner.scheme == "media"
        else None
    )
    if ref.scheme == "evidence_span":
        if owner.scheme == "fragment" and row.selector.get("type") == "x_capture_offsets":
            locator = {
                **row.selector,
                "text_quote_selector": row.selector.get("text_quote") or {"exact": words},
            }
            locator.pop("text_quote", None)
        else:
            locator = locator_resolver.locator_from_resolution(
                locator_resolver.evidence_resolution(
                    evidence_span_id=ref.id,
                    owner_id=owner.id,
                    span_text=words,
                    selector=row.selector,
                    resolver_kind=row.resolver_kind,
                ),
                media_id=owner.id,
                media_kind=media_kind or "note",
            )
    elif ref.scheme == "fragment":
        locator = (
            {
                "type": "x_capture_offsets"
                if row.locator["capture_id"] is not None
                else "epub_fragment_offsets"
                if media_kind == "epub"
                else "web_text_offsets",
                "fragment_id": str(ref.id),
                "start_offset": 0,
                "end_offset": len(words),
                "text_quote_selector": {"exact": words},
                **(
                    {"capture_id": row.locator["capture_id"]}
                    if row.locator["capture_id"] is not None
                    else {"media_id": str(owner.id)}
                ),
            }
            if words
            else None
        )
    source_identity = None
    scoped_authority = False
    if owner.scheme == "media":
        if not can_read_media(db, viewer_id, owner.id):
            scoped_authority = True
            chosen = None
            if ref.scheme == "reader_apparatus_item":
                chosen = db.scalar(
                    text(
                        f"SELECT reading_media_id FROM ({apparatus_scope_rows_sql(requested_media_ids_cte_sql())}) scope WHERE apparatus_item_id=:id ORDER BY reading_media_id LIMIT 1"
                    ),
                    {"id": ref.id, "viewer_id": viewer_id},
                )
            elif locator is not None and locator.get("type") in (
                "web_text_offsets",
                "epub_fragment_offsets",
            ):
                chosen = db.scalar(
                    text(
                        passage_owner_sql(
                            requested_media_ids_cte_sql(),
                            source=":source",
                            fragment=":fragment",
                            start=":start",
                            end=":end",
                        )
                    ),
                    {
                        "viewer_id": viewer_id,
                        "source": owner.id,
                        "fragment": UUID(locator["fragment_id"]),
                        "start": locator["start_offset"],
                        "end": locator["end_offset"],
                    },
                )
            if chosen is None:
                raise missing
            owner = ResourceRef("media", chosen)
        generation = db.scalar(
            text("SELECT generation FROM reader_publications WHERE media_id=:id"),
            {"id": row.owner_id},
        )
        source_identity = f"g{generation}" if generation is not None else None
    if locator is not None:
        locator = dict(locator)
        locator["text_quote_selector"] = {"exact": words, "prefix": None, "suffix": None}
        if locator.get("type") == "pdf_page_geometry":
            locator.update(exact=words, prefix=None, suffix=None)
        located = _bounded_locator(
            db,
            viewer_id=viewer_id,
            owner=owner,
            locator=_LOCATOR.validate_python(locator),
            exact=words,
            byte_limit=byte_limit,
            source_identity=source_identity,
        )
        locator = located.model_dump(mode="json") if located is not None else None
    if scoped_authority and locator is None:
        raise missing
    if owner.scheme in ("media", "fragment"):
        source = _reader_source(db, viewer_id, owner, location_label=row.label)
    else:
        source = CapturedSource(
            ref=owner.uri,
            title="annotation" if owner.scheme == "highlight" else "Note",
            media_kind=None,
            contributors=None,
            location_label=row.label,
        )
    field = "annotation" if owner.scheme == "highlight" else None
    return CapturedEvidence(
        quote=CapturedQuote(
            excerpt=plain_excerpt(words), exact=words, prefix=None, suffix=None, color=None
        ),
        source=source,
        target=CapturedPassageTarget(
            owner_ref=owner.uri,
            field=field,
            locator=_LOCATOR.validate_python(locator),
            precision=_precision(locator),
            source_identity=source_identity,
        )
        if locator is not None
        else CapturedUnavailableTarget(owner_ref=owner.uri, field=field),
    )


def _bounded_locator(
    db: Session,
    *,
    viewer_id: UUID,
    owner: ResourceRef,
    locator: RetrievalLocator,
    exact: str,
    byte_limit: int,
    source_identity: str | None = None,
) -> RetrievalLocator | None:
    """Prove only a stored locator's selected words; stale evidence is not requoted."""
    from nexus.services.text_quote import normalize_for_match

    raw = locator.model_dump(mode="json")
    kind = locator.type
    parameters: dict[str, Any] = {"viewer": viewer_id, "id": owner.id, "limit": byte_limit}
    sql = None
    if kind in ("web_text_offsets", "epub_fragment_offsets", "x_capture_offsets"):
        parameters |= {
            "fragment": UUID(raw["fragment_id"]),
            "start": raw["start_offset"],
            "size": raw["end_offset"] - raw["start_offset"],
        }
        if kind == "x_capture_offsets":
            if owner.scheme != "fragment" or str(owner.id) != raw["fragment_id"]:
                return None
            parameters["capture"] = UUID(raw["capture_id"])
            sql = "SELECT substring(canonical_text FROM :start+1 FOR :size) AS words FROM fragments WHERE id=:fragment AND x_post_capture_id=:capture"
        else:
            parameters["source"] = UUID(raw["media_id"])
            sql = "SELECT substring(f.canonical_text FROM :start+1 FOR :size) AS words FROM fragments f JOIN media reading ON reading.id=:id LEFT JOIN media_parts part ON part.media_id=reading.id WHERE f.id=:fragment AND f.media_id=:source AND f.media_id=COALESCE(part.source_media_id,reading.id)"
    elif kind in ("note_block_offsets", "highlight_annotation_offsets"):
        parameters |= {
            "start": raw["start_offset"],
            "size": raw["end_offset"] - raw["start_offset"],
        }
        sql = (
            "SELECT substring(body_text FROM :start+1 FOR :size) AS words FROM note_blocks WHERE id=:id AND user_id=:viewer AND authored_visible"
            if kind == "note_block_offsets"
            else "SELECT substring(annotation_body_text FROM :start+1 FOR :size) AS words FROM highlights WHERE id=:id AND user_id=:viewer AND authored_visible"
        )
    elif kind in ("pdf_page_geometry", "pdf_page"):
        return (
            locator
            if db.scalar(
                text(
                    "SELECT EXISTS (SELECT 1 FROM media m JOIN reader_publications p ON p.media_id=m.id WHERE m.id=:id AND :page BETWEEN 1 AND m.page_count AND 'g' || p.generation::text=:identity)"
                ),
                {"id": owner.id, "page": raw["page_number"], "identity": source_identity},
            )
            else None
        )
    elif kind == "message_offsets":
        if owner.scheme != "conversation" or str(owner.id) != str(raw["conversation_id"]):
            return None
        parameters |= {
            "message": UUID(str(raw["message_id"])),
            "start": raw["start_offset"],
            "size": raw["end_offset"] - raw["start_offset"],
        }
        sql = "SELECT substring(content FROM :start+1 FOR :size) AS words FROM messages WHERE id=:message AND conversation_id=:id"
    elif kind == "external_url":
        return locator
    elif kind in TIMED_KINDS:
        parameters |= {"start": raw["t_start_ms"], "end": raw["t_end_ms"]}
        size = db.scalar(
            text(
                "SELECT COALESCE(sum(octet_length(canonical_text)+1),0) FROM fragments WHERE media_id=:id AND t_end_ms>:start AND t_start_ms<:end"
            ),
            parameters,
        )
        if size > byte_limit:
            raise PromptEvidenceTooLarge(owner.uri)
        sql = "SELECT string_agg(canonical_text,E'\\n' ORDER BY t_start_ms,idx) AS words FROM fragments WHERE media_id=:id AND t_end_ms>:start AND t_start_ms<:end HAVING min(t_start_ms)=:start AND max(t_end_ms)=:end"
    if sql is None:
        return None
    size = db.scalar(text(f"SELECT octet_length(words) FROM ({sql}) selected"), parameters)
    if size is None:
        return None
    if size > byte_limit:
        raise PromptEvidenceTooLarge(owner.uri)
    words = db.scalar(text(sql), parameters)
    if normalize_for_match(words).text.strip() != normalize_for_match(exact).text.strip():
        return None
    return locator


def capture_evidence(
    db: Session,
    *,
    viewer_id: UUID,
    ref: ResourceRef,
    reading_media_id: UUID | None = None,
    field: ResourceField = None,
) -> CapturedEvidence:
    """A current readable target's complete words and location, captured together. 404
    when the viewer cannot see it; 409 ``E_READER_CONTENT_CHANGED`` when its publication
    changes under the capture (I7)."""
    validate_resource_field(ref.uri, field)
    if field == "annotation":
        from nexus.services.highlights import annotation_locator, read_highlight_annotations

        annotation = read_highlight_annotations(
            db, viewer_id=viewer_id, highlight_ids=[ref.id]
        ).get(ref.id)
        if annotation is None:
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Annotation not found")
        locator = annotation_locator(ref.id, annotation.body_text)
        return CapturedEvidence(
            quote=CapturedQuote(
                excerpt=plain_excerpt(annotation.body_text),
                exact=annotation.body_text,
                prefix=None,
                suffix=None,
                color=None,
            )
            if locator is not None
            else None,
            source=CapturedSource(
                ref=ref.uri,
                title="annotation",
                media_kind=None,
                contributors=None,
                location_label="annotation",
            ),
            target=CapturedPassageTarget(
                field="annotation",
                owner_ref=ref.uri,
                locator=_LOCATOR.validate_python(locator),
                precision="exact",
                source_identity=None,
            )
            if locator is not None
            else CapturedResourceTarget(field="annotation", owner_ref=ref.uri),
        )
    if ref.scheme in ("highlight", "passage_anchor"):
        stored = read_captures(db, [ref.uri]).get(ref.uri)
        if stored is not None and require_ref(stored["source_ref"]).scheme in ("media", "fragment"):
            return _stored_reader_evidence(
                db, viewer_id=viewer_id, ref=ref, stored=stored, reading_media_id=reading_media_id
            )
    item = resource_item_out(db, viewer_id=viewer_id, ref=ref, reading_media_id=reading_media_id)
    if item.missing:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Resource not found")
    return _capture(db, viewer_id, ref, item, reading_media_id=reading_media_id)


def _stored_reader_evidence(
    db: Session,
    *,
    viewer_id: UUID,
    ref: ResourceRef,
    stored: dict[str, Any],
    reading_media_id: UUID | None,
) -> CapturedEvidence:
    """Stored authored words already have provenance; only current disclosure is decided."""
    from nexus.auth.permissions import can_read_highlight, requested_media_ids_cte_sql
    from nexus.services.resource_items.locations import passage_owner_sql

    if ref.scheme == "highlight":
        if not can_read_highlight(db, viewer_id, ref.id):
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Highlight not found")
        row = db.execute(
            text("SELECT prefix,suffix,color FROM highlights WHERE id=:id AND authored_visible"),
            {"id": ref.id},
        ).first()
        if row is None:
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Highlight not found")
        prefix, suffix, color = row.prefix, row.suffix, row.color
    else:
        row = db.execute(
            text("SELECT selector FROM passage_anchors WHERE id=:id AND user_id=:viewer"),
            {"id": ref.id, "viewer": viewer_id},
        ).first()
        if row is None:
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Passage not found")
        prefix, suffix, color = (
            row.selector["quote"].get("prefix"),
            row.selector["quote"].get("suffix"),
            None,
        )
    source = require_ref(stored["source_ref"])
    raw = stored["capture"]["value"]
    locator = _LOCATOR.validate_python(raw["locator"]) if raw["locator"] is not None else None
    owner = (
        ResourceRef("media", reading_media_id)
        if reading_media_id is not None and source.scheme == "media"
        else source
    )
    if source.scheme == "media" and reading_media_id is not None:
        same_source = db.scalar(
            text("""SELECT EXISTS (
            SELECT 1 FROM media reading LEFT JOIN media_parts rp ON rp.media_id=reading.id
            JOIN media source ON source.id=:source LEFT JOIN media_parts sp ON sp.media_id=source.id
            WHERE reading.id=:reading AND COALESCE(rp.source_media_id,reading.id)=COALESCE(sp.source_media_id,source.id))"""),
            {"reading": reading_media_id, "source": source.id},
        )
        if not same_source:
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Source passage is outside this reading")
    if (
        source.scheme == "media"
        and reading_media_id is None
        and not can_read_media(db, viewer_id, source.id)
    ):
        if not isinstance(locator, (WebTextOffsetsLocator, EpubFragmentOffsetsLocator)):
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Source passage not found")
        chosen = db.scalar(
            text(
                passage_owner_sql(
                    requested_media_ids_cte_sql(),
                    source=":source",
                    fragment=":fragment",
                    start=":start",
                    end=":end",
                )
            ),
            {
                "viewer_id": viewer_id,
                "source": source.id,
                "fragment": UUID(str(locator.fragment_id)),
                "start": locator.start_offset,
                "end": locator.end_offset,
            },
        )
        if chosen is None:
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Source passage not found")
        owner = ResourceRef("media", chosen)
    publication = raw["publication"]
    identity = (
        f"g{publication['generation']}"
        if publication is not None and publication["kind"] == "reader"
        else str(locator.capture_id)
        if isinstance(locator, XCaptureOffsetsLocator)
        else None
    )
    evidence = CapturedEvidence(
        quote=CapturedQuote(
            excerpt=raw["excerpt"],
            exact=raw["quote_exact"],
            prefix=prefix,
            suffix=suffix,
            color=color,
        ),
        source=CapturedSource(
            ref=owner.uri, title=None, media_kind=None, contributors=None, location_label=None
        ),
        target=CapturedPassageTarget(
            owner_ref=owner.uri,
            field=None,
            locator=locator,
            precision=_precision(locator.model_dump(mode="json")),
            source_identity=identity,
        )
        if locator is not None
        else CapturedUnavailableTarget(owner_ref=owner.uri, field=None),
    )
    admitted = admit_captured_evidence(
        db, viewer_id=viewer_id, evidence=evidence, reading_media_id=reading_media_id
    )
    if admitted is None:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Source passage not found")
    return admitted.model_copy(
        update={
            "source": _reader_source(db, viewer_id, require_ref(admitted.target.owner_ref or ""))
        }
    )


def _capture(
    db: Session,
    viewer_id: UUID,
    ref: ResourceRef,
    item: ResourceItemOut,
    *,
    reading_media_id: UUID | None = None,
) -> CapturedEvidence:
    source_ref = item.preview.source.ref if item.preview.source else ref.uri
    media = (
        assert_resource_ref(source_ref).id
        if source_ref and source_ref.startswith("media:")
        else None
    )
    before = source_identities(db, [media]).get(media) if media else None
    from nexus.services.note_bodies import read_notes

    quote: CapturedQuote | None = None
    locator: dict[str, Any] | None = None
    owner = ref
    scoped = media_passages(
        db,
        viewer_id=viewer_id,
        refs=[ref],
        reading_media_ids={ref.uri: reading_media_id} if reading_media_id is not None else None,
    ).get(ref.uri)
    if scoped is not None:
        owner, locator = scoped.owner, scoped.locator
        quote = (
            captured_quote(scoped)
            if ref.scheme in ("highlight", "passage_anchor")
            else CapturedQuote(
                excerpt=plain_excerpt(scoped.quote.exact, scoped.quote.prefix, scoped.quote.suffix),
                **scoped.quote.model_dump(),
            )
        )
    elif ref.scheme in ("evidence_span", "content_chunk", "oracle_passage_anchor"):
        passage = current_passages(
            db,
            viewer_id=viewer_id,
            refs=[ref],
            reading_media_ids={ref.uri: reading_media_id} if reading_media_id is not None else None,
        ).get(ref.uri)
        if passage is None or passage.owner.scheme == "media":
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Source passage not found")
        owner, locator = passage.owner, passage.locator
        quote = CapturedQuote(
            excerpt=plain_excerpt(passage.quote.exact, passage.quote.prefix, passage.quote.suffix),
            **passage.quote.model_dump(),
        )
    elif ref.scheme in ("highlight", "fragment", "reader_apparatus_item"):
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Source passage not found")
    elif ref.scheme == "passage_anchor":
        row = db.execute(
            text("SELECT owner_scheme, owner_id, selector FROM passage_anchors WHERE id = :id"),
            {"id": ref.id},
        ).one()
        owner = assert_resource_ref(f"{row.owner_scheme}:{row.owner_id}")
        words = row.selector["quote"]
        saved = read_captures(db, [ref.uri])[ref.uri]["capture"]["value"]
        quote = CapturedQuote(
            excerpt=saved["excerpt"],
            exact=saved["quote_exact"],
            prefix=words.get("prefix"),
            suffix=words.get("suffix"),
            color=None,
        )
        from nexus.services import locator_resolver

        locator = resolve_quote(
            db,
            owner,
            quote,
            row.selector.get("locator_hint"),
            locator_resolver.read_passage_sources(
                db, [(owner.scheme, owner.id)], viewer_id=viewer_id
            ),
        )
    elif ref.scheme == "note_block":
        note = read_notes(db, viewer_id=viewer_id, note_ids=[ref.id]).get(ref.id)
        if note is None:
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Note not found")
        quote = CapturedQuote(
            excerpt=plain_excerpt(note.body_text, None, None),
            exact=note.body_text,
            prefix=None,
            suffix=None,
            color=None,
        )
        if note.body_text:
            locator = {
                "type": "note_block_offsets",
                "block_id": str(ref.id),
                "start_offset": 0,
                "end_offset": len(note.body_text),
                "body_version": None,
                "text_quote_selector": {"exact": note.body_text},
            }
    elif ref.scheme == "message":
        row = db.execute(
            text("SELECT conversation_id, content, seq FROM messages WHERE id = :id"),
            {"id": ref.id},
        ).one()
        owner = ResourceRef("conversation", row.conversation_id)
        quote = CapturedQuote(
            excerpt=plain_excerpt(row.content, None, None),
            exact=row.content,
            prefix=None,
            suffix=None,
            color=None,
        )
        if row.content:
            locator = {
                "type": "message_offsets",
                "conversation_id": str(owner.id),
                "message_id": str(ref.id),
                "message_seq": row.seq,
                "start_offset": 0,
                "end_offset": len(row.content),
                "text_quote_selector": {"exact": row.content},
            }
    field = (
        "annotation"
        if locator is not None and locator["type"] == "highlight_annotation_offsets"
        else None
    )
    if (
        quote is not None
        and ref.scheme not in ("highlight", "passage_anchor")
        and locator is not None
        and locator["type"] in ("web_text_offsets", "epub_fragment_offsets", "x_capture_offsets")
    ):
        from nexus.services.source_excerpt import SourceExcerptRequest, source_excerpts

        reading = (
            owner.id if owner.scheme in ("media", "fragment") else UUID(str(locator["media_id"]))
        )
        frozen = source_excerpts(
            db,
            [
                SourceExcerptRequest(
                    reading_id=reading,
                    fragment_id=UUID(str(locator["fragment_id"])),
                    start=locator["start_offset"],
                    end=locator["end_offset"],
                )
            ],
        )[0]
        quote = quote.model_copy(update={"excerpt": frozen})
    if locator is not None and locator["type"] == "note_block_offsets":
        # Note offsets freeze with the body version they were proven against.
        proof = CapturedPassageTarget(
            field=None,
            owner_ref=owner.uri,
            locator=_LOCATOR.validate_python(locator),
            precision="exact",
            source_identity=None,
        )
        locator = current_locator(proof, quote, location_reads(db, viewer_id, [proof]))
        if locator is not None and quote is not None:
            quote = quote.model_copy(update={"exact": locator["text_quote_selector"]["exact"]})
    source = source_attributions(db, viewer_id=viewer_id, refs=[owner]).get(owner.uri)
    captured_source = CapturedSource(
        ref=source.ref if source else None,
        title=source.title if source else None,
        media_kind=source.media_kind if source else None,
        contributors=source.contributors if source else None,
        location_label=item.preview.source.location_label
        if source and item.preview.source
        else None,
    )
    target: CapturedTarget
    if quote is None:
        target = CapturedResourceTarget(field=field, owner_ref=owner.uri)
    elif locator is None:
        target = CapturedUnavailableTarget(field=field, owner_ref=owner.uri)
    else:
        target = CapturedPassageTarget(
            field=field,
            owner_ref=owner.uri,
            locator=_LOCATOR.validate_python(locator),
            precision=_precision(locator),
            source_identity=locator["capture_id"]
            if locator["type"] == "x_capture_offsets"
            else before,
        )
    if media and before != source_identities(db, [media]).get(media):
        raise ConflictError(
            ApiErrorCode.E_READER_CONTENT_CHANGED, "Source changed during evidence capture"
        )
    return CapturedEvidence(quote=quote, source=captured_source, target=target)


def _precision(locator: dict[str, Any]) -> LocationPrecision:
    if locator["type"] in TIMED_KINDS:
        return "time"
    if locator["type"] == "pdf_page":
        return "page"
    return "approximate" if locator.get("projection") == "proportional_text_offsets" else "exact"


def _admitted_evidence(
    db: Session,
    *,
    viewer_id: UUID,
    evidence: CapturedEvidence,
    reading_media_id: UUID | None = None,
) -> tuple[CapturedEvidence, dict[str, Any], tuple[tuple[int, int], ...]] | None:
    """Historical words remain frozen, but current scope governs their disclosure."""
    target = evidence.target
    if target.field == "annotation":
        owner = require_ref(target.owner_ref or "")
        allowed = db.scalar(
            text(
                "SELECT EXISTS(SELECT 1 FROM highlights WHERE id=:id AND user_id=:viewer AND authored_visible)"
            ),
            {"id": owner.id, "viewer": viewer_id},
        )
        return (evidence, {"kind": "capture"}, ()) if allowed else None
    owner_ref = target.owner_ref or evidence.source.ref
    if not isinstance(target, CapturedPassageTarget):
        if evidence.quote is not None and owner_ref and owner_ref.startswith("media:"):
            owner_id = assert_resource_ref(owner_ref).id
            kind = db.scalar(text("SELECT kind FROM media WHERE id=:id"), {"id": owner_id})
            if (
                reading_media_id not in (None, owner_id)
                or kind == "text_part"
                or not can_read_media(db, viewer_id, owner_id)
            ):
                return None
        return evidence, {"kind": "capture"}, ()
    if target.locator.type == "x_capture_offsets":
        from nexus.services.media_text_scope import x_capture_scope_rows_sql
        from nexus.services.x_source import readable_x_capture_ids_sql

        owner = assert_resource_ref(target.owner_ref)
        if (
            owner.scheme != "fragment"
            or str(owner.id) != str(target.locator.fragment_id)
            or evidence.quote is None
        ):
            return None
        locator = target.locator
        words = db.scalar(
            text(f"""SELECT substring(f.canonical_text FROM :start+1 FOR :size)
            FROM fragments f WHERE f.id=:fragment AND f.x_post_capture_id=:capture
              AND f.x_post_capture_id IN ({readable_x_capture_ids_sql()})
              AND :start>=0 AND :end<=char_length(f.canonical_text)"""),
            {
                "viewer_id": viewer_id,
                "fragment": owner.id,
                "capture": locator.capture_id,
                "start": locator.start_offset,
                "end": locator.end_offset,
                "size": locator.end_offset - locator.start_offset,
            },
        )
        if words != evidence.quote.exact:
            return None
        if reading_media_id is not None and (
            not can_read_media(db, viewer_id, reading_media_id)
            or not db.scalar(
                text(
                    f"SELECT EXISTS (SELECT 1 FROM ({x_capture_scope_rows_sql('SELECT CAST(:reading AS uuid) AS media_id')}) occurrence WHERE occurrence.fragment_id=:fragment AND occurrence.capture_id=:capture)"
                ),
                {"reading": reading_media_id, "fragment": owner.id, "capture": locator.capture_id},
            )
        ):
            return None
        return evidence, {"kind": "capture"}, ()
    if not target.owner_ref.startswith("media:"):
        return evidence, {"kind": "capture"}, ()
    owner = assert_resource_ref(target.owner_ref)
    quote = evidence.quote
    if quote is None:
        return None
    owner_kind = db.scalar(text("SELECT kind FROM media WHERE id=:id"), {"id": owner.id})
    if (
        owner_kind is not None
        and owner_kind != "text_part"
        and reading_media_id in (None, owner.id)
        and can_read_media(db, viewer_id, owner.id)
    ):
        # Whole-source authority admits the saved evidence independently of
        # current fragments. Placement is resolved separately for activation.
        return evidence, {"kind": "capture"}, ()
    from nexus.services.media_text_scope import passage_scope_rows_sql

    reading = reading_media_id or owner.id
    locator = target.locator
    if not isinstance(
        locator, (WebTextOffsetsLocator, EpubFragmentOffsetsLocator)
    ) or not can_read_media(db, viewer_id, reading):
        return None
    bounds = db.execute(
        text(f"""SELECT scope.start_offset,scope.end_offset,
            substring(f.canonical_text FROM :start+1 FOR :size) AS exact
        FROM ({passage_scope_rows_sql("SELECT CAST(:reading AS uuid) AS media_id")}) scope
        JOIN fragments f ON f.id=scope.fragment_id
        WHERE scope.source_media_id=:source AND scope.fragment_id=:fragment
          AND scope.start_offset<=:start AND scope.end_offset>=:end"""),
        {
            "reading": reading,
            "source": UUID(str(locator.media_id)),
            "fragment": UUID(str(locator.fragment_id)),
            "start": locator.start_offset,
            "end": locator.end_offset,
            "size": locator.end_offset - locator.start_offset,
        },
    ).first()
    if bounds is None or bounds.exact != quote.exact:
        return None
    extent = quote.excerpt.source_extent
    scope = (
        {"kind": "interval", "start_offset": bounds.start_offset, "end_offset": bounds.end_offset}
        if extent is not None
        else {"kind": "selection"}
    )
    prefix_limit, suffix_limit = (
        locator.start_offset - bounds.start_offset,
        bounds.end_offset - locator.end_offset,
    )
    quote = quote.model_copy(
        update={
            "prefix": quote.prefix[-prefix_limit:] if quote.prefix and prefix_limit else None,
            "suffix": quote.suffix[:suffix_limit] if quote.suffix and suffix_limit else None,
        }
    )
    return (
        evidence.model_copy(
            update={
                "quote": quote,
                "target": target.model_copy(update={"owner_ref": f"media:{reading}"}),
            }
        ),
        scope,
        _incomplete_quote_tables(db, reading, UUID(str(locator.fragment_id)))
        if contains_table(quote.excerpt)
        else (),
    )


def admit_captured_evidence(
    db: Session,
    *,
    viewer_id: UUID,
    evidence: CapturedEvidence,
    reading_media_id: UUID | None = None,
) -> CapturedEvidence | None:
    """Current disclosure of frozen evidence; no discovery or whole-source body read."""
    admitted = _admitted_evidence(
        db, viewer_id=viewer_id, evidence=evidence, reading_media_id=reading_media_id
    )
    if admitted is None:
        return None
    accepted, scope, incomplete = admitted
    if accepted.quote is None:
        return accepted
    excerpt = scope_excerpts(
        [{"excerpt": accepted.quote.excerpt.model_dump(mode="json"), "scope": scope}],
        incomplete_tables=[incomplete],
    )[0]
    if excerpt is None:
        return None
    return accepted.model_copy(
        update={"quote": accepted.quote.model_copy(update={"excerpt": excerpt})}
    )


def evidence_items(
    db: Session,
    *,
    viewer_id: UUID,
    occurrences: Sequence[tuple[ResourceRef, CapturedEvidence, SourceTargetKey]],
) -> list[ResourceItemOut]:
    """Each occurrence as an item of its frozen words and attribution; the current state
    of the cited ref's owner decides only whether the location still opens (I6)."""
    admissions = [
        _admitted_evidence(db, viewer_id=viewer_id, evidence=evidence)
        for _, evidence, _ in occurrences
    ]
    quoted_admissions = [
        value for value in admissions if value is not None and value[0].quote is not None
    ]
    frozen = iter(
        scope_excerpts(
            [
                {"excerpt": quote.excerpt.model_dump(mode="json"), "scope": value[1]}
                for value in quoted_admissions
                if (quote := value[0].quote) is not None
            ],
            incomplete_tables=[value[2] for value in quoted_admissions],
        )
    )
    admitted: list[CapturedEvidence | None] = []
    for admission in admissions:
        if admission is None:
            admitted.append(None)
        elif admission[0].quote is None:
            admitted.append(admission[0])
        else:
            excerpt = next(frozen)
            admitted.append(
                None
                if excerpt is None
                else admission[0].model_copy(
                    update={"quote": admission[0].quote.model_copy(update={"excerpt": excerpt})}
                )
            )
    targets = [
        _source_target_from_admitted(db, viewer_id=viewer_id, evidence=value)
        if value is not None
        else _UNAVAILABLE_SOURCE
        for value in admitted
    ]
    projected = iter(
        project_excerpts(
            [
                {
                    "source_ref": original.source.ref,
                    "capture": {"kind": "evidence", "value": original.model_dump(mode="json")},
                    "mode": "full",
                    "scope": admission[1],
                }
                for (_, original, _), admission, value in zip(
                    occurrences, admissions, admitted, strict=True
                )
                if admission is not None and value is not None and value.quote is not None
            ]
        )
    )
    out = []
    for (ref, evidence, key), value, resolved in zip(occurrences, admitted, targets, strict=True):
        if value is None or resolved.source_activation is None:
            if value is not None and value.quote is not None:
                next(projected)
            out.append(
                ResourceItemOut(
                    authored_by_viewer=False,
                    ref=ref.uri,
                    action_ref=ref.uri,
                    label="source unavailable",
                    missing=True,
                    preview=ResourcePreviewOut(
                        body=NamedResourceBodyOut(
                            title="source unavailable",
                            image_url=None,
                            media_kind=None,
                            contributors=None,
                        ),
                        source=None,
                    ),
                    activation=ResourceActivationOut(
                        field=None,
                        resource_ref=ref.uri,
                        kind="none",
                        href=None,
                        unavailable_reason="source_unavailable",
                    ),
                )
            )
            continue
        evidence = value
        frozen = evidence.source
        attribution = SourceAttributionOut(
            **frozen.model_dump(), activation=resolved.source_activation
        )
        activation = _occurrence_activation(ref.uri, key, evidence, resolved.source_activation)
        if isinstance(resolved.location, UnavailableSourceLocationOut):
            activation = ResourceActivationOut(
                field=None,
                resource_ref=ref.uri,
                kind="none",
                href=None,
                unavailable_reason="location_unavailable",
            )
        quote = evidence.quote
        projection = next(projected) if quote else None
        body = (
            passage_body(
                projection, quote.color, reading_ref=evidence.target.owner_ref, captured=False
            )
            if quote and projection is not None
            else NamedResourceBodyOut(
                title=frozen.title or "Source",
                image_url=None,
                media_kind=frozen.media_kind,
                contributors=frozen.contributors,
            )
        )
        out.append(
            ResourceItemOut(
                authored_by_viewer=False,
                ref=ref.uri,
                action_ref=ref.uri,
                missing=False,
                label=passage_label(projection.text_parts.exact)
                if projection is not None and projection.text_parts is not None
                else frozen.title or "Source",
                preview=ResourcePreviewOut(body=body, source=attribution),
                activation=activation,
            )
        )
    return out


def _occurrence_activation(
    ref: str,
    key: SourceTargetKey,
    evidence: CapturedEvidence,
    source: ResourceActivationOut | None,
) -> ResourceActivationOut:
    """The owner's route with the occurrence as its fragment (I5): ``#quote-``,
    ``#citation-``, ``#retrieval-``; an outside source opens as itself."""
    if evidence.target.field == "annotation":
        owner = require_ref(evidence.target.owner_ref or "")
        return ResourceActivationOut(
            field="annotation",
            resource_ref=owner.uri,
            kind="route",
            href=f"/highlights/{owner.id}#annotation",
        )
    if source is None or source.kind == "none":
        return ResourceActivationOut(
            field=None,
            resource_ref=ref,
            kind="none",
            href=None,
            unavailable_reason="source_unavailable",
        )
    if evidence.target.kind == "unavailable":
        return ResourceActivationOut(
            field=None,
            resource_ref=ref,
            kind="none",
            href=None,
            unavailable_reason="location_unavailable",
        )
    if source.kind == "external" or isinstance(key, ResourceSourceTargetKey):
        return source.model_copy(update={"resource_ref": ref})
    match key:
        case ReaderQuoteSourceTargetKey():
            fragment = f"quote-{key.message_id}"
        case CitationSourceTargetKey():
            fragment = f"citation-{key.edge_id}"
        case RetrievalSourceTargetKey():
            fragment = f"retrieval-{key.retrieval_id}"
    href = source.href.split("#", 1)[0] + "#" + fragment if source.href else None
    return ResourceActivationOut(field=None, resource_ref=ref, kind=source.kind, href=href)


def resolve_source_target(
    db: Session, *, viewer_id: UUID, target: SourceTargetKey, reading_media_id: UUID | None = None
) -> SourceTargetOut:
    """Where a key opens now (J9, I18). A whole resource answers its activation; a passage
    its proven current extent, else ``unavailable``. A resource key the viewer cannot see,
    or whose publication moves during this read, is ``unavailable``, never an error; a
    quote, citation or retrieval key naming nothing the viewer can read is 404 (a citation
    reads for whoever reads what cites it); a malformed resource ref is 400."""
    match target:
        case ResourceSourceTargetKey():
            ref = require_ref(target.resource_ref)
            if target.field == "annotation":
                try:
                    evidence = capture_evidence(
                        db, viewer_id=viewer_id, ref=ref, field="annotation"
                    )
                except NotFoundError:
                    return _UNAVAILABLE_SOURCE
                captured = evidence.target
                activation = ResourceActivationOut(
                    field="annotation",
                    resource_ref=ref.uri,
                    kind="route",
                    href=f"/highlights/{ref.id}#annotation",
                )
                if captured.kind == "resource":
                    return SourceTargetOut(
                        source_activation=activation, location=WholeSourceLocationOut()
                    )
                assert isinstance(captured, CapturedPassageTarget)
                return SourceTargetOut(
                    source_activation=activation,
                    location=LocatedSourceLocationOut(
                        locator=captured.locator,
                        precision="exact",
                        source_identity=None,
                        apparatus_reference_id=None,
                    ),
                )
            if (
                reading_media_id is not None
                and ref.scheme == "media"
                and ref.id != reading_media_id
            ):
                return _UNAVAILABLE_SOURCE
            item = resource_item_out(
                db, viewer_id=viewer_id, ref=ref, reading_media_id=reading_media_id
            )
            if item.missing:
                return _UNAVAILABLE_SOURCE
            if ref.scheme in _WHOLE:
                return SourceTargetOut(
                    source_activation=item.activation, location=WholeSourceLocationOut()
                )
            try:
                evidence = _capture(db, viewer_id, ref, item, reading_media_id=reading_media_id)
            except ConflictError:
                source = item.preview.source
                return SourceTargetOut(
                    source_activation=source.activation if source else None,
                    location=UnavailableSourceLocationOut(reason="location_unavailable"),
                )
        case RetrievalSourceTargetKey():
            raw = db.scalar(
                text(
                    "SELECT r.captured_evidence FROM message_retrievals r"
                    " JOIN messages m ON m.id = r.assistant_message_id"
                    " JOIN conversations c ON c.id = m.conversation_id"
                    " WHERE r.id = :id AND c.owner_user_id = :viewer_id"
                ),
                {"id": target.retrieval_id, "viewer_id": viewer_id},
            )
            if raw is None:
                raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Retrieval not found")
            evidence = CapturedEvidence.model_validate(raw)
        case ReaderQuoteSourceTargetKey():
            from nexus.services.chat.quotes import decode

            raw = db.scalar(
                text(
                    "SELECT m.reader_selection_snapshot FROM messages m"
                    " JOIN conversations c ON c.id = m.conversation_id"
                    " WHERE m.id = :id AND c.owner_user_id = :viewer_id"
                ),
                {"id": target.message_id, "viewer_id": viewer_id},
            )
            if raw is None:
                raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Quote not found")
            evidence = decode(raw).evidence
        case CitationSourceTargetKey():
            from nexus.schemas.resource_graph import CitationSnapshot

            row = db.execute(
                text(
                    "SELECT snapshot, source_scheme || ':' || source_id AS source"
                    " FROM resource_edges"
                    " WHERE id = :id AND origin = 'citation' AND ordinal IS NOT NULL"
                    f" AND {edge_live_sql('resource_edges')}"
                ),
                {"id": target.edge_id},
            ).first()
            if row is None or not ref_visible(
                db, viewer_id=viewer_id, ref=assert_resource_ref(row.source)
            ):
                raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Citation not found")
            snapshot = CitationSnapshot.model_validate(row.snapshot)
            assert snapshot.evidence is not None
            evidence = snapshot.evidence
    admitted = admit_captured_evidence(
        db, viewer_id=viewer_id, evidence=evidence, reading_media_id=reading_media_id
    )
    return (
        _source_target_from_admitted(db, viewer_id=viewer_id, evidence=admitted)
        if admitted is not None
        else _UNAVAILABLE_SOURCE
    )


def _source_target_from_admitted(
    db: Session, *, viewer_id: UUID, evidence: CapturedEvidence
) -> SourceTargetOut:
    """A bounded current placement proof for already admitted frozen words."""
    from nexus.services.resource_items.routing import (
        captured_passage_activation,
        source_activation_for_ref,
    )

    captured = evidence.target
    owner_ref = captured.owner_ref or evidence.source.ref
    if owner_ref is None:
        return _UNAVAILABLE_SOURCE
    owner = assert_resource_ref(owner_ref)
    if not ref_visible(db, viewer_id=viewer_id, ref=owner):
        return _UNAVAILABLE_SOURCE
    activation = (
        captured_passage_activation(captured)
        if isinstance(captured, CapturedPassageTarget)
        else source_activation_for_ref(db, viewer_id=viewer_id, ref=owner, field=captured.field)
    )
    if activation.kind == "none":
        return _UNAVAILABLE_SOURCE
    if captured.kind == "resource":
        return SourceTargetOut(source_activation=activation, location=WholeSourceLocationOut())
    unavailable = SourceTargetOut(
        source_activation=activation,
        location=UnavailableSourceLocationOut(reason="location_unavailable"),
    )
    if captured.kind == "unavailable":
        return unavailable
    try:
        locator = _bounded_locator(
            db,
            viewer_id=viewer_id,
            owner=owner,
            locator=captured.locator,
            exact=evidence.quote.exact if evidence.quote else "",
            byte_limit=policy("chat").input_max_bytes,
            source_identity=captured.source_identity,
        )
    except PromptEvidenceTooLarge:
        return unavailable
    if locator is None:
        return unavailable
    apparatus_reference_id = None
    if owner.scheme == "media":
        from nexus.services.reader_apparatus import note_reference_for_locator

        apparatus_reference_id = note_reference_for_locator(
            db, viewer_id=viewer_id, media_id=owner.id, locator=locator
        )
    return SourceTargetOut(
        source_activation=activation,
        location=LocatedSourceLocationOut(
            locator=locator,
            precision="page" if locator.type == "pdf_page" else captured.precision,
            source_identity=captured.source_identity,
            apparatus_reference_id=apparatus_reference_id,
        ),
    )
