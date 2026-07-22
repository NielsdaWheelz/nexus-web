"""Link / stance / link-note command coverage (universal-link-authoring, § Mutation APIs).

Race scenarios drive the command from independent OS threads gated by a
``threading.Barrier`` (the ``direct_db`` precedent): every command opens its own
session and terminates in ``retry_serializable``, so the whole operation is the
race window and uniqueness collisions converge instead of surfacing a raw
``IntegrityError`` (AC3/AC4). Functional cases run service-first over the
savepoint-isolated ``db_session`` + ``bootstrapped_user``.
"""

from __future__ import annotations

import threading
from uuid import UUID, uuid4

import pytest
from sqlalchemy import Engine, select
from sqlalchemy.orm import Session

from nexus.auth.middleware import Viewer
from nexus.db.models import Highlight, NoteBlock, ResourceEdge
from nexus.errors import ApiError, ApiErrorCode, ConflictError
from nexus.schemas.resource_graph import (
    CreateLinkRequest,
    PutLinkNoteRequest,
    PutStanceRequest,
)
from nexus.services import notes
from nexus.services.bootstrap import ensure_user_and_default_library
from nexus.services.resource_graph import user_relations
from tests.factories import (
    create_test_fragment,
    create_test_highlight,
    create_test_media_in_library,
    get_user_default_library,
)

pytestmark = pytest.mark.integration


# ---------------------------------------------------------------------------
# Builders
# ---------------------------------------------------------------------------


def _resource_link(source_ref: str, target_ref: str, mutation_id: str) -> CreateLinkRequest:
    return CreateLinkRequest(
        client_mutation_id=mutation_id,
        source={"kind": "resource", "ref": source_ref},
        target={"kind": "resource", "ref": target_ref},
    )


def _user_edges(db: Session, viewer_id: UUID) -> list[ResourceEdge]:
    return list(
        db.execute(
            select(ResourceEdge).where(
                ResourceEdge.user_id == viewer_id, ResourceEdge.origin == "user"
            )
        )
        .scalars()
        .all()
    )


def _link_note_edges(db: Session, viewer_id: UUID) -> list[ResourceEdge]:
    return list(
        db.execute(
            select(ResourceEdge).where(
                ResourceEdge.user_id == viewer_id, ResourceEdge.origin == "link_note"
            )
        )
        .scalars()
        .all()
    )


# ---------------------------------------------------------------------------
# Functional (db_session + bootstrapped_user)
# ---------------------------------------------------------------------------


def test_reverse_link_is_idempotent(db_session: Session, bootstrapped_user: UUID) -> None:
    library_id = get_user_default_library(db_session, bootstrapped_user)
    assert library_id is not None
    media_a = create_test_media_in_library(db_session, bootstrapped_user, library_id, title="A")
    media_b = create_test_media_in_library(db_session, bootstrapped_user, library_id, title="B")

    forward = user_relations.create_link(
        db_session,
        viewer_id=bootstrapped_user,
        request=_resource_link(f"media:{media_a}", f"media:{media_b}", "m-fwd"),
    )
    assert forward.created is True
    assert forward.connection.direction == "undirected"

    reverse = user_relations.create_link(
        db_session,
        viewer_id=bootstrapped_user,
        request=_resource_link(f"media:{media_b}", f"media:{media_a}", "m-rev"),
    )
    assert reverse.created is False
    assert reverse.connection.edge_id == forward.connection.edge_id
    assert len(_user_edges(db_session, bootstrapped_user)) == 1


def test_same_mutation_id_replays_exact_response(
    db_session: Session, bootstrapped_user: UUID
) -> None:
    library_id = get_user_default_library(db_session, bootstrapped_user)
    assert library_id is not None
    media_a = create_test_media_in_library(db_session, bootstrapped_user, library_id, title="A")
    media_b = create_test_media_in_library(db_session, bootstrapped_user, library_id, title="B")
    request = _resource_link(f"media:{media_a}", f"media:{media_b}", "m-same")

    first = user_relations.create_link(db_session, viewer_id=bootstrapped_user, request=request)
    second = user_relations.create_link(db_session, viewer_id=bootstrapped_user, request=request)
    assert first.created is True
    assert second.created is True  # exact replay preserves created
    assert second.connection.edge_id == first.connection.edge_id
    assert len(_user_edges(db_session, bootstrapped_user)) == 1


def test_self_link_rejected(db_session: Session, bootstrapped_user: UUID) -> None:
    library_id = get_user_default_library(db_session, bootstrapped_user)
    assert library_id is not None
    media = create_test_media_in_library(db_session, bootstrapped_user, library_id)
    with pytest.raises(ApiError) as exc:
        user_relations.create_link(
            db_session,
            viewer_id=bootstrapped_user,
            request=_resource_link(f"media:{media}", f"media:{media}", "m-self"),
        )
    assert exc.value.code is ApiErrorCode.E_LINK_SELF


def test_capability_rejected(db_session: Session, bootstrapped_user: UUID) -> None:
    library_id = get_user_default_library(db_session, bootstrapped_user)
    assert library_id is not None
    media = create_test_media_in_library(db_session, bootstrapped_user, library_id)
    fragment = create_test_fragment(db_session, media, content="linkable body")
    with pytest.raises(ApiError) as exc:
        user_relations.create_link(
            db_session,
            viewer_id=bootstrapped_user,
            request=_resource_link(f"fragment:{fragment}", f"media:{media}", "m-cap"),
        )
    assert exc.value.code is ApiErrorCode.E_LINK_CAPABILITY


def test_stale_passage_candidate(db_session: Session, bootstrapped_user: UUID) -> None:
    library_id = get_user_default_library(db_session, bootstrapped_user)
    assert library_id is not None
    media = create_test_media_in_library(db_session, bootstrapped_user, library_id)
    request = CreateLinkRequest(
        client_mutation_id="m-stale",
        source={"kind": "resource", "ref": f"media:{media}"},
        target={"kind": "passage", "candidate_ref": f"evidence_span:{uuid4()}"},
    )
    with pytest.raises(ConflictError) as exc:
        user_relations.create_link(db_session, viewer_id=bootstrapped_user, request=request)
    assert exc.value.code is ApiErrorCode.E_LINK_TARGET_STALE


def test_highlight_id_conflict(db_session: Session, bootstrapped_user: UUID) -> None:
    library_id = get_user_default_library(db_session, bootstrapped_user)
    assert library_id is not None
    media = create_test_media_in_library(db_session, bootstrapped_user, library_id)
    fragment = create_test_fragment(db_session, media, content="alpha beta gamma delta")
    highlight_id = create_test_highlight(db_session, bootstrapped_user, fragment, exact="alpha")

    # Reuse the client-stable id for a different selection over the same fragment.
    request = CreateLinkRequest(
        client_mutation_id="m-hl-conflict",
        source={
            "kind": "fragment_selection",
            "highlight_id": str(highlight_id),
            "fragment_id": str(fragment),
            "start_offset": 6,
            "end_offset": 10,
            "color": "yellow",
        },
        target={"kind": "resource", "ref": f"media:{media}"},
    )
    with pytest.raises(ApiError) as exc:
        user_relations.create_link(db_session, viewer_id=bootstrapped_user, request=request)
    assert exc.value.code is ApiErrorCode.E_HIGHLIGHT_CONFLICT


def test_link_note_motif_exact_and_delete(db_session: Session, bootstrapped_user: UUID) -> None:
    library_id = get_user_default_library(db_session, bootstrapped_user)
    assert library_id is not None
    media_a = create_test_media_in_library(db_session, bootstrapped_user, library_id, title="A")
    media_b = create_test_media_in_library(db_session, bootstrapped_user, library_id, title="B")
    link = user_relations.create_link(
        db_session,
        viewer_id=bootstrapped_user,
        request=_resource_link(f"media:{media_a}", f"media:{media_b}", "m-note"),
    )
    link_id = link.connection.edge_id

    note_id = uuid4()
    result = user_relations.put_link_note(
        db_session,
        viewer_id=bootstrapped_user,
        link_id=link_id,
        request=PutLinkNoteRequest(
            client_mutation_id="m-note-put",
            note_block_id=note_id,
            body_pm_json=notes.pm_doc_from_text("why these connect"),
        ),
    )
    assert result.note_block_id == note_id
    assert result.connection.link_note is not None
    assert result.connection.link_note.note_block_id == note_id

    motif = _link_note_edges(db_session, bootstrapped_user)
    assert len(motif) == 2
    targets = {(e.target_scheme, e.target_id) for e in motif}
    assert targets == {("media", media_a), ("media", media_b)}
    assert all(e.source_scheme == "note_block" and e.source_id == note_id for e in motif)

    # Idempotent re-put keeps exactly two attachment edges.
    user_relations.put_link_note(
        db_session,
        viewer_id=bootstrapped_user,
        link_id=link_id,
        request=PutLinkNoteRequest(
            client_mutation_id="m-note-put-2",
            note_block_id=note_id,
            body_pm_json=notes.pm_doc_from_text("clarified reason"),
        ),
    )
    assert len(_link_note_edges(db_session, bootstrapped_user)) == 2

    # Delete note: note row + attachments gone, Link preserved.
    user_relations.delete_link_note(db_session, viewer_id=bootstrapped_user, link_id=link_id)
    assert _link_note_edges(db_session, bootstrapped_user) == []
    assert db_session.get(NoteBlock, note_id) is None
    assert len(_user_edges(db_session, bootstrapped_user)) == 1


def test_remove_link_detaches_note_but_keeps_prose(
    db_session: Session, bootstrapped_user: UUID
) -> None:
    library_id = get_user_default_library(db_session, bootstrapped_user)
    assert library_id is not None
    media_a = create_test_media_in_library(db_session, bootstrapped_user, library_id, title="A")
    media_b = create_test_media_in_library(db_session, bootstrapped_user, library_id, title="B")
    link = user_relations.create_link(
        db_session,
        viewer_id=bootstrapped_user,
        request=_resource_link(f"media:{media_a}", f"media:{media_b}", "m-rm"),
    )
    note_id = uuid4()
    user_relations.put_link_note(
        db_session,
        viewer_id=bootstrapped_user,
        link_id=link.connection.edge_id,
        request=PutLinkNoteRequest(
            client_mutation_id="m-rm-note",
            note_block_id=note_id,
            body_pm_json=notes.pm_doc_from_text("standalone-able prose"),
        ),
    )

    user_relations.delete_link(
        db_session, viewer_id=bootstrapped_user, link_id=link.connection.edge_id
    )
    assert _user_edges(db_session, bootstrapped_user) == []
    assert _link_note_edges(db_session, bootstrapped_user) == []
    # The authored note survives as detached prose.
    assert db_session.get(NoteBlock, note_id) is not None


def test_delete_link_is_idempotent(db_session: Session, bootstrapped_user: UUID) -> None:
    library_id = get_user_default_library(db_session, bootstrapped_user)
    assert library_id is not None
    media_a = create_test_media_in_library(db_session, bootstrapped_user, library_id, title="A")
    media_b = create_test_media_in_library(db_session, bootstrapped_user, library_id, title="B")
    link = user_relations.create_link(
        db_session,
        viewer_id=bootstrapped_user,
        request=_resource_link(f"media:{media_a}", f"media:{media_b}", "m-del"),
    )
    user_relations.delete_link(
        db_session, viewer_id=bootstrapped_user, link_id=link.connection.edge_id
    )
    # Second delete and an unknown id are both no-ops.
    user_relations.delete_link(
        db_session, viewer_id=bootstrapped_user, link_id=link.connection.edge_id
    )
    user_relations.delete_link(db_session, viewer_id=bootstrapped_user, link_id=uuid4())


def test_stance_replace_and_delete(db_session: Session, bootstrapped_user: UUID) -> None:
    library_id = get_user_default_library(db_session, bootstrapped_user)
    assert library_id is not None
    media_a = create_test_media_in_library(db_session, bootstrapped_user, library_id, title="A")
    media_b = create_test_media_in_library(db_session, bootstrapped_user, library_id, title="B")

    first = user_relations.put_stance(
        db_session,
        viewer_id=bootstrapped_user,
        request=PutStanceRequest(
            source_ref=f"media:{media_a}", target_ref=f"media:{media_b}", kind="supports"
        ),
    )
    assert first.connection.kind == "supports"
    # Opposite orientation + kind replaces; still exactly one stance.
    second = user_relations.put_stance(
        db_session,
        viewer_id=bootstrapped_user,
        request=PutStanceRequest(
            source_ref=f"media:{media_b}", target_ref=f"media:{media_a}", kind="contradicts"
        ),
    )
    stances = _user_edges(db_session, bootstrapped_user)
    assert len(stances) == 1
    assert stances[0].kind == "contradicts"

    user_relations.delete_stance(
        db_session, viewer_id=bootstrapped_user, stance_id=second.connection.edge_id
    )
    assert _user_edges(db_session, bootstrapped_user) == []


# ---------------------------------------------------------------------------
# Route wiring (auth_client + direct_db)
# ---------------------------------------------------------------------------


def test_link_routes_end_to_end(auth_client, direct_db) -> None:
    from tests.helpers import auth_headers, create_test_user_id

    user_id = create_test_user_id()
    assert auth_client.get("/me", headers=auth_headers(user_id)).status_code == 200
    direct_db.register_cleanup("users", "id", user_id)
    direct_db.register_cleanup("libraries", "owner_user_id", user_id)
    direct_db.register_cleanup("memberships", "user_id", user_id)
    direct_db.register_cleanup("resource_mutations", "user_id", user_id)
    direct_db.register_cleanup("resource_edges", "user_id", user_id)
    headers = auth_headers(user_id)

    with direct_db.session() as session:
        library_id = get_user_default_library(session, user_id)
        assert library_id is not None
        media_a = create_test_media_in_library(session, user_id, library_id, title="A")
        media_b = create_test_media_in_library(session, user_id, library_id, title="B")
    direct_db.register_cleanup("media", "id", media_a)
    direct_db.register_cleanup("media", "id", media_b)

    created = auth_client.post(
        "/resource-graph/links",
        headers=headers,
        json={
            "client_mutation_id": "route-m1",
            "source": {"kind": "resource", "ref": f"media:{media_a}"},
            "target": {"kind": "resource", "ref": f"media:{media_b}"},
        },
    )
    assert created.status_code == 201, created.text
    body = created.json()["data"]
    assert body["created"] is True
    assert body["connection"]["direction"] == "undirected"
    link_id = body["connection"]["edge_id"]

    # Reverse is idempotent success through the route.
    reverse = auth_client.post(
        "/resource-graph/links",
        headers=headers,
        json={
            "client_mutation_id": "route-m2",
            "source": {"kind": "resource", "ref": f"media:{media_b}"},
            "target": {"kind": "resource", "ref": f"media:{media_a}"},
        },
    )
    assert reverse.status_code == 201, reverse.text
    assert reverse.json()["data"]["created"] is False

    removed = auth_client.delete(f"/resource-graph/links/{link_id}", headers=headers)
    assert removed.status_code == 204, removed.text
    # Idempotent second delete.
    assert (
        auth_client.delete(f"/resource-graph/links/{link_id}", headers=headers).status_code == 204
    )


def test_stance_and_link_note_routes_end_to_end(auth_client, direct_db) -> None:
    from tests.helpers import auth_headers, create_test_user_id

    user_id = create_test_user_id()
    assert auth_client.get("/me", headers=auth_headers(user_id)).status_code == 200
    direct_db.register_cleanup("users", "id", user_id)
    direct_db.register_cleanup("libraries", "owner_user_id", user_id)
    direct_db.register_cleanup("memberships", "user_id", user_id)
    direct_db.register_cleanup("resource_mutations", "user_id", user_id)
    direct_db.register_cleanup("resource_edges", "user_id", user_id)
    direct_db.register_cleanup("note_blocks", "user_id", user_id)
    headers = auth_headers(user_id)

    with direct_db.session() as session:
        library_id = get_user_default_library(session, user_id)
        assert library_id is not None
        media_a = create_test_media_in_library(session, user_id, library_id, title="A")
        media_b = create_test_media_in_library(session, user_id, library_id, title="B")
    direct_db.register_cleanup("media", "id", media_a)
    direct_db.register_cleanup("media", "id", media_b)

    # PUT /stances then DELETE /stances/{id} (idempotent).
    stance = auth_client.put(
        "/resource-graph/stances",
        headers=headers,
        json={
            "source_ref": f"media:{media_a}",
            "target_ref": f"media:{media_b}",
            "kind": "supports",
        },
    )
    assert stance.status_code == 200, stance.text
    stance_conn = stance.json()["data"]["connection"]
    assert stance_conn["kind"] == "supports"
    stance_id = stance_conn["edge_id"]
    assert (
        auth_client.delete(f"/resource-graph/stances/{stance_id}", headers=headers).status_code
        == 204
    )
    assert (
        auth_client.delete(f"/resource-graph/stances/{stance_id}", headers=headers).status_code
        == 204
    )

    # A Link to hang a note on.
    created = auth_client.post(
        "/resource-graph/links",
        headers=headers,
        json={
            "client_mutation_id": "note-route-link",
            "source": {"kind": "resource", "ref": f"media:{media_a}"},
            "target": {"kind": "resource", "ref": f"media:{media_b}"},
        },
    )
    assert created.status_code == 201, created.text
    link_id = created.json()["data"]["connection"]["edge_id"]

    # PUT /links/{id}/note folds the note onto the refreshed connection.
    note_id = str(uuid4())
    put_note = auth_client.put(
        f"/resource-graph/links/{link_id}/note",
        headers=headers,
        json={
            "client_mutation_id": "note-route-put",
            "note_block_id": note_id,
            "body_pm_json": notes.pm_doc_from_text("routed rationale"),
        },
    )
    assert put_note.status_code == 200, put_note.text
    note_body = put_note.json()["data"]
    assert note_body["note_block_id"] == note_id
    assert note_body["connection"]["link_note"]["note_block_id"] == note_id

    # DELETE /links/{id}/note (idempotent); the Link itself survives.
    assert (
        auth_client.delete(f"/resource-graph/links/{link_id}/note", headers=headers).status_code
        == 204
    )
    assert (
        auth_client.delete(f"/resource-graph/links/{link_id}/note", headers=headers).status_code
        == 204
    )


# ---------------------------------------------------------------------------
# Concurrency (direct_db + real threads/sessions)
# ---------------------------------------------------------------------------


def _run_concurrently(targets):
    barrier = threading.Barrier(len(targets))
    errors: list[BaseException] = []
    lock = threading.Lock()

    def _wrap(fn):
        try:
            barrier.wait(timeout=10)
            fn()
        except BaseException as exc:  # pragma: no cover - surfaced via the assert
            with lock:
                errors.append(exc)

    threads = [threading.Thread(target=_wrap, args=(fn,)) for fn in targets]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=30)
    assert errors == [], f"concurrent workers raised: {errors!r}"


def _seed_owner(direct_db) -> Viewer:
    user_id = uuid4()
    direct_db.register_cleanup("users", "id", user_id)
    direct_db.register_cleanup("libraries", "owner_user_id", user_id)
    direct_db.register_cleanup("memberships", "user_id", user_id)
    direct_db.register_cleanup("resource_mutations", "user_id", user_id)
    direct_db.register_cleanup("resource_view_states", "user_id", user_id)
    direct_db.register_cleanup("resource_edges", "user_id", user_id)
    with direct_db.session() as session:
        library_id = ensure_user_and_default_library(session, user_id)
        session.commit()
    return Viewer(user_id=user_id, default_library_id=library_id, roles=frozenset())


def _seed_media(direct_db, viewer: Viewer, title: str) -> UUID:
    with direct_db.session() as session:
        media_id = create_test_media_in_library(
            session, viewer.user_id, viewer.default_library_id, title=title
        )
    direct_db.register_cleanup("media", "id", media_id)
    return media_id


def test_concurrent_creates_converge_to_one_link(engine: Engine, direct_db) -> None:
    viewer = _seed_owner(direct_db)
    media_a = _seed_media(direct_db, viewer, "A")
    media_b = _seed_media(direct_db, viewer, "B")

    outcomes: list[bool] = []
    edge_ids: list[UUID] = []
    lock = threading.Lock()

    def _create(mutation_id: str):
        def _run() -> None:
            with Session(engine) as session:
                result = user_relations.create_link(
                    session,
                    viewer_id=viewer.user_id,
                    request=_resource_link(f"media:{media_a}", f"media:{media_b}", mutation_id),
                )
            with lock:
                outcomes.append(result.created)
                edge_ids.append(result.connection.edge_id)

        return _run

    _run_concurrently([_create("mid-1"), _create("mid-2")])

    assert sorted(outcomes) == [False, True], outcomes
    assert len(set(edge_ids)) == 1, edge_ids
    with direct_db.session() as session:
        assert len(_user_edges(session, viewer.user_id)) == 1


def test_concurrent_deletes_of_same_link_converge(engine: Engine, direct_db) -> None:
    """Two concurrent Remove-Link calls on the same Link converge on the promised
    idempotent no-op: the loser retries under SERIALIZABLE and re-reads an absent
    edge, never surfacing a spurious 404 from the get/delete TOCTOU.
    """
    viewer = _seed_owner(direct_db)
    media_a = _seed_media(direct_db, viewer, "A")
    media_b = _seed_media(direct_db, viewer, "B")
    with direct_db.session() as session:
        link = user_relations.create_link(
            session,
            viewer_id=viewer.user_id,
            request=_resource_link(f"media:{media_a}", f"media:{media_b}", "seed-del"),
        )
        link_id = link.connection.edge_id

    def _delete():
        def _run() -> None:
            with Session(engine) as session:
                user_relations.delete_link(session, viewer_id=viewer.user_id, link_id=link_id)

        return _run

    _run_concurrently([_delete(), _delete()])

    with direct_db.session() as session:
        assert _user_edges(session, viewer.user_id) == []


def test_concurrent_opposite_stances_converge_to_one(engine: Engine, direct_db) -> None:
    viewer = _seed_owner(direct_db)
    media_a = _seed_media(direct_db, viewer, "A")
    media_b = _seed_media(direct_db, viewer, "B")

    def _stance(source: UUID, target: UUID, kind: str):
        def _run() -> None:
            with Session(engine) as session:
                user_relations.put_stance(
                    session,
                    viewer_id=viewer.user_id,
                    request=PutStanceRequest(
                        source_ref=f"media:{source}", target_ref=f"media:{target}", kind=kind
                    ),
                )

        return _run

    _run_concurrently(
        [_stance(media_a, media_b, "supports"), _stance(media_b, media_a, "contradicts")]
    )

    with direct_db.session() as session:
        stances = _user_edges(session, viewer.user_id)
    assert len(stances) == 1, stances
    assert stances[0].kind in ("supports", "contradicts")


def test_failed_create_persists_no_highlight(engine: Engine, direct_db) -> None:
    viewer = _seed_owner(direct_db)
    media = _seed_media(direct_db, viewer, "doc")
    with direct_db.session() as session:
        fragment = create_test_fragment(session, media, content="alpha beta gamma")
    direct_db.register_cleanup("highlights", "user_id", viewer.user_id)

    highlight_id = uuid4()
    request = CreateLinkRequest(
        client_mutation_id="m-atomic",
        source={
            "kind": "fragment_selection",
            "highlight_id": str(highlight_id),
            "fragment_id": str(fragment),
            "start_offset": 0,
            "end_offset": 5,
            "color": "yellow",
        },
        target={"kind": "passage", "candidate_ref": f"evidence_span:{uuid4()}"},
    )
    session = Session(engine)
    try:
        with pytest.raises(ConflictError) as exc:
            user_relations.create_link(session, viewer_id=viewer.user_id, request=request)
        assert exc.value.code is ApiErrorCode.E_LINK_TARGET_STALE
    finally:
        session.rollback()
        session.close()

    with direct_db.session() as session:
        assert session.get(Highlight, highlight_id) is None
