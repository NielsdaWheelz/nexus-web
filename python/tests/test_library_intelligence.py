"""Tests for the slim library-intelligence artifact owner (S4)."""

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
from provider_runtime.types import UserMessage
from pydantic import ValidationError
from sqlalchemy import select, text
from sqlalchemy.orm import Session

from nexus.config import clear_settings_cache
from nexus.db.models import LLMCall, ResourceEdge
from nexus.services import run_kit
from nexus.services.artifacts.dossier import (
    generate_artifact,
    get_artifact,
    promote_revision,
)
from nexus.services.artifacts.engine import run_revision as run_artifact_generation
from nexus.services.artifacts.reducers.library_dossier import (
    LI_REDUCE_INPUT_CHAR_BUDGET,
    _Candidate,
    _GroundedCitation,
    _LiCitationOut,
    _LiSynthesis,
    _map_li_citations,
)
from nexus.services.artifacts.revisions import get_revision, list_revisions
from nexus.services.billing_entitlements import grant_entitlement_override
from nexus.services.bootstrap import ensure_user_and_default_library
from nexus.services.llm_profiles import operation_profile
from nexus.services.media_intelligence import (
    MEDIA_UNIT_OPERATION,
    ensure_media_unit,
    run_media_unit_build,
)
from nexus.services.rate_limit import RateLimiter, get_rate_limiter, set_rate_limiter
from nexus.tasks.artifacts import _fail_revision_after_worker_exception
from tests.factories import (
    add_library_member,
    add_media_to_library,
    create_searchable_media_in_library,
    create_test_library,
    create_test_media,
    get_user_default_library,
)
from tests.helpers import create_test_user_id
from tests.utils.db import task_session_factory

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
        assert run_kit.terminal_statuses(run_kit.RunStreamKind.ArtifactRevision) == frozenset(
            {"ready", "failed"}
        )

    def test_li_channel(self) -> None:
        assert (
            run_kit.notify_channel(run_kit.RunStreamKind.ArtifactRevision)
            == "artifact_revision_events"
        )


@pytest.mark.unit
class TestSchemaStrictness:
    def test_synthesis_rejects_extra_keys(self) -> None:
        with pytest.raises(ValidationError):
            _LiSynthesis.model_validate({"content_md": "x", "citations": [], "junk": 1})

    def test_reduce_budget_constant(self) -> None:
        assert LI_REDUCE_INPUT_CHAR_BUDGET > 0


# =============================================================================
# Integration tests (real DB, fake ExecutionRuntime at the external boundary)
# =============================================================================

_LI_PROFILE = operation_profile("library_dossier")
_UNIT_PROFILE = operation_profile(MEDIA_UNIT_OPERATION)


@pytest.fixture(autouse=True)
def platform_key(monkeypatch):
    """generation_credential needs a configured platform key for the pinned
    provider. Both the library_dossier reduce ("balanced") and the inline
    media_summary unit build ("fast") profiles target openai (see
    llm_profiles.PROFILES) — the key must be OPENAI_API_KEY, not an
    anthropic key (see tests/test_media_intelligence.py's identical fixture)."""
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test-platform-openai")
    clear_settings_cache()
    yield
    clear_settings_cache()


class _RecordingRateLimiter:
    """Records the worker-level inflight-slot envelope that engine.py's li
    reduce and media_intelligence.py's inline unit builds acquire/release
    directly. Token-budget reserve/commit/release now happen inside
    execute_generation against the real global rate limiter (installed by
    the autouse `_rate_limiter` fixture below) — this fake no longer
    observes those calls. That's a genuine architecture change, not a test
    simplification (see tests/test_media_intelligence.py's identical split
    between `unit_rate_limiter` and its own real-limiter fixture)."""

    def __init__(self) -> None:
        self.events: list[str] = []

    def acquire_inflight_slot(self, user_id: UUID) -> None:
        self.events.append("acquire_inflight_slot")

    def release_inflight_slot(self, user_id: UUID) -> None:
        self.events.append("release_inflight_slot")


@pytest.fixture(autouse=True)
def li_rate_limiter(monkeypatch) -> _RecordingRateLimiter:
    # One recording limiter for both the reduce and the inline unit builds.
    limiter = _RecordingRateLimiter()
    monkeypatch.setattr("nexus.services.artifacts.engine.get_rate_limiter", lambda: limiter)
    monkeypatch.setattr("nexus.services.media_intelligence.get_rate_limiter", lambda: limiter)
    return limiter


@pytest.fixture(autouse=True)
def _rate_limiter(db_session):
    """Install a REAL RateLimiter as the global singleton so
    execute_generation's internal token-budget reserve/commit/release
    (nexus.services.rate_limit.get_rate_limiter, imported directly by
    llm_execution.py — a different reference than the one li_rate_limiter
    monkeypatches on the owner modules) runs for real against this test's DB."""
    previous = get_rate_limiter()
    set_rate_limiter(RateLimiter(session_factory=task_session_factory(db_session)))
    yield
    set_rate_limiter(previous)


@pytest.fixture(autouse=True)
def _owner_session_factory(monkeypatch, db_session):
    """Route each owner's internal ``get_session_factory()`` (the ledger session
    execute_generation opens for the entitlement check + llm_calls writes) onto
    this test's savepoint connection — same pattern as
    tests/test_media_intelligence.py's ``_media_intelligence_session_factory``.

    Without this, ``execute_generation`` opens a fresh connection from the real
    app engine that cannot see the user/entitlement rows this test wrote on
    ``db_session`` (uncommitted savepoint), so the entitlement check fails
    ``E_BILLING_REQUIRED`` and every unit build / reduce silently fails. Both
    owners are patched: ``media_intelligence`` for the inline (and
    ``_ready_unit_media``) unit builds, ``artifacts.engine`` for the reduce."""
    def factory():
        return task_session_factory(db_session)

    monkeypatch.setattr("nexus.services.media_intelligence.get_session_factory", factory)
    monkeypatch.setattr("nexus.services.artifacts.engine.get_session_factory", factory)


def _create_owner(db: Session) -> UUID:
    """A bootstrapped user entitled to the platform key (resolve_api_key auto).

    "unlimited" quota (matching tests/test_llm_execution.py's entitled_user_id
    and tests/test_media_intelligence.py's _grant_platform_llm) rather than
    the old "plan" quota mode: token-budget reservation is now real (see
    _rate_limiter above), not faked, so a real "plan" monthly limit could
    make the reservation itself flaky/denied independent of what a test means
    to exercise.
    """
    owner_id = create_test_user_id()
    ensure_user_and_default_library(db, owner_id)
    grant_entitlement_override(
        db,
        user_id=owner_id,
        plan_tier="ai_pro",
        platform_token_quota_mode="unlimited",
        platform_token_limit_monthly=None,
        transcription_quota_mode="unlimited",
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
            .where(LLMCall.owner_kind == "artifact_revision", LLMCall.owner_id == revision_id)
            .order_by(LLMCall.call_seq)
        )
    )


def _done_payload(db: Session, *, revision_id: UUID) -> dict:
    return db.execute(
        text(
            "SELECT payload FROM artifact_revision_events "
            "WHERE revision_id = :r AND event_type = 'done'"
        ),
        {"r": revision_id},
    ).scalar_one()


def _reservation_count(db: Session, generation_id: UUID) -> int:
    return db.execute(
        text("SELECT COUNT(*) FROM token_budget_reservations WHERE reservation_id = :id"),
        {"id": generation_id},
    ).scalar_one()


def _charge_amount(db: Session, generation_id: UUID) -> int | None:
    row = db.execute(
        text("SELECT charged_tokens FROM token_budget_charges WHERE reservation_id = :id"),
        {"id": generation_id},
    ).first()
    return None if row is None else int(row[0])


def _user_turn_text(intent) -> str:
    return "".join(
        block.text
        for message in intent.messages
        if isinstance(message, UserMessage)
        for block in message.blocks
    )


def _reduce_meta(**overrides: object) -> CallMeta:
    fields: dict[str, object] = {
        "provider": _LI_PROFILE.target.provider,
        "model": _LI_PROFILE.target.model,
        "provider_request_id": Present("req-li-reduce"),
        "upstream_provider": Absent(),
        "usage": Present(
            TokenUsage(
                input_tokens=400,
                output_tokens=120,
                total_tokens=520,
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


def _unit_meta(**overrides: object) -> CallMeta:
    fields: dict[str, object] = {
        "provider": _UNIT_PROFILE.target.provider,
        "model": _UNIT_PROFILE.target.model,
        "provider_request_id": Present("req-unit-build"),
        "upstream_provider": Absent(),
        "usage": Present(
            TokenUsage(
                input_tokens=200,
                output_tokens=60,
                total_tokens=260,
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


def _succeeded_reduce_outcome(
    *, content_md: str, citations: list[tuple[int, int, str]]
) -> Succeeded:
    """A Succeeded outcome carrying the reduce's StructuredContent payload —
    the fake-runtime analog of the old `_ReduceRouter`."""
    payload = {
        "content_md": content_md,
        "citations": [
            {"ordinal": ordinal, "claim_index": claim_index, "role": role}
            for ordinal, claim_index, role in citations
        ],
    }
    return Succeeded(
        meta=_reduce_meta(),
        response=ResponsePayload(
            content=StructuredContent(payload=payload, text=json.dumps(payload)),
            continuation=Absent(),
        ),
    )


def _succeeded_unit_outcome(*, summary_md: str, claims: list[tuple[str, int]]) -> Succeeded:
    """A Succeeded outcome carrying the unit build's StructuredContent payload —
    the fake-runtime analog of the old `_UnitRouter`."""
    payload = {
        "summary_md": summary_md,
        "claims": [{"claim_text": claim_text, "candidate_index": idx} for claim_text, idx in claims],
    }
    return Succeeded(
        meta=_unit_meta(),
        response=ResponsePayload(
            content=StructuredContent(payload=payload, text=json.dumps(payload)),
            continuation=Absent(),
        ),
    )


def _invalid_reduce_outcome() -> Succeeded:
    """A Succeeded outcome whose StructuredContent payload does not validate
    against `_LiSynthesis` (missing `citations`) — the fake-runtime analog of
    the old `_BadRouter`'s non-JSON text, now expressed as a decode failure
    rather than a parse failure since the model call itself succeeded and the
    runtime enforces strict JSON at the wire. There is no repair round
    anymore (see structured_synthesis.py's module docstring): a decode
    failure is terminal on the first attempt."""
    payload = {"not": "the expected shape"}
    return Succeeded(
        meta=_reduce_meta(),
        response=ResponsePayload(
            content=StructuredContent(payload=payload, text="not the expected shape"),
            continuation=Absent(),
        ),
    )


@dataclass
class _ScriptedRuntime:
    """A fake `ExecutionRuntime` scripting one fixed outcome for every
    `generate()` call — correct whenever every library media's unit is
    already pre-built (via `_ready_unit_media`/`_make_episode_media`), so
    `_collect` never triggers an inline unit build and the reduce call is the
    only dispatch. Copied in shape from tests/test_llm_execution.py's
    `_ScriptedRuntime` (stream() is unused: library intelligence never
    streams)."""

    outcome: object = None
    calls: list[str] = field(default_factory=list)
    user_messages: list[str] = field(default_factory=list)

    async def generate(self, intent, plan, credential) -> object:
        self.calls.append("generate")
        self.user_messages.append(_user_turn_text(intent))
        assert self.outcome is not None
        return self.outcome

    def stream(self, intent, plan, credential, *, cancel):  # pragma: no cover - unused
        raise NotImplementedError


@dataclass
class _DispatchingRuntime:
    """A fake `ExecutionRuntime` dispatching on the intent's user-turn marker
    ("CANDIDATES:" for a per-media unit build, "UNIT CLAIMS:" for the library
    reduce) — needed because `engine.run_revision` threads ONE runtime all the
    way through `reducer.collect`, which inline-builds any not-yet-ready
    media unit before the reduce call. The fake-runtime analog of the old
    `_UnitThenReduceRouter`."""

    unit_outcome: object
    reduce_outcome: object
    calls: list[str] = field(default_factory=list)

    async def generate(self, intent, plan, credential) -> object:
        if "UNIT CLAIMS:" in _user_turn_text(intent):
            self.calls.append("reduce")
            return self.reduce_outcome
        self.calls.append("unit")
        return self.unit_outcome

    def stream(self, intent, plan, credential, *, cancel):  # pragma: no cover - unused
        raise NotImplementedError


def _ready_unit_media(db: Session, user_id: UUID, library_id: UUID, *, title: str) -> UUID:
    """Create a library media whose per-media unit is built and ready with a claim."""
    media_id = create_searchable_media_in_library(db, user_id, library_id, title=title)
    ensure_media_unit(db, media_id=media_id)
    runtime = _ScriptedRuntime(
        outcome=_succeeded_unit_outcome(summary_md=f"Abstract of {title}.", claims=[("Key claim.", 0)])
    )
    asyncio.run(run_media_unit_build(db, media_id=media_id, runtime=runtime))
    db.expire_all()
    return media_id


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
    runtime = _ScriptedRuntime(
        outcome=_succeeded_unit_outcome(summary_md=f"Abstract of {title}.", claims=[("Key claim.", 0)])
    )
    asyncio.run(run_media_unit_build(db, media_id=media.id, runtime=runtime))
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


def _drive_generation(db: Session, *, owner_id: UUID, library_id: UUID, token: str, runtime) -> UUID:
    ref = generate_artifact(db, viewer_id=owner_id, library_id=library_id, idempotency_key=token)
    asyncio.run(run_artifact_generation(db, revision_id=ref.revision_id, runtime=runtime))
    db.expire_all()
    return ref.revision_id


def _citation_edges(db: Session, source_scheme: str, source_id: UUID) -> list[ResourceEdge]:
    return (
        db.query(ResourceEdge)
        .filter(
            ResourceEdge.source_scheme == source_scheme,
            ResourceEdge.source_id == source_id,
            ResourceEdge.origin == "citation",
        )
        .order_by(ResourceEdge.ordinal)
        .all()
    )


@pytest.mark.integration
class TestGenerateReduce:
    def test_generate_over_seeded_library_produces_grounded_citation(
        self, db_session: Session
    ) -> None:
        owner_id = _create_owner(db_session)
        library_id = create_test_library(db_session, owner_id, "Reduce Library")
        _ready_unit_media(db_session, owner_id, library_id, title="Source One")
        _ready_unit_media(db_session, owner_id, library_id, title="Source Two")

        runtime = _ScriptedRuntime(
            outcome=_succeeded_reduce_outcome(
                content_md="An overview [1] across sources [2].",
                citations=[(1, 0, "supports"), (2, 1, "context")],
            )
        )
        revision_id = _drive_generation(
            db_session, owner_id=owner_id, library_id=library_id, token="t1", runtime=runtime
        )

        view = get_artifact(db_session, viewer_id=owner_id, library_id=library_id)
        assert view.status == "current"
        assert view.revision_id == revision_id
        assert "overview" in view.content_md

        # The pane read-model is built from current-revision citation edges, roles
        # verbatim and ordinals dense 1..N.
        assert [(c.ordinal, c.role) for c in view.citations] == [(1, "supports"), (2, "context")], (
            f"expected the two grounded citations; got {view.citations}"
        )
        for out in view.citations:
            assert out.target_ref.type == "evidence_span"
            assert out.deep_link is not None
            assert out.deep_link.startswith("/media/") and "#evidence-" in out.deep_link
            # The edge stores no locator (position lives in the target grain,
            # D11), but CitationOut reconstructs the in-reader jump from the
            # media-owned span (§5.2/G6): chat, Oracle, and LI share one render
            # path, so a span citation carries a real (media_id, locator).
            assert out.media_id is not None and out.locator is not None
            assert out.snapshot is not None and out.snapshot.excerpt
            assert out.snapshot.result_type == "evidence_span"
            span_exists = db_session.execute(
                text("SELECT 1 FROM evidence_spans WHERE id = :sid"),
                {"sid": out.target_ref.id},
            ).scalar_one_or_none()
            assert span_exists == 1

        # The wire shape the pane consumes is unchanged.
        assert set(view.citations[0].model_dump().keys()) == {
            "ordinal",
            "role",
            "target_ref",
            "activation",
            "media_id",
            "locator",
            "deep_link",
            "snapshot",
        }

        # Storage contract: generated citation edges key on the revision, never the head.
        assert view.artifact_id is not None
        edges = _citation_edges(db_session, "artifact_revision", revision_id)
        assert [(e.ordinal, e.kind, e.origin) for e in edges] == [
            (1, "supports", "citation"),
            (2, "context", "citation"),
        ], f"expected two revision-sourced citation edges; got {edges}"
        assert _citation_edges(db_session, "artifact", view.artifact_id) == []

        # Normalized terminal grammar + AC-3 ledger row for the one reduce call.
        assert _done_payload(db_session, revision_id=revision_id) == {
            "status": "ready",
            "error_code": None,
            "revision_id": str(revision_id),
        }
        rows = _li_call_rows(db_session, revision_id=revision_id)
        assert [(row.call_seq, row.llm_operation) for row in rows] == [(1, "library_dossier")], (
            f"expected one library_dossier row, got {[(r.call_seq, r.llm_operation) for r in rows]}"
        )
        assert view.model_provider == _LI_PROFILE.target.provider
        assert view.model_name == _LI_PROFILE.target.model

    def test_budget_omissions_are_reported(self, db_session: Session, monkeypatch) -> None:
        owner_id = _create_owner(db_session)
        library_id = create_test_library(db_session, owner_id, "Budget Library")
        first_media_id = _ready_unit_media(db_session, owner_id, library_id, title="Included")
        second_media_id = _ready_unit_media(db_session, owner_id, library_id, title="Omitted")
        monkeypatch.setattr(
            "nexus.services.artifacts.reducers.library_dossier.LI_REDUCE_INPUT_CHAR_BUDGET",
            1,
        )

        runtime = _ScriptedRuntime(
            outcome=_succeeded_reduce_outcome(
                content_md="Included claim [1].", citations=[(1, 0, "supports")]
            )
        )
        revision_id = _drive_generation(
            db_session, owner_id=owner_id, library_id=library_id, token="t1", runtime=runtime
        )

        view = get_artifact(db_session, viewer_id=owner_id, library_id=library_id)
        assert view.status == "current"
        assert view.source_count == 2
        assert view.covered_source_count == 1
        assert view.omitted_source_count == 1
        revision = get_revision(
            db_session,
            viewer_id=owner_id,
            library_id=library_id,
            revision_id=revision_id,
        )
        assert revision.source_count == 2
        assert revision.covered_source_count == 1
        assert revision.omitted_source_count == 1
        assert (
            list_revisions(db_session, viewer_id=owner_id, library_id=library_id)[
                0
            ].omitted_source_count
            == 1
        )
        covered = db_session.execute(
            text("SELECT covered_targets FROM artifact_revisions WHERE id = :r"),
            {"r": revision_id},
        ).scalar_one()
        assert {record["id"]: record["coverage"] for record in covered} == {
            str(first_media_id): "included",
            str(second_media_id): "omitted_budget",
        }

    # NOTE: `test_reduce_repair_round_ledgers_two_li_revision_calls` deleted —
    # the repair-round mechanism it tested no longer exists.
    # structured_synthesis.py's module docstring is explicit: "There is no
    # repair round: the runtime enforces strict JSON at the provider boundary
    # (StrictJsonOutput), so a decode/schema/semantic-validate failure here is
    # terminal". `decode_structured_synthesis` raises once; the caller
    # (engine.run_revision) fails the revision on the first attempt. See
    # `test_llm_failure_marks_revision_failed_with_error_floor` below for the
    # single-attempt successor.

    def test_reduce_runs_inside_the_budget_envelope(
        self, db_session: Session, li_rate_limiter: _RecordingRateLimiter
    ) -> None:
        owner_id = _create_owner(db_session)
        library_id = create_test_library(db_session, owner_id, "Envelope Library")
        _ready_unit_media(db_session, owner_id, library_id, title="Source")
        li_rate_limiter.events.clear()  # drop the pre-built unit's envelope events

        runtime = _ScriptedRuntime(
            outcome=_succeeded_reduce_outcome(content_md="[1]", citations=[(1, 0, "supports")])
        )
        revision_id = _drive_generation(
            db_session, owner_id=owner_id, library_id=library_id, token="t1", runtime=runtime
        )

        assert li_rate_limiter.events == ["acquire_inflight_slot", "release_inflight_slot"], (
            f"unexpected envelope: {li_rate_limiter.events}"
        )

        # Token-budget reserve/commit/release now happen inside
        # execute_generation against the real global rate limiter (installed
        # by the autouse _rate_limiter fixture), not the worker-level
        # inflight-slot guard checked above — verify it against the ledger
        # row instead (architecture change, not a test simplification).
        call = _li_call_rows(db_session, revision_id=revision_id)[0]
        assert call.pricing_snapshot is not None
        reservation_estimate = call.pricing_snapshot["platform_token_reservation"]
        assert reservation_estimate > 4000, (
            "estimate must cover the rendered prompt plus max output tokens"
        )
        assert _reservation_count(db_session, call.id) == 0, "reservation must settle exactly once"
        assert _charge_amount(db_session, call.id) is not None, "a charge row must exist"

    def test_no_buildable_units_fails_revision(self, db_session: Session) -> None:
        owner_id = _create_owner(db_session)
        library_id = create_test_library(db_session, owner_id, "Empty Reduce")
        # A library media with NO extractable content: the inline unit build finds
        # no candidates and fails the unit, so the reduce sees zero ready units.
        _add_contentless_media(db_session, owner_id, library_id, title="Unbuilt")
        db_session.commit()

        runtime = _ScriptedRuntime(outcome=_succeeded_reduce_outcome(content_md="x", citations=[]))
        revision_id = _drive_generation(
            db_session, owner_id=owner_id, library_id=library_id, token="t1", runtime=runtime
        )
        assert runtime.calls == []  # the reduce never ran (no ready units)
        revision = db_session.execute(
            text("SELECT status, error_code, error_detail FROM artifact_revisions WHERE id = :r"),
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
        # A failed revision never gets a current_revision_id, so get_artifact's
        # early-return branch is hit and never reaches the llm_calls LATERAL
        # subquery that reads model/token attribution.
        view = get_artifact(db_session, viewer_id=owner_id, library_id=library_id)
        assert view.status == "failed"
        # AC22: only the promoting path writes citation edges.
        assert view.citations == []
        assert view.artifact_id is not None
        assert _citation_edges(db_session, "artifact_revision", revision_id) == [], (
            "a failed revision must write no citation edges"
        )
        assert _citation_edges(db_session, "artifact", view.artifact_id) == []

    def test_first_generate_builds_units_inline_and_succeeds(self, db_session: Session) -> None:
        # A fresh library whose per-media units were NOT pre-built: generation must
        # build them inline (fix for the first-generate race) and still produce a
        # grounded revision.
        owner_id = _create_owner(db_session)
        library_id = create_test_library(db_session, owner_id, "Fresh Inline")
        create_searchable_media_in_library(db_session, owner_id, library_id, title="Not Pre-Built")
        db_session.commit()

        runtime = _DispatchingRuntime(
            unit_outcome=_succeeded_unit_outcome(summary_md="Abstract.", claims=[("Key claim.", 0)]),
            reduce_outcome=_succeeded_reduce_outcome(
                content_md="Overview [1].", citations=[(1, 0, "supports")]
            ),
        )
        revision_id = _drive_generation(
            db_session, owner_id=owner_id, library_id=library_id, token="t1", runtime=runtime
        )

        view = get_artifact(db_session, viewer_id=owner_id, library_id=library_id)
        assert view.status == "current"
        assert view.revision_id == revision_id
        assert len(view.citations) == 1, "the inline-built unit's claim must ground a citation"

    def test_visible_marker_for_dropped_citation_fails_revision(self, db_session: Session) -> None:
        owner_id = _create_owner(db_session)
        library_id = create_test_library(db_session, owner_id, "Drop Library")
        _ready_unit_media(db_session, owner_id, library_id, title="Only Source")

        runtime = _ScriptedRuntime(
            outcome=_succeeded_reduce_outcome(
                content_md="[1] keep [2] drop",
                citations=[(1, 0, "supports"), (2, 50, "supports")],
            )
        )
        revision_id = _drive_generation(
            db_session, owner_id=owner_id, library_id=library_id, token="t1", runtime=runtime
        )
        revision = db_session.execute(
            text("SELECT status, error_code, error_detail FROM artifact_revisions WHERE id = :r"),
            {"r": revision_id},
        ).one()
        assert revision.status == "failed"
        assert revision.error_code == "citation_parity_failure", f"got {revision.error_code!r}"
        assert "markers=[1, 2], citations=[1]" in revision.error_detail
        assert _done_payload(db_session, revision_id=revision_id) == {
            "status": "failed",
            "error_code": "citation_parity_failure",
            "revision_id": str(revision_id),
        }
        # See test_no_buildable_units_fails_revision: a failed revision never
        # promotes, so get_artifact's early-return branch is safe here.
        view = get_artifact(db_session, viewer_id=owner_id, library_id=library_id)
        assert view.status == "failed"
        assert view.revision_id is None
        assert view.citations == []
        assert _citation_edges(db_session, "artifact_revision", revision_id) == [], (
            "a marker/citation parity failure must not write ready citation edges"
        )


@pytest.mark.integration
class TestStaleness:
    def test_reingest_flips_stale(self, db_session: Session) -> None:
        owner_id = _create_owner(db_session)
        library_id = create_test_library(db_session, owner_id, "Stale Library")
        media_id = _ready_unit_media(db_session, owner_id, library_id, title="Mutable Source")

        runtime = _ScriptedRuntime(
            outcome=_succeeded_reduce_outcome(content_md="[1]", citations=[(1, 0, "supports")])
        )
        _drive_generation(
            db_session, owner_id=owner_id, library_id=library_id, token="t1", runtime=runtime
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

        runtime = _ScriptedRuntime(
            outcome=_succeeded_reduce_outcome(content_md="[1]", citations=[(1, 0, "supports")])
        )
        _drive_generation(
            db_session, owner_id=owner_id, library_id=library_id, token="t1", runtime=runtime
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

        runtime = _ScriptedRuntime(
            outcome=_succeeded_reduce_outcome(content_md="[1]", citations=[(1, 0, "supports")])
        )
        _drive_generation(
            db_session, owner_id=owner_id, library_id=library_id, token="t1", runtime=runtime
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

        runtime = _ScriptedRuntime(
            outcome=_succeeded_reduce_outcome(content_md="[1]", citations=[(1, 0, "supports")])
        )
        _drive_generation(
            db_session, owner_id=owner_id, library_id=library_id, token="t1", runtime=runtime
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

        runtime = _ScriptedRuntime(
            outcome=_succeeded_reduce_outcome(content_md="[1]", citations=[(1, 0, "supports")])
        )
        _drive_generation(
            db_session, owner_id=owner_id, library_id=library_id, token="t1", runtime=runtime
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

        runtime = _ScriptedRuntime(
            outcome=_succeeded_reduce_outcome(content_md="Overview.", citations=[])
        )
        revision_id = _drive_generation(
            db_session, owner_id=owner_id, library_id=library_id, token="t1", runtime=runtime
        )

        view = get_artifact(db_session, viewer_id=owner_id, library_id=library_id)
        assert view.status == "current"
        covered = db_session.execute(
            text("SELECT covered_targets FROM artifact_revisions WHERE id = :r"),
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
class TestVirtualMediaSet:
    """Spec §4.1/AC12: the dossier's media set is `library_media_ids_cte_sql`'s
    personal virtual relation, viewer-anchored on the library's owner_user_id."""

    def test_default_dossier_covers_media_filed_only_in_a_member_library(
        self, db_session: Session
    ) -> None:
        owner_id = _create_owner(db_session)
        default_library_id = get_user_default_library(db_session, owner_id)
        assert default_library_id is not None
        shelf_id = create_test_library(db_session, owner_id, "Shelf")
        _ready_unit_media(db_session, owner_id, default_library_id, title="Direct Default")
        shelf_media_id = _ready_unit_media(db_session, owner_id, shelf_id, title="Shelved Only")

        runtime = _ScriptedRuntime(
            outcome=_succeeded_reduce_outcome(
                content_md="An overview [1] and a shelf source [2].",
                citations=[(1, 0, "supports"), (2, 1, "supports")],
            )
        )
        revision_id = _drive_generation(
            db_session,
            owner_id=owner_id,
            library_id=default_library_id,
            token="t1",
            runtime=runtime,
        )

        covered = db_session.execute(
            text("SELECT covered_targets FROM artifact_revisions WHERE id = :r"),
            {"r": revision_id},
        ).scalar_one()
        covered_media_ids = {rec["id"] for rec in covered if rec.get("kind") == "media"}
        assert str(shelf_media_id) in covered_media_ids, (
            "media filed only in a member non-default library must be covered by the "
            f"Default dossier (the personal virtual relation); got {covered_media_ids}"
        )

    def test_default_dossier_excludes_system_only_media(self, db_session: Session) -> None:
        # AC2: a system-library-only work (e.g. Oracle corpus) never enters the
        # Default dossier's media set, even though the viewer is a member of that
        # system library.
        owner_id = _create_owner(db_session)
        default_library_id = get_user_default_library(db_session, owner_id)
        assert default_library_id is not None
        _ready_unit_media(db_session, owner_id, default_library_id, title="Direct Default")

        system_media_id = create_test_media(db_session, title="Oracle-only")
        system_library_id = uuid4()
        db_session.execute(
            text(
                """
                INSERT INTO libraries (id, name, owner_user_id, is_default, system_key)
                VALUES (:id, 'System Corpus', :owner_user_id, false, :system_key)
                """
            ),
            {
                "id": system_library_id,
                "owner_user_id": owner_id,
                "system_key": f"test-li-system-{system_library_id}",
            },
        )
        db_session.execute(
            text(
                "INSERT INTO memberships (library_id, user_id, role) "
                "VALUES (:library_id, :user_id, 'admin')"
            ),
            {"library_id": system_library_id, "user_id": owner_id},
        )
        db_session.execute(
            text(
                "INSERT INTO library_entries (library_id, media_id, position) "
                "VALUES (:library_id, :media_id, 0)"
            ),
            {"library_id": system_library_id, "media_id": system_media_id},
        )
        db_session.commit()

        runtime = _ScriptedRuntime(
            outcome=_succeeded_reduce_outcome(
                content_md="An overview [1].", citations=[(1, 0, "supports")]
            )
        )
        revision_id = _drive_generation(
            db_session,
            owner_id=owner_id,
            library_id=default_library_id,
            token="t1",
            runtime=runtime,
        )

        covered = db_session.execute(
            text("SELECT covered_targets FROM artifact_revisions WHERE id = :r"),
            {"r": revision_id},
        ).scalar_one()
        covered_media_ids = {rec["id"] for rec in covered if rec.get("kind") == "media"}
        assert str(system_media_id) not in covered_media_ids, (
            f"system-only media must never enter the Default dossier; got {covered_media_ids}"
        )

    def test_non_owner_member_generation_still_covers_library_media(
        self, db_session: Session
    ) -> None:
        # The reducer viewer is always the library's owner_user_id (spec §4.1 /
        # engine.py collect_viewer), never the acting caller's own id, so a
        # non-owner member of a shared library can still trigger a generation
        # that covers the library's media.
        owner_id = _create_owner(db_session)
        member_id = _create_owner(db_session)
        library_id = create_test_library(db_session, owner_id, "Shared Library")
        add_library_member(db_session, library_id, member_id, role="member")
        _ready_unit_media(db_session, owner_id, library_id, title="Owner Source")

        runtime = _ScriptedRuntime(
            outcome=_succeeded_reduce_outcome(content_md="Overview [1].", citations=[(1, 0, "supports")])
        )
        revision_id = _drive_generation(
            db_session, owner_id=member_id, library_id=library_id, token="t1", runtime=runtime
        )

        view = get_artifact(db_session, viewer_id=member_id, library_id=library_id)
        assert view.status == "current"
        covered = db_session.execute(
            text("SELECT covered_targets FROM artifact_revisions WHERE id = :r"),
            {"r": revision_id},
        ).scalar_one()
        assert any(rec.get("kind") == "media" for rec in covered), (
            f"non-owner-triggered generation must still cover the library's media; got {covered}"
        )

    def test_engine_is_artifact_stale_resolves_library_owner_as_viewer(
        self, db_session: Session
    ) -> None:
        """`engine.is_artifact_stale`'s `_viewer_for_subject` must resolve a real
        viewer (the library's owner) for a ``library`` subject — the path
        `dawn_write.py`'s stale-library sweep depends on — since the dossier's
        live_fingerprint now requires a viewer_id and raises without one."""
        from nexus.services.artifacts.engine import is_artifact_stale

        owner_id = _create_owner(db_session)
        library_id = create_test_library(db_session, owner_id, "Sweep Library")
        _ready_unit_media(db_session, owner_id, library_id, title="Source")

        runtime = _ScriptedRuntime(
            outcome=_succeeded_reduce_outcome(content_md="Overview [1].", citations=[(1, 0, "supports")])
        )
        revision_id = _drive_generation(
            db_session, owner_id=owner_id, library_id=library_id, token="t1", runtime=runtime
        )

        assert not is_artifact_stale(
            db_session,
            subject_scheme="library",
            subject_id=library_id,
            kind="library_dossier",
            current_revision_id=revision_id,
        ), "a freshly generated revision must not be stale"

        create_searchable_media_in_library(db_session, owner_id, library_id, title="Added")
        db_session.commit()
        db_session.expire_all()

        assert is_artifact_stale(
            db_session,
            subject_scheme="library",
            subject_id=library_id,
            kind="library_dossier",
            current_revision_id=revision_id,
        ), "a newly added source must flip the revision stale"


@pytest.mark.integration
class TestRevisionsAndPromote:
    def test_regenerate_keeps_current_visible_then_promotes(self, db_session: Session) -> None:
        owner_id = _create_owner(db_session)
        library_id = create_test_library(db_session, owner_id, "Regen Library")
        _ready_unit_media(db_session, owner_id, library_id, title="Source")

        runtime1 = _ScriptedRuntime(
            outcome=_succeeded_reduce_outcome(
                content_md="First synthesis [1]", citations=[(1, 0, "supports")]
            )
        )
        first_rev = _drive_generation(
            db_session, owner_id=owner_id, library_id=library_id, token="t1", runtime=runtime1
        )

        # Regenerate: a new draft exists while the current revision stays shown.
        ref2 = generate_artifact(
            db_session, viewer_id=owner_id, library_id=library_id, idempotency_key="t2"
        )
        view = get_artifact(db_session, viewer_id=owner_id, library_id=library_id)
        assert view.revision_id == first_rev
        assert "First synthesis" in view.content_md
        assert view.build is not None and view.build.revision_id == ref2.revision_id
        # AC22: the in-flight draft has not touched the current revision's citation edges.
        assert [(c.ordinal, c.role) for c in view.citations] == [(1, "supports")], (
            f"a draft must not touch the current citation set; got {view.citations}"
        )
        assert _citation_edges(db_session, "artifact_revision", first_rev)
        assert _citation_edges(db_session, "artifact_revision", ref2.revision_id) == []

        runtime2 = _ScriptedRuntime(
            outcome=_succeeded_reduce_outcome(
                content_md="Second synthesis [1][2]",
                citations=[(1, 0, "supports"), (2, 0, "context")],
            )
        )
        asyncio.run(
            run_artifact_generation(db_session, revision_id=ref2.revision_id, runtime=runtime2)
        )
        db_session.expire_all()

        view = get_artifact(db_session, viewer_id=owner_id, library_id=library_id)
        assert view.revision_id == ref2.revision_id
        assert "Second synthesis" in view.content_md
        # The head now reads the second revision's citation set. The first
        # revision's citation set remains addressable under first_rev.
        assert [(c.ordinal, c.role) for c in view.citations] == [
            (1, "supports"),
            (2, "context"),
        ], f"the current head must read the new revision's citation set; got {view.citations}"
        assert view.artifact_id is not None
        assert len(_citation_edges(db_session, "artifact_revision", first_rev)) == 1
        assert len(_citation_edges(db_session, "artifact_revision", ref2.revision_id)) == 2
        assert _citation_edges(db_session, "artifact", view.artifact_id) == []
        # The prior revision is retained.
        prior = (
            db_session.execute(
                text("SELECT status, promoted_at FROM artifact_revisions WHERE id = :r"),
                {"r": first_rev},
            )
            .mappings()
            .one()
        )
        assert prior["status"] == "ready"
        assert prior["promoted_at"] is not None

    def test_instructionful_generate_stores_metadata_and_prompts_reduce(
        self, db_session: Session
    ) -> None:
        owner_id = _create_owner(db_session)
        library_id = create_test_library(db_session, owner_id, "Instruction Library")
        _ready_unit_media(db_session, owner_id, library_id, title="Source")

        instruction = "focus on cross-source tensions"
        ref = generate_artifact(
            db_session,
            viewer_id=owner_id,
            library_id=library_id,
            idempotency_key="instruction-1",
            instruction=f"  {instruction}  ",
        )
        stored = db_session.execute(
            text("SELECT custom_instruction FROM artifact_revisions WHERE id = :revision_id"),
            {"revision_id": ref.revision_id},
        ).scalar_one()
        assert stored == instruction

        runtime = _ScriptedRuntime(
            outcome=_succeeded_reduce_outcome(
                content_md="Instructional synthesis [1]",
                citations=[(1, 0, "supports")],
            )
        )
        asyncio.run(
            run_artifact_generation(db_session, revision_id=ref.revision_id, runtime=runtime)
        )
        assert any(
            f"CUSTOM INSTRUCTION:\n{instruction}" in message for message in runtime.user_messages
        ), f"reduce prompt did not include instruction; user turns: {runtime.user_messages!r}"

        db_session.expire_all()
        view = get_artifact(db_session, viewer_id=owner_id, library_id=library_id)
        assert view.revision_id == ref.revision_id
        assert view.custom_instruction == instruction
        assert view.source_count == 1
        revision = get_revision(
            db_session,
            viewer_id=owner_id,
            library_id=library_id,
            revision_id=ref.revision_id,
        )
        assert revision.custom_instruction == instruction
        assert revision.source_count == 1
        summaries = list_revisions(db_session, viewer_id=owner_id, library_id=library_id)
        assert summaries[0].custom_instruction == instruction
        assert summaries[0].source_count == 1

    def test_promote_restores_prior_revision(self, db_session: Session) -> None:
        owner_id = _create_owner(db_session)
        library_id = create_test_library(db_session, owner_id, "Restore Library")
        _ready_unit_media(db_session, owner_id, library_id, title="Source")

        runtime1 = _ScriptedRuntime(
            outcome=_succeeded_reduce_outcome(content_md="One [1]", citations=[(1, 0, "supports")])
        )
        first_rev = _drive_generation(
            db_session, owner_id=owner_id, library_id=library_id, token="t1", runtime=runtime1
        )
        runtime2 = _ScriptedRuntime(
            outcome=_succeeded_reduce_outcome(content_md="Two [1]", citations=[(1, 0, "supports")])
        )
        second_rev = _drive_generation(
            db_session, owner_id=owner_id, library_id=library_id, token="t2", runtime=runtime2
        )
        assert (
            get_artifact(db_session, viewer_id=owner_id, library_id=library_id).revision_id
            == second_rev
        )

        restored = promote_revision(
            db_session, viewer_id=owner_id, library_id=library_id, revision_id=first_rev
        )
        assert restored.revision_id == first_rev
        db_session.expire_all()
        view = get_artifact(db_session, viewer_id=owner_id, library_id=library_id)
        assert view.revision_id == first_rev
        assert "One" in view.content_md
        assert [(c.ordinal, c.role) for c in view.citations] == [(1, "supports")]
        second = get_revision(
            db_session, viewer_id=owner_id, library_id=library_id, revision_id=second_rev
        )
        assert [(c.ordinal, c.role) for c in second.citations] == [(1, "supports")]
        assert view.artifact_id is not None
        assert len(_citation_edges(db_session, "artifact_revision", first_rev)) == 1
        assert len(_citation_edges(db_session, "artifact_revision", second_rev)) == 1
        assert _citation_edges(db_session, "artifact", view.artifact_id) == []
        # Both revisions retained.
        summaries = list_revisions(db_session, viewer_id=owner_id, library_id=library_id)
        assert {s.revision_id for s in summaries} == {first_rev, second_rev}
        assert {s.revision_id: s.citation_count for s in summaries} == {
            first_rev: 1,
            second_rev: 1,
        }

    def test_idempotency_key_dedupes(self, db_session: Session) -> None:
        owner_id = _create_owner(db_session)
        library_id = create_test_library(db_session, owner_id, "Token Library")
        first = generate_artifact(
            db_session,
            viewer_id=owner_id,
            library_id=library_id,
            idempotency_key="same",
            instruction="first instruction",
        )
        second = generate_artifact(
            db_session,
            viewer_id=owner_id,
            library_id=library_id,
            idempotency_key="same",
            instruction="second instruction",
        )
        assert second.revision_id == first.revision_id
        stored = db_session.execute(
            text("SELECT custom_instruction FROM artifact_revisions WHERE id = :revision_id"),
            {"revision_id": first.revision_id},
        ).scalar_one()
        assert stored == "first instruction"
        job_count = db_session.execute(
            text(
                "SELECT COUNT(*) FROM background_jobs "
                "WHERE kind = 'library_dossier_generate' "
                "AND payload->>'revision_id' = :rid"
            ),
            {"rid": str(first.revision_id)},
        ).scalar_one()
        assert job_count == 1
        # A different idempotency key forks a fresh draft.
        third = generate_artifact(
            db_session,
            viewer_id=owner_id,
            library_id=library_id,
            idempotency_key="other",
            instruction="   ",
        )
        assert third.revision_id != first.revision_id
        blank_stored = db_session.execute(
            text("SELECT custom_instruction FROM artifact_revisions WHERE id = :revision_id"),
            {"revision_id": third.revision_id},
        ).scalar_one()
        assert blank_stored is None


@pytest.mark.integration
class TestWorkerBoundary:
    def test_llm_failure_marks_revision_failed_with_error_floor(self, db_session: Session) -> None:
        owner_id = _create_owner(db_session)
        library_id = create_test_library(db_session, owner_id, "Fail Library")
        _ready_unit_media(db_session, owner_id, library_id, title="Source")
        ref = generate_artifact(
            db_session, viewer_id=owner_id, library_id=library_id, idempotency_key="t1"
        )
        runtime = _ScriptedRuntime(outcome=_invalid_reduce_outcome())
        asyncio.run(
            run_artifact_generation(db_session, revision_id=ref.revision_id, runtime=runtime)
        )
        db_session.expire_all()
        # AC22: the failed (non-promoting) path wrote no citation edges.
        assert _citation_edges(db_session, "artifact_revision", ref.revision_id) == []
        assert _citation_edges(db_session, "artifact", ref.artifact_id) == []
        revision = db_session.execute(
            text("SELECT status, error_code, error_detail FROM artifact_revisions WHERE id = :r"),
            {"r": ref.revision_id},
        ).one()
        assert revision.status == "failed"
        assert revision.error_code == "invalid_structured_output", f"got {revision.error_code!r}"
        assert revision.error_detail, "error_detail must carry the operator-facing reason"
        assert _done_payload(db_session, revision_id=ref.revision_id) == {
            "status": "failed",
            "error_code": "invalid_structured_output",
            "revision_id": str(ref.revision_id),
        }
        # The provider call itself succeeded (only the decode failed downstream),
        # so exactly one attempt is ledgered — there is no repair-round retry in
        # the new architecture (engine.run_revision calls execute_generation
        # exactly once and fails immediately on a decode error).
        rows = _li_call_rows(db_session, revision_id=ref.revision_id)
        assert [row.call_seq for row in rows] == [1], (
            f"expected exactly one ledgered call, got {[(r.call_seq, r.outcome) for r in rows]}"
        )
        assert rows[0].outcome == "succeeded"

    def test_provider_failure_marks_revision_failed_with_error_floor(
        self, db_session: Session
    ) -> None:
        """The engine's non-Succeeded-outcome branch (outcome_failure_facts),
        distinct from the schema-decode failure above — new coverage this
        cutover's failure vocabulary makes possible (see the briefing's
        outcome/error_code mapping)."""
        owner_id = _create_owner(db_session)
        library_id = create_test_library(db_session, owner_id, "Provider Fail Library")
        _ready_unit_media(db_session, owner_id, library_id, title="Source")
        ref = generate_artifact(
            db_session, viewer_id=owner_id, library_id=library_id, idempotency_key="t1"
        )
        failure = TransientExhausted(attempts=1, cause=ProviderHttpUnavailable())
        runtime = _ScriptedRuntime(outcome=Failed(meta=_reduce_meta(usage=Absent()), failure=failure))

        asyncio.run(
            run_artifact_generation(db_session, revision_id=ref.revision_id, runtime=runtime)
        )
        db_session.expire_all()
        revision = db_session.execute(
            text("SELECT status, error_code, error_detail FROM artifact_revisions WHERE id = :r"),
            {"r": ref.revision_id},
        ).one()
        assert revision.status == "failed"
        assert revision.error_code == "provider_unavailable", f"got {revision.error_code!r}"
        rows = _li_call_rows(db_session, revision_id=ref.revision_id)
        assert [row.call_seq for row in rows] == [1]
        assert rows[0].outcome == "failed"
        assert rows[0].error_origin == "provider_http"
        assert rows[0].error_code == "provider_unavailable"

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
            text("SELECT status, error_code, error_detail FROM artifact_revisions WHERE id = :r"),
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
        runtime = _ScriptedRuntime(
            outcome=_succeeded_reduce_outcome(content_md="Kept [1]", citations=[(1, 0, "supports")])
        )
        revision_id = _drive_generation(
            db_session, owner_id=owner_id, library_id=library_id, token="t1", runtime=runtime
        )

        _fail_revision_after_worker_exception(
            db_session, RuntimeError("late"), revision_id=revision_id
        )
        db_session.expire_all()
        revision = db_session.execute(
            text("SELECT status, error_code FROM artifact_revisions WHERE id = :r"),
            {"r": revision_id},
        ).one()
        assert revision.status == "ready", "a terminal revision must not be re-failed"
        assert revision.error_code is None
