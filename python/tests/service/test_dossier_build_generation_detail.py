"""Background run detail on the public Dossier head (spec 3.4, acceptance 15)."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING
from uuid import UUID, uuid4

if TYPE_CHECKING:
    from fastapi.testclient import TestClient
    from sqlalchemy.orm import Session

    from nexus.services.resource_graph.refs import ResourceRef
    from tests.testkit.auth import UserRecord

_ABSENT = {"kind": "Absent"}
_BUILD_KEYS = {
    "handle",
    "requester_user_id",
    "instruction",
    "created_at",
    "execution",
    "failure",
    "cancellation",
    "admitted_generation",
    "capacity_pause",
}


@dataclass(frozen=True, slots=True)
class _StartedBuild:
    path: str
    build_id: UUID
    job_id: UUID


@dataclass(frozen=True, slots=True)
class _Claim:
    worker_id: str
    attempt_no: int
    payload: dict[str, object]


def _start_build(db: Session, *, requester_user_id: UUID, subject: ResourceRef) -> _StartedBuild:
    from nexus.jobs.queue import find_nonterminal_jobs_for_payload
    from nexus.services.artifacts.dossier_types import SubjectResource
    from nexus.services.artifacts.engine import bootstrap_resource_dossier
    from nexus.services.resource_graph.refs import ResourceRef

    ticket = bootstrap_resource_dossier(
        db,
        locator=SubjectResource(ref=subject),
        requester_user_id=requester_user_id,
        idempotency_key=f"build-detail-{uuid4()}",
        instruction=None,
    )
    jobs = find_nonterminal_jobs_for_payload(
        db,
        kind="dossier_build",
        expected_payload_match={"build_id": str(ticket.build_id)},
    )
    assert len(jobs) == 1
    return _StartedBuild(
        path=f"/artifacts/{ResourceRef(scheme='artifact', id=ticket.artifact_id).uri}",
        build_id=ticket.build_id,
        job_id=jobs[0].id,
    )


def _claim(db: Session, build: _StartedBuild) -> _Claim:
    """Hold the one heavy `dossier_build` lease the way a worker does before parking."""
    from nexus.jobs.queue import claim_job

    worker_id = f"build-detail-{build.job_id}"
    claimed = claim_job(
        db,
        job_id=build.job_id,
        worker_id=worker_id,
        lease_seconds=300,
        heavy_kinds=("dossier_build",),
        allowed_kinds=("dossier_build",),
    )
    assert claimed is not None
    return _Claim(worker_id=worker_id, attempt_no=claimed.attempts, payload=dict(claimed.payload))


def _active_build(client: TestClient, path: str) -> dict[str, object]:
    response = client.get(path)
    assert response.status_code == 200, response.text
    head = response.json()["data"]
    assert head["active_build"]["kind"] == "Present"
    build = head["active_build"]["value"]
    assert set(build) == _BUILD_KEYS
    return build


def test_head_projects_capacity_pause_and_admitted_selection_read_only(
    authenticated_client: TestClient,
    db_session: Session,
    test_user: UserRecord,
) -> None:
    """Risk: a quota-parked build hides its durable wait, or the browser must guess a
    background selection, tool plan, or price that the ledger never admitted."""

    from nexus.db.models import Media, MediaKind
    from nexus.jobs.queue import update_running_job_payload
    from nexus.schemas.llm import CapacityPaused
    from nexus.schemas.presence import Present
    from nexus.services import library_entries
    from nexus.services.durable_step_journal import stable_generation_id
    from nexus.services.llm_ledger import LlmCallOwner
    from nexus.services.resource_graph.refs import ResourceRef
    from nexus.services.tool_runtime.composition import freeze_tool_plan_snapshot
    from tests.testkit.codex_generation import (
        codex_generation_draft,
        codex_model_tool_fixture,
        stage_uncertain_codex_generation,
    )

    db = db_session
    media_id = uuid4()
    db.add(
        Media(
            id=media_id,
            kind=MediaKind.web_article.value,
            title="Background run detail source",
            created_by_user_id=test_user.id,
        )
    )
    db.flush()
    assert library_entries.ensure_media_in_default_library(db, test_user.id, media_id)

    # Media Dossier: the worker holds the heavy lease, quota parks the synthesis
    # admission, and policy later admits NoModelTools.
    media = _start_build(
        db, requester_user_id=test_user.id, subject=ResourceRef(scheme="media", id=media_id)
    )
    claim = _claim(db, media)
    fresh = _active_build(authenticated_client, media.path)
    assert fresh.get("admitted_generation") == _ABSENT
    assert fresh.get("capacity_pause") == _ABSENT

    observed_at = datetime(2026, 9, 5, 12, 0, tzinfo=UTC)
    pause = CapacityPaused(
        explanation="Codex subscription capacity is exhausted.",
        reset_at=Present(value=observed_at + timedelta(hours=2)),
        next_check_at=observed_at + timedelta(minutes=15),
        last_checked=observed_at,
    )
    assert update_running_job_payload(
        db,
        job_id=media.job_id,
        worker_id=claim.worker_id,
        attempt_no=claim.attempt_no,
        payload={
            **claim.payload,
            "generation_capacity_pauses": {"synthesis": pause.model_dump(mode="json")},
        },
    )
    paused = _active_build(authenticated_client, media.path)
    assert paused.get("capacity_pause") == {
        "kind": "Present",
        "value": {
            "kind": "CapacityPaused",
            "code": "quota_unavailable",
            "explanation": "Codex subscription capacity is exhausted.",
            "reset_at": {"kind": "Present", "value": "2026-09-05T14:00:00Z"},
            "next_check_at": "2026-09-05T12:15:00Z",
            "last_checked": "2026-09-05T12:00:00Z",
        },
    }
    assert paused.get("admitted_generation") == _ABSENT

    assert update_running_job_payload(
        db,
        job_id=media.job_id,
        worker_id=claim.worker_id,
        attempt_no=claim.attempt_no,
        payload=claim.payload,
    )
    media_draft = codex_generation_draft(
        request_id=stable_generation_id(media.build_id, "synthesis"),
        operation="dossier_media",
        instructions="Write the media dossier.",
        input_text="frozen media evidence",
        model="gpt-5.6-terra",
        reasoning="medium",
        turn_timeout_seconds=180,
    )
    stage_uncertain_codex_generation(
        db,
        owner=LlmCallOwner(kind="artifact_build", id=media.build_id),
        draft=media_draft,
    )
    admitted = _active_build(authenticated_client, media.path)
    assert admitted.get("capacity_pause") == _ABSENT
    assert admitted.get("admitted_generation") == {
        "kind": "Present",
        "value": {
            "selection": {
                "route": "CodexPersonal",
                "model": "gpt-5.6-terra",
                "reasoning": "medium",
            },
            "display_at_dispatch": media_draft.spec.display_at_dispatch.model_dump(mode="json"),
            "tool_plan": {"kind": "NoModelTools"},
            "tool_positions": 0,
        },
    }

    # Library Dossier: the admitted generation exposes exactly its frozen read
    # plan. The queue admits one running heavy job at a time and the head read
    # never depends on a lease, so this build stays queued and is not claimed.
    library = _start_build(
        db,
        requester_user_id=test_user.id,
        subject=ResourceRef(scheme="library", id=test_user.default_library_id),
    )
    _, tool_runtime = codex_model_tool_fixture()
    plan = freeze_tool_plan_snapshot(tool_runtime.operations["LibraryDossierRead"])
    library_draft = codex_generation_draft(
        request_id=stable_generation_id(library.build_id, "synthesis"),
        operation="dossier_library",
        instructions="Write the library dossier.",
        input_text="frozen library manifest",
        model="gpt-5.6-terra",
        reasoning="high",
        turn_timeout_seconds=180,
        model_tool_plan=plan,
    )
    stage_uncertain_codex_generation(
        db,
        owner=LlmCallOwner(kind="artifact_build", id=library.build_id),
        draft=library_draft,
    )
    tool_admitted = _active_build(authenticated_client, library.path)["admitted_generation"]
    assert tool_admitted == {
        "kind": "Present",
        "value": {
            "selection": {"route": "CodexPersonal", "model": "gpt-5.6-terra", "reasoning": "high"},
            "display_at_dispatch": library_draft.spec.display_at_dispatch.model_dump(mode="json"),
            "tool_plan": {
                "kind": "ExactModelTools",
                "plan_id": "LibraryDossierRead",
                "plan_revision": plan.plan_revision,
                "effect_mode": "ReadOnly",
            },
            "tool_positions": 0,
        },
    }
