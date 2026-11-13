"""Admit selected words once; project saved references with current source authority."""

from collections.abc import Mapping
from dataclasses import dataclass
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.errors import ApiErrorCode, InvalidRequestError, NotFoundError
from nexus.schemas.chat import AttachmentIn, AttachmentOut, ReferenceAttachmentIn
from nexus.schemas.live_reference import SavedReference
from nexus.schemas.resource_evidence import ResourceField
from nexus.schemas.resource_items import ResourceItemOut
from nexus.services.highlights import read_highlight_annotations
from nexus.services.live_references import (
    field_visible,
    reference_visible,
    resolve_location,
)
from nexus.services.media import media_summaries
from nexus.services.resource_graph.refs import require_ref
from nexus.services.resource_graph.resolve import PromptBodyTooLarge, resolve_prompt
from nexus.services.resource_items.evidence import capture_reader_selection
from nexus.services.resource_items.items import resource_items_out


@dataclass(frozen=True, slots=True)
class CurrentReference:
    label: str
    body: str
    source_available: bool
    content_available: bool


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
) -> list[SavedReference]:
    """Prove reader captures before admission locks; whole references carry no words."""
    from nexus.services.live_references import from_evidence

    admitted = []
    for attachment in attachments:
        if isinstance(attachment, ReferenceAttachmentIn):
            if not reference_visible(db, viewer_id=viewer_id, reference=attachment.reference):
                raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Source not found")
            admitted.append(SavedReference(**attachment.reference.model_dump(), quote=None))
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
        admitted.append(
            from_evidence(
                capture_reader_selection(
                    db,
                    viewer_id=viewer_id,
                    reading_ref=require_ref(attachment.reading_ref),
                    source_ref=require_ref(attachment.source_ref),
                    capture=capture,
                )
            )
        )
    return admitted


def read_attachments(
    db: Session, viewer_id: UUID, attachments: list[AttachmentIn]
) -> list[AttachmentOut]:
    """Admit and present a draft in one read snapshot; nothing is written."""
    references = admit_attachments(db, viewer_id, attachments)
    refs = {reference.resource_ref: require_ref(reference.resource_ref) for reference in references}
    items = {
        item.ref: item
        for item in resource_items_out(db, viewer_id=viewer_id, refs=list(refs.values()))
    }
    resolved = present_attachments(
        db, viewer_id, attachments_by_reference(db, viewer_id, references, items=items)
    )
    return [resolved[reference.model_dump_json()] for reference in references]


def resolve(
    db: Session, *, viewer_id: UUID, reference: SavedReference, byte_limit: int, horizon_seq: int
) -> CurrentReference:
    from nexus.services.chat.timeline import message_visible

    ref = require_ref(reference.resource_ref)
    message_id = ref.id if ref.scheme == "message" else None
    if ref.scheme == "passage_anchor":
        message_id = db.scalar(
            text("SELECT owner_id FROM passage_anchors WHERE id=:id AND owner_scheme='message'"),
            {"id": ref.id},
        )
    if not reference_visible(db, viewer_id=viewer_id, reference=reference) or (
        message_id is not None and not message_visible(db, viewer_id, message_id, horizon_seq)
    ):
        return CurrentReference("source unavailable", "", False, False)
    if reference.locator is not None or reference.field == "annotation":
        item = resource_items_out(db, viewer_id=viewer_id, refs=[ref])[0]
        if reference.quote is not None:
            if len(reference.quote.exact.encode()) > byte_limit:
                raise PromptBodyTooLarge(ref.uri)
            return CurrentReference(item.label, reference.quote.exact, True, True)
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
        return CurrentReference(item.label, body or "", True, True)
    resource = resolve_prompt(
        db, viewer_id=viewer_id, ref=ref, byte_limit=byte_limit, identity_only=False
    )
    if resource.quote is not None:
        body = resource.quote.exact
        if resource.quote.annotation:
            body += "\nannotation: " + resource.quote.annotation
    else:
        body = resource.inline_body or resource.body or resource.summary or resource.fetch_hint
    return CurrentReference(resource.label, body or "", not resource.missing, not resource.missing)
