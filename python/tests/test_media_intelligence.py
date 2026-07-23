"""Tests for the per-media intelligence unit service (S2)."""

from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass, field
from uuid import UUID, uuid4

import pytest
from provider_runtime import (
    Absent,
    CallMeta,
    Failed,
    PossiblyBillable,
    Present,
    ProviderHttpUnavailable,
    ResponsePayload,
    StructuredContent,
    Succeeded,
    TokenUsage,
    TransientExhausted,
)
from sqlalchemy import select, text
from sqlalchemy.orm import Session

from nexus.config import clear_settings_cache
from nexus.db.models import LLMCall
from nexus.errors import InvalidRequestError
from nexus.jobs.queue import JobExecutionContext, claim_next_job, get_job
from nexus.schemas.presence import Present as PresencePresent
from nexus.services import media_intelligence
from nexus.services.artifacts import coordination
from nexus.services.artifacts.bindings.library import BINDING as LIBRARY_BINDING
from nexus.services.artifacts.dossier_types import AudienceLibrary, DossierBuildFailureCode
from nexus.services.artifacts.subject_policy import ResolvedSubject
from nexus.services.billing_entitlements import grant_entitlement_override
from nexus.services.bootstrap import ensure_user_and_default_library
from nexus.services.content_indexing import rebuild_fragment_content_index
from nexus.services.llm_profiles import operation_profile
from nexus.services.media_intelligence import (
    MEDIA_UNIT_OPERATION,
    MediaUnit,
    NotReady,
    _persist_unit,
    ensure_current_many,
    ensure_media_unit,
    get_media_unit,
    read_single,
    reconcile_uncertain_media_unit,
    run_media_unit_build,
)
from nexus.services.rate_limit import RateLimiter, get_rate_limiter, set_rate_limiter
from nexus.services.resource_graph.refs import ResourceRef
from nexus.services.search.query import SearchQuery
from tests.factories import get_user_default_library
from tests.utils.db import task_session_factory

_PROFILE = operation_profile(MEDIA_UNIT_OPERATION)

# =============================================================================
# Integration tests (real DB, fake ExecutionRuntime at the external boundary)
# =============================================================================


@pytest.fixture(autouse=True)
def platform_key(monkeypatch):
    """generation_credential needs a configured platform key for the pinned provider.

    MEDIA_UNIT_OPERATION ("media_summary") resolves to the "fast" profile,
    whose target provider is openai (see llm_profiles.PROFILES) — the key
    must be OPENAI_API_KEY, not an anthropic key.
    """
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test-platform-openai")
    clear_settings_cache()
    yield
    clear_settings_cache()


@pytest.fixture(autouse=True)
def _media_intelligence_session_factory(monkeypatch, db_session):
    """Route the owner's internal ``get_session_factory()`` call onto this
    test's savepoint connection (same pattern as tests/test_llm_task.py
    `_task_db`), so execute_generation's entitlement/ledger reads see the
    grants and rows this test sets up on ``db_session``.
    """
    monkeypatch.setattr(
        "nexus.services.media_intelligence.get_session_factory",
        lambda: task_session_factory(db_session),
    )


@pytest.fixture(autouse=True)
def _rate_limiter(db_session):
    """Install the real RateLimiter as the global singleton so execute_generation's
    reservation/commit/release ledger flow runs for real against this test's DB.
    """
    previous = get_rate_limiter()
    set_rate_limiter(RateLimiter(session_factory=task_session_factory(db_session)))
    yield
    set_rate_limiter(previous)


class _RecordingRateLimiter:
    """Records only the worker-level inflight-slot envelope (the concurrency
    guard run_media_unit_build itself acquires/releases). Reservation/charge/
    release of the *token budget* now happens inside execute_generation
    against the real global rate limiter (see the _rate_limiter fixture
    above), so this fake no longer sees those calls — that's a genuine
    architecture change, not a test simplification.
    """

    def __init__(self) -> None:
        self.events: list[str] = []

    def acquire_inflight_slot(self, user_id: UUID) -> None:
        self.events.append("acquire_inflight_slot")

    def release_inflight_slot(self, user_id: UUID) -> None:
        self.events.append("release_inflight_slot")


@pytest.fixture
def unit_rate_limiter(monkeypatch) -> _RecordingRateLimiter:
    limiter = _RecordingRateLimiter()
    monkeypatch.setattr("nexus.services.media_intelligence.get_rate_limiter", lambda: limiter)
    return limiter


@dataclass
class _ScriptedRuntime:
    """A fake `ExecutionRuntime`: scripts one outcome (non-stream) or raises on
    dispatch. Copied from tests/test_llm_execution.py `_ScriptedRuntime`
    (stream() is unused by media_intelligence, which never streams)."""

    outcome: object = None
    generate_error: BaseException | None = None
    calls: list[str] = field(default_factory=list)

    async def generate(self, intent, plan, credential) -> object:
        self.calls.append("generate")
        if self.generate_error is not None:
            raise self.generate_error
        assert self.outcome is not None
        return self.outcome

    def stream(self, intent, plan, credential, *, cancel):  # pragma: no cover - unused
        raise NotImplementedError


def _meta(**overrides: object) -> CallMeta:
    fields: dict[str, object] = {
        "provider": _PROFILE.target.provider,
        "model": _PROFILE.target.model,
        "provider_request_id": Present("req-abc"),
        "upstream_provider": Absent(),
        "usage": Present(
            TokenUsage(
                input_tokens=50,
                output_tokens=20,
                total_tokens=70,
                reasoning_tokens=Absent(),
                cache_read_input_tokens=Absent(),
                cache_write_input_tokens=Absent(),
            )
        ),
        "attempt_trace": (),
        "billability": PossiblyBillable(),
    }
    fields.update(overrides)
    return CallMeta(**fields)  # type: ignore[arg-type]


def _succeeded_unit_outcome(*, summary_md: str, claims: list[tuple[str, int]]) -> Succeeded:
    """A Succeeded outcome carrying a StructuredContent payload the owner decodes
    into MediaUnitSynthesis — the fake-runtime analog of the old _UnitRouter."""
    payload = {
        "summary_md": summary_md,
        "claims": [{"claim_text": text_, "candidate_index": idx} for text_, idx in claims],
    }
    return Succeeded(
        meta=_meta(),
        response=ResponsePayload(
            content=StructuredContent(payload=payload, text=json.dumps(payload)),
            continuation=Absent(),
        ),
    )


def _succeeded_invalid_payload_outcome() -> Succeeded:
    """A Succeeded outcome whose StructuredContent payload does not validate
    against MediaUnitSynthesis — the fake-runtime analog of the old
    _RawTextRouter (non-JSON text), now expressed as a decode failure rather
    than a provider-level refusal since the model call itself succeeded."""
    payload = {"not": "the expected shape"}
    return Succeeded(
        meta=_meta(),
        response=ResponsePayload(
            content=StructuredContent(payload=payload, text="not the expected shape"),
            continuation=Absent(),
        ),
    )


def _grant_platform_llm(db: Session, user_id: UUID) -> None:
    """Entitle the user to the platform key (resolve_api_key auto -> platform)."""
    grant_entitlement_override(
        db,
        user_id=user_id,
        plan_tier="ai_pro",
        platform_token_quota_mode="unlimited",
        platform_token_limit_monthly=None,
        transcription_quota_mode="unlimited",
        transcription_minutes_limit_monthly=None,
        expires_at=None,
        reason="media unit test platform access",
        actor_label="test",
    )


def _llm_call_rows(db: Session, *, owner_kind: str, owner_id: UUID) -> list[LLMCall]:
    return list(
        db.scalars(
            select(LLMCall)
            .where(LLMCall.owner_kind == owner_kind, LLMCall.owner_id == owner_id)
            .order_by(LLMCall.call_seq)
        )
    )


def _seed_unit_media(db: Session, *, title: str = "Unit Doc") -> UUID:
    user_id = uuid4()
    ensure_user_and_default_library(db, user_id)
    _grant_platform_llm(db, user_id)
    from tests.factories import create_searchable_media

    return create_searchable_media(db, user_id, title=title)


def _job_count(db: Session, media_id: UUID) -> int:
    return int(
        db.execute(
            text(
                "SELECT COUNT(*) FROM background_jobs "
                "WHERE kind = 'media_unit_build' AND payload->>'media_id' = :mid"
            ),
            {"mid": str(media_id)},
        ).scalar_one()
    )


def _claim_media_unit_build(
    db: Session, *, media_id: UUID, worker_id: str = "media-unit-test"
) -> tuple[str, JobExecutionContext]:
    while True:
        job = claim_next_job(
            db,
            worker_id=worker_id,
            lease_seconds=600,
            allowed_kinds=["media_unit_build"],
        )
        assert job is not None, f"no media_unit_build job for {media_id}"
        if str(job.payload["media_id"]) == str(media_id):
            return (
                str(job.payload["content_fingerprint"]),
                JobExecutionContext(
                    job_id=job.id,
                    worker_id=worker_id,
                    attempt_no=job.attempts,
                ),
            )


def _dead_uncertain_media_unit_build(
    db: Session,
    *,
    media_id: UUID,
) -> tuple[str, UUID]:
    fingerprint, ctx = _claim_media_unit_build(db, media_id=media_id)
    runtime = _ScriptedRuntime(generate_error=RuntimeError("provider connection lost"))
    with pytest.raises(RuntimeError, match="provider connection lost"):
        asyncio.run(
            run_media_unit_build(
                db,
                media_id=media_id,
                content_fingerprint=fingerprint,
                ctx=ctx,
                runtime=runtime,
            )
        )
    db.execute(
        text(
            "UPDATE background_jobs SET status = 'dead', claimed_by = NULL, "
            "lease_expires_at = NULL, finished_at = now() WHERE id = :job_id"
        ),
        {"job_id": ctx.job_id},
    )
    db.commit()
    return fingerprint, ctx.job_id


@pytest.mark.integration
class TestEnsureMediaUnit:
    def test_content_index_rebuild_enqueues_build(self, db_session: Session) -> None:
        media_id = _seed_unit_media(db_session)
        # The ingest hook fires inside create_searchable_media's rebuild.
        assert _job_count(db_session, media_id) == 1
        summary = db_session.execute(
            text("SELECT status FROM media_summaries WHERE media_id = :mid"),
            {"mid": media_id},
        ).scalar_one()
        assert summary == "building"

    def test_idempotent_on_fingerprint(self, db_session: Session) -> None:
        media_id = _seed_unit_media(db_session)
        first = ensure_media_unit(db_session, media_id=media_id)
        # Re-running with unchanged content does not enqueue a second job.
        second = ensure_media_unit(db_session, media_id=media_id)
        assert second.enqueued is False
        assert second.content_fingerprint == first.content_fingerprint
        assert _job_count(db_session, media_id) == 1

    @pytest.mark.parametrize("queue_evidence", ["missing", "succeeded"])
    def test_current_build_without_runnable_exact_job_is_suspended(
        self,
        db_session: Session,
        queue_evidence: str,
    ) -> None:
        media_id = _seed_unit_media(db_session)
        owner_user_id = UUID(
            str(
                db_session.execute(
                    text("SELECT created_by_user_id FROM media WHERE id = :media_id"),
                    {"media_id": media_id},
                ).scalar_one()
            )
        )
        fingerprint = media_intelligence.current_content_fingerprint(
            db_session,
            media_id=media_id,
        )
        dedupe_key = f"media_unit_build:{media_id}:{fingerprint}"
        if queue_evidence == "missing":
            db_session.execute(
                text("DELETE FROM background_jobs WHERE dedupe_key = :dedupe_key"),
                {"dedupe_key": dedupe_key},
            )
            expected_job_count = 0
        else:
            db_session.execute(
                text(
                    "UPDATE background_jobs SET status = 'succeeded', "
                    "claimed_by = NULL, lease_expires_at = NULL, finished_at = now() "
                    "WHERE dedupe_key = :dedupe_key"
                ),
                {"dedupe_key": dedupe_key},
            )
            expected_job_count = 1
        db_session.commit()

        for _ in range(2):
            omission = ensure_current_many(
                db_session,
                media_ids=[media_id],
                requester_user_id=owner_user_id,
            )[0]
            assert isinstance(omission, media_intelligence.MediaOmission)
            assert (
                omission.reason
                is media_intelligence.MediaOmissionReason.ProjectionSuspended
            )
        assert _job_count(db_session, media_id) == expected_job_count

    def test_reingest_changes_fingerprint_and_clears_claims(self, db_session: Session) -> None:
        media_id = _seed_unit_media(db_session)
        ref = ensure_media_unit(db_session, media_id=media_id)
        # Mark ready with a claim so we can prove the rebuild clears it (AC-6 substrate).
        span_id = db_session.execute(
            text(
                "SELECT id FROM evidence_spans "
                "WHERE owner_kind = 'media' AND owner_id = :mid LIMIT 1"
            ),
            {"mid": media_id},
        ).scalar_one()
        db_session.execute(
            text("UPDATE media_summaries SET status = 'ready' WHERE id = :sid"),
            {"sid": ref.summary_id},
        )
        db_session.execute(
            text(
                "INSERT INTO media_claims (media_id, summary_id, claim_text, "
                "evidence_span_id, ordinal) VALUES (:m, :s, 'old', :e, 0)"
            ),
            {"m": media_id, "s": ref.summary_id, "e": span_id},
        )
        db_session.commit()

        # Re-ingest the source: same media, fresh chunk set → new fingerprint.
        from nexus.db.models import Fragment

        fragment = db_session.query(Fragment).filter(Fragment.media_id == media_id).first()
        assert fragment is not None
        fragment.canonical_text = "Completely different content body for the re-ingest."
        db_session.flush()
        rebuild_fragment_content_index(
            db_session,
            media_id=media_id,
            source_kind="web_article",
            fragments=[fragment],
            reason="test_reingest",
        )
        db_session.commit()

        new_ref = ensure_media_unit(db_session, media_id=media_id)
        assert new_ref.content_fingerprint != ref.content_fingerprint
        # Prior claims were cleared and the head returned to building.
        remaining = db_session.execute(
            text("SELECT COUNT(*) FROM media_claims WHERE summary_id = :sid"),
            {"sid": ref.summary_id},
        ).scalar_one()
        assert remaining == 0
        assert new_ref.status == "building"

    def test_same_content_reindex_changes_generation_fingerprint(
        self,
        db_session: Session,
    ) -> None:
        media_id = _seed_unit_media(db_session)
        ref = ensure_media_unit(db_session, media_id=media_id)
        span_id = db_session.execute(
            text(
                "SELECT id FROM evidence_spans "
                "WHERE owner_kind = 'media' AND owner_id = :media_id LIMIT 1"
            ),
            {"media_id": media_id},
        ).scalar_one()
        db_session.execute(
            text("UPDATE media_summaries SET status = 'ready' WHERE id = :summary_id"),
            {"summary_id": ref.summary_id},
        )
        db_session.execute(
            text(
                "INSERT INTO media_claims "
                "(media_id, summary_id, claim_text, evidence_span_id, ordinal) "
                "VALUES (:media_id, :summary_id, 'old', :span_id, 0)"
            ),
            {
                "media_id": media_id,
                "summary_id": ref.summary_id,
                "span_id": span_id,
            },
        )
        db_session.commit()
        from nexus.db.models import Fragment

        fragment = db_session.query(Fragment).filter(Fragment.media_id == media_id).one()
        rebuild_fragment_content_index(
            db_session,
            media_id=media_id,
            source_kind="web_article",
            fragments=[fragment],
            reason="same_content_reindex",
        )
        db_session.commit()

        rebuilt = ensure_media_unit(db_session, media_id=media_id)
        assert rebuilt.content_fingerprint != ref.content_fingerprint
        assert rebuilt.status == "building"
        assert db_session.execute(
            text(
                "SELECT count(*) FROM media_claims "
                "WHERE summary_id = :summary_id"
            ),
            {"summary_id": ref.summary_id},
        ).scalar_one() == 0

    def test_reensure_after_failure_at_same_fingerprint_enqueues_fresh_job(
        self, db_session: Session
    ) -> None:
        media_id = _seed_unit_media(db_session)
        ref = ensure_media_unit(db_session, media_id=media_id)
        dedupe_key = f"media_unit_build:{media_id}:{ref.content_fingerprint}"

        # Drive the build to failure, then complete its queue row as a real worker
        # would (SUCCEEDED holds the partial-unique dedupe_key forever).
        runtime = _ScriptedRuntime(outcome=_succeeded_invalid_payload_outcome())
        fingerprint, ctx = _claim_media_unit_build(db_session, media_id=media_id)
        asyncio.run(
            run_media_unit_build(
                db_session,
                media_id=media_id,
                content_fingerprint=fingerprint,
                ctx=ctx,
                runtime=runtime,
            )
        )
        db_session.expire_all()
        assert get_media_unit(db_session, media_id=media_id) is NotReady.Failed
        db_session.execute(
            text("UPDATE background_jobs SET status = 'succeeded' WHERE dedupe_key = :k"),
            {"k": dedupe_key},
        )
        db_session.commit()

        # Re-ensuring at the unchanged fingerprint must re-drive the head AND leave a
        # fresh runnable row (the terminal row is deleted before the re-enqueue).
        retry_ref = ensure_media_unit(db_session, media_id=media_id)
        assert retry_ref.content_fingerprint == ref.content_fingerprint
        assert retry_ref.status == "building"
        assert retry_ref.enqueued is True
        pending = db_session.execute(
            text(
                "SELECT COUNT(*) FROM background_jobs WHERE dedupe_key = :k AND status = 'pending'"
            ),
            {"k": dedupe_key},
        ).scalar_one()
        assert pending == 1


@pytest.mark.integration
class TestRunMediaUnitBuild:
    def test_persists_summary_and_grounded_claims(self, db_session: Session) -> None:
        media_id = _seed_unit_media(db_session)
        ref = ensure_media_unit(db_session, media_id=media_id)
        runtime = _ScriptedRuntime(
            outcome=_succeeded_unit_outcome(summary_md="An abstract.", claims=[("Claim one.", 0)])
        )

        fingerprint, ctx = _claim_media_unit_build(db_session, media_id=media_id)
        asyncio.run(
            run_media_unit_build(
                db_session,
                media_id=media_id,
                content_fingerprint=fingerprint,
                ctx=ctx,
                runtime=runtime,
            )
        )
        db_session.expire_all()

        unit = get_media_unit(db_session, media_id=media_id)
        assert isinstance(unit, MediaUnit)
        assert unit.summary_md == "An abstract."
        assert len(unit.claims) == 1
        assert unit.claims[0].claim_text == "Claim one."
        # The persisted span is a real evidence span for this media (grounding).
        span_exists = db_session.execute(
            text(
                "SELECT 1 FROM evidence_spans "
                "WHERE id = :sid AND owner_kind = 'media' AND owner_id = :mid"
            ),
            {"sid": unit.claims[0].evidence_span_id, "mid": media_id},
        ).scalar_one_or_none()
        assert span_exists == 1
        # AC-3: the one provider call is ledgered against the unit head.
        rows = _llm_call_rows(db_session, owner_kind="media_summary", owner_id=ref.summary_id)
        assert [row.call_seq for row in rows] == [1], (
            f"expected exactly one ledgered call, got {[(r.call_seq, r.outcome) for r in rows]}"
        )
        assert rows[0].llm_operation == MEDIA_UNIT_OPERATION
        assert rows[0].outcome == "succeeded"

    def test_build_runs_inside_the_budget_envelope(
        self, db_session: Session, unit_rate_limiter: _RecordingRateLimiter
    ) -> None:
        media_id = _seed_unit_media(db_session)
        ref = ensure_media_unit(db_session, media_id=media_id)
        runtime = _ScriptedRuntime(
            outcome=_succeeded_unit_outcome(summary_md="An abstract.", claims=[("Claim one.", 0)])
        )

        fingerprint, ctx = _claim_media_unit_build(db_session, media_id=media_id)
        asyncio.run(
            run_media_unit_build(
                db_session,
                media_id=media_id,
                content_fingerprint=fingerprint,
                ctx=ctx,
                runtime=runtime,
            )
        )

        # The worker's own concurrency guard still brackets the call.
        assert unit_rate_limiter.events == ["acquire_inflight_slot", "release_inflight_slot"]

        # The token budget reservation/charge is now owned inside execute_generation
        # (against the real global rate limiter installed by the _rate_limiter
        # fixture) rather than being visible on this worker-level hook — verify it
        # directly against the ledger row instead.
        db_session.expire_all()
        rows = _llm_call_rows(db_session, owner_kind="media_summary", owner_id=ref.summary_id)
        assert len(rows) == 1
        charge = db_session.execute(
            text("SELECT charged_tokens FROM token_budget_charges WHERE reservation_id = :id"),
            {"id": rows[0].id},
        ).first()
        assert charge is not None and charge[0] == 70

    def test_envelope_releases_inflight_slot_on_provider_failure(
        self, db_session: Session, unit_rate_limiter: _RecordingRateLimiter
    ) -> None:
        media_id = _seed_unit_media(db_session)
        ensure_media_unit(db_session, media_id=media_id)
        failure = TransientExhausted(attempts=1, cause=ProviderHttpUnavailable())
        runtime = _ScriptedRuntime(outcome=Failed(meta=_meta(usage=Absent()), failure=failure))

        fingerprint, ctx = _claim_media_unit_build(db_session, media_id=media_id)
        asyncio.run(
            run_media_unit_build(
                db_session,
                media_id=media_id,
                content_fingerprint=fingerprint,
                ctx=ctx,
                runtime=runtime,
            )
        )

        # The inflight slot is always released, success or failure.
        assert unit_rate_limiter.events == ["acquire_inflight_slot", "release_inflight_slot"]

    def test_drops_claim_with_unresolvable_index(self, db_session: Session) -> None:
        media_id = _seed_unit_media(db_session)
        ensure_media_unit(db_session, media_id=media_id)
        # index 999 is out of range → must be dropped (AC-2 end-to-end).
        runtime = _ScriptedRuntime(
            outcome=_succeeded_unit_outcome(summary_md="s", claims=[("kept", 0), ("dropped", 999)])
        )

        fingerprint, ctx = _claim_media_unit_build(db_session, media_id=media_id)
        asyncio.run(
            run_media_unit_build(
                db_session,
                media_id=media_id,
                content_fingerprint=fingerprint,
                ctx=ctx,
                runtime=runtime,
            )
        )
        db_session.expire_all()

        unit = get_media_unit(db_session, media_id=media_id)
        assert isinstance(unit, MediaUnit)
        assert [c.claim_text for c in unit.claims] == ["kept"]

    def test_invalid_structured_output_marks_failed_with_error_floor(
        self, db_session: Session
    ) -> None:
        media_id = _seed_unit_media(db_session)
        ref = ensure_media_unit(db_session, media_id=media_id)
        runtime = _ScriptedRuntime(outcome=_succeeded_invalid_payload_outcome())

        fingerprint, ctx = _claim_media_unit_build(db_session, media_id=media_id)
        asyncio.run(
            run_media_unit_build(
                db_session,
                media_id=media_id,
                content_fingerprint=fingerprint,
                ctx=ctx,
                runtime=runtime,
            )
        )
        db_session.expire_all()
        assert get_media_unit(db_session, media_id=media_id) is NotReady.Failed
        # The error floor lands on the head row.
        head = db_session.execute(
            text("SELECT error_code, error_detail FROM media_summaries WHERE id = :sid"),
            {"sid": ref.summary_id},
        ).one()
        assert head.error_code == "invalid_structured_output", f"got {head.error_code!r}"
        assert head.error_detail, "error_detail must carry the operator-facing reason"
        # The provider call itself succeeded (only the decode failed downstream),
        # so exactly one attempt is ledgered — there is no repair-round retry in
        # the new architecture (run_media_unit_build calls execute_generation
        # exactly once and fails immediately on a decode error).
        rows = _llm_call_rows(db_session, owner_kind="media_summary", owner_id=ref.summary_id)
        assert [row.call_seq for row in rows] == [1], (
            f"expected exactly one ledgered call, got {[(r.call_seq, r.outcome) for r in rows]}"
        )
        assert rows[0].outcome == "succeeded"

    def test_provider_failure_marks_failed_with_error_floor(self, db_session: Session) -> None:
        media_id = _seed_unit_media(db_session)
        ref = ensure_media_unit(db_session, media_id=media_id)
        failure = TransientExhausted(attempts=1, cause=ProviderHttpUnavailable())
        runtime = _ScriptedRuntime(outcome=Failed(meta=_meta(usage=Absent()), failure=failure))

        fingerprint, ctx = _claim_media_unit_build(db_session, media_id=media_id)
        asyncio.run(
            run_media_unit_build(
                db_session,
                media_id=media_id,
                content_fingerprint=fingerprint,
                ctx=ctx,
                runtime=runtime,
            )
        )
        db_session.expire_all()
        assert get_media_unit(db_session, media_id=media_id) is NotReady.Failed
        head = db_session.execute(
            text("SELECT error_code, error_detail FROM media_summaries WHERE id = :sid"),
            {"sid": ref.summary_id},
        ).one()
        assert head.error_code == "provider_unavailable", f"got {head.error_code!r}"
        rows = _llm_call_rows(db_session, owner_kind="media_summary", owner_id=ref.summary_id)
        assert [row.call_seq for row in rows] == [1]
        assert rows[0].outcome == "failed"
        assert rows[0].error_origin == "provider_http"
        assert rows[0].error_code == "provider_unavailable"

    def test_replay_guard_noop_when_not_building(self, db_session: Session) -> None:
        media_id = _seed_unit_media(db_session)
        ref = ensure_media_unit(db_session, media_id=media_id)
        db_session.execute(
            text("UPDATE media_summaries SET status = 'ready' WHERE id = :sid"),
            {"sid": ref.summary_id},
        )
        db_session.commit()
        runtime = _ScriptedRuntime(
            outcome=_succeeded_unit_outcome(summary_md="should-not-run", claims=[])
        )

        fingerprint, ctx = _claim_media_unit_build(db_session, media_id=media_id)
        asyncio.run(
            run_media_unit_build(
                db_session,
                media_id=media_id,
                content_fingerprint=fingerprint,
                ctx=ctx,
                runtime=runtime,
            )
        )
        assert runtime.calls == []

    def test_persist_is_noop_when_fingerprint_superseded(self, db_session: Session) -> None:
        # Mid-flight re-ingest TOCTOU: a build whose generation no longer matches the
        # head must not promote it (and must never reach the FK-bearing claim INSERTs).
        media_id = _seed_unit_media(db_session)
        ref = ensure_media_unit(db_session, media_id=media_id)
        span_id = db_session.execute(
            text(
                "SELECT id FROM evidence_spans "
                "WHERE owner_kind = 'media' AND owner_id = :mid LIMIT 1"
            ),
            {"mid": media_id},
        ).scalar_one()
        db_session.commit()

        owner_user_id = db_session.execute(
            text("SELECT created_by_user_id FROM media WHERE id = :mid"),
            {"mid": media_id},
        ).scalar_one()

        _persist_unit(
            db_session,
            media_id=media_id,
            owner_user_id=UUID(str(owner_user_id)),
            summary_id=ref.summary_id,
            summary_md="superseded summary",
            expected_fingerprint="a-different-generation-fingerprint",
            grounded=[("stale claim", UUID(str(span_id)), 0)],
            ctx=_claim_media_unit_build(db_session, media_id=media_id)[1],
        )
        db_session.expire_all()

        # Head stays building at the live fingerprint; no stale claims were written.
        assert get_media_unit(db_session, media_id=media_id) is NotReady.Building
        claim_count = db_session.execute(
            text("SELECT COUNT(*) FROM media_claims WHERE summary_id = :sid"),
            {"sid": ref.summary_id},
        ).scalar_one()
        assert claim_count == 0

    def test_prepared_crash_replays_and_dispatches_once(
        self, db_session: Session, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        media_id = _seed_unit_media(db_session)
        ensure_media_unit(db_session, media_id=media_id)
        fingerprint, ctx = _claim_media_unit_build(db_session, media_id=media_id)
        runtime = _ScriptedRuntime(
            outcome=_succeeded_unit_outcome(summary_md="prepared replay", claims=[("claim", 0)])
        )
        real_checkpoint = coordination.checkpoint_step_state
        checkpoint_calls = 0

        def crash_before_uncertain(*args, **kwargs):  # noqa: ANN002, ANN003
            nonlocal checkpoint_calls
            checkpoint_calls += 1
            if checkpoint_calls == 2:
                raise RuntimeError("crash after Prepared")
            return real_checkpoint(*args, **kwargs)

        monkeypatch.setattr(coordination, "checkpoint_step_state", crash_before_uncertain)
        with pytest.raises(RuntimeError, match="crash after Prepared"):
            asyncio.run(
                run_media_unit_build(
                    db_session,
                    media_id=media_id,
                    content_fingerprint=fingerprint,
                    ctx=ctx,
                    runtime=runtime,
                )
            )
        assert runtime.calls == []
        job = get_job(db_session, ctx.job_id)
        assert job is not None
        state = coordination.read_step_states(job)["synthesis"]
        assert state.dispatch_phase is coordination.Prepared

        db_session.rollback()
        monkeypatch.setattr(coordination, "checkpoint_step_state", real_checkpoint)
        asyncio.run(
            run_media_unit_build(
                db_session,
                media_id=media_id,
                content_fingerprint=fingerprint,
                ctx=ctx,
                runtime=runtime,
            )
        )
        assert runtime.calls == ["generate"]
        assert isinstance(get_media_unit(db_session, media_id=media_id), MediaUnit)

    def test_uncertain_crash_never_redispatches(self, db_session: Session) -> None:
        media_id = _seed_unit_media(db_session)
        ensure_media_unit(db_session, media_id=media_id)
        fingerprint, ctx = _claim_media_unit_build(db_session, media_id=media_id)
        first = _ScriptedRuntime(generate_error=RuntimeError("provider connection lost"))

        with pytest.raises(RuntimeError, match="provider connection lost"):
            asyncio.run(
                run_media_unit_build(
                    db_session,
                    media_id=media_id,
                    content_fingerprint=fingerprint,
                    ctx=ctx,
                    runtime=first,
                )
            )
        assert first.calls == ["generate"]
        job = get_job(db_session, ctx.job_id)
        assert job is not None
        state = coordination.read_step_states(job)["synthesis"]
        assert state.dispatch_phase is coordination.Uncertain

        second = _ScriptedRuntime(
            outcome=_succeeded_unit_outcome(summary_md="must not land", claims=[])
        )
        with pytest.raises(RuntimeError, match="synthesis is uncertain"):
            asyncio.run(
                run_media_unit_build(
                    db_session,
                    media_id=media_id,
                    content_fingerprint=fingerprint,
                    ctx=ctx,
                    runtime=second,
                )
            )
        assert second.calls == []
        assert get_media_unit(db_session, media_id=media_id) is NotReady.Building

    def test_completed_crash_replays_normalized_result_without_dispatch(
        self, db_session: Session, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        media_id = _seed_unit_media(db_session)
        ensure_media_unit(db_session, media_id=media_id)
        fingerprint, ctx = _claim_media_unit_build(db_session, media_id=media_id)
        first = _ScriptedRuntime(
            outcome=_succeeded_unit_outcome(summary_md="memoized abstract", claims=[("claim", 0)])
        )
        real_persist = media_intelligence._persist_unit

        def crash_before_publish(*args, **kwargs):  # noqa: ANN002, ANN003
            raise RuntimeError("crash after Completed")

        monkeypatch.setattr(media_intelligence, "_persist_unit", crash_before_publish)
        with pytest.raises(RuntimeError, match="crash after Completed"):
            asyncio.run(
                run_media_unit_build(
                    db_session,
                    media_id=media_id,
                    content_fingerprint=fingerprint,
                    ctx=ctx,
                    runtime=first,
                )
            )
        assert first.calls == ["generate"]
        job = get_job(db_session, ctx.job_id)
        assert job is not None
        state = coordination.read_step_states(job)["synthesis"]
        assert state.dispatch_phase is coordination.Completed
        assert isinstance(state.terminal_result, PresencePresent)
        assert json.loads(state.terminal_result.value)["outcome"] == "success"
        assert get_media_unit(db_session, media_id=media_id) is NotReady.Building

        monkeypatch.setattr(media_intelligence, "_persist_unit", real_persist)
        replay = _ScriptedRuntime(generate_error=AssertionError("must not dispatch"))
        asyncio.run(
            run_media_unit_build(
                db_session,
                media_id=media_id,
                content_fingerprint=fingerprint,
                ctx=ctx,
                runtime=replay,
            )
        )
        assert replay.calls == []
        unit = get_media_unit(db_session, media_id=media_id)
        assert isinstance(unit, MediaUnit)
        assert unit.summary_md == "memoized abstract"

    def test_operator_proves_not_dispatched_requeues_same_job_and_restores_liveness(
        self, db_session: Session
    ) -> None:
        media_id = _seed_unit_media(db_session)
        owner_user_id = UUID(
            str(
                db_session.execute(
                    text("SELECT created_by_user_id FROM media WHERE id = :media_id"),
                    {"media_id": media_id},
                ).scalar_one()
            )
        )
        fingerprint, job_id = _dead_uncertain_media_unit_build(
            db_session,
            media_id=media_id,
        )

        projection = read_single(
            db_session,
            media_id=media_id,
            requester_user_id=owner_user_id,
        )
        assert projection.status == "suspended"
        omission = ensure_current_many(
            db_session,
            media_ids=[media_id],
            requester_user_id=owner_user_id,
        )[0]
        assert isinstance(omission, media_intelligence.MediaOmission)
        assert omission.reason is media_intelligence.MediaOmissionReason.ProjectionSuspended

        library_id = get_user_default_library(db_session, owner_user_id)
        assert library_id is not None
        no_dispatch = _ScriptedRuntime(
            generate_error=AssertionError("suspended dependency must terminalize before dispatch")
        )
        collected = asyncio.run(
            LIBRARY_BINDING.collect(
                db_session,
                resolved=ResolvedSubject(
                    scheme="library",
                    subject_id=library_id,
                    ref=ResourceRef(scheme="library", id=library_id),
                    detail=owner_user_id,
                ),
                audience=AudienceLibrary(library_id=library_id),
                runtime=no_dispatch,
            )
        )
        assert no_dispatch.calls == []
        assert LIBRARY_BINDING.empty_failure(collected) is DossierBuildFailureCode.NoSourceMaterial

        reconcile_uncertain_media_unit(
            db_session,
            media_id=media_id,
            content_fingerprint=fingerprint,
            resolution=coordination.ProveNotDispatched(),
        )
        repaired_job = get_job(db_session, job_id)
        assert repaired_job is not None
        assert repaired_job.status == "pending"
        assert repaired_job.attempts == 0
        repaired_state = coordination.read_step_states(repaired_job)["synthesis"]
        assert repaired_state.dispatch_phase is coordination.Prepared
        assert (
            read_single(
                db_session,
                media_id=media_id,
                requester_user_id=owner_user_id,
            ).status
            == "building"
        )
        pending = ensure_current_many(
            db_session,
            media_ids=[media_id],
            requester_user_id=owner_user_id,
        )[0]
        assert isinstance(pending, media_intelligence.MediaOmission)
        assert pending.reason is media_intelligence.MediaOmissionReason.ProjectionPending

        repaired_fingerprint, repaired_ctx = _claim_media_unit_build(
            db_session,
            media_id=media_id,
            worker_id="proved-not-dispatched",
        )
        assert repaired_ctx.job_id == job_id
        replay = _ScriptedRuntime(
            outcome=_succeeded_unit_outcome(summary_md="repaired dispatch", claims=[("claim", 0)])
        )
        asyncio.run(
            run_media_unit_build(
                db_session,
                media_id=media_id,
                content_fingerprint=repaired_fingerprint,
                ctx=repaired_ctx,
                runtime=replay,
            )
        )
        assert replay.calls == ["generate"]
        assert isinstance(get_media_unit(db_session, media_id=media_id), MediaUnit)

    def test_operator_attaches_validated_result_and_replay_never_dispatches(
        self, db_session: Session
    ) -> None:
        media_id = _seed_unit_media(db_session)
        fingerprint, job_id = _dead_uncertain_media_unit_build(
            db_session,
            media_id=media_id,
        )
        evidence_span_id = UUID(
            str(
                db_session.execute(
                    text(
                        "SELECT primary_evidence_span_id FROM content_chunks "
                        "WHERE owner_kind = 'media' AND owner_id = :media_id "
                        "AND primary_evidence_span_id IS NOT NULL "
                        "ORDER BY chunk_idx LIMIT 1"
                    ),
                    {"media_id": media_id},
                ).scalar_one()
            )
        )
        recovered = {
            "outcome": "success",
            "summary_md": "Recovered operator result.",
            "claims": [
                {
                    "claim_text": "Recovered grounded claim.",
                    "evidence_span_id": str(evidence_span_id),
                    "ordinal": 0,
                }
            ],
        }

        with pytest.raises(ValueError):
            reconcile_uncertain_media_unit(
                db_session,
                media_id=media_id,
                content_fingerprint=fingerprint,
                resolution=coordination.AttachReconciledResult(
                    terminal_result=json.dumps(
                        {
                            "outcome": "success",
                            "summary_md": "Missing grounded claim identity.",
                            "claims": [{"claim_text": "invalid", "ordinal": 0}],
                        }
                    )
                ),
            )
        db_session.rollback()
        rejected_job = get_job(db_session, job_id)
        assert rejected_job is not None
        assert rejected_job.status == "dead"
        assert (
            coordination.read_step_states(rejected_job)["synthesis"].dispatch_phase
            is coordination.Uncertain
        )

        other_media_id = _seed_unit_media(db_session)
        foreign_span_id = db_session.execute(
            text(
                "SELECT id FROM evidence_spans "
                "WHERE owner_kind = 'media' AND owner_id = :media_id "
                "ORDER BY id LIMIT 1"
            ),
            {"media_id": other_media_id},
        ).scalar_one()
        with pytest.raises(InvalidRequestError):
            reconcile_uncertain_media_unit(
                db_session,
                media_id=media_id,
                content_fingerprint=fingerprint,
                resolution=coordination.AttachReconciledResult(
                    terminal_result=json.dumps(
                        {
                            "outcome": "success",
                            "summary_md": "Foreign grounding.",
                            "claims": [
                                {
                                    "claim_text": "invalid",
                                    "evidence_span_id": str(foreign_span_id),
                                    "ordinal": 0,
                                }
                            ],
                        }
                    )
                ),
            )
        db_session.rollback()
        rejected_job = get_job(db_session, job_id)
        assert rejected_job is not None
        assert rejected_job.status == "dead"
        assert (
            coordination.read_step_states(rejected_job)["synthesis"].dispatch_phase
            is coordination.Uncertain
        )

        reconcile_uncertain_media_unit(
            db_session,
            media_id=media_id,
            content_fingerprint=fingerprint,
            resolution=coordination.AttachReconciledResult(terminal_result=json.dumps(recovered)),
        )
        repaired_job = get_job(db_session, job_id)
        assert repaired_job is not None
        assert repaired_job.status == "pending"
        state = coordination.read_step_states(repaired_job)["synthesis"]
        assert state.dispatch_phase is coordination.Completed
        assert isinstance(state.terminal_result, PresencePresent)
        assert json.loads(state.terminal_result.value) == recovered

        repaired_fingerprint, repaired_ctx = _claim_media_unit_build(
            db_session,
            media_id=media_id,
            worker_id="attached-result",
        )
        replay = _ScriptedRuntime(generate_error=AssertionError("must not dispatch"))
        asyncio.run(
            run_media_unit_build(
                db_session,
                media_id=media_id,
                content_fingerprint=repaired_fingerprint,
                ctx=repaired_ctx,
                runtime=replay,
            )
        )
        assert replay.calls == []
        unit = get_media_unit(db_session, media_id=media_id)
        assert isinstance(unit, MediaUnit)
        assert unit.summary_md == "Recovered operator result."
        assert [claim.claim_text for claim in unit.claims] == ["Recovered grounded claim."]


@pytest.mark.integration
class TestGetMediaUnitStates:
    def test_missing(self, db_session: Session) -> None:
        assert get_media_unit(db_session, media_id=uuid4()) is NotReady.Missing

    def test_building(self, db_session: Session) -> None:
        media_id = _seed_unit_media(db_session)
        ensure_media_unit(db_session, media_id=media_id)
        assert get_media_unit(db_session, media_id=media_id) is NotReady.Building

    def test_stale_after_content_change(self, db_session: Session) -> None:
        media_id = _seed_unit_media(db_session)
        ref = ensure_media_unit(db_session, media_id=media_id)
        db_session.execute(
            text(
                "UPDATE media_summaries SET status = 'ready', "
                "content_fingerprint = 'stale-fingerprint' WHERE id = :sid"
            ),
            {"sid": ref.summary_id},
        )
        db_session.commit()
        assert get_media_unit(db_session, media_id=media_id) is NotReady.Stale


# =============================================================================
# app_search summary enrichment
# =============================================================================


@pytest.mark.integration
class TestAppSearchSummaryEnrichment:
    def test_media_card_carries_summary_when_ready(self, db_session: Session) -> None:
        from nexus.services.search import search

        media_id = _seed_unit_media(db_session, title="Searchable Abstract Doc")
        ref = ensure_media_unit(db_session, media_id=media_id)
        db_session.execute(
            text(
                "UPDATE media_summaries SET status = 'ready', "
                "summary_md = 'The ready abstract.' WHERE id = :sid"
            ),
            {"sid": ref.summary_id},
        )
        db_session.commit()

        user_id = db_session.execute(
            text("SELECT created_by_user_id FROM media WHERE id = :mid"),
            {"mid": media_id},
        ).scalar_one()
        response = search(
            db_session,
            viewer_id=user_id,
            query=SearchQuery(text="Searchable Abstract", requested_kinds=frozenset({"documents"})),
        )
        media_results = [r for r in response.results if getattr(r, "type", None) == "media"]
        assert media_results, "expected the media title hit"
        assert media_results[0].source.summary_md == "The ready abstract."

    def test_media_card_summary_null_when_not_ready(self, db_session: Session) -> None:
        from nexus.services.search import search

        media_id = _seed_unit_media(db_session, title="No Abstract Doc")
        ensure_media_unit(db_session, media_id=media_id)  # stays 'building'

        user_id = db_session.execute(
            text("SELECT created_by_user_id FROM media WHERE id = :mid"),
            {"mid": media_id},
        ).scalar_one()
        response = search(
            db_session,
            viewer_id=user_id,
            query=SearchQuery(text="No Abstract", requested_kinds=frozenset({"documents"})),
        )
        media_results = [r for r in response.results if getattr(r, "type", None) == "media"]
        assert media_results
        assert media_results[0].source.summary_md is None
