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
from nexus.schemas.retrieval import LocationPrecision, RetrievalLocator
from nexus.services.resource_graph.refs import ResourceRef, assert_resource_ref, require_ref
from nexus.services.resource_items.items import (
    passage_body,
    resource_item_out,
    resource_items_out,
    source_attributions,
    visible_refs,
)
from nexus.services.resource_items.locations import (
    TIMED_KINDS,
    current_locator,
    current_passages,
    location_reads,
    media_passages,
    resolve_quote,
    scoped_media_passage,
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


def capture_evidence(
    db: Session, *, viewer_id: UUID, ref: ResourceRef, reading_media_id: UUID | None = None
) -> CapturedEvidence:
    """A current readable target's complete words and location, captured together. 404
    when the viewer cannot see it; 409 ``E_READER_CONTENT_CHANGED`` when its publication
    changes under the capture (I7)."""
    item = resource_item_out(db, viewer_id=viewer_id, ref=ref, reading_media_id=reading_media_id)
    if item.missing:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Resource not found")
    return _capture(db, viewer_id, ref, item, reading_media_id=reading_media_id)


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
    from nexus.services.note_bodies import read_note

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
        owner, quote, locator = scoped.owner, scoped.quote, scoped.locator
    elif ref.scheme in ("evidence_span", "content_chunk", "oracle_passage_anchor"):
        passage = current_passages(
            db,
            viewer_id=viewer_id,
            refs=[ref],
            reading_media_ids={ref.uri: reading_media_id} if reading_media_id is not None else None,
        ).get(ref.uri)
        if passage is None or passage.owner.scheme == "media":
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Source passage not found")
        owner, quote, locator = passage.owner, passage.quote, passage.locator
    elif ref.scheme in ("highlight", "fragment", "reader_apparatus_item"):
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Source passage not found")
    elif ref.scheme == "passage_anchor":
        row = db.execute(
            text("SELECT owner_scheme, owner_id, selector FROM passage_anchors WHERE id = :id"),
            {"id": ref.id},
        ).one()
        owner = assert_resource_ref(f"{row.owner_scheme}:{row.owner_id}")
        words = row.selector["quote"]
        quote = CapturedQuote(
            exact=words["exact"], prefix=words.get("prefix"), suffix=words.get("suffix"), color=None
        )
        locator = resolve_quote(db, owner, quote, row.selector.get("locator_hint"))
    elif ref.scheme == "note_block":
        note = read_note(db, viewer_id=viewer_id, note_id=ref.id)
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
            text("SELECT conversation_id, content, seq FROM messages WHERE id = :id"),
            {"id": ref.id},
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
    if locator is not None and locator["type"] == "note_block_offsets":
        # Note offsets freeze with the body version they were proven against.
        proof = CapturedPassageTarget(
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
        target = CapturedResourceTarget(owner_ref=owner.uri)
    elif locator is None:
        target = CapturedUnavailableTarget(owner_ref=owner.uri)
    else:
        target = CapturedPassageTarget(
            owner_ref=owner.uri,
            locator=_LOCATOR.validate_python(locator),
            precision=_precision(locator),
            source_identity=before,
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
) -> CapturedEvidence | None:
    """Historical words remain frozen, but current scope governs their disclosure."""
    target = evidence.target
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
        return evidence
    if not target.owner_ref.startswith("media:"):
        return evidence
    owner = assert_resource_ref(target.owner_ref)
    quote = evidence.quote
    if quote is None:
        return None
    reads = location_reads(db, viewer_id, [target])
    current = current_locator(target, quote, reads)
    if owner.id in reads.passages.canonical_media and reading_media_id in (None, owner.id):
        if current is None or not can_read_media(db, viewer_id, owner.id):
            return None
        chosen_owner = owner
        chosen_locator = current
    else:
        scoped = scoped_media_passage(
            db,
            viewer_id=viewer_id,
            source_media_id=owner.id,
            quote=quote,
            locator=current or target.locator.model_dump(mode="json"),
            reading_media_id=reading_media_id,
        )
        if scoped is None:
            return None
        chosen_owner, chosen_locator = scoped.owner, scoped.locator
    selector = (chosen_locator or {}).get("text_quote_selector") or {}
    if current is not None and selector:
        prefix_limit = len(selector.get("prefix") or "")
        suffix_limit = len(selector.get("suffix") or "")
        quote = quote.model_copy(
            update={
                "prefix": quote.prefix[-prefix_limit:] if quote.prefix and prefix_limit else None,
                "suffix": quote.suffix[:suffix_limit] if quote.suffix and suffix_limit else None,
            }
        )
    return evidence.model_copy(
        update={"quote": quote, "target": target.model_copy(update={"owner_ref": chosen_owner.uri})}
    )


def evidence_items(
    db: Session,
    *,
    viewer_id: UUID,
    occurrences: Sequence[tuple[ResourceRef, CapturedEvidence, SourceTargetKey]],
) -> list[ResourceItemOut]:
    """Each occurrence as an item of its frozen words and attribution; the current state
    of the cited ref's owner decides only whether the location still opens (I6)."""
    current = {
        item.ref: item
        for item in resource_items_out(
            db, viewer_id=viewer_id, refs=[ref for ref, _, _ in occurrences]
        )
    }
    admitted = [
        _admitted_evidence(db, viewer_id=viewer_id, evidence=evidence)
        for _, evidence, _ in occurrences
    ]
    owners = {
        owner
        for value in admitted
        if value is not None and (owner := value.target.owner_ref or value.source.ref) is not None
    }
    sources = source_attributions(
        db, viewer_id=viewer_id, refs=[assert_resource_ref(owner) for owner in owners]
    )
    reads = location_reads(
        db,
        viewer_id,
        [
            value.target
            for value in admitted
            if value is not None and isinstance(value.target, CapturedPassageTarget)
        ],
    )
    out = []
    for (ref, evidence, key), value in zip(occurrences, admitted, strict=True):
        if value is None:
            out.append(
                current[ref.uri].model_copy(
                    update={
                        "label": "source unavailable",
                        "missing": True,
                        "preview": ResourcePreviewOut(
                            body=NamedResourceBodyOut(
                                title="source unavailable",
                                image_url=None,
                                media_kind=None,
                                contributors=None,
                            ),
                            source=None,
                            annotation=None,
                        ),
                        "activation": ResourceActivationOut(
                            resource_ref=ref.uri,
                            kind="none",
                            href=None,
                            unavailable_reason="source_unavailable",
                        ),
                    }
                )
            )
            continue
        evidence = value
        frozen = evidence.source
        known = sources.get(frozen.ref) if frozen.ref else None
        owner = sources.get(evidence.target.owner_ref) if evidence.target.owner_ref else None
        attribution = SourceAttributionOut(
            **frozen.model_dump(),
            activation=owner.activation if owner else known.activation if known else None,
        )
        activation = _occurrence_activation(
            ref.uri, key, evidence, owner.activation if owner else None
        )
        if (
            isinstance(evidence.target, CapturedPassageTarget)
            and owner
            and current_locator(evidence.target, evidence.quote, reads) is None
        ):
            activation = ResourceActivationOut(
                resource_ref=ref.uri,
                kind="none",
                href=None,
                unavailable_reason="location_unavailable",
            )
        quote = evidence.quote
        body = (
            passage_body(quote.exact, quote.prefix, quote.suffix, quote.color)
            if quote
            else NamedResourceBodyOut(
                title=frozen.title or "Source",
                image_url=None,
                media_kind=frozen.media_kind,
                contributors=frozen.contributors,
            )
        )
        out.append(
            current[ref.uri].model_copy(
                update={
                    "label": quote.exact[:120] if quote else frozen.title or "Source",
                    "preview": ResourcePreviewOut(body=body, source=attribution, annotation=None),
                    "activation": activation,
                }
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
    if source is None or source.kind == "none":
        return ResourceActivationOut(
            resource_ref=ref, kind="none", href=None, unavailable_reason="source_unavailable"
        )
    if evidence.target.kind == "unavailable":
        return ResourceActivationOut(
            resource_ref=ref, kind="none", href=None, unavailable_reason="location_unavailable"
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
    return ResourceActivationOut(resource_ref=ref, kind=source.kind, href=href)


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
                ),
                {"id": target.edge_id},
            ).first()
            if row is None or row.source not in visible_refs(
                db, viewer_id=viewer_id, refs=[assert_resource_ref(row.source)]
            ):
                raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Citation not found")
            snapshot = CitationSnapshot.model_validate(row.snapshot)
            assert snapshot.evidence is not None
            evidence = snapshot.evidence
    admitted = _admitted_evidence(
        db, viewer_id=viewer_id, evidence=evidence, reading_media_id=reading_media_id
    )
    if admitted is None:
        return _UNAVAILABLE_SOURCE
    evidence = admitted
    captured = evidence.target
    owner = assert_resource_ref(captured.owner_ref) if captured.owner_ref else None
    source = (
        source_attributions(db, viewer_id=viewer_id, refs=[owner]).get(owner.uri) if owner else None
    )
    if (
        owner is None
        or source is None
        or source.activation is None
        or source.activation.kind == "none"
    ):
        return _UNAVAILABLE_SOURCE
    if captured.kind == "resource":
        return SourceTargetOut(
            source_activation=source.activation, location=WholeSourceLocationOut()
        )
    unavailable = SourceTargetOut(
        source_activation=source.activation,
        location=UnavailableSourceLocationOut(reason="location_unavailable"),
    )
    if captured.kind == "unavailable":
        return unavailable
    reads = location_reads(db, viewer_id, [captured])
    locator = current_locator(captured, evidence.quote, reads)
    if locator is None:
        return unavailable
    resolved_locator = _LOCATOR.validate_python(locator)
    apparatus_reference_id = None
    if owner.scheme == "media":
        from nexus.services.reader_apparatus import note_reference_for_locator

        apparatus_reference_id = note_reference_for_locator(
            db, viewer_id=viewer_id, media_id=owner.id, locator=resolved_locator
        )
    return SourceTargetOut(
        source_activation=source.activation,
        location=LocatedSourceLocationOut(
            locator=resolved_locator,
            precision="page" if locator["type"] == "pdf_page" else captured.precision,
            source_identity=reads.identities.get(owner.id),
            apparatus_reference_id=apparatus_reference_id,
        ),
    )
