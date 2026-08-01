"""Integration contracts for bounded, route-only openable-resource search."""

from __future__ import annotations

import re
from uuid import UUID, uuid4

import pytest
from pydantic import ValidationError
from sqlalchemy import event, func, select, text
from sqlalchemy.orm import Session

from nexus.db.models import NexusUsage, Page, PassageAnchor, ResourceEdge
from nexus.schemas.presence import Absent, Present
from nexus.schemas.resource_openables import ResourceOpenableSearchRequest
from nexus.services.bootstrap import ensure_user_and_default_library
from nexus.services.resource_items import openables
from nexus.services.resource_items.openables import (
    OPENABLE_SEARCH_RESULT_LIMIT,
    search_openable_resources,
)
from tests.helpers import auth_headers, create_test_user_id
from tests.utils.db import DirectSessionManager

pytestmark = pytest.mark.integration


def _request(
    q: str, schemes: Absent | Present[list[str]] | None = None
) -> ResourceOpenableSearchRequest:
    return ResourceOpenableSearchRequest(q=q, schemes=schemes or Absent())


def _page(db: Session, user_id: UUID, title: str) -> Page:
    page = Page(id=uuid4(), user_id=user_id, title=title)
    db.add(page)
    db.flush()
    return page


def test_request_requires_trimmed_query_and_explicit_unique_presence() -> None:
    with pytest.raises(ValidationError):
        ResourceOpenableSearchRequest.model_validate({"q": "term"})
    with pytest.raises(ValidationError):
        ResourceOpenableSearchRequest(q="   ", schemes=Absent())
    with pytest.raises(ValidationError):
        ResourceOpenableSearchRequest(q="x" * 501, schemes=Absent())
    with pytest.raises(ValidationError):
        ResourceOpenableSearchRequest(q="term", schemes=Present(value=[]))
    with pytest.raises(ValidationError):
        ResourceOpenableSearchRequest(
            q="term",
            schemes=Present(value=["page", "page"]),
        )

    request = ResourceOpenableSearchRequest(
        q="  term  ",
        schemes=Present(value=["page", "library"]),
    )
    assert request.q == "term"
    assert request.schemes.value == ["page", "library"]


def test_one_character_search_scopes_dedupes_and_limits_before_projection(
    db_session: Session,
    bootstrapped_user: UUID,
) -> None:
    expected_ids = {
        _page(db_session, bootstrapped_user, f"Openable page {index:02d}").id
        for index in range(OPENABLE_SEARCH_RESULT_LIMIT + 5)
    }
    db_session.commit()

    response = search_openable_resources(
        db_session,
        viewer_id=bootstrapped_user,
        request=_request("o", Present(value=["page"])),
    )

    assert len(response.items) == OPENABLE_SEARCH_RESULT_LIMIT
    assert len({item.ref for item in response.items}) == len(response.items)
    assert {item.id for item in response.items} <= expected_ids
    assert {item.scheme for item in response.items} == {"page"}
    assert all(item.activation.kind == "route" for item in response.items)


def test_openables_calls_candidate_owner_exactly_once(
    db_session: Session,
    bootstrapped_user: UUID,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _page(db_session, bootstrapped_user, "Single candidate pass")
    db_session.commit()
    calls: list[dict[str, object]] = []
    actual = openables.reference_candidates

    def tracked(*args, **kwargs):
        calls.append(dict(kwargs))
        return actual(*args, **kwargs)

    monkeypatch.setattr(openables, "reference_candidates", tracked)
    search_openable_resources(
        db_session,
        viewer_id=bootstrapped_user,
        request=_request("s", Present(value=["page"])),
    )

    assert calls == [
        {
            "q": "s",
            "schemes": {"page"},
            "limit_per_source": OPENABLE_SEARCH_RESULT_LIMIT,
        }
    ]


def test_empty_openables_batches_all_candidate_sources_into_one_statement(
    db_session: Session,
    bootstrapped_user: UUID,
) -> None:
    statements: list[str] = []

    def observe(
        _connection,
        _cursor,
        statement: str,
        _parameters: object,
        _context,
        _executemany: bool,
    ) -> None:
        if statement.lstrip().upper().startswith(("SELECT", "WITH")):
            statements.append(statement)

    bind = db_session.get_bind()
    event.listen(bind, "before_cursor_execute", observe)
    try:
        response = search_openable_resources(
            db_session,
            viewer_id=bootstrapped_user,
            request=_request("definitely-absent-openable"),
        )
    finally:
        event.remove(bind, "before_cursor_execute", observe)

    assert response.items == []
    assert len(statements) == 1
    assert sum("UNION ALL" in statement for statement in statements) == 1


def test_openables_sql_count_is_row_bounded_and_candidate_plan_executes(
    db_session: Session,
    bootstrapped_user: UUID,
) -> None:
    _page(db_session, bootstrapped_user, "Bounded single needle")
    for index in range(25):
        _page(db_session, bootstrapped_user, f"Bounded many needle {index:02d}")
    db_session.commit()

    captured_candidate: tuple[str, object] | None = None

    def run_counted(query: str, *, capture_plan: bool = False) -> int:
        nonlocal captured_candidate
        statement_count = 0

        def observe(
            _connection,
            _cursor,
            statement: str,
            parameters: object,
            _context,
            _executemany: bool,
        ) -> None:
            nonlocal statement_count, captured_candidate
            statement_count += 1
            if capture_plan and "FROM pages p" in statement and "ILIKE" in statement:
                captured_candidate = (statement, parameters)

        db_session.rollback()
        bind = db_session.get_bind()
        event.listen(bind, "before_cursor_execute", observe)
        try:
            search_openable_resources(
                db_session,
                viewer_id=bootstrapped_user,
                request=_request(query, Present(value=["page"])),
            )
        finally:
            event.remove(bind, "before_cursor_execute", observe)
        return statement_count

    one_count = run_counted("bounded single needle")
    many_count = run_counted("bounded many needle", capture_plan=True)
    assert one_count == many_count
    assert many_count <= 10
    assert captured_candidate is not None

    statement, parameters = captured_candidate
    plan = (
        db_session.connection()
        .exec_driver_sql(
            f"EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) {statement}",
            parameters,
        )
        .scalar_one()
    )
    assert isinstance(plan, list) and plan
    assert plan[0]["Plan"]["Actual Loops"] >= 1
    assert plan[0]["Execution Time"] >= 0


def test_exact_ref_masks_hidden_missing_and_non_route_activation(
    db_session: Session,
    bootstrapped_user: UUID,
) -> None:
    visible = _page(db_session, bootstrapped_user, "Exact visible page")
    outsider = uuid4()
    ensure_user_and_default_library(db_session, outsider)
    hidden = _page(db_session, outsider, "Exact hidden page")
    external_id = db_session.execute(
        text(
            """
            INSERT INTO resource_external_snapshots (
                user_id, provider, url, title, snippet, source_snapshot
            )
            VALUES (
                :user_id, 'web', 'https://example.com/openable-exclusion',
                'External result', 'External result', '{}'::jsonb
            )
            RETURNING id
            """
        ),
        {"user_id": bootstrapped_user},
    ).scalar_one()
    db_session.commit()

    visible_response = search_openable_resources(
        db_session,
        viewer_id=bootstrapped_user,
        request=_request(f"page:{visible.id}"),
    )
    assert [item.ref for item in visible_response.items] == [f"page:{visible.id}"]

    for ref in (
        f"page:{hidden.id}",
        f"page:{uuid4()}",
        f"external_snapshot:{external_id}",
    ):
        assert (
            search_openable_resources(
                db_session,
                viewer_id=bootstrapped_user,
                request=_request(ref),
            ).items
            == []
        )


def test_search_performs_no_resource_history_or_passage_writes(
    db_session: Session,
    bootstrapped_user: UUID,
) -> None:
    _page(db_session, bootstrapped_user, "Readonly openable")
    db_session.commit()
    before = (
        db_session.scalar(select(func.count()).select_from(ResourceEdge)),
        db_session.scalar(select(func.count()).select_from(PassageAnchor)),
        db_session.scalar(select(func.count()).select_from(NexusUsage)),
    )

    search_openable_resources(
        db_session,
        viewer_id=bootstrapped_user,
        request=_request("r"),
    )

    after = (
        db_session.scalar(select(func.count()).select_from(ResourceEdge)),
        db_session.scalar(select(func.count()).select_from(PassageAnchor)),
        db_session.scalar(select(func.count()).select_from(NexusUsage)),
    )
    assert after == before


def test_route_returns_exact_camel_resource_item_wire(
    auth_client,
    direct_db: DirectSessionManager,
) -> None:
    user_id = create_test_user_id()
    assert auth_client.get("/me", headers=auth_headers(user_id)).status_code == 200
    page_id = uuid4()
    with direct_db.session() as db:
        db.add(Page(id=page_id, user_id=user_id, title="Wire openable"))
        db.commit()
    direct_db.register_cleanup("pages", "id", page_id)

    response = auth_client.post(
        "/resource-items/openables/search",
        headers=auth_headers(user_id),
        json={"q": f"page:{page_id}", "schemes": {"kind": "Absent"}},
    )

    assert response.status_code == 200, response.text
    assert set(response.json()["data"]) == {"items"}
    item = response.json()["data"]["items"][0]
    assert item["ref"] == f"page:{page_id}"
    assert item["activation"]["resourceRef"] == item["ref"]
    assert "resource_ref" not in item["activation"]
    assert "userRelation" in item["capabilities"]
    assert "versionByLane" in item
    assert re.fullmatch(
        r"nexus_api;dur=\d+\.\d{2}, "
        r"nexus_openables;dur=\d+\.\d{2}, "
        r"nexus_auth;dur=\d+\.\d{2}",
        response.headers["Server-Timing"],
    )
