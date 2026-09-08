"""Real-API proof for the Imports workspace query, its counts, and its cursors.

The risks this file owns: an import disclosed to or counted for the wrong
viewer, one import counted twice across the upload/media union, a page bound
applied before the counts it reports, a cursor that loses or repeats a row, a
History filter satisfied by two different events instead of one, an order the
reader cannot rely on, a settled outcome demanding attention, and a missing
diagnostic code read as an unknown one.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from urllib.parse import quote
from uuid import UUID, uuid4

import pytest
from nexus.services.imports import read_import_page
from sqlalchemy.orm import Session
from starlette.testclient import TestClient

from nexus.db.models import (
    ContentIndexState,
    MediaKind,
    MediaSourceAttempt,
    MediaUploadSession,
    ProcessingStatus,
)
from nexus.jobs.queue import enqueue_job, fail_job
from nexus.schemas.import_history import (
    IndexSucceeded,
    SourceFailed,
    SourceSucceeded,
    UploadAccepted,
    UploadPublished,
)
from nexus.schemas.imports import ImportListQuery
from nexus.schemas.presence import absent, present
from nexus.services.bootstrap import ensure_user_and_default_library
from nexus.services.sealed_handles import seal_upload_session
from tests.testkit.auth import UserRecord
from tests.testkit.media_activity import (
    claim_heavy_job,
    create_source_media,
    create_upload_session,
    enqueue_source_job,
)
from tests.testkit.unreachable_state import insert_processing_event, insert_upload_event

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
    assert published_item["media_ref"] == {"kind": "Present", "value": str(published_media_id)}
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


def test_failed_index_without_its_exact_dead_job_is_still_a_defect(
    db_session: Session,
    test_user: UserRecord,
) -> None:
    media_id, attempt = create_source_media(
        db_session,
        viewer_id=test_user.id,
        title="Failed index without repair work",
        attempt_no=1,
        processing_status=ProcessingStatus.ready_for_reading,
        kind=MediaKind.epub,
    )
    attempt.status = "succeeded"
    db_session.add(
        ContentIndexState(owner_kind="media", owner_id=media_id, revision=1, status="failed")
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
