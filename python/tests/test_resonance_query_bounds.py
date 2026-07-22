"""Query-bound evidence for the Resonance read owner.

These integration tests measure public service calls through SQLAlchemy's
execution boundary. They intentionally avoid source inspection: the guard is
the number and mutability of statements the database actually receives.
"""

from __future__ import annotations

from collections.abc import Callable
from datetime import timedelta
from typing import Any
from uuid import UUID

import pytest
from sqlalchemy import event, text
from sqlalchemy.orm import Session

from nexus.db.models import ReaderEngagementState
from nexus.ids import new_uuid7
from nexus.services.resonance import service as resonance_service
from tests.factories import (
    create_searchable_media,
    create_test_media_in_library,
    get_user_default_library,
)

pytestmark = pytest.mark.integration

# Deliberately close to the structural maximum, not a loose timeout proxy:
# capacity/asOf (2), the three anchor owners plus three possible anchor schemes
# (6), two non-relational lanes + graph + authors + target facts (5), up to five
# calibrated ANN anchors (5), and mixed media/podcast hydration (3) total 21.
# Three queries of headroom tolerate an owner port's constant-shape refinement;
# any row-, candidate-, or corpus-proportional loop still fails this ceiling.
_SERVICE_QUERY_UPPER_BOUND = 24


def _capture_queries(
    db: Session, operation: Callable[[], object]
) -> tuple[object, list[tuple[str, Any]]]:
    statements: list[tuple[str, Any]] = []
    connection = db.connection()

    def capture(
        _conn: object,
        _cursor: object,
        statement: str,
        parameters: Any,
        _context: object,
        _executemany: bool,
    ) -> None:
        statements.append((statement, parameters))

    event.listen(connection, "before_cursor_execute", capture)
    try:
        result = operation()
    finally:
        event.remove(connection, "before_cursor_execute", capture)
    return result, statements


def _assert_read_only_and_bounded(statements: list[tuple[str, Any]]) -> None:
    assert len(statements) <= _SERVICE_QUERY_UPPER_BOUND, {
        "actual": len(statements),
        "upper_bound": _SERVICE_QUERY_UPPER_BOUND,
    }
    for statement, _ in statements:
        normalized = statement.upper()
        assert "INSERT INTO" not in normalized
        assert "UPDATE " not in normalized
        assert "DELETE FROM" not in normalized


def _add_visible_media(
    db: Session,
    *,
    viewer_id: UUID,
    library_id: UUID,
    title: str,
) -> UUID:
    media_id = create_test_media_in_library(
        db,
        viewer_id,
        library_id,
        title=title,
    )
    _stabilize_creation_before_snapshot(
        db,
        media_id=media_id,
        library_id=library_id,
    )
    return media_id


def _stabilize_creation_before_snapshot(
    db: Session,
    *,
    media_id: UUID,
    library_id: UUID,
) -> None:
    # The integration fixture holds one outer transaction open. PostgreSQL
    # ``now()`` is that transaction's start, while ORM defaults use wall-clock
    # time; pin setup rows just before the database snapshot so the test models
    # a real fresh request transaction instead of manufacturing future facts.
    database_now = db.execute(text("SELECT now()")).scalar_one()
    created_at = database_now - timedelta(seconds=1)
    db.execute(
        text("UPDATE media SET created_at = :created_at WHERE id = :media_id"),
        {"created_at": created_at, "media_id": media_id},
    )
    db.execute(
        text(
            "UPDATE library_entries SET created_at = :created_at"
            " WHERE library_id = :library_id AND media_id = :media_id"
        ),
        {
            "created_at": created_at,
            "library_id": library_id,
            "media_id": media_id,
        },
    )
    db.commit()


def _add_engaged_media(
    db: Session,
    *,
    viewer_id: UUID,
    library_id: UUID,
    ordinal: int,
) -> UUID:
    if ordinal <= 2:
        media_id = create_searchable_media(
            db,
            viewer_id,
            title=f"Anchor {ordinal:02d}",
        )
        _stabilize_creation_before_snapshot(
            db,
            media_id=media_id,
            library_id=library_id,
        )
    else:
        media_id = _add_visible_media(
            db,
            viewer_id=viewer_id,
            library_id=library_id,
            title=f"Anchor {ordinal:02d}",
        )
    database_now = db.execute(text("SELECT now()")).scalar_one()
    db.add(
        ReaderEngagementState(
            id=new_uuid7(),
            user_id=viewer_id,
            media_id=media_id,
            last_engaged_at=database_now - timedelta(minutes=ordinal),
            max_total_progression=0.4,
        )
    )
    db.commit()
    return media_id


def test_lectern_slate_has_fixed_query_ceiling_at_zero_one_five_and_many_anchors(
    db_session: Session,
    bootstrapped_user: UUID,
) -> None:
    default_library_id = get_user_default_library(db_session, bootstrapped_user)
    assert default_library_id is not None

    counts: dict[str, int] = {}
    _, statements = _capture_queries(
        db_session,
        lambda: resonance_service.build_lectern_slate(db_session, viewer_id=bootstrapped_user),
    )
    counts["zero"] = len(statements)
    _assert_read_only_and_bounded(statements)

    for ordinal in range(1, 13):
        _add_engaged_media(
            db_session,
            viewer_id=bootstrapped_user,
            library_id=default_library_id,
            ordinal=ordinal,
        )
        if ordinal not in (1, 5, 12):
            continue
        slate, statements = _capture_queries(
            db_session,
            lambda: resonance_service.build_lectern_slate(db_session, viewer_id=bootstrapped_user),
        )
        assert len(slate.items) <= 10
        counts[str(ordinal)] = len(statements)
        _assert_read_only_and_bounded(statements)

    for ordinal in range(30):
        _add_visible_media(
            db_session,
            viewer_id=bootstrapped_user,
            library_id=default_library_id,
            title=f"Candidate {ordinal:02d}",
        )
    slate, statements = _capture_queries(
        db_session,
        lambda: resonance_service.build_lectern_slate(db_session, viewer_id=bootstrapped_user),
    )
    assert len(slate.items) == 10
    counts["many_candidates"] = len(statements)
    _assert_read_only_and_bounded(statements)

    assert counts["zero"] <= counts["1"] <= counts["5"]
    assert counts["5"] == counts["12"] == counts["many_candidates"]
