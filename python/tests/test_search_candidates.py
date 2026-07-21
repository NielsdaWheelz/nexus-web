"""Seam tests for the pre-projection search candidate engine.

Covers the two target profiles of ``services/search/candidates.py``
(universal-link-authoring-hard-cutover.md, Resource Target Search rules 1-3):

- ``reference_candidates``: one-character acceptance, note-body substring
  matching (the ported ObjectRef-picker behavior), direct-targets-only output,
  and the zero-embedding-calls invariant (AC-14).
- ``link_candidates``: hybrid pool plus the target-only resource-metadata
  retrievers (libraries, generated outputs, passage anchors).

Deep target admission/pagination tests belong to ``resource_items/targets.py``
(next phase); ordinary ``/search`` behavior stays covered by ``test_search.py``.
"""

from uuid import uuid4

import pytest
from sqlalchemy.orm import Session

from nexus.db.models import (
    ArtifactRevision,
    Contributor,
    ContributorCredit,
    NoteBlock,
    OracleReading,
    Page,
    PassageAnchor,
    SynthesisArtifact,
)
from nexus.errors import ApiError, ApiErrorCode
from nexus.services.bootstrap import ensure_user_and_default_library
from nexus.services.search.candidates import (
    candidate_resource_ref,
    link_candidates,
    reference_candidates,
)
from nexus.services.search.results import _SearchScore
from nexus.services.search.retrievers.resource_metadata import (
    LibraryCandidate,
    LibraryDossierCandidate,
    OracleReadingCandidate,
    PassageAnchorCandidate,
)
from tests.factories import create_searchable_media, create_test_library

pytestmark = pytest.mark.integration

_PASSAGE_SCHEMES = {
    "evidence_span",
    "content_chunk",
    "fragment",
    "reader_apparatus_item",
    "oracle_passage_anchor",
}


def _create_note_block(db: Session, user_id, body: str) -> NoteBlock:
    note = NoteBlock(
        id=uuid4(),
        user_id=user_id,
        body_pm_json={"type": "paragraph", "content": [{"type": "text", "text": body}]},
        body_text=body,
    )
    db.add(note)
    db.flush()
    return note


def _no_embedding_calls(monkeypatch: pytest.MonkeyPatch) -> None:
    def boom(_text: str):
        raise AssertionError("purpose=reference must never build a query embedding")

    monkeypatch.setattr("nexus.services.search.embedding.build_text_embedding", boom)


class TestReferenceProfile:
    def test_one_char_query_matches_note_body_substring(
        self, db_session: Session, bootstrapped_user, monkeypatch
    ) -> None:
        _no_embedding_calls(monkeypatch)
        note = _create_note_block(db_session, bootstrapped_user, "alpha bravo xylophone plan")

        results = reference_candidates(db_session, bootstrapped_user, q="y")

        assert note.id in {
            c.id for c in results if candidate_resource_ref(c).scheme == "note_block"
        }

    def test_multichar_substring_matches_note_body_without_fts_terms(
        self, db_session: Session, bootstrapped_user, monkeypatch
    ) -> None:
        _no_embedding_calls(monkeypatch)
        note = _create_note_block(db_session, bootstrapped_user, "alpha bravo xylophone plan")

        results = reference_candidates(db_session, bootstrapped_user, q="ylopho")

        assert note.id in {
            c.id for c in results if candidate_resource_ref(c).scheme == "note_block"
        }

    def test_matches_library_name_and_page_title_by_prefix(
        self, db_session: Session, bootstrapped_user, monkeypatch
    ) -> None:
        _no_embedding_calls(monkeypatch)
        library_id = create_test_library(db_session, bootstrapped_user, name="Zephyr Collection")
        page = Page(id=uuid4(), user_id=bootstrapped_user, title="Zephyr field notes")
        db_session.add(page)
        db_session.flush()

        results = reference_candidates(db_session, bootstrapped_user, q="zep")

        by_scheme = {}
        for candidate in results:
            by_scheme.setdefault(candidate_resource_ref(candidate).scheme, set()).add(candidate.id)
        assert library_id in by_scheme.get("library", set())
        assert page.id in by_scheme.get("page", set())

    def test_emits_direct_targets_only(
        self, db_session: Session, bootstrapped_user, monkeypatch
    ) -> None:
        _no_embedding_calls(monkeypatch)
        # Searchable media has an indexed fragment whose canonical text contains
        # the title words, so a passage-capable retriever WOULD match this query.
        create_searchable_media(db_session, bootstrapped_user, title="Canonical Widgets")

        results = reference_candidates(db_session, bootstrapped_user, q="canonical")

        schemes = {candidate_resource_ref(c).scheme for c in results}
        assert "media" in schemes
        assert schemes & _PASSAGE_SCHEMES == set()

    def test_schemes_filter_restricts_sources(
        self, db_session: Session, bootstrapped_user, monkeypatch
    ) -> None:
        _no_embedding_calls(monkeypatch)
        library_id = create_test_library(db_session, bootstrapped_user, name="Quill Library")
        _create_note_block(db_session, bootstrapped_user, "Quill body text")

        results = reference_candidates(
            db_session, bootstrapped_user, q="quill", schemes={"library"}
        )

        assert {type(c) for c in results} == {LibraryCandidate}
        assert {c.id for c in results} == {library_id}

    def test_empty_query_returns_nothing(
        self, db_session: Session, bootstrapped_user, monkeypatch
    ) -> None:
        _no_embedding_calls(monkeypatch)
        assert reference_candidates(db_session, bootstrapped_user, q="   ") == []

    def test_contributor_gate_requires_visible_credit(
        self, db_session: Session, bootstrapped_user, monkeypatch
    ) -> None:
        """D-8: a retained zero-visible-credit contributor never surfaces from the
        reference profile, even when its display name matches the query."""
        _no_embedding_calls(monkeypatch)
        media_id = create_searchable_media(db_session, bootstrapped_user, title="Gatecheck Work")
        credited = Contributor(
            id=uuid4(),
            handle=f"credited-{uuid4().hex[:8]}",
            display_name="Findable Gatecheck Author",
        )
        hidden = Contributor(
            id=uuid4(),
            handle=f"hidden-{uuid4().hex[:8]}",
            display_name="Hidden Gatecheck Owner",
        )
        db_session.add_all([credited, hidden])
        db_session.flush()
        db_session.add(
            ContributorCredit(
                contributor_id=credited.id,
                media_id=media_id,
                credited_name=credited.display_name,
                normalized_credited_name=credited.display_name.lower(),
                role="author",
                ordinal=0,
                source="epub_opf",
            )
        )
        db_session.flush()

        results = reference_candidates(
            db_session, bootstrapped_user, q="gatecheck", schemes={"contributor"}
        )

        ids = {c.id for c in results}
        assert credited.id in ids, "a credited-visible contributor must surface"
        assert hidden.id not in ids, (
            "a zero-visible-credit contributor must stay hidden from the picker (D-8)"
        )

    def test_library_dossier_head_requires_membership_and_ready_current_revision(
        self, db_session: Session, bootstrapped_user, monkeypatch
    ) -> None:
        _no_embedding_calls(monkeypatch)
        library_id = create_test_library(db_session, bootstrapped_user, name="Dossier Home")
        artifact = SynthesisArtifact(
            id=uuid4(),
            subject_scheme="library",
            subject_id=library_id,
            kind="library_dossier",
            user_id=bootstrapped_user,
        )
        db_session.add(artifact)
        db_session.flush()
        revision = ArtifactRevision(
            id=uuid4(),
            artifact_id=artifact.id,
            content_md="dossierword synthesis of the shelf",
            covered_targets=[],
            status="ready",
        )
        db_session.add(revision)
        db_session.flush()
        artifact.current_revision_id = revision.id
        db_session.flush()

        results = reference_candidates(
            db_session, bootstrapped_user, q="dossierword", schemes={"artifact"}
        )
        assert [type(c) for c in results] == [LibraryDossierCandidate]
        assert results[0].id == artifact.id
        assert results[0].library_id == library_id
        assert results[0].library_name == "Dossier Home"
        assert candidate_resource_ref(results[0]).uri == f"artifact:{artifact.id}"

        # A non-member never sees the head.
        outsider = uuid4()
        ensure_user_and_default_library(db_session, outsider)
        assert (
            reference_candidates(db_session, outsider, q="dossierword", schemes={"artifact"}) == []
        )

        # A non-ready current revision never matches.
        revision.status = "building"
        db_session.flush()
        assert (
            reference_candidates(
                db_session, bootstrapped_user, q="dossierword", schemes={"artifact"}
            )
            == []
        )


class TestLinkProfile:
    def test_includes_metadata_and_hybrid_candidates(
        self, db_session: Session, bootstrapped_user, monkeypatch
    ) -> None:
        # LLM boundary: no embedding key -> typed lexical-only degradation.
        def no_key(_text: str):
            raise ApiError(ApiErrorCode.E_LLM_NO_KEY, "no key")

        monkeypatch.setattr("nexus.services.search.embedding.build_text_embedding", no_key)

        library_id = create_test_library(db_session, bootstrapped_user, name="Quantum Widgets")
        media_id = create_searchable_media(db_session, bootstrapped_user, title="Quantum Reader")
        reading = OracleReading(
            id=uuid4(),
            user_id=bootstrapped_user,
            folio_number=1,
            question_text="What of the quantum flux?",
        )
        anchor = PassageAnchor(
            id=uuid4(),
            user_id=bootstrapped_user,
            owner_scheme="media",
            owner_id=media_id,
            selector_version=1,
            anchor_key="a" * 64,
            selector={
                "quote": {"exact": "quantum flux capacitor", "prefix": "", "suffix": ""},
                "locator_hint": None,
            },
        )
        db_session.add_all([reading, anchor])
        # Commit: build_query_embedding rolls back a non-caller-owned transaction
        # before its HTTP call, so flushed-only seed rows would vanish.
        db_session.commit()

        results = link_candidates(
            db_session,
            bootstrapped_user,
            q="quantum",
            transaction_active_at_entry=db_session.in_transaction(),
        )

        by_scheme = {}
        for candidate in results:
            by_scheme.setdefault(candidate_resource_ref(candidate).scheme, set()).add(candidate.id)
        assert library_id in by_scheme.get("library", set())
        assert reading.id in by_scheme.get("oracle_reading", set())
        assert anchor.id in by_scheme.get("passage_anchor", set())
        assert media_id in by_scheme.get("media", set())
        # Ranked: normalized scores are non-increasing.
        normalized = [c.score.normalized for c in results]
        assert normalized == sorted(normalized, reverse=True)

    def test_metadata_candidate_types(self) -> None:
        # The target-only candidates map to their schemes without consumer switches.
        lib = LibraryCandidate(id=uuid4(), name="L", snippet="L", score=_score())
        reading = OracleReadingCandidate(id=uuid4(), question_text="Q", snippet="Q", score=_score())
        anchor = PassageAnchorCandidate(
            id=uuid4(),
            owner_scheme="media",
            owner_id=uuid4(),
            exact="x",
            snippet="x",
            score=_score(),
        )
        assert candidate_resource_ref(lib).scheme == "library"
        assert candidate_resource_ref(reading).scheme == "oracle_reading"
        assert candidate_resource_ref(anchor).scheme == "passage_anchor"


def _score() -> _SearchScore:
    return _SearchScore(raw=1.0)
