from __future__ import annotations

from uuid import UUID, uuid4

import pytest
from sqlalchemy import event, select, text
from sqlalchemy.orm import Session

from nexus.db.models import Contributor, NoteBlock, ResourceEdge, ResourceViewState
from nexus.errors import ApiError, ApiErrorCode, ConflictError
from nexus.schemas.notes import CreatePageRequest
from nexus.schemas.resource_items import (
    InsertNoteSurfaceCommand,
    InsertResourceSurfaceCommand,
    MoveOccurrenceSurfaceCommand,
    RemoveOccurrenceSurfaceCommand,
    ResourceLaneVersionIn,
    ResourceSurfaceCommandRequest,
    ResourceTitleMutationRequest,
    SplitNoteSurfaceCommand,
    SurfaceAfterPosition,
    SurfaceStartPosition,
)
from nexus.services import notes
from nexus.services.resource_graph.refs import ResourceRef, ResourceScheme
from nexus.services.resource_items import mutations as resource_item_mutations
from nexus.services.resource_items import surfaces
from nexus.services.resource_items.surfaces import resource_item_out
from tests.factories import (
    create_test_conversation_with_message,
    create_test_fragment,
    create_test_highlight,
    create_test_library_artifact,
    create_test_media_in_library,
    get_user_default_library,
)
from tests.helpers import auth_headers

pytestmark = pytest.mark.integration


def _paragraph(value: str) -> dict[str, object]:
    return {"type": "paragraph", "content": [{"type": "text", "text": value}]}


def _page_ref(page_id: UUID) -> ResourceRef:
    return ResourceRef(scheme="page", id=page_id)


def _outgoing_base(surface) -> ResourceLaneVersionIn:
    return ResourceLaneVersionIn(
        ref=surface.source.item.ref,
        lane="outgoing_edges",
        version=surface.source.item.version_by_lane["outgoing_edges"],
    )


def _body_base(surface, occurrence_index: int = 0) -> ResourceLaneVersionIn:
    item = surface.ordered_items[occurrence_index].target.item
    return ResourceLaneVersionIn(
        ref=item.ref,
        lane="body",
        version=item.version_by_lane["body"],
    )


def test_surface_is_one_hop_and_projects_note_bodies_in_one_response(
    db_session: Session, bootstrapped_user: UUID
) -> None:
    page = notes.create_page(
        db_session,
        bootstrapped_user,
        CreatePageRequest(page_id=uuid4(), title="Surface"),
    )
    source = _page_ref(page.id)
    first = surfaces.execute_surface_command(
        db_session,
        viewer_id=bootstrapped_user,
        source=source,
        request=ResourceSurfaceCommandRequest(
            client_mutation_id="insert-note",
            base_versions=[
                _outgoing_base(
                    surfaces.get_surface(db_session, viewer_id=bootstrapped_user, source=source)
                )
            ],
            command=InsertNoteSurfaceCommand(
                type="insert_note",
                note_id=uuid4(),
                position=SurfaceStartPosition(kind="start"),
                body_pm_json=_paragraph("Direct note"),
            ),
        ),
    )
    note_ref = first.surface.ordered_items[0].target.item.ref
    library_id = get_user_default_library(db_session, bootstrapped_user)
    assert library_id is not None
    media_ref = ResourceRef(
        scheme="media",
        id=create_test_media_in_library(
            db_session, bootstrapped_user, library_id, title="Direct media"
        ),
    )
    surface = surfaces.execute_surface_command(
        db_session,
        viewer_id=bootstrapped_user,
        source=source,
        request=ResourceSurfaceCommandRequest(
            client_mutation_id="insert-media",
            base_versions=[_outgoing_base(first.surface)],
            command=InsertResourceSurfaceCommand(
                type="insert_resource",
                target_ref=media_ref.uri,
                position=SurfaceAfterPosition(
                    kind="after", occurrence_id=first.surface.ordered_items[0].occurrence_id
                ),
            ),
        ),
    ).surface

    assert surface.source.content.kind == "page_title"
    assert [item.target.item.ref for item in surface.ordered_items] == [note_ref, media_ref.uri]
    assert surface.ordered_items[0].target.content.kind == "note_body"
    assert surface.ordered_items[0].target.content.body_text == "Direct note"
    assert surface.ordered_items[1].target.content.kind == "resource_summary"


def test_surface_note_hydration_query_count_is_independent_of_row_count(
    db_session: Session, bootstrapped_user: UUID
) -> None:
    def page_with_notes(title: str, count: int) -> ResourceRef:
        page = notes.create_page(
            db_session,
            bootstrapped_user,
            CreatePageRequest(page_id=uuid4(), title=title),
        )
        source = _page_ref(page.id)
        surface = surfaces.get_surface(db_session, viewer_id=bootstrapped_user, source=source)
        for index in range(count):
            surface = surfaces.execute_surface_command(
                db_session,
                viewer_id=bootstrapped_user,
                source=source,
                request=ResourceSurfaceCommandRequest(
                    client_mutation_id=f"{title}-{index}",
                    base_versions=[_outgoing_base(surface)],
                    command=InsertNoteSurfaceCommand(
                        type="insert_note",
                        note_id=uuid4(),
                        position=(
                            SurfaceStartPosition(kind="start")
                            if not surface.ordered_items
                            else SurfaceAfterPosition(
                                kind="after",
                                occurrence_id=surface.ordered_items[-1].occurrence_id,
                            )
                        ),
                        body_pm_json=_paragraph(f"Note {index}"),
                    ),
                ),
            ).surface
        return source

    one = page_with_notes("one-row", 1)
    many = page_with_notes("many-rows", 12)

    def query_count(source: ResourceRef) -> int:
        count = 0

        def increment(*_args: object) -> None:
            nonlocal count
            count += 1

        # Compare equivalent transaction boundaries: the first read in a new
        # transaction pays one fixed connection/session setup statement.
        db_session.rollback()
        bind = db_session.get_bind()
        event.listen(bind, "before_cursor_execute", increment)
        try:
            surfaces.get_surface(db_session, viewer_id=bootstrapped_user, source=source)
        finally:
            event.remove(bind, "before_cursor_execute", increment)
        return count

    assert query_count(many) == query_count(one)


def test_surface_command_replay_and_conflict_return_the_canonical_surface(
    db_session: Session, bootstrapped_user: UUID
) -> None:
    page = notes.create_page(
        db_session,
        bootstrapped_user,
        CreatePageRequest(page_id=uuid4(), title="Replay"),
    )
    source = _page_ref(page.id)
    initial = surfaces.get_surface(db_session, viewer_id=bootstrapped_user, source=source)
    request = ResourceSurfaceCommandRequest(
        client_mutation_id="stable-insert",
        base_versions=[_outgoing_base(initial)],
        command=InsertNoteSurfaceCommand(
            type="insert_note",
            note_id=uuid4(),
            position=SurfaceStartPosition(kind="start"),
            body_pm_json=_paragraph("Only once"),
        ),
    )

    first = surfaces.execute_surface_command(
        db_session, viewer_id=bootstrapped_user, source=source, request=request
    )
    replay = surfaces.execute_surface_command(
        db_session, viewer_id=bootstrapped_user, source=source, request=request
    )
    assert replay == first
    assert len(first.surface.ordered_items) == 1

    with pytest.raises(ConflictError) as excinfo:
        surfaces.execute_surface_command(
            db_session,
            viewer_id=bootstrapped_user,
            source=source,
            request=ResourceSurfaceCommandRequest(
                client_mutation_id="stale-remove",
                base_versions=[_outgoing_base(initial)],
                command=RemoveOccurrenceSurfaceCommand(
                    type="remove_occurrence",
                    occurrence_id=first.surface.ordered_items[0].occurrence_id,
                ),
            ),
        )
    assert excinfo.value.code == ApiErrorCode.E_RESOURCE_CONFLICT
    assert excinfo.value.details is not None
    assert excinfo.value.details["surface"]["ordered_items"][0]["occurrence_id"] == str(
        first.surface.ordered_items[0].occurrence_id
    )


def test_surface_command_route_is_post_only_and_snake_case(authenticated_client) -> None:
    headers = auth_headers(uuid4())
    page = authenticated_client.post(
        "/notes/pages",
        headers=headers,
        json={"page_id": str(uuid4()), "title": "Route"},
    )
    assert page.status_code == 201, page.text
    page_id = page.json()["data"]["id"]
    surface_path = f"/resource-items/page:{page_id}/surface"
    surface = authenticated_client.get(surface_path, headers=headers)
    assert surface.status_code == 200, surface.text
    initial = surface.json()["data"]
    assert initial["source"]["content"] == {"kind": "page_title", "title": "Route"}
    response = authenticated_client.post(
        f"{surface_path}/commands",
        headers=headers,
        json={
            "client_mutation_id": "route-insert",
            "base_versions": [
                {
                    "ref": initial["source"]["item"]["ref"],
                    "lane": "outgoing_edges",
                    "version": initial["source"]["item"]["versionByLane"]["outgoing_edges"],
                }
            ],
            "command": {
                "type": "insert_note",
                "note_id": str(uuid4()),
                "position": {"kind": "start"},
                "body_pm_json": _paragraph("Route note"),
            },
        },
    )
    assert response.status_code == 200, response.text
    data = response.json()["data"]
    assert data["client_mutation_id"] == "route-insert"
    assert data["surface"]["ordered_items"][0]["target"]["content"]["kind"] == "note_body"
    assert (
        authenticated_client.put(
            f"/resource-items/page:{page_id}/adjacency", headers=headers
        ).status_code
        == 404
    )
    assert (
        authenticated_client.post(
            f"{surface_path}/commands",
            headers=headers,
            json={"clientMutationId": "camel-case-is-rejected"},
        ).status_code
        == 400
    )


def test_intrinsic_mutation_requires_exact_base_lane(
    db_session: Session, bootstrapped_user: UUID
) -> None:
    page = notes.create_page(
        db_session,
        bootstrapped_user,
        CreatePageRequest(page_id=uuid4(), title="Exact"),
    )
    ref = _page_ref(page.id)
    with pytest.raises(ConflictError) as excinfo:
        resource_item_mutations.update_title(
            db_session,
            viewer_id=bootstrapped_user,
            ref=ref,
            request=ResourceTitleMutationRequest(
                client_mutation_id="extra-base",
                title="No update",
                base_versions=[
                    ResourceLaneVersionIn(ref=ref.uri, lane="title", version=1),
                    ResourceLaneVersionIn(ref=ref.uri, lane="outgoing_edges", version=1),
                ],
            ),
        )
    assert excinfo.value.code == ApiErrorCode.E_RESOURCE_CONFLICT


def test_move_preserves_occurrence_and_view_state_and_remove_keeps_dense_keys(
    db_session: Session, bootstrapped_user: UUID
) -> None:
    page = notes.create_page(
        db_session,
        bootstrapped_user,
        CreatePageRequest(page_id=uuid4(), title="Move"),
    )
    source = _page_ref(page.id)
    first = surfaces.execute_surface_command(
        db_session,
        viewer_id=bootstrapped_user,
        source=source,
        request=ResourceSurfaceCommandRequest(
            client_mutation_id="first",
            base_versions=[
                _outgoing_base(
                    surfaces.get_surface(db_session, viewer_id=bootstrapped_user, source=source)
                )
            ],
            command=InsertNoteSurfaceCommand(
                type="insert_note",
                note_id=uuid4(),
                position=SurfaceStartPosition(kind="start"),
                body_pm_json=_paragraph("First"),
            ),
        ),
    )
    second = surfaces.execute_surface_command(
        db_session,
        viewer_id=bootstrapped_user,
        source=source,
        request=ResourceSurfaceCommandRequest(
            client_mutation_id="second",
            base_versions=[_outgoing_base(first.surface)],
            command=InsertNoteSurfaceCommand(
                type="insert_note",
                note_id=uuid4(),
                position=SurfaceAfterPosition(
                    kind="after", occurrence_id=first.surface.ordered_items[0].occurrence_id
                ),
                body_pm_json=_paragraph("Second"),
            ),
        ),
    )
    first_occurrence = second.surface.ordered_items[0].occurrence_id
    db_session.add(
        ResourceViewState(
            user_id=bootstrapped_user,
            surface_scheme="page",
            surface_id=page.id,
            edge_id=first_occurrence,
            target_scheme="note_block",
            target_id=second.surface.ordered_items[0].target.item.id,
            state={"open": True},
        )
    )
    db_session.commit()

    moved = surfaces.execute_surface_command(
        db_session,
        viewer_id=bootstrapped_user,
        source=source,
        request=ResourceSurfaceCommandRequest(
            client_mutation_id="move-first-after-second",
            base_versions=[_outgoing_base(second.surface)],
            command=MoveOccurrenceSurfaceCommand(
                type="move_occurrence",
                occurrence_id=first_occurrence,
                position=SurfaceAfterPosition(
                    kind="after", occurrence_id=second.surface.ordered_items[1].occurrence_id
                ),
            ),
        ),
    )
    assert moved.surface.ordered_items[1].occurrence_id == first_occurrence
    assert (
        db_session.scalar(
            select(ResourceViewState).where(ResourceViewState.edge_id == first_occurrence)
        )
        is not None
    )

    removed = surfaces.execute_surface_command(
        db_session,
        viewer_id=bootstrapped_user,
        source=source,
        request=ResourceSurfaceCommandRequest(
            client_mutation_id="remove-second",
            base_versions=[_outgoing_base(moved.surface)],
            command=RemoveOccurrenceSurfaceCommand(
                type="remove_occurrence",
                occurrence_id=moved.surface.ordered_items[0].occurrence_id,
            ),
        ),
    )
    rows = db_session.scalars(
        select(ResourceEdge)
        .where(ResourceEdge.source_id == page.id, ResourceEdge.source_order_key.is_not(None))
        .order_by(ResourceEdge.source_order_key)
    ).all()
    assert len(removed.surface.ordered_items) == 1
    assert [row.source_order_key for row in rows] == ["0000000001"]


def test_split_is_atomic_and_reused_note_edits_and_unlinks_remain_resource_native(
    db_session: Session, bootstrapped_user: UUID
) -> None:
    first_page = notes.create_page(
        db_session,
        bootstrapped_user,
        CreatePageRequest(page_id=uuid4(), title="First surface"),
    )
    second_page = notes.create_page(
        db_session,
        bootstrapped_user,
        CreatePageRequest(page_id=uuid4(), title="Second surface"),
    )
    first_source = _page_ref(first_page.id)
    second_source = _page_ref(second_page.id)
    inserted = surfaces.execute_surface_command(
        db_session,
        viewer_id=bootstrapped_user,
        source=first_source,
        request=ResourceSurfaceCommandRequest(
            client_mutation_id="insert-reused-note",
            base_versions=[
                _outgoing_base(
                    surfaces.get_surface(
                        db_session, viewer_id=bootstrapped_user, source=first_source
                    )
                )
            ],
            command=InsertNoteSurfaceCommand(
                type="insert_note",
                note_id=uuid4(),
                position=SurfaceStartPosition(kind="start"),
                body_pm_json=_paragraph("Original"),
            ),
        ),
    ).surface
    reused_ref = ResourceRef(scheme="note_block", id=inserted.ordered_items[0].target.item.id)
    surfaces.execute_surface_command(
        db_session,
        viewer_id=bootstrapped_user,
        source=second_source,
        request=ResourceSurfaceCommandRequest(
            client_mutation_id="reuse-note",
            base_versions=[
                _outgoing_base(
                    surfaces.get_surface(
                        db_session, viewer_id=bootstrapped_user, source=second_source
                    )
                )
            ],
            command=InsertResourceSurfaceCommand(
                type="insert_resource",
                target_ref=reused_ref.uri,
                position=SurfaceStartPosition(kind="start"),
            ),
        ),
    )

    right_note_id = uuid4()
    split = surfaces.execute_surface_command(
        db_session,
        viewer_id=bootstrapped_user,
        source=first_source,
        request=ResourceSurfaceCommandRequest(
            client_mutation_id="split-reused-note",
            base_versions=[_outgoing_base(inserted), _body_base(inserted)],
            command=SplitNoteSurfaceCommand(
                type="split_note",
                occurrence_id=inserted.ordered_items[0].occurrence_id,
                note_id=right_note_id,
                left_body_pm_json=_paragraph("Left"),
                right_body_pm_json=_paragraph("Right"),
            ),
        ),
    ).surface
    assert split.ordered_items[0].occurrence_id == inserted.ordered_items[0].occurrence_id
    assert [row.target.content.body_text for row in split.ordered_items] == ["Left", "Right"]
    assert (
        surfaces.get_surface(db_session, viewer_id=bootstrapped_user, source=second_source)
        .ordered_items[0]
        .target.content.body_text
        == "Left"
    )

    removed = surfaces.execute_surface_command(
        db_session,
        viewer_id=bootstrapped_user,
        source=first_source,
        request=ResourceSurfaceCommandRequest(
            client_mutation_id="unlink-reused-note",
            base_versions=[_outgoing_base(split)],
            command=RemoveOccurrenceSurfaceCommand(
                type="remove_occurrence",
                occurrence_id=split.ordered_items[0].occurrence_id,
            ),
        ),
    ).surface
    assert [row.target.content.body_text for row in removed.ordered_items] == ["Right"]
    assert db_session.get(NoteBlock, reused_ref.id) is not None
    assert (
        len(
            surfaces.get_surface(
                db_session, viewer_id=bootstrapped_user, source=second_source
            ).ordered_items
        )
        == 1
    )

    before_failed_split = surfaces.get_surface(
        db_session, viewer_id=bootstrapped_user, source=second_source
    )
    with pytest.raises(ApiError) as excinfo:
        surfaces.execute_surface_command(
            db_session,
            viewer_id=bootstrapped_user,
            source=second_source,
            request=ResourceSurfaceCommandRequest(
                client_mutation_id="split-with-existing-right",
                base_versions=[
                    _outgoing_base(before_failed_split),
                    _body_base(before_failed_split),
                ],
                command=SplitNoteSurfaceCommand(
                    type="split_note",
                    occurrence_id=before_failed_split.ordered_items[0].occurrence_id,
                    note_id=right_note_id,
                    left_body_pm_json=_paragraph("Must roll back"),
                    right_body_pm_json=_paragraph("Must not overwrite"),
                ),
            ),
        )
    assert excinfo.value.code == ApiErrorCode.E_INVALID_REQUEST
    after_failed_split = surfaces.get_surface(
        db_session, viewer_id=bootstrapped_user, source=second_source
    )
    assert after_failed_split == before_failed_split


def test_insert_commands_reject_unknown_positions_before_writing(
    db_session: Session, bootstrapped_user: UUID
) -> None:
    page = notes.create_page(
        db_session,
        bootstrapped_user,
        CreatePageRequest(page_id=uuid4(), title="Fail closed"),
    )
    source = _page_ref(page.id)
    first = surfaces.execute_surface_command(
        db_session,
        viewer_id=bootstrapped_user,
        source=source,
        request=ResourceSurfaceCommandRequest(
            client_mutation_id="fail-closed-seed",
            base_versions=[
                _outgoing_base(
                    surfaces.get_surface(
                        db_session,
                        viewer_id=bootstrapped_user,
                        source=source,
                    )
                )
            ],
            command=InsertNoteSurfaceCommand(
                type="insert_note",
                note_id=uuid4(),
                position=SurfaceStartPosition(kind="start"),
                body_pm_json=_paragraph("Existing"),
            ),
        ),
    ).surface
    unknown_occurrence_id = uuid4()
    rejected_note_id = uuid4()

    with pytest.raises(ApiError) as excinfo:
        surfaces.execute_surface_command(
            db_session,
            viewer_id=bootstrapped_user,
            source=source,
            request=ResourceSurfaceCommandRequest(
                client_mutation_id="fail-closed-note",
                base_versions=[_outgoing_base(first)],
                command=InsertNoteSurfaceCommand(
                    type="insert_note",
                    note_id=rejected_note_id,
                    position=SurfaceAfterPosition(
                        kind="after",
                        occurrence_id=unknown_occurrence_id,
                    ),
                    body_pm_json=_paragraph("Must not persist"),
                ),
            ),
        )
    assert excinfo.value.code == ApiErrorCode.E_INVALID_REQUEST
    # A direct service caller may catch the typed error and continue its unit of
    # work. Validation must therefore precede every write, not rely on HTTP
    # session cleanup to roll pending rows back.
    db_session.commit()
    assert db_session.get(NoteBlock, rejected_note_id) is None
    assert (
        surfaces.get_surface(
            db_session,
            viewer_id=bootstrapped_user,
            source=source,
        )
        == first
    )

    library_id = get_user_default_library(db_session, bootstrapped_user)
    assert library_id is not None
    media_ref = ResourceRef(
        scheme="media",
        id=create_test_media_in_library(
            db_session,
            bootstrapped_user,
            library_id,
            title="Rejected insert target",
        ),
    )
    with pytest.raises(ApiError) as excinfo:
        surfaces.execute_surface_command(
            db_session,
            viewer_id=bootstrapped_user,
            source=source,
            request=ResourceSurfaceCommandRequest(
                client_mutation_id="fail-closed-resource",
                base_versions=[_outgoing_base(first)],
                command=InsertResourceSurfaceCommand(
                    type="insert_resource",
                    target_ref=media_ref.uri,
                    position=SurfaceAfterPosition(
                        kind="after",
                        occurrence_id=unknown_occurrence_id,
                    ),
                ),
            ),
        )
    assert excinfo.value.code == ApiErrorCode.E_INVALID_REQUEST
    db_session.commit()
    assert (
        surfaces.get_surface(
            db_session,
            viewer_id=bootstrapped_user,
            source=source,
        )
        == first
    )


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
        == f"/conversations/{conversation_id}?message={message_id}"
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
    serialized = item.model_dump(mode="json", by_alias=True)
    assert serialized["capabilities"]["libraryPlacement"] == "ManageEntries"
    assert "library_placement" not in serialized["capabilities"]


def test_generated_and_identity_resources_project_existing_routes(
    db_session: Session, bootstrapped_user: UUID
):
    library_id = get_user_default_library(db_session, bootstrapped_user)
    assert library_id is not None
    artifact_id, revision_id = create_test_library_artifact(
        db_session,
        library_id=library_id,
        requester_user_id=bootstrapped_user,
        content_html=(
            '<article><section id="route-synthesis"><p>Route synthesis</p></section></article>'
        ),
        content_text="Route synthesis",
    )
    reading_id = _make_oracle_reading(db_session, bootstrapped_user)
    contributor = Contributor(
        id=uuid4(),
        handle="route-author",
        display_name="Route Author",
    )
    db_session.add(contributor)
    db_session.flush()

    artifact_route = f"/artifacts/artifact:{artifact_id}"
    assert _route(db_session, bootstrapped_user, "artifact", artifact_id) == artifact_route
    assert (
        _route(db_session, bootstrapped_user, "artifact_revision", revision_id)
        == f"{artifact_route}?revision=artifact_revision:{revision_id}"
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
