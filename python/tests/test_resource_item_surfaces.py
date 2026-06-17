from __future__ import annotations

from uuid import UUID, uuid4

import pytest
from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.db.models import Contributor
from nexus.services.resource_graph.refs import ResourceRef, ResourceScheme
from nexus.services.resource_items.surfaces import resource_item_out
from tests.factories import (
    create_test_conversation_with_message,
    create_test_fragment,
    create_test_highlight,
    create_test_media_in_library,
    get_user_default_library,
)

pytestmark = pytest.mark.integration


def test_resource_item_routes_use_product_paths(db_session: Session, bootstrapped_user: UUID):
    library_id = get_user_default_library(db_session, bootstrapped_user)
    assert library_id is not None
    media_id = create_test_media_in_library(
        db_session, bootstrapped_user, library_id, title="Route media"
    )
    fragment_id = create_test_fragment(db_session, media_id, "Route fragment")
    highlight_id = create_test_highlight(db_session, bootstrapped_user, fragment_id, "route")
    conversation_id, message_id = create_test_conversation_with_message(
        db_session, bootstrapped_user
    )

    assert _route(db_session, bootstrapped_user, "media", media_id) == f"/media/{media_id}"
    assert _activation(db_session, bootstrapped_user, "media", media_id) == {
        "kind": "route",
        "href": f"/media/{media_id}",
        "unresolved_reason": None,
    }
    assert (
        _route(db_session, bootstrapped_user, "library", library_id) == f"/libraries/{library_id}"
    )
    assert (
        _route(db_session, bootstrapped_user, "highlight", highlight_id)
        == f"/media/{media_id}#highlight-{highlight_id}"
    )
    assert (
        _route(db_session, bootstrapped_user, "fragment", fragment_id)
        == f"/media/{media_id}#fragment-{fragment_id}"
    )
    assert (
        _route(db_session, bootstrapped_user, "conversation", conversation_id)
        == f"/conversations/{conversation_id}"
    )
    assert (
        _route(db_session, bootstrapped_user, "message", message_id)
        == f"/conversations/{conversation_id}"
    )


def test_external_snapshot_activates_as_external_url(db_session: Session, bootstrapped_user: UUID):
    snapshot_id = db_session.execute(
        text(
            """
            INSERT INTO resource_external_snapshots (
                user_id, provider, url, title, snippet, source_snapshot
            )
            VALUES (
                :user_id, 'web', 'https://example.com/source',
                'External Source', 'External snippet', '{}'::jsonb
            )
            RETURNING id
            """
        ),
        {"user_id": bootstrapped_user},
    ).scalar_one()

    assert _route(db_session, bootstrapped_user, "external_snapshot", snapshot_id) is None
    assert _activation(db_session, bootstrapped_user, "external_snapshot", snapshot_id) == {
        "kind": "external",
        "href": "https://example.com/source",
        "unresolved_reason": None,
    }


def test_missing_resource_activation_fails_closed(db_session: Session, bootstrapped_user: UUID):
    missing_id = uuid4()

    item = resource_item_out(
        db_session,
        viewer_id=bootstrapped_user,
        ref=ResourceRef(scheme="media", id=missing_id),
    )

    assert item.route is None
    assert item.activation.kind == "none"
    assert item.activation.href is None
    assert item.activation.unresolved_reason == "missing"


def test_generated_and_identity_resources_project_existing_routes(
    db_session: Session, bootstrapped_user: UUID
):
    library_id = get_user_default_library(db_session, bootstrapped_user)
    assert library_id is not None
    artifact_id, revision_id = _make_library_intelligence(db_session, bootstrapped_user, library_id)
    reading_id = _make_oracle_reading(db_session, bootstrapped_user)
    contributor = Contributor(
        id=uuid4(),
        handle="route-author",
        display_name="Route Author",
        sort_name="Author, Route",
        kind="person",
        status="verified",
    )
    db_session.add(contributor)
    db_session.flush()

    assert (
        _route(db_session, bootstrapped_user, "library_intelligence_artifact", artifact_id)
        == f"/libraries/{library_id}?tab=intelligence"
    )
    assert (
        _route(db_session, bootstrapped_user, "library_intelligence_revision", revision_id)
        == f"/libraries/{library_id}?tab=intelligence&revision={revision_id}"
    )
    assert _route(db_session, bootstrapped_user, "oracle_reading", reading_id) == (
        f"/oracle/{reading_id}"
    )
    assert _route(db_session, bootstrapped_user, "contributor", contributor.id) == (
        "/authors/route-author"
    )


def _route(db: Session, viewer_id: UUID, scheme: ResourceScheme, resource_id: UUID) -> str | None:
    return _item(db, viewer_id=viewer_id, scheme=scheme, resource_id=resource_id).route


def _activation(
    db: Session, viewer_id: UUID, scheme: ResourceScheme, resource_id: UUID
) -> dict[str, str | None]:
    activation = _item(db, viewer_id=viewer_id, scheme=scheme, resource_id=resource_id).activation
    return {
        "kind": activation.kind,
        "href": activation.href,
        "unresolved_reason": activation.unresolved_reason,
    }


def _item(db: Session, viewer_id: UUID, scheme: ResourceScheme, resource_id: UUID):
    return resource_item_out(
        db,
        viewer_id=viewer_id,
        ref=ResourceRef(scheme=scheme, id=resource_id),
    )


def _make_library_intelligence(db: Session, user_id: UUID, library_id: UUID) -> tuple[UUID, UUID]:
    artifact_id = db.execute(
        text(
            """
            INSERT INTO library_intelligence_artifacts (library_id, user_id)
            VALUES (:library_id, :user_id)
            RETURNING id
            """
        ),
        {"library_id": library_id, "user_id": user_id},
    ).scalar_one()
    revision_id = db.execute(
        text(
            """
            INSERT INTO library_intelligence_artifact_revisions (
                artifact_id, content_md, covered_targets, status, promoted_at
            )
            VALUES (:artifact_id, 'Route synthesis', '[]'::jsonb, 'ready', now())
            RETURNING id
            """
        ),
        {"artifact_id": artifact_id},
    ).scalar_one()
    db.execute(
        text(
            """
            UPDATE library_intelligence_artifacts
            SET current_revision_id = :revision_id
            WHERE id = :artifact_id
            """
        ),
        {"artifact_id": artifact_id, "revision_id": revision_id},
    )
    db.flush()
    return UUID(str(artifact_id)), UUID(str(revision_id))


def _make_oracle_reading(db: Session, user_id: UUID) -> UUID:
    return UUID(
        str(
            db.execute(
                text(
                    """
                    INSERT INTO oracle_readings (
                        user_id, folio_number, question_text, folio_theme,
                        status, interpretation_text, completed_at
                    )
                    VALUES (
                        :user_id, 977, 'Where should this route open?', 'Of the Word',
                        'complete', 'Open the reading.', now()
                    )
                    RETURNING id
                    """
                ),
                {"user_id": user_id},
            ).scalar_one()
        )
    )
