"""Resolve live attachments using current source authority and structural coordinates.

No source words or publication identities are saved here. A syntactically valid
reference may be unavailable now; offsets never search for replacement words.
"""

from collections.abc import Mapping
from dataclasses import dataclass
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.schemas.chat import AttachmentOut
from nexus.schemas.live_reference import LiveReference
from nexus.schemas.resource_evidence import ResourceField
from nexus.schemas.resource_items import ResourceItemOut
from nexus.services.live_references import field_visible, reference_visible, resolve_location
from nexus.services.resource_graph.refs import require_ref
from nexus.services.resource_graph.resolve import PromptBodyTooLarge, resolve_prompt
from nexus.services.resource_items.items import resource_items_out


@dataclass(frozen=True, slots=True)
class CurrentReference:
    label: str
    body: str
    source_available: bool
    location_available: bool


def attachments_by_reference(
    db: Session,
    viewer_id: UUID,
    references: list[LiveReference],
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
            and resolve_location(db, reference, byte_limit=None)[0],
        )
    return result


def resolve(
    db: Session, *, viewer_id: UUID, reference: LiveReference, byte_limit: int, horizon_seq: int
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
        if reference.locator is not None:
            available, body = resolve_location(db, reference, byte_limit=byte_limit)
            return CurrentReference(item.label, body or "", True, available)
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
