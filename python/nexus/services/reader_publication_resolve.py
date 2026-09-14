"""Resolve exact locators against retained coordinates without changing intent."""

from __future__ import annotations

from uuid import UUID

from sqlalchemy import and_, func, or_, select, text, tuple_
from sqlalchemy.orm import Session

from nexus.db.models import (
    Media,
    ReaderPublicationAnchor,
    ReaderPublicationArtifact,
    ReaderPublicationTarget,
    ReaderPublicationUnit,
)
from nexus.errors import ApiError, ApiErrorCode, InvalidRequestError, NotFoundError
from nexus.schemas.reader import (
    EpubReaderResumeState,
    PdfReaderResumeState,
    ReaderEpubTarget,
    ReaderFragmentTarget,
    ReaderQuoteContext,
    ReaderTextLocations,
    WebReaderResumeState,
)
from nexus.schemas.reader_publication import (
    ReaderPublicationEpubHrefTarget,
    ReaderPublicationLocatorTarget,
    ReaderPublicationMemberRef,
    ReaderPublicationNavigationTarget,
    ReaderPublicationPdfResolution,
    ReaderPublicationResolution,
    ReaderPublicationResolveRequest,
    ReaderPublicationSectionContext,
    ReaderPublicationSectionContextRequest,
    ReaderPublicationSectionSummary,
    ReaderPublicationSourceRange,
    ReaderPublicationSourceRangeResolution,
    ReaderPublicationSourceRangeTarget,
    ReaderPublicationTextResolution,
    ReaderPublicationUnitResolution,
    ReaderPublicationUnitTarget,
    ReaderPublicationUnresolved,
)
from nexus.services.passage_anchors import normalize_quote_text
from nexus.services.reader_publication_anchors import reader_publication_anchor_key
from nexus.services.reader_publication_read import (
    get_reader_publication_member_for_viewer,
    get_reader_publication_pdf_source_for_viewer,
)
from nexus.services.reader_publication_search import reader_publication_quote_matches_sql

# One ownership rule for a point: the first target at the greatest offset at or
# before it. Equal-offset targets keep the earlier authored identity, so a
# zero-width heading is never replaced by a later target at the same offset.
OWNING_TARGET_ORDER = (
    ReaderPublicationTarget.offset_cp.desc(),
    ReaderPublicationTarget.ordinal,
    ReaderPublicationTarget.target_id,
)


def resolve_reader_publication_for_viewer(
    db: Session,
    *,
    viewer_id: UUID,
    media_id: UUID,
    generation: int,
    request: ReaderPublicationResolveRequest,
) -> ReaderPublicationResolution:
    get_reader_publication_member_for_viewer(
        db,
        viewer_id=viewer_id,
        media_id=media_id,
        generation=generation,
        key="descriptor.json",
        role="descriptor",
    )
    if isinstance(request.target, ReaderPublicationUnitTarget):
        unit = db.get(ReaderPublicationUnit, (media_id, generation, request.target.unit_key))
        if unit is None:
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Reader publication unit not found")
        member, previous, following = _unit_adjacency(db, unit)
        return ReaderPublicationUnitResolution(
            unit_ref=member,
            ordinal=unit.ordinal,
            previous_ref=previous,
            next_ref=following,
            fragment_id=str(unit.fragment_id),
            start_cp=unit.start_cp,
            end_cp=unit.end_cp,
        )
    media_kind = db.scalar(select(Media.kind).where(Media.id == media_id))
    if media_kind is None:
        # justify-defect: the member lookup above authorized this media through
        # can_read_media, so its row exists for the rest of this transaction.
        raise AssertionError("Authorized reader publication has no media row")
    if isinstance(request.target, ReaderPublicationSourceRangeTarget):
        return _resolve_source_range(db, media_id, generation, media_kind, request.target)
    if isinstance(
        request.target, (ReaderPublicationNavigationTarget, ReaderPublicationEpubHrefTarget)
    ):
        if isinstance(request.target, ReaderPublicationNavigationTarget):
            target = db.get(
                ReaderPublicationTarget, (media_id, generation, request.target.target_id)
            )
            if target is None:
                return ReaderPublicationUnresolved(locator=None, reason="TargetMissing")
            unit = db.get(ReaderPublicationUnit, (media_id, generation, target.unit_key))
            navigation_offset = target.offset_cp
            navigation_anchor = target.anchor_id
        else:
            if media_kind != "epub":
                raise InvalidRequestError(
                    ApiErrorCode.E_INVALID_REQUEST, "EPUB href requires an EPUB publication"
                )
            target_rows = select(ReaderPublicationTarget).where(
                ReaderPublicationTarget.media_id == media_id,
                ReaderPublicationTarget.generation == generation,
                or_(
                    ReaderPublicationTarget.href_pathname == request.target.pathname,
                    ReaderPublicationTarget.target_id == request.target.pathname,
                ),
            )
            first_target = db.scalar(
                target_rows.order_by(
                    ReaderPublicationTarget.ordinal, ReaderPublicationTarget.target_id
                ).limit(1)
            )
            if first_target is None:
                return ReaderPublicationUnresolved(locator=None, reason="TargetMissing")
            if first_target.href_path is None:
                raise AssertionError("retained EPUB target has no original source path")
            # The legacy helper picks the first matching source path, including
            # normalized aliases; later source documents cannot supply its ids.
            target_rows = target_rows.where(
                ReaderPublicationTarget.href_path == first_target.href_path
            )

            if request.target.anchor_id is None:
                first_target_unit = db.get(
                    ReaderPublicationUnit, (media_id, generation, first_target.unit_key)
                )
                if first_target_unit is None:
                    raise AssertionError("retained EPUB source target lost its unit")
                unit = db.scalar(
                    select(ReaderPublicationUnit)
                    .where(
                        ReaderPublicationUnit.media_id == media_id,
                        ReaderPublicationUnit.generation == generation,
                        ReaderPublicationUnit.fragment_id == first_target_unit.fragment_id,
                    )
                    .order_by(ReaderPublicationUnit.ordinal)
                    .limit(1)
                )
                navigation_offset = 0
            else:
                anchor = db.get(
                    ReaderPublicationAnchor,
                    (
                        media_id,
                        generation,
                        reader_publication_anchor_key(
                            first_target.href_path, request.target.anchor_id
                        ),
                    ),
                )
                if anchor is None:
                    return ReaderPublicationUnresolved(locator=None, reason="TargetMissing")
                if (anchor.href_path, anchor.anchor_id) != (
                    first_target.href_path,
                    request.target.anchor_id,
                ):
                    raise ApiError(
                        ApiErrorCode.E_STORAGE_ERROR, "Reader authored anchor digest collision"
                    )
                unit = db.get(ReaderPublicationUnit, (media_id, generation, anchor.unit_key))
                navigation_offset = anchor.offset_cp
            target = (
                db.scalar(
                    target_rows.where(ReaderPublicationTarget.offset_cp <= navigation_offset)
                    .order_by(*OWNING_TARGET_ORDER)
                    .limit(1)
                )
                or first_target
            )
            navigation_anchor = request.target.anchor_id
        if unit is None:
            raise AssertionError("retained navigation target lost its unit")
        locations = ReaderTextLocations(
            text_offset=navigation_offset, progression=None, total_progression=None, position=None
        )
        context = ReaderQuoteContext(quote=None, quote_prefix=None, quote_suffix=None)
        navigation_locator: WebReaderResumeState | EpubReaderResumeState
        if media_kind == "web_article":
            navigation_locator = WebReaderResumeState(
                kind="web",
                target=ReaderFragmentTarget(fragment_id=str(unit.fragment_id)),
                locations=locations,
                text=context,
            )
        elif media_kind == "epub" and target.href_path is not None:
            navigation_locator = EpubReaderResumeState(
                kind="epub",
                target=ReaderEpubTarget(
                    section_id=target.target_id,
                    href_path=target.href_path,
                    anchor_id=navigation_anchor,
                ),
                locations=locations,
                text=context,
            )
        else:
            raise AssertionError("retained navigation target has no format-valid locator")
        member, previous, following = _unit_adjacency(db, unit)
        return ReaderPublicationTextResolution(
            locator=navigation_locator,
            fragment_id=str(unit.fragment_id),
            offset_cp=navigation_offset,
            local_offset_cp=navigation_offset - unit.start_cp,
            unit_ref=member,
            ordinal=unit.ordinal,
            previous_ref=previous,
            next_ref=following,
        )
    locator = request.target.locator
    if isinstance(locator, PdfReaderResumeState) and media_kind == "pdf":
        # Retained geometry identity has one owner: it reads the page bound and
        # the document asset member off the verified projection rows, so
        # navigation never fetches or digests the descriptor object.
        source = get_reader_publication_pdf_source_for_viewer(
            db, viewer_id=viewer_id, media_id=media_id, generation=generation
        )
        if locator.page > source.page_count:
            return ReaderPublicationUnresolved(locator=locator, reason="OffsetOutOfRange")
        return ReaderPublicationPdfResolution(
            locator=locator,
            page=locator.page,
            document_asset_ref=source.document_asset_ref,
        )

    target_unit: ReaderPublicationUnit | None = None
    target_offset = 0
    if isinstance(locator, WebReaderResumeState) and media_kind == "web_article":
        try:
            fragment_id = UUID(locator.target.fragment_id)
        except ValueError:
            return ReaderPublicationUnresolved(locator=locator, reason="TargetMissing")
    elif isinstance(locator, EpubReaderResumeState) and media_kind == "epub":
        row = db.execute(
            select(ReaderPublicationTarget, ReaderPublicationUnit)
            .join(
                ReaderPublicationUnit,
                and_(
                    ReaderPublicationUnit.media_id == ReaderPublicationTarget.media_id,
                    ReaderPublicationUnit.generation == ReaderPublicationTarget.generation,
                    ReaderPublicationUnit.unit_key == ReaderPublicationTarget.unit_key,
                ),
            )
            .where(
                ReaderPublicationTarget.media_id == media_id,
                ReaderPublicationTarget.generation == generation,
                ReaderPublicationTarget.target_id == locator.target.section_id,
                ReaderPublicationTarget.href_path == locator.target.href_path,
            )
        ).one_or_none()
        if row is None:
            return ReaderPublicationUnresolved(locator=locator, reason="TargetMissing")
        target, target_unit = row.tuple()
        fragment_id, target_offset = target_unit.fragment_id, target.offset_cp
        if locator.target.anchor_id is not None:
            anchor = db.get(
                ReaderPublicationAnchor,
                (
                    media_id,
                    generation,
                    reader_publication_anchor_key(
                        locator.target.href_path, locator.target.anchor_id
                    ),
                ),
            )
            if anchor is not None:
                if (anchor.href_path, anchor.anchor_id) != (
                    locator.target.href_path,
                    locator.target.anchor_id,
                ):
                    raise ApiError(
                        ApiErrorCode.E_STORAGE_ERROR, "Reader authored anchor digest collision"
                    )
                if locator.locations.text_offset == anchor.offset_cp or (
                    locator.locations.text_offset is None and locator.text.quote is None
                ):
                    anchored_unit = db.get(
                        ReaderPublicationUnit, (media_id, generation, anchor.unit_key)
                    )
                    if anchored_unit is None or anchored_unit.fragment_id != fragment_id:
                        raise AssertionError("retained authored anchor escaped its EPUB source")
                    target_unit, target_offset = anchored_unit, anchor.offset_cp
    else:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST, "Locator does not describe this publication format"
        )

    base = select(ReaderPublicationUnit).where(
        ReaderPublicationUnit.media_id == media_id,
        ReaderPublicationUnit.generation == generation,
        ReaderPublicationUnit.fragment_id == fragment_id,
    )
    first = db.scalar(base.order_by(ReaderPublicationUnit.ordinal).limit(1))
    if first is None:
        return ReaderPublicationUnresolved(locator=locator, reason="TargetMissing")
    offset = locator.locations.text_offset
    if offset is None and locator.text.quote is not None:
        exact = locator.text.quote
        prefix = locator.text.quote_prefix or ""
        suffix = locator.text.quote_suffix or ""
        # A match belongs to the unit containing the combined literal's first
        # point. At most 511 following points cover the existing quote/context
        # contract, including quotes split across arbitrarily many empty units.
        # PostgreSQL returns only two scalar offsets; it never assembles a
        # fragment, returns body text, or asks the client to traverse unit pages.
        needle = prefix + exact + suffix
        matches = db.scalars(
            text(
                """
                SELECT u.start_cp + hit.position - 1 + :prefix_length
                FROM reader_publication_units u
                CROSS JOIN LATERAL (
                    SELECT u.canonical_text || coalesce(string_agg(
                        substring(n.canonical_text FROM 1
                            FOR :overlap - (n.start_cp - u.end_cp)),
                        '' ORDER BY n.start_cp, n.ordinal
                    ), '') AS body
                    FROM reader_publication_units n
                    WHERE n.media_id = u.media_id AND n.generation = u.generation
                      AND n.fragment_id = u.fragment_id AND n.end_cp > n.start_cp
                      AND n.start_cp >= u.end_cp AND n.start_cp < u.end_cp + :overlap
                ) context
                CROSS JOIN LATERAL (
                    SELECT strpos(context.body, :needle) AS position
                ) first_match
                CROSS JOIN LATERAL (VALUES
                    (first_match.position),
                    (CASE WHEN first_match.position > 0 THEN
                        first_match.position + nullif(strpos(
                            substring(context.body FROM first_match.position + 1), :needle
                        ), 0)
                    END)
                ) hit(position)
                WHERE u.media_id = :media_id AND u.generation = :generation
                  AND u.fragment_id = :fragment_id AND u.end_cp > u.start_cp
                  AND hit.position > 0 AND hit.position <= u.end_cp - u.start_cp
                LIMIT 2
                """
            ),
            {
                "media_id": media_id,
                "generation": generation,
                "fragment_id": fragment_id,
                "needle": needle,
                "overlap": len(needle) - 1,
                "prefix_length": len(prefix),
            },
        ).all()
        if not matches:
            return ReaderPublicationUnresolved(locator=locator, reason="QuoteMissing")
        if len(matches) == 2:
            return ReaderPublicationUnresolved(locator=locator, reason="QuoteAmbiguous")
        offset = matches[0]
    elif offset is None:
        offset = target_offset

    # An explicit point target can address an image-only part. Ordinary text
    # offsets prefer a rendering text extent, never an earlier zero-text part.
    if target_unit is not None and offset == target_offset:
        resolved = target_unit
    else:
        resolved = db.scalar(
            base.where(
                ReaderPublicationUnit.start_cp <= offset,
                ReaderPublicationUnit.end_cp > offset,
            )
            .order_by(ReaderPublicationUnit.start_cp.desc(), ReaderPublicationUnit.ordinal)
            .limit(1)
        )
        if resolved is None:
            resolved = db.scalar(
                base.where(
                    ReaderPublicationUnit.end_cp == offset,
                    ReaderPublicationUnit.end_cp > ReaderPublicationUnit.start_cp,
                )
                .order_by(ReaderPublicationUnit.ordinal.desc())
                .limit(1)
            )
        if resolved is None and offset == 0 and first.end_cp == 0:
            resolved = first
    if resolved is None or not resolved.start_cp <= offset <= resolved.end_cp:
        return ReaderPublicationUnresolved(locator=locator, reason="OffsetOutOfRange")
    member, previous, following = _unit_adjacency(db, resolved)
    return ReaderPublicationTextResolution(
        locator=locator,
        fragment_id=str(fragment_id),
        offset_cp=offset,
        local_offset_cp=offset - resolved.start_cp,
        unit_ref=member,
        ordinal=resolved.ordinal,
        previous_ref=previous,
        next_ref=following,
    )


def _unit_adjacency(
    db: Session, unit: ReaderPublicationUnit
) -> tuple[
    ReaderPublicationMemberRef, ReaderPublicationMemberRef | None, ReaderPublicationMemberRef | None
]:
    rows = db.execute(
        select(ReaderPublicationUnit.ordinal, ReaderPublicationArtifact)
        .join(
            ReaderPublicationArtifact,
            and_(
                ReaderPublicationArtifact.media_id == ReaderPublicationUnit.media_id,
                ReaderPublicationArtifact.generation == ReaderPublicationUnit.generation,
                ReaderPublicationArtifact.path == ReaderPublicationUnit.unit_key,
            ),
        )
        .where(
            ReaderPublicationUnit.media_id == unit.media_id,
            ReaderPublicationUnit.generation == unit.generation,
            ReaderPublicationUnit.ordinal.in_((unit.ordinal - 1, unit.ordinal, unit.ordinal + 1)),
        )
    )
    refs = {
        ordinal: ReaderPublicationMemberRef(
            key=member.path, bytes=member.size_bytes, sha256=member.sha256
        )
        for ordinal, member in rows
    }
    if unit.ordinal not in refs:
        raise AssertionError("Retained canonical unit has no immutable member")
    return refs[unit.ordinal], refs.get(unit.ordinal - 1), refs.get(unit.ordinal + 1)


def get_reader_publication_section_context(
    db: Session,
    *,
    viewer_id: UUID,
    media_id: UUID,
    generation: int,
    request: ReaderPublicationSectionContextRequest,
) -> ReaderPublicationSectionContext:
    """One captured point, its authored section, and two adjacent authored targets."""
    resolved = resolve_reader_publication_for_viewer(
        db,
        viewer_id=viewer_id,
        media_id=media_id,
        generation=generation,
        request=ReaderPublicationResolveRequest(
            target=ReaderPublicationLocatorTarget(locator=request.locator)
        ),
    )
    target = ReaderPublicationTarget
    source = ReaderPublicationUnit
    owned = (target.media_id == media_id, target.generation == generation)
    section_count = db.scalar(select(func.count()).select_from(target).where(*owned)) or 0
    if not isinstance(resolved, ReaderPublicationTextResolution):
        return ReaderPublicationSectionContext(
            current=None,
            previous=None,
            next=None,
            section_position=None,
            section_count=section_count,
        )
    rows = (
        select(target, source.fragment_id)
        .join(
            source,
            and_(
                source.media_id == target.media_id,
                source.generation == target.generation,
                source.unit_key == target.unit_key,
            ),
        )
        .where(*owned)
    )
    fragment_rows = rows.where(source.fragment_id == UUID(resolved.fragment_id))
    current = None
    if isinstance(request.locator, EpubReaderResumeState):
        exact = db.execute(
            fragment_rows.where(
                target.target_id == request.locator.target.section_id,
                target.href_path == request.locator.target.href_path,
                _section_contains_offset(resolved.offset_cp),
            )
        ).one_or_none()
        if exact is not None:
            current = exact
    if current is None:
        current = db.execute(
            fragment_rows.where(_section_contains_offset(resolved.offset_cp))
            .order_by(*OWNING_TARGET_ORDER)
            .limit(1)
        ).one_or_none()
    if current is None:
        current = db.execute(
            fragment_rows.order_by(target.ordinal, target.target_id).limit(1)
        ).one_or_none()
    if current is None:
        return ReaderPublicationSectionContext(
            current=None,
            previous=None,
            next=None,
            section_position=None,
            section_count=section_count,
        )
    section, fragment_id = current
    ordering = tuple_(target.ordinal, target.target_id)
    before = ordering < (section.ordinal, section.target_id)
    previous = db.execute(
        rows.where(before).order_by(target.ordinal.desc(), target.target_id.desc()).limit(1)
    ).one_or_none()
    following = db.execute(
        rows.where(ordering > (section.ordinal, section.target_id))
        .order_by(target.ordinal, target.target_id)
        .limit(1)
    ).one_or_none()
    position = db.scalar(select(func.count()).select_from(target).where(*owned, before)) or 0

    def summary(row: ReaderPublicationTarget, fragment: UUID) -> ReaderPublicationSectionSummary:
        return ReaderPublicationSectionSummary(
            section_id=row.target_id,
            label=row.label,
            ordinal=row.ordinal,
            unit_key=row.unit_key,
            fragment_id=str(fragment),
            start_offset=row.offset_cp,
            end_offset=row.end_cp,
            href_path=row.href_path,
            anchor_id=row.anchor_id,
        )

    return ReaderPublicationSectionContext(
        current=summary(section, fragment_id),
        previous=summary(*previous) if previous is not None else None,
        next=summary(*following) if following is not None else None,
        section_position=position + 1,
        section_count=section_count,
    )


def _resolve_source_range(
    db: Session,
    media_id: UUID,
    generation: int,
    media_kind: str,
    target: ReaderPublicationSourceRangeTarget,
) -> ReaderPublicationSourceRangeResolution | ReaderPublicationUnresolved:
    locator = target.locator
    if (
        str(locator.media_id) != str(media_id)
        or (locator.type == "web_text_offsets" and media_kind != "web_article")
        or (locator.type == "epub_fragment_offsets" and media_kind != "epub")
    ):
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST, "Source range does not describe this publication"
        )
    quote = locator.text_quote_selector
    if quote is None or not quote.get("exact"):
        return ReaderPublicationUnresolved(locator=None, reason="QuoteMissing")
    if (
        set(quote) - {"exact", "prefix", "suffix"}
        or not isinstance(quote["exact"], str)
        or any(
            quote.get(field) is not None and not isinstance(quote[field], str)
            for field in ("prefix", "suffix")
        )
    ):
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST, "Source range requires a complete text quote selector"
        )
    exact = quote["exact"]
    normalized = normalize_quote_text(exact)
    if not normalized:
        return ReaderPublicationUnresolved(locator=None, reason="QuoteMissing")
    try:
        fragment_id = UUID(str(locator.fragment_id))
    except ValueError:
        fragment_id = None
    start, end = locator.start_offset, locator.end_offset
    parameters = {
        "media_id": media_id,
        "generation": generation,
        "fragment_id": fragment_id,
        "start": start,
        "end": end,
        "exact": exact,
    }
    exact_range = fragment_id is not None and bool(
        db.scalar(
            text("""
        WITH pieces AS (
            SELECT greatest(start_cp, :start) AS first, least(end_cp, :end) AS last,
                   substring(canonical_text FROM greatest(start_cp, :start) - start_cp + 1
                       FOR least(end_cp, :end) - greatest(start_cp, :start)) AS body
            FROM reader_publication_units
            WHERE media_id = :media_id AND generation = :generation
              AND fragment_id = :fragment_id AND start_cp < :end AND end_cp > :start
              AND end_cp > start_cp
        )
        SELECT char_length(:exact) = :end - :start AND min(first) = :start AND max(last) = :end
           AND sum(last - first) = :end - :start
           AND bool_and(body COLLATE "C" = substring(:exact FROM first - :start + 1 FOR last - first) COLLATE "C")
        FROM pieces
    """),
            parameters,
        )
    )
    if not exact_range:
        match = db.execute(
            text(
                reader_publication_quote_matches_sql(
                    "SELECT CAST(:exact AS text) AS exact, CAST(:prefix AS text) AS prefix, CAST(:suffix AS text) AS suffix"
                )
            ),
            {
                "media_id": media_id,
                "generation": generation,
                "exact": normalized,
                "prefix": normalize_quote_text(quote.get("prefix") or ""),
                "suffix": normalize_quote_text(quote.get("suffix") or ""),
            },
        ).one()
        if match.hit_count != 1:
            return ReaderPublicationUnresolved(
                locator=None, reason="QuoteMissing" if match.hit_count == 0 else "QuoteAmbiguous"
            )
        if match.fragment_id is None or match.raw_start is None or match.raw_end is None:
            raise AssertionError("Text quote match lost its exact retained source map")
        fragment_id, start, end = match.fragment_id, match.raw_start, match.raw_end
    unit = db.scalar(
        select(ReaderPublicationUnit)
        .where(
            ReaderPublicationUnit.media_id == media_id,
            ReaderPublicationUnit.generation == generation,
            ReaderPublicationUnit.fragment_id == fragment_id,
            ReaderPublicationUnit.start_cp <= start,
            ReaderPublicationUnit.end_cp > start,
        )
        .order_by(ReaderPublicationUnit.ordinal)
        .limit(1)
    )
    if unit is None:
        raise AssertionError("Attested source range lost its starting unit")
    locations = ReaderTextLocations(
        text_offset=start, progression=None, total_progression=None, position=None
    )
    context = ReaderQuoteContext(quote=None, quote_prefix=None, quote_suffix=None)
    if media_kind == "web_article":
        resume = WebReaderResumeState(
            kind="web",
            target=ReaderFragmentTarget(fragment_id=str(fragment_id)),
            locations=locations,
            text=context,
        )
    else:
        targets = (
            select(ReaderPublicationTarget)
            .join(
                ReaderPublicationUnit,
                and_(
                    ReaderPublicationUnit.media_id == ReaderPublicationTarget.media_id,
                    ReaderPublicationUnit.generation == ReaderPublicationTarget.generation,
                    ReaderPublicationUnit.unit_key == ReaderPublicationTarget.unit_key,
                ),
            )
            .where(
                ReaderPublicationTarget.media_id == media_id,
                ReaderPublicationTarget.generation == generation,
                ReaderPublicationUnit.fragment_id == fragment_id,
            )
        )
        section = None
        if locator.type == "epub_fragment_offsets" and locator.section_id is not None:
            section = db.scalar(
                targets.where(
                    ReaderPublicationTarget.target_id == str(locator.section_id),
                    _section_contains_offset(start),
                )
            )
        if section is None:
            section = db.scalar(
                targets.where(_section_contains_offset(start))
                .order_by(*OWNING_TARGET_ORDER)
                .limit(1)
            )
        if section is None:
            section = db.scalar(
                targets.order_by(
                    ReaderPublicationTarget.ordinal, ReaderPublicationTarget.target_id
                ).limit(1)
            )
        if section is None or section.href_path is None:
            raise AssertionError("Attested EPUB source range has no retained default target")
        resume = EpubReaderResumeState(
            kind="epub",
            target=ReaderEpubTarget(
                section_id=section.target_id,
                href_path=section.href_path,
                anchor_id=section.anchor_id,
            ),
            locations=locations,
            text=context,
        )
    member, previous, following = _unit_adjacency(db, unit)
    return ReaderPublicationSourceRangeResolution(
        locator=resume,
        range=ReaderPublicationSourceRange(
            unit_key=member.key, fragment_id=str(fragment_id), start_cp=start, end_cp=end
        ),
        unit_ref=member,
        ordinal=unit.ordinal,
        previous_ref=previous,
        next_ref=following,
        fragment_id=str(fragment_id),
    )


def _section_contains_offset(offset: int):
    target = ReaderPublicationTarget
    return or_(
        and_(target.offset_cp <= offset, target.end_cp > offset),
        and_(target.offset_cp == offset, or_(target.end_cp.is_(None), target.end_cp == offset)),
    )
