"""Tests for the per-media intelligence unit service (S2)."""

from __future__ import annotations

import asyncio
import json
from uuid import UUID, uuid4

import pytest
from llm_calling.types import LLMResponse
from pydantic import ValidationError
from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.services.bootstrap import ensure_user_and_default_library
from nexus.services.content_indexing import rebuild_fragment_content_index
from nexus.services.media_intelligence import (
    MediaUnit,
    MediaUnitClaimOut,
    MediaUnitSynthesis,
    NotReady,
    _Candidate,
    _map_claims_to_spans,
    _persist_unit,
    ensure_media_unit,
    fail_media_unit_after_worker_exception,
    get_media_unit,
    run_media_unit_build,
)
from tests.helpers import auth_headers, create_test_user_id

# =============================================================================
# Unit tests (pure helper + schema) — AC-2 grounding map
# =============================================================================


@pytest.mark.unit
class TestMapClaimsToSpans:
    def _candidates(self, n: int) -> list[_Candidate]:
        return [_Candidate(evidence_span_id=uuid4(), text=f"chunk {i}") for i in range(n)]

    def test_valid_index_kept_with_right_span(self) -> None:
        candidates = self._candidates(3)
        synthesis = MediaUnitSynthesis(
            summary_md="s",
            claims=[
                MediaUnitClaimOut(claim_text="a", candidate_index=0),
                MediaUnitClaimOut(claim_text="b", candidate_index=2),
            ],
        )
        grounded = _map_claims_to_spans(synthesis, candidates)
        assert grounded == [
            ("a", candidates[0].evidence_span_id, 0),
            ("b", candidates[2].evidence_span_id, 1),
        ]

    def test_out_of_range_index_dropped(self) -> None:
        candidates = self._candidates(2)
        synthesis = MediaUnitSynthesis(
            summary_md="s",
            claims=[
                MediaUnitClaimOut(claim_text="keep", candidate_index=1),
                MediaUnitClaimOut(claim_text="drop_high", candidate_index=5),
                MediaUnitClaimOut(claim_text="drop_neg", candidate_index=-1),
            ],
        )
        grounded = _map_claims_to_spans(synthesis, candidates)
        # Only the in-range claim survives (AC-2: ungrounded claims are dropped).
        assert grounded == [("keep", candidates[1].evidence_span_id, 0)]

    def test_ordinals_reassigned_over_survivors(self) -> None:
        candidates = self._candidates(2)
        synthesis = MediaUnitSynthesis(
            summary_md="s",
            claims=[
                MediaUnitClaimOut(claim_text="x", candidate_index=9),  # dropped
                MediaUnitClaimOut(claim_text="y", candidate_index=0),  # ordinal 0
                MediaUnitClaimOut(claim_text="z", candidate_index=1),  # ordinal 1
            ],
        )
        grounded = _map_claims_to_spans(synthesis, candidates)
        assert [(text_, ordinal) for text_, _span, ordinal in grounded] == [("y", 0), ("z", 1)]


@pytest.mark.unit
class TestMediaUnitSynthesisSchema:
    def test_rejects_extra_keys(self) -> None:
        with pytest.raises(ValidationError):
            MediaUnitSynthesis.model_validate({"summary_md": "s", "claims": [], "unexpected": True})

    def test_rejects_missing_summary(self) -> None:
        with pytest.raises(ValidationError):
            MediaUnitSynthesis.model_validate({"claims": []})

    def test_claim_rejects_extra_keys(self) -> None:
        with pytest.raises(ValidationError):
            MediaUnitClaimOut.model_validate({"claim_text": "a", "candidate_index": 0, "junk": 1})


# =============================================================================
# Integration tests (real DB, fake LLM at the external boundary)
# =============================================================================


class _UnitRouter:
    """Fake LLMRouter returning a fixed unit synthesis (the external boundary)."""

    def __init__(self, *, summary_md: str, claims: list[tuple[str, int]]) -> None:
        self._payload = {
            "summary_md": summary_md,
            "claims": [
                {"claim_text": claim_text, "candidate_index": idx} for claim_text, idx in claims
            ],
        }
        self.calls = 0

    async def generate(self, _provider, _request, _api_key, *, timeout_s):
        self.calls += 1
        return LLMResponse(
            text=json.dumps(self._payload),
            usage=None,
            provider_request_id=None,
            status=None,
            incomplete_details=None,
        )


class _RawTextRouter:
    """Fake router returning non-JSON text (drives StructuredSynthesisError)."""

    async def generate(self, _provider, _request, _api_key, *, timeout_s):
        return LLMResponse(
            text="not json at all",
            usage=None,
            provider_request_id=None,
            status=None,
            incomplete_details=None,
        )


def _seed_unit_media(db: Session, *, title: str = "Unit Doc") -> UUID:
    user_id = uuid4()
    ensure_user_and_default_library(db, user_id)
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

    def test_reingest_changes_fingerprint_and_clears_claims(self, db_session: Session) -> None:
        media_id = _seed_unit_media(db_session)
        ref = ensure_media_unit(db_session, media_id=media_id)
        # Mark ready with a claim so we can prove the rebuild clears it (AC-6 substrate).
        span_id = db_session.execute(
            text("SELECT id FROM evidence_spans WHERE media_id = :mid LIMIT 1"),
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

    def test_reensure_after_failure_at_same_fingerprint_enqueues_fresh_job(
        self, db_session: Session
    ) -> None:
        media_id = _seed_unit_media(db_session)
        ref = ensure_media_unit(db_session, media_id=media_id)
        dedupe_key = f"media_unit_build:{media_id}:{ref.content_fingerprint}"

        # Drive the build to failure, then complete its queue row as a real worker
        # would (SUCCEEDED holds the partial-unique dedupe_key forever).
        asyncio.run(run_media_unit_build(db_session, media_id=media_id, llm=_RawTextRouter()))
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
                "SELECT COUNT(*) FROM background_jobs "
                "WHERE dedupe_key = :k AND status = 'pending'"
            ),
            {"k": dedupe_key},
        ).scalar_one()
        assert pending == 1


@pytest.mark.integration
class TestRunMediaUnitBuild:
    def test_persists_summary_and_grounded_claims(self, db_session: Session) -> None:
        media_id = _seed_unit_media(db_session)
        ensure_media_unit(db_session, media_id=media_id)
        router = _UnitRouter(summary_md="An abstract.", claims=[("Claim one.", 0)])

        asyncio.run(run_media_unit_build(db_session, media_id=media_id, llm=router))
        db_session.expire_all()

        unit = get_media_unit(db_session, media_id=media_id)
        assert isinstance(unit, MediaUnit)
        assert unit.summary_md == "An abstract."
        assert len(unit.claims) == 1
        assert unit.claims[0].claim_text == "Claim one."
        # The persisted span is a real evidence span for this media (grounding).
        span_exists = db_session.execute(
            text("SELECT 1 FROM evidence_spans WHERE id = :sid AND media_id = :mid"),
            {"sid": unit.claims[0].evidence_span_id, "mid": media_id},
        ).scalar_one_or_none()
        assert span_exists == 1

    def test_drops_claim_with_unresolvable_index(self, db_session: Session) -> None:
        media_id = _seed_unit_media(db_session)
        ensure_media_unit(db_session, media_id=media_id)
        # index 999 is out of range → must be dropped (AC-2 end-to-end).
        router = _UnitRouter(summary_md="s", claims=[("kept", 0), ("dropped", 999)])

        asyncio.run(run_media_unit_build(db_session, media_id=media_id, llm=router))
        db_session.expire_all()

        unit = get_media_unit(db_session, media_id=media_id)
        assert isinstance(unit, MediaUnit)
        assert [c.claim_text for c in unit.claims] == ["kept"]

    def test_llm_failure_marks_failed(self, db_session: Session) -> None:
        media_id = _seed_unit_media(db_session)
        ensure_media_unit(db_session, media_id=media_id)

        asyncio.run(run_media_unit_build(db_session, media_id=media_id, llm=_RawTextRouter()))
        db_session.expire_all()
        assert get_media_unit(db_session, media_id=media_id) is NotReady.Failed

    def test_replay_guard_noop_when_not_building(self, db_session: Session) -> None:
        media_id = _seed_unit_media(db_session)
        ref = ensure_media_unit(db_session, media_id=media_id)
        db_session.execute(
            text("UPDATE media_summaries SET status = 'ready' WHERE id = :sid"),
            {"sid": ref.summary_id},
        )
        db_session.commit()
        router = _UnitRouter(summary_md="should-not-run", claims=[])

        asyncio.run(run_media_unit_build(db_session, media_id=media_id, llm=router))
        assert router.calls == 0

    def test_persist_is_noop_when_fingerprint_superseded(self, db_session: Session) -> None:
        # Mid-flight re-ingest TOCTOU: a build whose generation no longer matches the
        # head must not promote it (and must never reach the FK-bearing claim INSERTs).
        media_id = _seed_unit_media(db_session)
        ref = ensure_media_unit(db_session, media_id=media_id)
        span_id = db_session.execute(
            text("SELECT id FROM evidence_spans WHERE media_id = :mid LIMIT 1"),
            {"mid": media_id},
        ).scalar_one()
        db_session.commit()

        _persist_unit(
            db_session,
            media_id=media_id,
            summary_id=ref.summary_id,
            summary_md="superseded summary",
            expected_fingerprint="a-different-generation-fingerprint",
            grounded=[("stale claim", UUID(str(span_id)), 0)],
        )
        db_session.expire_all()

        # Head stays building at the live fingerprint; no stale claims were written.
        assert get_media_unit(db_session, media_id=media_id) is NotReady.Building
        claim_count = db_session.execute(
            text("SELECT COUNT(*) FROM media_claims WHERE summary_id = :sid"),
            {"sid": ref.summary_id},
        ).scalar_one()
        assert claim_count == 0


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


@pytest.mark.integration
class TestFailAfterWorkerException:
    def test_sets_failed_when_nonterminal(self, db_session: Session) -> None:
        media_id = _seed_unit_media(db_session)
        ensure_media_unit(db_session, media_id=media_id)
        fail_media_unit_after_worker_exception(db_session, media_id=media_id)
        db_session.expire_all()
        assert get_media_unit(db_session, media_id=media_id) is NotReady.Failed

    def test_noop_when_already_ready(self, db_session: Session) -> None:
        media_id = _seed_unit_media(db_session)
        router = _UnitRouter(summary_md="kept", claims=[("c", 0)])
        ensure_media_unit(db_session, media_id=media_id)
        asyncio.run(run_media_unit_build(db_session, media_id=media_id, llm=router))
        db_session.expire_all()
        fail_media_unit_after_worker_exception(db_session, media_id=media_id)
        db_session.expire_all()
        unit = get_media_unit(db_session, media_id=media_id)
        assert isinstance(unit, MediaUnit)
        assert unit.summary_md == "kept"


# =============================================================================
# Route + app_search enrichment
# =============================================================================


@pytest.mark.integration
class TestSummarizeRoute:
    def test_summarize_returns_202_when_readable(self, auth_client, direct_db) -> None:
        from tests.factories import create_searchable_media

        user_id = create_test_user_id()
        with direct_db.session() as session:
            ensure_user_and_default_library(session, user_id)
            media_id = create_searchable_media(session, user_id, title="Readable")
        direct_db.register_cleanup("media", "id", media_id)

        response = auth_client.post(f"/media/{media_id}/summarize", headers=auth_headers(user_id))
        assert response.status_code == 202, response.text
        data = response.json()["data"]
        assert data["media_id"] == str(media_id)
        assert data["status"] in ("building", "ready")

    def test_summarize_returns_404_when_unreadable(self, auth_client, direct_db) -> None:
        from tests.factories import create_searchable_media

        owner_id = create_test_user_id()
        other_id = create_test_user_id()
        with direct_db.session() as session:
            ensure_user_and_default_library(session, owner_id)
            ensure_user_and_default_library(session, other_id)
            media_id = create_searchable_media(session, owner_id, title="Private")
        direct_db.register_cleanup("media", "id", media_id)

        response = auth_client.post(f"/media/{media_id}/summarize", headers=auth_headers(other_id))
        assert response.status_code == 404


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
        response = search(db_session, user_id, "Searchable Abstract", types=["media"])
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
        response = search(db_session, user_id, "No Abstract", types=["media"])
        media_results = [r for r in response.results if getattr(r, "type", None) == "media"]
        assert media_results
        assert media_results[0].source.summary_md is None
