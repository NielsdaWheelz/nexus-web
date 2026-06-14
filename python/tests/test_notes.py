from __future__ import annotations

from datetime import date
from uuid import UUID, uuid4

import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session

from nexus.db.models import NoteBlock, Page, ResourceEdge, ResourceVersion
from nexus.schemas.notes import CreatePageRequest, QuickCaptureRequest
from nexus.services import notes
from nexus.services.resource_graph.adjacency import OrderedTarget, replace_ordered_targets
from nexus.services.resource_graph.refs import ResourceRef

pytestmark = pytest.mark.unit


def _paragraph(text: str) -> dict[str, object]:
    return {"type": "paragraph", "content": [{"type": "text", "text": text}]}


def test_page_and_note_rows_are_intrinsic_only() -> None:
    assert not hasattr(Page, "description")
    assert not hasattr(Page, "document_version")
    assert not hasattr(NoteBlock, "block_kind")
    assert not hasattr(NoteBlock, "body_markdown")


def test_quick_capture_links_note_to_daily_page(
    db_session: Session,
    bootstrapped_user: UUID,
) -> None:
    block_id = uuid4()
    block = notes.quick_capture(
        db_session,
        bootstrapped_user,
        request=QuickCaptureRequest(
            id=block_id,
            client_mutation_id="quick-1",
            local_date=date(2026, 6, 13),
            body_pm_json=_paragraph("captured"),
        ),
    )

    assert block.id == block_id
    assert block.body_text == "captured"
    edge = db_session.scalar(
        select(ResourceEdge).where(
            ResourceEdge.user_id == bootstrapped_user,
            ResourceEdge.origin == "user",
            ResourceEdge.source_scheme == "page",
            ResourceEdge.target_scheme == "note_block",
            ResourceEdge.target_id == block_id,
            ResourceEdge.source_order_key.is_not(None),
        )
    )
    assert edge is not None
    assert db_session.scalar(
        select(ResourceVersion).where(
            ResourceVersion.user_id == bootstrapped_user,
            ResourceVersion.resource_scheme == "note_block",
            ResourceVersion.resource_id == block_id,
            ResourceVersion.lane == "body",
        )
    )


def test_get_note_block_is_body_only(
    db_session: Session,
    bootstrapped_user: UUID,
) -> None:
    block_id = uuid4()
    notes.quick_capture(
        db_session,
        bootstrapped_user,
        request=QuickCaptureRequest(
            id=block_id,
            client_mutation_id="quick-1",
            body_pm_json=_paragraph("standalone"),
        ),
    )

    block = notes.get_note_block(db_session, bootstrapped_user, block_id)

    assert block.id == block_id
    assert block.body_text == "standalone"
    assert "pageId" not in block.model_dump(mode="json", by_alias=True)


def test_delete_page_leaves_linked_note_alive(
    db_session: Session,
    bootstrapped_user: UUID,
) -> None:
    page = notes.create_page(db_session, bootstrapped_user, CreatePageRequest(title="Page"))
    block_id = uuid4()
    notes.quick_capture(
        db_session,
        bootstrapped_user,
        request=QuickCaptureRequest(
            id=block_id,
            client_mutation_id="quick-1",
            body_pm_json=_paragraph("survives"),
        ),
    )
    replace_ordered_targets(
        db_session,
        user_id=bootstrapped_user,
        source=ResourceRef(scheme="page", id=page.id),
        targets=[
            OrderedTarget(
                target=ResourceRef(scheme="note_block", id=block_id),
                source_order_key="0000000001",
            )
        ],
    )
    db_session.commit()

    notes.delete_page(db_session, bootstrapped_user, page.id)

    assert db_session.get(NoteBlock, block_id) is not None
    assert not db_session.scalars(
        select(ResourceEdge).where(
            ResourceEdge.user_id == bootstrapped_user,
            ResourceEdge.source_scheme == "page",
            ResourceEdge.source_id == page.id,
        )
    ).all()
