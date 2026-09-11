"""Nexus selection history: which in-app destinations a selection may name."""

from __future__ import annotations

from uuid import UUID, uuid4

import pytest
from sqlalchemy.orm import Session

from nexus.errors import ApiError, ApiErrorCode
from nexus.schemas.nexus_history import NexusSelectionRecordRequest
from nexus.services.nexus_history import (
    get_history_for_viewer,
    record_selection_for_viewer,
)
from tests.testkit.auth import UserRecord


def _record(db: Session, viewer_id: UUID, href: str, label: str) -> None:
    record_selection_for_viewer(
        db,
        viewer_id,
        request=NexusSelectionRecordRequest(
            client_mutation_id=str(uuid4()),
            query="imports",
            target_href=href,
            label_snapshot=label,
            source="Static",
        ),
    )


def test_imports_is_a_recordable_nexus_destination_and_an_unknown_section_is_not(
    db_session: Session, test_user: UserRecord
) -> None:
    """Nexus resolves the same destination the rail does, so the pane route is
    recordable history; a section that is not a destination stays refused."""
    _record(db_session, test_user.id, "/imports?view=NeedsAttention", "Imports")

    recorded = get_history_for_viewer(db_session, test_user.id, query="imports")
    assert [row.target_href for row in recorded.recent] == ["/imports?view=NeedsAttention"], (
        "an Imports selection must be recorded with the pane state it named: "
        f"{[row.target_href for row in recorded.recent]!r}"
    )

    with pytest.raises(ApiError) as refused:
        _record(db_session, test_user.id, "/import-inbox", "Import inbox")
    assert refused.value.code is ApiErrorCode.E_INVALID_REQUEST, (
        f"/import-inbox is not a Nexus destination and must be refused, got {refused.value.code}"
    )
