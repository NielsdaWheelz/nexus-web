"""Integration tests for resource-target admission/projection.

Covers ``services/resource_items/targets.py`` + ``POST
/resource-items/targets/search`` (universal-link-authoring-hard-cutover.md,
Resource Target Search): policy admission per scheme class, visibility
masking, exclusions/dedupe before per-source caps with refill, the
zero-embedding one-character reference path, passage projection
(activation/excerpt), exact-ResourceRef input, and the non-mutating
existing-Link/anchor lookup in both orientations.
"""

from __future__ import annotations

from uuid import UUID, uuid4

import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session

from nexus.db.models import Fragment, NoteBlock, Page, PassageAnchor
from nexus.errors import ApiError, ApiErrorCode
from nexus.schemas.resource_targets import ResourceTargetSearchRequest
from nexus.services import passage_anchors
from nexus.services.bootstrap import ensure_user_and_default_library
from nexus.services.resource_graph import edges
from nexus.services.resource_graph.refs import ResourceRef
from nexus.services.resource_graph.schemas import EdgeCreate
from nexus.services.resource_items import targets
from nexus.services.resource_items.targets import search_targets
from nexus.services.search.cursor import encode_search_cursor
from nexus.services.search.results import _build_search_score, _RankedMediaResult
from tests.factories import (
    create_searchable_media,
    create_test_library,
    create_test_media_in_library,
    get_user_default_library,
)
from tests.helpers import auth_headers, create_test_user_id
from tests.utils.db import DirectSessionManager

pytestmark = pytest.mark.integration

_PASSAGE_SCHEMES = {
    "evidence_span",
    "content_chunk",
    "fragment",
    "reader_apparatus_item",
    "oracle_passage_anchor",
}


def _request(**kwargs) -> ResourceTargetSearchRequest:
    return ResourceTargetSearchRequest(**{"purpose": "link", **kwargs})


def _no_embedding_calls(monkeypatch: pytest.MonkeyPatch) -> None:
    def boom(*_args, **_kwargs):
        raise AssertionError("this target-search path must never build a query embedding")

    monkeypatch.setattr("nexus.services.search.candidates.build_query_embedding", boom)
    monkeypatch.setattr("nexus.services.search.embedding.build_text_embedding", boom)


def _lexical_only_embedding(monkeypatch: pytest.MonkeyPatch) -> None:
    """LLM boundary: no embedding key -> typed lexical-only degradation."""

    def no_key(_text: str):
        raise ApiError(ApiErrorCode.E_LLM_NO_KEY, "no key")

    monkeypatch.setattr("nexus.services.search.embedding.build_text_embedding", no_key)


def _create_note(db: Session, user_id: UUID, body: str) -> NoteBlock:
    note = NoteBlock(
        id=uuid4(),
        user_id=user_id,
        body_pm_json={"type": "paragraph", "content": [{"type": "text", "text": body}]},
        body_text=body,
    )
    db.add(note)
    db.flush()
    return note


def _create_user_link(db: Session, user_id: UUID, source: ResourceRef, target: ResourceRef) -> UUID:
    edge = edges.create_edge(
        db,
        viewer_id=user_id,
        input=EdgeCreate(source=source, target=target, kind="context", origin="user"),
    )
    db.flush()
    return edge.id


class TestAdmission:
    def test_link_admits_direct_and_passage_targets(
        self, db_session: Session, bootstrapped_user, monkeypatch
    ) -> None:
        _lexical_only_embedding(monkeypatch)
        library_id = create_test_library(db_session, bootstrapped_user, name="Canonical Shelf")
        media_id = create_searchable_media(db_session, bootstrapped_user, title="Canonical Widgets")
        db_session.commit()

        response = search_targets(
            db_session,
            viewer_id=bootstrapped_user,
            request=_request(q="canonical", limit=20),
        )

        resource_refs = {t.item.ref for t in response.targets if t.kind == "resource"}
        assert f"media:{media_id}" in resource_refs
        assert f"library:{library_id}" in resource_refs

        passages = [t for t in response.targets if t.kind == "passage"]
        assert passages, "hybrid link profile must emit passage candidates"
        for passage in passages:
            scheme = passage.candidate_ref.split(":", 1)[0]
            assert scheme in _PASSAGE_SCHEMES
            assert passage.excerpt
            assert passage.activation.resource_ref == passage.candidate_ref
            assert passage.source.scheme == "media"
            assert passage.source.id == media_id
            assert passage.label == passage.source.label

    def test_reference_emits_direct_targets_only(
        self, db_session: Session, bootstrapped_user, monkeypatch
    ) -> None:
        _no_embedding_calls(monkeypatch)
        media_id = create_searchable_media(db_session, bootstrapped_user, title="Canonical Widgets")

        response = search_targets(
            db_session,
            viewer_id=bootstrapped_user,
            request=_request(purpose="reference", q="canonical", limit=20),
        )

        assert all(t.kind == "resource" for t in response.targets)
        schemes = {t.item.scheme for t in response.targets}
        assert "media" in schemes
        assert schemes & _PASSAGE_SCHEMES == set()
        assert f"media:{media_id}" in {t.item.ref for t in response.targets}

    def test_reference_one_char_note_body_substring_zero_embedding_calls(
        self, db_session: Session, bootstrapped_user, monkeypatch
    ) -> None:
        _no_embedding_calls(monkeypatch)
        note = _create_note(db_session, bootstrapped_user, "alpha bravo xylophone plan")

        response = search_targets(
            db_session,
            viewer_id=bootstrapped_user,
            request=_request(purpose="reference", q="y", limit=20),
        )

        assert f"note_block:{note.id}" in {
            t.item.ref for t in response.targets if t.kind == "resource"
        }

    def test_link_short_query_returns_empty_page(
        self, db_session: Session, bootstrapped_user, monkeypatch
    ) -> None:
        _no_embedding_calls(monkeypatch)
        _create_note(db_session, bootstrapped_user, "alpha bravo xylophone plan")

        response = search_targets(db_session, viewer_id=bootstrapped_user, request=_request(q="y"))

        assert response.targets == []
        assert response.next_cursor is None

    def test_dedupe_is_by_canonical_durable_ref(self) -> None:
        media_id = uuid4()
        as_media = _RankedMediaResult(
            id=media_id, snippet="s", source=None, score=_build_search_score(1.0)
        )
        as_episode = _RankedMediaResult(
            id=media_id,
            snippet="s",
            source=None,
            score=_build_search_score(1.0),
            result_type="episode",
        )

        admitted = targets._admit([as_media, as_episode], purpose="link", excluded=set())

        assert admitted == [as_media]


class TestRefill:
    def test_exclusions_apply_before_caps_and_pool_refills(
        self, db_session: Session, bootstrapped_user, monkeypatch
    ) -> None:
        _no_embedding_calls(monkeypatch)
        monkeypatch.setitem(targets._INITIAL_LIMIT_PER_SOURCE, "reference", 2)
        # Four exact-match notes outrank the one substring-match note, so the
        # first per-source cap (2) retrieves only excluded candidates.
        excluded_notes = [
            _create_note(db_session, bootstrapped_user, "refilltoken") for _ in range(4)
        ]
        kept = _create_note(db_session, bootstrapped_user, "the refilltoken appears here later")

        response = search_targets(
            db_session,
            viewer_id=bootstrapped_user,
            request=_request(
                purpose="reference",
                q="refilltoken",
                limit=1,
                exclude_refs=[f"note_block:{note.id}" for note in excluded_notes],
                schemes=["note_block"],
            ),
        )

        assert [t.item.ref for t in response.targets] == [f"note_block:{kept.id}"]
        assert response.next_cursor is None


class TestExactRefInput:
    def test_direct_ref_resolves_through_resource_item(
        self, db_session: Session, bootstrapped_user
    ) -> None:
        media_id = create_searchable_media(db_session, bootstrapped_user, title="Exact Target")

        response = search_targets(
            db_session, viewer_id=bootstrapped_user, request=_request(q=f"media:{media_id}")
        )

        assert len(response.targets) == 1
        target = response.targets[0]
        assert target.kind == "resource"
        assert target.item.ref == f"media:{media_id}"
        assert target.item.label == "Exact Target"
        assert target.existing_link_id is None
        assert response.next_cursor is None

    def test_hidden_and_missing_refs_mask_identically(
        self, db_session: Session, bootstrapped_user
    ) -> None:
        other_user = uuid4()
        ensure_user_and_default_library(db_session, other_user)
        hidden_media = create_searchable_media(db_session, other_user, title="Hidden Media")

        hidden = search_targets(
            db_session, viewer_id=bootstrapped_user, request=_request(q=f"media:{hidden_media}")
        )
        missing = search_targets(
            db_session, viewer_id=bootstrapped_user, request=_request(q=f"media:{uuid4()}")
        )

        assert hidden == missing
        assert hidden.targets == []

    def test_excluded_and_offset_exact_ref_returns_empty(
        self, db_session: Session, bootstrapped_user
    ) -> None:
        media_id = create_searchable_media(db_session, bootstrapped_user, title="Exact Target")

        excluded = search_targets(
            db_session,
            viewer_id=bootstrapped_user,
            request=_request(q=f"media:{media_id}", exclude_refs=[f"media:{media_id}"]),
        )
        beyond = search_targets(
            db_session,
            viewer_id=bootstrapped_user,
            request=_request(q=f"media:{media_id}", cursor=encode_search_cursor(1)),
        )

        assert excluded.targets == []
        assert beyond.targets == []

    def test_passage_scheme_ref_projects_passage_target(
        self, db_session: Session, bootstrapped_user
    ) -> None:
        media_id = create_searchable_media(db_session, bootstrapped_user, title="Exact Passage")
        fragment_id = db_session.execute(
            select(Fragment.id).where(Fragment.media_id == media_id)
        ).scalar_one()

        response = search_targets(
            db_session, viewer_id=bootstrapped_user, request=_request(q=f"fragment:{fragment_id}")
        )

        assert len(response.targets) == 1
        target = response.targets[0]
        assert target.kind == "passage"
        assert target.candidate_ref == f"fragment:{fragment_id}"
        assert "canonical text" in target.excerpt
        assert target.source.ref == f"media:{media_id}"

    def test_reference_purpose_rejects_passage_scheme_ref(
        self, db_session: Session, bootstrapped_user
    ) -> None:
        media_id = create_searchable_media(db_session, bootstrapped_user, title="Exact Passage")
        fragment_id = db_session.execute(
            select(Fragment.id).where(Fragment.media_id == media_id)
        ).scalar_one()

        response = search_targets(
            db_session,
            viewer_id=bootstrapped_user,
            request=_request(purpose="reference", q=f"fragment:{fragment_id}"),
        )

        assert response.targets == []


class TestExistingLinkLookup:
    def test_exact_ref_carries_existing_link_id_in_both_orientations(
        self, db_session: Session, bootstrapped_user
    ) -> None:
        media_a = create_searchable_media(db_session, bootstrapped_user, title="Orientwidget Alpha")
        media_b = create_searchable_media(db_session, bootstrapped_user, title="Orientwidget Beta")
        ref_a = ResourceRef(scheme="media", id=media_a)
        ref_b = ResourceRef(scheme="media", id=media_b)
        edge_id = _create_user_link(db_session, bootstrapped_user, ref_a, ref_b)

        from_a = search_targets(
            db_session,
            viewer_id=bootstrapped_user,
            request=_request(q=ref_b.uri, source_ref=ref_a.uri),
        )
        from_b = search_targets(
            db_session,
            viewer_id=bootstrapped_user,
            request=_request(q=ref_a.uri, source_ref=ref_b.uri),
        )

        assert from_a.targets[0].existing_link_id == edge_id
        assert from_b.targets[0].existing_link_id == edge_id

    def test_ranked_search_sets_existing_link_id_and_excludes_source(
        self, db_session: Session, bootstrapped_user, monkeypatch
    ) -> None:
        _no_embedding_calls(monkeypatch)
        media_a = create_searchable_media(db_session, bootstrapped_user, title="Orientwidget Alpha")
        media_b = create_searchable_media(db_session, bootstrapped_user, title="Orientwidget Beta")
        ref_a = ResourceRef(scheme="media", id=media_a)
        ref_b = ResourceRef(scheme="media", id=media_b)
        edge_id = _create_user_link(db_session, bootstrapped_user, ref_a, ref_b)

        response = search_targets(
            db_session,
            viewer_id=bootstrapped_user,
            request=_request(purpose="reference", q="orientwidget", source_ref=ref_a.uri, limit=20),
        )

        by_ref = {t.item.ref: t for t in response.targets if t.kind == "resource"}
        assert ref_a.uri not in by_ref  # self-exclusion of the source ref
        assert by_ref[ref_b.uri].existing_link_id == edge_id

    def test_passage_candidate_reports_existing_anchor_link_without_materializing(
        self, db_session: Session, bootstrapped_user, monkeypatch
    ) -> None:
        _lexical_only_embedding(monkeypatch)
        media_id = create_searchable_media(db_session, bootstrapped_user, title="Anchored Widgets")
        fragment = db_session.execute(
            select(Fragment).where(Fragment.media_id == media_id)
        ).scalar_one()
        note = _create_note(db_session, bootstrapped_user, "link source note")
        anchor = passage_anchors.materialize_or_reuse(
            db_session,
            user_id=bootstrapped_user,
            owner_scheme="media",
            owner_id=media_id,
            exact=fragment.canonical_text,
        )
        note_ref = ResourceRef(scheme="note_block", id=note.id)
        edge_id = _create_user_link(
            db_session,
            bootstrapped_user,
            note_ref,
            ResourceRef(scheme="passage_anchor", id=anchor.id),
        )
        db_session.commit()
        anchors_before = db_session.execute(select(PassageAnchor.id)).scalars().all()

        response = search_targets(
            db_session,
            viewer_id=bootstrapped_user,
            request=_request(q="canonical", source_ref=note_ref.uri, limit=20),
        )

        fragment_targets = [
            t
            for t in response.targets
            if t.kind == "passage" and t.candidate_ref == f"fragment:{fragment.id}"
        ]
        assert fragment_targets, "fragment passage candidate must stay ranked"
        assert fragment_targets[0].existing_link_id == edge_id
        # Rule 8: search never materializes an anchor.
        anchors_after = db_session.execute(select(PassageAnchor.id)).scalars().all()
        assert sorted(anchors_after) == sorted(anchors_before)


class TestPagination:
    def test_limit_and_cursor_paginate_post_filter_ranking(
        self, db_session: Session, bootstrapped_user, monkeypatch
    ) -> None:
        _no_embedding_calls(monkeypatch)
        expected = {
            f"media:{create_searchable_media(db_session, bootstrapped_user, title=title)}"
            for title in ("Cursor Widget One", "Cursor Widget Two", "Cursor Widget Three")
        }

        first = search_targets(
            db_session,
            viewer_id=bootstrapped_user,
            request=_request(purpose="reference", q="cursor widget", limit=2, schemes=["media"]),
        )
        assert len(first.targets) == 2
        assert first.next_cursor is not None

        second = search_targets(
            db_session,
            viewer_id=bootstrapped_user,
            request=_request(
                purpose="reference",
                q="cursor widget",
                limit=2,
                schemes=["media"],
                cursor=first.next_cursor,
            ),
        )
        assert len(second.targets) == 1
        assert second.next_cursor is None

        seen = [t.item.ref for t in [*first.targets, *second.targets]]
        assert sorted(seen) == sorted(expected)

    def test_pages_of_one_query_stay_consistent_across_refill_escalation(
        self, db_session: Session, bootstrapped_user, monkeypatch
    ) -> None:
        """Rule 5: one query has ONE ranking. Deeper cursors escalate the
        per-source retrieval cap; the refill must only APPEND new entrants —
        re-ranking the grown pool would reshuffle the cross-type interleaving
        earlier pages were sliced from, duplicating or skipping targets."""
        _no_embedding_calls(monkeypatch)
        monkeypatch.setitem(targets._INITIAL_LIMIT_PER_SOURCE, "reference", 2)
        # Deterministic ids (the ranking tie-break is str(id)) and three note
        # score tiers: refill steps grow the note pool tier by tier, which
        # re-ranking would re-normalize (prefix notes drift 0.0 -> 0.5 once
        # substring notes enter), reordering them against the substring page
        # that pages already served.
        note_bodies = {
            "aaaaaaaa-0000-0000-0000-000000000001": "pagintoken",
            "abaaaaaa-0000-0000-0000-000000000001": "pagintoken",
            "feaaaaaa-0000-0000-0000-000000000001": "pagintoken alpha one",
            "ffaaaaaa-0000-0000-0000-000000000001": "pagintoken alpha two",
            "e1aaaaaa-0000-0000-0000-000000000001": "the pagintoken one",
            "e2aaaaaa-0000-0000-0000-000000000001": "the pagintoken two",
        }
        page_titles = {
            "b0aaaaaa-0000-0000-0000-000000000001": "pagintoken",
            "00aaaaaa-0000-0000-0000-000000000001": "about pagintoken stuff",
        }
        expected: set[str] = set()
        for raw_id, body in note_bodies.items():
            db_session.add(
                NoteBlock(
                    id=UUID(raw_id),
                    user_id=bootstrapped_user,
                    body_pm_json={
                        "type": "paragraph",
                        "content": [{"type": "text", "text": body}],
                    },
                    body_text=body,
                )
            )
            expected.add(f"note_block:{raw_id}")
        for raw_id, title in page_titles.items():
            db_session.add(Page(id=UUID(raw_id), user_id=bootstrapped_user, title=title))
            expected.add(f"page:{raw_id}")
        db_session.flush()

        seen: list[str] = []
        cursor = None
        while True:
            response = search_targets(
                db_session,
                viewer_id=bootstrapped_user,
                request=_request(
                    purpose="reference",
                    q="pagintoken",
                    limit=2,
                    schemes=["note_block", "page"],
                    cursor=cursor,
                ),
            )
            seen.extend(t.item.ref for t in response.targets)
            if response.next_cursor is None:
                break
            cursor = response.next_cursor

        assert len(seen) == len(set(seen)), "no target may repeat across pages of one query"
        assert set(seen) == expected, "every admitted target must appear on exactly one page"


class TestRoute:
    def test_post_targets_search_returns_camelcase_envelope(
        self, auth_client, direct_db: DirectSessionManager
    ) -> None:
        user_id = create_test_user_id()
        me_response = auth_client.get("/me", headers=auth_headers(user_id))
        assert me_response.status_code == 200, me_response.text
        direct_db.register_cleanup("users", "id", user_id)
        direct_db.register_cleanup("libraries", "owner_user_id", user_id)
        direct_db.register_cleanup("memberships", "user_id", user_id)
        with direct_db.session() as session:
            library_id = get_user_default_library(session, user_id)
            assert library_id is not None
            media_id = create_test_media_in_library(
                session, user_id, library_id, title="Route Target"
            )
        direct_db.register_cleanup("media", "id", media_id)
        direct_db.register_cleanup("library_entries", "media_id", media_id)

        response = auth_client.post(
            "/resource-items/targets/search",
            json={"q": f"media:{media_id}", "purpose": "link", "limit": 5},
            headers=auth_headers(user_id),
        )

        assert response.status_code == 200
        data = response.json()["data"]
        assert data["nextCursor"] is None
        assert len(data["targets"]) == 1
        target = data["targets"][0]
        assert target["kind"] == "resource"
        assert target["existingLinkId"] is None
        assert target["item"]["ref"] == f"media:{media_id}"
        assert "userRelation" in target["item"]["capabilities"]

    def test_post_targets_search_serializes_passage_arm_camelcase(
        self, auth_client, direct_db: DirectSessionManager
    ) -> None:
        """The passage arm of the target union crosses the wire with camelCase
        keys (``candidateRef``), not just as Python dataclass attributes."""
        user_id = create_test_user_id()
        me_response = auth_client.get("/me", headers=auth_headers(user_id))
        assert me_response.status_code == 200, me_response.text
        direct_db.register_cleanup("users", "id", user_id)
        direct_db.register_cleanup("libraries", "owner_user_id", user_id)
        direct_db.register_cleanup("memberships", "user_id", user_id)
        with direct_db.session() as session:
            media_id = create_searchable_media(session, user_id, title="Passage Route Target")
            fragment_id = session.execute(
                select(Fragment.id).where(Fragment.media_id == media_id)
            ).scalar_one()
        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        response = auth_client.post(
            "/resource-items/targets/search",
            json={"q": f"fragment:{fragment_id}", "purpose": "link", "limit": 5},
            headers=auth_headers(user_id),
        )

        assert response.status_code == 200
        data = response.json()["data"]
        assert data["nextCursor"] is None
        assert len(data["targets"]) == 1
        target = data["targets"][0]
        assert target["kind"] == "passage"
        assert target["candidateRef"] == f"fragment:{fragment_id}"
        assert "candidate_ref" not in target
        assert target["existingLinkId"] is None
        assert target["source"]["ref"] == f"media:{media_id}"
        assert target["activation"]["resourceRef"] == f"fragment:{fragment_id}"
        assert target["excerpt"]
