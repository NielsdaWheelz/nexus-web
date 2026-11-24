"""Admit selected words once; project saved references with current source authority."""

from collections.abc import Mapping
from dataclasses import dataclass
from uuid import UUID

from pydantic import TypeAdapter
from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.errors import ApiErrorCode, InvalidRequestError, NotFoundError
from nexus.schemas.chat import AttachmentIn, AttachmentOut, ReferenceAttachmentIn
from nexus.schemas.live_reference import (
    CaptureScope,
    PdfPageTarget,
    QuestionAttachment,
    SavedReference,
    SavedRetrievalTarget,
    UrlRetrievalTarget,
)
from nexus.schemas.reader import (
    EpubTextOffsetsTargetOut,
    PdfPageGeometryTargetOut,
    TranscriptTextOffsetsTargetOut,
    WebTextOffsetsTargetOut,
)
from nexus.schemas.resource_evidence import CapturedEvidence, ResourceField
from nexus.schemas.resource_items import ResourceItemOut
from nexus.services.generation.policy import policy
from nexus.services.highlights import read_highlight_annotations
from nexus.services.live_references import (
    field_visible,
    reference_visible,
    resolve_location,
)
from nexus.services.media import media_summaries
from nexus.services.resource_graph.refs import ResourceRef, require_ref
from nexus.services.resource_graph.resolve import PromptBodyTooLarge, resolve_prompt
from nexus.services.resource_items.evidence import (
    PromptEvidenceTooLarge,
    capture_prompt_evidence,
    capture_reader_selection,
    reader_source,
)
from nexus.services.resource_items.items import resource_items_out


@dataclass(frozen=True, slots=True)
class CurrentReference:
    label: str
    body: str
    source_available: bool
    content_available: bool
    voice: str = "subject"
    required: tuple[tuple[str, str], ...] = ()
    evidence: CapturedEvidence | None = None


def attachments_by_reference(
    db: Session,
    viewer_id: UUID,
    references: list[SavedReference],
    *,
    items: Mapping[str, ResourceItemOut],
) -> dict[str, AttachmentOut]:
    """Index full-reference JSON from this viewer/snapshot's hydrated item batch.

    Nonmissing items prove resource authority; field privacy is shared across locators.
    Callers reconstruct occurrence order.
    """
    visible: dict[tuple[str, ResourceField], bool] = {}
    result: dict[str, AttachmentOut] = {}
    for reference in references:
        key = reference.model_dump_json()
        if key in result:
            continue
        item = items[reference.resource_ref]
        field = (reference.resource_ref, reference.field)
        if field not in visible:
            visible[field] = not item.missing and field_visible(
                db, viewer_id=viewer_id, reference=reference
            )
        result[key] = AttachmentOut(
            reference=reference,
            item=item if visible[field] else None,
            location_available=visible[field]
            and resolve_location(db, reference, viewer_id=viewer_id),
            annotation=None,
            source=None,
        )
    return result


def present_attachments(
    db: Session, viewer_id: UUID, attachments: Mapping[str, AttachmentOut]
) -> dict[str, AttachmentOut]:
    """Enrich figures with current annotations and source identity, never source words."""
    readable = {key: value for key, value in attachments.items() if value.item is not None}
    annotation_ids = {
        key: require_ref(value.reference.resource_ref).id
        for key, value in readable.items()
        if value.location_available
        and value.reference.locator is None
        and require_ref(value.reference.resource_ref).scheme == "highlight"
    }
    annotations = read_highlight_annotations(
        db, viewer_id=viewer_id, highlight_ids=list(set(annotation_ids.values()))
    )
    source_ids = {}
    for key, value in readable.items():
        item = value.item
        assert item is not None
        source = item.preview.source
        if item.preview.body.kind == "media" or source is None or source.ref is None:
            continue
        ref = require_ref(source.ref)
        if ref.scheme == "media":
            source_ids[key] = ref.id
    sources = media_summaries(db, viewer_id=viewer_id, media_ids=list(set(source_ids.values())))
    return {
        key: value.model_copy(
            update={
                "annotation": annotations.get(annotation_ids[key])
                if key in annotation_ids
                else None,
                "source": sources.get(source_ids[key]) if key in source_ids else None,
            }
        )
        for key, value in attachments.items()
    }


def admit_attachments(
    db: Session, viewer_id: UUID, attachments: list[AttachmentIn]
) -> list[QuestionAttachment]:
    """Prove reader captures before admission locks; whole references carry no words."""
    from nexus.services.live_references import from_evidence

    admitted = []
    for attachment in attachments:
        if isinstance(attachment, ReferenceAttachmentIn):
            if not reference_visible(db, viewer_id=viewer_id, reference=attachment.reference):
                raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Source not found")
            admitted.append(
                QuestionAttachment(
                    reference=SavedReference(**attachment.reference.model_dump(), quote=None),
                    capture_scope=None,
                )
            )
            continue
        capture = attachment.capture
        if (
            len(capture.quote_exact) > 20_000
            or len(capture.prefix or "") > 1_000
            or len(capture.suffix or "") > 1_000
            or len(capture.model_dump_json().encode()) > 512 * 1024
        ):
            raise InvalidRequestError(
                ApiErrorCode.E_READER_SELECTION_TOO_LARGE, "Selection exceeds quote bounds"
            )
        reading = require_ref(attachment.reading_ref)
        evidence = capture_reader_selection(
            db,
            viewer_id=viewer_id,
            reading_ref=reading,
            source_ref=require_ref(attachment.source_ref),
            capture=capture,
        )
        assert evidence.target.kind == "passage"
        admitted.append(
            QuestionAttachment(
                reference=from_evidence(evidence),
                capture_scope=CaptureScope(
                    reading_ref=reading.uri, source_identity=evidence.target.source_identity
                ),
            )
        )
    return admitted


def read_attachments(
    db: Session, viewer_id: UUID, attachments: list[AttachmentIn]
) -> list[AttachmentOut]:
    """Admit and present a draft in one read snapshot; nothing is written."""
    references = [item.reference for item in admit_attachments(db, viewer_id, attachments)]
    refs = {reference.resource_ref: require_ref(reference.resource_ref) for reference in references}
    items = {
        item.ref: item
        for item in resource_items_out(db, viewer_id=viewer_id, refs=list(refs.values()))
    }
    resolved = present_attachments(
        db, viewer_id, attachments_by_reference(db, viewer_id, references, items=items)
    )
    return [resolved[reference.model_dump_json()] for reference in references]


def _words_visible(
    db: Session, viewer_id: UUID, reference: SavedReference, horizon_seq: int
) -> bool:
    """The selected field and historical message must still be readable at execution."""
    from nexus.services.chat.timeline import message_visible

    ref = require_ref(reference.resource_ref)
    if not reference_visible(db, viewer_id=viewer_id, reference=reference):
        return False
    message_id = ref.id if ref.scheme == "message" else None
    if ref.scheme == "passage_anchor":
        message_id = db.scalar(
            text("SELECT owner_id FROM passage_anchors WHERE id=:id AND owner_scheme='message'"),
            {"id": ref.id},
        )
    if message_id is not None and not message_visible(db, viewer_id, message_id, horizon_seq):
        return False
    if (
        reference.quote is not None
        and ref.scheme == "media"
        and db.scalar(text("SELECT 1 FROM media_parts WHERE media_id=:id"), {"id": ref.id})
    ):
        return resolve_location(db, reference, viewer_id=viewer_id)
    return True


def resolve(
    db: Session, *, viewer_id: UUID, reference: SavedReference, byte_limit: int, horizon_seq: int
) -> CurrentReference:
    ref = require_ref(reference.resource_ref)
    if not _words_visible(db, viewer_id, reference, horizon_seq):
        return CurrentReference("source unavailable", "", False, False)
    if reference.locator is not None or reference.field == "annotation":
        item = resource_items_out(db, viewer_id=viewer_id, refs=[ref])[0]
        if reference.quote is not None:
            if len(reference.quote.exact.encode()) > byte_limit:
                raise PromptBodyTooLarge(ref.uri)
            return CurrentReference(
                "message passage" if ref.scheme == "message" else item.label,
                reference.quote.exact,
                True,
                True,
                _annotation_voice(db, viewer_id, ref) if reference.field else "selected words",
            )
        if reference.locator is not None:
            return CurrentReference(item.label, "", True, False)
        size = db.scalar(
            text("SELECT octet_length(annotation_body_text) FROM highlights WHERE id=:id"),
            {"id": ref.id},
        )
        if size is None:
            return CurrentReference(item.label, "", True, False)
        if size > byte_limit:
            raise PromptBodyTooLarge(ref.uri)
        body = db.scalar(
            text("SELECT annotation_body_text FROM highlights WHERE id=:id"), {"id": ref.id}
        )
        return CurrentReference(
            item.label, body or "", True, True, _annotation_voice(db, viewer_id, ref)
        )
    if ref.scheme in (
        "content_chunk",
        "evidence_span",
        "fragment",
        "reader_apparatus_item",
        "oracle_passage_anchor",
    ):
        try:
            evidence = capture_prompt_evidence(
                db, viewer_id=viewer_id, ref=ref, byte_limit=byte_limit
            )
        except NotFoundError:
            # justify-ignore-error: the subject's identity can survive loss of its complete reading extent.
            return CurrentReference("source unavailable", "", False, False)
        except PromptEvidenceTooLarge as error:
            raise PromptBodyTooLarge(ref.uri) from error
        if evidence.quote is not None:
            return CurrentReference(
                evidence.source.location_label or evidence.source.title or ref.uri,
                evidence.quote.exact,
                True,
                True,
                "selected words",
                evidence=evidence,
            )
    resource = resolve_prompt(
        db, viewer_id=viewer_id, ref=ref, byte_limit=byte_limit, identity_only=False
    )
    if resource.quote is not None:
        annotation = resource.quote.annotation
        return CurrentReference(
            resource.label,
            resource.quote.exact,
            not resource.missing,
            not resource.missing,
            "selected words",
            ((_annotation_voice(db, viewer_id, ref), annotation),) if annotation else (),
        )
    body = resource.inline_body or resource.body or resource.summary or resource.fetch_hint
    return CurrentReference(resource.label, body or "", not resource.missing, not resource.missing)


def _annotation_voice(db: Session, viewer_id: UUID, ref: ResourceRef) -> str:
    from nexus.services.tools.assistant_writes import authorship_for_target

    provenance = authorship_for_target(db, viewer_id, ref.uri, field="annotation")
    return "annotation (assistant-created)" if provenance else "reader annotation"


def _answer_evidence(
    db: Session,
    viewer_id: UUID,
    message_id: UUID,
    horizon_seq: int,
    start: int,
    end: int,
    body: str,
) -> list[tuple[str, str]]:
    from nexus.services.chat.markdown_citations import parse_markers

    rows = dict(
        db.execute(
            text("""
        SELECT citation_ordinal,target FROM message_retrievals
        WHERE assistant_message_id=:message AND citation_ordinal IS NOT NULL
    """),
            {"message": message_id},
        )
        .tuples()
        .all()
    )
    if not rows:
        return []
    ordinals = dict.fromkeys(
        m.ordinal_text for m in parse_markers(body) if start <= m.start and m.end <= end
    )
    lookup = {str(n): target for n, target in rows.items()}
    decoder = TypeAdapter(SavedRetrievalTarget)
    result = []
    for ordinal in ordinals:
        if ordinal not in lookup:
            continue
        target = decoder.validate_python(lookup[ordinal])
        label = f"source citation {ordinal}"
        if isinstance(target, UrlRetrievalTarget):
            result.append((label, target.url))
            continue
        saved = target.reference
        ref = require_ref(saved.resource_ref)
        if not _words_visible(db, viewer_id, saved, horizon_seq):
            continue
        quote = saved.quote
        result.append((label, ref.uri))
        if quote is not None:
            clipped = len(quote.exact) > 2000 or quote.excerpt.truncated_after
            result.append(
                (
                    label + " retained quote",
                    ("[…] " if quote.excerpt.truncated_before else "")
                    + quote.exact[:2000]
                    + (" […]" if clipped else ""),
                )
            )
    return result


def surroundings(
    db: Session,
    *,
    viewer_id: UUID,
    attachment: QuestionAttachment,
    primary: CurrentReference,
    horizon_seq: int,
) -> list[tuple[str, str]]:
    """Optional first-call context, independently authorized for this occurrence."""
    from nexus.services.live_references import from_evidence
    from nexus.services.media_read_map import ask_page_context
    from nexus.services.reader_document import ask_fragment_context
    from nexus.services.resource_items.items import ref_visible

    reference = attachment.reference
    ref = require_ref(reference.resource_ref)
    reading = require_ref(attachment.capture_scope.reading_ref) if attachment.capture_scope else ref
    identity = attachment.capture_scope.source_identity if attachment.capture_scope else None
    exact = primary.body
    locator = reference.locator
    result: list[tuple[str, str]] = []
    if ref.scheme == "message":
        # A narrow selection still parses the complete markdown, including enclosing code fences.
        row = db.execute(
            text("SELECT role,content FROM messages WHERE id=:id"), {"id": ref.id}
        ).one()
        if locator is None:
            start, end = 0, len(row.content)
        elif (
            locator.kind == "TextOffsets"
            and row.content[locator.start_offset : locator.end_offset] == exact
        ):
            start, end = locator.start_offset, locator.end_offset
        else:
            return []
        result.append(("location", f"{ref.uri} · characters {start}–{end}"))
        if row.role == "assistant":
            result.extend(
                _answer_evidence(db, viewer_id, ref.id, horizon_seq, start, end, row.content)
            )
        return result
    if ref.scheme in (
        "highlight",
        "passage_anchor",
        "evidence_span",
        "content_chunk",
        "reader_apparatus_item",
        "oracle_passage_anchor",
        "fragment",
    ) and (locator is None or reference.field == "annotation"):
        try:
            # Only stored highlights and named passages need a separate source capture.
            evidence = primary.evidence or capture_prompt_evidence(
                db,
                viewer_id=viewer_id,
                ref=ref,
                byte_limit=policy("chat").input_max_bytes,
                use_captured_reading=True,
            )
        except (NotFoundError, PromptEvidenceTooLarge):
            # justify-ignore-error: a retained primary can survive loss of optional source access.
            if reference.field == "annotation":
                retained = db.scalar(
                    text(
                        "SELECT exact FROM highlights WHERE id=:id AND authored_visible AND user_id=:viewer"
                    ),
                    {"id": ref.id, "viewer": viewer_id},
                )
                if retained:
                    result.append(("highlighted words", retained))
            return result
        if evidence.target.owner_ref is None:
            return result
        reading = require_ref(evidence.target.owner_ref)
        if not ref_visible(db, viewer_id=viewer_id, ref=reading):
            return result
        if evidence.quote is not None:
            exact = evidence.quote.exact
            if reference.field == "annotation":
                result.append(("highlighted words", exact))
        if evidence.target.kind == "passage":
            identity = evidence.target.source_identity
            locator = from_evidence(evidence).locator
            native = evidence.target.locator
            if native.type == "message_offsets":
                from nexus.services.chat.timeline import message_visible

                message_id = UUID(str(native.message_id))
                if message_visible(db, viewer_id, message_id, horizon_seq):
                    row = db.execute(
                        text("SELECT role,content FROM messages WHERE id=:id"), {"id": message_id}
                    ).one()
                    if (
                        row.role == "assistant"
                        and row.content[native.start_offset : native.end_offset] == exact
                    ):
                        result.append(
                            (
                                "location",
                                f"message:{message_id} · characters {native.start_offset}–{native.end_offset}",
                            )
                        )
                        result.extend(
                            _answer_evidence(
                                db,
                                viewer_id,
                                message_id,
                                horizon_seq,
                                native.start_offset,
                                native.end_offset,
                                row.content,
                            )
                        )
                return result
    if reading.scheme not in ("media", "fragment") or not ref_visible(
        db, viewer_id=viewer_id, ref=reading
    ):
        return result
    if locator is None and reading == ref and ref.scheme == "media":
        return result
    placed: list[tuple[str, str]] = []
    if isinstance(locator, (PdfPageTarget, PdfPageGeometryTargetOut)) and reading.scheme == "media":
        placed.extend(
            ask_page_context(db, viewer_id, reading.id, locator.page_number, identity, exact)
        )
    elif isinstance(
        locator, (WebTextOffsetsTargetOut, EpubTextOffsetsTargetOut, TranscriptTextOffsetsTargetOut)
    ):
        placed.extend(
            ask_fragment_context(
                db,
                viewer_id=viewer_id,
                reading=reading,
                fragment_id=locator.fragment_id,
                start=locator.start_offset,
                end=locator.end_offset,
                exact=exact,
            )
        )
    elif (
        locator is not None
        and locator.kind == "TimeRange"
        and resolve_location(db, reference, viewer_id=viewer_id)
    ):
        placed.append(("location", f"{locator.start_ms}–{locator.end_ms} ms"))
    sources = [(reading, "work")]
    if attachment.capture_scope is not None and ref.scheme == "fragment" and reading != ref:
        sources = [(ref, "selected post")]
        if placed:
            sources.append((reading, "work"))
    for owner, label in sources:
        try:
            source = reader_source(db, viewer_id, owner)
        except NotFoundError:
            # justify-ignore-error: a visible subject can lack separate current attribution.
            continue
        result.append((label, " · ".join(filter(None, (source.title, owner.uri)))))
        if source.contributors:
            result.append(
                (
                    "credits",
                    ", ".join(
                        f"{credit.credited_name} ({credit.role})" for credit in source.contributors
                    ),
                )
            )
        elif source.attribution_text:
            result.append(("attribution", source.attribution_text))
    return [*result, *placed]
