"""Selected PDF geometry never borrows another binary's source identity."""

import pytest
from sqlalchemy import Engine, select

from nexus.db.models import Highlight, ReaderPublicationSearchSource
from nexus.errors import ApiError, ApiErrorCode
from nexus.schemas.highlights import (
    CreatePdfHighlightRequest,
    PdfAnchorUpdateRequest,
    PdfQuadIn,
    UpdateHighlightRequest,
)
from nexus.services.highlights import (
    get_highlight,
    get_highlight_reader_target,
    highlight_action_facts,
    update_highlight,
)
from nexus.services.library_entries import delete_all_entries_for_media
from nexus.services.locator_resolver import (
    resolve_highlight_reader_target,
    resolve_highlight_reader_target_disposition,
)
from nexus.services.pdf_highlights import create_pdf_highlight, list_pdf_highlights
from tests.testkit.reader_pdf import published_pdf_sources
from tests.testkit.reader_publication import FIXTURE_LIMITS


def test_pdf_selection_paint_and_reattachment_remain_bound_to_selected_source(
    engine: Engine,
) -> None:
    with published_pdf_sources(engine) as fixture:
        factory, user_id, media_id, quad, digests, highlights = (
            fixture.factory,
            fixture.user_id,
            fixture.media_id,
            fixture.quad,
            fixture.digests,
            fixture.highlights,
        )
        with factory() as db:
            renamed_page = list_pdf_highlights(
                db, user_id, media_id, 1, reader_generation=3, limits=FIXTURE_LIMITS
            )
            assert renamed_page.source_sha256 == digests[1]
            assert [item.id for item in renamed_page.highlights] == [highlights[1]], (
                "pdf paint crossed its selected source"
            )
        with factory() as db:
            # Same page/quads on different binary sources are distinct selections.
            for generation in (1, 2):
                page = list_pdf_highlights(
                    db, user_id, media_id, 1, reader_generation=generation, limits=FIXTURE_LIMITS
                )
                assert page.source_sha256 == digests[generation - 1]
                assert [item.id for item in page.highlights] == [highlights[generation - 1]], (
                    "pdf paint crossed its selected source"
                )
            assert resolve_highlight_reader_target(db, highlight_id=highlights[0]) is None
            assert (
                resolve_highlight_reader_target_disposition(db, highlight_id=highlights[0]).status
                == "source_unverified"
            ), "a superseded binary is unattributable provenance, not a missing highlight"
            assert (
                get_highlight_reader_target(db, viewer_id=user_id, highlight_id=highlights[0]).kind
                == "UnresolvedSource"
            ), "a readable highlight with unattributable provenance is not a 404"
            legacy = db.get(Highlight, highlights[0])
            legacy.pdf_anchor.source_sha256 = None
            db.commit()
            assert (
                resolve_highlight_reader_target_disposition(db, highlight_id=legacy.id).status
                == "source_unverified"
            ), "an unattributed anchor is unattributable provenance, not a missing highlight"
            assert (
                get_highlight_reader_target(db, viewer_id=user_id, highlight_id=legacy.id).kind
                == "UnresolvedSource"
            ), "an unattributed anchor is not a 404 either"
            detail = get_highlight(db, user_id, legacy.id)
            assert detail.anchor.source_sha256 is None and detail.exact == "original"
            assert highlight_action_facts(db, viewer_id=user_id, highlight_ids=[legacy.id])[
                legacy.id
            ].edit_bounds_applicable
            assert (
                list_pdf_highlights(
                    db, user_id, media_id, 1, reader_generation=1, limits=FIXTURE_LIMITS
                ).highlights
                == ()
            )
            # Explicit selection stamps the old source even though the current text differs.
            updated = update_highlight(
                db,
                user_id,
                legacy.id,
                UpdateHighlightRequest(
                    anchor=PdfAnchorUpdateRequest(reader_generation=1, page_number=1, quads=[quad]),
                    exact="original",
                ),
            )
            assert updated.anchor.source_sha256 == digests[0]
            assert db.get(Highlight, legacy.id).pdf_anchor.plain_text_match_status == "unique"
            assert (
                list_pdf_highlights(
                    db, user_id, media_id, 1, reader_generation=1, limits=FIXTURE_LIMITS
                )
                .highlights[0]
                .id
                == legacy.id
            )
            delete_all_entries_for_media(db, media_id)
            db.commit()
            with pytest.raises(ApiError) as revoked:
                create_pdf_highlight(
                    db,
                    user_id,
                    media_id,
                    CreatePdfHighlightRequest(
                        reader_generation=1,
                        page_number=1,
                        quads=[quad],
                        exact="original",
                        color="yellow",
                    ),
                )
            assert revoked.value.code == ApiErrorCode.E_MEDIA_NOT_FOUND, (
                "revoked media must mask existence, not surface another owned failure"
            )


def test_pdf_write_time_match_names_absolute_offsets_and_context(engine: Engine) -> None:
    """Page-slice matching still reports document offsets and 64-code-point context.

    The write path reads only the selected page extent and the two context
    windows, never the whole retained canonical text, so its offsets stay
    absolute and its ambiguity verdict stays page-local.
    """
    with published_pdf_sources(engine) as fixture:
        factory, user_id, media_id = fixture.factory, fixture.user_id, fixture.media_id
        with factory() as db:
            canonical = db.scalar(
                select(ReaderPublicationSearchSource.canonical_text).where(
                    ReaderPublicationSearchSource.media_id == media_id,
                    ReaderPublicationSearchSource.generation == 2,
                    ReaderPublicationSearchSource.source_ordinal == 0,
                    ReaderPublicationSearchSource.fragment_id.is_(None),
                )
            )
            assert canonical is not None
            assert canonical.count("place") == 1 and canonical.count("e") > 1
            created = {}
            for index, exact in enumerate(("place", "e", "sphinx")):
                edge = 30.0 + index * 20
                created[exact] = create_pdf_highlight(
                    db,
                    user_id,
                    media_id,
                    CreatePdfHighlightRequest(
                        reader_generation=2,
                        page_number=1,
                        quads=[
                            PdfQuadIn(
                                x1=edge,
                                y1=edge,
                                x2=edge + 10,
                                y2=edge,
                                x3=edge + 10,
                                y3=edge + 10,
                                x4=edge,
                                y4=edge + 10,
                            )
                        ],
                        exact=exact,
                        color="yellow",
                    ),
                ).id
        with factory() as db:
            unique = db.get(Highlight, created["place"])
            start = unique.pdf_anchor.plain_text_start_offset
            finish = unique.pdf_anchor.plain_text_end_offset
            assert unique.pdf_anchor.plain_text_match_status == "unique"
            assert start is not None and finish is not None
            assert canonical[start:finish] == "place"
            assert unique.prefix == canonical[max(0, start - 64) : start]
            assert unique.suffix == canonical[finish : finish + 64]
            for exact, status in (("e", "ambiguous"), ("sphinx", "no_match")):
                other = db.get(Highlight, created[exact])
                assert other.pdf_anchor.plain_text_match_status == status
                assert other.pdf_anchor.plain_text_start_offset is None
                assert other.pdf_anchor.plain_text_end_offset is None
                assert other.prefix == "" and other.suffix == ""
