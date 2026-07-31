from __future__ import annotations

import threading
from collections.abc import Callable
from datetime import date
from uuid import UUID, uuid4

import pytest
from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.errors import ApiErrorCode, ConflictError, InvalidRequestError
from nexus.schemas.notes import DailyCaptureRequest, DailyCaptureResult
from nexus.services import notes
from tests.helpers import auth_headers, create_test_user_id
from tests.utils.db import DirectSessionManager

pytestmark = pytest.mark.integration


def _paragraph(value: str) -> dict[str, object]:
    return {"type": "paragraph", "content": [{"type": "text", "text": value}]}


def _register_daily_cleanup(direct_db: DirectSessionManager, viewer_id: UUID) -> None:
    direct_db.register_cleanup("users", "id", viewer_id)
    direct_db.register_cleanup("pages", "user_id", viewer_id)


def _surface_capabilities(
    *,
    citable_result_type: str,
    expansion_policy: str,
) -> dict[str, object]:
    return {
        "sharing": "CopyOnly",
        "libraryPlacement": "None",
        "userRelation": {
            "userLinkSource": True,
            "userLinkTarget": "direct",
            "noteReferenceTarget": True,
        },
        "attachable": True,
        "chatSubject": "readable",
        "readable": "body",
        "inspectable": "none",
        "citableResultType": citable_result_type,
        "citationOutputSource": False,
        "appSearchScope": False,
        "conversationSearchScope": True,
        "adjacencySource": True,
        "adjacencyTarget": True,
        "promptRender": "inline_body",
        "expansionPolicy": expansion_policy,
        "expandable": True,
    }


def _expected_capture_surface(
    *,
    page_id: UUID,
    note_id: UUID,
    occurrence_id: UUID,
    title: str,
    body_pm_json: dict[str, object],
    body_text: str,
) -> dict[str, object]:
    page_ref = f"page:{page_id}"
    note_ref = f"note_block:{note_id}"
    return {
        "source": {
            "item": {
                "ref": page_ref,
                "scheme": "page",
                "id": str(page_id),
                "label": title,
                "summary": title,
                "route": f"/pages/{page_id}",
                "activation": {
                    "resourceRef": page_ref,
                    "kind": "route",
                    "href": f"/pages/{page_id}",
                    "unresolvedReason": None,
                },
                "missing": False,
                "capabilities": _surface_capabilities(
                    citable_result_type="page",
                    expansion_policy="page_note_blocks",
                ),
                "versionByLane": {"title": 1, "outgoing_edges": 2},
            },
            "content": {"kind": "page_title", "title": title},
        },
        "ordered_items": [
            {
                "occurrence_id": str(occurrence_id),
                "target": {
                    "item": {
                        "ref": note_ref,
                        "scheme": "note_block",
                        "id": str(note_id),
                        "label": body_text,
                        "summary": body_text,
                        "route": f"/notes/{note_id}",
                        "activation": {
                            "resourceRef": note_ref,
                            "kind": "route",
                            "href": f"/notes/{note_id}",
                            "unresolvedReason": None,
                        },
                        "missing": False,
                        "capabilities": _surface_capabilities(
                            citable_result_type="note_block",
                            expansion_policy="note_block_owned_evidence",
                        ),
                        "versionByLane": {"body": 1, "outgoing_edges": 1},
                    },
                    "content": {
                        "kind": "note_body",
                        "body_pm_json": body_pm_json,
                        "body_text": body_text,
                    },
                },
            }
        ],
    }


def _owned_counts(db: Session, viewer_id: UUID) -> dict[str, int]:
    return {
        table: int(
            db.scalar(
                text(f"SELECT count(*) FROM {table} WHERE {owner_column} = :viewer_id"),
                {"viewer_id": viewer_id},
            )
            or 0
        )
        for table, owner_column in (
            ("pages", "user_id"),
            ("daily_page_bindings", "user_id"),
            ("note_blocks", "user_id"),
            ("resource_edges", "user_id"),
            ("resource_versions", "user_id"),
            ("resource_mutations", "user_id"),
        )
    }


def _capture(
    db: Session,
    *,
    viewer_id: UUID,
    local_date: date,
    note_id: UUID,
    mutation_id: str,
    body: str,
) -> DailyCaptureResult:
    return notes.capture_daily_page_note(
        db,
        viewer_id,
        local_date=local_date,
        request=DailyCaptureRequest(
            client_mutation_id=mutation_id,
            note_id=note_id,
            body_pm_json=_paragraph(body),
        ),
    )


def test_latent_daily_descriptor_is_a_zero_write_read(
    db_session: Session,
    bootstrapped_user: UUID,
) -> None:
    before = _owned_counts(db_session, bootstrapped_user)

    descriptor = notes.read_daily_page(
        db_session,
        bootstrapped_user,
        date(2026, 7, 4),
    )

    assert descriptor.kind == "Latent"
    assert descriptor.local_date == date(2026, 7, 4)
    assert descriptor.default_title == "July 4, 2026"
    assert _owned_counts(db_session, bootstrapped_user) == before


def test_first_capture_materializes_one_complete_daily_surface_and_replays_exactly(
    db_session: Session,
    bootstrapped_user: UUID,
) -> None:
    local_date = date(2026, 7, 5)
    note_id = uuid4()
    mutation_id = f"daily-first-{uuid4()}"

    first = _capture(
        db_session,
        viewer_id=bootstrapped_user,
        local_date=local_date,
        note_id=note_id,
        mutation_id=mutation_id,
        body="First daily thought",
    )
    replay = _capture(
        db_session,
        viewer_id=bootstrapped_user,
        local_date=local_date,
        note_id=note_id,
        mutation_id=mutation_id,
        body="First daily thought",
    )

    assert replay == first
    assert first.surface.source.item.id == first.page_id
    assert first.surface.ordered_items[-1].target.item.id == note_id
    assert first.surface.ordered_items[-1].target.content.body_text == "First daily thought"
    counts = _owned_counts(db_session, bootstrapped_user)
    assert counts["pages"] == 1
    assert counts["daily_page_bindings"] == 1
    assert counts["note_blocks"] == 1
    assert counts["resource_edges"] == 1
    assert counts["resource_versions"] == 4
    assert counts["resource_mutations"] == 1

    descriptor = notes.read_daily_page(db_session, bootstrapped_user, local_date)
    assert descriptor.kind == "Materialized"
    assert descriptor.page.daily_page is not None
    assert descriptor.page.daily_page.local_date == local_date
    assert descriptor.surface == first.surface


def test_sequential_second_capture_appends_the_exact_note_last(
    db_session: Session,
    bootstrapped_user: UUID,
) -> None:
    local_date = date(2026, 7, 9)
    first_note_id = uuid4()
    second_note_id = uuid4()
    first = _capture(
        db_session,
        viewer_id=bootstrapped_user,
        local_date=local_date,
        note_id=first_note_id,
        mutation_id=f"daily-sequential-first-{uuid4()}",
        body="First in order",
    )

    second = _capture(
        db_session,
        viewer_id=bootstrapped_user,
        local_date=local_date,
        note_id=second_note_id,
        mutation_id=f"daily-sequential-second-{uuid4()}",
        body="Exact final note",
    )

    assert second.page_id == first.page_id
    assert [occurrence.target.item.id for occurrence in second.surface.ordered_items] == [
        first_note_id,
        second_note_id,
    ]
    last = second.surface.ordered_items[-1]
    assert last.target.item.id == second_note_id
    assert last.target.content.body_pm_json == _paragraph("Exact final note")
    assert last.target.content.body_text == "Exact final note"


@pytest.mark.parametrize("changed_field", ["body", "note_id"])
def test_same_date_mutation_replay_rejects_changed_request(
    db_session: Session,
    bootstrapped_user: UUID,
    changed_field: str,
) -> None:
    local_date = date(2026, 7, 10)
    mutation_id = f"daily-same-date-mismatch-{uuid4()}"
    note_id = uuid4()
    first = _capture(
        db_session,
        viewer_id=bootstrapped_user,
        local_date=local_date,
        note_id=note_id,
        mutation_id=mutation_id,
        body="Original request",
    )

    with pytest.raises(ConflictError) as exc_info:
        _capture(
            db_session,
            viewer_id=bootstrapped_user,
            local_date=local_date,
            note_id=uuid4() if changed_field == "note_id" else note_id,
            mutation_id=mutation_id,
            body="Changed request" if changed_field == "body" else "Original request",
        )

    assert exc_info.value.code == ApiErrorCode.E_IDEMPOTENCY_KEY_REPLAY_MISMATCH
    descriptor = notes.read_daily_page(db_session, bootstrapped_user, local_date)
    assert descriptor.kind == "Materialized"
    assert descriptor.surface == first.surface
    assert _owned_counts(db_session, bootstrapped_user) == {
        "pages": 1,
        "daily_page_bindings": 1,
        "note_blocks": 1,
        "resource_edges": 1,
        "resource_versions": 4,
        "resource_mutations": 1,
    }


def test_empty_daily_capture_is_named_error_and_records_nothing(
    db_session: Session,
    bootstrapped_user: UUID,
) -> None:
    before = _owned_counts(db_session, bootstrapped_user)

    with pytest.raises(InvalidRequestError) as exc_info:
        _capture(
            db_session,
            viewer_id=bootstrapped_user,
            local_date=date(2026, 7, 6),
            note_id=uuid4(),
            mutation_id=f"daily-empty-{uuid4()}",
            body=" \n\t ",
        )

    assert exc_info.value.code == ApiErrorCode.E_EMPTY_NOTE_BODY
    assert _owned_counts(db_session, bootstrapped_user) == before


def test_daily_capture_mutation_id_reuse_at_another_date_is_hash_mismatch(
    db_session: Session,
    bootstrapped_user: UUID,
) -> None:
    mutation_id = f"daily-date-mismatch-{uuid4()}"
    note_id = uuid4()
    _capture(
        db_session,
        viewer_id=bootstrapped_user,
        local_date=date(2026, 7, 7),
        note_id=note_id,
        mutation_id=mutation_id,
        body="Frozen date",
    )

    with pytest.raises(ConflictError) as exc_info:
        _capture(
            db_session,
            viewer_id=bootstrapped_user,
            local_date=date(2026, 7, 8),
            note_id=note_id,
            mutation_id=mutation_id,
            body="Frozen date",
        )

    assert exc_info.value.code == ApiErrorCode.E_IDEMPOTENCY_KEY_REPLAY_MISMATCH
    assert _owned_counts(db_session, bootstrapped_user)["daily_page_bindings"] == 1


def test_capture_rolls_back_every_owned_write_phase_on_failure(
    auth_client,
    direct_db: DirectSessionManager,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    viewer_id = create_test_user_id()
    response = auth_client.get("/me", headers=auth_headers(viewer_id))
    assert response.status_code == 200, response.text
    _register_daily_cleanup(direct_db, viewer_id)

    with direct_db.session() as db:
        baseline = _owned_counts(db, viewer_id)

    phases: tuple[tuple[object, str], ...] = (
        (notes, "_create_daily_page_binding_without_commit"),
        (notes.resource_surfaces, "insert_note_occurrence_without_commit"),
        (notes, "record_replay"),
    )
    for index, (owner, name) in enumerate(phases):
        original = getattr(owner, name)

        def fail_after_phase(*args, _original=original, **kwargs):
            _original(*args, **kwargs)
            raise RuntimeError("injected daily capture failure")

        with monkeypatch.context() as patch:
            patch.setattr(owner, name, fail_after_phase)
            with direct_db.session() as db:
                with pytest.raises(RuntimeError, match="injected daily capture failure"):
                    _capture(
                        db,
                        viewer_id=viewer_id,
                        local_date=date(2026, 8, index + 1),
                        note_id=uuid4(),
                        mutation_id=f"daily-rollback-{index}-{uuid4()}",
                        body=f"Rollback phase {index}",
                    )
        with direct_db.session() as db:
            assert _owned_counts(db, viewer_id) == baseline


def _run_concurrently(
    operations: list[Callable[[], DailyCaptureResult]],
) -> list[DailyCaptureResult]:
    barrier = threading.Barrier(len(operations))
    results: list[DailyCaptureResult | None] = [None] * len(operations)
    errors: list[BaseException] = []
    lock = threading.Lock()

    def run(index: int, operation: Callable[[], DailyCaptureResult]) -> None:
        try:
            barrier.wait(timeout=10)
            result = operation()
            with lock:
                results[index] = result
        except BaseException as exc:  # pragma: no cover - surfaced below
            with lock:
                errors.append(exc)

    threads = [
        threading.Thread(target=run, args=(index, operation), daemon=True)
        for index, operation in enumerate(operations)
    ]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=30)
    assert all(not thread.is_alive() for thread in threads)
    assert errors == []
    return [result for result in results if result is not None]


def test_concurrent_first_captures_share_one_page_and_append_each_note_once(
    auth_client,
    direct_db: DirectSessionManager,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    viewer_id = create_test_user_id()
    response = auth_client.get("/me", headers=auth_headers(viewer_id))
    assert response.status_code == 200, response.text
    _register_daily_cleanup(direct_db, viewer_id)
    local_date = date(2026, 9, 9)
    note_ids = (uuid4(), uuid4())
    binding_barrier = threading.Barrier(2)
    proof_lock = threading.Lock()
    binding_attempts = 0
    attempts_by_thread: dict[int, int] = {}
    create_binding = notes._create_daily_page_binding_without_commit
    retry = notes.retry_serializable

    def interlocked_create_binding(*args, **kwargs):
        nonlocal binding_attempts
        with proof_lock:
            binding_attempts += 1
            attempt = binding_attempts
        if attempt <= 2:
            # Both serializable transactions have already observed no binding.
            # Releasing them here deterministically makes one first insert lose.
            binding_barrier.wait(timeout=10)
        return create_binding(*args, **kwargs)

    def counted_retry(db, label, op, *, retries=3):
        thread_id = threading.get_ident()

        def counted_op():
            with proof_lock:
                attempts_by_thread[thread_id] = attempts_by_thread.get(thread_id, 0) + 1
            return op()

        return retry(db, label, counted_op, retries=retries)

    monkeypatch.setattr(
        notes, "_create_daily_page_binding_without_commit", interlocked_create_binding
    )
    monkeypatch.setattr(notes, "retry_serializable", counted_retry)

    def capture(index: int):
        with direct_db.session() as db:
            return _capture(
                db,
                viewer_id=viewer_id,
                local_date=local_date,
                note_id=note_ids[index],
                mutation_id=f"daily-race-{index}-{uuid4()}",
                body=f"Concurrent note {index}",
            )

    results = _run_concurrently([lambda: capture(0), lambda: capture(1)])

    assert len({result.page_id for result in results}) == 1
    assert binding_attempts == 2
    assert sorted(attempts_by_thread.values()) == [1, 2]
    winning_page_id = results[0].page_id
    with direct_db.session() as db:
        counts = _owned_counts(db, viewer_id)
        assert counts == {
            "pages": 1,
            "daily_page_bindings": 1,
            "note_blocks": 2,
            "resource_edges": 2,
            "resource_versions": 6,
            "resource_mutations": 2,
        }
        persisted_note_ids = set(
            db.scalars(
                text("SELECT id FROM note_blocks WHERE user_id = :viewer_id"),
                {"viewer_id": viewer_id},
            )
        )
        assert persisted_note_ids == set(note_ids)
        persisted_edges = set(
            db.execute(
                text(
                    """
                    SELECT source_scheme, source_id, target_scheme, target_id
                    FROM resource_edges
                    WHERE user_id = :viewer_id
                    """
                ),
                {"viewer_id": viewer_id},
            ).all()
        )
        assert persisted_edges == {
            ("page", winning_page_id, "note_block", note_ids[0]),
            ("page", winning_page_id, "note_block", note_ids[1]),
        }
        persisted_versions = set(
            db.execute(
                text(
                    """
                    SELECT resource_scheme, resource_id, lane, version
                    FROM resource_versions
                    WHERE user_id = :viewer_id
                    """
                ),
                {"viewer_id": viewer_id},
            ).all()
        )
        assert persisted_versions == {
            ("page", winning_page_id, "title", 1),
            ("page", winning_page_id, "outgoing_edges", 3),
            ("note_block", note_ids[0], "body", 1),
            ("note_block", note_ids[0], "outgoing_edges", 1),
            ("note_block", note_ids[1], "body", 1),
            ("note_block", note_ids[1], "outgoing_edges", 1),
        }


def test_daily_routes_have_exact_dated_capture_and_descriptor_wire_contract(
    auth_client,
    direct_db: DirectSessionManager,
) -> None:
    owner_id = create_test_user_id()
    other_id = create_test_user_id()
    _register_daily_cleanup(direct_db, owner_id)
    _register_daily_cleanup(direct_db, other_id)
    owner_headers = auth_headers(owner_id)
    other_headers = auth_headers(other_id)
    local_date = "2026-10-04"
    title = "October 4, 2026"
    latent_envelope = {
        "data": {
            "kind": "Latent",
            "localDate": local_date,
            "defaultTitle": title,
        }
    }

    latent = auth_client.get(f"/notes/daily/{local_date}", headers=owner_headers)

    assert latent.status_code == 200, latent.text
    assert latent.json() == latent_envelope

    note_id = uuid4()
    mutation_id = f"daily-route-{uuid4()}"
    body_pm_json = _paragraph("Route thought")
    capture_request = {
        "clientMutationId": mutation_id,
        "noteId": str(note_id),
        "bodyPmJson": body_pm_json,
    }
    captured = auth_client.post(
        f"/notes/daily/{local_date}/captures",
        headers=owner_headers,
        json=capture_request,
    )

    assert captured.status_code == 201, captured.text
    capture_data = captured.json()["data"]
    page_id = UUID(capture_data["pageId"])
    occurrence_id = UUID(capture_data["surface"]["ordered_items"][0]["occurrence_id"])
    expected_surface = _expected_capture_surface(
        page_id=page_id,
        note_id=note_id,
        occurrence_id=occurrence_id,
        title=title,
        body_pm_json=body_pm_json,
        body_text="Route thought",
    )
    assert captured.json() == {
        "data": {
            "clientMutationId": mutation_id,
            "localDate": local_date,
            "pageId": str(page_id),
            "surface": expected_surface,
        }
    }

    materialized = auth_client.get(f"/notes/daily/{local_date}", headers=owner_headers)

    assert materialized.status_code == 200, materialized.text
    materialized_data = materialized.json()["data"]
    updated_at = materialized_data["page"]["updatedAt"]
    assert materialized.json() == {
        "data": {
            "kind": "Materialized",
            "localDate": local_date,
            "page": {
                "id": str(page_id),
                "title": title,
                "updatedAt": updated_at,
                "dailyPage": {"localDate": local_date},
            },
            "surface": expected_surface,
        }
    }
    assert "dailyNote" not in materialized.text

    other_user_read = auth_client.get(
        f"/notes/daily/{local_date}",
        headers=other_headers,
    )
    assert other_user_read.status_code == 200, other_user_read.text
    assert other_user_read.json() == latent_envelope


def test_daily_read_route_rejects_an_invalid_date(
    auth_client,
    direct_db: DirectSessionManager,
) -> None:
    viewer_id = create_test_user_id()
    _register_daily_cleanup(direct_db, viewer_id)

    response = auth_client.get(
        "/notes/daily/not-a-date",
        headers=auth_headers(viewer_id),
    )

    assert response.status_code == 400
    assert response.json()["error"]["code"] == ApiErrorCode.E_INVALID_REQUEST


def test_removed_quick_capture_and_undated_daily_api_return_404(
    auth_client,
    direct_db: DirectSessionManager,
) -> None:
    viewer_id = create_test_user_id()
    _register_daily_cleanup(direct_db, viewer_id)
    headers = auth_headers(viewer_id)

    assert auth_client.post("/notes/quick-capture", json={}, headers=headers).status_code == 404
    assert auth_client.get("/notes/daily", headers=headers).status_code == 404
