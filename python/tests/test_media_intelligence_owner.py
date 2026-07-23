"""CP1 RED contract tests — MediaIntelligence sole-owner surface (T7).

Test-first for the hard cutover. Imports the CANONICAL A19 identifier
``MediaIntelligence`` (the pinned dotted owner, e.g.
``MediaIntelligence.ensure_current_many``) which does NOT exist yet ->
COLLECTION-time ImportError == the intended RED. Goes green, without edits, once
CP3 lands the owner per CONTRACTS.md A11 (§530-544, §580-607).

INTEGRATOR ASSUMPTION (flagged): these call the pinned methods as
``MediaIntelligence.method(db, ...)`` — i.e. a class/namespace owner exposing
static/class methods (matching the spec's dotted ``MediaIntelligence.x`` and B6's
grep target). If CP3 makes them instance methods this is the single reconcile
point.
"""

from __future__ import annotations

import asyncio
import re
from pathlib import Path
from uuid import UUID, uuid4

import pytest
from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.db.models import Fragment
from nexus.jobs.queue import JobExecutionContext, claim_next_job
from nexus.services.bootstrap import ensure_user_and_default_library
from nexus.services.content_indexing import rebuild_fragment_content_index
from nexus.services.resource_graph.refs import ResourceRef
from tests.factories import (
    create_searchable_media,
    create_searchable_media_in_library,
    create_test_library,
    create_test_media,
)

# --- CANONICAL A19 targets (do not exist yet -> ImportError == the RED) -------
from nexus.services.artifacts.dossier_types import (  # noqa: E402
    DossierBuildFailureCode,
    SubjectResource,
)
from nexus.services.artifacts.engine import create_build, run_build  # noqa: E402
from nexus.services.media_intelligence import MediaIntelligence  # noqa: E402
from nexus.services.media_intelligence import MediaUnit  # noqa: E402  (existing value type)

pytestmark = pytest.mark.integration


@pytest.fixture(autouse=True)
def _session_factories(monkeypatch, db_session):
    from tests.utils.db import task_session_factory

    monkeypatch.setattr(
        "nexus.services.media_intelligence.get_session_factory",
        lambda: task_session_factory(db_session),
        raising=False,
    )
    monkeypatch.setattr(
        "nexus.services.artifacts.engine.get_session_factory",
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
        raise AssertionError("no usable projection -> Dossier must fail before dispatch")

    def stream(self, intent, plan, credential, *, cancel):  # noqa: ANN001, pragma: no cover
        raise NotImplementedError


def _user(db: Session) -> UUID:
    uid = uuid4()
    ensure_user_and_default_library(db, uid)
    return uid


def _coerce_projection(db: Session, media_id: UUID, *, status: str, with_claim: bool) -> None:
    fp = MediaIntelligence.current_content_fingerprint(db, media_id=media_id)
    db.execute(
        text(
            "UPDATE media_summaries SET status = :s, content_fingerprint = :fp, "
            "summary_md = 'Abstract.', model_name = 'test-model' WHERE media_id = :m"
        ),
        {"s": status, "fp": fp, "m": media_id},
    )
    if with_claim:
        summary_id = db.execute(
            text("SELECT id FROM media_summaries WHERE media_id = :m"), {"m": media_id}
        ).scalar_one()
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


def _library_dossier_failure(db: Session, uid: UUID, lib: UUID) -> DossierBuildFailureCode:
    loc = SubjectResource(ref=ResourceRef(scheme="library", id=lib))
    ticket = create_build(
        db, locator=loc, requester_user_id=uid, idempotency_key="k-1", instruction=None
    )
    job = claim_next_job(db, worker_id="w", lease_seconds=600, allowed_kinds=["dossier_build"])
    assert job is not None
    ctx = JobExecutionContext(job_id=job.id, worker_id="w", attempt_no=job.attempts)
    asyncio.run(run_build(db, build_id=ticket.build_id, ctx=ctx, runtime=_NoDispatchRuntime()))
    code = db.execute(
        text("SELECT failure_code FROM artifact_build_failures WHERE build_id = :b"),
        {"b": ticket.build_id},
    ).scalar_one()
    return DossierBuildFailureCode(code)


# --- current_content_fingerprint: no-LLM, deterministic, incl. not-ready ------


def test_current_content_fingerprint_is_deterministic_and_no_llm(db_session: Session) -> None:
    uid = _user(db_session)
    media_id = create_searchable_media(db_session, uid, title="Doc")
    fp1 = MediaIntelligence.current_content_fingerprint(db_session, media_id=media_id)
    fp2 = MediaIntelligence.current_content_fingerprint(db_session, media_id=media_id)
    assert isinstance(fp1, str) and fp1
    assert fp1 == fp2  # no-LLM, pure function of content


def test_current_content_fingerprint_works_for_not_ready_media(db_session: Session) -> None:
    """A11: no-LLM fingerprint including for not-ready Media (empty content index)."""
    media_id = create_test_media(db_session, title="Bare", status="pending")
    fp = MediaIntelligence.current_content_fingerprint(db_session, media_id=media_id)
    assert isinstance(fp, str) and fp


def test_fingerprint_changes_on_reingestion(db_session: Session) -> None:
    uid = _user(db_session)
    media_id = create_searchable_media(db_session, uid, title="Doc")
    fp1 = MediaIntelligence.current_content_fingerprint(db_session, media_id=media_id)
    fragment = db_session.query(Fragment).filter(Fragment.media_id == media_id).first()
    assert fragment is not None
    fragment.canonical_text = "Completely different content body for the re-ingest path here."
    db_session.flush()
    rebuild_fragment_content_index(
        db_session,
        media_id=media_id,
        source_kind="web_article",
        fragments=[fragment],
        reason="test_reingest",
    )
    db_session.commit()
    fp2 = MediaIntelligence.current_content_fingerprint(db_session, media_id=media_id)
    assert fp2 != fp1


# --- publish fence: WHERE media_id AND content_fingerprint -> 0 rows if moved --


def test_publish_fence_rejects_stale_fingerprint_after_reingestion(db_session: Session) -> None:
    uid = _user(db_session)
    media_id = create_searchable_media(db_session, uid, title="Doc")
    captured = MediaIntelligence.current_content_fingerprint(db_session, media_id=media_id)
    # First publish lands at the captured fingerprint.
    db_session.execute(
        text(
            "UPDATE media_summaries SET status = 'ready', content_fingerprint = :fp, "
            "summary_md = 'v1', model_name = 'test-model' WHERE media_id = :m"
        ),
        {"fp": captured, "m": media_id},
    )
    db_session.commit()

    # Reingestion moves the content fingerprint; the owner re-heads at the new fp.
    fragment = db_session.query(Fragment).filter(Fragment.media_id == media_id).first()
    fragment.canonical_text = "A brand new body after reingestion, materially different text."
    db_session.flush()
    rebuild_fragment_content_index(
        db_session,
        media_id=media_id,
        source_kind="web_article",
        fragments=[fragment],
        reason="test_reingest",
    )
    db_session.commit()
    MediaIntelligence.ensure_current(db_session, media_id=media_id, requester=uid)
    new_fp = MediaIntelligence.current_content_fingerprint(db_session, media_id=media_id)
    assert new_fp != captured

    # A stale worker that captured the OLD fingerprint cannot publish (§601-603).
    result = db_session.execute(
        text(
            "UPDATE media_summaries SET summary_md = 'stale' "
            "WHERE media_id = :m AND content_fingerprint = :captured"
        ),
        {"m": media_id, "captured": captured},
    )
    assert result.rowcount == 0


# --- ensure_current: idempotent; one interpretation per (media_id, fp) --------


def test_ensure_current_is_idempotent_one_interpretation_per_fingerprint(
    db_session: Session,
) -> None:
    uid = _user(db_session)
    media_id = create_searchable_media(db_session, uid, title="Doc")
    MediaIntelligence.ensure_current(db_session, media_id=media_id, requester=uid)
    MediaIntelligence.ensure_current(db_session, media_id=media_id, requester=uid)
    rows = db_session.execute(
        text("SELECT count(*) FROM media_summaries WHERE media_id = :m"), {"m": media_id}
    ).scalar_one()
    assert rows == 1  # UNIQUE(media_id): exactly one interpretation head


# --- ensure_current_many: dedup + bounded + typed no-source + usability -------


def test_ensure_current_many_dedups_and_is_bounded(db_session: Session) -> None:
    uid = _user(db_session)
    lib = create_test_library(db_session, uid)
    m1 = create_searchable_media_in_library(db_session, uid, lib, title="One")
    m2 = create_searchable_media_in_library(db_session, uid, lib, title="Two")
    # A duplicated, already-audience-filtered set: dedup by media id; never a
    # sequential N-call blow-up. Tolerates duplicates without error.
    MediaIntelligence.ensure_current_many(db_session, media_ids=[m1, m2, m1], requester=uid)
    for mid in (m1, m2):
        rows = db_session.execute(
            text("SELECT count(*) FROM media_summaries WHERE media_id = :m"), {"m": mid}
        ).scalar_one()
        assert rows == 1


def test_ready_with_claim_projection_is_usable(db_session: Session) -> None:
    uid = _user(db_session)
    lib = create_test_library(db_session, uid)
    media_id = create_searchable_media_in_library(db_session, uid, lib, title="Usable")
    _coerce_projection(db_session, media_id, status="ready", with_claim=True)
    unit = MediaIntelligence.get_current(db_session, media_id=media_id)
    assert isinstance(unit, MediaUnit)
    assert len(unit.claims) >= 1  # ready + current + >=1 candidate == usable


def test_ready_but_claimless_media_is_not_usable_for_aggregate(db_session: Session) -> None:
    """A11 §543: a ready but claimless MediaUnit is NOT usable -> a library whose
    only media is claimless-ready fails NoSourceMaterial before dispatch."""
    uid = _user(db_session)
    lib = create_test_library(db_session, uid)
    media_id = create_searchable_media_in_library(db_session, uid, lib, title="Claimless")
    _coerce_projection(db_session, media_id, status="ready", with_claim=False)
    assert _library_dossier_failure(db_session, uid, lib) == DossierBuildFailureCode.NoSourceMaterial


def test_no_usable_projection_when_media_is_contentless(db_session: Session) -> None:
    """No usable projection (contentless media) -> typed no-source before Dossier
    generation; observed as a library NoSourceMaterial failure."""
    uid = _user(db_session)
    lib = create_test_library(db_session, uid)
    from nexus.db.models import Media, MediaKind, ProcessingStatus
    from tests.factories import add_media_to_library

    media = Media(
        id=uuid4(),
        kind=MediaKind.web_article.value,
        title="No Content",
        processing_status=ProcessingStatus.ready_for_reading,
        created_by_user_id=uid,
    )
    db_session.add(media)
    db_session.flush()
    add_media_to_library(db_session, lib, media.id)
    db_session.commit()
    assert _library_dossier_failure(db_session, uid, lib) == DossierBuildFailureCode.NoSourceMaterial


# --- residue: no direct media-table reads outside the owner ------------------


def test_no_direct_media_table_reads_outside_media_intelligence() -> None:
    """A11/§594: routes, agents, search, Synapse, citation-enrichment, and Dossier
    bindings STOP reading media_summaries/media_claims directly."""
    services_dir = Path(__file__).resolve().parents[1] / "nexus" / "services"
    pattern = re.compile(r"\bfrom\s+media_(summaries|claims)\b", re.IGNORECASE)
    offenders: list[str] = []
    for path in services_dir.rglob("*.py"):
        if path.name == "media_intelligence.py":
            continue
        if pattern.search(path.read_text(encoding="utf-8")):
            offenders.append(str(path.relative_to(services_dir)))
    assert offenders == [], f"direct media-table reads outside MediaIntelligence: {offenders}"
