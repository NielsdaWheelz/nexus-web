"""Captured evidence: freezing words with their location, projecting frozen words as an
occurrence, and resolving a source-target key.

Capture happens when words enter a candidate or quote; publication only copies it. A
historical read never asks the current target for replacement words or attribution:
current state can only make the location or the source unavailable (I6). Where words
land now is ``locations``'s proof.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
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
    ResourceField,
    validate_resource_field,
)
from nexus.schemas.resource_graph import CitationSnapshot
from nexus.schemas.resource_items import (
    CitationSourceTargetKey,
    LocatedSourceLocationOut,
    NamedResourceBodyOut,
    PointSourceLocationOut,
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
    XPostSourceLocationOut,
    XPostSourceTargetKey,
)
from nexus.schemas.retrieval import LocationPrecision, RetrievalLocator
from nexus.services.reader_excerpts import (
    plain_excerpt,
    project_excerpts,
    read_captures,
    scope_excerpts,
)
from nexus.services.reader_publication import ready_publication_rows_sql
from nexus.services.resource_graph.liveness import edge_live_sql
from nexus.services.resource_graph.refs import ResourceRef, assert_resource_ref, require_ref
from nexus.services.resource_items.items import (
    passage_body,
    passage_label,
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
    scoped_media_passage,
    source_identities,
)
from nexus.services.x_source import x_primary_post_captures_sql

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
            completion_ref=None,
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
                attribution_text=None,
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
    if ref.scheme == "fragment":
        capture_id = db.scalar(
            text("SELECT x_post_capture_id FROM fragments WHERE id=:id"), {"id": ref.id}
        )
        if capture_id is not None:
            from nexus.services.source_citations import x_capture_evidence

            return x_capture_evidence(db, capture_id=capture_id)
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
        attribution_text=source.attribution_text if source else None,
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
    return CapturedEvidence(quote=quote, source=captured_source, target=target, completion_ref=None)


def _precision(locator: dict[str, Any]) -> LocationPrecision:
    if locator["type"] in TIMED_KINDS:
        return "time"
    if locator["type"] == "pdf_page":
        return "page"
    return "approximate" if locator.get("projection") == "proportional_text_offsets" else "exact"


def _admitted_body(
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
        if owner_ref and owner_ref.startswith("fragment:"):
            from nexus.services.x_source import readable_x_capture_ids_sql

            capture = db.scalar(
                text("SELECT x_post_capture_id FROM fragments WHERE id=:id"),
                {"id": assert_resource_ref(owner_ref).id},
            )
            if capture is not None and not db.scalar(
                text(
                    f"SELECT EXISTS(SELECT 1 FROM ({readable_x_capture_ids_sql()}) r WHERE r.capture_id=:capture)"
                ),
                {"viewer_id": viewer_id, "capture": capture},
            ):
                return None
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
        owner = assert_resource_ref(target.owner_ref)
        if (
            owner.scheme != "fragment"
            or str(owner.id) != str(target.locator.fragment_id)
            or evidence.quote is None
        ):
            return None
        scoped = media_passages(
            db,
            viewer_id=viewer_id,
            refs=[owner],
            reading_media_ids={owner.uri: reading_media_id}
            if reading_media_id is not None
            else None,
        ).get(owner.uri)
        if (
            scoped is None
            or scoped.locator is None
            or scoped.locator["capture_id"] != str(target.locator.capture_id)
        ):
            return None
        words = scoped.quote.exact
        if words[target.locator.start_offset : target.locator.end_offset] != evidence.quote.exact:
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
    reads = location_reads(db, viewer_id, [target])
    current = current_locator(target, quote, reads)
    if current is None:
        return None
    scoped = scoped_media_passage(
        db,
        viewer_id=viewer_id,
        source_media_id=owner.id,
        quote=quote,
        locator=current,
        reading_media_id=reading_media_id,
    )
    if scoped is None:
        return None
    chosen_owner, chosen_locator = scoped.owner, scoped.locator
    scope = scoped.excerpt_scope or {"kind": "capture"}
    incomplete_tables = scoped.incomplete_tables
    selector = (chosen_locator or {}).get("text_quote_selector") or {}
    if selector:
        prefix_limit = len(selector.get("prefix") or "")
        suffix_limit = len(selector.get("suffix") or "")
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
                "target": target.model_copy(update={"owner_ref": chosen_owner.uri}),
            }
        ),
        scope,
        incomplete_tables,
    )


@dataclass(frozen=True, slots=True)
class _AdmittedEvidence:
    original: CapturedEvidence
    projected: CapturedEvidence
    scope: dict[str, Any]
    incomplete_tables: tuple[tuple[int, int], ...]


def _admitted_evidence(
    db: Session,
    *,
    viewer_id: UUID,
    evidence: CapturedEvidence,
    reading_media_id: UUID | None = None,
) -> _AdmittedEvidence | None:
    """Admit the frozen base and its optional observation separately.

    Callers already authorize the containing occurrence. Only the internal
    projection merges observations; serialized evidence keeps its original base.
    A supplementary observation is not permission to read that capture's body.
    """
    body = _admitted_body(
        db,
        viewer_id=viewer_id,
        evidence=evidence.model_copy(update={"completion_ref": None}),
        reading_media_id=reading_media_id,
    )
    if body is None:
        return None
    original, scope, incomplete = body
    projected = original
    if evidence.completion_ref is not None:
        capture_id = db.scalar(
            text("""
            SELECT capture.id FROM fragments f
            JOIN x_post_captures capture ON capture.id=f.x_post_capture_id
            JOIN x_post_capture_admissions admission ON admission.capture_id=capture.id
            WHERE f.id=:fragment_id AND admission.user_id=:viewer_id
              AND capture.payload->>'kind'='complete_post'
        """),
            {
                "fragment_id": assert_resource_ref(evidence.completion_ref).id,
                "viewer_id": viewer_id,
            },
        )
        if capture_id is not None:
            from nexus.services.source_citations import x_capture_evidence

            observation = x_capture_evidence(db, capture_id=capture_id)
            target, quote = original.target, original.quote
            if (target.owner_ref or "").startswith("external_snapshot:"):
                admitted_observation = _admitted_body(
                    db,
                    viewer_id=viewer_id,
                    evidence=observation,
                    reading_media_id=reading_media_id,
                )
                if admitted_observation is None:
                    return _AdmittedEvidence(original, projected, scope, incomplete)
                observation, scope, incomplete = admitted_observation
                target, quote = observation.target, observation.quote
            source = original.source.model_dump()
            for field, value in observation.source.model_dump().items():
                if field != "ref" and source[field] is None:
                    source[field] = value
            original = original.model_copy(update={"completion_ref": evidence.completion_ref})
            projected = original.model_copy(
                update={
                    "source": CapturedSource.model_validate(source),
                    "target": target,
                    "quote": quote,
                }
            )
    return _AdmittedEvidence(original, projected, scope, incomplete)


def _scope_admissions(
    admissions: Sequence[
        tuple[CapturedEvidence, dict[str, Any], tuple[tuple[int, int], ...]] | None
    ],
) -> list[CapturedEvidence | None]:
    quoted = [value for value in admissions if value is not None and value[0].quote is not None]
    frozen = iter(
        scope_excerpts(
            [
                {"excerpt": quote.excerpt.model_dump(mode="json"), "scope": value[1]}
                for value in quoted
                if (quote := value[0].quote) is not None
            ],
            incomplete_tables=[value[2] for value in quoted],
        )
    )
    output: list[CapturedEvidence | None] = []
    for value in admissions:
        if value is None:
            output.append(None)
        elif value[0].quote is None:
            output.append(value[0])
        else:
            excerpt = next(frozen)
            output.append(
                None
                if excerpt is None
                else value[0].model_copy(
                    update={"quote": value[0].quote.model_copy(update={"excerpt": excerpt})}
                )
            )
    return output


def admit_evidence(
    db: Session,
    *,
    viewer_id: UUID,
    evidence: CapturedEvidence,
) -> CapturedEvidence | None:
    """Disclose the original base and admitted proof without flattening preview completion."""
    admitted = _admitted_evidence(db, viewer_id=viewer_id, evidence=evidence)
    if admitted is None:
        return None
    return _scope_admissions([(admitted.original, admitted.scope, admitted.incomplete_tables)])[0]


def admit_citation_snapshot(
    db: Session, *, viewer_id: UUID, snapshot: CitationSnapshot
) -> CitationSnapshot:
    """A connection's raw snapshot obeys the same evidence disclosure as its item."""
    if snapshot.evidence is None:
        return snapshot
    return snapshot.model_copy(
        update={"evidence": admit_evidence(db, viewer_id=viewer_id, evidence=snapshot.evidence)}
    )


def _citation_reference(db: Session, *, edge_id: UUID) -> tuple[str, str | None] | None:
    """Only source-bound declared references survive denied target evidence."""
    row = db.execute(
        text("""
        SELECT c.referenced_revision_id AS revision,NULL::text AS title
        FROM x_post_capture_contexts c WHERE c.citation_id=:id AND c.relation='quoted'
        UNION ALL SELECT d.provider_target_ref,d.title FROM document_embeds d
        WHERE d.citation_id=:id AND d.provider='x' AND d.embed_kind='post'
    """),
        {"id": edge_id},
    ).one_or_none()
    if row is None:
        return None
    from nexus.services.x_identity import canonical_x_post_url

    return canonical_x_post_url(row.revision), row.title


def evidence_items(
    db: Session,
    *,
    viewer_id: UUID,
    occurrences: Sequence[tuple[ResourceRef, CapturedEvidence, SourceTargetKey]],
    reading_media_ids: Mapping[str, UUID] | None = None,
) -> list[ResourceItemOut]:
    """Each occurrence as an item of its frozen words and attribution; the current state
    of the cited ref's owner decides only whether the location still opens (I6)."""
    current = {
        ref.uri: ResourceItemOut(
            authored_by_viewer=False,
            ref=ref.uri,
            action_ref=ref.uri,
            label="Source",
            missing=False,
            preview=ResourcePreviewOut(
                body=NamedResourceBodyOut(
                    title="Source", image_url=None, media_kind=None, contributors=None
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
        for ref, _, _ in occurrences
    }
    admissions = [
        _admitted_evidence(
            db,
            viewer_id=viewer_id,
            evidence=evidence,
            reading_media_id=reading_media_ids.get(ref.uri) if reading_media_ids else None,
        )
        for ref, evidence, _ in occurrences
    ]
    admitted = _scope_admissions(
        [
            (admission.projected, admission.scope, admission.incomplete_tables)
            if admission is not None
            else None
            for admission in admissions
        ]
    )
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
    projected = iter(
        project_excerpts(
            [
                {
                    "source_ref": original.source.ref,
                    "capture": {
                        "kind": "evidence",
                        "value": admission.projected.model_dump(mode="json"),
                    },
                    "mode": "full",
                    "scope": admission.scope,
                }
                for (_, original, _), admission, value in zip(
                    occurrences, admissions, admitted, strict=True
                )
                if admission is not None and value is not None and value.quote is not None
            ]
        )
    )
    out = []
    for (ref, evidence, key), value in zip(occurrences, admitted, strict=True):
        if value is None:
            reference = (
                _citation_reference(db, edge_id=key.edge_id)
                if isinstance(key, CitationSourceTargetKey)
                else None
            )
            if reference is not None:
                url, title = reference
                out.append(
                    current[ref.uri].model_copy(
                        update={
                            "label": title or url,
                            "preview": ResourcePreviewOut(
                                body=NamedResourceBodyOut(
                                    title=title or url,
                                    image_url=None,
                                    media_kind=None,
                                    contributors=None,
                                ),
                                source=None,
                            ),
                            "activation": ResourceActivationOut(
                                field=None, resource_ref=ref.uri, kind="external", href=url
                            ),
                        }
                    )
                )
                continue
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
                        ),
                        "activation": ResourceActivationOut(
                            field=None,
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
                field=None,
                resource_ref=ref.uri,
                kind="none",
                href=None,
                unavailable_reason="location_unavailable",
            )
        quote = evidence.quote
        reference = (
            _citation_reference(db, edge_id=key.edge_id)
            if isinstance(key, CitationSourceTargetKey)
            else None
        )
        display_title = frozen.title or (reference[0] if reference is not None else "Source")
        projection = next(projected) if quote else None
        body = (
            passage_body(
                projection, quote.color, reading_ref=evidence.target.owner_ref, captured=False
            )
            if quote and projection is not None
            else NamedResourceBodyOut(
                title=display_title,
                image_url=None,
                media_kind=frozen.media_kind,
                contributors=frozen.contributors,
            )
        )
        out.append(
            current[ref.uri].model_copy(
                update={
                    "label": passage_label(projection.text_parts.exact)
                    if projection is not None and projection.text_parts is not None
                    else display_title,
                    "preview": ResourcePreviewOut(body=body, source=attribution),
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
            fragment = f"citation-{'source-' if key.side == 'source' else ''}{key.edge_id}"
        case RetrievalSourceTargetKey():
            fragment = f"retrieval-{key.retrieval_id}"
        case XPostSourceTargetKey():
            raise ValueError("a logical post target cannot name captured evidence")
    href = source.href.split("#", 1)[0] + "#" + fragment if source.href else None
    return ResourceActivationOut(field=None, resource_ref=ref, kind=source.kind, href=href)


def _capture_destination(
    db: Session,
    *,
    viewer_id: UUID,
    capture_id: UUID,
    owner: ResourceRef,
    reading_media_id: UUID | None,
    primary_only: bool = False,
) -> tuple[ResourceActivationOut, str, str]:
    """Choose an exact unique occurrence; otherwise open the retained capture itself."""
    from nexus.services.reader_document import read_capture_document, read_reader_document

    selected = reading_media_id
    if selected is not None and can_read_media(db, viewer_id, selected):
        document = read_reader_document(db, viewer_id, selected)
        if document.kind != "pdf":
            matching = [
                unit
                for unit in document.units
                if unit.x_post
                and unit.x_post.owner
                and unit.x_post.owner.capture_id == capture_id
                and (not primary_only or unit.x_post.relation == "primary")
            ]
            if len(matching) == 1:
                return (
                    ResourceActivationOut(
                        field=None,
                        resource_ref=f"media:{selected}",
                        kind="route",
                        href=f"/media/{selected}",
                    ),
                    document.identity,
                    matching[0].id,
                )
    document = read_capture_document(db, viewer_id, capture_id)
    return (
        ResourceActivationOut(
            field=None, resource_ref=owner.uri, kind="route", href=f"/x/captures/{capture_id}"
        ),
        document.identity,
        str(capture_id),
    )


def _citation_source_target(
    db: Session,
    *,
    viewer_id: UUID,
    edge_id: UUID,
    source_ref: ResourceRef,
    reading_media_id: UUID | None,
) -> SourceTargetOut:
    from nexus.schemas.reader_point import ReaderPointOut
    from nexus.services.reader_document import read_reader_document
    from nexus.services.resource_items.routing import resource_activation_for_ref

    if source_ref.scheme in ("message", "oracle_reading"):
        return SourceTargetOut(
            source_activation=resource_activation_for_ref(
                db, viewer_id=viewer_id, ref=source_ref, missing=False
            ),
            location=WholeSourceLocationOut(),
        )
    if source_ref.scheme == "media":
        if reading_media_id not in (None, source_ref.id):
            return _UNAVAILABLE_SOURCE
        document = read_reader_document(db, viewer_id, source_ref.id)
        occurrences = [
            item for item in document.citation_occurrences if item.citation.edge_id == edge_id
        ]
        activation = ResourceActivationOut(
            field=None,
            resource_ref=source_ref.uri,
            kind="route",
            href=f"/media/{source_ref.id}#citation-source-{edge_id}",
        )
        if len(occurrences) != 1 or occurrences[0].at is None:
            return SourceTargetOut(
                source_activation=activation,
                location=UnavailableSourceLocationOut(reason="location_unavailable"),
            )
        return SourceTargetOut(
            source_activation=activation,
            location=PointSourceLocationOut(
                point=occurrences[0].at, source_identity=document.identity
            ),
        )
    if source_ref.scheme != "fragment":
        return _UNAVAILABLE_SOURCE
    row = db.execute(
        text("""
        SELECT c.capture_id,f.canonical_text FROM x_post_capture_contexts c
        JOIN fragments f ON f.x_post_capture_id=c.capture_id
        WHERE c.citation_id=:edge AND f.id=:fragment AND c.relation='quoted'
    """),
        {"edge": edge_id, "fragment": source_ref.id},
    ).one_or_none()
    if row is None:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Citation not found")
    activation, identity, unit_id = _capture_destination(
        db,
        viewer_id=viewer_id,
        capture_id=row.capture_id,
        owner=source_ref,
        reading_media_id=reading_media_id,
        primary_only=True,
    )
    if reading_media_id is not None and activation.resource_ref != f"media:{reading_media_id}":
        return SourceTargetOut(
            source_activation=activation,
            location=UnavailableSourceLocationOut(reason="location_unavailable"),
        )
    activation = activation.model_copy(
        update={"href": f"{activation.href}#citation-source-{edge_id}"}
    )
    return SourceTargetOut(
        source_activation=activation,
        location=PointSourceLocationOut(
            point=ReaderPointOut(unit_id=unit_id, offset=len(row.canonical_text)),
            source_identity=identity,
        ),
    )


def resolve_source_target(
    db: Session, *, viewer_id: UUID, target: SourceTargetKey, reading_media_id: UUID | None = None
) -> SourceTargetOut:
    """Where a key opens now (J9, I18). A whole resource answers its activation; a passage
    its proven current extent, else ``unavailable``. A resource key the viewer cannot see,
    or whose publication moves during this read, is ``unavailable``, never an error; a
    quote, citation or retrieval key naming nothing the viewer can read is 404 (a citation
    reads for whoever reads what cites it); a malformed resource ref is 400."""
    match target:
        case XPostSourceTargetKey():
            assert reading_media_id is not None
            if not can_read_media(db, viewer_id, reading_media_id):
                return _UNAVAILABLE_SOURCE
            activation = ResourceActivationOut(
                resource_ref=f"media:{reading_media_id}",
                field=None,
                kind="route",
                href=f"/media/{reading_media_id}",
            )
            capture_id = db.execute(
                text(f"""
                    SELECT primary_post.capture_id
                    FROM ({x_primary_post_captures_sql()}) primary_post
                    JOIN x_post_aliases alias ON alias.post_id = primary_post.post_id
                    JOIN ({ready_publication_rows_sql()}) publication
                      ON publication.media_id = primary_post.media_id
                    WHERE primary_post.media_id = :media_id AND alias.revision_id = :revision_id
                """),
                {"media_id": reading_media_id, "revision_id": target.revision_id},
            ).scalar_one_or_none()
            return SourceTargetOut(
                source_activation=activation,
                location=XPostSourceLocationOut(capture_id=capture_id)
                if capture_id is not None
                else UnavailableSourceLocationOut(reason="location_unavailable"),
            )
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
            from nexus.services.resource_graph.citations import citation_source_visible_sql

            row = db.execute(
                text(
                    "SELECT snapshot, source_scheme || ':' || source_id AS source"
                    " FROM resource_edges"
                    " WHERE id = :id AND origin = 'citation' AND ordinal IS NOT NULL"
                    f" AND {edge_live_sql('resource_edges')}"
                    f" AND {citation_source_visible_sql('resource_edges')}"
                ),
                {"id": target.edge_id, "viewer_id": viewer_id},
            ).first()
            if row is None:
                raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Citation not found")
            if target.side == "source":
                return _citation_source_target(
                    db,
                    viewer_id=viewer_id,
                    edge_id=target.edge_id,
                    source_ref=assert_resource_ref(row.source),
                    reading_media_id=reading_media_id,
                )
            snapshot = CitationSnapshot.model_validate(row.snapshot)
            assert snapshot.evidence is not None
            evidence = snapshot.evidence
    admitted = _admitted_evidence(
        db,
        viewer_id=viewer_id,
        evidence=evidence,
        reading_media_id=None if isinstance(target, CitationSourceTargetKey) else reading_media_id,
    )
    if admitted is None:
        reference = (
            _citation_reference(db, edge_id=target.edge_id)
            if isinstance(target, CitationSourceTargetKey)
            else None
        )
        if reference is not None:
            return SourceTargetOut(
                source_activation=ResourceActivationOut(
                    field=None,
                    resource_ref=evidence.source.ref or "",
                    kind="external",
                    href=reference[0],
                ),
                location=WholeSourceLocationOut(),
            )
        return _UNAVAILABLE_SOURCE
    evidence = admitted.projected
    captured = evidence.target
    owner = assert_resource_ref(captured.owner_ref) if captured.owner_ref else None
    if owner is not None and owner.scheme == "fragment":
        capture_id = db.scalar(
            text("SELECT x_post_capture_id FROM fragments WHERE id=:id"), {"id": owner.id}
        )
        if capture_id is not None:
            activation, identity, unit_id = _capture_destination(
                db,
                viewer_id=viewer_id,
                capture_id=capture_id,
                owner=owner,
                reading_media_id=reading_media_id,
            )
            if (
                isinstance(captured, CapturedPassageTarget)
                and captured.locator.type == "x_capture_offsets"
            ):
                return SourceTargetOut(
                    source_activation=activation,
                    location=LocatedSourceLocationOut(
                        locator=captured.locator,
                        precision=captured.precision,
                        source_identity=identity,
                        apparatus_reference_id=None,
                    ),
                )
            if captured.kind == "resource":
                from nexus.schemas.reader_point import ReaderPointOut

                return SourceTargetOut(
                    source_activation=activation,
                    location=PointSourceLocationOut(
                        point=ReaderPointOut(unit_id=unit_id, offset=0), source_identity=identity
                    ),
                )
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
    if captured.field == "annotation":
        source = source.model_copy(
            update={
                "activation": ResourceActivationOut(
                    field="annotation",
                    resource_ref=owner.uri,
                    kind="route",
                    href=f"/highlights/{owner.id}#annotation",
                )
            }
        )
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
            source_identity=(
                str(resolved_locator.capture_id)
                if resolved_locator.type == "x_capture_offsets"
                else reads.identities.get(owner.id)
            ),
            apparatus_reference_id=apparatus_reference_id,
        ),
    )
