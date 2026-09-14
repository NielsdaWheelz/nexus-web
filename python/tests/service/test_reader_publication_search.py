"""Stored-anchor search keeps full quote identity and original coordinates."""

from tempfile import TemporaryFile
from uuid import uuid4

from sqlalchemy import select, text
from sqlalchemy.orm import Session

from nexus.db.models import Media, PassageAnchor, ReaderPublicationSearchSource
from nexus.services.passage_anchors import compute_anchor_key
from nexus.services.reader_publication_search import (
    ReaderSearchPreparation,
    install_reader_search,
    prepare_pdf_reader_search,
    reader_passage_search_rows_sql,
    verify_reader_search,
)
from tests.testkit.auth import UserRecord


def test_retained_passage_search_keeps_long_quotes_whitespace_cuts_and_ambiguity(
    db_session: Session, test_user: UserRecord
) -> None:
    media_id, fragment_id, second_fragment, anchor_id = uuid4(), uuid4(), uuid4(), uuid4()
    db_session.add(
        Media(id=media_id, kind="web_article", title="Source", created_by_user_id=test_user.id)
    )
    exact = ("🧠é " * 300) + "FIN\\N"
    raw_quote = ("🧠é\t\n" * 300) + "FIN\\N"
    body = "prefix\n\n" + raw_quote + " \t suffix"
    expected_start = len("prefix\n\n")
    expected_end = expected_start + len(raw_quote)
    db_session.add(
        PassageAnchor(
            id=anchor_id,
            user_id=test_user.id,
            owner_scheme="media",
            owner_id=media_id,
            selector_version=1,
            anchor_key=compute_anchor_key(exact=exact, prefix="prefix", suffix="suffix"),
            selector={
                "quote": {"exact": exact, "prefix": "prefix", "suffix": "suffix"},
                "locator_hint": {
                    "kind": "text",
                    "fragment_id": str(uuid4()),
                    "start_offset": 0,
                    "end_offset": 1,
                },
            },
        )
    )
    db_session.flush()
    # Seventeen is a fixture chunk size chosen to cut whitespace runs and the
    # repeated Unicode quote. It is not a publication capacity qualification.
    for generation in (1, 2):
        with TemporaryFile(mode="w+b") as staged:
            preparation = ReaderSearchPreparation(staged, chunk_codepoints=17)
            for ordinal, identity, source in (
                (0, fragment_id, body),
                (1, second_fragment, body if generation == 2 else "unrelated"),
            ):
                for offset in range(0, len(source), 17):
                    preparation.append(
                        source_ordinal=ordinal,
                        fragment_id=identity,
                        raw_start=offset,
                        text=source[offset : offset + 17],
                    )
            install_reader_search(
                db_session, media_id=media_id, generation=generation, prepared=preparation.finish()
            )
            with TemporaryFile(mode="w+b") as recut:
                verification = ReaderSearchPreparation(recut, chunk_codepoints=11)
                for ordinal, identity, source in (
                    (0, fragment_id, body),
                    (1, second_fragment, body if generation == 2 else "unrelated"),
                ):
                    for offset in range(0, len(source), 11):
                        verification.append(
                            source_ordinal=ordinal,
                            fragment_id=identity,
                            raw_start=offset,
                            text=source[offset : offset + 11],
                        )
                verify_reader_search(
                    db_session,
                    media_id=media_id,
                    generation=generation,
                    prepared=verification.finish(),
                )
    statement = text(reader_passage_search_rows_sql("SELECT CAST(:anchor_id AS uuid) AS anchor_id"))
    params = {
        "viewer_id": test_user.id,
        "media_id": media_id,
        "generation": 1,
        "anchor_id": anchor_id,
    }
    unique = db_session.execute(statement, params).mappings().one()
    assert unique["hit_count"] == 1
    assert (unique["fragment_id"], unique["raw_start"], unique["raw_end"]) == (
        fragment_id,
        expected_start,
        expected_end,
    )
    assert unique["page_number"] is None
    normalized = db_session.scalar(
        select(ReaderPublicationSearchSource.normalized_text).where(
            ReaderPublicationSearchSource.media_id == media_id,
            ReaderPublicationSearchSource.generation == 1,
            ReaderPublicationSearchSource.source_ordinal == 0,
        )
    )
    assert normalized == "prefix " + exact + " suffix"
    ambiguous = db_session.execute(statement, {**params, "generation": 2}).mappings().one()
    assert ambiguous["hit_count"] == 2
    assert db_session.execute(statement, {**params, "viewer_id": uuid4()}).all() == []
    assert db_session.get(PassageAnchor, anchor_id).selector["quote"]["exact"] == exact


def test_retained_pdf_search_uses_page_boundaries_and_optional_context_spaces(
    db_session: Session, test_user: UserRecord
) -> None:
    media_id, anchor_id = uuid4(), uuid4()
    db_session.add(
        Media(id=media_id, kind="pdf", title="PDF source", created_by_user_id=test_user.id)
    )
    db_session.add(
        PassageAnchor(
            id=anchor_id,
            user_id=test_user.id,
            owner_scheme="media",
            owner_id=media_id,
            selector_version=1,
            anchor_key=compute_anchor_key(exact="QUOTED", prefix="before", suffix="after"),
            selector={
                "quote": {"exact": "QUOTED", "prefix": "before", "suffix": "after"},
                "locator_hint": {"kind": "pdf", "page_number": 99},
            },
        )
    )
    db_session.flush()
    with TemporaryFile(mode="w+b") as staged:
        prepared = prepare_pdf_reader_search(
            staged,
            plain_text="first page\n\nbeforeQUOTED\n\nafter",
            page_spans=((1, 0, 10), (2, 12, 31)),
            page_heights=((1, 800.0), (2, 900.0)),
            page_count=2,
            chunk_codepoints=7,
        )
        install_reader_search(db_session, media_id=media_id, generation=7, prepared=prepared)
    row = (
        db_session.execute(
            text(reader_passage_search_rows_sql("SELECT CAST(:anchor_id AS uuid) AS anchor_id")),
            {
                "viewer_id": test_user.id,
                "media_id": media_id,
                "generation": 7,
                "anchor_id": anchor_id,
            },
        )
        .mappings()
        .one()
    )
    assert row["hit_count"] == 1
    assert (row["fragment_id"], row["raw_start"], row["raw_end"], row["page_number"]) == (
        None,
        None,
        None,
        2,
    )


def test_pdf_passage_nfc_keeps_raw_geometry_text_and_attests_only_page(
    db_session: Session, test_user: UserRecord
) -> None:
    # Independent Unicode canonical-equivalence cases: composition, reordered
    # marks, Hangul composition, and canonical expansion. One-codepoint staging
    # cuts deliberately bisect each cluster; they are not a release profile.
    for authored, exact in (
        ("cafe\u0301", "café"),
        ("a\u0315\u0300", "à\u0315"),
        ("\u1100\u1161\u11a8", "각"),
        ("\u0344", "\u0308\u0301"),
    ):
        media_id, anchor_id = uuid4(), uuid4()
        raw = "before\n\n" + authored + "\n\nafter"
        last_page_start = 10 + len(authored)
        db_session.add(
            Media(id=media_id, kind="pdf", title="Raw PDF", created_by_user_id=test_user.id)
        )
        db_session.add(
            PassageAnchor(
                id=anchor_id,
                user_id=test_user.id,
                owner_scheme="media",
                owner_id=media_id,
                selector_version=1,
                anchor_key=compute_anchor_key(exact=exact, prefix="before", suffix="after"),
                selector={"quote": {"exact": exact, "prefix": "before", "suffix": "after"}},
            )
        )
        db_session.flush()
        with TemporaryFile(mode="w+b") as staged:
            prepared = prepare_pdf_reader_search(
                staged,
                plain_text=raw,
                page_spans=((1, 0, 6), (2, 8, 8 + len(authored)), (3, last_page_start, len(raw))),
                page_heights=((1, 800.0), (2, 900.0), (3, 800.0)),
                page_count=3,
                chunk_codepoints=1,
            )
            install_reader_search(db_session, media_id=media_id, generation=7, prepared=prepared)
            verify_reader_search(db_session, media_id=media_id, generation=7, prepared=prepared)
        result = (
            db_session.execute(
                text(
                    reader_passage_search_rows_sql("SELECT CAST(:anchor_id AS uuid) AS anchor_id")
                ),
                {
                    "viewer_id": test_user.id,
                    "media_id": media_id,
                    "generation": 7,
                    "anchor_id": anchor_id,
                },
            )
            .mappings()
            .one()
        )
        assert result["hit_count"] == 1
        assert result["page_number"] == 2
        assert result["raw_start"] is None and result["raw_end"] is None
        assert (
            db_session.scalar(
                select(ReaderPublicationSearchSource.canonical_text).where(
                    ReaderPublicationSearchSource.media_id == media_id
                )
            )
            == raw
        )


def test_pdf_passage_navigation_uses_attested_beginning_page_across_page_cuts(
    db_session: Session, test_user: UserRecord
) -> None:
    for raw, exact, spans, expected_page in (
        ("left\n\nright", "left right", ((1, 0, 4), (2, 6, 11)), 1),
        ("e\u0301", "é", ((1, 0, 1), (2, 1, 2)), None),
    ):
        media_id, anchor_id = uuid4(), uuid4()
        db_session.add(
            Media(id=media_id, kind="pdf", title="Page cut", created_by_user_id=test_user.id)
        )
        db_session.add(
            PassageAnchor(
                id=anchor_id,
                user_id=test_user.id,
                owner_scheme="media",
                owner_id=media_id,
                selector_version=1,
                anchor_key=compute_anchor_key(exact=exact, prefix="", suffix=""),
                selector={"quote": {"exact": exact}},
            )
        )
        db_session.flush()
        with TemporaryFile(mode="w+b") as staged:
            prepared = prepare_pdf_reader_search(
                staged,
                plain_text=raw,
                page_spans=spans,
                page_heights=((1, 800.0), (2, 900.0)),
                page_count=2,
                chunk_codepoints=1,
            )
            install_reader_search(db_session, media_id=media_id, generation=1, prepared=prepared)
            verify_reader_search(db_session, media_id=media_id, generation=1, prepared=prepared)
        hit = (
            db_session.execute(
                text(
                    reader_passage_search_rows_sql("SELECT CAST(:anchor_id AS uuid) AS anchor_id")
                ),
                {
                    "viewer_id": test_user.id,
                    "media_id": media_id,
                    "generation": 1,
                    "anchor_id": anchor_id,
                },
            )
            .mappings()
            .one()
        )
        assert hit["hit_count"] == 1
        assert hit["page_number"] == expected_page
        assert hit["raw_start"] is None and hit["raw_end"] is None
