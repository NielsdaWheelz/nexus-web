from __future__ import annotations

import asyncio
from typing import Any
from uuid import UUID, uuid4

import pytest
from sqlalchemy import func, select, text
from sqlalchemy.orm import Session

from nexus.config import clear_settings_cache
from nexus.db.models import (
    ArtifactBuild,
    ArtifactIdeaResolution,
    ArtifactIdeaSeed,
    ArtifactIdeaSubject,
    ArtifactLearnRequest,
    ArtifactLearnSuccess,
    ArtifactRevision,
    SynthesisArtifact,
)
from nexus.errors import ApiErrorCode, ConflictError, NotFoundError
from nexus.schemas.presence import absent, present
from nexus.services.artifacts import engine
from nexus.services.artifacts.idea_identity import idea_key_from_selection
from nexus.services.artifacts.idea_seeds import register_idea_seed
from nexus.services.artifacts.learn import (
    ExistingIdeaResolution,
    FailedLearnRequest,
    NewIdeaResolution,
    PendingLearnRequest,
    candidate_ideas_for_request,
    materialize_idea_resolution,
    record_learn_opened,
    record_learn_unresolved,
    reserve_learn_request,
)
from nexus.services.billing_entitlements import grant_entitlement_override
from nexus.services.bootstrap import ensure_user_and_default_library
from nexus.services.highlights import delete_highlight
from nexus.services.rate_limit import RateLimiter, get_rate_limiter, set_rate_limiter
from nexus.services.real_media_fixture_llm import RealMediaFixtureExecutionRuntime
from nexus.services.resource_graph.refs import ResourceRef
from nexus.services.resource_graph.resolve import resolve_ref
from tests.factories import (
    add_library_member,
    create_test_fragment,
    create_test_highlight,
    create_test_library,
    create_test_media_in_library,
    get_user_default_library,
)
from tests.utils.db import DirectSessionManager, task_session_factory

pytestmark = pytest.mark.integration


class _GatedIdeaResolverRuntime:
    def __init__(self) -> None:
        self.entered = asyncio.Event()
        self.release = asyncio.Event()
        self.call_count = 0
        self._delegate = RealMediaFixtureExecutionRuntime()

    async def generate(self, intent: Any, plan: Any, credential: Any) -> Any:
        self.call_count += 1
        self.entered.set()
        await self.release.wait()
        return await self._delegate.generate(intent, plan, credential)

    def stream(
        self,
        intent: Any,
        plan: Any,
        credential: Any,
        *,
        cancel: Any,
    ) -> Any:
        return self._delegate.stream(
            intent,
            plan,
            credential,
            cancel=cancel,
        )


class _GatedFailingIdeaResolverRuntime:
    def __init__(self) -> None:
        self.entered = asyncio.Event()
        self.release = asyncio.Event()
        self.call_count = 0

    async def generate(self, intent: Any, plan: Any, credential: Any) -> Any:
        del intent, plan, credential
        self.call_count += 1
        self.entered.set()
        await self.release.wait()
        raise RuntimeError("resolver dispatch failed")

    def stream(
        self,
        intent: Any,
        plan: Any,
        credential: Any,
        *,
        cancel: Any,
    ) -> Any:
        del intent, plan, credential, cancel
        raise NotImplementedError


def _highlight(db: Session, *, user_id, exact: str):
    library_id = get_user_default_library(db, user_id)
    assert library_id is not None
    media_id = create_test_media_in_library(
        db,
        user_id,
        library_id,
        title="Idea source",
    )
    fragment_id = create_test_fragment(db, media_id, exact)
    return create_test_highlight(db, user_id, fragment_id, exact)


def _direct_learn_highlight(
    direct_db: DirectSessionManager,
    *,
    exact: str,
):
    user_id = uuid4()
    direct_db.register_cleanup("users", "id", user_id)
    with direct_db.session() as db:
        ensure_user_and_default_library(db, user_id)
        grant_entitlement_override(
            db,
            user_id=user_id,
            plan_tier="ai_pro",
            platform_token_quota_mode="unlimited",
            platform_token_limit_monthly=None,
            transcription_quota_mode="unlimited",
            transcription_minutes_limit_monthly=None,
            expires_at=None,
            reason="Learn concurrency test",
            actor_label="test",
        )
        highlight_id = _highlight(db, user_id=user_id, exact=exact)
        media_id = db.scalar(
            text("SELECT anchor_media_id FROM highlights WHERE id = :highlight_id"),
            {"highlight_id": highlight_id},
        )
        assert media_id is not None
        db.commit()
    direct_db.register_cleanup("media", "id", media_id)
    return user_id, highlight_id


def _direct_shared_learn_highlight(
    direct_db: DirectSessionManager,
) -> tuple[UUID, UUID, UUID]:
    owner_id = uuid4()
    user_id = uuid4()
    direct_db.register_cleanup("users", "id", user_id)
    direct_db.register_cleanup("users", "id", owner_id)
    with direct_db.session() as db:
        ensure_user_and_default_library(db, owner_id)
        db.execute(text("INSERT INTO users (id) VALUES (:user_id)"), {"user_id": user_id})
        grant_entitlement_override(
            db,
            user_id=user_id,
            plan_tier="ai_pro",
            platform_token_quota_mode="unlimited",
            platform_token_limit_monthly=None,
            transcription_quota_mode="unlimited",
            transcription_minutes_limit_monthly=None,
            expires_at=None,
            reason="Learn teardown concurrency test",
            actor_label="test",
        )
        library_id = create_test_library(db, owner_id)
        add_library_member(db, library_id, user_id)
        media_id = create_test_media_in_library(
            db,
            owner_id,
            library_id,
            title="Shared Idea source",
        )
        fragment_id = create_test_fragment(db, media_id, "Entropy")
        highlight_id = create_test_highlight(db, user_id, fragment_id, "Entropy")
        db.commit()
    direct_db.register_cleanup("media", "id", media_id)
    return owner_id, user_id, highlight_id


def _materialize_idea_head(
    db: Session,
    *,
    user_id,
    highlight_id,
    idempotency_key: str,
):
    request = reserve_learn_request(
        db,
        user_id=user_id,
        highlight_id=highlight_id,
        idempotency_key=idempotency_key,
        initial_coordination={},
    )
    assert isinstance(request, PendingLearnRequest)
    idea = materialize_idea_resolution(
        db,
        request=request,
        user_id=user_id,
        candidates=[],
        resolution=NewIdeaResolution(
            display_title="Entropy",
            idea_key=idea_key_from_selection("Entropy", disambiguator=absent()),
        ),
    )
    artifact = SynthesisArtifact(
        subject_scheme="idea",
        subject_id=idea.id,
        audience_scheme="user",
        audience_id=str(user_id),
    )
    db.add(artifact)
    db.flush()
    register_idea_seed(
        db,
        user_id=user_id,
        artifact_id=artifact.id,
        highlight_id=highlight_id,
        idea_subject_id=idea.id,
    )
    record_learn_opened(db, request_id=request.request_id, artifact_id=artifact.id)
    db.commit()
    return request, idea, artifact


def test_learn_replay_detects_mismatch_and_replays_terminal_failure(
    db_session: Session,
) -> None:
    user_id = uuid4()
    ensure_user_and_default_library(db_session, user_id)
    first_highlight_id = _highlight(db_session, user_id=user_id, exact="Entropy")
    second_highlight_id = _highlight(db_session, user_id=user_id, exact="Enthalpy")

    first = reserve_learn_request(
        db_session,
        user_id=user_id,
        highlight_id=first_highlight_id,
        idempotency_key="learn-1",
        initial_coordination={},
    )
    assert isinstance(first, PendingLearnRequest)
    terminal = record_learn_unresolved(db_session, request_id=first.request_id)
    db_session.commit()

    replay = reserve_learn_request(
        db_session,
        user_id=user_id,
        highlight_id=first_highlight_id,
        idempotency_key="learn-1",
        initial_coordination={"must": "not replace stored coordination"},
    )
    assert replay == terminal
    assert isinstance(replay, FailedLearnRequest)

    with pytest.raises(ConflictError) as mismatch:
        reserve_learn_request(
            db_session,
            user_id=user_id,
            highlight_id=second_highlight_id,
            idempotency_key="learn-1",
            initial_coordination={},
        )
    assert mismatch.value.code == ApiErrorCode.E_IDEMPOTENCY_KEY_REPLAY_MISMATCH


def test_exact_idea_key_converges_highlights_and_resolution_is_immutable(
    db_session: Session,
) -> None:
    user_id = uuid4()
    ensure_user_and_default_library(db_session, user_id)
    first_highlight_id = _highlight(db_session, user_id=user_id, exact="Entropy")
    second_highlight_id = _highlight(db_session, user_id=user_id, exact="Entropy")

    first = reserve_learn_request(
        db_session,
        user_id=user_id,
        highlight_id=first_highlight_id,
        idempotency_key="learn-first",
        initial_coordination={},
    )
    assert isinstance(first, PendingLearnRequest)
    idea = materialize_idea_resolution(
        db_session,
        request=first,
        user_id=user_id,
        candidates=[],
        resolution=NewIdeaResolution(
            display_title="Entropy",
            idea_key=idea_key_from_selection("Entropy", disambiguator=absent()),
        ),
    )

    second = reserve_learn_request(
        db_session,
        user_id=user_id,
        highlight_id=second_highlight_id,
        idempotency_key="learn-second",
        initial_coordination={},
    )
    assert isinstance(second, PendingLearnRequest)
    candidates = candidate_ideas_for_request(db_session, request=second, user_id=user_id)
    reused = materialize_idea_resolution(
        db_session,
        request=second,
        user_id=user_id,
        candidates=candidates,
        resolution=ExistingIdeaResolution(idea_subject_id=idea.id),
    )
    db_session.commit()

    assert reused == idea
    assert [candidate.id for candidate in candidates] == [idea.id]


def test_same_title_with_distinct_disambiguators_creates_distinct_idea_heads(
    db_session: Session,
) -> None:
    user_id = uuid4()
    ensure_user_and_default_library(db_session, user_id)
    planet_highlight_id = _highlight(db_session, user_id=user_id, exact="Mercury")
    element_highlight_id = _highlight(db_session, user_id=user_id, exact="Mercury")

    ideas = []
    artifacts = []
    for highlight_id, disambiguator, idempotency_key in (
        (planet_highlight_id, "planet", "learn-mercury-planet"),
        (element_highlight_id, "chemical element", "learn-mercury-element"),
    ):
        request = reserve_learn_request(
            db_session,
            user_id=user_id,
            highlight_id=highlight_id,
            idempotency_key=idempotency_key,
            initial_coordination={},
        )
        assert isinstance(request, PendingLearnRequest)
        idea = materialize_idea_resolution(
            db_session,
            request=request,
            user_id=user_id,
            candidates=[],
            resolution=NewIdeaResolution(
                display_title="Mercury",
                idea_key=idea_key_from_selection(
                    "Mercury",
                    disambiguator=present(disambiguator),
                ),
            ),
        )
        artifact = SynthesisArtifact(
            subject_scheme="idea",
            subject_id=idea.id,
            audience_scheme="user",
            audience_id=str(user_id),
        )
        db_session.add(artifact)
        db_session.flush()
        ideas.append(idea)
        artifacts.append(artifact)

    assert ideas[0].id != ideas[1].id
    assert ideas[0].idea_key != ideas[1].idea_key
    assert artifacts[0].id != artifacts[1].id
    assert {artifact.subject_id for artifact in artifacts} == {idea.id for idea in ideas}


def test_highlight_teardown_removes_learn_rows_but_keeps_the_idea_head(
    db_session: Session,
) -> None:
    user_id = uuid4()
    ensure_user_and_default_library(db_session, user_id)
    highlight_id = _highlight(db_session, user_id=user_id, exact="Entropy")
    request, idea, artifact = _materialize_idea_head(
        db_session,
        user_id=user_id,
        highlight_id=highlight_id,
        idempotency_key="learn-highlight-cleanup",
    )

    delete_highlight(db_session, user_id, highlight_id)

    assert db_session.get(ArtifactLearnRequest, request.request_id) is None
    assert db_session.get(ArtifactIdeaResolution, highlight_id) is None
    assert (
        db_session.scalar(
            select(func.count())
            .select_from(ArtifactIdeaSeed)
            .where(ArtifactIdeaSeed.artifact_id == artifact.id)
        )
        == 0
    )
    assert db_session.get(ArtifactIdeaSubject, idea.id) is not None
    assert db_session.get(SynthesisArtifact, artifact.id) is not None


def test_artifact_teardown_removes_idea_head_seeds_resolution_and_replay(
    db_session: Session,
) -> None:
    user_id = uuid4()
    ensure_user_and_default_library(db_session, user_id)
    highlight_id = _highlight(db_session, user_id=user_id, exact="Entropy")
    request, idea, artifact = _materialize_idea_head(
        db_session,
        user_id=user_id,
        highlight_id=highlight_id,
        idempotency_key="learn-artifact-cleanup",
    )
    request_id = request.request_id
    idea_id = idea.id
    artifact_id = artifact.id

    engine._delete_heads(db_session, [artifact_id])
    db_session.expire_all()

    assert db_session.get(SynthesisArtifact, artifact_id) is None
    assert db_session.get(ArtifactLearnRequest, request_id) is None
    assert db_session.get(ArtifactIdeaSubject, idea_id) is None
    assert db_session.get(ArtifactIdeaResolution, highlight_id) is None
    assert (
        db_session.scalar(
            select(func.count())
            .select_from(ArtifactIdeaSeed)
            .where(ArtifactIdeaSeed.artifact_id == artifact_id)
        )
        == 0
    )


def test_user_teardown_removes_the_private_idea_head_and_all_idea_rows(
    db_session: Session,
) -> None:
    owner_id = uuid4()
    departing_user_id = uuid4()
    ensure_user_and_default_library(db_session, owner_id)
    db_session.execute(
        text("INSERT INTO users (id) VALUES (:user_id)"),
        {"user_id": departing_user_id},
    )
    library_id = create_test_library(db_session, owner_id)
    add_library_member(db_session, library_id, departing_user_id)
    media_id = create_test_media_in_library(
        db_session,
        owner_id,
        library_id,
        title="Shared Idea source",
    )
    fragment_id = create_test_fragment(db_session, media_id, "Entropy")
    highlight_id = create_test_highlight(
        db_session,
        departing_user_id,
        fragment_id,
        "Entropy",
    )
    request, idea, artifact = _materialize_idea_head(
        db_session,
        user_id=departing_user_id,
        highlight_id=highlight_id,
        idempotency_key="learn-user-cleanup",
    )
    artifact_id = artifact.id

    engine.on_user_deleted(db_session, user_id=departing_user_id)
    db_session.commit()

    assert db_session.get(SynthesisArtifact, artifact_id) is None
    assert db_session.get(ArtifactLearnRequest, request.request_id) is None
    assert db_session.get(ArtifactIdeaSubject, idea.id) is None
    assert db_session.get(ArtifactIdeaResolution, highlight_id) is None
    assert (
        db_session.scalar(
            select(func.count())
            .select_from(ArtifactIdeaSeed)
            .where(ArtifactIdeaSeed.artifact_id == artifact_id)
        )
        == 0
    )


@pytest.mark.asyncio
async def test_learn_command_converges_highlights_and_opens_the_active_head(
    db_session: Session,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    user_id = uuid4()
    ensure_user_and_default_library(db_session, user_id)
    grant_entitlement_override(
        db_session,
        user_id=user_id,
        plan_tier="ai_pro",
        platform_token_quota_mode="unlimited",
        platform_token_limit_monthly=None,
        transcription_quota_mode="unlimited",
        transcription_minutes_limit_monthly=None,
        expires_at=None,
        reason="Learn command integration test",
        actor_label="test",
    )
    first_highlight_id = _highlight(db_session, user_id=user_id, exact="Entropy")
    second_highlight_id = _highlight(db_session, user_id=user_id, exact="Entropy")
    db_session.commit()
    runtime = RealMediaFixtureExecutionRuntime()
    session_factory = task_session_factory(db_session)
    monkeypatch.setattr(engine, "get_session_factory", lambda: session_factory)
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test-platform-key")
    clear_settings_cache()
    previous_rate_limiter = get_rate_limiter()
    set_rate_limiter(RateLimiter(session_factory=session_factory))

    try:
        first = await engine.learn_idea(
            db_session,
            highlight_id=first_highlight_id,
            requester_user_id=user_id,
            idempotency_key="learn-command-first",
            runtime=runtime,
        )
        second = await engine.learn_idea(
            db_session,
            highlight_id=second_highlight_id,
            requester_user_id=user_id,
            idempotency_key="learn-command-second",
            runtime=runtime,
        )
    finally:
        set_rate_limiter(previous_rate_limiter)
        clear_settings_cache()

    assert first.kind == "BuildAccepted"
    assert second.kind == "Opened"
    assert second.artifact_id == first.artifact_id
    assert (
        db_session.scalar(
            select(func.count())
            .select_from(SynthesisArtifact)
            .where(
                SynthesisArtifact.subject_scheme == "idea",
                SynthesisArtifact.audience_scheme == "user",
                SynthesisArtifact.audience_id == str(user_id),
            )
        )
        == 1
    )
    assert (
        db_session.scalar(
            select(func.count())
            .select_from(ArtifactIdeaSeed)
            .where(ArtifactIdeaSeed.artifact_id == first.artifact_id)
        )
        == 2
    )
    outcomes = list(
        db_session.scalars(
            select(ArtifactLearnSuccess.outcome_kind)
            .where(ArtifactLearnSuccess.artifact_id == first.artifact_id)
            .order_by(ArtifactLearnSuccess.created_at)
        )
    )
    assert outcomes == ["BuildAccepted", "Opened"]


@pytest.mark.asyncio
async def test_relearn_against_current_revision_opens_without_regeneration(
    db_session: Session,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    user_id = uuid4()
    ensure_user_and_default_library(db_session, user_id)
    grant_entitlement_override(
        db_session,
        user_id=user_id,
        plan_tier="ai_pro",
        platform_token_quota_mode="unlimited",
        platform_token_limit_monthly=None,
        transcription_quota_mode="unlimited",
        transcription_minutes_limit_monthly=None,
        expires_at=None,
        reason="Re-Learn current revision test",
        actor_label="test",
    )
    first_highlight_id = _highlight(db_session, user_id=user_id, exact="Entropy")
    second_highlight_id = _highlight(db_session, user_id=user_id, exact="Entropy")
    _request, _idea, artifact = _materialize_idea_head(
        db_session,
        user_id=user_id,
        highlight_id=first_highlight_id,
        idempotency_key="learn-current-first",
    )
    published_build = ArtifactBuild(
        artifact_id=artifact.id,
        requester_user_id=user_id,
        idempotency_key="published-build",
    )
    db_session.add(published_build)
    db_session.flush()
    revision = ArtifactRevision(
        build_id=published_build.id,
        content_html="<article><p>Published lesson.</p></article>",
        content_text="Published lesson.",
        input_manifest={
            "version": "v1",
            "kind": "idea",
            "idea_subject_id": str(artifact.subject_id),
            "included_seed_refs": [f"highlight:{first_highlight_id}"],
            "nexus_query_fingerprints": [],
            "web_query_fingerprints": [],
            "included_sources": [],
            "omitted_sources": [],
        },
        citation_owner_user_id=user_id,
    )
    db_session.add(revision)
    db_session.flush()
    artifact.current_revision_id = revision.id
    db_session.commit()
    initial_build_count = db_session.scalar(
        select(func.count())
        .select_from(ArtifactBuild)
        .where(ArtifactBuild.artifact_id == artifact.id)
    )
    session_factory = task_session_factory(db_session)
    monkeypatch.setattr(engine, "get_session_factory", lambda: session_factory)
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test-platform-key")
    clear_settings_cache()
    previous_rate_limiter = get_rate_limiter()
    set_rate_limiter(RateLimiter(session_factory=session_factory))

    try:
        outcome = await engine.learn_idea(
            db_session,
            highlight_id=second_highlight_id,
            requester_user_id=user_id,
            idempotency_key="learn-current-second",
            runtime=RealMediaFixtureExecutionRuntime(),
        )
    finally:
        set_rate_limiter(previous_rate_limiter)
        clear_settings_cache()

    assert outcome.kind == "Opened"
    assert outcome.artifact_id == artifact.id
    assert (
        db_session.scalar(
            select(func.count())
            .select_from(ArtifactBuild)
            .where(ArtifactBuild.artifact_id == artifact.id)
        )
        == initial_build_count
    )
    assert (
        db_session.scalar(
            select(func.count())
            .select_from(ArtifactIdeaSeed)
            .where(ArtifactIdeaSeed.artifact_id == artifact.id)
        )
        == 2
    )


@pytest.mark.asyncio
async def test_concurrent_same_key_learn_replay_dispatches_resolver_once(
    direct_db: DirectSessionManager,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    user_id, highlight_id = _direct_learn_highlight(direct_db, exact="Entropy")
    runtime = _GatedIdeaResolverRuntime()
    monkeypatch.setattr(engine, "get_session_factory", lambda: direct_db.session)
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test-platform-key")
    clear_settings_cache()
    previous_rate_limiter = get_rate_limiter()
    set_rate_limiter(RateLimiter(session_factory=direct_db.session))
    first_db = direct_db.session()
    replay_db = direct_db.session()
    first_task = asyncio.create_task(
        engine.learn_idea(
            first_db,
            highlight_id=highlight_id,
            requester_user_id=user_id,
            idempotency_key="same-live-request",
            runtime=runtime,
        )
    )
    replay_task: asyncio.Task | None = None

    try:
        try:
            await asyncio.wait_for(runtime.entered.wait(), timeout=5)
        except TimeoutError:
            await first_task
            raise
        replay_task = asyncio.create_task(
            engine.learn_idea(
                replay_db,
                highlight_id=highlight_id,
                requester_user_id=user_id,
                idempotency_key="same-live-request",
                runtime=runtime,
            )
        )
        await asyncio.sleep(0.05)
        assert runtime.call_count == 1
        runtime.release.set()
        first, replay = await asyncio.wait_for(
            asyncio.gather(first_task, replay_task),
            timeout=10,
        )
    finally:
        runtime.release.set()
        if not first_task.done():
            first_task.cancel()
        if replay_task is not None and not replay_task.done():
            replay_task.cancel()
        await asyncio.gather(
            first_task,
            *(tuple([replay_task]) if replay_task is not None else ()),
            return_exceptions=True,
        )
        first_db.close()
        replay_db.close()
        set_rate_limiter(previous_rate_limiter)
        clear_settings_cache()

    assert runtime.call_count == 1
    assert first == replay
    assert first.kind == "BuildAccepted"
    with direct_db.session() as cleanup_db:
        head_ids = list(
            cleanup_db.scalars(
                select(SynthesisArtifact.id).where(
                    SynthesisArtifact.audience_scheme == "user",
                    SynthesisArtifact.audience_id == str(user_id),
                )
            )
        )
        engine._delete_heads(cleanup_db, head_ids)
        cleanup_db.commit()


@pytest.mark.asyncio
async def test_highlight_teardown_during_resolver_dispatch_returns_masked_not_found(
    direct_db: DirectSessionManager,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    user_id, highlight_id = _direct_learn_highlight(direct_db, exact="Entropy")
    runtime = _GatedIdeaResolverRuntime()
    monkeypatch.setattr(engine, "get_session_factory", lambda: direct_db.session)
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test-platform-key")
    clear_settings_cache()
    previous_rate_limiter = get_rate_limiter()
    set_rate_limiter(RateLimiter(session_factory=direct_db.session))
    request_db = direct_db.session()
    learn_task = asyncio.create_task(
        engine.learn_idea(
            request_db,
            highlight_id=highlight_id,
            requester_user_id=user_id,
            idempotency_key="deleted-during-resolve",
            runtime=runtime,
        )
    )

    try:
        try:
            await asyncio.wait_for(runtime.entered.wait(), timeout=5)
        except TimeoutError:
            await learn_task
            raise
        with direct_db.session() as teardown_db:
            delete_highlight(teardown_db, user_id, highlight_id)
            teardown_db.commit()
        runtime.release.set()
        with pytest.raises(NotFoundError) as error:
            await asyncio.wait_for(learn_task, timeout=10)
    finally:
        runtime.release.set()
        if not learn_task.done():
            learn_task.cancel()
        await asyncio.gather(learn_task, return_exceptions=True)
        request_db.close()
        set_rate_limiter(previous_rate_limiter)
        clear_settings_cache()

    assert error.value.code == ApiErrorCode.E_NOT_FOUND
    assert runtime.call_count == 1


@pytest.mark.asyncio
async def test_artifact_teardown_after_persisted_resolution_returns_masked_not_found(
    direct_db: DirectSessionManager,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    user_id, highlight_id = _direct_learn_highlight(direct_db, exact="Entropy")
    with direct_db.session() as setup_db:
        _request, _idea, artifact = _materialize_idea_head(
            setup_db,
            user_id=user_id,
            highlight_id=highlight_id,
            idempotency_key="artifact-race-initial",
        )
        artifact_id = artifact.id

    original = engine.learn_service.existing_resolution_for_request
    teardown_landed = False

    def resolve_then_delete_artifact(*args: Any, **kwargs: Any) -> Any:
        nonlocal teardown_landed
        resolved = original(*args, **kwargs)
        if not teardown_landed:
            assert resolved is not None
            with direct_db.session() as teardown_db:
                engine._delete_heads(teardown_db, [artifact_id])
                teardown_db.commit()
            teardown_landed = True
        return resolved

    monkeypatch.setattr(
        engine.learn_service,
        "existing_resolution_for_request",
        resolve_then_delete_artifact,
    )

    with direct_db.session() as request_db:
        with pytest.raises(NotFoundError) as error:
            await engine.learn_idea(
                request_db,
                highlight_id=highlight_id,
                requester_user_id=user_id,
                idempotency_key="artifact-race-replay",
                runtime=RealMediaFixtureExecutionRuntime(),
            )

    assert error.value.code == ApiErrorCode.E_NOT_FOUND
    assert teardown_landed is True
    with direct_db.session() as check_db:
        assert (
            check_db.scalar(
                select(func.count())
                .select_from(ArtifactLearnRequest)
                .where(
                    ArtifactLearnRequest.user_id == user_id,
                    ArtifactLearnRequest.idempotency_key == "artifact-race-replay",
                )
            )
            == 0
        )


@pytest.mark.asyncio
@pytest.mark.parametrize("teardown_kind", ["highlight", "user"])
async def test_teardown_during_resolver_failure_returns_masked_not_found(
    direct_db: DirectSessionManager,
    monkeypatch: pytest.MonkeyPatch,
    teardown_kind: str,
) -> None:
    _owner_id, user_id, highlight_id = _direct_shared_learn_highlight(direct_db)
    runtime = _GatedFailingIdeaResolverRuntime()
    monkeypatch.setattr(engine, "get_session_factory", lambda: direct_db.session)
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test-platform-key")
    clear_settings_cache()
    previous_rate_limiter = get_rate_limiter()
    set_rate_limiter(RateLimiter(session_factory=direct_db.session))
    request_db = direct_db.session()
    learn_task = asyncio.create_task(
        engine.learn_idea(
            request_db,
            highlight_id=highlight_id,
            requester_user_id=user_id,
            idempotency_key=f"{teardown_kind}-during-resolver-failure",
            runtime=runtime,
        )
    )

    try:
        try:
            await asyncio.wait_for(runtime.entered.wait(), timeout=5)
        except TimeoutError:
            await learn_task
            raise
        with direct_db.session() as teardown_db:
            if teardown_kind == "highlight":
                delete_highlight(teardown_db, user_id, highlight_id)
            else:
                engine.on_user_deleted(teardown_db, user_id=user_id)
            teardown_db.commit()
        runtime.release.set()
        with pytest.raises(NotFoundError) as error:
            await asyncio.wait_for(learn_task, timeout=10)
    finally:
        runtime.release.set()
        if not learn_task.done():
            learn_task.cancel()
        await asyncio.gather(learn_task, return_exceptions=True)
        request_db.close()
        set_rate_limiter(previous_rate_limiter)
        clear_settings_cache()

    assert error.value.code == ApiErrorCode.E_NOT_FOUND
    assert runtime.call_count == 1
    with direct_db.session() as check_db:
        assert (
            check_db.scalar(
                select(func.count())
                .select_from(ArtifactLearnRequest)
                .where(ArtifactLearnRequest.user_id == user_id)
            )
            == 0
        )


def test_idea_artifact_resolves_by_ref_without_fabricating_a_resource_subject(
    db_session: Session,
) -> None:
    user_id = uuid4()
    other_user_id = uuid4()
    ensure_user_and_default_library(db_session, user_id)
    ensure_user_and_default_library(db_session, other_user_id)
    highlight_id = _highlight(db_session, user_id=user_id, exact="Entropy")
    request = reserve_learn_request(
        db_session,
        user_id=user_id,
        highlight_id=highlight_id,
        idempotency_key="learn-resolve",
        initial_coordination={},
    )
    assert isinstance(request, PendingLearnRequest)
    idea = materialize_idea_resolution(
        db_session,
        request=request,
        user_id=user_id,
        candidates=[],
        resolution=NewIdeaResolution(
            display_title="Entropy",
            idea_key=idea_key_from_selection("Entropy", disambiguator=absent()),
        ),
    )
    artifact = SynthesisArtifact(
        subject_scheme="idea",
        subject_id=idea.id,
        audience_scheme="user",
        audience_id=str(user_id),
    )
    db_session.add(artifact)
    db_session.flush()
    build = ArtifactBuild(
        artifact_id=artifact.id,
        requester_user_id=user_id,
        idempotency_key="idea-artifact",
    )
    db_session.add(build)
    db_session.flush()
    revision = ArtifactRevision(
        build_id=build.id,
        content_html="<article><p>Entropy measures multiplicity.</p></article>",
        content_text="Entropy measures multiplicity.",
        input_manifest={
            "version": "v1",
            "kind": "idea",
            "idea_subject_id": str(idea.id),
            "included_seed_refs": [],
            "nexus_query_fingerprints": [],
            "web_query_fingerprints": [],
            "included_sources": [],
            "omitted_sources": [],
        },
        citation_owner_user_id=user_id,
    )
    db_session.add(revision)
    db_session.flush()
    artifact.current_revision_id = revision.id
    db_session.commit()

    ref = ResourceRef(scheme="artifact", id=artifact.id)
    resolved = resolve_ref(db_session, viewer_id=user_id, ref=ref)
    masked = resolve_ref(db_session, viewer_id=other_user_id, ref=ref)

    assert resolved.missing is False
    assert resolved.label == "Dossier — Entropy"
    assert resolved.inline_body == "Entropy measures multiplicity."
    assert masked.missing is True
