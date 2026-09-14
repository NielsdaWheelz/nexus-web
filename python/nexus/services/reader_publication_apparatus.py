"""Retained source annotations; authored user relationships remain live.

The publication owner holds the media/generation fence while copying current
source facts. SQL copies exact text without hydrating note bodies in the API or
publication process. The original HTML remains in retained source assets/units.
An apparatus UUID is a logical attachment identity, not proof of unchanged text:
only this selected generation identifies its immutable body and selector.
"""

from uuid import UUID

from sqlalchemy import (
    Integer,
    Row,
    Select,
    Text,
    case,
    exists,
    func,
    insert,
    literal,
    select,
    text,
    true,
)
from sqlalchemy.orm import Session, aliased

from nexus.config import ReaderPublicationLimits
from nexus.db.models import (
    ReaderApparatusEdge,
    ReaderApparatusItem,
    ReaderPublicationApparatusEdge,
    ReaderPublicationApparatusItem,
    ReaderPublicationUnit,
)
from nexus.errors import ApiError, ApiErrorCode, NotFoundError, ReaderContentTooLargeError
from nexus.schemas.reader_apparatus import READER_APPARATUS_FORWARD_RELATIONS
from nexus.schemas.reader_publication import (
    ReaderPublicationApparatusLocation,
    ReaderPublicationApparatusPage,
    ReaderPublicationApparatusPdfLocation,
    ReaderPublicationApparatusRequest,
    ReaderPublicationApparatusSummary,
    ReaderPublicationApparatusTarget,
    ReaderPublicationApparatusTargetsPage,
    ReaderPublicationApparatusTextLocation,
    ReaderPublicationApparatusTextPage,
    ReaderPublicationApparatusTextRequest,
    ReaderPublicationApparatusUnavailableLocation,
    ReaderPublicationSourceRange,
)
from nexus.services.reader_publication_read import get_reader_publication_member_for_viewer
from nexus.services.search.constants import MAX_SNIPPET_LENGTH
from nexus.services.signed_keyset_cursor import (
    KeysetValue,
    KeysetValueKind,
    decode_signed_keyset_cursor,
    encode_signed_keyset_cursor,
)


def retain_reader_publication_apparatus(
    db: Session, *, media_id: UUID, generation: int, source_generation: int | None = None
) -> None:
    """Install after source projection writes; title changes copy their prior source."""
    for current, retained, identity, fields in (
        (
            ReaderApparatusItem,
            ReaderPublicationApparatusItem,
            "item_id",
            (
                "stable_key",
                "sort_key",
                "kind",
                "label",
                "body_text",
                "locator",
                "locator_status",
                "confidence",
            ),
        ),
        (
            ReaderApparatusEdge,
            ReaderPublicationApparatusEdge,
            "edge_id",
            ("from_item_id", "to_item_id", "relation", "confidence"),
        ),
    ):
        if source_generation is None:
            source = select(
                current.media_id,
                literal(generation),
                current.id,
                func.row_number().over(order_by=(current.sort_key, current.stable_key, current.id))
                - 1,
                *(getattr(current, field) for field in fields),
            ).where(current.media_id == media_id)
        else:
            source = select(
                retained.media_id,
                literal(generation),
                getattr(retained, identity),
                retained.ordinal,
                *(getattr(retained, field) for field in fields),
            ).where(retained.media_id == media_id, retained.generation == source_generation)
        db.execute(
            insert(retained).from_select(
                ("media_id", "generation", identity, "ordinal", *fields), source
            )
        )


def verify_current_reader_publication_apparatus(
    db: Session, *, media_id: UUID, generation: int
) -> None:
    """Release preflight compares exact current facts in SQL, without loading bodies."""
    if (
        db.scalar(
            text("SELECT generation FROM reader_publications WHERE media_id = :media"),
            {"media": media_id},
        )
        != generation
    ):
        raise ValueError("Reader apparatus verification requires the current generation")
    for current, retained, identity, fields in (
        (
            "reader_apparatus_items",
            "reader_publication_apparatus_items",
            "item_id",
            "stable_key, sort_key, kind, label, body_text, locator, locator_status, confidence",
        ),
        (
            "reader_apparatus_edges",
            "reader_publication_apparatus_edges",
            "edge_id",
            "from_item_id, to_item_id, relation, confidence",
        ),
    ):
        different = db.scalar(
            text(
                f"""
                WITH current AS (
                  SELECT id, row_number() OVER (ORDER BY sort_key, stable_key, id) - 1 AS ordinal,
                         {fields}
                  FROM {current} WHERE media_id = :media
                ), retained AS (
                  SELECT {identity} AS id, ordinal, {fields}
                  FROM {retained} WHERE media_id = :media AND generation = :generation
                )
                SELECT EXISTS (
                  (SELECT * FROM current EXCEPT SELECT * FROM retained)
                  UNION ALL
                  (SELECT * FROM retained EXCEPT SELECT * FROM current)
                )
                """
            ),
            {"media": media_id, "generation": generation},
        )
        if different:
            raise ValueError("Retained reader apparatus differs from its published source")


def _apparatus_summary_query(media_id: UUID, generation: int) -> Select:
    item = ReaderPublicationApparatusItem
    edge = ReaderPublicationApparatusEdge
    target = aliased(ReaderPublicationApparatusItem)
    outgoing = (
        edge.media_id == item.media_id,
        edge.generation == item.generation,
        edge.from_item_id == item.item_id,
        edge.relation.in_(READER_APPARATUS_FORWARD_RELATIONS),
    )
    query = select(
        item.item_id.label("id"), item.stable_key, item.ordinal, item.kind, item.confidence
    ).select_from(item)
    # Existing source-reference display uses the owner's first nonempty field,
    # then the earliest forward target carrying that field. Return its exact
    # source id so explicit text pages never mistake a preview for authored text.
    for field in ("label", "body_text"):
        target_field = getattr(target, field)
        count_field = "body_codepoints" if field == "body_text" else "label_codepoints"
        target_count = getattr(target, count_field)
        first = (
            select(
                target.item_id,
                func.substr(target_field, 1, MAX_SNIPPET_LENGTH).label("excerpt"),
                target_count.label("codepoints"),
            )
            .select_from(target)
            .join(
                edge,
                (edge.media_id == target.media_id)
                & (edge.generation == target.generation)
                & (edge.to_item_id == target.item_id),
            )
            .where(*outgoing, target_count > 0)
            .order_by(edge.ordinal)
            .limit(1)
            .correlate(item)
            .lateral(f"first_{field}")
        )
        owned = getattr(item, field)
        owned_count = getattr(item, count_field)
        present = owned_count > 0
        name = "body" if field == "body_text" else field
        query = query.outerjoin(first, true()).add_columns(
            case((present, func.substr(owned, 1, MAX_SNIPPET_LENGTH)), else_=first.c.excerpt).label(
                f"{name}_excerpt"
            ),
            case((present, owned_count), else_=first.c.codepoints).label(f"{name}_codepoints"),
            case((present, item.item_id), else_=first.c.item_id).label(f"{name}_source_id"),
        )
    fragment = item.location["fragment_id"].astext
    start = item.location["start_offset"].astext.cast(Integer)
    end = item.location["end_offset"].astext.cast(Integer)
    unit = ReaderPublicationUnit
    last = aliased(ReaderPublicationUnit)
    addressed = (
        select(unit.unit_key)
        .where(
            unit.media_id == item.media_id,
            unit.generation == item.generation,
            unit.fragment_id.cast(Text) == fragment,
            unit.start_cp <= start,
            unit.end_cp > start,
            item.location["media_id"].astext == str(media_id),
            exists(
                select(last.unit_key)
                .where(
                    last.media_id == item.media_id,
                    last.generation == item.generation,
                    last.fragment_id.cast(Text) == fragment,
                    last.end_cp >= end,
                )
                .correlate(item)
            ),
        )
        .order_by(unit.start_cp.desc(), unit.ordinal)
        .limit(1)
        .correlate(item)
        .lateral("addressed")
    )
    has_targets = exists(select(edge.edge_id).where(*outgoing).correlate(item))
    return (
        query.outerjoin(addressed, true())
        .add_columns(
            has_targets.label("has_targets"),
            addressed.c.unit_key,
            fragment.label("fragment_id"),
            start.label("start_cp"),
            end.label("end_cp"),
            item.location["page_number"].astext.cast(Integer).label("pdf_page"),
        )
        .where(item.media_id == media_id, item.generation == generation)
    )


def _summary(row: Row) -> ReaderPublicationApparatusSummary:
    return ReaderPublicationApparatusSummary(
        id=row.id,
        stable_key=row.stable_key,
        kind=row.kind,
        confidence=row.confidence,
        label_excerpt=row.label_excerpt,
        label_codepoints=row.label_codepoints,
        label_source_id=row.label_source_id,
        body_excerpt=row.body_excerpt,
        body_codepoints=row.body_codepoints,
        body_source_id=row.body_source_id,
        has_targets=row.has_targets,
        source_range=ReaderPublicationSourceRange(
            unit_key=row.unit_key,
            fragment_id=row.fragment_id,
            start_cp=row.start_cp,
            end_cp=row.end_cp,
        )
        if row.unit_key is not None
        else None,
        pdf_page=row.pdf_page,
    )


def lookup_reader_publication_apparatus(
    db: Session,
    *,
    viewer_id: UUID,
    media_id: UUID,
    generation: int,
    stable_key: str,
) -> ReaderPublicationApparatusSummary:
    """Resolve an authored inline marker key against only its selected source."""
    get_reader_publication_member_for_viewer(
        db,
        viewer_id=viewer_id,
        media_id=media_id,
        generation=generation,
        key="descriptor.json",
        role="descriptor",
    )
    row = db.execute(
        _apparatus_summary_query(media_id, generation)
        .where(
            ReaderPublicationApparatusItem.stable_key == stable_key,
        )
        .limit(2)
    ).one_or_none()
    if row is None:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Reader apparatus item not found")
    return _summary(row)


def list_reader_publication_apparatus(
    db: Session,
    *,
    viewer_id: UUID,
    media_id: UUID,
    generation: int,
    request: ReaderPublicationApparatusRequest,
    limits: ReaderPublicationLimits,
    from_item_id: UUID | None = None,
) -> ReaderPublicationApparatusPage | ReaderPublicationApparatusTargetsPage:
    """Source facts and explicit forward-target pages; no live user associations."""
    get_reader_publication_member_for_viewer(
        db,
        viewer_id=viewer_id,
        media_id=media_id,
        generation=generation,
        key="descriptor.json",
        role="descriptor",
    )
    item = ReaderPublicationApparatusItem
    edge = ReaderPublicationApparatusEdge
    query = _apparatus_summary_query(media_id, generation)
    if from_item_id is None:
        # Preserve the existing source-reference owner rule. A target with no
        # own marker/forward edges is displayed through its referring owner.
        forward = edge.relation.in_(READER_APPARATUS_FORWARD_RELATIONS)
        incoming = exists(
            select(edge.edge_id)
            .where(
                edge.media_id == item.media_id,
                edge.generation == item.generation,
                edge.to_item_id == item.item_id,
                forward,
            )
            .correlate(item)
        )
        outgoing = exists(
            select(edge.edge_id)
            .where(
                edge.media_id == item.media_id,
                edge.generation == item.generation,
                edge.from_item_id == item.item_id,
                forward,
            )
            .correlate(item)
        )
        query = query.where(item.kind.endswith("_ref", autoescape=True) | outgoing | ~incoming)
        order = item.ordinal
        page_type = ReaderPublicationApparatusPage
    else:
        if (
            db.scalar(
                select(item.item_id).where(
                    item.media_id == media_id,
                    item.generation == generation,
                    item.item_id == from_item_id,
                )
            )
            is None
        ):
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Reader apparatus item not found")
        earlier = aliased(ReaderPublicationApparatusEdge)
        repeated_target = exists(
            select(earlier.edge_id)
            .where(
                earlier.media_id == edge.media_id,
                earlier.generation == edge.generation,
                earlier.from_item_id == edge.from_item_id,
                earlier.to_item_id == edge.to_item_id,
                earlier.relation.in_(READER_APPARATUS_FORWARD_RELATIONS),
                earlier.ordinal < edge.ordinal,
            )
            .correlate(edge)
        )
        query = (
            query.join(
                edge,
                (edge.media_id == item.media_id)
                & (edge.generation == item.generation)
                & (edge.to_item_id == item.item_id),
            )
            .where(
                edge.from_item_id == from_item_id,
                edge.relation.in_(READER_APPARATUS_FORWARD_RELATIONS),
                ~repeated_target,
            )
            .add_columns(edge.edge_id, edge.relation, edge.confidence.label("edge_confidence"))
        )
        order = edge.ordinal
        page_type = ReaderPublicationApparatusTargetsPage
    binding = {
        "viewer": str(viewer_id),
        "media": str(media_id),
        "generation": generation,
        "from": str(from_item_id) if from_item_id is not None else None,
    }
    if request.after is not None:
        (after,) = decode_signed_keyset_cursor(
            request.after,
            family="ReaderPublicationApparatus",
            query=binding,
            expected_kinds=(KeysetValueKind.Int,),
        )
        query = query.where(order > after)
    rows = db.execute(
        query.add_columns(order.label("page_ordinal")).order_by(order).limit(request.limit + 1)
    ).all()
    items = []
    last_cursor = None
    for row in rows:
        projected = _summary(row)
        value = (
            projected
            if from_item_id is None
            else ReaderPublicationApparatusTarget(
                edge_id=row.edge_id,
                relation=row.relation,
                confidence=row.edge_confidence,
                target=projected,
            )
        )
        cursor = encode_signed_keyset_cursor(
            family="ReaderPublicationApparatus",
            query=binding,
            after=(KeysetValue(KeysetValueKind.Int, row.page_ordinal),),
        )
        candidate = page_type(items=(*items, value), next_cursor=cursor)
        page_bytes = len(candidate.model_dump_json().encode()) + len(b'{"data":}')
        if len(items) == request.limit or page_bytes > limits.index_bytes:
            if not items:
                raise ReaderContentTooLargeError(
                    "Reader apparatus exceeds response capacity",
                    limit="index_bytes",
                    limit_value=limits.index_bytes,
                    measured=page_bytes,
                )
            return page_type(items=tuple(items), next_cursor=last_cursor)
        items.append(value)
        last_cursor = cursor
    return page_type(items=tuple(items), next_cursor=None)


def read_reader_publication_apparatus_text(
    db: Session,
    *,
    viewer_id: UUID,
    media_id: UUID,
    generation: int,
    item_id: UUID,
    request: ReaderPublicationApparatusTextRequest,
    limits: ReaderPublicationLimits,
) -> ReaderPublicationApparatusTextPage:
    """Complete authored text in explicit Unicode-codepoint pages, including empty text."""
    get_reader_publication_member_for_viewer(
        db,
        viewer_id=viewer_id,
        media_id=media_id,
        generation=generation,
        key="descriptor.json",
        role="descriptor",
    )
    item = ReaderPublicationApparatusItem
    column = item.body_text if request.field == "Body" else item.label
    where = (item.media_id == media_id, item.generation == generation, item.item_id == item_id)
    count_column = item.body_codepoints if request.field == "Body" else item.label_codepoints
    total = db.scalar(select(func.coalesce(count_column, 0)).where(*where))
    if total is None:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Reader apparatus item not found")
    if request.offset_cp > total:
        raise ApiError(
            ApiErrorCode.E_INVALID_REQUEST, "Reader apparatus text offset exceeds source"
        )
    envelope = ReaderPublicationApparatusTextPage(
        field=request.field,
        offset_cp=request.offset_cp,
        text="",
        total_codepoints=total,
        next_offset_cp=total if total >= 1000 else None,
    )
    # A scalar encodes into at most six JSON/UTF-8 bytes. Reserve exact envelope
    # metadata (using the largest possible next offset) before asking SQL for text.
    available = limits.index_bytes - len(envelope.model_dump_json().encode()) - len(b'{"data":}')
    count = available // 6
    if count <= 0:
        # justify-service-invariant-check: the envelope holds only fixed-width
        # scalars, so its size is independent of the retained text; a profile
        # whose index_bytes cannot hold it can never serve any apparatus text.
        # ReaderPublicationLimits validates each field in isolation and cannot
        # express this relation between index_bytes and the envelope shape.
        raise AssertionError("Qualified index capacity cannot hold the apparatus text envelope")
    value = db.scalar(
        select(func.coalesce(func.substr(column, request.offset_cp + 1, count), "")).where(*where)
    )
    if value is None:
        raise AssertionError(
            "Selected immutable apparatus item disappeared within the read snapshot"
        )
    next_offset = request.offset_cp + len(value)
    return envelope.model_copy(
        update={
            "text": value,
            "next_offset_cp": next_offset if next_offset < total else None,
        }
    )


def locate_reader_publication_apparatus(
    db: Session,
    *,
    viewer_id: UUID,
    media_id: UUID,
    generation: int,
    item_id: UUID,
) -> ReaderPublicationApparatusLocation:
    """Recover precise geometry on activation, excluding unbounded quote/context strings."""
    get_reader_publication_member_for_viewer(
        db,
        viewer_id=viewer_id,
        media_id=media_id,
        generation=generation,
        key="descriptor.json",
        role="descriptor",
    )
    item = ReaderPublicationApparatusItem
    row = db.execute(
        _apparatus_summary_query(media_id, generation).where(item.item_id == item_id)
    ).one_or_none()
    if row is None:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Reader apparatus item not found")
    if row.unit_key is not None:
        return ReaderPublicationApparatusTextLocation(
            range=ReaderPublicationSourceRange(
                unit_key=row.unit_key,
                fragment_id=row.fragment_id,
                start_cp=row.start_cp,
                end_cp=row.end_cp,
            )
        )
    if row.pdf_page is not None:
        quads = db.scalar(
            select(item.location["quads"]).where(
                item.media_id == media_id,
                item.generation == generation,
                item.item_id == item_id,
                item.location["type"].astext == "pdf_page_geometry",
                item.location["media_id"].astext == str(media_id),
            )
        )
        if quads:
            return ReaderPublicationApparatusPdfLocation(page=row.pdf_page, quads=tuple(quads))
    return ReaderPublicationApparatusUnavailableLocation()
