"""Bounded, replay-safe evidence collection for Idea Dossiers."""

from __future__ import annotations

import hashlib
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import TYPE_CHECKING, Literal
from urllib.parse import urlparse
from uuid import UUID, uuid5

from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.orm import Session
from web_search_tool.types import WebSearchProvider

from nexus.errors import InvalidRequestError
from nexus.jobs.queue import JobRow
from nexus.schemas.presence import Present, absent, present
from nexus.services.agent_tools.web_page_read import (
    PageAcceptResult,
    PageReadReceipt,
    PageReadyResult,
    ReadWebPage,
    WebSearchItem,
    WebSearchResult,
    accept_web_search_result,
    observe_web_page,
    read_web_page,
)
from nexus.services.agent_tools.web_search import search_web_readonly
from nexus.services.artifacts.coordination import (
    Completed,
    DossierBuildRuntime,
    Prepared,
    ReplayPolicy,
    StepReplayState,
    Uncertain,
    decode_step_result,
    encode_step_result,
    stable_generation_id,
)
from nexus.services.artifacts.idea_seeds import list_idea_seed_highlight_ids
from nexus.services.artifacts.subject_policy import ResolvedIdeaSubject
from nexus.services.media_read_map import load_media_document
from nexus.services.resource_graph.refs import (
    ResourceRef,
    ResourceRefParseFailure,
    parse_resource_ref,
)
from nexus.services.resource_graph.resolve import load_resource_batch
from nexus.services.resource_graph.schemas import CitationSnapshot
from nexus.services.resource_items.capabilities import resource_read_policy
from nexus.services.search import search
from nexus.services.search.kinds import SearchKind
from nexus.services.search.query import SearchQuery
from nexus.services.url_normalize import normalize_url_for_display, validate_requested_url

if TYPE_CHECKING:
    from nexus.services.artifacts.bindings._shared import Candidate

_SOURCE_TEXT_BUDGET = 120_000
_MAX_NEXUS_RESULTS_PER_QUERY = 6
_MAX_WEB_RESULTS_PER_QUERY = 6
_MAX_NEXUS_SOURCES = 6
_MAX_WEB_SOURCES = 6
_NEXUS_RESEARCH_KINDS: frozenset[SearchKind] = frozenset(
    {"documents", "notes", "highlights", "people"}
)


class _StrictStepResult(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)


class NexusSearchItem(_StrictStepResult):
    read_ref: str = Field(min_length=1, max_length=256)
    target_ref: str = Field(min_length=1, max_length=256)
    title: str = Field(min_length=1, max_length=1_000)
    rank: int = Field(ge=1)


class NexusSearchResult(_StrictStepResult):
    query_fingerprint: str = Field(pattern=r"^[0-9a-f]{64}$")
    items: list[NexusSearchItem]


class ResourceReadReceipt(_StrictStepResult):
    read_ref: str = Field(min_length=1, max_length=256)
    target_ref: str = Field(min_length=1, max_length=256)
    title: str = Field(min_length=1, max_length=1_000)
    content_fingerprint: str = Field(pattern=r"^[0-9a-f]{64}$")


@dataclass(frozen=True, slots=True)
class ResearchSource:
    read_ref: ResourceRef
    target_ref: ResourceRef
    title: str
    body: str
    content_fingerprint: str
    role: Literal["seed", "nexus", "web"]

    def candidate(self, index: int) -> Candidate:
        from nexus.services.artifacts.bindings._shared import Candidate

        return Candidate(
            index=index,
            target=self.target_ref,
            text=f"{self.title}\n{self.body}",
            snapshot=CitationSnapshot(
                title=self.title,
                excerpt=self.body[:600],
                result_type=self.target_ref.scheme,
            ),
        )


@dataclass(frozen=True, slots=True)
class ResearchOmission:
    locator: str
    reason: str


@dataclass(frozen=True, slots=True)
class FrozenIdeaEvidence:
    idea_subject_id: UUID
    included_seed_refs: tuple[str, ...]
    nexus_query_fingerprints: tuple[str, ...]
    web_query_fingerprints: tuple[str, ...]
    sources: tuple[ResearchSource, ...]
    omissions: tuple[ResearchOmission, ...]

    @property
    def candidates(self) -> list[Candidate]:
        return [source.candidate(index) for index, source in enumerate(self.sources)]


class ResearchInputsChanged(Exception):
    """A completed read receipt no longer resolves to the same visible content."""


class ResearchLeaseLost(Exception):
    """The Dossier job lost its lease while checkpointing a research step."""


async def collect_idea_evidence(
    db: Session,
    *,
    resolved: ResolvedIdeaSubject,
    runtime: DossierBuildRuntime,
) -> FrozenIdeaEvidence:
    """Collect seeds, Nexus sources, and fetched Web Articles under fixed budgets."""

    queries = idea_research_queries(resolved)
    query_fingerprints = tuple(_fingerprint(query) for query in queries)
    sources: list[ResearchSource] = []
    omissions: list[ResearchOmission] = []
    used_chars = 0
    seen_targets: set[str] = set()

    def include(source: ResearchSource) -> bool:
        nonlocal used_chars
        if source.target_ref.uri in seen_targets:
            return False
        source_chars = len(source.title) + 1 + len(source.body)
        if used_chars + source_chars > _SOURCE_TEXT_BUDGET:
            omissions.append(ResearchOmission(source.target_ref.uri, "Budget"))
            return False
        used_chars += source_chars
        seen_targets.add(source.target_ref.uri)
        sources.append(source)
        return True

    included_seed_refs: list[str] = []
    for highlight_id in list_idea_seed_highlight_ids(db, artifact_id=runtime.artifact_id):
        seed_ref = ResourceRef(scheme="highlight", id=highlight_id)
        source = _read_source(
            db,
            viewer_id=resolved.user_id,
            read_ref=seed_ref,
            target_ref=seed_ref,
            fallback_title=resolved.display_title,
            role="seed",
        )
        if source is None:
            raise ResearchInputsChanged
        if include(source):
            included_seed_refs.append(seed_ref.uri)

    nexus_results = [
        await _redispatchable_step(
            db,
            runtime=runtime,
            path=f"research/nexus-search/{index}",
            request_fingerprint=query_fingerprints[index],
            schema=NexusSearchResult,
            dispatch=lambda query=query, fingerprint=query_fingerprints[index]: _nexus_search(
                db,
                viewer_id=resolved.user_id,
                query=query,
                query_fingerprint=fingerprint,
            ),
        )
        for index, query in enumerate(queries)
    ]
    nexus_items: list[NexusSearchItem] = []
    seen_nexus: set[str] = set()
    for result in nexus_results:
        for item in result.items:
            if item.target_ref in seen_nexus or item.target_ref in seen_targets:
                continue
            seen_nexus.add(item.target_ref)
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
            request_fingerprint=_fingerprint(f"{item.read_ref}\0{item.target_ref}"),
            schema=ResourceReadReceipt,
            dispatch=lambda item=item: _read_nexus_receipt(
                db,
                viewer_id=resolved.user_id,
                item=item,
            ),
        )
        source = _hydrate_resource_receipt(
            db,
            viewer_id=resolved.user_id,
            receipt=receipt,
            role="nexus",
        )
        include(source)

    provider = _web_search_provider(runtime)
    web_results = [
        await _redispatchable_step(
            db,
            runtime=runtime,
            path=f"research/web-search/{index}",
            request_fingerprint=query_fingerprints[index],
            schema=WebSearchResult,
            dispatch=lambda query=query, fingerprint=query_fingerprints[index]: _web_search(
                provider,
                build_id=runtime.build_id,
                query=query,
                query_fingerprint=fingerprint,
            ),
        )
        for index, query in enumerate(queries)
    ]
    web_items = _select_web_items(web_results)
    for index, item in enumerate(web_items):
        accepted = await _redispatchable_step(
            db,
            runtime=runtime,
            path=f"research/page-accept/{index}",
            request_fingerprint=_fingerprint(f"{item.result_id}\0{item.canonical_url}"),
            schema=PageAcceptResult,
            dispatch=lambda item=item: _accept_page(
                db,
                viewer_id=resolved.user_id,
                build_id=runtime.build_id,
                job=runtime.job,
                result_id=item.result_id,
            ),
        )
        if accepted.status == "Omitted":
            if not isinstance(accepted.omission_reason, Present):
                raise AssertionError("omitted Web page has no reason")
            omissions.append(ResearchOmission(item.result_id, accepted.omission_reason.value.value))
            continue
        ready = _observe_page_step(
            db,
            runtime=runtime,
            index=index,
            accepted=accepted,
        )
        if ready.status == "Omitted":
            if not isinstance(ready.omission_reason, Present):
                raise AssertionError("omitted Web page has no reason")
            omissions.append(ResearchOmission(item.result_id, ready.omission_reason.value.value))
            continue
        receipt = await _complete_page_read_step(
            db,
            runtime=runtime,
            viewer_id=resolved.user_id,
            index=index,
            accepted=accepted,
        )
        hydrated = _hydrate_page_receipt(
            db,
            viewer_id=resolved.user_id,
            receipt=receipt,
        )
        include(
            ResearchSource(
                read_ref=_parse_owned_ref(receipt.media_ref),
                target_ref=_parse_owned_ref(receipt.media_ref),
                title=receipt.title,
                body=hydrated.body,
                content_fingerprint=receipt.content_fingerprint,
                role="web",
            )
        )

    return FrozenIdeaEvidence(
        idea_subject_id=resolved.subject_id,
        included_seed_refs=tuple(included_seed_refs),
        nexus_query_fingerprints=query_fingerprints,
        web_query_fingerprints=query_fingerprints,
        sources=tuple(sources),
        omissions=tuple(omissions),
    )


def idea_research_queries(resolved: ResolvedIdeaSubject) -> tuple[str, str, str]:
    disambiguator = resolved.idea_key.disambiguator_key
    base = (
        f"{resolved.display_title} {disambiguator.value}"
        if isinstance(disambiguator, Present)
        else resolved.display_title
    )
    return (base, f"{base} explained", f"{base} examples")


def evidence_is_current(
    db: Session,
    *,
    viewer_id: UUID,
    evidence: FrozenIdeaEvidence,
) -> bool:
    """Recheck only the frozen seed/source witness; later seeds are irrelevant."""

    for source in evidence.sources:
        current = _read_source(
            db,
            viewer_id=viewer_id,
            read_ref=source.read_ref,
            target_ref=source.target_ref,
            fallback_title=source.title,
            role=source.role,
        )
        if current is None or current.content_fingerprint != source.content_fingerprint:
            return False
    return True


def current_research_source_fingerprint(
    db: Session,
    *,
    viewer_id: UUID,
    ref: ResourceRef,
) -> str | None:
    """Read one persisted manifest source through the same audience boundary."""

    source = _read_source(
        db,
        viewer_id=viewer_id,
        read_ref=ref,
        target_ref=ref,
        fallback_title="",
        role="nexus",
    )
    return source.content_fingerprint if source is not None else None


async def _redispatchable_step[T: BaseModel](
    db: Session,
    *,
    runtime: DossierBuildRuntime,
    path: str,
    request_fingerprint: str,
    schema: type[T],
    dispatch: Callable[[], Awaitable[T]],
) -> T:
    state = runtime.read_step(path, ReplayPolicy.ReDispatchable)
    generation_id = stable_generation_id(runtime.build_id, path)
    if state is not None:
        if state.generation_id != generation_id:
            raise AssertionError(f"Dossier research step {path!r} changed identity")
        if (
            not isinstance(state.request_fingerprint, Present)
            or state.request_fingerprint.value != request_fingerprint
        ):
            raise ResearchInputsChanged
        if state.dispatch_phase is Completed:
            if not isinstance(state.terminal_result, Present):
                raise AssertionError(f"Completed Dossier step {path!r} has no result")
            return decode_step_result(state.terminal_result.value, schema)
    else:
        state = StepReplayState(
            generation_id=generation_id,
            dispatch_phase=Prepared,
            request_fingerprint=present(request_fingerprint),
            terminal_result=absent(),
        )
        if not runtime.checkpoint_step(db, path=path, state=state):
            db.rollback()
            raise ResearchLeaseLost
        db.commit()

    uncertain = state.model_copy(update={"dispatch_phase": Uncertain})
    if not runtime.checkpoint_step(db, path=path, state=uncertain):
        db.rollback()
        raise ResearchLeaseLost
    db.commit()
    result = await dispatch()
    completed = uncertain.model_copy(
        update={
            "dispatch_phase": Completed,
            "terminal_result": present(encode_step_result(result)),
        }
    )
    if not runtime.checkpoint_step(db, path=path, state=completed):
        db.rollback()
        raise ResearchLeaseLost
    db.commit()
    return result


async def _nexus_search(
    db: Session,
    *,
    viewer_id: UUID,
    query: str,
    query_fingerprint: str,
) -> NexusSearchResult:
    response = search(
        db,
        viewer_id,
        SearchQuery(
            text=query,
            requested_kinds=_NEXUS_RESEARCH_KINDS,
            limit=_MAX_NEXUS_RESULTS_PER_QUERY,
        ),
    )
    items: list[NexusSearchItem] = []
    for rank, result in enumerate(response.results, start=1):
        if result.citation_target is None:
            continue
        items.append(
            NexusSearchItem(
                read_ref=result.resource_ref,
                target_ref=result.citation_target,
                title=result.title,
                rank=rank,
            )
        )
    return NexusSearchResult(query_fingerprint=query_fingerprint, items=items)


async def _web_search(
    provider: WebSearchProvider,
    *,
    build_id: UUID,
    query: str,
    query_fingerprint: str,
) -> WebSearchResult:
    result = await search_web_readonly(provider, query, freshness_days=None)
    items: list[WebSearchItem] = []
    for citation in result.citations[:_MAX_WEB_RESULTS_PER_QUERY]:
        try:
            validate_requested_url(citation.url)
        except (InvalidRequestError, ValueError):
            # Preserve invalid provider output for the acceptance owner to reject
            # and model as Unsupported/SSRFBlocked; never repair it into a URL.
            canonical_url = citation.url
        else:
            canonical_url = normalize_url_for_display(citation.url)
        try:
            domain = (urlparse(canonical_url).hostname or "").lower()
        except ValueError:
            domain = ""
        items.append(
            WebSearchItem(
                result_id=uuid5(build_id, canonical_url).hex,
                title=citation.title,
                canonical_url=canonical_url,
                domain=domain,
                rank=citation.rank,
            )
        )
    return WebSearchResult(query_fingerprint=query_fingerprint, items=items)


async def _read_nexus_receipt(
    db: Session,
    *,
    viewer_id: UUID,
    item: NexusSearchItem,
) -> ResourceReadReceipt:
    source = _read_source(
        db,
        viewer_id=viewer_id,
        read_ref=_parse_owned_ref(item.read_ref),
        target_ref=_parse_owned_ref(item.target_ref),
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


def _hydrate_resource_receipt(
    db: Session,
    *,
    viewer_id: UUID,
    receipt: ResourceReadReceipt,
    role: Literal["seed", "nexus", "web"],
) -> ResearchSource:
    source = _read_source(
        db,
        viewer_id=viewer_id,
        read_ref=_parse_owned_ref(receipt.read_ref),
        target_ref=_parse_owned_ref(receipt.target_ref),
        fallback_title=receipt.title,
        role=role,
    )
    if source is None or source.content_fingerprint != receipt.content_fingerprint:
        raise ResearchInputsChanged
    return source


async def _accept_page(
    db: Session,
    *,
    viewer_id: UUID,
    build_id: UUID,
    job: JobRow,
    result_id: str,
) -> PageAcceptResult:
    return accept_web_search_result(
        db,
        viewer_id=viewer_id,
        build_id=build_id,
        job=job,
        result_id=result_id,
    )


def _observe_page_step(
    db: Session,
    *,
    runtime: DossierBuildRuntime,
    index: int,
    accepted: PageAcceptResult,
) -> PageReadyResult:
    path = f"research/page-ready/{index}"
    fingerprint = _fingerprint(encode_step_result(accepted))
    state = runtime.read_step(path, ReplayPolicy.ReDispatchable)
    if state is not None and state.dispatch_phase is Completed:
        if (
            not isinstance(state.request_fingerprint, Present)
            or state.request_fingerprint.value != fingerprint
            or not isinstance(state.terminal_result, Present)
        ):
            raise ResearchInputsChanged
        ready = decode_step_result(state.terminal_result.value, PageReadyResult)
        if ready.status == "Pending":
            raise AssertionError("completed page-ready step cannot remain Pending")
        return ready

    observed = observe_web_page(db, accepted=accepted)
    if observed.status == "Pending":
        if not isinstance(accepted.ready_deadline, Present):
            raise AssertionError("accepted page has no readiness deadline")
        runtime.yield_until(accepted.ready_deadline.value)
    completed = StepReplayState(
        generation_id=stable_generation_id(runtime.build_id, path),
        dispatch_phase=Completed,
        request_fingerprint=present(fingerprint),
        terminal_result=present(encode_step_result(observed)),
    )
    if not runtime.checkpoint_step(db, path=path, state=completed):
        db.rollback()
        raise ResearchLeaseLost
    db.commit()
    return observed


async def _complete_page_read_step(
    db: Session,
    *,
    runtime: DossierBuildRuntime,
    viewer_id: UUID,
    index: int,
    accepted: PageAcceptResult,
) -> PageReadReceipt:
    return await _redispatchable_step(
        db,
        runtime=runtime,
        path=f"research/page-read/{index}",
        request_fingerprint=_fingerprint(encode_step_result(accepted)),
        schema=PageReadReceipt,
        dispatch=lambda: _read_page_receipt(
            db,
            viewer_id=viewer_id,
            accepted=accepted,
        ),
    )


async def _read_page_receipt(
    db: Session,
    *,
    viewer_id: UUID,
    accepted: PageAcceptResult,
) -> PageReadReceipt:
    return read_web_page(db, viewer_id=viewer_id, accepted=accepted).receipt


def _hydrate_page_receipt(
    db: Session,
    *,
    viewer_id: UUID,
    receipt: PageReadReceipt,
) -> ReadWebPage:
    ref = _parse_owned_ref(receipt.media_ref)
    document = load_media_document(db, viewer_id, ref.id)
    if document is None:
        raise ResearchInputsChanged
    fingerprint = _fingerprint(document.body)
    if fingerprint != receipt.content_fingerprint:
        raise ResearchInputsChanged
    return ReadWebPage(receipt=receipt, body=document.body)


def _read_source(
    db: Session,
    *,
    viewer_id: UUID,
    read_ref: ResourceRef,
    target_ref: ResourceRef,
    fallback_title: str,
    role: Literal["seed", "nexus", "web"],
) -> ResearchSource | None:
    if target_ref != read_ref:
        target = load_resource_batch(
            db,
            [target_ref],
            viewer_id=viewer_id,
        )[target_ref.uri]
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
                part
                for part in (
                    quote.prefix,
                    quote.exact,
                    quote.suffix,
                    quote.note or "",
                )
                if part
            )
        else:
            title = loaded.title or fallback_title
            body = loaded.body or ""
    if not body.strip():
        return None
    title = title or fallback_title or "Untitled"
    return ResearchSource(
        read_ref=read_ref,
        target_ref=target_ref,
        title=title,
        body=body,
        content_fingerprint=_fingerprint(body),
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


def _web_search_provider(runtime: DossierBuildRuntime) -> WebSearchProvider:
    if not isinstance(runtime.web_search_provider, Present):
        # justify-defect: Idea research requires the configured Web-search
        # dependency; absence is process wiring failure, not a softer lesson.
        raise AssertionError("Idea Dossier research has no Web search provider")
    return runtime.web_search_provider.value


def _parse_owned_ref(uri: str) -> ResourceRef:
    parsed = parse_resource_ref(uri)
    if isinstance(parsed, ResourceRefParseFailure):
        raise AssertionError(f"owned Dossier research ref is malformed: {uri!r}")
    return parsed


def _fingerprint(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()
