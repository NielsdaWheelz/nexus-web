"""Tests for the slim library-intelligence artifact owner (S4)."""

from __future__ import annotations

import asyncio
import json
from uuid import UUID, uuid4

import pytest
from llm_calling.types import LLMResponse
from pydantic import ValidationError
from sqlalchemy import select, text
from sqlalchemy.orm import Session

from nexus.config import clear_settings_cache
from nexus.db.models import LLMCall
from nexus.services import run_kit
from nexus.services.billing_entitlements import grant_entitlement_override
from nexus.services.bootstrap import ensure_user_and_default_library
from nexus.services.library_intelligence import (
    generate_artifact,
    get_artifact,
    list_revisions,
    promote_revision,
)
from nexus.services.library_intelligence_reduce import (
    LI_REDUCE_INPUT_CHAR_BUDGET,
    _Candidate,
    _GroundedCitation,
    _LiCitationOut,
    _LiSynthesis,
    _map_li_citations,
    run_artifact_generation,
)
from nexus.tasks.library_intelligence import _fail_revision_after_worker_exception
from tests.factories import (
    add_media_to_library,
    create_searchable_media_in_library,
    create_test_library,
)
from tests.helpers import create_test_user_id

# =============================================================================
# Unit tests (pure helpers, no DB)
# =============================================================================


@pytest.mark.unit
class TestMapLiCitations:
    def _candidates(self, n: int) -> list[_Candidate]:
        return [
            _Candidate(
                global_index=i,
                media_id=uuid4(),
                evidence_span_id=uuid4(),
                claim_text=f"claim {i}",
                summary_md="s",
            )
            for i in range(n)
        ]

    def test_valid_claim_index_mapped_to_span(self) -> None:
        candidates = self._candidates(3)
        synthesis = _LiSynthesis(
            content_md="Prose [1] and [2].",
            citations=[
                _LiCitationOut(ordinal=1, claim_index=0, role="supports"),
                _LiCitationOut(ordinal=2, claim_index=2, role="context"),
            ],
        )
        grounded = _map_li_citations(synthesis, candidates)
        assert grounded == [
            _GroundedCitation(
                ordinal=1,
                role="supports",
                media_id=candidates[0].media_id,
                evidence_span_id=candidates[0].evidence_span_id,
            ),
            _GroundedCitation(
                ordinal=2,
                role="context",
                media_id=candidates[2].media_id,
                evidence_span_id=candidates[2].evidence_span_id,
            ),
        ]

    def test_out_of_range_claim_index_dropped(self) -> None:
        candidates = self._candidates(2)
        synthesis = _LiSynthesis(
            content_md="x",
            citations=[
                _LiCitationOut(ordinal=1, claim_index=0, role="supports"),
                _LiCitationOut(ordinal=2, claim_index=99, role="supports"),
                _LiCitationOut(ordinal=3, claim_index=-1, role="supports"),
            ],
        )
        grounded = _map_li_citations(synthesis, candidates)
        assert [g.ordinal for g in grounded] == [1]
        assert grounded[0].evidence_span_id == candidates[0].evidence_span_id

    def test_duplicate_ordinal_keeps_first(self) -> None:
        candidates = self._candidates(2)
        synthesis = _LiSynthesis(
            content_md="x",
            citations=[
                _LiCitationOut(ordinal=1, claim_index=0, role="supports"),
                _LiCitationOut(ordinal=1, claim_index=1, role="supports"),
            ],
        )
        grounded = _map_li_citations(synthesis, candidates)
        assert len(grounded) == 1
        assert grounded[0].evidence_span_id == candidates[0].evidence_span_id

    def test_unknown_role_falls_back_to_context(self) -> None:
        candidates = self._candidates(1)
        synthesis = _LiSynthesis(
            content_md="x",
            citations=[_LiCitationOut(ordinal=1, claim_index=0, role="nonsense")],
        )
        grounded = _map_li_citations(synthesis, candidates)
        assert grounded[0].role == "context"


@pytest.mark.unit
class TestRunKitExhaustiveness:
    def test_all_run_kinds_have_channel_and_terminal_set(self) -> None:
        for kind in run_kit.RunStreamKind:
            assert run_kit.notify_channel(kind)
            assert run_kit.terminal_statuses(kind)

    def test_library_intelligence_terminal_set(self) -> None:
        assert run_kit.terminal_statuses(run_kit.RunStreamKind.LibraryIntelligence) == frozenset(
            {"ready", "failed"}
        )

    def test_li_channel(self) -> None:
        assert (
            run_kit.notify_channel(run_kit.RunStreamKind.LibraryIntelligence)
            == "library_intelligence_revision_events"
        )


@pytest.mark.unit
class TestSchemaStrictness:
    def test_synthesis_rejects_extra_keys(self) -> None:
        with pytest.raises(ValidationError):
            _LiSynthesis.model_validate({"content_md": "x", "citations": [], "junk": 1})

    def test_reduce_budget_constant(self) -> None:
        assert LI_REDUCE_INPUT_CHAR_BUDGET > 0


# =============================================================================
# Integration tests (real DB, fake LLM at the boundary)
# =============================================================================


@pytest.fixture(autouse=True)
def anthropic_platform_key(monkeypatch):
    """resolve_api_key needs a configured platform key for the pinned provider."""
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test-platform-anthropic")
    clear_settings_cache()
    yield
    clear_settings_cache()


class _RecordingRateLimiter:
    """Records the worker budget-envelope calls (the rate-limit boundary fake)."""

    def __init__(self) -> None:
        self.events: list[tuple[str, UUID, UUID | None, int | None]] = []

    def acquire_inflight_slot(self, user_id: UUID) -> None:
        self.events.append(("acquire_inflight_slot", user_id, None, None))

    def release_inflight_slot(self, user_id: UUID) -> None:
        self.events.append(("release_inflight_slot", user_id, None, None))

    def reserve_token_budget(
        self, user_id: UUID, reservation_id: UUID, est_tokens: int, ttl: int = 300
    ) -> None:
        self.events.append(("reserve_token_budget", user_id, reservation_id, est_tokens))

    def commit_token_budget(self, user_id: UUID, reservation_id: UUID, actual_tokens: int) -> None:
        self.events.append(("commit_token_budget", user_id, reservation_id, actual_tokens))

    def release_token_budget(self, user_id: UUID, reservation_id: UUID) -> None:
        self.events.append(("release_token_budget", user_id, reservation_id, None))

    def event_names(self) -> list[str]:
        return [event[0] for event in self.events]


@pytest.fixture(autouse=True)
def li_rate_limiter(monkeypatch) -> _RecordingRateLimiter:
    # One recording limiter for both the reduce and the inline unit builds.
    limiter = _RecordingRateLimiter()
    monkeypatch.setattr(
        "nexus.services.library_intelligence_reduce.get_rate_limiter", lambda: limiter
    )
    monkeypatch.setattr("nexus.services.media_intelligence.get_rate_limiter", lambda: limiter)
    return limiter


def _create_owner(db: Session) -> UUID:
    """A bootstrapped user entitled to the platform key (resolve_api_key auto)."""
    owner_id = create_test_user_id()
    ensure_user_and_default_library(db, owner_id)
    grant_entitlement_override(
        db,
        user_id=owner_id,
        plan_tier="ai_plus",
        platform_token_quota_mode="plan",
        platform_token_limit_monthly=None,
        transcription_quota_mode="plan",
        transcription_minutes_limit_monthly=None,
        expires_at=None,
        reason="library intelligence test platform access",
        actor_label="test",
    )
    return owner_id


def _li_call_rows(db: Session, *, revision_id: UUID) -> list[LLMCall]:
    return list(
        db.scalars(
            select(LLMCall)
            .where(LLMCall.owner_kind == "li_revision", LLMCall.owner_id == revision_id)
            .order_by(LLMCall.call_seq)
        )
    )


def _done_payload(db: Session, *, revision_id: UUID) -> dict:
    return db.execute(
        text(
            "SELECT payload FROM library_intelligence_revision_events "
            "WHERE revision_id = :r AND event_type = 'done'"
        ),
        {"r": revision_id},
    ).scalar_one()


class _ReduceRouter:
    """Fake LLMRouter returning a fixed reduce synthesis."""

    def __init__(self, *, content_md: str, citations: list[tuple[int, int, str]]) -> None:
        self._payload = {
            "content_md": content_md,
            "citations": [
                {"ordinal": ordinal, "claim_index": claim_index, "role": role}
                for ordinal, claim_index, role in citations
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


class _BadRouter:
    async def generate(self, _provider, _request, _api_key, *, timeout_s):
        return LLMResponse(
            text="not json",
            usage=None,
            provider_request_id=None,
            status=None,
            incomplete_details=None,
        )


class _RepairingReduceRouter:
    """First reduce call returns malformed output; the one repair round succeeds."""

    def __init__(self, *, content_md: str, citations: list[tuple[int, int, str]]) -> None:
        self._payload = {
            "content_md": content_md,
            "citations": [
                {"ordinal": ordinal, "claim_index": claim_index, "role": role}
                for ordinal, claim_index, role in citations
            ],
        }
        self.calls = 0

    async def generate(self, _provider, _request, _api_key, *, timeout_s):
        self.calls += 1
        text_out = "not json" if self.calls == 1 else json.dumps(self._payload)
        return LLMResponse(
            text=text_out,
            usage=None,
            provider_request_id=None,
            status=None,
            incomplete_details=None,
        )


def _ready_unit_media(db: Session, user_id: UUID, library_id: UUID, *, title: str) -> UUID:
    """Create a library media whose per-media unit is built and ready with a claim."""
    media_id = create_searchable_media_in_library(db, user_id, library_id, title=title)
    from nexus.services.media_intelligence import ensure_media_unit, run_media_unit_build

    ensure_media_unit(db, media_id=media_id)
    unit_router = _UnitRouter(summary_md=f"Abstract of {title}.", claims=[("Key claim.", 0)])
    asyncio.run(run_media_unit_build(db, media_id=media_id, llm=unit_router))
    db.expire_all()
    return media_id


class _UnitRouter:
    def __init__(self, *, summary_md: str, claims: list[tuple[str, int]]) -> None:
        self._payload = {
            "summary_md": summary_md,
            "claims": [
                {"claim_text": claim_text, "candidate_index": idx} for claim_text, idx in claims
            ],
        }

    async def generate(self, _provider, _request, _api_key, *, timeout_s):
        return LLMResponse(
            text=json.dumps(self._payload),
            usage=None,
            provider_request_id=None,
            status=None,
            incomplete_details=None,
        )


class _UnitThenReduceRouter:
    """Serves the media-unit-build call and the reduce call from one fake router.

    Dispatches on the user-turn marker each prompt emits ("CANDIDATES:" for the
    per-media unit build, "UNIT CLAIMS:" for the library reduce) so a single router
    can drive a first-generate that builds units inline before reducing.
    """

    def __init__(
        self,
        *,
        summary_md: str,
        unit_claims: list[tuple[str, int]],
        content_md: str,
        reduce_citations: list[tuple[int, int, str]],
    ) -> None:
        self._unit_payload = {
            "summary_md": summary_md,
            "claims": [
                {"claim_text": claim_text, "candidate_index": idx}
                for claim_text, idx in unit_claims
            ],
        }
        self._reduce_payload = {
            "content_md": content_md,
            "citations": [
                {"ordinal": ordinal, "claim_index": claim_index, "role": role}
                for ordinal, claim_index, role in reduce_citations
            ],
        }

    async def generate(self, _provider, request, _api_key, *, timeout_s):
        user_text = "".join(turn.content for turn in request.messages if turn.role == "user")
        payload = self._reduce_payload if "UNIT CLAIMS:" in user_text else self._unit_payload
        return LLMResponse(
            text=json.dumps(payload),
            usage=None,
            provider_request_id=None,
            status=None,
            incomplete_details=None,
        )


def _add_contentless_media(db: Session, user_id: UUID, library_id: UUID, *, title: str) -> UUID:
    """A library media with no content chunks (so no unit can ever be built)."""
    from nexus.db.models import Media, MediaKind, ProcessingStatus

    media = Media(
        id=uuid4(),
        kind=MediaKind.web_article.value,
        title=title,
        processing_status=ProcessingStatus.ready_for_reading,
        created_by_user_id=user_id,
    )
    db.add(media)
    db.flush()
    add_media_to_library(db, library_id, media.id)
    return media.id


def _make_episode_media(db: Session, user_id: UUID, podcast_id: UUID, *, title: str) -> UUID:
    """A podcast-episode media with content + a ready unit (no direct library entry)."""
    from nexus.db.models import Media, MediaKind, PodcastEpisode, ProcessingStatus
    from nexus.services.content_indexing import rebuild_transcript_content_index
    from nexus.services.media_intelligence import ensure_media_unit, run_media_unit_build
    from nexus.services.transcript_segments import TranscriptSegmentInput

    media = Media(
        id=uuid4(),
        kind=MediaKind.podcast_episode.value,
        title=title,
        processing_status=ProcessingStatus.ready_for_reading,
        created_by_user_id=user_id,
    )
    db.add(media)
    db.flush()
    # Podcast episodes are transcript-sourced: index real transcript segments so the
    # evidence spans carry valid transcript_time_text locators (the fragment-block
    # path produces block locators, which are invalid for transcript source).
    rebuild_transcript_content_index(
        db,
        media_id=media.id,
        transcript_segments=[
            TranscriptSegmentInput(
                segment_idx=0,
                t_start_ms=0,
                t_end_ms=8000,
                canonical_text=(
                    f"Transcript for {title}. It discusses several distinct topics in depth, "
                    "including the central argument and the evidence that supports it."
                ),
                speaker_label=None,
            )
        ],
        reason="test_episode",
    )
    db.add(
        PodcastEpisode(
            media_id=media.id,
            podcast_id=podcast_id,
            provider_episode_id=f"ep-{media.id}",
            fallback_identity=f"fallback-{media.id}",
        )
    )
    db.commit()
    ensure_media_unit(db, media_id=media.id)
    asyncio.run(
        run_media_unit_build(
            db,
            media_id=media.id,
            llm=_UnitRouter(summary_md=f"Abstract of {title}.", claims=[("Key claim.", 0)]),
        )
    )
    db.expire_all()
    return media.id


def _add_podcast_to_library(db: Session, library_id: UUID, *, title: str) -> UUID:
    """Create a podcast linked to the library via a podcast library_entry."""
    from nexus.db.models import Podcast

    podcast = Podcast(
        id=uuid4(),
        provider="test",
        provider_podcast_id=f"prov-{uuid4()}",
        title=title,
        feed_url=f"https://feeds.example.com/{uuid4()}.xml",
    )
    db.add(podcast)
    db.flush()
    next_position = int(
        db.execute(
            text(
                "SELECT COALESCE(MAX(position) + 1, 0) FROM library_entries WHERE library_id = :l"
            ),
            {"l": library_id},
        ).scalar_one()
    )
    db.execute(
        text(
            "INSERT INTO library_entries (id, library_id, position, podcast_id) "
            "VALUES (:id, :library_id, :position, :podcast_id)"
        ),
        {
            "id": uuid4(),
            "library_id": library_id,
            "position": next_position,
            "podcast_id": podcast.id,
        },
    )
    db.commit()
    return podcast.id


def _drive_generation(db: Session, *, owner_id: UUID, library_id: UUID, token: str, router) -> UUID:
    ref = generate_artifact(db, viewer_id=owner_id, library_id=library_id, idempotency_key=token)
    asyncio.run(run_artifact_generation(db, revision_id=ref.revision_id, llm=router))
    db.expire_all()
    return ref.revision_id


@pytest.mark.integration
class TestGenerateReduce:
    def test_generate_over_seeded_library_produces_grounded_citation(
        self, db_session: Session
    ) -> None:
        owner_id = _create_owner(db_session)
        library_id = create_test_library(db_session, owner_id, "Reduce Library")
        _ready_unit_media(db_session, owner_id, library_id, title="Source One")
        _ready_unit_media(db_session, owner_id, library_id, title="Source Two")

        router = _ReduceRouter(
            content_md="An overview [1] across sources [2].",
            citations=[(1, 0, "supports"), (2, 1, "context")],
        )
        revision_id = _drive_generation(
            db_session, owner_id=owner_id, library_id=library_id, token="t1", router=router
        )

        view = get_artifact(db_session, viewer_id=owner_id, library_id=library_id)
        assert view.status == "current"
        assert view.revision_id == revision_id
        assert "overview" in view.content_md

        citations = (
            db_session.execute(
                text(
                    "SELECT ordinal, role, target_type, target_id, locator, snapshot "
                    "FROM library_intelligence_citations WHERE revision_id = :r ORDER BY ordinal"
                ),
                {"r": revision_id},
            )
            .mappings()
            .all()
        )
        assert len(citations) == 2
        for row in citations:
            assert row["target_type"] == "evidence_span"
            assert row["locator"] is not None
            assert row["snapshot"]["deep_link"].startswith("/media/")
            assert "#evidence-" in row["snapshot"]["deep_link"]
            span_exists = db_session.execute(
                text("SELECT 1 FROM evidence_spans WHERE id = :sid"),
                {"sid": row["target_id"]},
            ).scalar_one_or_none()
            assert span_exists == 1

        # The shared read-model resolves and carries the deep link.
        from nexus.services.retrieval_citation import build_citation_outs_for_revision

        outs = build_citation_outs_for_revision(db_session, revision_id=revision_id)
        assert len(outs) == 2
        assert all(out.deep_link and out.locator is not None for out in outs)

        # Normalized terminal grammar + AC-3 ledger row for the one reduce call.
        assert _done_payload(db_session, revision_id=revision_id) == {
            "status": "ready",
            "error_code": None,
            "revision_id": str(revision_id),
        }
        rows = _li_call_rows(db_session, revision_id=revision_id)
        assert [(row.call_seq, row.llm_operation) for row in rows] == [(1, "li_reduce")], (
            f"expected one li_reduce row, got {[(r.call_seq, r.llm_operation) for r in rows]}"
        )

    def test_reduce_repair_round_ledgers_two_li_revision_calls(self, db_session: Session) -> None:
        owner_id = _create_owner(db_session)
        library_id = create_test_library(db_session, owner_id, "Repair Library")
        _ready_unit_media(db_session, owner_id, library_id, title="Source")

        router = _RepairingReduceRouter(content_md="Overview [1].", citations=[(1, 0, "supports")])
        revision_id = _drive_generation(
            db_session, owner_id=owner_id, library_id=library_id, token="t1", router=router
        )

        view = get_artifact(db_session, viewer_id=owner_id, library_id=library_id)
        assert view.status == "current", "the repaired synthesis must still promote"
        assert view.revision_id == revision_id
        rows = _li_call_rows(db_session, revision_id=revision_id)
        assert [row.call_seq for row in rows] == [1, 2], (
            f"a repaired reduce must ledger both attempts, got "
            f"{[(r.call_seq, r.error_class) for r in rows]}"
        )
        assert all(row.llm_operation == "li_reduce" for row in rows)

    def test_reduce_runs_inside_the_budget_envelope(
        self, db_session: Session, li_rate_limiter: _RecordingRateLimiter
    ) -> None:
        owner_id = _create_owner(db_session)
        library_id = create_test_library(db_session, owner_id, "Envelope Library")
        _ready_unit_media(db_session, owner_id, library_id, title="Source")
        li_rate_limiter.events.clear()  # drop the pre-built unit's envelope events

        router = _ReduceRouter(content_md="[1]", citations=[(1, 0, "supports")])
        revision_id = _drive_generation(
            db_session, owner_id=owner_id, library_id=library_id, token="t1", router=router
        )

        assert li_rate_limiter.event_names() == [
            "acquire_inflight_slot",
            "reserve_token_budget",
            "commit_token_budget",
            "release_inflight_slot",
        ], f"unexpected envelope: {li_rate_limiter.events}"
        reserve = li_rate_limiter.events[1]
        assert reserve[1] == owner_id, "the envelope is keyed on the artifact owner"
        assert reserve[2] == revision_id, "reservation must be keyed on the revision (the run)"
        assert reserve[3] is not None and reserve[3] > 4000, (
            "estimate must cover the rendered prompt plus max output tokens"
        )

    def test_no_buildable_units_fails_revision(self, db_session: Session) -> None:
        owner_id = _create_owner(db_session)
        library_id = create_test_library(db_session, owner_id, "Empty Reduce")
        # A library media with NO extractable content: the inline unit build finds
        # no candidates and fails the unit, so the reduce sees zero ready units.
        _add_contentless_media(db_session, owner_id, library_id, title="Unbuilt")
        db_session.commit()

        router = _ReduceRouter(content_md="x", citations=[])
        revision_id = _drive_generation(
            db_session, owner_id=owner_id, library_id=library_id, token="t1", router=router
        )
        assert router.calls == 0  # the reduce never ran (no ready units)
        revision = db_session.execute(
            text(
                "SELECT status, error_code, error_detail "
                "FROM library_intelligence_artifact_revisions WHERE id = :r"
            ),
            {"r": revision_id},
        ).one()
        assert revision.status == "failed"
        assert revision.error_code == "no_ready_units"
        assert revision.error_detail
        assert _done_payload(db_session, revision_id=revision_id) == {
            "status": "failed",
            "error_code": "no_ready_units",
            "revision_id": str(revision_id),
        }
        view = get_artifact(db_session, viewer_id=owner_id, library_id=library_id)
        assert view.status == "failed"

    def test_first_generate_builds_units_inline_and_succeeds(self, db_session: Session) -> None:
        # A fresh library whose per-media units were NOT pre-built: generation must
        # build them inline (fix for the first-generate race) and still produce a
        # grounded revision.
        owner_id = _create_owner(db_session)
        library_id = create_test_library(db_session, owner_id, "Fresh Inline")
        create_searchable_media_in_library(db_session, owner_id, library_id, title="Not Pre-Built")
        db_session.commit()

        router = _UnitThenReduceRouter(
            summary_md="Abstract.",
            unit_claims=[("Key claim.", 0)],
            content_md="Overview [1].",
            reduce_citations=[(1, 0, "supports")],
        )
        revision_id = _drive_generation(
            db_session, owner_id=owner_id, library_id=library_id, token="t1", router=router
        )

        view = get_artifact(db_session, viewer_id=owner_id, library_id=library_id)
        assert view.status == "current"
        assert view.revision_id == revision_id
        count = db_session.execute(
            text("SELECT COUNT(*) FROM library_intelligence_citations WHERE revision_id = :r"),
            {"r": revision_id},
        ).scalar_one()
        assert count == 1, "the inline-built unit's claim must ground a citation"

    def test_out_of_range_citation_dropped_end_to_end(self, db_session: Session) -> None:
        owner_id = _create_owner(db_session)
        library_id = create_test_library(db_session, owner_id, "Drop Library")
        _ready_unit_media(db_session, owner_id, library_id, title="Only Source")

        router = _ReduceRouter(
            content_md="[1] keep [2] drop",
            citations=[(1, 0, "supports"), (2, 50, "supports")],
        )
        revision_id = _drive_generation(
            db_session, owner_id=owner_id, library_id=library_id, token="t1", router=router
        )
        count = db_session.execute(
            text("SELECT COUNT(*) FROM library_intelligence_citations WHERE revision_id = :r"),
            {"r": revision_id},
        ).scalar_one()
        assert count == 1


@pytest.mark.integration
class TestStaleness:
    def test_reingest_flips_stale(self, db_session: Session) -> None:
        owner_id = _create_owner(db_session)
        library_id = create_test_library(db_session, owner_id, "Stale Library")
        media_id = _ready_unit_media(db_session, owner_id, library_id, title="Mutable Source")

        router = _ReduceRouter(content_md="[1]", citations=[(1, 0, "supports")])
        _drive_generation(
            db_session, owner_id=owner_id, library_id=library_id, token="t1", router=router
        )
        assert (
            get_artifact(db_session, viewer_id=owner_id, library_id=library_id).status == "current"
        )

        # Re-ingest the source: new fingerprint via the content-index rebuild.
        from nexus.db.models import Fragment
        from nexus.services.content_indexing import rebuild_fragment_content_index

        fragment = db_session.query(Fragment).filter(Fragment.media_id == media_id).first()
        assert fragment is not None
        fragment.canonical_text = "Totally different content for the re-ingest path here."
        db_session.flush()
        rebuild_fragment_content_index(
            db_session,
            media_id=media_id,
            source_kind="web_article",
            fragments=[fragment],
            reason="test_reingest",
        )
        db_session.commit()
        db_session.expire_all()

        assert get_artifact(db_session, viewer_id=owner_id, library_id=library_id).status == "stale"

    def test_new_member_media_flips_stale(self, db_session: Session) -> None:
        owner_id = _create_owner(db_session)
        library_id = create_test_library(db_session, owner_id, "Membership Library")
        _ready_unit_media(db_session, owner_id, library_id, title="First")

        router = _ReduceRouter(content_md="[1]", citations=[(1, 0, "supports")])
        _drive_generation(
            db_session, owner_id=owner_id, library_id=library_id, token="t1", router=router
        )
        assert (
            get_artifact(db_session, viewer_id=owner_id, library_id=library_id).status == "current"
        )

        create_searchable_media_in_library(db_session, owner_id, library_id, title="Added Later")
        db_session.commit()
        db_session.expire_all()
        assert get_artifact(db_session, viewer_id=owner_id, library_id=library_id).status == "stale"

    def test_stale_source_count_is_none_when_current(self, db_session: Session) -> None:
        owner_id = _create_owner(db_session)
        library_id = create_test_library(db_session, owner_id, "Fresh Count Library")
        _ready_unit_media(db_session, owner_id, library_id, title="Only Source")

        router = _ReduceRouter(content_md="[1]", citations=[(1, 0, "supports")])
        _drive_generation(
            db_session, owner_id=owner_id, library_id=library_id, token="t1", router=router
        )

        view = get_artifact(db_session, viewer_id=owner_id, library_id=library_id)
        assert view.status == "current"
        assert view.stale_source_count is None, (
            f"A current artifact must not report a stale count; got {view.stale_source_count}"
        )

    def test_stale_source_count_counts_added_media(self, db_session: Session) -> None:
        owner_id = _create_owner(db_session)
        library_id = create_test_library(db_session, owner_id, "Added Count Library")
        _ready_unit_media(db_session, owner_id, library_id, title="First")

        router = _ReduceRouter(content_md="[1]", citations=[(1, 0, "supports")])
        _drive_generation(
            db_session, owner_id=owner_id, library_id=library_id, token="t1", router=router
        )

        # Two more sources join the library after the revision was built.
        create_searchable_media_in_library(db_session, owner_id, library_id, title="Added One")
        create_searchable_media_in_library(db_session, owner_id, library_id, title="Added Two")
        db_session.commit()
        db_session.expire_all()

        view = get_artifact(db_session, viewer_id=owner_id, library_id=library_id)
        assert view.status == "stale"
        assert view.stale_source_count == 2, (
            f"Two added sources should count as 2 changed; got {view.stale_source_count}"
        )

    def test_stale_source_count_counts_reingested_media(self, db_session: Session) -> None:
        owner_id = _create_owner(db_session)
        library_id = create_test_library(db_session, owner_id, "Reingest Count Library")
        media_id = _ready_unit_media(db_session, owner_id, library_id, title="Mutable")
        _ready_unit_media(db_session, owner_id, library_id, title="Stable")

        router = _ReduceRouter(content_md="[1]", citations=[(1, 0, "supports")])
        _drive_generation(
            db_session, owner_id=owner_id, library_id=library_id, token="t1", router=router
        )
        assert (
            get_artifact(db_session, viewer_id=owner_id, library_id=library_id).status == "current"
        )

        from nexus.db.models import Fragment
        from nexus.services.content_indexing import rebuild_fragment_content_index

        fragment = db_session.query(Fragment).filter(Fragment.media_id == media_id).first()
        assert fragment is not None
        fragment.canonical_text = "Re-ingested body changing only one source fingerprint."
        db_session.flush()
        rebuild_fragment_content_index(
            db_session,
            media_id=media_id,
            source_kind="web_article",
            fragments=[fragment],
            reason="test_reingest_count",
        )
        db_session.commit()
        db_session.expire_all()

        view = get_artifact(db_session, viewer_id=owner_id, library_id=library_id)
        assert view.status == "stale"
        assert view.stale_source_count == 1, (
            f"Only one re-ingested source should count as 1; got {view.stale_source_count}"
        )


@pytest.mark.integration
class TestPodcastExpansion:
    def test_podcast_episode_media_is_covered_and_new_episode_flips_stale(
        self, db_session: Session
    ) -> None:
        # AC-7: a podcast entry expands to its episode media; the episode is covered
        # by kind "media", and adding a 2nd episode flips the artifact stale.
        owner_id = _create_owner(db_session)
        library_id = create_test_library(db_session, owner_id, "Podcast Library")
        podcast_id = _add_podcast_to_library(db_session, library_id, title="A Show")
        episode_media_id = _make_episode_media(
            db_session, owner_id, podcast_id, title="Episode One"
        )

        router = _ReduceRouter(content_md="Overview [1].", citations=[(1, 0, "supports")])
        revision_id = _drive_generation(
            db_session, owner_id=owner_id, library_id=library_id, token="t1", router=router
        )

        view = get_artifact(db_session, viewer_id=owner_id, library_id=library_id)
        assert view.status == "current"
        covered = db_session.execute(
            text(
                "SELECT covered_targets FROM library_intelligence_artifact_revisions WHERE id = :r"
            ),
            {"r": revision_id},
        ).scalar_one()
        covered_media_ids = {rec["id"] for rec in covered if rec.get("kind") == "media"}
        assert str(episode_media_id) in covered_media_ids

        # A second episode joins the podcast after the revision was built.
        _make_episode_media(db_session, owner_id, podcast_id, title="Episode Two")
        db_session.expire_all()

        view = get_artifact(db_session, viewer_id=owner_id, library_id=library_id)
        assert view.status == "stale"
        assert view.stale_source_count == 1, (
            f"One added episode should count as 1; got {view.stale_source_count}"
        )


@pytest.mark.integration
class TestRevisionsAndPromote:
    def test_regenerate_keeps_current_visible_then_promotes(self, db_session: Session) -> None:
        owner_id = _create_owner(db_session)
        library_id = create_test_library(db_session, owner_id, "Regen Library")
        _ready_unit_media(db_session, owner_id, library_id, title="Source")

        router1 = _ReduceRouter(content_md="First synthesis [1]", citations=[(1, 0, "supports")])
        first_rev = _drive_generation(
            db_session, owner_id=owner_id, library_id=library_id, token="t1", router=router1
        )

        # Regenerate: a new draft exists while the current revision stays shown.
        ref2 = generate_artifact(
            db_session, viewer_id=owner_id, library_id=library_id, idempotency_key="t2"
        )
        view = get_artifact(db_session, viewer_id=owner_id, library_id=library_id)
        assert view.revision_id == first_rev
        assert "First synthesis" in view.content_md
        assert view.build is not None and view.build.revision_id == ref2.revision_id

        router2 = _ReduceRouter(content_md="Second synthesis [1]", citations=[(1, 0, "supports")])
        asyncio.run(run_artifact_generation(db_session, revision_id=ref2.revision_id, llm=router2))
        db_session.expire_all()

        view = get_artifact(db_session, viewer_id=owner_id, library_id=library_id)
        assert view.revision_id == ref2.revision_id
        assert "Second synthesis" in view.content_md
        # The prior revision is retained.
        prior = (
            db_session.execute(
                text(
                    "SELECT status, promoted_at FROM library_intelligence_artifact_revisions WHERE id = :r"
                ),
                {"r": first_rev},
            )
            .mappings()
            .one()
        )
        assert prior["status"] == "ready"
        assert prior["promoted_at"] is not None

    def test_promote_restores_prior_revision(self, db_session: Session) -> None:
        owner_id = _create_owner(db_session)
        library_id = create_test_library(db_session, owner_id, "Restore Library")
        _ready_unit_media(db_session, owner_id, library_id, title="Source")

        router1 = _ReduceRouter(content_md="One [1]", citations=[(1, 0, "supports")])
        first_rev = _drive_generation(
            db_session, owner_id=owner_id, library_id=library_id, token="t1", router=router1
        )
        router2 = _ReduceRouter(content_md="Two [1]", citations=[(1, 0, "supports")])
        second_rev = _drive_generation(
            db_session, owner_id=owner_id, library_id=library_id, token="t2", router=router2
        )
        assert (
            get_artifact(db_session, viewer_id=owner_id, library_id=library_id).revision_id
            == second_rev
        )

        promote_revision(db_session, viewer_id=owner_id, revision_id=first_rev)
        db_session.expire_all()
        assert (
            get_artifact(db_session, viewer_id=owner_id, library_id=library_id).revision_id
            == first_rev
        )
        # Both revisions retained.
        summaries = list_revisions(db_session, viewer_id=owner_id, library_id=library_id)
        assert {s.revision_id for s in summaries} == {first_rev, second_rev}

    def test_idempotency_key_dedupes(self, db_session: Session) -> None:
        owner_id = _create_owner(db_session)
        library_id = create_test_library(db_session, owner_id, "Token Library")
        first = generate_artifact(
            db_session, viewer_id=owner_id, library_id=library_id, idempotency_key="same"
        )
        second = generate_artifact(
            db_session, viewer_id=owner_id, library_id=library_id, idempotency_key="same"
        )
        assert second.revision_id == first.revision_id
        job_count = db_session.execute(
            text(
                "SELECT COUNT(*) FROM background_jobs "
                "WHERE kind = 'library_intelligence_artifact_generate' "
                "AND payload->>'revision_id' = :rid"
            ),
            {"rid": str(first.revision_id)},
        ).scalar_one()
        assert job_count == 1
        # A different idempotency key forks a fresh draft.
        third = generate_artifact(
            db_session, viewer_id=owner_id, library_id=library_id, idempotency_key="other"
        )
        assert third.revision_id != first.revision_id


@pytest.mark.integration
class TestWorkerBoundary:
    def test_llm_failure_marks_revision_failed_with_error_floor(self, db_session: Session) -> None:
        owner_id = _create_owner(db_session)
        library_id = create_test_library(db_session, owner_id, "Fail Library")
        _ready_unit_media(db_session, owner_id, library_id, title="Source")
        ref = generate_artifact(
            db_session, viewer_id=owner_id, library_id=library_id, idempotency_key="t1"
        )
        asyncio.run(
            run_artifact_generation(db_session, revision_id=ref.revision_id, llm=_BadRouter())
        )
        db_session.expire_all()
        revision = db_session.execute(
            text(
                "SELECT status, error_code, error_detail "
                "FROM library_intelligence_artifact_revisions WHERE id = :r"
            ),
            {"r": ref.revision_id},
        ).one()
        assert revision.status == "failed"
        assert revision.error_code == "E_LLM_BAD_REQUEST", f"got {revision.error_code!r}"
        assert revision.error_detail, "error_detail must carry the operator-facing reason"
        assert _done_payload(db_session, revision_id=ref.revision_id) == {
            "status": "failed",
            "error_code": "E_LLM_BAD_REQUEST",
            "revision_id": str(ref.revision_id),
        }
        # AC-3: the failed synthesis still ledgers both attempts (one repair round).
        rows = _li_call_rows(db_session, revision_id=ref.revision_id)
        assert [row.call_seq for row in rows] == [1, 2], (
            f"expected attempt + repair rows, got {[(r.call_seq, r.error_class) for r in rows]}"
        )

    def test_worker_exception_boundary_is_terminal_with_error_floor(
        self, db_session: Session
    ) -> None:
        owner_id = _create_owner(db_session)
        library_id = create_test_library(db_session, owner_id, "Crash Library")
        ref = generate_artifact(
            db_session, viewer_id=owner_id, library_id=library_id, idempotency_key="t1"
        )
        _fail_revision_after_worker_exception(
            db_session, RuntimeError("worker exploded"), revision_id=ref.revision_id
        )
        db_session.expire_all()
        revision = db_session.execute(
            text(
                "SELECT status, error_code, error_detail "
                "FROM library_intelligence_artifact_revisions WHERE id = :r"
            ),
            {"r": ref.revision_id},
        ).one()
        assert revision.status == "failed"
        assert revision.error_code == "E_INTERNAL"
        assert revision.error_detail == "RuntimeError: worker exploded"
        assert _done_payload(db_session, revision_id=ref.revision_id) == {
            "status": "failed",
            "error_code": "E_INTERNAL",
            "revision_id": str(ref.revision_id),
        }

    def test_worker_exception_boundary_noop_when_already_terminal(
        self, db_session: Session
    ) -> None:
        owner_id = _create_owner(db_session)
        library_id = create_test_library(db_session, owner_id, "Late Crash Library")
        _ready_unit_media(db_session, owner_id, library_id, title="Source")
        router = _ReduceRouter(content_md="Kept [1]", citations=[(1, 0, "supports")])
        revision_id = _drive_generation(
            db_session, owner_id=owner_id, library_id=library_id, token="t1", router=router
        )

        _fail_revision_after_worker_exception(
            db_session, RuntimeError("late"), revision_id=revision_id
        )
        db_session.expire_all()
        revision = db_session.execute(
            text(
                "SELECT status, error_code "
                "FROM library_intelligence_artifact_revisions WHERE id = :r"
            ),
            {"r": revision_id},
        ).one()
        assert revision.status == "ready", "a terminal revision must not be re-failed"
        assert revision.error_code is None
