"""Focused contract tests for bounded EPUB Find."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any
from uuid import UUID, uuid4

import pytest
from pydantic import ValidationError

from nexus.db.models import EpubNavLocation, Fragment, Media, MediaKind, ProcessingStatus
from nexus.schemas.epub_find import EpubFindRequest
from nexus.services.epub_find import MATCH_THRESHOLD, find_epub_for_viewer
from tests.factories import add_media_to_library
from tests.helpers import auth_headers, create_test_user_id
from tests.utils.db import DirectSessionManager

pytestmark = pytest.mark.integration

_SHARED_FIXTURE_PATH = (
    Path(__file__).resolve().parents[2] / "testdata" / "pane-find" / "canonical-text.json"
)
_SHARED_FIXTURE = json.loads(_SHARED_FIXTURE_PATH.read_text(encoding="utf-8"))
_SHARED_CASES = _SHARED_FIXTURE["cases"]


def _register_media_cleanup(direct_db: DirectSessionManager, media_id: UUID) -> None:
    direct_db.register_cleanup("media", "id", media_id)
    direct_db.register_cleanup("library_entries", "media_id", media_id)
    direct_db.register_cleanup("fragments", "media_id", media_id)
    direct_db.register_cleanup("epub_nav_locations", "media_id", media_id)


def _seed_media(
    direct_db: DirectSessionManager,
    units: list[tuple[str, str]],
    *,
    kind: str = MediaKind.epub.value,
    status: ProcessingStatus = ProcessingStatus.ready_for_reading,
    navigation: dict[str, list[tuple[str, str, int]]] | None = None,
) -> tuple[UUID, dict[str, tuple[UUID, int]]]:
    media_id = uuid4()
    _register_media_cleanup(direct_db, media_id)
    fragments: dict[str, tuple[UUID, int]] = {}

    with direct_db.session() as session:
        session.add(
            Media(
                id=media_id,
                kind=kind,
                title="EPUB Find Test",
                processing_status=status,
            )
        )
        for position, (unit_id, canonical_text) in enumerate(units):
            fragment_idx = position * 2
            fragment_id = uuid4()
            fragments[unit_id] = (fragment_id, fragment_idx)
            session.add(
                Fragment(
                    id=fragment_id,
                    media_id=media_id,
                    idx=fragment_idx,
                    canonical_text=canonical_text,
                    html_sanitized=f"<p>HTML must not enter Find: {unit_id}</p>",
                )
            )
            locations = (
                navigation[unit_id]
                if navigation is not None and unit_id in navigation
                else [(f"section-{unit_id}", f"Section {unit_id}", position)]
            )
            for location_id, label, ordinal in locations:
                session.add(
                    EpubNavLocation(
                        media_id=media_id,
                        location_id=location_id,
                        ordinal=ordinal,
                        source_node_id=None,
                        label=label,
                        fragment_idx=fragment_idx,
                        href_path=f"{unit_id}.xhtml",
                        href_fragment=None,
                        source="spine",
                    )
                )
        session.commit()

    return media_id, fragments


def _make_visible(
    auth_client: Any,
    direct_db: DirectSessionManager,
    user_id: UUID,
    media_id: UUID,
) -> None:
    response = auth_client.get("/me", headers=auth_headers(user_id))
    assert response.status_code == 200
    library_id = UUID(response.json()["data"]["default_library_id"])
    with direct_db.session() as session:
        add_media_to_library(session, library_id, media_id)
        session.commit()


def _find_body(
    witness: UUID,
    *,
    query: str,
    match_case: bool = False,
    whole_word: bool = False,
    scope: dict[str, str] | None = None,
) -> dict[str, object]:
    return {
        "source_witness_fragment_id": str(witness),
        "query": query,
        "match_case": match_case,
        "whole_word": whole_word,
        "scope": scope or {"kind": "EntireResource"},
    }


def _post_find(
    auth_client: Any,
    *,
    user_id: UUID,
    media_id: UUID,
    body: dict[str, object],
):
    return auth_client.post(
        f"/media/{media_id}/epub-find",
        headers=auth_headers(user_id),
        json=body,
    )


def test_request_contract_normalizes_before_codepoint_bounds_and_is_strict() -> None:
    witness = uuid4()
    request = EpubFindRequest.model_validate(
        {
            "source_witness_fragment_id": str(witness),
            "query": "e\u0301" * 256,
            "match_case": False,
            "whole_word": False,
            "scope": {"kind": "EntireResource"},
        }
    )
    assert request.query == "é" * 256
    assert len(request.query) == 256
    assert request.source_witness_fragment_id == witness

    base = {
        "source_witness_fragment_id": witness,
        "query": "x",
        "match_case": False,
        "whole_word": False,
        "scope": {"kind": "EntireResource"},
    }
    invalid_requests = [
        {**base, "query": ""},
        {**base, "query": "😀" * 257},
        {**base, "query": "x\ny"},
        {**base, "match_case": "false"},
        {**base, "unexpected": True},
        {**base, "scope": {"kind": "EntireResource", "section_id": "extra"}},
        {**base, "scope": {"kind": "Section"}},
    ]
    for invalid in invalid_requests:
        with pytest.raises(ValidationError):
            EpubFindRequest.model_validate(invalid)


@pytest.mark.parametrize("case", _SHARED_CASES, ids=lambda case: str(case["name"]))
def test_shared_canonical_text_contract(
    auth_client: Any,
    direct_db: DirectSessionManager,
    case: dict[str, Any],
) -> None:
    assert _SHARED_FIXTURE["version"] == 1
    units = [
        (str(unit["id"]), str(unit["text"]) * int(unit.get("repeat", 1))) for unit in case["units"]
    ]
    media_id, fragments = _seed_media(direct_db, units)
    user_id = create_test_user_id()
    _make_visible(auth_client, direct_db, user_id, media_id)
    first_witness = next(iter(fragments.values()))[0]

    response = _post_find(
        auth_client,
        user_id=user_id,
        media_id=media_id,
        body=_find_body(
            first_witness,
            query=str(case["query"]),
            match_case=bool(case["matchCase"]),
            whole_word=bool(case["wholeWord"]),
        ),
    )

    assert response.status_code == 200
    assert set(response.json()) == {"data"}
    data = response.json()["data"]
    expected = case["expected"]
    if expected["kind"] == "Ready":
        fragment_to_unit = {
            str(fragment_id): unit_id for unit_id, (fragment_id, _) in fragments.items()
        }
        actual_occurrences = [
            {
                "unitId": fragment_to_unit[row["fragment_id"]],
                "startCp": row["start_offset"],
                "endCp": row["end_offset"],
                "snippet": row["snippet"],
            }
            for row in data["occurrences"]
        ]
        assert actual_occurrences == expected["occurrences"]
        assert data["kind"] == "Ready"
        assert data["source_witness_fragment_id"] == str(first_witness)
        for row in data["occurrences"]:
            unit_id = fragment_to_unit[row["fragment_id"]]
            _, fragment_idx = fragments[unit_id]
            assert set(row) == {
                "section_id",
                "section_label",
                "fragment_id",
                "fragment_idx",
                "start_offset",
                "end_offset",
                "snippet",
            }
            assert row["section_id"] == f"section-{unit_id}"
            assert row["section_label"] == f"Section {unit_id}"
            assert row["fragment_idx"] == fragment_idx
    elif expected["kind"] == "NoMatches":
        assert data == {
            "kind": "NoMatches",
            "source_witness_fragment_id": str(first_witness),
        }
    else:
        assert data == {
            "kind": "TooManyMatches",
            "source_witness_fragment_id": str(first_witness),
            "threshold": expected["threshold"],
        }


def test_exact_match_threshold_still_returns_complete_ready_result(
    auth_client: Any,
    direct_db: DirectSessionManager,
) -> None:
    media_id, fragments = _seed_media(direct_db, [("limit", "x" * MATCH_THRESHOLD)])
    user_id = create_test_user_id()
    _make_visible(auth_client, direct_db, user_id, media_id)
    witness = fragments["limit"][0]

    response = _post_find(
        auth_client,
        user_id=user_id,
        media_id=media_id,
        body=_find_body(witness, query="x", match_case=True),
    )

    assert response.status_code == 200
    data = response.json()["data"]
    assert data["kind"] == "Ready"
    assert len(data["occurrences"]) == MATCH_THRESHOLD
    assert data["occurrences"][0]["start_offset"] == 0
    assert data["occurrences"][-1]["end_offset"] == MATCH_THRESHOLD


def test_section_scope_requires_unique_fragment_ownership_and_whole_book_deduplicates(
    auth_client: Any,
    direct_db: DirectSessionManager,
) -> None:
    media_id, fragments = _seed_media(
        direct_db,
        [("shared", "find"), ("sole", "find")],
        navigation={
            "shared": [
                ("shared-later", "Shared later", 2),
                ("shared-first", "Shared first", 0),
            ],
            "sole": [("sole-section", "Sole section", 1)],
        },
    )
    user_id = create_test_user_id()
    _make_visible(auth_client, direct_db, user_id, media_id)
    witness = fragments["shared"][0]

    whole_book = _post_find(
        auth_client,
        user_id=user_id,
        media_id=media_id,
        body=_find_body(witness, query="find"),
    )
    assert whole_book.status_code == 200
    occurrences = whole_book.json()["data"]["occurrences"]
    assert [(row["section_id"], row["section_label"]) for row in occurrences] == [
        ("shared-first", "Shared first"),
        ("sole-section", "Sole section"),
    ]

    sole_section = _post_find(
        auth_client,
        user_id=user_id,
        media_id=media_id,
        body=_find_body(
            witness,
            query="find",
            scope={"kind": "Section", "section_id": "sole-section"},
        ),
    )
    assert sole_section.status_code == 200
    assert [row["section_id"] for row in sole_section.json()["data"]["occurrences"]] == [
        "sole-section"
    ]

    for invalid_section in ("shared-first", "missing"):
        invalid = _post_find(
            auth_client,
            user_id=user_id,
            media_id=media_id,
            body=_find_body(
                witness,
                query="find",
                scope={"kind": "Section", "section_id": invalid_section},
            ),
        )
        assert invalid.status_code == 400
        assert invalid.json()["error"]["code"] == "E_INVALID_REQUEST"


def test_source_witness_must_be_the_current_first_fragment(
    auth_client: Any,
    direct_db: DirectSessionManager,
) -> None:
    media_id, fragments = _seed_media(direct_db, [("first", "find"), ("second", "find")])
    user_id = create_test_user_id()
    _make_visible(auth_client, direct_db, user_id, media_id)

    for stale_witness in (uuid4(), fragments["second"][0]):
        response = _post_find(
            auth_client,
            user_id=user_id,
            media_id=media_id,
            body=_find_body(stale_witness, query="find"),
        )
        assert response.status_code == 409
        assert response.json()["error"]["code"] == "E_EPUB_FIND_SOURCE_CHANGED"


def test_guard_order_masks_visibility_before_kind_and_readiness(
    auth_client: Any,
    direct_db: DirectSessionManager,
) -> None:
    unreadable_id, unreadable_fragments = _seed_media(direct_db, [("hidden", "find")])
    hidden_wrong_kind_id, hidden_wrong_kind_fragments = _seed_media(
        direct_db,
        [("hidden-wrong-kind", "find")],
        kind=MediaKind.web_article.value,
    )
    hidden_pending_id, hidden_pending_fragments = _seed_media(
        direct_db,
        [("hidden-pending", "find")],
        status=ProcessingStatus.pending,
    )
    wrong_kind_id, wrong_kind_fragments = _seed_media(
        direct_db,
        [("article", "find")],
        kind=MediaKind.web_article.value,
    )
    pending_id, pending_fragments = _seed_media(
        direct_db,
        [("pending", "find")],
        status=ProcessingStatus.pending,
    )
    user_id = create_test_user_id()
    _make_visible(auth_client, direct_db, user_id, wrong_kind_id)
    _make_visible(auth_client, direct_db, user_id, pending_id)

    cases = [
        (unreadable_id, unreadable_fragments["hidden"][0], 404, "E_MEDIA_NOT_FOUND"),
        (
            hidden_wrong_kind_id,
            hidden_wrong_kind_fragments["hidden-wrong-kind"][0],
            404,
            "E_MEDIA_NOT_FOUND",
        ),
        (
            hidden_pending_id,
            hidden_pending_fragments["hidden-pending"][0],
            404,
            "E_MEDIA_NOT_FOUND",
        ),
        (wrong_kind_id, wrong_kind_fragments["article"][0], 400, "E_INVALID_KIND"),
        (pending_id, pending_fragments["pending"][0], 409, "E_MEDIA_NOT_READY"),
    ]
    for media_id, witness, status, code in cases:
        response = _post_find(
            auth_client,
            user_id=user_id,
            media_id=media_id,
            body=_find_body(witness, query="find"),
        )
        assert response.status_code == status
        assert response.json()["error"]["code"] == code


def test_python_platform_local_case_and_word_boundaries(
    auth_client: Any,
    direct_db: DirectSessionManager,
) -> None:
    media_id, fragments = _seed_media(direct_db, [("local", "İ ß 中文分词")])
    user_id = create_test_user_id()
    _make_visible(auth_client, direct_db, user_id, media_id)
    witness = fragments["local"][0]

    cases = [
        ("i", False, "Ready", [(0, 1)]),
        ("ss", False, "NoMatches", []),
        ("中", True, "Ready", [(4, 5)]),
    ]
    for query, whole_word, expected_kind, expected_offsets in cases:
        response = _post_find(
            auth_client,
            user_id=user_id,
            media_id=media_id,
            body=_find_body(witness, query=query, whole_word=whole_word),
        )
        assert response.status_code == 200
        data = response.json()["data"]
        assert data["kind"] == expected_kind
        actual_offsets = [
            (row["start_offset"], row["end_offset"]) for row in data.get("occurrences", [])
        ]
        assert actual_offsets == expected_offsets


def test_current_fragment_without_navigation_is_a_service_defect(
    auth_client: Any,
    direct_db: DirectSessionManager,
) -> None:
    media_id, fragments = _seed_media(direct_db, [("orphan", "find")], navigation={"orphan": []})
    user_id = create_test_user_id()
    _make_visible(auth_client, direct_db, user_id, media_id)
    request = EpubFindRequest.model_validate(
        _find_body(fragments["orphan"][0], query="find")
        | {"source_witness_fragment_id": fragments["orphan"][0]}
    )

    with direct_db.session() as session:
        with pytest.raises(
            AssertionError,
            match="Current EPUB fragment has no canonical navigation target",
        ):
            find_epub_for_viewer(session, user_id, media_id, request)
