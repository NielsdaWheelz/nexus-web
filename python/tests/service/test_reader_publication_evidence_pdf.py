"""Explicit evidence activation keeps retained PDF geometry and source identity."""

from uuid import uuid4

import pytest
from sqlalchemy import Engine, select

from nexus.db.models import (
    HighlightPdfAnchor,
    ReaderPublicationApparatusItem,
    ReaderPublicationSearchSource,
)
from nexus.schemas.reader_publication_evidence import (
    ReaderEvidenceBucketRequest,
    ReaderEvidenceLocationRequest,
    ReaderEvidenceOverviewRequest,
)
from nexus.services.reader_publication_evidence import (
    get_reader_publication_evidence_overview,
    list_reader_publication_evidence_bucket,
    locate_reader_publication_evidence,
)
from tests.testkit.reader_pdf import published_pdf_sources
from tests.testkit.reader_publication import FIXTURE_LIMITS


def test_evidence_pdf_activation_keeps_old_source_quads_and_unavailable_geometry(
    engine: Engine,
) -> None:
    with published_pdf_sources(engine) as fixture:
        args = dict(viewer_id=fixture.user_id, media_id=fixture.media_id, limits=FIXTURE_LIMITS)
        with fixture.factory() as db:
            old = locate_reader_publication_evidence(
                db,
                **args,
                generation=1,
                request=ReaderEvidenceLocationRequest(fact_id=f"highlight:{fixture.highlights[0]}"),
            )
            assert old.location.kind == "PdfGeometry"
            assert old.location.source_sha256 == fixture.digests[0], (
                "evidence activation borrowed another PDF source"
            )
            assert [quad.model_dump() for quad in old.location.quads] == [fixture.quad.model_dump()]
            changed = locate_reader_publication_evidence(
                db, **args, generation=2, request=ReaderEvidenceLocationRequest(fact_id=old.fact_id)
            )
            assert changed.location.model_dump() == {"kind": "Unavailable", "reason": "Stale"}
            renamed = locate_reader_publication_evidence(
                db,
                **args,
                generation=3,
                request=ReaderEvidenceLocationRequest(fact_id=f"highlight:{fixture.highlights[1]}"),
            )
            assert renamed.location.source_sha256 == fixture.digests[1]
            db.get(HighlightPdfAnchor, fixture.highlights[0]).source_sha256 = None
            db.flush()
            legacy = locate_reader_publication_evidence(
                db, **args, generation=1, request=ReaderEvidenceLocationRequest(fact_id=old.fact_id)
            )
            assert legacy.location.model_dump() == {
                "kind": "Unavailable",
                "reason": "SourceUnverified",
            }
            # Authored quad ordering is untouched. Overview origin is the minimum
            # of ALL vertices; its first y1 intentionally is not the top point.
            item_id = uuid4()
            quad = dict(x1=12, y1=40, x2=25, y2=5, x3=20, y3=45, x4=8, y4=10)
            db.add(
                ReaderPublicationApparatusItem(
                    media_id=fixture.media_id,
                    generation=1,
                    item_id=item_id,
                    ordinal=0,
                    stable_key="original-note",
                    sort_key="original-note",
                    kind="footnote",
                    label="note",
                    body_text="authored source note",
                    confidence="exact",
                    locator_status="resolved",
                    locator={
                        "type": "pdf_page_geometry",
                        "media_id": str(fixture.media_id),
                        "page_number": 1,
                        "quads": [quad],
                    },
                )
            )
            db.flush()
            exact = locate_reader_publication_evidence(
                db,
                **args,
                generation=1,
                request=ReaderEvidenceLocationRequest(fact_id="source-reference:original-note"),
            )
            assert (
                exact.location.kind == "PdfGeometry"
                and exact.location.source_sha256 == fixture.digests[0]
            )
            from nexus.schemas.reader_publication_evidence import ReaderEvidenceGutterRequest
            from nexus.services.reader_publication_evidence import list_reader_publication_gutter

            window = {
                "kind": "Pdf",
                "pages": [
                    {"page": 1, "rect": {"left": 0, "top": 4, "right": 100, "bottom": 6}},
                    {"page": 1, "rect": {"left": 0, "top": 5, "right": 100, "bottom": 7}},
                ],
            }
            gutter_request = ReaderEvidenceGutterRequest(
                window=window,
                kinds=("SourceReference", "Highlight"),
                include_stances=False,
                after=None,
                limit=24,
            )
            gutter = list_reader_publication_gutter(
                db, **args, generation=1, request=gutter_request
            )
            assert gutter.total_count == 1 and gutter.next_cursor is None
            assert gutter.items[0].location == exact.location
            assert gutter.items[0].fact_id == "source-reference:original-note"
            outside = list_reader_publication_gutter(
                db,
                **args,
                generation=1,
                request=gutter_request.model_copy(
                    update={
                        "window": type(gutter_request.window).model_validate(
                            {
                                "kind": "Pdf",
                                "pages": [
                                    {
                                        "page": 1,
                                        "rect": {"left": 0, "top": 0, "right": 100, "bottom": 1},
                                    }
                                ],
                            }
                        )
                    }
                ),
            )
            assert outside.total_count == 0 and outside.items == ()
            assert [value.model_dump() for value in exact.location.quads] == [quad]
            source = db.scalar(
                select(ReaderPublicationSearchSource).where(
                    ReaderPublicationSearchSource.media_id == fixture.media_id,
                    ReaderPublicationSearchSource.generation == 1,
                )
            )
            assert source.pdf_page_heights == [
                842.0
            ]  # Explicit dimensions in the source PDF fixture.
            source.pdf_page_spans = [None]  # Image-only/absent text does not erase its height.
            db.flush()
            markers = list_reader_publication_evidence_bucket(
                db,
                **args,
                generation=1,
                request=ReaderEvidenceBucketRequest(
                    bucket_count=1, index=0, kinds=("SourceReference",), after=None, limit=10
                ),
            )
            assert len(markers.items) == 1 and markers.items[0].position == pytest.approx(5 / 842)
            source.pdf_page_heights = [None]
            db.flush()
            unavailable = get_reader_publication_evidence_overview(
                db,
                **args,
                generation=1,
                request=ReaderEvidenceOverviewRequest(bucket_count=1, kinds=("SourceReference",)),
            )
            assert (
                unavailable.buckets == () and unavailable.unavailable_counts.source_references == 1
            )
            db.rollback()
