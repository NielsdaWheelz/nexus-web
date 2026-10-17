"""Frozen evidence projection and the single source-target resolver.

Capture happens when words enter a candidate or quote. Publication only copies it.
A historical read never asks the current target for replacement words or metadata.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any
from uuid import UUID

from pydantic import TypeAdapter
from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.errors import ApiErrorCode, ConflictError, NotFoundError
from nexus.schemas.resource_evidence import (
    CapturedEvidence,
    CapturedPassageTarget,
    CapturedQuote,
    CapturedResourceTarget,
    CapturedSource,
    CapturedTarget,
    CapturedUnavailableTarget,
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
    PdfPageLocator,
    PlaybackTimeRangeLocator,
    RetrievalLocator,
    TranscriptTimeRangeLocator,
    WebTextOffsetsLocator,
)
from nexus.services import locator_resolver, text_quote
from nexus.services.resource_graph.refs import ResourceRef, assert_resource_ref
from nexus.services.resource_items.items import (
    passage_body,
    resource_item_out,
    resource_items_out,
    source_attributions,
)

_LOCATOR = TypeAdapter(RetrievalLocator)


def capture_evidence(db: Session, *, viewer_id: UUID, ref: ResourceRef) -> CapturedEvidence:
    """Capture a current readable target's complete words and location together."""
    item = resource_item_out(db, viewer_id=viewer_id, ref=ref)
    if item.missing:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Resource not found")
    source_ref = (
        item.preview.source.ref
        if item.preview.source
        else ref.uri
        if ref.scheme == "media"
        else None
    )
    media_owner = (
        assert_resource_ref(source_ref).id
        if source_ref and source_ref.startswith("media:")
        else None
    )
    before = source_identities(db, [media_owner]).get(media_owner) if media_owner else None
    quote: CapturedQuote | None = None
    locator: dict[str, Any] | None = None
    captured_note = None
    owner = ref
    precision: LocationPrecision = "exact"
    if ref.scheme == "highlight":
        row = locator_resolver.read_highlight_reader_source(db, highlight_id=ref.id)
        if row is None:
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Highlight not found")
        owner = ResourceRef("media", row.media_id)
        quote = CapturedQuote(
            exact=row.exact, prefix=row.prefix, suffix=row.suffix, color=row.color
        )
        found = row.target
        if found is not None:
            raw = found.model_dump(mode="json")
            if raw["kind"] == "PdfPageGeometry":
                locator = {
                    "type": "pdf_page_geometry",
                    "media_id": str(owner.id),
                    "page_number": raw["page_number"],
                    "quads": raw["quads"],
                    "exact": row.exact,
                    "prefix": row.prefix,
                    "suffix": row.suffix,
                }
            elif raw["kind"] == "TranscriptTextOffsets" and raw["time_range"] is not None:
                locator = {
                    "type": "transcript_time_range",
                    "media_id": str(owner.id),
                    "t_start_ms": raw["time_range"]["start_ms"],
                    "t_end_ms": raw["time_range"]["end_ms"],
                }
            else:
                kind = row.media_kind
                locator = {
                    "type": "epub_fragment_offsets" if kind == "epub" else "web_text_offsets",
                    "media_id": str(owner.id),
                    "media_kind": kind,
                    "fragment_id": raw["fragment_id"],
                    "start_offset": raw["start_offset"],
                    "end_offset": raw["end_offset"],
                }
            locator["text_quote_selector"] = {
                "exact": quote.exact,
                "prefix": quote.prefix or "",
                "suffix": quote.suffix or "",
            }
    elif ref.scheme == "fragment":
        row = db.execute(
            text(
                "SELECT f.media_id, f.canonical_text, f.t_start_ms, f.t_end_ms, m.kind FROM fragments f JOIN media m ON m.id=f.media_id WHERE f.id=:id"
            ),
            {"id": ref.id},
        ).one()
        owner = ResourceRef("media", row.media_id)
        quote = CapturedQuote(exact=row.canonical_text, prefix=None, suffix=None, color=None)
        if (
            row.kind in ("podcast_episode", "video")
            and row.t_start_ms is not None
            and row.t_end_ms is not None
            and row.t_end_ms > row.t_start_ms
        ):
            locator = {
                "type": "transcript_time_range",
                "media_id": str(owner.id),
                "t_start_ms": row.t_start_ms,
                "t_end_ms": row.t_end_ms,
                "text_quote_selector": {"exact": row.canonical_text},
            }
        elif row.canonical_text:
            locator = {
                "type": "epub_fragment_offsets" if row.kind == "epub" else "web_text_offsets",
                "media_id": str(owner.id),
                "media_kind": row.kind,
                "fragment_id": str(ref.id),
                "start_offset": 0,
                "end_offset": len(row.canonical_text),
                "text_quote_selector": {"exact": row.canonical_text},
            }
    elif ref.scheme in ("evidence_span", "content_chunk", "oracle_passage_anchor"):
        current = ref
        oracle_quote = None
        if ref.scheme == "oracle_passage_anchor":
            from nexus.services.resource_graph.resolve import oracle_anchor_current_target

            anchor = db.execute(
                text(
                    "SELECT a.quote,s.media_id FROM oracle_passage_anchors a JOIN oracle_corpus_sources s ON s.id=a.corpus_source_id WHERE a.id=:id"
                ),
                {"id": ref.id},
            ).one()
            owner = ResourceRef("media", anchor.media_id)
            oracle_quote = CapturedQuote(exact=anchor.quote, prefix=None, suffix=None, color=None)
            quote = oracle_quote
            current = oracle_anchor_current_target(db, ref.id)
        if current is not None and current.scheme == "content_chunk":
            chunk = db.execute(
                text(
                    "SELECT owner_kind,owner_id,chunk_text,primary_evidence_span_id FROM content_chunks WHERE id=:id"
                ),
                {"id": current.id},
            ).one()
            owner = assert_resource_ref(f"{chunk.owner_kind}:{chunk.owner_id}")
            quote = CapturedQuote(exact=chunk.chunk_text, prefix=None, suffix=None, color=None)
            current = (
                ResourceRef("evidence_span", chunk.primary_evidence_span_id)
                if chunk.primary_evidence_span_id
                else None
            )
        if current is not None:
            span = db.execute(
                text(
                    "SELECT owner_kind,owner_id,span_text,selector,resolver_kind FROM evidence_spans WHERE id=:id"
                ),
                {"id": current.id},
            ).one()
            owner = assert_resource_ref(f"{span.owner_kind}:{span.owner_id}")
            q = span.selector.get("text_quote", {})
            if quote is None:
                quote = CapturedQuote(
                    exact=span.span_text, prefix=q.get("prefix"), suffix=q.get("suffix"), color=None
                )
            resolution = locator_resolver.evidence_resolution(
                evidence_span_id=current.id,
                owner_id=owner.id,
                span_text=span.span_text,
                selector=span.selector,
                resolver_kind=span.resolver_kind,
            )
            kind = (
                db.scalar(text("SELECT kind FROM media WHERE id=:id"), {"id": owner.id})
                if owner.scheme == "media"
                else "note"
            )
            # A chunk is one complete segment today. Refuse a partial-span substitution.
            if quote.exact == span.span_text:
                locator = locator_resolver.locator_from_resolution(
                    resolution, media_id=owner.id, media_kind=kind
                )
        if oracle_quote is not None:
            quote = oracle_quote
            locator = _resolve_quote(db, owner, quote, None) if current is not None else None
    elif ref.scheme == "passage_anchor":
        row = db.execute(
            text("SELECT owner_scheme,owner_id,selector FROM passage_anchors WHERE id=:id"),
            {"id": ref.id},
        ).one()
        owner = assert_resource_ref(f"{row.owner_scheme}:{row.owner_id}")
        q = row.selector["quote"]
        quote = CapturedQuote(
            exact=q["exact"], prefix=q.get("prefix"), suffix=q.get("suffix"), color=None
        )
        locator = _resolve_quote(db, owner, quote, row.selector.get("locator_hint"))
    elif ref.scheme == "reader_apparatus_item":
        row = db.execute(
            text("SELECT media_id,body_text,locator FROM reader_apparatus_items WHERE id=:id"),
            {"id": ref.id},
        ).one()
        owner = ResourceRef("media", row.media_id)
        quote = CapturedQuote(exact=row.body_text or "", prefix=None, suffix=None, color=None)
        locator = row.locator
    elif ref.scheme == "note_block":
        from nexus.services.note_bodies import read_note

        note = read_note(db, viewer_id=viewer_id, note_id=ref.id)
        captured_note = note
        quote = CapturedQuote(exact=note.body_text, prefix=None, suffix=None, color=None)
        if note.body_text:
            locator = {
                "type": "note_block_offsets",
                "block_id": str(ref.id),
                "start_offset": 0,
                "end_offset": len(note.body_text),
                "body_version": note.body_version,
                "text_quote_selector": {"exact": note.body_text},
            }
    elif ref.scheme == "message":
        row = db.execute(
            text("SELECT conversation_id,content,seq FROM messages WHERE id=:id"), {"id": ref.id}
        ).one()
        owner = ResourceRef("conversation", row.conversation_id)
        quote = CapturedQuote(exact=row.content, prefix=None, suffix=None, color=None)
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
    source = source_attributions(db, viewer_id=viewer_id, refs=[owner]).get(owner.uri)
    captured_source = (
        CapturedSource(
            ref=source.ref,
            title=source.title,
            media_kind=source.media_kind,
            contributors=source.contributors,
            location_label=item.preview.source.location_label if item.preview.source else None,
        )
        if source
        else CapturedSource(
            ref=None, title=None, media_kind=None, contributors=None, location_label=None
        )
    )
    if locator is not None and locator["type"] == "note_block_offsets":
        from nexus.services.note_bodies import read_note

        note = captured_note or read_note(db, viewer_id=viewer_id, note_id=owner.id)
        locator = _current_locator(
            db,
            viewer_id,
            CapturedPassageTarget(
                owner_ref=owner.uri,
                locator=_LOCATOR.validate_python(locator),
                precision=precision,
                source_identity=None,
            ),
            quote,
            {"notes": {owner.id: note}, "changed": set()},
        )
        if locator is not None and quote is not None:
            quote = quote.model_copy(update={"exact": locator["text_quote_selector"]["exact"]})
    target: CapturedTarget
    if quote is None:
        target = CapturedResourceTarget(owner_ref=owner.uri)
    elif locator is None:
        target = CapturedUnavailableTarget(owner_ref=owner.uri)
    else:
        if locator["type"] in ("transcript_time_range", "audio_time_range", "video_time_range"):
            precision = "time"
        elif locator["type"] == "pdf_page":
            precision = "page"
        elif locator.get("projection") == "proportional_text_offsets":
            precision = "approximate"
        target = CapturedPassageTarget(
            owner_ref=owner.uri,
            locator=_LOCATOR.validate_python(locator),
            precision=precision,
            source_identity=before,
        )
    if media_owner and before != source_identities(db, [media_owner]).get(media_owner):
        raise ConflictError(
            ApiErrorCode.E_READER_CONTENT_CHANGED, "Source changed during evidence capture"
        )
    return CapturedEvidence(quote=quote, source=captured_source, target=target)


def evidence_items(
    db: Session,
    *,
    viewer_id: UUID,
    occurrences: Sequence[tuple[ResourceRef, CapturedEvidence, SourceTargetKey]],
) -> list[ResourceItemOut]:
    current = {
        item.ref: item
        for item in resource_items_out(
            db, viewer_id=viewer_id, refs=[ref for ref, _, _ in occurrences]
        )
    }
    owners = list(
        {
            owner
            for _, e, _ in occurrences
            if (owner := e.target.owner_ref or e.source.ref) is not None
        }
    )
    sources = source_attributions(
        db, viewer_id=viewer_id, refs=[assert_resource_ref(r) for r in owners]
    )
    reads = _location_reads(
        db,
        viewer_id,
        [e.target for _, e, _ in occurrences if isinstance(e.target, CapturedPassageTarget)],
    )
    out = []
    for ref, evidence, key in occurrences:
        item = current[ref.uri]
        source = evidence.source
        known = sources.get(source.ref) if source.ref else None
        attribution = SourceAttributionOut(
            **source.model_dump(), activation=known.activation if known else None
        )
        owner = sources.get(evidence.target.owner_ref) if evidence.target.owner_ref else None
        activation = _occurrence_activation(
            ref.uri, key, evidence, owner.activation if owner else None
        )
        if (
            isinstance(evidence.target, CapturedPassageTarget)
            and owner
            and _current_locator(db, viewer_id, evidence.target, evidence.quote, reads) is None
        ):
            activation = activation.model_copy(
                update={"kind": "none", "href": None, "unavailable_reason": "location_unavailable"}
            )
        body = (
            passage_body(
                evidence.quote.exact,
                evidence.quote.prefix,
                evidence.quote.suffix,
                evidence.quote.color,
            )
            if evidence.quote
            else NamedResourceBodyOut(
                title=source.title or "Source",
                media_kind=source.media_kind,
                contributors=source.contributors,
            )
        )
        label = evidence.quote.exact[:120] if evidence.quote else source.title or "Source"
        out.append(
            item.model_copy(
                update={
                    "label": label,
                    "preview": ResourcePreviewOut(body=body, source=attribution, annotation=None),
                    "activation": activation,
                }
            )
        )
    return out


def _occurrence_activation(
    ref: str, key: SourceTargetKey, evidence: CapturedEvidence, source: ResourceActivationOut | None
) -> ResourceActivationOut:
    if source is None or source.kind == "none":
        return ResourceActivationOut(
            resource_ref=ref,
            kind="none",
            href=None,
            source_target=key,
            unavailable_reason="source_unavailable",
        )
    if evidence.target.kind == "unavailable":
        return ResourceActivationOut(
            resource_ref=ref,
            kind="none",
            href=None,
            source_target=key,
            unavailable_reason="location_unavailable",
        )
    if source.kind == "external":
        return source.model_copy(update={"resource_ref": ref, "source_target": key})
    fragment = (
        f"quote-{key.message_id}"
        if isinstance(key, ReaderQuoteSourceTargetKey)
        else f"citation-{key.edge_id}"
        if isinstance(key, CitationSourceTargetKey)
        else f"retrieval-{key.retrieval_id}"
        if isinstance(key, RetrievalSourceTargetKey)
        else None
    )
    href = (
        source.href.split("#", 1)[0] + "#" + fragment if source.href and fragment else source.href
    )
    return ResourceActivationOut(resource_ref=ref, kind=source.kind, href=href, source_target=key)


def resolve_source_target(
    db: Session, *, viewer_id: UUID, target: SourceTargetKey
) -> SourceTargetOut:
    if isinstance(target, ResourceSourceTargetKey):
        ref = assert_resource_ref(target.resource_ref)
        if ref.scheme in (
            "media",
            "note_block",
            "page",
            "conversation",
            "library",
            "podcast",
            "contributor",
            "artifact",
            "artifact_revision",
            "oracle_reading",
            "external_snapshot",
        ):
            item = resource_item_out(db, viewer_id=viewer_id, ref=ref)
            return SourceTargetOut(
                source_activation=None if item.missing else item.activation,
                location=UnavailableSourceLocationOut(reason="source_unavailable")
                if item.missing
                else WholeSourceLocationOut(),
            )
        evidence = capture_evidence(db, viewer_id=viewer_id, ref=ref)
    elif isinstance(target, RetrievalSourceTargetKey):
        raw = db.execute(
            text(
                "SELECT r.captured_evidence FROM message_retrievals r JOIN messages m ON m.id=r.assistant_message_id JOIN conversations c ON c.id=m.conversation_id WHERE r.id=:id AND c.owner_user_id=:viewer_id"
            ),
            {"id": target.retrieval_id, "viewer_id": viewer_id},
        ).scalar_one_or_none()
        if raw is None:
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Retrieval not found")
        evidence = CapturedEvidence.model_validate(raw)
    elif isinstance(target, ReaderQuoteSourceTargetKey):
        from nexus.services.chat.quotes import decode

        raw = db.execute(
            text(
                "SELECT m.reader_selection_snapshot FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE m.id=:id AND c.owner_user_id=:viewer_id"
            ),
            {"id": target.message_id, "viewer_id": viewer_id},
        ).scalar_one_or_none()
        if raw is None:
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Quote not found")
        evidence = decode(raw).evidence
    else:
        from nexus.schemas.resource_graph import CitationSnapshot

        raw = db.execute(
            text(
                "SELECT snapshot FROM resource_edges WHERE id=:id AND user_id=:viewer_id AND origin='citation' AND ordinal IS NOT NULL"
            ),
            {"id": target.edge_id, "viewer_id": viewer_id},
        ).scalar_one_or_none()
        if raw is None:
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Citation not found")
        snapshot = CitationSnapshot.model_validate(raw)
        assert snapshot.evidence is not None
        evidence = snapshot.evidence
    captured = evidence.target
    source = (
        source_attributions(
            db, viewer_id=viewer_id, refs=[assert_resource_ref(captured.owner_ref)]
        ).get(captured.owner_ref)
        if captured.owner_ref
        else None
    )
    if source is None or source.activation is None or source.activation.kind == "none":
        return SourceTargetOut(
            source_activation=None,
            location=UnavailableSourceLocationOut(reason="source_unavailable"),
        )
    if captured.kind == "resource":
        return SourceTargetOut(
            source_activation=source.activation, location=WholeSourceLocationOut()
        )
    if captured.kind == "unavailable":
        return SourceTargetOut(
            source_activation=source.activation,
            location=UnavailableSourceLocationOut(reason="location_unavailable"),
        )
    reads = _location_reads(db, viewer_id, [captured])
    locator = _current_locator(db, viewer_id, captured, evidence.quote, reads)
    if locator is None:
        return SourceTargetOut(
            source_activation=source.activation,
            location=UnavailableSourceLocationOut(reason="location_unavailable"),
        )
    return SourceTargetOut(
        source_activation=source.activation,
        location=LocatedSourceLocationOut(
            locator=_LOCATOR.validate_python(locator),
            precision="page" if locator["type"] == "pdf_page" else captured.precision,
            source_identity=reads["identities"].get(assert_resource_ref(captured.owner_ref).id),
        ),
    )


def source_identities(db: Session, media_ids: list[UUID]) -> dict[UUID, str]:
    if not media_ids:
        return {}
    from nexus.services.reader_document import transcript_identity

    rows = db.execute(
        text("""SELECT m.id,m.kind,r.generation,
        ARRAY(SELECT f.id::text FROM fragments f WHERE f.media_id=m.id ORDER BY f.t_start_ms NULLS LAST,f.idx) AS unit_ids
        FROM media m LEFT JOIN reader_publications r ON r.media_id=m.id WHERE m.id=ANY(:ids)"""),
        {"ids": media_ids},
    )
    return {
        row.id: f"g{row.generation}"
        if row.generation is not None
        else transcript_identity(row.unit_ids)
        for row in rows
        if row.generation is not None or row.kind in ("podcast_episode", "video")
    }


def _location_reads(
    db: Session, viewer_id: UUID, targets: Sequence[CapturedPassageTarget]
) -> dict[str, Any]:
    owners = [assert_resource_ref(t.owner_ref) for t in targets]
    media_ids = list({r.id for r in owners if r.scheme == "media"})
    before = source_identities(db, media_ids)
    fragment_ids = list(
        {
            UUID(str(t.locator.fragment_id))
            for t in targets
            if isinstance(t.locator, (WebTextOffsetsLocator, EpubFragmentOffsetsLocator))
        }
    )
    timed_ids = list(
        {
            UUID(str(t.locator.media_id))
            for t in targets
            if isinstance(t.locator, (TranscriptTimeRangeLocator, PlaybackTimeRangeLocator))
        }
    )
    fragments = (
        list(
            db.execute(
                text(
                    "SELECT id,media_id,canonical_text,t_start_ms,t_end_ms FROM fragments WHERE id=ANY(:ids) OR media_id=ANY(:timed) ORDER BY t_start_ms NULLS LAST,idx"
                ),
                {"ids": fragment_ids, "timed": timed_ids},
            ).mappings()
        )
        if fragment_ids or timed_ids
        else []
    )
    pdf_ids = list(
        {
            UUID(str(t.locator.media_id))
            for t in targets
            if isinstance(t.locator, (PdfPageGeometryLocator, PdfPageLocator))
        }
    )
    pdfs = (
        {
            row.id: row
            for row in db.execute(
                text("SELECT id,page_count,plain_text FROM media WHERE id=ANY(:ids)"),
                {"ids": pdf_ids},
            )
        }
        if pdf_ids
        else {}
    )
    pages = (
        list(
            db.execute(
                text(
                    "SELECT media_id,page_number,start_offset,end_offset FROM pdf_page_text_spans WHERE media_id=ANY(:ids)"
                ),
                {"ids": pdf_ids},
            ).mappings()
        )
        if pdf_ids
        else []
    )
    note_ids = list({r.id for r in owners if r.scheme == "note_block"})
    from nexus.services.note_bodies import read_note_sources

    notes = read_note_sources(db, viewer_id=viewer_id, note_ids=note_ids) if note_ids else {}
    message_ids = list(
        {UUID(str(t.locator.message_id)) for t in targets if t.locator.type == "message_offsets"}
    )
    messages = (
        {
            row.id: row
            for row in db.execute(
                text("SELECT id,conversation_id,content FROM messages WHERE id=ANY(:ids)"),
                {"ids": message_ids},
            )
        }
        if message_ids
        else {}
    )
    after = source_identities(db, media_ids)
    return {
        "changed": {id_ for id_ in media_ids if before.get(id_) != after.get(id_)},
        "identities": after,
        "fragments": fragments,
        "pdfs": pdfs,
        "pages": pages,
        "notes": notes,
        "messages": messages,
    }


def _same_words(left: str, right: str) -> bool:
    return (
        text_quote.normalize_for_match(left).text.strip()
        == text_quote.normalize_for_match(right).text.strip()
    )


def locatable_passages(
    db: Session,
    *,
    viewer_id: UUID,
    passages: Sequence[tuple[CapturedPassageTarget, CapturedQuote | None]],
) -> list[bool]:
    """The row's capability uses the same batched source proof as its eventual open."""
    reads = _location_reads(db, viewer_id, [target for target, _ in passages])
    return [
        _current_locator(db, viewer_id, target, quote, reads) is not None
        for target, quote in passages
    ]


def _current_locator(
    db: Session,
    viewer_id: UUID,
    target: CapturedPassageTarget,
    quote: CapturedQuote | None,
    reads: dict[str, Any],
) -> dict[str, Any] | None:
    raw = target.locator.model_dump(mode="json")
    owner = assert_resource_ref(target.owner_ref)
    kind = raw["type"]
    selector = raw.get("text_quote_selector") or {}
    exact = selector.get("exact")
    if kind not in (
        "note_block_offsets",
        "message_offsets",
        "web_text_offsets",
        "epub_fragment_offsets",
    ):
        exact = exact or (quote.exact if quote else None)
    prefix = selector.get("prefix") or (quote.prefix if quote else None) or ""
    suffix = selector.get("suffix") or (quote.suffix if quote else None) or ""
    if owner.id in reads["changed"]:
        return None
    if kind in ("web_text_offsets", "epub_fragment_offsets"):
        fragment = next(
            (
                f
                for f in reads["fragments"]
                if str(f["id"]) == raw["fragment_id"] and f["media_id"] == owner.id
            ),
            None,
        )
        if fragment is None:
            return None
        body = fragment["canonical_text"]
        return (
            {
                **raw,
                "text_quote_selector": {
                    **(raw.get("text_quote_selector") or {}),
                    "exact": body[raw["start_offset"] : raw["end_offset"]],
                },
            }
            if 0 <= raw["start_offset"] < raw["end_offset"] <= len(body)
            and exact is not None
            and _same_words(body[raw["start_offset"] : raw["end_offset"]], exact)
            else None
        )
    if kind == "note_block_offsets":
        note = reads["notes"].get(owner.id)
        if note is None:
            return None
        bounded = 0 <= raw["start_offset"] < raw["end_offset"] <= len(note.body_text)
        if (
            raw.get("body_version") == note.body_version
            and bounded
            and (
                exact is None
                or _same_words(note.body_text[raw["start_offset"] : raw["end_offset"]], exact)
            )
        ):
            return {
                **raw,
                "text_quote_selector": {
                    **(raw.get("text_quote_selector") or {}),
                    "exact": note.body_text[raw["start_offset"] : raw["end_offset"]],
                },
            }
        if exact is None:
            return None
        exact = text_quote.normalize_for_match(exact).text.strip()
        match = text_quote.match_quote_in_sources(
            [
                text_quote.NormalizedOwnerSource(
                    None, None, None, text_quote.normalize_for_match(note.body_text)
                )
            ],
            exact=exact,
            prefix=text_quote.normalize_for_match(prefix).text.strip(),
            suffix=text_quote.normalize_for_match(suffix).text.strip(),
        )
        match = text_quote.project_note_match(note.body_text, match, exact=exact)
        return (
            {
                **raw,
                "start_offset": match.raw_start,
                "end_offset": match.raw_end,
                "body_version": note.body_version,
                "text_quote_selector": {
                    **(raw.get("text_quote_selector") or {}),
                    "exact": note.body_text[match.raw_start : match.raw_end],
                },
            }
            if match.status is text_quote.QuoteStatus.unique
            else None
        )
    if kind == "message_offsets":
        message = reads["messages"].get(UUID(raw["message_id"]))
        return (
            {
                **raw,
                "text_quote_selector": {
                    **(raw.get("text_quote_selector") or {}),
                    "exact": message.content[raw["start_offset"] : raw["end_offset"]],
                },
            }
            if message
            and message.conversation_id == owner.id
            and exact is not None
            and raw["start_offset"] == 0
            and raw["end_offset"] == len(message.content)
            and _same_words(message.content[raw["start_offset"] : raw["end_offset"]], exact)
            else None
        )
    identity = reads["identities"].get(owner.id)
    if kind in ("pdf_page_geometry", "pdf_page"):
        media = reads["pdfs"].get(owner.id)
        if media is None:
            return None
        if (
            target.source_identity is not None
            and identity == target.source_identity
            and media.page_count
            and raw["page_number"] <= media.page_count
        ):
            return raw
        if not exact:
            return None
        # Historical geometry has no publication proof. A unique current quote can
        # recover its page, never the old boxes.
        candidates = text_quote.find_quote_candidates(
            text_quote.normalize_for_match(media.plain_text or ""),
            exact=text_quote.normalize_for_match(exact).text.strip(),
            prefix=text_quote.normalize_for_match(prefix).text.strip(),
            suffix=text_quote.normalize_for_match(suffix).text.strip(),
        )
        if len(candidates) != 1:
            return None
        hit = candidates[0]
        pages = [
            p
            for p in reads["pages"]
            if p["media_id"] == owner.id
            and p["start_offset"] <= hit.raw_start < p["end_offset"]
            and hit.raw_end <= p["end_offset"]
        ]
        return (
            {"type": "pdf_page", "media_id": str(owner.id), "page_number": pages[0]["page_number"]}
            if len(pages) == 1
            else None
        )
    if kind in ("transcript_time_range", "audio_time_range", "video_time_range"):
        fragments = [
            f
            for f in reads["fragments"]
            if f["media_id"] == owner.id
            and f["t_start_ms"] is not None
            and f["t_end_ms"] is not None
            and f["t_end_ms"] > raw["t_start_ms"]
            and f["t_start_ms"] < raw["t_end_ms"]
        ]
        words = "\n".join(f["canonical_text"] for f in fragments)
        proven = target.source_identity is not None and identity == target.source_identity
        if not proven:
            proven = bool(
                fragments
                and fragments[0]["t_start_ms"] == raw["t_start_ms"]
                and fragments[-1]["t_end_ms"] == raw["t_end_ms"]
                and exact is not None
                and _same_words(words, exact)
            )
        if not proven:
            return None
        return (
            {**raw, "text_quote_selector": {**selector, "exact": words}}
            if kind == "transcript_time_range" and fragments
            else raw
        )
    return raw if kind == "external_url" else None


def _resolve_quote(
    db: Session, owner: ResourceRef, quote: CapturedQuote, hint: dict[str, Any] | None
) -> dict[str, Any] | None:
    result = locator_resolver.resolve_passage_selector(
        db,
        owner_scheme=owner.scheme,
        owner_id=owner.id,
        exact=text_quote.normalize_for_match(quote.exact).text.strip(),
        prefix=text_quote.normalize_for_match(quote.prefix or "").text.strip(),
        suffix=text_quote.normalize_for_match(quote.suffix or "").text.strip(),
        locator_hint=hint,
    )
    if result.locator is None:
        return None
    found = result.locator
    selector = {"exact": quote.exact, "prefix": quote.prefix or "", "suffix": quote.suffix or ""}
    if owner.scheme == "note_block":
        return {
            "type": "note_block_offsets",
            "block_id": str(owner.id),
            "start_offset": found["start_offset"],
            "end_offset": found["end_offset"],
            "text_quote_selector": selector,
        }
    if found["kind"] == "text":
        kind = db.scalar(text("SELECT kind FROM media WHERE id=:id"), {"id": owner.id})
        return {
            "type": "epub_fragment_offsets" if kind == "epub" else "web_text_offsets",
            "media_id": str(owner.id),
            "media_kind": kind,
            "fragment_id": found["fragment_id"],
            "start_offset": found["start_offset"],
            "end_offset": found["end_offset"],
            "text_quote_selector": selector,
        }
    if found["kind"] == "time":
        return {
            "type": "transcript_time_range",
            "media_id": str(owner.id),
            "t_start_ms": found["t_start_ms"],
            "t_end_ms": found["t_end_ms"],
            "text_quote_selector": selector,
        }
    if found["kind"] == "pdf":
        return {
            "type": "pdf_page",
            "media_id": str(owner.id),
            "page_number": found["page_number"],
            "text_quote_selector": selector,
        }
    return None
