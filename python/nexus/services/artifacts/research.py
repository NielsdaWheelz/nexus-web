"""Bounded, replay-safe evidence collection for Idea dossiers.

Seed highlights, up to six Nexus sources from three derived queries, and up to
six fetched web articles (one per domain). Every external step is journaled:
the Nexus and page steps are re-dispatchable, the public web search is billed
once and is never automatically repeated.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Literal
from uuid import UUID

from llm_tools import (
    ExecutionContext,
    HostTable,
    InvocationPosition,
    ParsedJson,
    PositionConflictDefect,
    PositionState,
    Principal,
    ReplayPolicy,
    Reservation,
    RunLimits,
    Scope,
    Settlement,
    ToolExecutor,
    ToolId,
    ToolResult,
    canonical_json_bytes,
)
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import text
from sqlalchemy.orm import Session, sessionmaker

from nexus.db.async_session import open_async_session
from nexus.errors import NotFoundError
from nexus.schemas.presence import Presence, Present, absent, present
from nexus.services.artifacts.collect import EXCERPT_CHARS, Candidate, Collected
from nexus.services.artifacts.coordination import DossierBuildRuntime, ResearchLeaseLost
from nexus.services.artifacts.dossier_types import AudienceScope, WebResearchNotConfigured
from nexus.services.artifacts.idea import IdeaSubject, list_idea_seed_highlight_ids
from nexus.services.artifacts.manifests import (
    IdeaIncludedSource,
    IdeaInputManifestV1,
    IdeaOmittedSource,
    InputManifestV1,
)
from nexus.services.artifacts.web_pages import (
    PageAcceptResult,
    PageReadReceipt,
    PageReadyResult,
    WebPageOmissionReason,
    WebSearchItem,
    WebSearchResult,
    accept_web_search_result,
    observe_web_page,
    read_web_page,
    web_search_items,
)
from nexus.services.durable_step_journal import (
    Completed,
    Prepared,
    StepReplayState,
    Uncertain,
    decode_step_result,
    encode_step_result,
    stable_generation_id,
)
from nexus.services.media_read_map import load_media_document
from nexus.services.resource_graph.refs import ResourceRef, assert_resource_ref
from nexus.services.resource_graph.schemas import CitationSnapshot
from nexus.services.resource_items.capabilities import resource_read_policy
from nexus.services.search.query import SearchKind, SearchQuery
from nexus.services.search.service import search_scopes_async
from nexus.services.tool_runtime.catalog import (
    encode_tool_plan_snapshot,
    validate_tool_plan_snapshot,
)

_SOURCE_TEXT_BUDGET = 120_000
_MAX_NEXUS_RESULTS_PER_QUERY = 6
_MAX_NEXUS_SOURCES = 6
_MAX_WEB_SOURCES = 6
_WEB_SEARCH_TOOL_ID = ToolId("web.search")
_TOOL_PLAN_STEP_PATH = "research/tool-plan"
_NEXUS_RESEARCH_KINDS: frozenset[SearchKind] = frozenset(
    {"documents", "notes", "highlights", "people"}
)
_IDEA_HEADING = "IDEA CONTEXTS AND RESEARCH SOURCES"
_IDEA_CONTEXT = (
    "Teach one coherent idea from foundations through practical examples. "
    "The highlighted seeds establish user context; Nexus and Web Article "
    "sources provide broader evidence. Omitted sources are not evidence."
)

type SourceRole = Literal["seed", "nexus", "web"]


class ResearchInputsChanged(Exception):
    """A completed read receipt no longer resolves to the same visible content."""


class _StepModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)


class NexusSearchItem(_StepModel):
    read_ref: str = Field(min_length=1, max_length=256)
    target_ref: str = Field(min_length=1, max_length=256)
    title: str = Field(min_length=1, max_length=1_000)
    rank: int = Field(ge=1)


class NexusSearchResult(_StepModel):
    query_fingerprint: str = Field(pattern=r"^[0-9a-f]{64}$")
    items: list[NexusSearchItem]


class ResourceReadReceipt(_StepModel):
    read_ref: str = Field(min_length=1, max_length=256)
    target_ref: str = Field(min_length=1, max_length=256)
    title: str = Field(min_length=1, max_length=1_000)
    content_fingerprint: str = Field(pattern=r"^[0-9a-f]{64}$")


@dataclass(frozen=True, slots=True)
class _Source:
    read_ref: ResourceRef
    target_ref: ResourceRef
    title: str
    body: str
    content_fingerprint: str
    role: SourceRole


# ---------------------------------------------------------------------------
# The Idea entry in the binding table.
# ---------------------------------------------------------------------------


async def collect_idea_inputs(
    db: Session,
    subject: object,
    audience: AudienceScope,
    runtime: DossierBuildRuntime,
) -> Collected:
    """Seeds, Nexus sources, and fetched web articles under fixed budgets."""
    del audience
    idea = _require_idea(subject)
    queries = _idea_queries(idea)
    fingerprints = tuple(_sha256(query) for query in queries)
    sources: list[_Source] = []
    omissions: list[IdeaOmittedSource] = []
    seed_refs: list[str] = []
    used_chars = 0
    seen: set[str] = set()

    def include(source: _Source) -> bool:
        nonlocal used_chars
        if source.target_ref.uri in seen:
            return False
        cost = len(source.title) + 1 + len(source.body)
        if used_chars + cost > _SOURCE_TEXT_BUDGET:
            omissions.append(IdeaOmittedSource(locator=source.target_ref.uri, reason="Budget"))
            return False
        used_chars += cost
        seen.add(source.target_ref.uri)
        sources.append(source)
        return True

    for highlight_id in list_idea_seed_highlight_ids(db, artifact_id=runtime.artifact_id):
        seed_ref = ResourceRef(scheme="highlight", id=highlight_id)
        source = _read_source(
            db,
            viewer_id=idea.user_id,
            read_ref=seed_ref,
            target_ref=seed_ref,
            fallback_title=idea.display_title,
            role="seed",
        )
        if source is None:
            raise ResearchInputsChanged
        if include(source):
            seed_refs.append(seed_ref.uri)

    nexus_results = [
        await _redispatchable_step(
            db,
            runtime=runtime,
            path=f"research/nexus-search/{index}",
            request_fingerprint=fingerprints[index],
            schema=NexusSearchResult,
            dispatch=lambda query=query, fingerprint=fingerprints[index]: _nexus_search(
                db, viewer_id=idea.user_id, query=query, query_fingerprint=fingerprint
            ),
        )
        for index, query in enumerate(queries)
    ]
    nexus_items: list[NexusSearchItem] = []
    chosen_targets: set[str] = set()
    for result in nexus_results:
        for item in result.items:
            if item.target_ref in chosen_targets or item.target_ref in seen:
                continue
            chosen_targets.add(item.target_ref)
            nexus_items.append(item)
            if len(nexus_items) == _MAX_NEXUS_SOURCES:
                break
        if len(nexus_items) == _MAX_NEXUS_SOURCES:
            break

    for index, item in enumerate(nexus_items):
        receipt = await _redispatchable_step(
            db,
            runtime=runtime,
            path=f"research/nexus-read/{index}",
            request_fingerprint=_sha256(f"{item.read_ref}\0{item.target_ref}"),
            schema=ResourceReadReceipt,
            dispatch=lambda item=item: _read_nexus_receipt(db, viewer_id=idea.user_id, item=item),
        )
        source = _read_source(
            db,
            viewer_id=idea.user_id,
            read_ref=assert_resource_ref(receipt.read_ref),
            target_ref=assert_resource_ref(receipt.target_ref),
            fallback_title=receipt.title,
            role="nexus",
        )
        if source is None or source.content_fingerprint != receipt.content_fingerprint:
            raise ResearchInputsChanged
        include(source)

    _ensure_research_tool_plan(db, runtime=runtime)
    web_results = [
        await _web_search_step(
            db,
            runtime=runtime,
            path=f"research/web-search/{index}",
            principal=Principal(str(idea.user_id)),
            query=query,
            request_fingerprint=fingerprints[index],
        )
        for index, query in enumerate(queries)
    ]
    for index, item in enumerate(_select_web_items(web_results)):
        accepted = await _redispatchable_step(
            db,
            runtime=runtime,
            path=f"research/page-accept/{index}",
            request_fingerprint=_sha256(f"{item.result_id}\0{item.canonical_url}"),
            schema=PageAcceptResult,
            dispatch=lambda item=item: _accept_page(
                db, viewer_id=idea.user_id, runtime=runtime, result_id=item.result_id
            ),
        )
        if accepted.status == "Omitted":
            omissions.append(
                IdeaOmittedSource(locator=item.result_id, reason=_reason(accepted.omission_reason))
            )
            continue
        ready = _observe_page_step(db, runtime=runtime, index=index, accepted=accepted)
        if ready.status == "Omitted":
            omissions.append(
                IdeaOmittedSource(locator=item.result_id, reason=_reason(ready.omission_reason))
            )
            continue
        receipt = await _redispatchable_step(
            db,
            runtime=runtime,
            path=f"research/page-read/{index}",
            request_fingerprint=_sha256(encode_step_result(accepted)),
            schema=PageReadReceipt,
            dispatch=lambda accepted=accepted: _read_page_receipt(
                db, viewer_id=idea.user_id, accepted=accepted
            ),
        )
        media_ref = assert_resource_ref(receipt.media_ref)
        document = load_media_document(db, idea.user_id, media_ref.id)
        if document is None or _sha256(document.body) != receipt.content_fingerprint:
            raise ResearchInputsChanged
        include(
            _Source(
                read_ref=media_ref,
                target_ref=media_ref,
                title=receipt.title,
                body=document.body,
                content_fingerprint=receipt.content_fingerprint,
                role="web",
            )
        )

    return Collected(
        candidates=[_candidate(index, source) for index, source in enumerate(sources)],
        manifest=IdeaInputManifestV1(
            idea_subject_id=str(idea.id),
            included_seed_refs=seed_refs,
            nexus_query_fingerprints=list(fingerprints),
            web_query_fingerprints=list(fingerprints),
            included_sources=[
                IdeaIncludedSource(
                    ref=source.read_ref.uri,
                    content_fingerprint=source.content_fingerprint,
                    role=source.role,
                )
                for source in sources
            ],
            omitted_sources=omissions,
        ),
        heading=_IDEA_HEADING,
        context=_IDEA_CONTEXT,
    )


def idea_evidence_is_current(
    db: Session,
    subject: object,
    audience: AudienceScope,
    collected: Collected,
) -> bool:
    """Recheck only the frozen sources; later seeds are irrelevant to this build."""
    del audience
    idea = _require_idea(subject)
    manifest = collected.manifest
    if not isinstance(manifest, IdeaInputManifestV1):
        raise AssertionError("an Idea dossier has the wrong manifest")
    # ``included_sources`` and ``candidates`` are both built from the frozen
    # source list in order: index i is one source's read ref and cited target.
    for source, candidate in zip(manifest.included_sources, collected.candidates, strict=True):
        current = _read_source(
            db,
            viewer_id=idea.user_id,
            read_ref=assert_resource_ref(source.ref),
            target_ref=candidate.target,
            fallback_title=candidate.snapshot.title or "",
            role=source.role,
        )
        if current is None or current.content_fingerprint != source.content_fingerprint:
            return False
    return True


def idea_live_manifest(db: Session, subject: object, audience: AudienceScope) -> InputManifestV1:
    """The stored manifest with every source's fingerprint re-read live."""
    del audience
    idea = _require_idea(subject)
    raw = db.execute(
        text(
            "SELECT r.input_manifest FROM artifacts a "
            "JOIN artifact_revisions r ON r.id = a.current_revision_id "
            "WHERE a.subject_scheme = 'idea' AND a.subject_id = :subject_id "
            "AND a.audience_scheme = 'user' AND a.audience_id = :audience_id"
        ),
        {"subject_id": idea.id, "audience_id": str(idea.user_id)},
    ).scalar_one_or_none()
    if not isinstance(raw, dict):
        raise NotFoundError(message="Dossier not found")
    stored = IdeaInputManifestV1.model_validate(raw)
    refreshed: list[IdeaIncludedSource] = []
    for source in stored.included_sources:
        ref = assert_resource_ref(source.ref)
        current = _read_source(
            db,
            viewer_id=idea.user_id,
            read_ref=ref,
            target_ref=ref,
            fallback_title="",
            role=source.role,
        )
        # A SHA-256 fingerprint is never empty, so disappearance differs.
        refreshed.append(
            source.model_copy(
                update={
                    "content_fingerprint": (
                        current.content_fingerprint if current is not None else ""
                    )
                }
            )
        )
    return stored.model_copy(update={"included_sources": refreshed})


# ---------------------------------------------------------------------------
# Journaled steps.
# ---------------------------------------------------------------------------


async def _redispatchable_step[T: BaseModel](
    db: Session,
    *,
    runtime: DossierBuildRuntime,
    path: str,
    request_fingerprint: str,
    schema: type[T],
    dispatch: Callable[[], Awaitable[T]],
) -> T:
    state = _step_state(db, runtime=runtime, path=path, request_fingerprint=request_fingerprint)
    if state.dispatch_phase is Completed:
        return decode_step_result(_terminal(state, path), schema)

    uncertain = state.model_copy(update={"dispatch_phase": Uncertain})
    _checkpoint(db, runtime=runtime, path=path, state=uncertain)
    result = await dispatch()
    _checkpoint(
        db,
        runtime=runtime,
        path=path,
        state=uncertain.model_copy(
            update={
                "dispatch_phase": Completed,
                "terminal_result": present(encode_step_result(result)),
            }
        ),
    )
    return result


def _step_state(
    db: Session,
    *,
    runtime: DossierBuildRuntime,
    path: str,
    request_fingerprint: str,
) -> StepReplayState:
    """This step's journal record, prepared on first sight and never drifting."""
    generation_id = stable_generation_id(runtime.build_id, path)
    state = runtime.read_step(path)
    if state is None:
        state = StepReplayState(
            generation_id=generation_id,
            dispatch_phase=Prepared,
            request_fingerprint=present(request_fingerprint),
            terminal_result=absent(),
        )
        _checkpoint(db, runtime=runtime, path=path, state=state)
        return state
    if state.generation_id != generation_id:
        raise AssertionError(f"Dossier research step {path!r} changed identity")
    if (
        not isinstance(state.request_fingerprint, Present)
        or state.request_fingerprint.value != request_fingerprint
    ):
        raise ResearchInputsChanged
    return state


def _terminal(state: StepReplayState, path: str) -> str:
    if not isinstance(state.terminal_result, Present):
        raise AssertionError(f"Completed Dossier step {path!r} has no result")
    return state.terminal_result.value


def _checkpoint(
    db: Session, *, runtime: DossierBuildRuntime, path: str, state: StepReplayState
) -> None:
    if not runtime.checkpoint_step(db, path=path, state=state):
        db.rollback()
        raise ResearchLeaseLost
    db.commit()


def _ensure_research_tool_plan(db: Session, *, runtime: DossierBuildRuntime) -> None:
    operation = runtime.research_tool_operation
    if not isinstance(operation.plan.exposure, HostTable):
        raise AssertionError("Idea Dossier research requires a HostTable tool plan")
    generation_id = stable_generation_id(runtime.build_id, _TOOL_PLAN_STEP_PATH)
    state = runtime.read_step(_TOOL_PLAN_STEP_PATH)
    if state is not None:
        if (
            state.generation_id != generation_id
            or state.dispatch_phase is not Completed
            or not isinstance(state.request_fingerprint, Present)
            or state.request_fingerprint.value != operation.plan.plan_revision
            or not isinstance(state.terminal_result, Present)
        ):
            raise AssertionError("Dossier research tool-plan snapshot changed identity")
        validate_tool_plan_snapshot(state.terminal_result.value, operation=operation)
        return
    _checkpoint(
        db,
        runtime=runtime,
        path=_TOOL_PLAN_STEP_PATH,
        state=StepReplayState(
            generation_id=generation_id,
            dispatch_phase=Completed,
            request_fingerprint=present(operation.plan.plan_revision),
            terminal_result=present(encode_tool_plan_snapshot(operation)),
        ),
    )


class _ResearchBudget:
    """The run budget for one fixed research step; the plan caps calls at three."""

    def __init__(self, *, limits: RunLimits, remaining_elapsed_seconds: float) -> None:
        self.limits = limits
        self.remaining_elapsed_seconds = remaining_elapsed_seconds

    async def reserve(self, position: InvocationPosition, reservation: Reservation) -> bool:
        del position, reservation
        return True

    async def settle(self, position: InvocationPosition, settlement: Settlement) -> None:
        del position, settlement


class _ResearchRecorder:
    """In-process recorder for one fixed ``BilledOnce`` step.

    The step journal owns durability: :func:`_web_search_step` checkpoints
    Prepared -> Uncertain -> Completed around this recorder, which only
    satisfies the portable executor's phase protocol and reports whether the
    dispatch outcome stayed uncertain.
    """

    def __init__(self, *, position: InvocationPosition, budgets: _ResearchBudget) -> None:
        self.position = position
        self.budgets = budgets
        self.uncertain_outcome = False
        self.durable = True

    async def occupy(self, **kwargs: Any) -> PositionState:
        del kwargs
        return PositionState(terminal_result=None, uncertain=False, actual_attempts=0)

    async def reserve(self, **kwargs: Any) -> bool:
        del kwargs
        return True

    async def dispatch_started(self, **kwargs: Any) -> PositionState:
        del kwargs
        return PositionState(terminal_result=None, uncertain=False, actual_attempts=0)

    async def dispatch_abandoned(self, **kwargs: Any) -> None:
        raise AssertionError("Idea research never re-admits an abandoned dispatch")

    async def uncertain(self, *, position: InvocationPosition) -> None:
        del position
        self.uncertain_outcome = True

    async def terminalize_and_settle(self, *, result: ToolResult, **kwargs: Any) -> ToolResult:
        del kwargs
        return result


class _InertToolSeams:
    """The cancellation and telemetry seams this one fixed step does not use."""

    cancelled = False

    def event(self, name: str, attributes: dict[str, object]) -> None:
        del name, attributes


async def _web_search_step(
    db: Session,
    *,
    runtime: DossierBuildRuntime,
    path: str,
    principal: Principal,
    query: str,
    request_fingerprint: str,
) -> WebSearchResult:
    """Run one public web search once; an uncertain outcome is never redispatched."""
    operation = runtime.research_tool_operation
    binding = operation.plan.catalog_view.binding(_WEB_SEARCH_TOOL_ID)
    if binding.replay_policy is not ReplayPolicy.BilledOnce:
        raise AssertionError("Idea research Web search must remain BilledOnce")
    db.commit()
    state = _step_state(db, runtime=runtime, path=path, request_fingerprint=request_fingerprint)
    if state.dispatch_phase is Completed:
        return _web_search_result(_terminal(state, path), runtime, request_fingerprint)
    if state.dispatch_phase is Uncertain:
        # A billed public-Web search is never automatically redispatched.
        raise ResearchInputsChanged
    _checkpoint(
        db,
        runtime=runtime,
        path=path,
        state=state.model_copy(update={"dispatch_phase": Uncertain}),
    )

    limits = operation.profile.run_limits
    started_at = runtime.job.started_at or runtime.job.created_at
    if started_at.tzinfo is None:
        started_at = started_at.replace(tzinfo=UTC)
    elapsed = (datetime.now(UTC) - started_at).total_seconds()
    recorder = _ResearchRecorder(
        position=InvocationPosition(path),
        budgets=_ResearchBudget(
            limits=limits,
            remaining_elapsed_seconds=max(0.0, float(limits.max_elapsed_seconds) - elapsed),
        ),
    )
    seams = _InertToolSeams()
    try:
        result = await ToolExecutor.execute(
            binding,
            ParsedJson({"query": query, "freshness_days": None}),
            ExecutionContext(
                plan=operation.plan,
                grant=operation.plan.grant(_WEB_SEARCH_TOOL_ID),
                catalog_view=operation.plan.catalog_view,
                position=recorder.position,
                recorder=recorder,
                effect_id=None,
                budgets=recorder.budgets,
                principal=principal,
                scope=Scope("idea_dossier_research"),
                cancellation=seams,
                telemetry=seams,
            ),
        )
    except PositionConflictDefect as exc:
        # With the frozen plan already validated, a conflict at this fixed
        # position means the Idea-derived query changed after occupation.
        raise ResearchInputsChanged from exc
    if recorder.uncertain_outcome:
        raise ResearchInputsChanged

    terminal = canonical_json_bytes(result).decode("utf-8")
    _checkpoint(
        db,
        runtime=runtime,
        path=path,
        state=state.model_copy(
            update={"dispatch_phase": Completed, "terminal_result": present(terminal)}
        ),
    )
    return _web_search_result(terminal, runtime, request_fingerprint)


def _web_search_result(
    terminal: str, runtime: DossierBuildRuntime, request_fingerprint: str
) -> WebSearchResult:
    decoded = json.loads(terminal)
    if decoded.get("type") != "Success":
        error = decoded.get("error")
        error_type = error.get("type") if isinstance(error, dict) else None
        if error_type == "ToolUnavailable":
            raise WebResearchNotConfigured()
        raise RuntimeError(f"Dossier Web search failed: {error_type or 'InvalidToolResult'}")
    return WebSearchResult(
        query_fingerprint=request_fingerprint,
        items=list(web_search_items(terminal, build_id=runtime.build_id)),
    )


def _observe_page_step(
    db: Session,
    *,
    runtime: DossierBuildRuntime,
    index: int,
    accepted: PageAcceptResult,
) -> PageReadyResult:
    path = f"research/page-ready/{index}"
    fingerprint = _sha256(encode_step_result(accepted))
    state = runtime.read_step(path)
    if state is not None and state.dispatch_phase is Completed:
        if (
            not isinstance(state.request_fingerprint, Present)
            or state.request_fingerprint.value != fingerprint
        ):
            raise ResearchInputsChanged
        return decode_step_result(_terminal(state, path), PageReadyResult)

    observed = observe_web_page(db, accepted=accepted)
    if observed.status == "Pending":
        if not isinstance(accepted.ready_deadline, Present):
            raise AssertionError("accepted page has no readiness deadline")
        runtime.yield_until(accepted.ready_deadline.value)
    _checkpoint(
        db,
        runtime=runtime,
        path=path,
        state=StepReplayState(
            generation_id=stable_generation_id(runtime.build_id, path),
            dispatch_phase=Completed,
            request_fingerprint=present(fingerprint),
            terminal_result=present(encode_step_result(observed)),
        ),
    )
    return observed


# ---------------------------------------------------------------------------
# Dispatches.
# ---------------------------------------------------------------------------


async def _nexus_search(
    db: Session, *, viewer_id: UUID, query: str, query_fingerprint: str
) -> NexusSearchResult:
    if db.in_transaction():
        raise RuntimeError("research search requires its committed dispatch checkpoint")
    prepared = SearchQuery(
        text=query,
        requested_kinds=_NEXUS_RESEARCH_KINDS,
        limit=_MAX_NEXUS_RESULTS_PER_QUERY,
    )
    async with open_async_session(sessionmaker(bind=db.get_bind())) as database:
        response = await search_scopes_async(database, viewer_id, prepared, (prepared.scope,))
    return NexusSearchResult(
        query_fingerprint=query_fingerprint,
        items=[
            NexusSearchItem(
                read_ref=result.resource_ref,
                target_ref=result.citation_target,
                title=result.title,
                rank=rank,
            )
            for rank, result in enumerate(response.results, start=1)
            if result.citation_target is not None
        ],
    )


async def _read_nexus_receipt(
    db: Session, *, viewer_id: UUID, item: NexusSearchItem
) -> ResourceReadReceipt:
    source = _read_source(
        db,
        viewer_id=viewer_id,
        read_ref=assert_resource_ref(item.read_ref),
        target_ref=assert_resource_ref(item.target_ref),
        fallback_title=item.title,
        role="nexus",
    )
    if source is None:
        raise ResearchInputsChanged
    return ResourceReadReceipt(
        read_ref=source.read_ref.uri,
        target_ref=source.target_ref.uri,
        title=source.title,
        content_fingerprint=source.content_fingerprint,
    )


async def _accept_page(
    db: Session, *, viewer_id: UUID, runtime: DossierBuildRuntime, result_id: str
) -> PageAcceptResult:
    return accept_web_search_result(
        db,
        viewer_id=viewer_id,
        build_id=runtime.build_id,
        job=runtime.job,
        result_id=result_id,
    )


async def _read_page_receipt(
    db: Session, *, viewer_id: UUID, accepted: PageAcceptResult
) -> PageReadReceipt:
    return read_web_page(db, viewer_id=viewer_id, accepted=accepted).receipt


# ---------------------------------------------------------------------------
# Source reading.
# ---------------------------------------------------------------------------


def _read_source(
    db: Session,
    *,
    viewer_id: UUID,
    read_ref: ResourceRef,
    target_ref: ResourceRef,
    fallback_title: str,
    role: SourceRole,
) -> _Source | None:
    from nexus.services.resource_graph.resolve import load_resource_batch

    if target_ref != read_ref:
        target = load_resource_batch(db, [target_ref], viewer_id=viewer_id)[target_ref.uri]
        if target.missing:
            return None
    if resource_read_policy(read_ref) == "media":
        document = load_media_document(db, viewer_id, read_ref.id)
        if document is None:
            return None
        title, body = document.title, document.body
    else:
        loaded = load_resource_batch(db, [read_ref], viewer_id=viewer_id)[read_ref.uri]
        if loaded.missing:
            return None
        if loaded.quote is not None:
            quote = loaded.quote
            title = quote.source_label
            body = "\n".join(
                part for part in (quote.prefix, quote.exact, quote.suffix, quote.note or "") if part
            )
        else:
            title = loaded.title or fallback_title
            body = loaded.body or ""
    if not body.strip():
        return None
    return _Source(
        read_ref=read_ref,
        target_ref=target_ref,
        title=title or fallback_title or "Untitled",
        body=body,
        content_fingerprint=_sha256(body),
        role=role,
    )


def _select_web_items(results: list[WebSearchResult]) -> list[WebSearchItem]:
    selected: list[WebSearchItem] = []
    seen_urls: set[str] = set()
    seen_domains: set[str] = set()
    for result in results:
        for item in sorted(result.items, key=lambda value: value.rank):
            if item.canonical_url in seen_urls or item.domain in seen_domains:
                continue
            seen_urls.add(item.canonical_url)
            seen_domains.add(item.domain)
            selected.append(item)
            if len(selected) == _MAX_WEB_SOURCES:
                return selected
    return selected


def _candidate(index: int, source: _Source) -> Candidate:
    return Candidate(
        index=index,
        target=source.target_ref,
        text=f"{source.title}\n{source.body}",
        snapshot=CitationSnapshot(
            title=source.title,
            excerpt=source.body[:EXCERPT_CHARS],
            result_type=source.target_ref.scheme,
        ),
    )


def _idea_queries(idea: IdeaSubject) -> tuple[str, str, str]:
    disambiguator = idea.idea_key.disambiguator_key
    base = (
        f"{idea.display_title} {disambiguator.value}"
        if isinstance(disambiguator, Present)
        else idea.display_title
    )
    return (base, f"{base} explained", f"{base} examples")


def _require_idea(subject: object) -> IdeaSubject:
    if not isinstance(subject, IdeaSubject):
        raise AssertionError("the Idea dossier binding received a Resource subject")
    return subject


def _reason(omission: Presence[WebPageOmissionReason]) -> str:
    if not isinstance(omission, Present):
        raise AssertionError("an omitted Web page has no reason")
    return omission.value.value


def _sha256(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()
