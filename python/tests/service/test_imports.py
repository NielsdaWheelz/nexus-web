"""Real-API proof for the Imports workspace query, its counts, and its cursors.

The risks this file owns: an import disclosed to or counted for the wrong
viewer, one import counted twice across the upload/media union, a page bound
applied before the counts it reports, a cursor that loses or repeats a row, a
History filter satisfied by two different events instead of one, an order the
reader cannot rely on, a settled outcome demanding attention, a missing
diagnostic code read as an unknown one, and a recovery route admitting work other
than the exact identity the viewer inspected.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from urllib.parse import quote
from uuid import UUID, uuid4

import pytest
from sqlalchemy.orm import Session
from starlette.testclient import TestClient

from nexus.db.models import (
    ContentIndexState,
    Media,
    MediaKind,
    MediaSourceAttempt,
    MediaUploadSession,
    ProcessingStatus,
)
from nexus.jobs.queue import complete_job, enqueue_job, fail_job, get_job
from nexus.schemas.import_history import (
    IndexSucceeded,
    MediaHistoryOwner,
    SourceAccepted,
    SourceFailed,
    SourceSucceeded,
    UploadAccepted,
    UploadHistoryBaseline,
    UploadPublished,
)
from nexus.schemas.imports import ImportListQuery
from nexus.schemas.presence import absent, present
from nexus.services.bootstrap import ensure_user_and_default_library
from nexus.services.imports import read_import_page, read_import_summary
from nexus.services.library_entries import ensure_media_in_default_library
from nexus.services.sealed_handles import seal_upload_session
from tests.testkit.auth import UserRecord
from tests.testkit.imports import (
    claim_heavy_job,
    create_source_media,
    create_upload_session,
    enqueue_source_job,
)
from tests.testkit.unreachable_state import (
    expire_heavy_job_claim,
    insert_processing_event,
    insert_upload_event,
    read_content_index_state,
    read_events,
)

INGEST_FAILURE_CODE = "E_INGEST_FAILED"


def _upload_ref(session: MediaUploadSession) -> str:
    return f"upload:{seal_upload_session(session.id)}"


def _media_ref(media_id: UUID) -> str:
    return f"media:{media_id}"


def _kill_source_job(
    db: Session,
    *,
    media_id: UUID,
    attempt: MediaSourceAttempt,
    worker: str,
) -> UUID:
    """Drive one source attempt to a terminal domain failure with a dead job."""
    job = enqueue_source_job(db, media_id=media_id, attempt=attempt, max_attempts=1)
    claim = claim_heavy_job(db, job.id, worker)
    assert (
        fail_job(
            db,
            job_id=job.id,
            worker_id=worker,
            attempt_no=claim.attempts,
            error_code=INGEST_FAILURE_CODE,
            error_message="source extraction failed",
            retry_delays_seconds=(),
        )
        == "dead"
    ), f"{worker} must leave {job.id} dead"
    attempt.status = "failed"
    attempt.error_code = INGEST_FAILURE_CODE
    return job.id


def _page(client: TestClient, query: str) -> dict:
    response = client.get(f"/imports?{query}")
    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "private, no-store"
    return response.json()["data"]


def test_needs_attention_pages_every_import_through_cursors_in_one_stable_order(
    db_session: Session,
    test_user: UserRecord,
    authenticated_client: TestClient,
) -> None:
    now = datetime.now(UTC)
    uploads = [
        create_upload_session(
            db_session,
            viewer_id=test_user.id,
            filename=f"backlog-{index:02d}.epub",
            expires_at=now - timedelta(minutes=60 - index),
        )
        for index in range(24)
    ]
    failed_id, failed_attempt = create_source_media(
        db_session,
        viewer_id=test_user.id,
        title="Extraction failed",
        attempt_no=1,
    )
    _kill_source_job(db_session, media_id=failed_id, attempt=failed_attempt, worker="dead-worker")
    db_session.flush()

    # Attention orders by stage rank, then by the server-side failure time, so
    # every upload capability expiry precedes the later Extract failure.
    expected_refs = [_upload_ref(session) for session in uploads] + [_media_ref(failed_id)]
    collected: list[str] = []
    cursor = ""
    for _page_index in range(3):
        page = _page(authenticated_client, f"view=NeedsAttention&limit=10{cursor}")
        assert page["matched_count"] == 25, page["matched_count"]
        assert page["groups"] == [
            {"stage": "Upload", "count": 24},
            {"stage": "Extract", "count": 1},
        ], page["groups"]
        collected.extend(item["ref"] for item in page["items"])
        if page["next_cursor"]["kind"] == "Absent":
            break
        cursor = f"&cursor={quote(page['next_cursor']['value'])}"

    assert page["next_cursor"] == {"kind": "Absent"}, "the last page must end the walk"
    assert collected == expected_refs, "cursors lost, repeated, or reordered an import"

    first = _page(authenticated_client, "view=NeedsAttention&limit=10")
    rebound = authenticated_client.get(
        f"/imports?view=NeedsAttention&media_kind=pdf&limit=10"
        f"&cursor={quote(first['next_cursor']['value'])}"
    )
    assert rebound.status_code == 400, (
        "a cursor minted under one filter set is not a page of another"
    )
    assert rebound.json()["error"]["code"] == "E_INVALID_CURSOR"


def test_summary_counts_the_whole_backlog_while_a_page_counts_its_filter(
    db_session: Session,
    test_user: UserRecord,
    authenticated_client: TestClient,
) -> None:
    now = datetime.now(UTC)
    create_upload_session(
        db_session,
        viewer_id=test_user.id,
        filename="expired.epub",
        expires_at=now - timedelta(minutes=3),
    )
    create_upload_session(
        db_session,
        viewer_id=test_user.id,
        filename="also-expired.epub",
        expires_at=now - timedelta(minutes=2),
    )
    failed_pdf_id, failed_pdf_attempt = create_source_media(
        db_session,
        viewer_id=test_user.id,
        title="Failed PDF",
        attempt_no=1,
    )
    _kill_source_job(
        db_session, media_id=failed_pdf_id, attempt=failed_pdf_attempt, worker="pdf-worker"
    )
    queued_id, queued_attempt = create_source_media(
        db_session,
        viewer_id=test_user.id,
        title="Queued epub",
        attempt_no=1,
        kind=MediaKind.epub,
        attempt_status="queued",
    )
    enqueue_source_job(db_session, media_id=queued_id, attempt=queued_attempt, max_attempts=3)
    queued_attempt.created_at = now - timedelta(minutes=1)
    indexing_id, indexing_attempt = create_source_media(
        db_session,
        viewer_id=test_user.id,
        title="Indexing epub",
        attempt_no=1,
        processing_status=ProcessingStatus.ready_for_reading,
        kind=MediaKind.epub,
    )
    indexing_attempt.status = "succeeded"
    indexing_attempt.created_at = now - timedelta(minutes=9)
    db_session.add(
        ContentIndexState(owner_kind="media", owner_id=indexing_id, revision=1, status="pending")
    )
    enqueue_job(
        db_session,
        kind="media_content_reindex_job",
        payload={"media_id": str(indexing_id), "revision": 1},
    )
    db_session.flush()

    summary = authenticated_client.get("/imports/summary")
    assert summary.status_code == 200, summary.text
    assert summary.headers["cache-control"] == "private, no-store"
    summary_data = summary.json()["data"]
    assert summary_data["needs_attention_count"] == 3, summary_data
    assert summary_data["active_count"] == 2, summary_data

    bounded = _page(authenticated_client, "view=NeedsAttention&limit=1")
    assert bounded["matched_count"] == 3, "counts must cover the filtered set before the limit"
    assert len(bounded["items"]) == 1
    assert bounded["next_cursor"]["kind"] == "Present"

    filtered = _page(authenticated_client, "view=NeedsAttention&media_kind=pdf&limit=50")
    assert filtered["matched_count"] == 1, filtered
    assert [item["ref"] for item in filtered["items"]] == [_media_ref(failed_pdf_id)]
    assert filtered["groups"] == [{"stage": "Extract", "count": 1}]

    in_progress = _page(authenticated_client, "view=InProgress&limit=50")
    assert in_progress["matched_count"] == 2, in_progress
    # Active work is newest accepted first, so the later-accepted queued import
    # precedes the index work accepted eight minutes before it.
    assert [item["ref"] for item in in_progress["items"]] == [
        _media_ref(queued_id),
        _media_ref(indexing_id),
    ], "in-progress imports order by acceptance time, newest first"

    unchanged = authenticated_client.get("/imports/summary")
    assert unchanged.json()["data"]["needs_attention_count"] == 3
    assert unchanged.json()["data"]["active_count"] == 2


def test_history_lists_each_import_once_in_evidence_order_without_foreign_rows(
    db_session: Session,
    test_user: UserRecord,
    authenticated_client: TestClient,
) -> None:
    now = datetime.now(UTC)
    published_media_id, published_attempt = create_source_media(
        db_session,
        viewer_id=test_user.id,
        title="Published upload",
        attempt_no=1,
        processing_status=ProcessingStatus.ready_for_reading,
        kind=MediaKind.epub,
    )
    published_attempt.status = "succeeded"
    published = create_upload_session(
        db_session,
        viewer_id=test_user.id,
        filename="published.epub",
        expires_at=now - timedelta(minutes=7),
    )
    published.published_media_id = published_media_id
    published.published_source_attempt_id = published_attempt.id
    published.published_at = now - timedelta(minutes=6)
    # The same long-expired capability, unpublished, is the live control: only
    # publication resolves an obligation, never capability freshness.
    unpublished = create_upload_session(
        db_session,
        viewer_id=test_user.id,
        filename="unpublished.epub",
        expires_at=now - timedelta(minutes=7),
    )

    foreign_user_id = uuid4()
    ensure_user_and_default_library(
        db_session,
        foreign_user_id,
        f"foreign-{foreign_user_id}@example.invalid",
    )
    foreign_media_id, foreign_attempt = create_source_media(
        db_session,
        viewer_id=foreign_user_id,
        title="Foreign import",
        attempt_no=1,
    )
    _kill_source_job(
        db_session, media_id=foreign_media_id, attempt=foreign_attempt, worker="foreign-worker"
    )
    create_upload_session(
        db_session,
        viewer_id=foreign_user_id,
        filename="foreign.epub",
        expires_at=now - timedelta(minutes=7),
    )
    # One settled media import shares the older import's evidence instant, so
    # the tie has to be broken by ref rather than left to the plan.
    settled_id, settled_attempt = create_source_media(
        db_session,
        viewer_id=test_user.id,
        title="Settled beside the tie",
        attempt_no=1,
        processing_status=ProcessingStatus.ready_for_reading,
        kind=MediaKind.epub,
    )
    settled_attempt.status = "succeeded"
    published_at = datetime(2026, 9, 3, 12, 0, tzinfo=UTC)
    older_at = datetime(2026, 9, 1, 12, 0, tzinfo=UTC)
    published_event_id = insert_upload_event(
        db_session,
        session_id=published.id,
        facts=UploadPublished(
            generation=published.upload_generation,
            media_id=published_media_id,
            source_attempt_id=published_attempt.id,
        ),
        stage=present("Upload"),
        failure_code=absent(),
        occurred_at=published_at,
    )
    insert_upload_event(
        db_session,
        session_id=unpublished.id,
        facts=UploadAccepted(generation=unpublished.upload_generation),
        stage=present("Upload"),
        failure_code=absent(),
        occurred_at=older_at,
    )
    insert_processing_event(
        db_session,
        media_id=settled_id,
        facts=SourceSucceeded(source_attempt_id=settled_attempt.id, execution_id=absent()),
        stage=present("Finalize"),
        failure_code=absent(),
        occurred_at=older_at,
    )
    db_session.flush()

    history = _page(authenticated_client, "view=History&limit=50")
    refs = [item["ref"] for item in history["items"]]
    assert refs.count(_upload_ref(published)) == 1, refs
    assert _media_ref(published_media_id) not in refs, "a published upload is not a second import"
    assert _media_ref(foreign_media_id) not in refs
    # History carries every current state, newest matching evidence first, and
    # every listed row has the event that matched, so its order key exists.
    assert refs == [_upload_ref(published)] + sorted(
        [_upload_ref(unpublished), _media_ref(settled_id)]
    ), "History orders by matched-event time and breaks its ties by ref"
    published_item = history["items"][0]
    assert published_item["media_ref"] == {
        "kind": "Present",
        "value": f"media:{published_media_id}",
    }, "the linked media is named by its resource ref, the grammar every media action speaks"
    assert published_item["state"] == {"kind": "Complete"}
    assert published_item["title"] == "published.epub"
    assert published_item["matched_event"] == {
        "kind": "Present",
        "value": {
            "id": str(published_event_id),
            "occurred_at": published_at.isoformat().replace("+00:00", "Z"),
            "stage": {"kind": "Present", "value": "Upload"},
            "failure_code": {"kind": "Absent"},
            "facts": {
                "kind": "UploadPublished",
                "generation": 1,
                "media_id": str(published_media_id),
                "source_attempt_id": str(published_attempt.id),
            },
        },
    }, "the newest event of an unfiltered History row is its match"

    attention = _page(authenticated_client, "view=NeedsAttention&limit=50")
    assert [item["ref"] for item in attention["items"]] == [_upload_ref(unpublished)]
    assert attention["matched_count"] == 1

    summary = authenticated_client.get("/imports/summary").json()["data"]
    assert summary["needs_attention_count"] == 1, "a foreign import must not reach this badge"
    assert summary["active_count"] == 0

    foreign_detail = authenticated_client.get(f"/imports/{quote(_media_ref(foreign_media_id))}")
    assert foreign_detail.status_code == 404, foreign_detail.text
    assert foreign_detail.json()["error"]["code"] == "E_IMPORT_NOT_FOUND"


def test_history_finds_a_recovered_failure_beside_its_current_complete_state(
    db_session: Session,
    test_user: UserRecord,
    authenticated_client: TestClient,
) -> None:
    media_id, attempt = create_source_media(
        db_session,
        viewer_id=test_user.id,
        title="Recovered extraction",
        attempt_no=1,
        processing_status=ProcessingStatus.ready_for_reading,
    )
    attempt.status = "succeeded"
    failed_at = datetime(2026, 9, 1, 12, 0, tzinfo=UTC)
    insert_processing_event(
        db_session,
        media_id=media_id,
        facts=SourceFailed(
            source_attempt_id=attempt.id,
            execution_id=absent(),
            origin="Domain",
            terminal=True,
            progress=absent(),
        ),
        stage=present("Extract"),
        failure_code=present(INGEST_FAILURE_CODE),
        occurred_at=failed_at,
    )
    insert_processing_event(
        db_session,
        media_id=media_id,
        facts=SourceSucceeded(source_attempt_id=attempt.id, execution_id=absent()),
        stage=present("Finalize"),
        failure_code=absent(),
        occurred_at=datetime(2026, 9, 2, 12, 0, tzinfo=UTC),
    )
    db_session.flush()

    matched = _page(authenticated_client, "view=History&had_failures=true&limit=50")

    assert [item["ref"] for item in matched["items"]] == [_media_ref(media_id)]
    item = matched["items"][0]
    assert item["state"] == {"kind": "Complete"}, "recovery must not rewrite the current state"
    assert item["matched_event"]["kind"] == "Present"
    event = item["matched_event"]["value"]
    assert event["failure_code"] == {"kind": "Present", "value": INGEST_FAILURE_CODE}
    assert event["stage"] == {"kind": "Present", "value": "Extract"}
    assert event["facts"]["kind"] == "SourceFailed"
    assert event["occurred_at"] == failed_at.isoformat().replace("+00:00", "Z")

    without_failures = _page(authenticated_client, "view=History&had_failures=false&limit=50")
    assert [item["ref"] for item in without_failures["items"]] == []


def test_history_stage_and_date_filters_must_be_satisfied_by_one_event(
    db_session: Session,
    test_user: UserRecord,
    authenticated_client: TestClient,
) -> None:
    media_id, attempt = create_source_media(
        db_session,
        viewer_id=test_user.id,
        title="Old extraction failure, recent reindex",
        attempt_no=1,
        processing_status=ProcessingStatus.ready_for_reading,
    )
    attempt.status = "succeeded"
    old_failure_at = datetime(2026, 1, 5, 9, 0, tzinfo=UTC)
    recent_index_at = datetime(2026, 9, 5, 9, 0, tzinfo=UTC)
    insert_processing_event(
        db_session,
        media_id=media_id,
        facts=SourceFailed(
            source_attempt_id=attempt.id,
            execution_id=absent(),
            origin="Domain",
            terminal=False,
            progress=absent(),
        ),
        stage=present("Extract"),
        failure_code=present(INGEST_FAILURE_CODE),
        occurred_at=old_failure_at,
    )
    insert_processing_event(
        db_session,
        media_id=media_id,
        facts=IndexSucceeded(revision=1, job_id=uuid4(), execution_id=uuid4()),
        stage=present("Index"),
        failure_code=absent(),
        occurred_at=recent_index_at,
    )
    db_session.flush()

    recent_window = "from=2026-09-01T00:00:00Z&before=2026-09-08T00:00:00Z"
    unmatched = _page(authenticated_client, f"view=History&stage=Extract&{recent_window}&limit=50")
    assert [item["ref"] for item in unmatched["items"]] == [], (
        "an old Extract failure and a recent Index event are two events, not one match"
    )
    assert unmatched["matched_count"] == 0

    matched_stage = _page(authenticated_client, "view=History&stage=Extract&limit=50")
    assert [item["ref"] for item in matched_stage["items"]] == [_media_ref(media_id)]
    assert matched_stage["items"][0]["matched_event"]["value"]["occurred_at"] == (
        old_failure_at.isoformat().replace("+00:00", "Z")
    )

    matched_index = _page(
        authenticated_client, f"view=History&stage=Index&{recent_window}&limit=50"
    )
    assert [item["ref"] for item in matched_index["items"]] == [_media_ref(media_id)]
    assert matched_index["items"][0]["matched_event"]["value"]["occurred_at"] == (
        recent_index_at.isoformat().replace("+00:00", "Z")
    )


@pytest.mark.parametrize(
    ("case", "query"),
    [
        ("attention_cannot_read_history_state", "view=NeedsAttention&state=Complete"),
        ("attention_cannot_read_failure_history", "view=NeedsAttention&had_failures=true"),
        ("attention_has_no_date_window", "view=NeedsAttention&from=2026-09-01T00:00:00Z"),
        ("progress_has_no_failure_reason", "view=InProgress&failure_code=E_INGEST_FAILED"),
        ("progress_has_no_date_window", "view=InProgress&before=2026-09-08T00:00:00Z"),
        (
            "reason_contradicts_no_failures",
            "view=History&failure_code=E_INGEST_FAILED&had_failures=false",
        ),
    ],
)
def test_imports_rejects_filter_combinations_no_view_can_correlate(
    authenticated_client: TestClient,
    case: str,
    query: str,
) -> None:
    response = authenticated_client.get(f"/imports?{query}")

    assert response.status_code == 400, f"{case}: {response.text}"
    assert response.json()["error"]["code"] == "E_INVALID_REQUEST", case


def test_upload_obligations_project_strict_state_precedence(
    db_session: Session,
    test_user: UserRecord,
    authenticated_client: TestClient,
) -> None:
    now = datetime.now(UTC)
    expired = create_upload_session(
        db_session,
        viewer_id=test_user.id,
        filename="expired.epub",
        expires_at=now - timedelta(minutes=3),
    )
    transport = create_upload_session(
        db_session,
        viewer_id=test_user.id,
        filename="transport.epub",
        expires_at=now - timedelta(minutes=4),
        transport_failure_kind="HttpRejected",
    )
    transport.transport_http_status = 503
    transport.transport_failed_at = now - timedelta(minutes=2)
    verification = create_upload_session(
        db_session,
        viewer_id=test_user.id,
        filename="verification.epub",
        expires_at=now - timedelta(minutes=5),
        verification_error_code="E_SOURCE_INTEGRITY",
    )
    verification.verification_failed_at = now - timedelta(minutes=1)
    # A live verification lease outranks the transport failure it followed.
    verifying = create_upload_session(
        db_session,
        viewer_id=test_user.id,
        filename="verifying.epub",
        expires_at=now - timedelta(minutes=6),
        transport_failure_kind="Timeout",
    )
    verifying.verification_token = uuid4()
    verifying.verification_generation = verifying.upload_generation
    verifying.verification_expires_at = now + timedelta(minutes=1)
    awaiting = create_upload_session(
        db_session,
        viewer_id=test_user.id,
        filename="awaiting.epub",
        expires_at=now + timedelta(minutes=1),
    )
    db_session.flush()

    attention = _page(authenticated_client, "view=NeedsAttention&limit=50")

    assert [item["ref"] for item in attention["items"]] == [
        _upload_ref(expired),
        _upload_ref(transport),
        _upload_ref(verification),
    ], "attention orders uploads by the server-side failure time, not by expiry"
    by_ref = {item["ref"]: item for item in attention["items"]}
    assert by_ref[_upload_ref(expired)]["state"] == {
        "kind": "NeedsAttention",
        "stage": "Upload",
        "failure_code": {"kind": "Present", "value": "E_UPLOAD_CAPABILITY_EXPIRED"},
    }, "the wire carries no failure time on an attention state"
    assert by_ref[_upload_ref(transport)]["state"] == {
        "kind": "NeedsAttention",
        "stage": "Upload",
        "failure_code": {"kind": "Present", "value": "E_UPLOAD_TRANSPORT_FAILED"},
    }
    assert by_ref[_upload_ref(verification)]["state"] == {
        "kind": "NeedsAttention",
        "stage": "Validate",
        "failure_code": {"kind": "Present", "value": "E_SOURCE_INTEGRITY"},
    }
    assert by_ref[_upload_ref(expired)]["capabilities"] == {
        "can_open": False,
        "can_remove": True,
        "recovery": {
            "kind": "Present",
            "value": {
                "kind": "RetryUpload",
                "expected_generation": 1,
                "input": "ChooseOriginalFile",
            },
        },
        "unavailable_reason": {"kind": "Absent"},
    }
    assert by_ref[_upload_ref(verification)]["capabilities"] == {
        "can_open": False,
        "can_remove": True,
        "recovery": {"kind": "Absent"},
        "unavailable_reason": {"kind": "Present", "value": "UploadRejected"},
    }
    assert by_ref[_upload_ref(expired)]["matched_event"] == {"kind": "Absent"}

    # Attention filters read the row's own current stage and reason, together.
    rejected = _page(
        authenticated_client,
        "view=NeedsAttention&stage=Validate&failure_code=E_SOURCE_INTEGRITY&limit=50",
    )
    assert [item["ref"] for item in rejected["items"]] == [_upload_ref(verification)]
    assert rejected["matched_count"] == 1
    assert rejected["groups"] == [{"stage": "Validate", "count": 1}]
    assert [
        item["ref"]
        for item in _page(authenticated_client, "view=NeedsAttention&stage=Upload&limit=50")[
            "items"
        ]
    ] == [_upload_ref(expired), _upload_ref(transport)]
    assert [
        item["ref"]
        for item in _page(
            authenticated_client,
            "view=NeedsAttention&failure_code=E_UPLOAD_TRANSPORT_FAILED&limit=50",
        )["items"]
    ] == [_upload_ref(transport)]

    in_progress = _page(authenticated_client, "view=InProgress&limit=50")
    progress_by_ref = {item["ref"]: item for item in in_progress["items"]}
    assert set(progress_by_ref) == {_upload_ref(verifying), _upload_ref(awaiting)}
    assert progress_by_ref[_upload_ref(verifying)]["state"] == {
        "kind": "Active",
        "status": "Processing",
        "stage": "Validate",
        "waiting_reason": {"kind": "Absent"},
        "progress": {"kind": "Absent"},
        "next_retry_at": {"kind": "Absent"},
    }
    assert progress_by_ref[_upload_ref(awaiting)]["state"]["stage"] == "Upload"


def test_unknown_source_failure_code_is_a_defect_not_an_import_state(
    db_session: Session,
    test_user: UserRecord,
) -> None:
    _media_id, attempt = create_source_media(
        db_session,
        viewer_id=test_user.id,
        title="Unknown terminal code",
        attempt_no=1,
        attempt_status="failed",
    )
    attempt.error_code = "E_CODE_THAT_NO_OWNER_DECLARES"
    db_session.flush()

    with pytest.raises(AssertionError, match="E_CODE_THAT_NO_OWNER_DECLARES"):
        read_import_page(
            db_session,
            viewer_id=test_user.id,
            query=ImportListQuery(view="NeedsAttention"),
            is_admin=False,
        )


@pytest.mark.parametrize("exact_status", [None, "pending", "failed", "running", "succeeded"])
def test_failed_index_without_its_exact_dead_job_is_still_a_defect(
    db_session: Session,
    test_user: UserRecord,
    exact_status: str | None,
) -> None:
    """A failed index state is repairable only through its exact dead job; any
    other queue shape beside it is a state no owner transition produces."""
    media_id, attempt = create_source_media(
        db_session,
        viewer_id=test_user.id,
        title=f"Failed index beside {exact_status or 'no'} job",
        attempt_no=1,
        processing_status=ProcessingStatus.ready_for_reading,
        kind=MediaKind.epub,
    )
    attempt.status = "succeeded"
    db_session.add(
        ContentIndexState(owner_kind="media", owner_id=media_id, revision=1, status="failed")
    )
    if exact_status is not None:
        job = enqueue_job(
            db_session,
            kind="media_content_reindex_job",
            payload={"media_id": str(media_id), "revision": 1},
        )
        if exact_status != "pending":
            claim = claim_heavy_job(
                db_session, job.id, "index-worker", allowed_kinds=("media_content_reindex_job",)
            )
        if exact_status == "failed":
            assert (
                fail_job(
                    db_session,
                    job_id=job.id,
                    worker_id="index-worker",
                    attempt_no=claim.attempts,
                    error_code="E_INDEX_RETRY",
                    error_message="retryable index failure",
                    retry_delays_seconds=(300,),
                )
                == "failed"
            )
        elif exact_status == "succeeded":
            assert complete_job(
                db_session, job_id=job.id, worker_id="index-worker", attempt_no=claim.attempts
            )
    db_session.flush()

    with pytest.raises(AssertionError, match="invariant defect"):
        read_import_page(
            db_session,
            viewer_id=test_user.id,
            query=ImportListQuery(view="NeedsAttention"),
            is_admin=False,
        )


def test_terminal_source_failure_without_a_recorded_code_still_needs_attention(
    db_session: Session,
    test_user: UserRecord,
    authenticated_client: TestClient,
) -> None:
    """A pruned diagnostic code is missing evidence, not an unknown code."""
    media_id, _attempt = create_source_media(
        db_session,
        viewer_id=test_user.id,
        title="Pruned terminal source failure",
        attempt_no=1,
        attempt_status="failed",
    )
    db_session.flush()

    attention = _page(authenticated_client, "view=NeedsAttention&limit=50")

    assert [item["ref"] for item in attention["items"]] == [_media_ref(media_id)]
    assert attention["items"][0]["state"] == {
        "kind": "NeedsAttention",
        "stage": "Extract",
        "failure_code": {"kind": "Absent"},
    }, "a failure with no safe code is still a failure the reader must see"
    summary = authenticated_client.get("/imports/summary").json()["data"]
    assert summary["needs_attention_count"] == 1
    assert summary["active_count"] == 0


@pytest.mark.parametrize("index_status", ["no_text", "ocr_required"])
def test_settled_index_outcome_is_complete_and_asks_for_nothing(
    db_session: Session,
    test_user: UserRecord,
    authenticated_client: TestClient,
    index_status: str,
) -> None:
    """No text and OCR-required are settled index obligations, not attention."""
    media_id, attempt = create_source_media(
        db_session,
        viewer_id=test_user.id,
        title=f"Terminal index {index_status}",
        attempt_no=1,
        processing_status=ProcessingStatus.ready_for_reading,
        kind=MediaKind.epub,
    )
    attempt.status = "succeeded"
    db_session.add(
        ContentIndexState(owner_kind="media", owner_id=media_id, revision=1, status=index_status)
    )
    insert_processing_event(
        db_session,
        media_id=media_id,
        facts=SourceSucceeded(source_attempt_id=attempt.id, execution_id=absent()),
        stage=present("Finalize"),
        failure_code=absent(),
        occurred_at=datetime(2026, 9, 4, 8, 0, tzinfo=UTC),
    )
    db_session.flush()

    assert _page(authenticated_client, "view=NeedsAttention&limit=50")["items"] == []
    assert _page(authenticated_client, "view=InProgress&limit=50")["items"] == []
    history = _page(authenticated_client, "view=History&limit=50")
    assert [item["ref"] for item in history["items"]] == [_media_ref(media_id)]
    assert history["items"][0]["state"] == {"kind": "Complete"}
    summary = authenticated_client.get("/imports/summary").json()["data"]
    assert summary["needs_attention_count"] == 0
    assert summary["active_count"] == 0


def test_in_progress_reads_queue_reasons_backoff_and_counted_progress_from_owner_state(
    db_session: Session,
    test_user: UserRecord,
    authenticated_client: TestClient,
) -> None:
    backoff_id, backoff_attempt = create_source_media(
        db_session, viewer_id=test_user.id, title="Retry backoff", attempt_no=1
    )
    backoff_job = enqueue_source_job(
        db_session, media_id=backoff_id, attempt=backoff_attempt, max_attempts=2
    )
    backoff_claim = claim_heavy_job(db_session, backoff_job.id, "backoff-worker")
    assert (
        fail_job(
            db_session,
            job_id=backoff_job.id,
            worker_id="backoff-worker",
            attempt_no=backoff_claim.attempts,
            error_code="E_WORKER_INTERRUPTED",
            error_message="worker interrupted",
            retry_delays_seconds=(300,),
        )
        == "failed"
    )
    running_id, running_attempt = create_source_media(
        db_session,
        viewer_id=test_user.id,
        title="Running bounded PDF",
        attempt_no=1,
        progress=(80, 712),
    )
    running_job = enqueue_source_job(
        db_session, media_id=running_id, attempt=running_attempt, max_attempts=3
    )
    claim_heavy_job(db_session, running_job.id, "active-worker")
    capacity_id, capacity_attempt = create_source_media(
        db_session, viewer_id=test_user.id, title="Waiting for capacity", attempt_no=1
    )
    enqueue_source_job(db_session, media_id=capacity_id, attempt=capacity_attempt, max_attempts=3)
    db_session.flush()

    by_ref = {
        item["ref"]: item
        for item in _page(authenticated_client, "view=InProgress&limit=50")["items"]
    }

    backoff_job_row = get_job(db_session, backoff_job.id)
    assert backoff_job_row is not None
    assert by_ref[_media_ref(backoff_id)]["state"] == {
        "kind": "Active",
        "status": "Queued",
        "stage": "Extract",
        "waiting_reason": {"kind": "Present", "value": "RetryBackoff"},
        "progress": {
            "kind": "Present",
            "value": {
                "kind": "Stage",
                "stage": "Extract",
                "run_count": 1,
                "updated_at": backoff_attempt.progress_updated_at.isoformat().replace(
                    "+00:00", "Z"
                ),
            },
        },
        "next_retry_at": {
            "kind": "Present",
            "value": backoff_job_row.available_at.isoformat().replace("+00:00", "Z"),
        },
    }, "a scheduled retry names the instant the queue will run it again"
    running_state = by_ref[_media_ref(running_id)]["state"]
    assert running_state["status"] == "Processing"
    assert running_state["waiting_reason"] == {"kind": "Absent"}
    assert running_state["progress"] == {
        "kind": "Present",
        "value": {
            "kind": "Counted",
            "stage": "Extract",
            "completed": 80,
            "total": 712,
            "unit": "Page",
            "run_count": 1,
            "updated_at": running_attempt.progress_updated_at.isoformat().replace("+00:00", "Z"),
        },
    }, "counted progress comes from the source owner's recorded snapshot"
    assert by_ref[_media_ref(capacity_id)]["state"]["waiting_reason"] == {
        "kind": "Present",
        "value": "Capacity",
    }, "a due job behind the Heavy capacity holder waits for capacity, not the queue"

    expire_heavy_job_claim(db_session, job_id=running_job.id)
    db_session.flush()
    after_expiry = {
        item["ref"]: item
        for item in _page(authenticated_client, "view=InProgress&limit=50")["items"]
    }
    assert after_expiry[_media_ref(capacity_id)]["state"]["waiting_reason"] == {
        "kind": "Present",
        "value": "Queue",
    }, "once the capacity lease lapses the same job is merely queued"


def test_orders_follow_lifecycle_evidence_not_media_edits(
    db_session: Session,
    test_user: UserRecord,
    authenticated_client: TestClient,
) -> None:
    old_time = datetime(2020, 1, 1, tzinfo=UTC)
    new_time = datetime(2020, 1, 2, tzinfo=UTC)
    old_failed_id, old_failed = create_source_media(
        db_session,
        viewer_id=test_user.id,
        title="Old failure",
        attempt_no=1,
        attempt_status="failed",
    )
    new_failed_id, new_failed = create_source_media(
        db_session,
        viewer_id=test_user.id,
        title="New failure",
        attempt_no=1,
        attempt_status="failed",
    )
    old_active_id, old_active = create_source_media(
        db_session,
        viewer_id=test_user.id,
        title="Old active",
        attempt_no=1,
        attempt_status="accepted",
    )
    new_active_id, new_active = create_source_media(
        db_session,
        viewer_id=test_user.id,
        title="New active",
        attempt_no=1,
        attempt_status="accepted",
    )
    old_failed.finished_at = old_time
    new_failed.finished_at = new_time
    old_active.created_at = old_time
    new_active.created_at = new_time
    # Unrelated media edits run the other way; neither order may follow them.
    db_session.get(Media, old_failed_id).updated_at = new_time
    db_session.get(Media, new_failed_id).updated_at = old_time
    db_session.get(Media, old_active_id).updated_at = new_time
    db_session.get(Media, new_active_id).updated_at = old_time
    db_session.flush()

    attention = _page(authenticated_client, "view=NeedsAttention&limit=50")
    in_progress = _page(authenticated_client, "view=InProgress&limit=50")

    assert [item["ref"] for item in attention["items"]] == [
        _media_ref(old_failed_id),
        _media_ref(new_failed_id),
    ], "attention lists the oldest unresolved failure first"
    assert [item["ref"] for item in in_progress["items"]] == [
        _media_ref(new_active_id),
        _media_ref(old_active_id),
    ], "in-progress lists the newest accepted work first"


def test_published_source_with_a_later_dead_job_is_complete_and_offers_nothing(
    db_session: Session,
    test_user: UserRecord,
    authenticated_client: TestClient,
) -> None:
    """A dead job after publication is an operator anomaly, never the reader's."""
    media_id, attempt = create_source_media(
        db_session,
        viewer_id=test_user.id,
        title="Published then interrupted",
        attempt_no=1,
        processing_status=ProcessingStatus.ready_for_reading,
        kind=MediaKind.epub,
    )
    attempt.status = "succeeded"
    attempt.processing_stage = "Finalize"
    job = enqueue_source_job(db_session, media_id=media_id, attempt=attempt, max_attempts=1)
    claim = claim_heavy_job(db_session, job.id, "publication-worker")
    assert (
        fail_job(
            db_session,
            job_id=job.id,
            worker_id="publication-worker",
            attempt_no=claim.attempts,
            error_code="E_WORKER_INTERRUPTED",
            error_message="worker interrupted",
            retry_delays_seconds=(),
        )
        == "dead"
    )
    db_session.flush()

    assert _page(authenticated_client, "view=NeedsAttention&limit=50")["items"] == []
    assert _page(authenticated_client, "view=InProgress&limit=50")["items"] == []
    summary = authenticated_client.get("/imports/summary").json()["data"]
    assert (summary["needs_attention_count"], summary["active_count"]) == (0, 0)
    detail = authenticated_client.get(f"/imports/{quote(_media_ref(media_id))}")
    assert detail.status_code == 200, detail.text
    item = detail.json()["data"]["item"]
    assert item["state"] == {"kind": "Complete"}
    assert item["capabilities"]["recovery"] == {"kind": "Absent"}
    assert item["capabilities"]["unavailable_reason"] == {"kind": "Absent"}


def test_detail_of_an_upload_origin_ref_resolves_its_media_and_reports_coverage(
    db_session: Session,
    test_user: UserRecord,
    authenticated_client: TestClient,
) -> None:
    now = datetime.now(UTC)
    media_id, attempt = create_source_media(
        db_session,
        viewer_id=test_user.id,
        title="Published upload",
        attempt_no=1,
        processing_status=ProcessingStatus.ready_for_reading,
        kind=MediaKind.epub,
    )
    attempt.status = "succeeded"
    db_session.add(
        ContentIndexState(owner_kind="media", owner_id=media_id, revision=1, status="ready")
    )
    published = create_upload_session(
        db_session,
        viewer_id=test_user.id,
        filename="published.epub",
        expires_at=now - timedelta(minutes=7),
    )
    published.published_media_id = media_id
    published.published_source_attempt_id = attempt.id
    published.published_at = now - timedelta(minutes=6)
    # This session predates history recording: its baseline is its only upload
    # event, so its detail must say so rather than claim a full record.
    recorded_since = datetime(2026, 9, 6, 8, 0, tzinfo=UTC)
    insert_upload_event(
        db_session,
        session_id=published.id,
        facts=UploadHistoryBaseline(generation=published.upload_generation),
        stage=absent(),
        failure_code=absent(),
        occurred_at=recorded_since,
    )
    fully_recorded_id, fully_recorded = create_source_media(
        db_session,
        viewer_id=test_user.id,
        title="Recorded from acceptance",
        attempt_no=1,
        attempt_status="queued",
    )
    insert_processing_event(
        db_session,
        media_id=fully_recorded_id,
        facts=SourceAccepted(source_attempt_id=fully_recorded.id, attempt_no=1),
        stage=present("Validate"),
        failure_code=absent(),
        occurred_at=now,
    )
    db_session.flush()

    detail = authenticated_client.get(f"/imports/{quote(_upload_ref(published))}")

    assert detail.status_code == 200, detail.text
    assert detail.headers["cache-control"] == "private, no-store"
    data = detail.json()["data"]
    assert data["item"]["ref"] == _upload_ref(published)
    assert data["item"]["title"] == "published.epub"
    assert data["item"]["media_ref"] == {"kind": "Present", "value": f"media:{media_id}"}
    assert data["item"]["state"] == {"kind": "Complete"}
    assert data["item"]["source_label"] == {"kind": "Absent"}
    assert data["item"]["capabilities"]["can_open"] is True
    assert data["readiness"] == {"can_read": True, "can_search": True, "can_play": False}
    assert data["history_coverage"] == {
        "kind": "Partial",
        "recorded_since": recorded_since.isoformat().replace("+00:00", "Z"),
    }, "a baseline row means detailed history before it was never recorded"

    as_media = authenticated_client.get(f"/imports/{quote(_media_ref(media_id))}")
    assert as_media.status_code == 404, "an upload-origin media is not a second import"
    assert as_media.json()["error"]["code"] == "E_IMPORT_NOT_FOUND"

    recorded = authenticated_client.get(f"/imports/{quote(_media_ref(fully_recorded_id))}")
    assert recorded.status_code == 200, recorded.text
    assert recorded.json()["data"]["history_coverage"] == {"kind": "Full"}
    assert recorded.json()["data"]["readiness"] == {
        "can_read": False,
        "can_search": False,
        "can_play": False,
    }


def test_history_of_an_upload_origin_import_merges_both_owners_newest_first_through_cursors(
    db_session: Session,
    test_user: UserRecord,
    authenticated_client: TestClient,
) -> None:
    now = datetime.now(UTC)
    media_id, attempt = create_source_media(
        db_session,
        viewer_id=test_user.id,
        title="Published upload",
        attempt_no=1,
        processing_status=ProcessingStatus.ready_for_reading,
        kind=MediaKind.epub,
    )
    attempt.status = "succeeded"
    published = create_upload_session(
        db_session,
        viewer_id=test_user.id,
        filename="published.epub",
        expires_at=now - timedelta(minutes=7),
    )
    published.published_media_id = media_id
    published.published_source_attempt_id = attempt.id
    published.published_at = now - timedelta(minutes=6)
    instants = [datetime(2026, 9, 5, 12, minute, tzinfo=UTC) for minute in range(4)]
    accepted_id = insert_upload_event(
        db_session,
        session_id=published.id,
        facts=UploadAccepted(generation=1),
        stage=present("Upload"),
        failure_code=absent(),
        occurred_at=instants[0],
    )
    published_id = insert_upload_event(
        db_session,
        session_id=published.id,
        facts=UploadPublished(generation=1, media_id=media_id, source_attempt_id=attempt.id),
        stage=present("Upload"),
        failure_code=absent(),
        occurred_at=instants[1],
    )
    source_accepted_id = insert_processing_event(
        db_session,
        media_id=media_id,
        facts=SourceAccepted(source_attempt_id=attempt.id, attempt_no=1),
        stage=present("Validate"),
        failure_code=absent(),
        occurred_at=instants[2],
    )
    succeeded_id = insert_processing_event(
        db_session,
        media_id=media_id,
        facts=SourceSucceeded(source_attempt_id=attempt.id, execution_id=absent()),
        stage=present("Finalize"),
        failure_code=absent(),
        occurred_at=instants[3],
    )
    foreign_user_id = uuid4()
    ensure_user_and_default_library(
        db_session, foreign_user_id, f"foreign-{foreign_user_id}@example.invalid"
    )
    foreign = create_upload_session(
        db_session,
        viewer_id=foreign_user_id,
        filename="foreign.epub",
        expires_at=now - timedelta(minutes=7),
    )
    db_session.flush()

    ref = quote(_upload_ref(published))
    first = authenticated_client.get(f"/imports/{ref}/history?limit=2")
    assert first.status_code == 200, first.text
    assert first.headers["cache-control"] == "private, no-store"
    first_page = first.json()["data"]
    assert [entry["id"] for entry in first_page["entries"]] == [
        str(succeeded_id),
        str(source_accepted_id),
    ], "the media's processing history and the session's upload history are one record"
    assert first_page["entries"][0]["facts"]["kind"] == "SourceSucceeded"
    assert first_page["next_cursor"]["kind"] == "Present"

    cursor = quote(first_page["next_cursor"]["value"])
    second_page = authenticated_client.get(f"/imports/{ref}/history?limit=2&cursor={cursor}")
    assert second_page.status_code == 200, second_page.text
    assert [entry["id"] for entry in second_page.json()["data"]["entries"]] == [
        str(published_id),
        str(accepted_id),
    ], "the continuation resumes exactly after the last entry it returned"
    assert second_page.json()["data"]["next_cursor"] == {"kind": "Absent"}

    other_id, other_attempt = create_source_media(
        db_session, viewer_id=test_user.id, title="Another import", attempt_no=1
    )
    insert_processing_event(
        db_session,
        media_id=other_id,
        facts=SourceAccepted(source_attempt_id=other_attempt.id, attempt_no=1),
        stage=present("Validate"),
        failure_code=absent(),
        occurred_at=instants[0],
    )
    db_session.flush()
    misapplied = authenticated_client.get(
        f"/imports/{quote(_media_ref(other_id))}/history?cursor={cursor}"
    )
    assert misapplied.status_code == 400, "a cursor is bound to the import it was minted for"
    assert misapplied.json()["error"]["code"] == "E_INVALID_CURSOR"
    foreign_history = authenticated_client.get(f"/imports/{quote(_upload_ref(foreign))}/history")
    assert foreign_history.status_code == 404, foreign_history.text
    assert foreign_history.json()["error"]["code"] == "E_IMPORT_NOT_FOUND"
    foreign_detail = authenticated_client.get(f"/imports/{quote(_upload_ref(foreign))}")
    assert foreign_detail.status_code == 404, "a foreign session handle names no import here"


def test_repair_routes_admit_only_the_inspected_dead_job(
    db_session: Session,
    test_user: UserRecord,
    authenticated_client: TestClient,
) -> None:
    media_id, attempt = create_source_media(
        db_session, viewer_id=test_user.id, title="Interrupted extraction", attempt_no=1
    )
    job = enqueue_source_job(db_session, media_id=media_id, attempt=attempt, max_attempts=1)
    claim = claim_heavy_job(db_session, job.id, "dead-worker")
    assert (
        fail_job(
            db_session,
            job_id=job.id,
            worker_id="dead-worker",
            attempt_no=claim.attempts,
            error_code="E_WORKER_INTERRUPTED",
            error_message="worker interrupted",
            retry_delays_seconds=(),
        )
        == "dead"
    )
    db_session.flush()

    offered = _page(authenticated_client, "view=NeedsAttention&limit=50")["items"][0]
    assert offered["ref"] == _media_ref(media_id)
    assert offered["capabilities"]["recovery"] == {
        "kind": "Present",
        "value": {
            "kind": "RepairSource",
            "expected_attempt_id": str(attempt.id),
            "expected_job_id": str(job.id),
            "input": "StoredSource",
        },
    }, "a stopped upload-file extraction reruns from the stored artifact"

    stale = authenticated_client.post(
        f"/media/{media_id}/repair",
        json={
            "kind": "Source",
            "client_mutation_id": str(uuid4()),
            "expected_attempt_id": str(attempt.id),
            "expected_job_id": str(uuid4()),
        },
    )
    assert stale.status_code == 409, stale.text
    assert stale.json()["error"]["code"] == "E_RESOURCE_CONFLICT"
    assert stale.json()["error"]["details"]["current"]["job_id"] == str(job.id)

    wrong_scope = authenticated_client.post(
        f"/media/{media_id}/repair",
        json={
            "kind": "Search",
            "client_mutation_id": str(uuid4()),
            "expected_revision": 1,
            "expected_job_id": str(job.id),
        },
    )
    assert wrong_scope.status_code == 409, wrong_scope.text
    assert wrong_scope.json()["error"]["code"] == "E_REPAIR_NOT_ALLOWED"

    repaired = authenticated_client.post(
        f"/media/{media_id}/repair",
        json={
            "kind": "Source",
            "client_mutation_id": str(uuid4()),
            "expected_attempt_id": str(attempt.id),
            "expected_job_id": str(job.id),
        },
    )
    assert repaired.status_code == 202, repaired.text
    assert repaired.json()["data"] == {
        "kind": "SourceRepair",
        "media_id": str(media_id),
        "source_attempt_id": str(attempt.id),
        "job_id": str(job.id),
    }
    assert _page(authenticated_client, "view=NeedsAttention&limit=50")["items"] == []
    assert [item["ref"] for item in _page(authenticated_client, "view=InProgress")["items"]] == [
        _media_ref(media_id)
    ], "an admitted repair moves the import back to In progress at once"

    nothing_dead = authenticated_client.post(f"/internal/ingest/source/{media_id}/retry-dead")
    assert nothing_dead.status_code == 409, nothing_dead.text
    assert nothing_dead.json()["error"]["code"] == "E_REPAIR_NOT_ALLOWED"
    no_index = authenticated_client.post(f"/internal/ingest/content-index/{media_id}/retry-dead")
    assert no_index.status_code == 409, no_index.text
    assert no_index.json()["error"]["code"] == "E_REPAIR_NOT_ALLOWED"


def test_operator_repair_requeues_the_medias_current_dead_source_job(
    db_session: Session,
    test_user: UserRecord,
    authenticated_client: TestClient,
) -> None:
    """The operator route carries no inspected identity: it resolves the media's
    current dead source execution through the owner and requeues that one job."""
    media_id, attempt = create_source_media(
        db_session, viewer_id=test_user.id, title="Stopped extraction", attempt_no=1
    )
    job = enqueue_source_job(db_session, media_id=media_id, attempt=attempt, max_attempts=1)
    claim = claim_heavy_job(db_session, job.id, "stopped-worker")
    assert (
        fail_job(
            db_session,
            job_id=job.id,
            worker_id="stopped-worker",
            attempt_no=claim.attempts,
            error_code="E_WORKER_INTERRUPTED",
            error_message="worker interrupted",
            retry_delays_seconds=(),
        )
        == "dead"
    ), "the operator route needs a dead execution to repair"
    # The owner read ends its own transaction, so the backlog it resolves has to
    # be durable before the route runs.
    db_session.commit()

    unknown = authenticated_client.post(f"/internal/ingest/source/{uuid4()}/retry-dead")
    assert unknown.status_code == 404, unknown.text
    assert unknown.json()["error"]["code"] == "E_MEDIA_NOT_FOUND"

    repaired = authenticated_client.post(f"/internal/ingest/source/{media_id}/retry-dead")

    assert repaired.status_code == 202, repaired.text
    assert repaired.json()["data"] == {"media_id": str(media_id), "job_id": str(job.id)}
    requeued = get_job(db_session, job.id)
    assert requeued is not None and requeued.status == "pending", "the exact dead job runs again"
    assert [
        event["event_type"]
        for event in read_events(db_session, owner=MediaHistoryOwner(media_id=media_id))
    ] == ["RecoveryAccepted"], "an operator repair is recorded like any other recovery"
    assert [item["ref"] for item in _page(authenticated_client, "view=InProgress")["items"]] == [
        _media_ref(media_id)
    ], "the repaired import is active work again"


def test_operator_repair_requeues_the_dead_job_of_the_current_index_revision(
    db_session: Session,
    test_user: UserRecord,
    authenticated_client: TestClient,
) -> None:
    """The search route resolves the dead reindex job of the media's current
    index revision and requeues that one job."""
    media_id, attempt = create_source_media(
        db_session,
        viewer_id=test_user.id,
        title="Stopped indexing",
        attempt_no=1,
        processing_status=ProcessingStatus.ready_for_reading,
        kind=MediaKind.epub,
    )
    attempt.status = "succeeded"
    # `indexing` is what `prepare_media_content_reindex` leaves behind while an
    # execution holds the revision; nothing marks a media content index `failed`.
    db_session.add(
        ContentIndexState(owner_kind="media", owner_id=media_id, revision=1, status="indexing")
    )
    job = enqueue_job(
        db_session,
        kind="media_content_reindex_job",
        payload={"media_id": str(media_id), "revision": 1},
        max_attempts=1,
    )
    claim = claim_heavy_job(
        db_session, job.id, "index-worker", allowed_kinds=("media_content_reindex_job",)
    )
    assert (
        fail_job(
            db_session,
            job_id=job.id,
            worker_id="index-worker",
            attempt_no=claim.attempts,
            error_code="E_WORKER_INTERRUPTED",
            error_message="worker interrupted",
            retry_delays_seconds=(),
        )
        == "dead"
    ), "the operator route needs a dead reindex execution to repair"
    db_session.commit()

    unknown = authenticated_client.post(f"/internal/ingest/content-index/{uuid4()}/retry-dead")
    assert unknown.status_code == 404, unknown.text
    assert unknown.json()["error"]["code"] == "E_MEDIA_NOT_FOUND"

    repaired = authenticated_client.post(f"/internal/ingest/content-index/{media_id}/retry-dead")

    assert repaired.status_code == 202, repaired.text
    assert repaired.json()["data"] == {"media_id": str(media_id), "job_id": str(job.id)}
    requeued = get_job(db_session, job.id)
    assert requeued is not None and requeued.status == "pending", "the exact dead job runs again"
    assert read_content_index_state(db_session, owner_id=media_id) == (
        "indexing",
        1,
    ), "search repair rewrote the index materialization instead of rerunning the job"
    assert [
        event["event_type"]
        for event in read_events(db_session, owner=MediaHistoryOwner(media_id=media_id))
    ] == ["RecoveryAccepted"], "an operator repair is recorded like any other recovery"
    assert [item["ref"] for item in _page(authenticated_client, "view=InProgress")["items"]] == [
        _media_ref(media_id)
    ], "the repaired index obligation is active work again"


def test_attention_reports_the_attempts_domain_code_over_a_stale_queue_code(
    db_session: Session,
    test_user: UserRecord,
    authenticated_client: TestClient,
) -> None:
    """A reclaimed execution leaves `E_WORKER_INTERRUPTED` on the queue row; the
    rerun's terminal domain failure is the attempt's own code, and the reason the
    reader filters by."""
    media_id, attempt = create_source_media(
        db_session, viewer_id=test_user.id, title="Interrupted, then rejected", attempt_no=1
    )
    job = enqueue_source_job(db_session, media_id=media_id, attempt=attempt, max_attempts=3)
    claim_heavy_job(db_session, job.id, "first-worker")
    expire_heavy_job_claim(db_session, job_id=job.id)
    reclaim = claim_heavy_job(db_session, job.id, "second-worker")
    assert complete_job(
        db_session, job_id=job.id, worker_id="second-worker", attempt_no=reclaim.attempts
    )
    queue_row = get_job(db_session, job.id)
    assert queue_row is not None and queue_row.status == "succeeded"
    assert queue_row.error_code == "E_WORKER_INTERRUPTED", (
        "the queue keeps the interrupted execution's code after the rerun succeeds"
    )
    attempt.status = "failed"
    attempt.error_code = "E_SOURCE_INTEGRITY"
    db_session.flush()

    by_domain_code = _page(
        authenticated_client, "view=NeedsAttention&failure_code=E_SOURCE_INTEGRITY&limit=50"
    )

    assert [item["ref"] for item in by_domain_code["items"]] == [_media_ref(media_id)], (
        "a failed attempt's reason is its own domain code, not the queue's stale one"
    )
    assert by_domain_code["items"][0]["state"] == {
        "kind": "NeedsAttention",
        "stage": "Extract",
        "failure_code": {"kind": "Present", "value": "E_SOURCE_INTEGRITY"},
    }
    by_queue_code = _page(
        authenticated_client, "view=NeedsAttention&failure_code=E_WORKER_INTERRUPTED&limit=50"
    )
    assert by_queue_code["items"] == [], "the interrupted execution is not this failure's reason"


def test_search_matches_title_upload_filename_and_source_host_literally(
    db_session: Session,
    test_user: UserRecord,
    authenticated_client: TestClient,
) -> None:
    now = datetime.now(UTC)
    url_id, _url_attempt = create_source_media(
        db_session,
        viewer_id=test_user.id,
        title="Quarterly report 100% done",
        attempt_no=1,
        attempt_status="failed",
    )
    db_session.get(Media, url_id).requested_url = "https://News.Example.org/reports/100"
    plain_id, _plain_attempt = create_source_media(
        db_session,
        viewer_id=test_user.id,
        title="Quarterly report 100 done",
        attempt_no=1,
        attempt_status="failed",
    )
    dashed_id, _dashed_attempt = create_source_media(
        db_session,
        viewer_id=test_user.id,
        title="report-q3 notes",
        attempt_no=1,
        attempt_status="failed",
    )
    upload = create_upload_session(
        db_session,
        viewer_id=test_user.id,
        filename="report_q3.epub",
        expires_at=now - timedelta(minutes=1),
    )
    db_session.flush()

    def found(q: str) -> list[str]:
        page = _page(authenticated_client, f"view=NeedsAttention&q={quote(q)}&limit=50")
        return sorted(item["ref"] for item in page["items"])

    assert found("report") == sorted(
        [_media_ref(url_id), _media_ref(plain_id), _media_ref(dashed_id), _upload_ref(upload)]
    ), "search reads titles and upload filenames alike"
    assert found("100%") == [_media_ref(url_id)], "a percent sign is a character, not a wildcard"
    assert found("t_q") == [_upload_ref(upload)], "an underscore is a character, not a wildcard"
    assert found("example.org") == [_media_ref(url_id)], "search reads the source host"
    assert found("reports/100") == [], "the URL path is not a searched field"
    assert found("https") == [], "the URL scheme is not a searched field"
    by_ref = {
        item["ref"]: item
        for item in _page(authenticated_client, "view=NeedsAttention&limit=50")["items"]
    }
    assert by_ref[_media_ref(url_id)]["source_label"] == {
        "kind": "Present",
        "value": "news.example.org",
    }, "a URL import is labelled by its host"
    assert by_ref[_media_ref(plain_id)]["source_label"] == {"kind": "Absent"}
    assert by_ref[_upload_ref(upload)]["source_label"] == {"kind": "Absent"}


def test_history_state_filter_keeps_the_newest_event_as_the_match(
    db_session: Session,
    test_user: UserRecord,
    authenticated_client: TestClient,
) -> None:
    complete_id, complete_attempt = create_source_media(
        db_session,
        viewer_id=test_user.id,
        title="Settled",
        attempt_no=1,
        processing_status=ProcessingStatus.ready_for_reading,
        kind=MediaKind.epub,
    )
    complete_attempt.status = "succeeded"
    failed_id, failed_attempt = create_source_media(
        db_session, viewer_id=test_user.id, title="Rejected", attempt_no=1, attempt_status="failed"
    )
    failed_attempt.error_code = INGEST_FAILURE_CODE
    accepted_at = datetime(2026, 9, 3, 9, 0, tzinfo=UTC)
    settled_at = datetime(2026, 9, 3, 10, 0, tzinfo=UTC)
    for media_id, attempt in ((complete_id, complete_attempt), (failed_id, failed_attempt)):
        insert_processing_event(
            db_session,
            media_id=media_id,
            facts=SourceAccepted(source_attempt_id=attempt.id, attempt_no=1),
            stage=present("Validate"),
            failure_code=absent(),
            occurred_at=accepted_at,
        )
    succeeded_event_id = insert_processing_event(
        db_session,
        media_id=complete_id,
        facts=SourceSucceeded(source_attempt_id=complete_attempt.id, execution_id=absent()),
        stage=present("Finalize"),
        failure_code=absent(),
        occurred_at=settled_at,
    )
    failed_event_id = insert_processing_event(
        db_session,
        media_id=failed_id,
        facts=SourceFailed(
            source_attempt_id=failed_attempt.id,
            execution_id=absent(),
            origin="Domain",
            terminal=True,
            progress=absent(),
        ),
        stage=present("Extract"),
        failure_code=present(INGEST_FAILURE_CODE),
        occurred_at=settled_at,
    )
    db_session.flush()

    complete = _page(authenticated_client, "view=History&state=Complete&limit=50")
    assert [item["ref"] for item in complete["items"]] == [_media_ref(complete_id)]
    assert complete["items"][0]["state"] == {"kind": "Complete"}
    assert complete["items"][0]["matched_event"]["value"]["id"] == str(succeeded_event_id), (
        "a state filter narrows membership; the match stays the newest event"
    )
    assert complete["groups"] == [], "a settled import has no current stage to group"

    attention = _page(authenticated_client, "view=History&state=NeedsAttention&limit=50")
    assert [item["ref"] for item in attention["items"]] == [_media_ref(failed_id)]
    assert attention["items"][0]["matched_event"]["value"]["id"] == str(failed_event_id)
    assert attention["groups"] == [{"stage": "Extract", "count": 1}], (
        "History groups its filtered set by current stage like every other view"
    )

    assert _page(authenticated_client, "view=History&state=Active&limit=50")["items"] == []
    everything = _page(authenticated_client, "view=History&limit=50")
    assert everything["matched_count"] == 2
    assert everything["groups"] == [{"stage": "Extract", "count": 1}]


def test_a_sharee_sees_a_published_upload_as_the_media_it_can_read(
    db_session: Session,
    test_user: UserRecord,
    authenticated_client: TestClient,
) -> None:
    """The upload identity belongs to the session's creator; a viewer who can
    only read the media sees the media import, with no recovery to offer."""
    now = datetime.now(UTC)
    media_id, attempt = create_source_media(
        db_session, viewer_id=test_user.id, title="Shared upload", attempt_no=1
    )
    job = enqueue_source_job(db_session, media_id=media_id, attempt=attempt, max_attempts=1)
    claim = claim_heavy_job(db_session, job.id, "shared-worker")
    assert (
        fail_job(
            db_session,
            job_id=job.id,
            worker_id="shared-worker",
            attempt_no=claim.attempts,
            error_code="E_WORKER_INTERRUPTED",
            error_message="worker interrupted",
            retry_delays_seconds=(),
        )
        == "dead"
    )
    published = create_upload_session(
        db_session,
        viewer_id=test_user.id,
        filename="shared.epub",
        expires_at=now - timedelta(minutes=7),
    )
    published.published_media_id = media_id
    published.published_source_attempt_id = attempt.id
    published.published_at = now - timedelta(minutes=6)
    sharee_id = uuid4()
    ensure_user_and_default_library(db_session, sharee_id, f"sharee-{sharee_id}@example.invalid")
    ensure_media_in_default_library(db_session, sharee_id, media_id)
    db_session.flush()

    creator = _page(authenticated_client, "view=NeedsAttention&limit=50")
    assert [item["ref"] for item in creator["items"]] == [_upload_ref(published)]
    assert creator["items"][0]["capabilities"]["recovery"]["kind"] == "Present"

    sharee = read_import_page(
        db_session,
        viewer_id=sharee_id,
        query=ImportListQuery(view="NeedsAttention"),
        is_admin=False,
    )
    assert [str(item.ref) for item in sharee.items] == [_media_ref(media_id)], (
        "the sharee's import is the media it can read, never the creator's upload"
    )
    assert sharee.matched_count == 1
    assert sharee.items[0].title == "Shared upload"
    assert sharee.items[0].capabilities.recovery == absent()
    assert sharee.items[0].capabilities.unavailable_reason == present("NotOwner")
    assert read_import_summary(db_session, viewer_id=sharee_id).needs_attention_count == 1
