"""CP1 RED contract tests — Dossier failure precedence + citation contract (T5).

Test-first for the hard cutover. Imports CANONICAL A19 identifiers that do NOT
exist yet -> COLLECTION-time ImportError == the intended RED. Goes green,
without edits, once CP2/CP3 land the engine, bindings, and MediaIntelligence
per CONTRACTS.md A7 (failure precedence), A10 (citation contract), A11.

Drivable-without-a-provider subset (pre-dispatch precedence): zero usable
candidate -> NoSourceMaterial; a modeled MI dependency failure while a usable
source exists -> DependencyProjectionFailed. Post-synthesis branches
(InputsChanged, CitationValidationFailed, audience-invisible target ->
InputsChanged, target re-resolution) require a driven provider success and are
flagged for the integrator (see module RETURN notes).
"""

from __future__ import annotations

import asyncio
from uuid import UUID, uuid4

import pytest
from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.db.models import NoteBlock
from nexus.jobs.queue import JobExecutionContext
from nexus.services import media_intelligence
from nexus.services.artifacts.dossier_types import (
    DossierBuildFailureCode,
    MigratedIncompleteReason,
    SubjectResource,
)
from nexus.services.artifacts.engine import create_build, run_build
from nexus.services.bootstrap import ensure_user_and_default_library
from nexus.services.resource_graph.refs import ResourceRef
from nexus.services.resource_items import versions
from tests.factories import (
    create_searchable_media_in_library,
    create_test_conversation,
    create_test_library,
)
from tests.utils.dossier_jobs import claim_dossier_build_job

pytestmark = pytest.mark.integration


@pytest.fixture(autouse=True)
def _engine_session_factory(monkeypatch, db_session):
    from tests.utils.db import task_session_factory

    monkeypatch.setattr(
        "nexus.services.artifacts.engine.get_session_factory",
        lambda: task_session_factory(db_session),
        raising=False,
    )
    monkeypatch.setattr(
        "nexus.services.media_intelligence.get_session_factory",
        lambda: task_session_factory(db_session),
        raising=False,
    )


@pytest.fixture(autouse=True)
def _rate_limiter(db_session):
    from nexus.services.rate_limit import RateLimiter, get_rate_limiter, set_rate_limiter
    from tests.utils.db import task_session_factory

    previous = get_rate_limiter()
    set_rate_limiter(RateLimiter(session_factory=task_session_factory(db_session)))
    yield
    set_rate_limiter(previous)


class _NoDispatchRuntime:
    def __init__(self) -> None:
        self.calls = 0

    async def generate(self, intent, plan, credential):  # noqa: ANN001
        self.calls += 1
        raise AssertionError("provider dispatch must not occur for a pre-dispatch failure")

    def stream(self, intent, plan, credential, *, cancel):  # noqa: ANN001, pragma: no cover
        raise NotImplementedError


def _user(db: Session) -> UUID:
    uid = uuid4()
    ensure_user_and_default_library(db, uid)
    return uid


def _drive_to_failure(db: Session, locator: SubjectResource, uid: UUID) -> DossierBuildFailureCode:
    """create_build -> claim -> run_build; return the single modeled failure code.

    Asserts the run produced exactly ONE failure child, no revision, no
    cancellation, and never dispatched the provider (all these precedence codes
    are decided at/ before collection)."""
    ticket = create_build(
        db, locator=locator, requester_user_id=uid, idempotency_key="k-1", instruction=None
    )
    job = claim_dossier_build_job(db, build_id=ticket.build_id, worker_id="w")
    ctx = JobExecutionContext(job_id=job.id, worker_id="w", attempt_no=job.attempts)
    rt = _NoDispatchRuntime()
    asyncio.run(run_build(db, build_id=ticket.build_id, ctx=ctx, runtime=rt))
    assert rt.calls == 0, "these codes are selected before provider dispatch"
    rev = db.execute(
        text("SELECT count(*) FROM artifact_revisions WHERE build_id = :b"), {"b": ticket.build_id}
    ).scalar_one()
    canc = db.execute(
        text("SELECT count(*) FROM artifact_build_cancellations WHERE build_id = :b"),
        {"b": ticket.build_id},
    ).scalar_one()
    codes = list(
        db.execute(
            text("SELECT failure_code FROM artifact_build_failures WHERE build_id = :b"),
            {"b": ticket.build_id},
        ).scalars()
    )
    assert rev == 0 and canc == 0
    assert len(codes) == 1, "the same event selects exactly ONE failure code (single-code)"
    return DossierBuildFailureCode(codes[0])


def _seed_projection(db: Session, media_id: UUID, *, status: str, with_claim: bool) -> None:
    """Coerce the (already-created, building) media unit into a fixed state.

    Content indexing creates a `building` media_summaries row; UPDATE it to the
    target state keyed on the CURRENT fingerprint so `ready` means current."""
    fp = media_intelligence.current_content_fingerprint(db, media_id=media_id)
    db.execute(
        text(
            "UPDATE media_summaries SET status = :s, content_fingerprint = :fp, "
            "summary_md = 'Abstract.', model_name = 'test-model' WHERE media_id = :m"
        ),
        {"s": status, "fp": fp, "m": media_id},
    )
    summary_id = db.execute(
        text("SELECT id FROM media_summaries WHERE media_id = :m"), {"m": media_id}
    ).scalar_one()
    if with_claim:
        span_id = db.execute(
            text(
                "SELECT id FROM evidence_spans WHERE owner_kind = 'media' AND owner_id = :m LIMIT 1"
            ),
            {"m": media_id},
        ).scalar_one()
        db.execute(
            text(
                "INSERT INTO media_claims (id, media_id, summary_id, claim_text, "
                "evidence_span_id, ordinal) VALUES (:i, :m, :s, 'Key claim.', :e, 0)"
            ),
            {"i": uuid4(), "m": media_id, "s": summary_id, "e": span_id},
        )
    db.commit()


# --- Closed unions (pure; assert the exact pinned value sets) ----------------


def test_failure_code_enum_is_closed() -> None:
    assert {c.value for c in DossierBuildFailureCode} == {
        "NoSourceMaterial",
        "InputsChanged",
        "DependencyProjectionFailed",
        "EntitlementDenied",
        "BudgetExceeded",
        "ContextTooLarge",
        "ProviderRefused",
        "ProviderIncomplete",
        "SchemaRepairExhausted",
        "CitationValidationFailed",
        "MigratedFailure",
        "MigratedIncomplete",
    }


def test_migrated_incomplete_reason_is_closed() -> None:
    assert {r.value for r in MigratedIncompleteReason} == {"LegacyBuilding", "LegacyZeroCitation"}


# --- Precedence rule 1: NoSourceMaterial (zero usable citation candidate) -----


def test_empty_conversation_fails_no_source_material(db_session: Session) -> None:
    uid = _user(db_session)
    conv = create_test_conversation(db_session, uid)  # no messages
    loc = SubjectResource(ref=ResourceRef(scheme="conversation", id=conv))
    assert _drive_to_failure(db_session, loc, uid) == DossierBuildFailureCode.NoSourceMaterial


def test_empty_note_with_no_connection_fails_no_source_material(db_session: Session) -> None:
    """A10: empty Note with no connection -> NoSourceMaterial (Note is atomic)."""
    uid = _user(db_session)
    note = NoteBlock(
        id=uuid4(),
        user_id=uid,
        body_pm_json={"type": "paragraph", "content": []},
        body_text="",
    )
    db_session.add(note)
    db_session.flush()
    versions.ensure_version(
        db_session, viewer_id=uid, ref=ResourceRef(scheme="note_block", id=note.id), lane="body"
    )
    versions.ensure_version(
        db_session,
        viewer_id=uid,
        ref=ResourceRef(scheme="note_block", id=note.id),
        lane="outgoing_edges",
    )
    db_session.commit()
    loc = SubjectResource(ref=ResourceRef(scheme="note_block", id=note.id))
    assert _drive_to_failure(db_session, loc, uid) == DossierBuildFailureCode.NoSourceMaterial


def test_library_with_only_failed_dependencies_is_no_source_material(db_session: Session) -> None:
    """No usable source at all -> rule 1 (NoSourceMaterial), NOT
    DependencyProjectionFailed (which needs a usable source to coexist)."""
    uid = _user(db_session)
    lib = create_test_library(db_session, uid)
    m = create_searchable_media_in_library(db_session, uid, lib, title="Only Failed")
    _seed_projection(db_session, m, status="failed", with_claim=False)
    loc = SubjectResource(ref=ResourceRef(scheme="library", id=lib))
    assert _drive_to_failure(db_session, loc, uid) == DossierBuildFailureCode.NoSourceMaterial


# --- Precedence rule 2: DependencyProjectionFailed (usable coexists) ---------


def test_library_dependency_failure_with_usable_source_is_dependency_projection_failed(
    db_session: Session,
) -> None:
    """A7 rule 2: a required MI dependency reaches a modeled terminal failure
    while other usable sources exist -> DependencyProjectionFailed."""
    uid = _user(db_session)
    lib = create_test_library(db_session, uid)
    usable = create_searchable_media_in_library(db_session, uid, lib, title="Usable")
    _seed_projection(db_session, usable, status="ready", with_claim=True)
    failed = create_searchable_media_in_library(db_session, uid, lib, title="Failed Dep")
    _seed_projection(db_session, failed, status="failed", with_claim=False)
    loc = SubjectResource(ref=ResourceRef(scheme="library", id=lib))
    assert (
        _drive_to_failure(db_session, loc, uid)
        == DossierBuildFailureCode.DependencyProjectionFailed
    )
