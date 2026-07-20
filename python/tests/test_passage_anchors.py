"""Passage-anchor identity gold vectors (universal-link-authoring AC7).

Covers canonical quote normalization, anchor_key stability across caller
context-window and locator-hint changes, empty-quote and ambiguous refusals
(never geometry-disambiguated), boundary prefix/suffix recomputation, and live
current-locator resolution.
"""

from __future__ import annotations

import hashlib
from uuid import uuid4

import pytest
from sqlalchemy.orm import Session

from nexus.db.models import Fragment, NoteBlock, PassageAnchor
from nexus.errors import ApiError, ApiErrorCode, InvalidRequestError
from nexus.services import passage_anchors
from nexus.services.locator_resolver import resolve_passage_selector
from nexus.services.text_quote import QuoteStatus, find_quote_candidates, normalize_for_match
from tests.factories import (
    create_pdf_media_with_text,
    create_test_fragment,
    create_test_media,
    get_user_default_library,
)

FIXTURE_TEXT = (
    "Alpha bravo charlie delta echo foxtrot golf hotel india juliet "
    "kilo lima mike november oscar papa quebec romeo sierra tango "
    "uniform victor whiskey xray yankee zulu."
)


def _materialize(db: Session, user_id, owner_id, **kwargs) -> PassageAnchor:
    return passage_anchors.materialize_or_reuse(
        db,
        user_id=user_id,
        owner_scheme=kwargs.pop("owner_scheme", "media"),
        owner_id=owner_id,
        **kwargs,
    )


@pytest.mark.unit
class TestQuoteNormalization:
    def test_nfc_and_whitespace_equality(self):
        composed = "Café society"
        decomposed = "Café  society"
        assert passage_anchors.normalize_quote_text(composed) == "Café society"
        assert passage_anchors.normalize_quote_text(decomposed) == "Café society"

    def test_newlines_and_unicode_whitespace_collapse(self):
        assert passage_anchors.normalize_quote_text("a\r\nb") == "a b"
        assert passage_anchors.normalize_quote_text("a\rb") == "a b"
        assert passage_anchors.normalize_quote_text(" \ta 　 b  ") == "a b"

    def test_anchor_key_pins_canonical_json(self):
        # Sorted keys, compact separators, UTF-8, ensure_ascii=False — the
        # exact encoding migration 0184's inline helper must reproduce.
        expected = hashlib.sha256('{"exact":"é x","prefix":"a","suffix":"b"}'.encode()).hexdigest()
        assert passage_anchors.compute_anchor_key(exact="é x", prefix="a", suffix="b") == expected

    def test_anchor_key_varies_with_context(self):
        base = passage_anchors.compute_anchor_key(exact="a", prefix="b", suffix="c")
        assert passage_anchors.compute_anchor_key(exact="a", prefix="B", suffix="c") != base


@pytest.mark.unit
class TestCanonicalLocatorHint:
    def test_integers_stay_integers(self):
        hint = passage_anchors.canonical_locator_hint(
            {"kind": "text", "fragment_id": "f-1", "start_offset": 5.0, "end_offset": 9}
        )
        assert hint == {"kind": "text", "fragment_id": "f-1", "start_offset": 5, "end_offset": 9}

    def test_non_integral_geometry_is_fixed_decimal_string(self):
        quad = {"x1": 1.5, "y1": 2.0, "x2": 0.00001, "y2": 3, "x3": 4, "y3": 5, "x4": 6, "y4": 7}
        hint = passage_anchors.canonical_locator_hint(
            {"kind": "pdf", "page_number": 2, "quads": [quad]}
        )
        assert hint is not None
        assert hint["quads"][0] == {
            "x1": "1.5",
            "y1": 2,
            "x2": "0.00001",
            "y2": 3,
            "x3": 4,
            "y3": 5,
            "x4": 6,
            "y4": 7,
        }

    def test_invalid_hints_refused(self):
        with pytest.raises(InvalidRequestError):
            passage_anchors.canonical_locator_hint({"kind": "orbit"})
        with pytest.raises(InvalidRequestError):
            passage_anchors.canonical_locator_hint(
                {"kind": "time", "t_start_ms": -1, "t_end_ms": 5}
            )
        with pytest.raises(InvalidRequestError):
            passage_anchors.canonical_locator_hint(
                {"kind": "text", "start_offset": 1.5, "end_offset": 9}
            )


@pytest.mark.unit
class TestNormalizedMatching:
    def test_raw_offsets_span_collapsed_whitespace(self):
        normalized = normalize_for_match("foo\n\nbar baz")
        assert normalized.text == "foo bar baz"
        candidates = find_quote_candidates(normalized, exact="foo bar", prefix="", suffix="")
        assert len(candidates) == 1
        assert (candidates[0].raw_start, candidates[0].raw_end) == (0, 8)

    def test_context_narrowing_is_seam_tolerant(self):
        normalized = normalize_for_match("red one two blue and later green one two yellow")
        by_red = find_quote_candidates(normalized, exact="one two", prefix="red", suffix="")
        by_green = find_quote_candidates(normalized, exact="one two", prefix="green", suffix="")
        assert len(by_red) == 1
        assert len(by_green) == 1
        assert by_red[0].raw_start != by_green[0].raw_start


@pytest.mark.integration
class TestMaterializeOrReuse:
    def test_nfc_and_whitespace_variants_reuse_one_anchor(
        self, db_session: Session, bootstrapped_user
    ):
        media_id = create_test_media(db_session)
        create_test_fragment(db_session, media_id, content="Café society gathers here nightly")
        first = _materialize(db_session, bootstrapped_user, media_id, exact="Café society")
        second = _materialize(db_session, bootstrapped_user, media_id, exact="Café  society")
        assert first.id == second.id
        assert first.selector["quote"]["exact"] == "Café society"

    def test_caller_context_window_length_reuses_one_anchor(
        self, db_session: Session, bootstrapped_user
    ):
        media_id = create_test_media(db_session)
        create_test_fragment(db_session, media_id, content=FIXTURE_TEXT)
        start = FIXTURE_TEXT.index("kilo lima mike")
        short = _materialize(
            db_session,
            bootstrapped_user,
            media_id,
            exact="kilo lima mike",
            prefix=FIXTURE_TEXT[start - 10 : start],
            suffix=FIXTURE_TEXT[start + len("kilo lima mike") :][:10],
        )
        long = _materialize(
            db_session,
            bootstrapped_user,
            media_id,
            exact="kilo lima mike",
            prefix=FIXTURE_TEXT[start - 40 : start],
            suffix=FIXTURE_TEXT[start + len("kilo lima mike") :][:40],
        )
        assert short.id == long.id

    def test_changed_text_hint_offsets_reuse_one_anchor(
        self, db_session: Session, bootstrapped_user
    ):
        media_id = create_test_media(db_session)
        fragment_id = create_test_fragment(db_session, media_id, content=FIXTURE_TEXT)
        first = _materialize(
            db_session,
            bootstrapped_user,
            media_id,
            exact="kilo lima mike",
            locator_hint={
                "kind": "text",
                "fragment_id": str(fragment_id),
                "start_offset": 64,
                "end_offset": 78,
            },
        )
        second = _materialize(
            db_session,
            bootstrapped_user,
            media_id,
            exact="kilo lima mike",
            locator_hint={
                "kind": "text",
                "fragment_id": str(uuid4()),
                "start_offset": 0,
                "end_offset": 14,
            },
        )
        assert first.id == second.id

    def test_changed_time_hints_reuse_one_anchor_and_recompute_times(
        self, db_session: Session, bootstrapped_user
    ):
        media_id = create_test_media(db_session)
        db_session.add(
            Fragment(
                id=uuid4(),
                media_id=media_id,
                idx=0,
                canonical_text="Welcome to the show today we discuss anchors",
                html_sanitized="<p>Welcome to the show today we discuss anchors</p>",
                t_start_ms=1000,
                t_end_ms=5000,
            )
        )
        db_session.flush()
        first = _materialize(
            db_session,
            bootstrapped_user,
            media_id,
            exact="we discuss anchors",
            locator_hint={"kind": "time", "t_start_ms": 111, "t_end_ms": 222},
        )
        second = _materialize(
            db_session,
            bootstrapped_user,
            media_id,
            exact="we discuss anchors",
            locator_hint={"kind": "time", "t_start_ms": 999, "t_end_ms": 1999},
        )
        assert first.id == second.id
        assert first.selector["locator_hint"] == {
            "kind": "time",
            "t_start_ms": 1000,
            "t_end_ms": 5000,
        }

    def test_pdf_quad_order_and_float_precision_reuse_one_anchor(
        self, db_session: Session, bootstrapped_user
    ):
        library_id = get_user_default_library(db_session, bootstrapped_user)
        assert library_id is not None
        media_id = create_pdf_media_with_text(
            db_session,
            bootstrapped_user,
            library_id,
            plain_text=FIXTURE_TEXT,
            page_count=1,
            page_spans=[(0, len(FIXTURE_TEXT))],
        )
        quad_a = {"x1": 1.5, "y1": 2, "x2": 3, "y2": 4, "x3": 5, "y3": 6, "x4": 7, "y4": 8}
        quad_b = {"x1": 10, "y1": 20, "x2": 30, "y2": 40, "x3": 50, "y3": 60, "x4": 70, "y4": 80}
        first = _materialize(
            db_session,
            bootstrapped_user,
            media_id,
            exact="kilo lima mike",
            locator_hint={"kind": "pdf", "page_number": 1, "quads": [quad_a, quad_b]},
        )
        second = _materialize(
            db_session,
            bootstrapped_user,
            media_id,
            exact="kilo lima mike",
            locator_hint={
                "kind": "pdf",
                "page_number": 1,
                "quads": [dict(quad_b), {**quad_a, "x1": 1.50}],
            },
        )
        assert first.id == second.id
        assert first.selector["locator_hint"]["kind"] == "pdf"
        assert first.selector["locator_hint"]["page_number"] == 1

    def test_empty_quote_pdf_candidate_refused(self, db_session: Session, bootstrapped_user):
        library_id = get_user_default_library(db_session, bootstrapped_user)
        assert library_id is not None
        media_id = create_pdf_media_with_text(
            db_session, bootstrapped_user, library_id, plain_text=FIXTURE_TEXT, page_count=1
        )
        quad = {"x1": 1, "y1": 2, "x2": 3, "y2": 4, "x3": 5, "y3": 6, "x4": 7, "y4": 8}
        with pytest.raises(ApiError) as excinfo:
            _materialize(
                db_session,
                bootstrapped_user,
                media_id,
                exact="   ",
                locator_hint={"kind": "pdf", "page_number": 1, "quads": [quad]},
            )
        assert excinfo.value.code is ApiErrorCode.E_LINK_TARGET_AMBIGUOUS

    def test_repeated_quote_and_context_refused_never_geometry_disambiguated(
        self, db_session: Session, bootstrapped_user
    ):
        block = "one two three four five six seven eight nine ten"
        media_id = create_test_media(db_session)
        fragment_id = create_test_fragment(db_session, media_id, content=f"{block} {block}")
        with pytest.raises(ApiError) as excinfo:
            _materialize(
                db_session,
                bootstrapped_user,
                media_id,
                exact="five six",
                prefix="three four",
                suffix="seven",
                locator_hint={
                    "kind": "text",
                    "fragment_id": str(fragment_id),
                    "start_offset": 19,
                    "end_offset": 27,
                },
            )
        assert excinfo.value.code is ApiErrorCode.E_LINK_TARGET_AMBIGUOUS

    def test_no_match_refused(self, db_session: Session, bootstrapped_user):
        media_id = create_test_media(db_session)
        create_test_fragment(db_session, media_id, content=FIXTURE_TEXT)
        with pytest.raises(ApiError) as excinfo:
            _materialize(db_session, bootstrapped_user, media_id, exact="not in the text")
        assert excinfo.value.code is ApiErrorCode.E_LINK_TARGET_AMBIGUOUS

    def test_prefix_suffix_recomputed_at_boundaries(self, db_session: Session, bootstrapped_user):
        media_id = create_test_media(db_session)
        create_test_fragment(db_session, media_id, content=FIXTURE_TEXT)

        at_start = _materialize(db_session, bootstrapped_user, media_id, exact="Alpha bravo")
        assert at_start.selector["quote"]["prefix"] == ""
        assert (
            at_start.selector["quote"]["suffix"] == FIXTURE_TEXT[len("Alpha bravo") :][:64].strip()
        )

        at_end = _materialize(db_session, bootstrapped_user, media_id, exact="yankee zulu.")
        assert at_end.selector["quote"]["suffix"] == ""

        # Interior quote: full 64-scalar windows on both sides.
        start = FIXTURE_TEXT.index("quebec romeo sierra")
        mid = _materialize(db_session, bootstrapped_user, media_id, exact="quebec romeo sierra")
        assert mid.selector["quote"]["prefix"] == FIXTURE_TEXT[start - 64 : start].strip()
        end = start + len("quebec romeo sierra")
        assert mid.selector["quote"]["suffix"] == FIXTURE_TEXT[end : end + 64].strip()

    def test_distinct_contexts_make_distinct_anchors(self, db_session: Session, bootstrapped_user):
        media_id = create_test_media(db_session)
        create_test_fragment(
            db_session, media_id, content="red one two blue and later green one two yellow"
        )
        by_red = _materialize(
            db_session, bootstrapped_user, media_id, exact="one two", prefix="red"
        )
        by_green = _materialize(
            db_session, bootstrapped_user, media_id, exact="one two", prefix="green"
        )
        assert by_red.id != by_green.id
        assert by_red.anchor_key != by_green.anchor_key

    def test_note_block_owner(self, db_session: Session, bootstrapped_user):
        note = NoteBlock(
            id=uuid4(),
            user_id=bootstrapped_user,
            body_pm_json={"type": "doc"},
            body_text="A note about the meaning of anchors and durable identity.",
        )
        db_session.add(note)
        db_session.flush()
        anchor = _materialize(
            db_session,
            bootstrapped_user,
            note.id,
            owner_scheme="note_block",
            exact="meaning of anchors",
        )
        assert anchor.owner_scheme == "note_block"
        start = note.body_text.index("meaning of anchors")
        assert anchor.selector["locator_hint"] == {
            "kind": "text",
            "start_offset": start,
            "end_offset": start + len("meaning of anchors"),
        }


@pytest.mark.integration
class TestCurrentLocationResolution:
    def test_resolves_live_against_current_text(self, db_session: Session, bootstrapped_user):
        media_id = create_test_media(db_session)
        fragment_id = create_test_fragment(db_session, media_id, content=FIXTURE_TEXT)
        anchor = _materialize(db_session, bootstrapped_user, media_id, exact="kilo lima mike")

        location = passage_anchors.resolve_current_location(
            db_session, viewer_id=bootstrapped_user, passage_anchor_id=anchor.id
        )
        assert location is not None
        assert location.resolved is True
        assert location.locator is not None
        assert location.locator["kind"] == "text"
        assert location.locator["fragment_id"] == str(fragment_id)
        assert location.exact == "kilo lima mike"

    def test_masked_for_other_viewer(self, db_session: Session, bootstrapped_user):
        media_id = create_test_media(db_session)
        create_test_fragment(db_session, media_id, content=FIXTURE_TEXT)
        anchor = _materialize(db_session, bootstrapped_user, media_id, exact="kilo lima mike")
        assert (
            passage_anchors.resolve_current_location(
                db_session, viewer_id=uuid4(), passage_anchor_id=anchor.id
            )
            is None
        )

    def test_changed_content_is_unresolved_not_deleted(
        self, db_session: Session, bootstrapped_user
    ):
        media_id = create_test_media(db_session)
        fragment_id = create_test_fragment(db_session, media_id, content=FIXTURE_TEXT)
        anchor = _materialize(db_session, bootstrapped_user, media_id, exact="kilo lima mike")

        fragment = db_session.get(Fragment, fragment_id)
        assert fragment is not None
        fragment.canonical_text = "Entirely different content now."
        db_session.flush()

        location = passage_anchors.resolve_current_location(
            db_session, viewer_id=bootstrapped_user, passage_anchor_id=anchor.id
        )
        assert location is not None
        assert location.resolved is False
        assert location.locator is None
        assert db_session.get(PassageAnchor, anchor.id) is not None

    def test_later_ambiguity_is_unresolved(self, db_session: Session, bootstrapped_user):
        media_id = create_test_media(db_session)
        fragment_id = create_test_fragment(db_session, media_id, content=FIXTURE_TEXT)
        anchor = _materialize(db_session, bootstrapped_user, media_id, exact="kilo lima mike")

        fragment = db_session.get(Fragment, fragment_id)
        assert fragment is not None
        fragment.canonical_text = f"{FIXTURE_TEXT} {FIXTURE_TEXT}"
        db_session.flush()

        location = passage_anchors.resolve_current_location(
            db_session, viewer_id=bootstrapped_user, passage_anchor_id=anchor.id
        )
        assert location is not None
        assert location.resolved is False
        assert location.locator is None


@pytest.mark.integration
class TestResolvePassageSelector:
    def test_pdf_page_and_hint_quads(self, db_session: Session, bootstrapped_user):
        library_id = get_user_default_library(db_session, bootstrapped_user)
        assert library_id is not None
        page_break = FIXTURE_TEXT.index("kilo")
        media_id = create_pdf_media_with_text(
            db_session,
            bootstrapped_user,
            library_id,
            plain_text=FIXTURE_TEXT,
            page_count=2,
            page_spans=[(0, page_break), (page_break, len(FIXTURE_TEXT))],
        )
        quad = {"x1": 1, "y1": 2, "x2": 3, "y2": 4, "x3": 5, "y3": 6, "x4": 7, "y4": 8}
        resolution = resolve_passage_selector(
            db_session,
            owner_scheme="media",
            owner_id=media_id,
            exact="kilo lima mike",
            locator_hint={"kind": "pdf", "page_number": 2, "quads": [quad]},
        )
        assert resolution.status is QuoteStatus.unique
        assert resolution.locator == {"kind": "pdf", "page_number": 2, "quads": [quad]}

        stale_page_hint = resolve_passage_selector(
            db_session,
            owner_scheme="media",
            owner_id=media_id,
            exact="kilo lima mike",
            locator_hint={"kind": "pdf", "page_number": 1, "quads": [quad]},
        )
        assert stale_page_hint.status is QuoteStatus.unique
        assert stale_page_hint.locator == {"kind": "pdf", "page_number": 2}

    def test_missing_owner_is_no_match(self, db_session: Session, bootstrapped_user):
        resolution = resolve_passage_selector(
            db_session, owner_scheme="media", owner_id=uuid4(), exact="anything"
        )
        assert resolution.status is QuoteStatus.no_match
