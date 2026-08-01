"""Real-PostgreSQL/API proof for bounded Openables retrieval and timing."""

from __future__ import annotations

import re
from uuid import uuid4

from fastapi.testclient import TestClient
from sqlalchemy import Engine, event
from sqlalchemy.orm import Session

from nexus.schemas.notes import CreatePageRequest
from nexus.services import note_bodies, notes
from nexus.services.bootstrap import ensure_user_and_default_library
from nexus.services.resource_items.openables import OPENABLE_SEARCH_RESULT_LIMIT
from tests.testkit.auth import UserRecord


def test_openables_decodes_visible_pages_and_notes_in_one_bounded_candidate_query(
    authenticated_client: TestClient,
    engine: Engine,
    db_session: Session,
    test_user: UserRecord,
) -> None:
    query = "openables keystone"
    page_id = uuid4()
    note_id = uuid4()
    notes.create_page(
        db_session,
        test_user.id,
        CreatePageRequest(page_id=page_id, title=query),
    )
    note_bodies.upsert_note_body(
        db_session,
        viewer_id=test_user.id,
        block_id=note_id,
        body_pm_json=note_bodies.pm_doc_from_text(query),
    )
    for index in range(19):
        notes.create_page(
            db_session,
            test_user.id,
            CreatePageRequest(page_id=uuid4(), title=f"Extra {query} {index:02d}"),
        )

    foreign_user_id = uuid4()
    ensure_user_and_default_library(
        db_session,
        foreign_user_id,
        f"openables-foreign-{foreign_user_id}@example.invalid",
    )
    foreign_page_id = uuid4()
    foreign_note_id = uuid4()
    notes.create_page(
        db_session,
        foreign_user_id,
        CreatePageRequest(page_id=foreign_page_id, title=query),
    )
    note_bodies.upsert_note_body(
        db_session,
        viewer_id=foreign_user_id,
        block_id=foreign_note_id,
        body_pm_json=note_bodies.pm_doc_from_text(query),
    )

    statements: list[str] = []

    def capture_statement(
        _connection: object,
        _cursor: object,
        statement: str,
        _parameters: object,
        _context: object,
        _executemany: bool,
    ) -> None:
        statements.append(" ".join(statement.split()))

    event.listen(engine, "before_cursor_execute", capture_statement)
    try:
        response = authenticated_client.post(
            "/resource-items/openables/search",
            json={
                "q": query,
                "schemes": {"kind": "Present", "value": ["page", "note_block"]},
            },
        )
    finally:
        event.remove(engine, "before_cursor_execute", capture_statement)

    assert response.status_code == 200, f"Openables service request failed: {response.text}"
    items = response.json()["data"]["items"]
    assert len(items) == OPENABLE_SEARCH_RESULT_LIMIT, (
        f"Openables returned {len(items)} items beyond its exact bounded result contract"
    )
    by_ref = {item["ref"]: item for item in items}
    page_ref = f"page:{page_id}"
    note_ref = f"note_block:{note_id}"
    page_item = by_ref.get(page_ref)
    note_item = by_ref.get(note_ref)
    assert page_item is not None, (
        f"Openables omitted representative Page {page_ref}; returned refs={sorted(by_ref)}"
    )
    assert note_item is not None, (
        f"Openables omitted representative NoteBlock {note_ref}; returned refs={sorted(by_ref)}"
    )
    assert page_item["label"] == query, (
        f"Openables decoded the representative Page incorrectly: {page_item!r}"
    )
    assert note_item["label"] == query, (
        f"Openables decoded the representative NoteBlock incorrectly: {note_item!r}"
    )
    assert (
        f"page:{foreign_page_id}" not in by_ref and f"note_block:{foreign_note_id}" not in by_ref
    ), f"Openables exposed a foreign resource to {test_user.id}: {sorted(by_ref)}"

    candidate_statements = [
        statement for statement in statements if "direct_candidates" in statement
    ]
    assert len(candidate_statements) == 1, (
        "Openables must retrieve its independently bounded candidate sources in one statement; "
        f"observed {len(candidate_statements)} candidate statements"
    )
    candidate_statement = candidate_statements[0]
    assert (
        candidate_statement.startswith(("SELECT ", "WITH "))
        and candidate_statement.count(" UNION ALL ") == 1
    ), f"Openables candidate statement lost its two-source UNION ALL shape: {candidate_statement}"

    timing_parts = [part.strip() for part in response.headers["server-timing"].split(",")]
    timing_matches = [
        re.fullmatch(r"(nexus_[a-z]+);dur=([0-9]+[.][0-9]{2})", part) for part in timing_parts
    ]
    assert all(match is not None for match in timing_matches), (
        f"FastAPI Openables timing lost exact nonnegative two-decimal phases: {timing_parts!r}"
    )
    timing_phases = [match.group(1) for match in timing_matches if match is not None]
    assert timing_phases == ["nexus_api", "nexus_openables", "nexus_auth"], (
        f"FastAPI Openables timing phases were reordered or omitted: {timing_parts!r}"
    )
