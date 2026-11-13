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
from nexus.schemas.reader import (
    EpubTextOffsetsTargetOut,
    TranscriptTextOffsetsTargetOut,
    WebTextOffsetsTargetOut,
)
from nexus.schemas.reader_excerpts import FrozenExcerpt
from nexus.schemas.resource_evidence import ResourceField
from nexus.schemas.resource_items import ResourceItemOut
from nexus.services.highlights import read_highlight_annotations
from nexus.services.live_references import (
    field_visible,
    reference_texts,
    reference_visible,
    resolve_location,
)
from nexus.services.media import media_summaries
from nexus.services.reader_excerpts import plain_excerpt, project_excerpts
from nexus.services.resource_graph.refs import require_ref
from nexus.services.resource_graph.resolve import PromptBodyTooLarge, resolve_prompt
from nexus.services.resource_items.items import resource_items_out
from nexus.services.source_excerpt import (
    SourceExcerptFormatLimit,
    SourceExcerptRequest,
    source_display_excerpts,
)


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
            and resolve_location(db, reference, viewer_id=viewer_id, byte_limit=None)[0],
            excerpt=None,
            annotation=None,
            source=None,
        )
    return result


def present_attachments(
    db: Session, viewer_id: UUID, attachments: Mapping[str, AttachmentOut]
) -> dict[str, AttachmentOut]:
    """Enrich only actual figures, sharing admitted identity and exact text work."""
    readable = {key: value for key, value in attachments.items() if value.item is not None}
    selected = {
        key: value.reference
        for key, value in readable.items()
        if value.location_available
        and value.reference.locator is not None
        and value.reference.locator.kind
        in (
            "WebTextOffsets",
            "EpubTextOffsets",
            "TranscriptTextOffsets",
            "TextOffsets",
        )
    }
    words = reference_texts(db, list(selected.values()))
    structured = {
        key: reference
        for key, reference in selected.items()
        if isinstance(
            reference.locator,
            (WebTextOffsetsTargetOut, EpubTextOffsetsTargetOut, TranscriptTextOffsetsTargetOut),
        )
        and (require_ref(reference.resource_ref).scheme == "media" or words[key].x_capture)
    }
    requests = []
    for key, reference in structured.items():
        locator = reference.locator
        assert isinstance(
            locator,
            (WebTextOffsetsTargetOut, EpubTextOffsetsTargetOut, TranscriptTextOffsetsTargetOut),
        )
        requests.append(
            SourceExcerptRequest(
                reading_id=locator.fragment_id
                if words[key].x_capture
                else require_ref(reference.resource_ref).id,
                fragment_id=locator.fragment_id,
                start=locator.start_offset,
                end=min(locator.end_offset, locator.start_offset + 601),
            )
        )
    frozen: dict[str, FrozenExcerpt] = {}
    for key, outcome in zip(structured, source_display_excerpts(db, requests), strict=True):
        frozen[key] = (
            plain_excerpt(words[key].text)
            if isinstance(outcome, SourceExcerptFormatLimit)
            else outcome
        )
    for key in selected:
        if key not in frozen:
            frozen[key] = plain_excerpt(words[key].text)
    excerpts = {
        key: projection.view
        for key, projection in zip(
            frozen,
            project_excerpts(
                [
                    {
                        "source_ref": selected[key].resource_ref,
                        "capture": {
                            "kind": "passage",
                            "value": {
                                "quote_exact": words[key].text,
                                "publication": None,
                                "locator": None,
                                "excerpt": excerpt.model_dump(mode="json"),
                            },
                        },
                        "mode": "compact",
                        "scope": {"kind": "capture"},
                    }
                    for key, excerpt in frozen.items()
                ]
            ),
            strict=True,
        )
    }
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
                "excerpt": excerpts.get(key),
                "annotation": annotations.get(annotation_ids[key])
                if key in annotation_ids
                else None,
                "source": sources.get(source_ids[key]) if key in source_ids else None,
            }
        )
        for key, value in attachments.items()
    }


def read_attachments(
    db: Session, viewer_id: UUID, references: list[LiveReference]
) -> list[AttachmentOut]:
    """One snapshot and resource batch, preserving caller order and multiplicity."""
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
            available, body = resolve_location(
                db, reference, viewer_id=viewer_id, byte_limit=byte_limit
            )
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
