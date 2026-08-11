"""Real-API proof for regroupable activity capture and factual corrections."""

from __future__ import annotations

from collections.abc import Generator
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import Engine, text
from sqlalchemy.orm import Session

from nexus.app import add_request_id_middleware, create_app
from nexus.auth.middleware import AuthMiddleware
from nexus.db.models import Media, MediaKind, ProcessingStatus
from nexus.ops.consumption_activity_counts import read_global_counts
from nexus.services.bootstrap import ensure_user_and_default_library
from nexus.services.consumption import service as consumption_service
from nexus.services.library_entries import ensure_media_in_default_library
from tests.testkit.auth import StaticTokenVerifier


@dataclass(frozen=True, slots=True)
class ActivityApi:
    app: FastAPI
    client: TestClient
    viewer_id: UUID
    media_id: UUID
    device_id: str


@pytest.fixture
def activity_api(engine: Engine) -> Generator[ActivityApi, None, None]:
    viewer_id = uuid4()
    media_id = uuid4()
    email = f"consumption-activity-{viewer_id}@example.invalid"
    with Session(engine) as db:
        ensure_user_and_default_library(db, viewer_id, email)
        db.add(
            Media(
                id=media_id,
                kind=MediaKind.web_article.value,
                title="Regroupable activity",
                processing_status=ProcessingStatus.ready_for_reading,
                created_by_user_id=viewer_id,
            )
        )
        db.flush()
        ensure_media_in_default_library(db, viewer_id, media_id)
        db.commit()

    verifier = StaticTokenVerifier(viewer_id, email)

    def bootstrap(user_id: UUID, email: str | None = None) -> UUID:
        with Session(engine) as db:
            return ensure_user_and_default_library(db, user_id, email)

    app = create_app(
        install_auth_middleware=lambda application: application.add_middleware(
            AuthMiddleware,
            verifier=verifier,
            requires_internal_header=False,
            internal_secret=None,
            bootstrap_callback=bootstrap,
        )
    )
    add_request_id_middleware(app, log_requests=False)
    with TestClient(
        app,
        headers={"Authorization": f"Bearer {verifier.token}"},
    ) as client:
        yield ActivityApi(
            app=app,
            client=client,
            viewer_id=viewer_id,
            media_id=media_id,
            device_id=f"activity-device-{uuid4()}",
        )


def _iso(value: datetime) -> str:
    return value.isoformat().replace("+00:00", "Z")


def _reading_span(*, capture_key: UUID, occurred_at: datetime, duration_ms: int) -> dict:
    return {
        "captureKey": str(capture_key),
        "occurredAt": _iso(occurred_at),
        "durationMs": duration_ms,
        "progressStart": {"kind": "Absent"},
        "progressEnd": {"kind": "Absent"},
        "wordStart": {"kind": "Absent"},
        "wordEnd": {"kind": "Absent"},
    }


def _activity_body(
    activity: ActivityApi,
    *,
    client_mutation_id: UUID,
    spans: list[dict],
) -> dict:
    return {
        "clientMutationId": str(client_mutation_id),
        "mediaRef": f"media:{activity.media_id}",
        "deviceId": activity.device_id,
        "deviceClass": "Desktop",
        "batch": {"modality": "Reading", "spans": spans},
    }


def _stats(activity: ActivityApi, *, start: datetime, end: datetime) -> dict:
    response = activity.client.get(
        "/consumption/stats",
        params={
            "start": _iso(start),
            "end": _iso(end),
            "timeZone": "UTC",
            "bucket": "Day",
            "currentDeviceId": activity.device_id,
        },
    )
    assert response.status_code == 200, (
        f"Consumption Stats rejected a valid activity snapshot: {response.text}"
    )
    return response.json()["data"]


def _sessions(activity: ActivityApi, *, start: datetime, end: datetime) -> list[dict]:
    response = activity.client.get(
        "/consumption/sessions",
        params={
            "start": _iso(start),
            "end": _iso(end),
            "timeZone": "UTC",
            "currentDeviceId": activity.device_id,
            "limit": "100",
        },
    )
    assert response.status_code == 200, (
        f"Consumption sessions rejected a valid factual read: {response.text}"
    )
    return response.json()["data"]["sessions"]


def test_capture_keys_regroup_without_duplication_and_conflict_atomically(
    activity_api: ActivityApi,
) -> None:
    """A stable capture identity survives request regrouping and poisons no later batch."""
    start = datetime.now(UTC) - timedelta(minutes=5)
    capture_a, capture_b, capture_c, capture_d = (uuid4() for _ in range(4))
    span_a = _reading_span(capture_key=capture_a, occurred_at=start, duration_ms=1_000)
    span_b = _reading_span(
        capture_key=capture_b,
        occurred_at=start + timedelta(seconds=2),
        duration_ms=1_000,
    )
    span_c = _reading_span(
        capture_key=capture_c,
        occurred_at=start + timedelta(seconds=4),
        duration_ms=1_000,
    )
    span_d = _reading_span(
        capture_key=capture_d,
        occurred_at=start + timedelta(seconds=6),
        duration_ms=1_000,
    )

    first = activity_api.client.post(
        "/consumption/activity",
        json=_activity_body(
            activity_api,
            client_mutation_id=uuid4(),
            spans=[span_a, span_b],
        ),
    )
    assert first.status_code == 204, (
        f"first capture-key batch was not accepted: {first.status_code} {first.text}"
    )

    regrouped = activity_api.client.post(
        "/consumption/activity",
        json=_activity_body(
            activity_api,
            client_mutation_id=uuid4(),
            spans=[span_b, span_c],
        ),
    )
    assert regrouped.status_code == 204, (
        "an exact capture-key replay under a new mutation was not a no-op: "
        f"{regrouped.status_code} {regrouped.text}"
    )

    changed_b = {**span_b, "durationMs": 999}
    conflicted = activity_api.client.post(
        "/consumption/activity",
        json=_activity_body(
            activity_api,
            client_mutation_id=uuid4(),
            spans=[changed_b, span_d],
        ),
    )
    assert conflicted.status_code == 409, (
        "capture-key reuse with changed semantic bytes did not conflict: "
        f"{conflicted.status_code} {conflicted.text}"
    )
    assert conflicted.json()["error"]["code"] == "E_ACTIVITY_CAPTURE_CONFLICT"

    after_conflict = _stats(
        activity_api,
        start=start - timedelta(minutes=1),
        end=datetime.now(UTC) + timedelta(minutes=1),
    )["activity"]["totals"]
    assert after_conflict["recordedActiveMs"] == 3_000, (
        f"the conflicting batch partially inserted its unrelated span: {after_conflict!r}"
    )

    later = activity_api.client.post(
        "/consumption/activity",
        json=_activity_body(
            activity_api,
            client_mutation_id=uuid4(),
            spans=[span_d],
        ),
    )
    assert later.status_code == 204, (
        f"a capture-key conflict wedged a later valid batch: {later.status_code} {later.text}"
    )
    final_totals = _stats(
        activity_api,
        start=start - timedelta(minutes=1),
        end=datetime.now(UTC) + timedelta(minutes=1),
    )["activity"]["totals"]
    assert final_totals == {
        **final_totals,
        "recordedActiveMs": 4_000,
        "excludedActiveMs": 0,
        "observedActiveMs": 4_000,
        "manualActiveMs": 0,
        "activeMs": 4_000,
    }

    expired = activity_api.client.post(
        "/consumption/activity",
        json=_activity_body(
            activity_api,
            client_mutation_id=uuid4(),
            spans=[
                _reading_span(
                    capture_key=uuid4(),
                    occurred_at=datetime.now(UTC) - timedelta(days=31),
                    duration_ms=1_000,
                )
            ],
        ),
    )
    assert expired.status_code == 400, expired.text
    assert expired.json()["error"]["code"] == "E_ACTIVITY_EXPIRED"

    missing_media = _activity_body(
        activity_api,
        client_mutation_id=uuid4(),
        spans=[
            _reading_span(
                capture_key=uuid4(),
                occurred_at=datetime.now(UTC) - timedelta(minutes=1),
                duration_ms=1_000,
            )
        ],
    )
    missing_media["mediaRef"] = f"media:{uuid4()}"
    rejected_missing_media = activity_api.client.post("/consumption/activity", json=missing_media)
    assert rejected_missing_media.status_code == 404, rejected_missing_media.text
    assert rejected_missing_media.json()["error"]["code"] == "E_MEDIA_NOT_FOUND"


def test_adjustments_replay_once_and_project_add_exclude_retract(
    activity_api: ActivityApi,
    engine: Engine,
) -> None:
    """Concurrent replay is one correction and projections preserve observed provenance."""
    start = datetime.now(UTC) - timedelta(minutes=10)
    add_mutation_id = uuid4()
    add_body = {
        "kind": "Add",
        "clientMutationId": str(add_mutation_id),
        "mediaRef": f"media:{activity_api.media_id}",
        "occurredAt": _iso(start + timedelta(minutes=5)),
        "durationMs": 5_000,
    }

    def add_once() -> tuple[int, dict]:
        response = activity_api.client.post(
            "/consumption/activity-adjustments",
            json=add_body,
        )
        return response.status_code, response.json()

    with ThreadPoolExecutor(max_workers=2) as executor:
        add_results = list(executor.map(lambda _index: add_once(), range(2)))
    assert [status for status, _payload in add_results] == [200, 200], (
        f"concurrent exact adjustment replay did not linearize: {add_results!r}"
    )
    assert add_results[0][1] == add_results[1][1], (
        f"exact replay returned different adjustment outcomes: {add_results!r}"
    )
    add_handle = add_results[0][1]["data"]["adjustmentHandle"]["value"]

    observed = _reading_span(
        capture_key=uuid4(),
        occurred_at=start,
        duration_ms=10_000,
    )
    captured = activity_api.client.post(
        "/consumption/activity",
        json=_activity_body(
            activity_api,
            client_mutation_id=uuid4(),
            spans=[observed],
        ),
    )
    assert captured.status_code == 204, (
        f"observed correction fixture was not accepted: {captured.status_code} {captured.text}"
    )
    sessions = _sessions(
        activity_api,
        start=start - timedelta(minutes=1),
        end=datetime.now(UTC) + timedelta(minutes=1),
    )
    observed_session = next(row for row in sessions if row["source"] == "Observed")
    exclude_body = {
        "kind": "Exclude",
        "clientMutationId": str(uuid4()),
        "mediaRef": observed_session["mediaRef"],
        "modality": observed_session["modality"],
        "deviceHandle": observed_session["device"]["value"]["deviceHandle"],
        "startedAt": observed_session["startedAt"],
        "endedAt": observed_session["endedAt"],
    }
    wrong_device = activity_api.client.post(
        "/consumption/activity-adjustments",
        json={
            **exclude_body,
            "clientMutationId": str(uuid4()),
            "deviceHandle": "ncd1.AAAAAAAAAAAAAAAAAAAAAA",
        },
    )
    assert wrong_device.status_code == 400, (
        "Exclude accepted a device other than the exact projected session device: "
        f"{wrong_device.status_code} {wrong_device.text}"
    )
    excluded = activity_api.client.post(
        "/consumption/activity-adjustments",
        json=exclude_body,
    )
    assert excluded.status_code == 200, (
        f"exact observed session was not excluded: {excluded.status_code} {excluded.text}"
    )
    exclude_handle = excluded.json()["data"]["adjustmentHandle"]["value"]
    stale_session = activity_api.client.post(
        "/consumption/activity-adjustments",
        json={**exclude_body, "clientMutationId": str(uuid4())},
    )
    assert stale_session.status_code == 400, (
        "Exclude accepted a session removed from the current projection: "
        f"{stale_session.status_code} {stale_session.text}"
    )

    excluded_stats = _stats(
        activity_api,
        start=start - timedelta(minutes=1),
        end=datetime.now(UTC) + timedelta(minutes=1),
    )
    totals = excluded_stats["activity"]["totals"]
    assert {
        key: totals[key]
        for key in (
            "recordedActiveMs",
            "excludedActiveMs",
            "observedActiveMs",
            "manualActiveMs",
            "activeMs",
        )
    } == {
        "recordedActiveMs": 10_000,
        "excludedActiveMs": 10_000,
        "observedActiveMs": 0,
        "manualActiveMs": 5_000,
        "activeMs": 5_000,
    }, f"corrections produced the wrong provenance totals: {totals!r}"
    assert len(excluded_stats["activity"]["activeExclusions"]) == 1
    assert excluded_stats["activity"]["activeExclusions"][0]["adjustmentHandle"] == exclude_handle
    assert (
        excluded_stats["activity"]["activeExclusions"][0]["device"]
        == observed_session["device"]["value"]
    )
    projected_sessions = excluded_stats["activity"]["sessions"]["rows"]
    assert [(row["source"], row["activeMs"]) for row in projected_sessions] == [
        ("Manual", 5_000)
    ], f"excluded observed spans remained in the session projection: {projected_sessions!r}"

    device_filtered = activity_api.client.get(
        "/consumption/stats",
        params={
            "start": _iso(start - timedelta(minutes=1)),
            "end": _iso(datetime.now(UTC) + timedelta(minutes=1)),
            "timeZone": "UTC",
            "bucket": "Day",
            "currentDeviceId": activity_api.device_id,
            "deviceHandle": observed_session["device"]["value"]["deviceHandle"],
        },
    )
    assert device_filtered.status_code == 200, device_filtered.text
    device_activity = device_filtered.json()["data"]["activity"]
    assert device_activity["totals"]["recordedActiveMs"] == 10_000
    assert device_activity["totals"]["excludedActiveMs"] == 10_000
    assert device_activity["totals"]["manualActiveMs"] == 0
    assert device_activity["totals"]["activeMs"] == 0
    assert device_activity["inapplicableFilters"] == ["manual"]

    retract_mutation_id = uuid4()
    retract_body = {
        "kind": "Retract",
        "clientMutationId": str(retract_mutation_id),
        "adjustmentHandle": exclude_handle,
    }
    retracted = activity_api.client.post(
        "/consumption/activity-adjustments",
        json=retract_body,
    )
    replayed_retract = activity_api.client.post(
        "/consumption/activity-adjustments",
        json=retract_body,
    )
    assert retracted.status_code == 200 and replayed_retract.status_code == 200, (
        f"exact retraction replay did not converge: {retracted.text} {replayed_retract.text}"
    )
    assert retracted.json() == replayed_retract.json()
    assert retracted.json()["data"] == {
        "outcome": "Retracted",
        "adjustmentHandle": {"kind": "Present", "value": exclude_handle},
    }

    restored = _stats(
        activity_api,
        start=start - timedelta(minutes=1),
        end=datetime.now(UTC) + timedelta(minutes=1),
    )
    restored_totals = restored["activity"]["totals"]
    assert restored_totals["observedActiveMs"] == 10_000
    assert restored_totals["manualActiveMs"] == 5_000
    assert restored_totals["activeMs"] == 15_000
    assert restored["activity"]["activeExclusions"] == []

    removed_add = activity_api.client.post(
        "/consumption/activity-adjustments",
        json={
            "kind": "Retract",
            "clientMutationId": str(uuid4()),
            "adjustmentHandle": add_handle,
        },
    )
    assert removed_add.status_code == 200, removed_add.text
    final = _stats(
        activity_api,
        start=start - timedelta(minutes=1),
        end=datetime.now(UTC) + timedelta(minutes=1),
    )["activity"]["totals"]
    assert final["activeMs"] == 10_000 and final["manualActiveMs"] == 0, final

    with Session(engine) as db:
        counts = read_global_counts(db)
    assert counts.activity_adjustments >= 2
    assert counts.accepted_spans >= 5
    assert counts.deduplicated_spans >= 1
    assert counts.capture_key_duplicates == 0
    assert counts.capture_key_conflicts == 0
    assert counts.query_latency_ms >= 0

    with Session(engine) as db:
        consumption_service.delete_media_consumption_state_in_txn(
            db, media_id=activity_api.media_id
        )
        db.commit()
    with Session(engine) as db:
        remaining = (
            db.execute(
                text(
                    """
                SELECT
                    (SELECT count(*) FROM consumption_activity_spans
                     WHERE media_id = :media_id) AS spans,
                    (SELECT count(*) FROM consumption_activity_adjustments
                     WHERE media_id = :media_id) AS adjustments
                """
                ),
                {"media_id": activity_api.media_id},
            )
            .mappings()
            .one()
        )
    assert dict(remaining) == {"spans": 0, "adjustments": 0}
