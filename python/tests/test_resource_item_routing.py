"""Focused parity and query-bound tests for resource activation routing."""

from uuid import uuid4

import pytest
from sqlalchemy import event, select, text
from sqlalchemy.orm import Session

from nexus.db.models import Fragment
from nexus.schemas.reader_apparatus import ReaderApparatusLocatorStatus
from nexus.services.bootstrap import ensure_user_and_default_library
from nexus.services.reader_apparatus import replace_media_apparatus, source_fingerprint
from nexus.services.resource_graph.refs import ResourceRef
from nexus.services.resource_items.routing import (
    resource_activation_for_ref,
    resource_activations_for_refs,
    route_for_visible_apparatus_item,
)
from tests.factories import (
    create_pdf_media_with_text,
    create_searchable_media,
    create_test_conversation_with_message,
    create_test_highlight,
)
from tests.helpers import create_test_user_id

pytestmark = pytest.mark.integration


@pytest.mark.parametrize(
    ("locator_present", "locator_status", "locator_current", "routeable"),
    [
        (True, "exact", True, True),
        (True, "container", True, True),
        (False, "missing", False, False),
        (True, "exact", False, False),
    ],
)
def test_visible_apparatus_route_policy_matches_evidence_resolution(
    locator_present: bool,
    locator_status: ReaderApparatusLocatorStatus,
    locator_current: bool,
    routeable: bool,
) -> None:
    media_id = uuid4()
    item_id = uuid4()

    route = route_for_visible_apparatus_item(
        media_id=media_id,
        item_id=item_id,
        stable_key="target",
        locator_present=locator_present,
        locator_status=locator_status,
        locator_current=locator_current,
    )

    if routeable:
        assert route == f"/media/{media_id}?apparatus=target&apparatus_id={item_id}"
    else:
        assert route is None


def test_batched_reader_resource_routes_match_single_owner_with_bounded_queries(
    db_session: Session,
) -> None:
    user_id = create_test_user_id()
    library_id = ensure_user_and_default_library(db_session, user_id)
    media_id = create_searchable_media(db_session, user_id, title="Routing parity")
    fragment = db_session.scalar(select(Fragment).where(Fragment.media_id == media_id))
    assert fragment is not None
    highlight_id = create_test_highlight(
        db_session,
        user_id,
        fragment.id,
        exact="This",
    )
    _conversation_id, message_id = create_test_conversation_with_message(db_session, user_id)
    _other_conversation_id, other_message_id = create_test_conversation_with_message(
        db_session,
        user_id,
    )
    stale_fragment_id = uuid4()
    exact_item = {
        "stable_key": "target",
        "kind": "footnote",
        "label": "1",
        "body_text": "Source note",
        "body_html_sanitized": None,
        "locator": {
            "type": "web_text_offsets",
            "media_id": str(media_id),
            "fragment_id": str(fragment.id),
            "start_offset": 0,
            "end_offset": 1,
        },
        "confidence": "exact",
        "extraction_method": "test",
        "source_ref": {},
        "sort_key": "000000.target",
    }
    stale_item = {
        **exact_item,
        "stable_key": "stale-target",
        "locator": {
            **exact_item["locator"],
            "fragment_id": str(stale_fragment_id),
        },
        "sort_key": "000001.stale-target",
    }
    replace_media_apparatus(
        db_session,
        media_id=media_id,
        media_kind="web_article",
        source_fingerprint_value=source_fingerprint("route-parity", media_id),
        items=[exact_item, stale_item],
        edges=[],
    )
    pdf_media_id = create_pdf_media_with_text(
        db_session,
        user_id,
        library_id,
        plain_text="One current page",
        page_count=1,
    )
    pdf_item = {
        "stable_key": "pdf-current",
        "kind": "footnote",
        "label": "PDF current",
        "body_text": "Current page target",
        "body_html_sanitized": None,
        "locator": {
            "type": "pdf_page_geometry",
            "media_id": str(pdf_media_id),
            "page_number": 1,
            "quads": [
                {
                    "x1": 10,
                    "y1": 10,
                    "x2": 20,
                    "y2": 10,
                    "x3": 20,
                    "y3": 20,
                    "x4": 10,
                    "y4": 20,
                }
            ],
            "exact": "current",
        },
        "confidence": "exact",
        "extraction_method": "test",
        "source_ref": {},
        "sort_key": "000000.pdf-current",
    }
    replace_media_apparatus(
        db_session,
        media_id=pdf_media_id,
        media_kind="pdf",
        source_fingerprint_value=source_fingerprint("route-parity-pdf", pdf_media_id),
        items=[
            pdf_item,
            {
                **pdf_item,
                "stable_key": "pdf-stale",
                "locator": {**pdf_item["locator"], "page_number": 2},
                "sort_key": "000001.pdf-stale",
            },
        ],
        edges=[],
    )
    apparatus_ids = dict(
        db_session.execute(
            text(
                """
            SELECT stable_key, id FROM reader_apparatus_items
            WHERE media_id = :media_id
            """
            ),
            {"media_id": media_id},
        ).all()
    )
    assert set(apparatus_ids) == {"target", "stale-target"}
    pdf_apparatus_ids = dict(
        db_session.execute(
            text(
                """
            SELECT stable_key, id FROM reader_apparatus_items
            WHERE media_id = :media_id
            """
            ),
            {"media_id": pdf_media_id},
        ).all()
    )
    assert set(pdf_apparatus_ids) == {"pdf-current", "pdf-stale"}
    missing_ref = ResourceRef(scheme="message", id=uuid4())
    refs = [
        ResourceRef(scheme="media", id=media_id),
        ResourceRef(scheme="fragment", id=fragment.id),
        ResourceRef(scheme="highlight", id=highlight_id),
        ResourceRef(scheme="message", id=message_id),
        ResourceRef(scheme="message", id=other_message_id),
        ResourceRef(scheme="reader_apparatus_item", id=apparatus_ids["target"]),
        ResourceRef(scheme="reader_apparatus_item", id=apparatus_ids["stale-target"]),
        ResourceRef(scheme="reader_apparatus_item", id=pdf_apparatus_ids["pdf-current"]),
        ResourceRef(scheme="reader_apparatus_item", id=pdf_apparatus_ids["pdf-stale"]),
        missing_ref,
    ]
    expected = {
        ref.uri: resource_activation_for_ref(
            db_session,
            viewer_id=user_id,
            ref=ref,
            missing=ref == missing_ref,
        )
        for ref in refs
    }

    statement_count = 0

    def count_statement(*_args: object) -> None:
        nonlocal statement_count
        statement_count += 1

    engine = db_session.get_bind()
    event.listen(engine, "before_cursor_execute", count_statement)
    try:
        actual = resource_activations_for_refs(
            db_session,
            viewer_id=user_id,
            refs=refs,
            missing_ref_uris={missing_ref.uri},
        )
    finally:
        event.remove(engine, "before_cursor_execute", count_statement)

    assert actual == expected
    assert actual[f"reader_apparatus_item:{apparatus_ids['stale-target']}"].kind == "none"
    assert actual[f"reader_apparatus_item:{pdf_apparatus_ids['pdf-current']}"].kind == "route"
    assert actual[f"reader_apparatus_item:{pdf_apparatus_ids['pdf-stale']}"].kind == "none"
    assert statement_count == 4
