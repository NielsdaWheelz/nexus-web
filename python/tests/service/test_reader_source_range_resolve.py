"""Historical source activation needs a complete selected-source quote attestation."""

from tempfile import TemporaryFile
from uuid import uuid4

import pytest
from sqlalchemy.orm import Session

from nexus.db.models import Media, ReaderPublicationTarget
from nexus.schemas.reader_publication import ReaderPublicationResolveRequest
from nexus.services.reader_publication_resolve import resolve_reader_publication_for_viewer
from nexus.services.reader_publication_search import ReaderSearchPreparation, install_reader_search
from tests.testkit.auth import UserRecord
from tests.testkit.reader_publication import seed_retained_text


@pytest.mark.parametrize("kind", ["web_article", "epub"])
def test_source_activation_checks_full_range_then_uniquely_reanchors_in_selected_generation(
    db_session: Session,
    test_user: UserRecord,
    kind: str,
) -> None:
    quote = "é🧠" * 700
    source = "before\n" + quote + "\nafter"
    media_id, fragment_id = seed_retained_text(
        db_session,
        test_user,
        (source[:500], "", source[500:1000], source[1000:]),
        (0, len(source)),
    )
    media = db_session.get(Media, media_id)
    assert media is not None
    media.kind = kind
    if kind == "epub":
        db_session.add(
            ReaderPublicationTarget(
                media_id=media_id,
                generation=1,
                target_id="authored chapter",
                ordinal=0,
                label="Authored chapter",
                unit_key="units/0.json",
                offset_cp=0,
                end_cp=len(source),
                href_path="Original Chapter.xhtml",
                href_pathname="/Original%20Chapter.xhtml",
                anchor_id="opening",
            )
        )
    db_session.flush()
    with TemporaryFile(mode="w+b") as staged:
        preparation = ReaderSearchPreparation(staged, chunk_codepoints=37)
        for offset in range(0, len(source), 37):
            preparation.append(
                source_ordinal=0,
                fragment_id=fragment_id,
                raw_start=offset,
                text=source[offset : offset + 37],
            )
        install_reader_search(
            db_session, media_id=media_id, generation=1, prepared=preparation.finish()
        )
    locator = {
        "type": "web_text_offsets" if kind == "web_article" else "epub_fragment_offsets",
        "media_id": str(media_id),
        "fragment_id": str(fragment_id),
        "start_offset": 7,
        "end_offset": 7 + len(quote),
        "text_quote_selector": {"exact": quote, "prefix": "before", "suffix": "after"},
    }
    args = dict(viewer_id=test_user.id, media_id=media_id, generation=1)
    request = ReaderPublicationResolveRequest(target={"kind": "SourceRange", "locator": locator})
    exact = resolve_reader_publication_for_viewer(db_session, **args, request=request)
    assert exact.kind == "SourceRange"
    assert (exact.range.fragment_id, exact.range.start_cp, exact.range.end_cp) == (
        str(fragment_id),
        7,
        1407,
    )
    assert exact.range.unit_key == exact.unit_ref.key == "units/0.json"
    assert exact.locator.locations.text_offset == 7
    if kind == "epub":
        assert exact.locator.target.section_id == "authored chapter"
        assert exact.locator.target.href_path == "Original Chapter.xhtml"
    stale = {**locator, "fragment_id": str(uuid4()), "start_offset": 0, "end_offset": 1}
    repaired = resolve_reader_publication_for_viewer(
        db_session,
        **args,
        request=ReaderPublicationResolveRequest(target={"kind": "SourceRange", "locator": stale}),
    )
    assert repaired == exact, (
        "a missing old hint must not conceal a uniquely locatable complete quote"
    )
    missing = resolve_reader_publication_for_viewer(
        db_session,
        **args,
        request=ReaderPublicationResolveRequest(
            target={"kind": "SourceRange", "locator": {**locator, "text_quote_selector": None}}
        ),
    )
    assert (missing.kind, missing.reason, missing.locator) == ("Unresolved", "QuoteMissing", None)
    changed = resolve_reader_publication_for_viewer(
        db_session, viewer_id=test_user.id, media_id=media_id, generation=2, request=request
    )
    assert (changed.kind, changed.reason) == ("Unresolved", "QuoteMissing")


def test_source_activation_preserves_ambiguity_instead_of_borrowing_an_unverified_hint(
    db_session: Session,
    test_user: UserRecord,
) -> None:
    source = "cat cat"
    media_id, fragment_id = seed_retained_text(db_session, test_user, ("cat ", "cat"), (0, 3, 4, 7))
    with TemporaryFile(mode="w+b") as staged:
        preparation = ReaderSearchPreparation(staged, chunk_codepoints=3)
        for offset in range(0, len(source), 3):
            preparation.append(
                source_ordinal=0,
                fragment_id=fragment_id,
                raw_start=offset,
                text=source[offset : offset + 3],
            )
        install_reader_search(
            db_session, media_id=media_id, generation=1, prepared=preparation.finish()
        )
    locator = {
        "type": "web_text_offsets",
        "media_id": str(media_id),
        "fragment_id": str(fragment_id),
        "start_offset": 1,
        "end_offset": 4,
        "text_quote_selector": {"exact": "cat"},
    }
    result = resolve_reader_publication_for_viewer(
        db_session,
        viewer_id=test_user.id,
        media_id=media_id,
        generation=1,
        request=ReaderPublicationResolveRequest(target={"kind": "SourceRange", "locator": locator}),
    )
    assert (result.kind, result.reason, result.locator) == ("Unresolved", "QuoteAmbiguous", None)
    locator.update(start_offset=4, end_offset=7)
    exact = resolve_reader_publication_for_viewer(
        db_session,
        viewer_id=test_user.id,
        media_id=media_id,
        generation=1,
        request=ReaderPublicationResolveRequest(target={"kind": "SourceRange", "locator": locator}),
    )
    assert exact.kind == "SourceRange" and exact.range.start_cp == 4
    assert exact.range.unit_key == "units/1.json"


def test_source_range_section_membership_is_half_open_and_null_end_is_a_point(
    db_session: Session,
    test_user: UserRecord,
) -> None:
    from nexus.schemas.reader_publication import ReaderPublicationSectionContextRequest
    from nexus.services.reader_publication_resolve import get_reader_publication_section_context

    media_id, fragment_id = seed_retained_text(
        db_session, test_user, ("one two end",), (0, 3, 4, 7, 8, 11)
    )
    media = db_session.get(Media, media_id)
    assert media is not None
    media.kind = "epub"
    for ordinal, section_id, start, end in (
        (0, "first", 0, 4),
        (1, "point", 2, None),
        (2, "second", 4, 11),
    ):
        db_session.add(
            ReaderPublicationTarget(
                media_id=media_id,
                generation=1,
                target_id=section_id,
                ordinal=ordinal,
                label=section_id,
                unit_key="units/0.json",
                offset_cp=start,
                end_cp=end,
                href_path="chapter.xhtml",
                href_pathname="/chapter.xhtml",
                anchor_id=section_id,
            )
        )
    db_session.flush()
    for requested in ("first", "point"):
        locator = {
            "type": "epub_fragment_offsets",
            "media_id": str(media_id),
            "fragment_id": str(fragment_id),
            "section_id": requested,
            "start_offset": 4,
            "end_offset": 7,
            "text_quote_selector": {"exact": "two"},
        }
        resolved = resolve_reader_publication_for_viewer(
            db_session,
            viewer_id=test_user.id,
            media_id=media_id,
            generation=1,
            request=ReaderPublicationResolveRequest(
                target={"kind": "SourceRange", "locator": locator}
            ),
        )
        assert resolved.kind == "SourceRange" and resolved.locator.target.section_id == "second"
        context_locator = resolved.locator.model_copy(
            update={
                "target": resolved.locator.target.model_copy(
                    update={"section_id": requested, "anchor_id": requested}
                )
            }
        )
        context = get_reader_publication_section_context(
            db_session,
            viewer_id=test_user.id,
            media_id=media_id,
            generation=1,
            request=ReaderPublicationSectionContextRequest(locator=context_locator),
        )
        assert context.current is not None and context.current.section_id == "second"
