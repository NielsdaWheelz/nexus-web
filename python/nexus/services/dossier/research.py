"""Idea identity and idea research.

An idea is the canonical form of highlighted text, so learning one phrase twice reaches
one head. Research gathers, in order: the seed highlights, up to six Nexus sources for
three queries, and up to six web pages (one per domain) from one web search step. That
step is the only billed one; its picks stay in the job payload so the build's reschedules
never search again (a crash before they are kept searches again). Pages go through the ordinary url ingest (filed into the user's
library) with one idempotency key per pick, and are read once ready, or omitted after
ten minutes. Nexus search reruns on every attempt: before admission drift is harmless.
"""

import unicodedata
from datetime import UTC, datetime, timedelta
from urllib.parse import urlparse
from uuid import UUID

import regex
from llm_tools import WebSearchError, WebSearchProvider, WebSearchRequest
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.orm import Session, sessionmaker

from nexus.db.async_session import open_async_session
from nexus.errors import InvalidRequestError
from nexus.jobs.queue import JobExecutionContext, JobRow, update_running_job_payload
from nexus.schemas.presence import Present
from nexus.services.dossier.inputs import Candidate, Collected, collect, offer
from nexus.services.import_history import source_supersession_media_id
from nexus.services.media_read_map import load_media_document
from nexus.services.media_source_ingest import accept_url_source
from nexus.services.resource_graph.refs import ResourceRef, assert_resource_ref
from nexus.services.resource_items.capabilities import resource_read_policy
from nexus.services.search.query import SearchKind, SearchQuery, SearchScope
from nexus.services.search.service import search_scopes_async
from nexus.services.url_normalize import normalize_url_for_display

MAX_GRAPHEMES = 160
SOURCE_CHARS = 120_000
MAX_NEXUS = 6
MAX_WEB = 6
READY_WITHIN = timedelta(minutes=10)
_RECHECK = timedelta(seconds=5)
_HEADING = "IDEA CONTEXTS AND RESEARCH SOURCES"
_CONTEXT = (
    "Teach one coherent idea from foundations through practical examples. The highlighted "
    "seeds establish user context; Nexus and Web Article sources provide broader evidence. "
    "Omitted sources are not evidence."
)
_NEXUS_KINDS: frozenset[SearchKind] = frozenset({"documents", "notes", "highlights", "people"})
_IGNORABLE = regex.compile(r"\p{Default_Ignorable_Code_Point}+")


class WebPicks(BaseModel):
    """The web step's journaled result; ``ok`` is False when the search failed."""

    ok: bool
    urls: list[str]


def idea_key(selection: str) -> tuple[str, str] | None:
    """``(title_key, display_title)``, or None when empty or over 160 graphemes."""
    display = " ".join(unicodedata.normalize("NFKC", _IGNORABLE.sub("", selection)).split())
    key = " ".join(unicodedata.normalize("NFKC", display.casefold()).split())
    graphemes = max(len(regex.findall(r"\X", key)), len(regex.findall(r"\X", display)))
    return (key, display) if key and graphemes <= MAX_GRAPHEMES else None


def learn_applicable(selection: str) -> bool:
    return idea_key(selection) is not None


async def gather(
    db: Session,
    *,
    idea_id: UUID,
    artifact_id: UUID,
    build_id: UUID,
    user_id: UUID,
    ctx: JobExecutionContext,
    job: JobRow,
    web: WebSearchProvider | None,
) -> Collected | datetime:
    """The idea's sources, or when to look again while a page is still ingesting."""
    title = db.execute(
        text("SELECT display_title FROM artifact_idea_subjects WHERE id = :id"), {"id": idea_id}
    ).scalar_one()
    seeds = db.execute(
        text(
            "SELECT highlight_id FROM artifact_idea_seeds WHERE artifact_id = :id ORDER BY added_at, id"
        ),
        {"id": artifact_id},
    ).scalars()
    picked = [(ResourceRef("highlight", seed), ResourceRef("highlight", seed)) for seed in seeds]
    db.commit()

    queries = [title, f"{title} explained", f"{title} examples"]
    nexus: dict[ResourceRef, ResourceRef] = {}
    for query in queries:
        prepared = SearchQuery(text=query, requested_kinds=_NEXUS_KINDS, limit=MAX_NEXUS)
        # one session per search: search_scopes_async begins its own transactions
        async with open_async_session(sessionmaker(bind=db.get_bind())) as search_db:
            found = await search_scopes_async(search_db, user_id, prepared, (SearchScope("all"),))
        for result in found.results:
            if result.citation_target is not None:
                target = assert_resource_ref(result.citation_target)
                nexus.setdefault(target, assert_resource_ref(result.resource_ref))
    seed_targets = {target for _, target in picked}
    fresh = [(read, target) for target, read in nexus.items() if target not in seed_targets]
    picked += fresh[:MAX_NEXUS]

    web_step = await _web_step(db, ctx, job, queries, web)
    omitted = 0 if web_step.ok else 1
    retry_at: datetime | None = None
    for index, url in enumerate(web_step.urls):
        page = _page(db, user_id, f"dossier-research:{build_id}:{index}", url)
        if isinstance(page, ResourceRef):
            picked.append((page, page))
        elif page is None:
            omitted += 1
        else:
            retry_at = min(page, retry_at or page)
    if retry_at is not None:
        return retry_at

    candidates: list[Candidate] = []
    sources: list[tuple[str, str]] = []
    chars = 0
    for read, target in picked:
        if target.uri in {uri for _, uri in sources}:
            continue
        candidate = read_source(db, user_id, read, target)
        if candidate is None or chars + len(candidate.text) > SOURCE_CHARS:
            omitted += 1
            continue
        chars += len(candidate.text)
        candidates.append(candidate)
        sources.append((read.uri, target.uri))
    return collect("source", _HEADING, _CONTEXT, candidates, omitted=omitted, sources=sources)


def reread(db: Session, *, user_id: UUID, sources: list[tuple[str, str]]) -> str:
    """The live fingerprint of a revision's sources, for freshness."""
    candidates = [
        read_source(db, user_id, assert_resource_ref(read), assert_resource_ref(target))
        for read, target in sources
    ]
    live = [candidate for candidate in candidates if candidate is not None]
    return collect("source", _HEADING, _CONTEXT, live).coverage.fingerprint


def read_source(
    db: Session, user_id: UUID, read: ResourceRef, target: ResourceRef
) -> Candidate | None:
    """``read``'s current text cited as ``target``, both visible to the user, or None."""
    from nexus.services.resource_graph.resolve import load_resource_batch

    loaded = load_resource_batch(db, list(dict.fromkeys([read, target])), viewer_id=user_id)
    if loaded[read.uri].missing or loaded[target.uri].missing:
        return None
    quote = loaded[read.uri].quote
    if resource_read_policy(read) == "media":
        document = load_media_document(db, user_id, read.id)
        title, body = (document.title, document.body) if document is not None else ("", "")
    elif quote is not None:
        parts = (quote.prefix, quote.exact, quote.suffix, quote.note or "")
        title, body = quote.source_label or "", "\n".join(part for part in parts if part)
    else:
        title, body = loaded[read.uri].title or "", loaded[read.uri].body or ""
    title = title or "Untitled"
    return offer(target, f"{title}\n{body}", body, None, title) if body.strip() else None


async def _web_step(
    db: Session,
    ctx: JobExecutionContext,
    job: JobRow,
    queries: list[str],
    web: WebSearchProvider | None,
) -> WebPicks:
    """The billed step: three searches once per build, kept in the job payload."""
    stored = job.payload.get("web_picks")
    if stored is not None:
        return WebPicks.model_validate(stored)
    if web is None:
        return WebPicks(ok=False, urls=[])
    picks = await _search(web, queries)
    payload = {**job.payload, "web_picks": picks.model_dump(mode="json")}
    if not update_running_job_payload(db, context=ctx, payload=payload):
        raise RuntimeError("dossier research lost its job lease")
    db.commit()
    return picks


async def _search(web: WebSearchProvider, queries: list[str]) -> WebPicks:
    """Three searches; the first result per domain, in rank order, at most six."""
    try:
        responses = [await web.search(WebSearchRequest(query=query)) for query in queries]
    except WebSearchError:
        return WebPicks(ok=False, urls=[])
    urls: dict[str, str] = {}
    for response in responses:
        for hit in sorted(response.results, key=lambda item: item.rank):
            try:
                url = normalize_url_for_display(hit.url)
            except ValueError:
                url = hit.url
            if len(urls) < MAX_WEB:
                urls.setdefault((urlparse(url).hostname or "").lower(), url)
    return WebPicks(ok=True, urls=list(urls.values()))


def _page(db: Session, user_id: UUID, key: str, url: str) -> ResourceRef | datetime | None:
    """The ingested page once ready, when to look again while pending, or None: omitted."""
    try:
        accepted = accept_url_source(
            db=db,
            viewer_id=user_id,
            url=url,
            library_ids=[],
            idempotency_key=key,
            ingest_purpose="artifact_research",
        )
    except InvalidRequestError:
        return None
    winner = source_supersession_media_id(db, source_attempt_id=accepted.source_attempt_id)
    media_id = winner.value if isinstance(winner, Present) else accepted.media_id
    status, accepted_at = db.execute(
        text(
            "SELECT m.processing_status, a.created_at FROM media m, media_source_attempts a "
            "WHERE m.id = :media_id AND a.id = :attempt_id"
        ),
        {"media_id": media_id, "attempt_id": accepted.source_attempt_id},
    ).one()
    db.commit()
    now, deadline = datetime.now(UTC), accepted_at + READY_WITHIN
    if status == "ready_for_reading":
        return ResourceRef("media", media_id)
    if status == "failed" or now >= deadline:
        return None
    return min(deadline, now + _RECHECK)
