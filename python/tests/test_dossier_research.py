"""Focused pure tests for Idea research replay and closed step results."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from typing import Any, cast
from uuid import UUID

import pytest
from pydantic import ValidationError

from nexus.errors import ApiError, ApiErrorCode, InvalidRequestError
from nexus.schemas.presence import absent, present
from nexus.services import media_source_types as source_types
from nexus.services.agent_tools.web_page_read import (
    PageAcceptResult,
    PageReadyResult,
    WebPageOmissionReason,
    WebSearchItem,
    WebSearchResult,
    _load_canonical_dedupe_winner,
    _resolve_build_search_result,
    _terminal_omission_reason,
    omitted_web_search_result,
)
from nexus.services.artifacts.coordination import DossierBuildRuntime, DossierResearchPending
from nexus.services.artifacts.idea_identity import idea_key_from_selection
from nexus.services.artifacts.research import (
    NexusSearchResult,
    _fingerprint,
    _observe_page_step,
    _redispatchable_step,
    idea_research_queries,
)
from nexus.services.artifacts.subject_policy import ResolvedIdeaSubject
from nexus.services.durable_step_journal import (
    Completed,
    ReplayPolicy,
    StepReplayState,
    Uncertain,
    decode_step_states,
    encode_step_result,
    stable_generation_id,
)
from nexus.services.media_read_map import DocumentRead
from nexus.services.media_source_ingest import _is_terminal_source_failure

pytestmark = pytest.mark.unit

_BUILD_ID = UUID("11111111-1111-4111-8111-111111111111")
_ARTIFACT_ID = UUID("22222222-2222-4222-8222-222222222222")
_USER_ID = UUID("33333333-3333-4333-8333-333333333333")
_FINGERPRINT = "a" * 64
_RESULT_ID = "b" * 32


class _CommitOnlySession:
    def __init__(self) -> None:
        self.commits = 0
        self.rollbacks = 0

    def commit(self) -> None:
        self.commits += 1

    def rollback(self) -> None:
        self.rollbacks += 1


class _ReplayRuntime:
    build_id = _BUILD_ID
    artifact_id = _ARTIFACT_ID

    def __init__(self, state: StepReplayState | None = None) -> None:
        self.state = state

    def read_step(
        self,
        path: str,
        replay_policy: ReplayPolicy,
    ) -> StepReplayState | None:
        assert path == "research/nexus-search/0"
        if self.state is not None:
            assert replay_policy is ReplayPolicy.ReDispatchable
        return self.state

    def checkpoint_step(
        self,
        db: _CommitOnlySession,
        *,
        path: str,
        state: StepReplayState,
    ) -> bool:
        del db
        assert path == "research/nexus-search/0"
        self.state = state
        return True


def _resolved(*, disambiguator: str | None = None) -> ResolvedIdeaSubject:
    return ResolvedIdeaSubject(
        scheme="idea",
        subject_id=_ARTIFACT_ID,
        idea_key=idea_key_from_selection(
            "Bayes' theorem",
            disambiguator=present(disambiguator) if disambiguator else absent(),
        ),
        display_title="Bayes' theorem",
        user_id=_USER_ID,
    )


def test_idea_queries_are_exact_and_absence_does_not_render() -> None:
    assert idea_research_queries(_resolved()) == (
        "Bayes' theorem",
        "Bayes' theorem explained",
        "Bayes' theorem examples",
    )
    assert idea_research_queries(_resolved(disambiguator="probability")) == (
        "Bayes' theorem probability",
        "Bayes' theorem probability explained",
        "Bayes' theorem probability examples",
    )


@pytest.mark.asyncio
async def test_redispatchable_step_checkpoints_once_and_reuses_completion() -> None:
    db = _CommitOnlySession()
    runtime = _ReplayRuntime()
    calls = 0

    async def dispatch() -> NexusSearchResult:
        nonlocal calls
        calls += 1
        return NexusSearchResult(query_fingerprint=_FINGERPRINT, items=[])

    first = await _redispatchable_step(
        db,  # type: ignore[arg-type]
        runtime=runtime,  # type: ignore[arg-type]
        path="research/nexus-search/0",
        request_fingerprint=_FINGERPRINT,
        schema=NexusSearchResult,
        dispatch=dispatch,
    )
    second = await _redispatchable_step(
        db,  # type: ignore[arg-type]
        runtime=runtime,  # type: ignore[arg-type]
        path="research/nexus-search/0",
        request_fingerprint=_FINGERPRINT,
        schema=NexusSearchResult,
        dispatch=dispatch,
    )

    assert first == second
    assert calls == 1
    assert db.commits == 3
    assert runtime.state is not None
    assert runtime.state.dispatch_phase is Completed


@pytest.mark.asyncio
async def test_uncertain_redispatchable_step_may_dispatch_again() -> None:
    state = StepReplayState(
        generation_id=stable_generation_id(_BUILD_ID, "research/nexus-search/0"),
        dispatch_phase=Uncertain,
        request_fingerprint=present(_FINGERPRINT),
        terminal_result=absent(),
    )
    db = _CommitOnlySession()
    runtime = _ReplayRuntime(state)
    calls = 0

    async def dispatch() -> NexusSearchResult:
        nonlocal calls
        calls += 1
        return NexusSearchResult(query_fingerprint=_FINGERPRINT, items=[])

    await _redispatchable_step(
        db,  # type: ignore[arg-type]
        runtime=runtime,  # type: ignore[arg-type]
        path="research/nexus-search/0",
        request_fingerprint=_FINGERPRINT,
        schema=NexusSearchResult,
        dispatch=dispatch,
    )

    assert calls == 1
    assert db.commits == 2
    assert runtime.state is not None
    assert runtime.state.dispatch_phase is Completed


def test_completed_coordination_payload_fails_closed_on_unknown_fields() -> None:
    with pytest.raises(ValidationError):
        decode_step_states(
            {
                "coordination": {
                    "research/nexus-search/0": {
                        "generation_id": str(_BUILD_ID),
                        "dispatch_phase": "Completed",
                        "request_fingerprint": {
                            "kind": "Present",
                            "value": "fingerprint",
                        },
                        "terminal_result": {
                            "kind": "Present",
                            "value": '{"query_fingerprint":"fingerprint","items":[]}',
                        },
                        "unknown": True,
                    }
                }
            }
        )


def test_page_accept_result_is_an_exact_variant() -> None:
    omitted = omitted_web_search_result(
        result_id=_RESULT_ID,
        reason=WebPageOmissionReason.SsrfBlocked,
    )
    assert omitted.status == "Omitted"

    with pytest.raises(ValidationError):
        PageAcceptResult(
            result_id=_RESULT_ID,
            status="Omitted",
            source_attempt_id=absent(),
            media_ref=absent(),
            accepted_at=absent(),
            ready_deadline=absent(),
            omission_reason=absent(),
        )


def test_page_ready_result_is_an_exact_variant() -> None:
    assert (
        PageReadyResult(
            result_id=_RESULT_ID,
            status="Ready",
            omission_reason=absent(),
        ).status
        == "Ready"
    )
    with pytest.raises(ValidationError):
        PageReadyResult(
            result_id=_RESULT_ID,
            status="Ready",
            omission_reason=present(WebPageOmissionReason.Deadline),
        )
    with pytest.raises(ValidationError):
        PageReadyResult(
            result_id=_RESULT_ID,
            status="Omitted",
            omission_reason=absent(),
        )


def test_completed_ready_step_replays_without_observing_the_page_again() -> None:
    now = datetime.now(UTC)
    accepted = PageAcceptResult(
        result_id=_RESULT_ID,
        status="Accepted",
        source_attempt_id=present(UUID("66666666-6666-4666-8666-666666666666")),
        media_ref=present("media:77777777-7777-4777-8777-777777777777"),
        accepted_at=present(now),
        ready_deadline=present(now + timedelta(minutes=10)),
        omission_reason=absent(),
    )
    path = "research/page-ready/0"
    state = StepReplayState(
        generation_id=stable_generation_id(_BUILD_ID, path),
        dispatch_phase=Completed,
        request_fingerprint=present(_fingerprint(encode_step_result(accepted))),
        terminal_result=present(
            encode_step_result(
                PageReadyResult(
                    result_id=_RESULT_ID,
                    status="Ready",
                    omission_reason=absent(),
                )
            )
        ),
    )

    class ReadyReplayRuntime:
        build_id = _BUILD_ID

        def read_step(self, candidate_path, replay_policy):
            assert candidate_path == path
            assert replay_policy is ReplayPolicy.ReDispatchable
            return state

        def checkpoint_step(self, *args, **kwargs):
            raise AssertionError("completed Ready result must not checkpoint again")

    result = _observe_page_step(
        cast("Any", object()),
        runtime=cast("Any", ReadyReplayRuntime()),
        index=0,
        accepted=accepted,
    )
    assert result.status == "Ready"


def test_completed_page_ready_step_rejects_pending_state() -> None:
    now = datetime.now(UTC)
    accepted = PageAcceptResult(
        result_id=_RESULT_ID,
        status="Accepted",
        source_attempt_id=present(UUID("66666666-6666-4666-8666-666666666666")),
        media_ref=present("media:77777777-7777-4777-8777-777777777777"),
        accepted_at=present(now),
        ready_deadline=present(now + timedelta(minutes=10)),
        omission_reason=absent(),
    )
    path = "research/page-ready/0"
    state = StepReplayState(
        generation_id=stable_generation_id(_BUILD_ID, path),
        dispatch_phase=Completed,
        request_fingerprint=present(_fingerprint(encode_step_result(accepted))),
        terminal_result=present(
            encode_step_result(
                PageReadyResult(
                    result_id=_RESULT_ID,
                    status="Pending",
                    omission_reason=absent(),
                )
            )
        ),
    )

    class PendingReplayRuntime:
        build_id = _BUILD_ID

        def read_step(self, _path, _replay_policy):
            return state

    with pytest.raises(AssertionError, match="cannot remain Pending"):
        _observe_page_step(
            cast("Any", object()),
            runtime=cast("Any", PendingReplayRuntime()),
            index=0,
            accepted=accepted,
        )


def test_deadline_crossing_yields_once_for_terminal_observation() -> None:
    before = datetime.now(UTC)
    with pytest.raises(DossierResearchPending) as raised:
        DossierBuildRuntime.yield_until(
            cast("Any", object()),
            before - timedelta(milliseconds=1),
        )
    assert raised.value.available_at >= before


def test_web_page_read_resolves_only_a_build_owned_opaque_result() -> None:
    search_result = WebSearchResult(
        query_fingerprint=_FINGERPRINT,
        items=[
            WebSearchItem(
                result_id=_RESULT_ID,
                title="Source",
                canonical_url="https://example.com/source",
                domain="example.com",
                rank=1,
            )
        ],
    )
    state = StepReplayState(
        generation_id=stable_generation_id(_BUILD_ID, "research/web-search/0"),
        dispatch_phase=Completed,
        request_fingerprint=present(_FINGERPRINT),
        terminal_result=present(encode_step_result(search_result)),
    )
    job = cast(
        "Any",
        SimpleNamespace(
            payload={
                "coordination": {
                    "research/web-search/0": state.model_dump(mode="json"),
                }
            }
        ),
    )

    assert _resolve_build_search_result(job, result_id=_RESULT_ID).canonical_url == (
        "https://example.com/source"
    )
    with pytest.raises(InvalidRequestError, match="not owned by this Dossier build"):
        _resolve_build_search_result(job, result_id="foreign")


def test_page_fetch_omission_never_downgrades_dependency_failure() -> None:
    assert (
        _terminal_omission_reason(
            "E_SOURCE_FETCH_FAILED",
            "HTTP error: 404",
        )
        is WebPageOmissionReason.Gone
    )
    assert _terminal_omission_reason("E_SOURCE_FETCH_FAILED", "Fetch timed out") is None
    assert (
        _terminal_omission_reason(
            "E_SOURCE_FETCH_FAILED",
            "Upstream returned status 503",
        )
        is None
    )


def test_generic_web_source_retries_transient_fetch_failures() -> None:
    assert _is_terminal_source_failure(
        ApiError(ApiErrorCode.E_SOURCE_FETCH_FAILED, "HTTP error: 404"),
        source_type=source_types.GENERIC_WEB_URL,
    )
    assert not _is_terminal_source_failure(
        ApiError(ApiErrorCode.E_SOURCE_FETCH_FAILED, "HTTP error: 503"),
        source_type=source_types.GENERIC_WEB_URL,
    )
    assert not _is_terminal_source_failure(
        ApiError(ApiErrorCode.E_SOURCE_FETCH_FAILED, "Fetch failed: reset"),
        source_type=source_types.GENERIC_WEB_URL,
    )


def test_page_read_follows_exact_canonical_dedupe_winner(monkeypatch) -> None:
    winner_id = UUID("44444444-4444-4444-8444-444444444444")
    monkeypatch.setattr(
        "nexus.services.agent_tools.web_page_read.get_job",
        lambda _db, _job_id: SimpleNamespace(
            status="succeeded",
            result={"superseded_by_media_id": str(winner_id)},
        ),
    )
    monkeypatch.setattr(
        "nexus.services.agent_tools.web_page_read.load_media_document",
        lambda _db, _viewer_id, media_id: (
            DocumentRead(
                media_id=winner_id,
                kind="web_article",
                title="Canonical",
                body="Readable body",
                char_count=13,
            )
            if media_id == winner_id
            else None
        ),
    )

    document = _load_canonical_dedupe_winner(
        cast("Any", object()),
        viewer_id=_USER_ID,
        attempt=cast(
            "Any",
            SimpleNamespace(
                job_id=UUID("55555555-5555-4555-8555-555555555555"),
            ),
        ),
    )

    assert document is not None
    assert document.media_id == winner_id
