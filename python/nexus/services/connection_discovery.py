"""Connection discovery: the sole writer of ``origin='discovery'`` resource-graph edges.

A scan judges one source against candidates retrieved from the viewer's own
corpus and replace-sets the source's discovery edges with the grounded picks: a
successful scan owns the whole set, even when it empties it; every other
outcome leaves it untouched. Exclusion is at work grain (a passage, highlight
or anchor counts as its media): the source's own work, works it already
relates to, and works a dismissal paired with its work in either direction.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Literal
from uuid import UUID

from llm_tools import canonical_json_bytes
from pydantic import BaseModel, ConfigDict, field_validator
from sqlalchemy import select, text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from nexus.config import get_settings
from nexus.db.models import ConnectionDiscoverySuppression, Highlight, NoteBlock
from nexus.db.retries import retry_serializable
from nexus.errors import ApiErrorCode, ConflictError, NotFoundError
from nexus.jobs.queue import JobExecutionContext, enqueue_unique_job, lock_running_job_claim
from nexus.logging import get_logger
from nexus.schemas.resource_graph import CitationSnapshot
from nexus.schemas.search import (
    SearchResultContentChunkOut,
    SearchResultNoteBlockOut,
    SearchResultOut,
)
from nexus.services.generation import synthesis
from nexus.services.generation.contract import Failed, InvalidOutput, Owner, Succeeded
from nexus.services.generation.run import generate
from nexus.services.generation.runtime import Runtime, run_generation_job
from nexus.services.media_intelligence import NotReady, get_media_unit
from nexus.services.resource_graph.edges import (
    CONNECTION_DISCOVERY_SOURCE_SCHEMES,
    EdgeCreate,
    delete_edge,
    get_owned_edge,
    replace_edges_for_origin,
)
from nexus.services.resource_graph.owners import owner_rows_sql
from nexus.services.resource_graph.refs import ResourceRef, assert_resource_ref
from nexus.services.resource_graph.resolve import resolve_ref, resolve_refs
from nexus.services.resource_items.capabilities import expand_owned_child_refs
from nexus.services.search.query import SearchQuery
from nexus.services.search.service import search

logger = get_logger(__name__)

ScanStatus = Literal["idle", "pending", "running", "failed"]
ScanResult = Literal["ok", "skipped", "terminal_failed"]
_MAX_CANDIDATES = 12
_MAX_EDGES = 4
_MAX_PER_WORK = 2  # two passages of one work is passage grain; four is monologue


class ConnectionDiscoveryConnection(BaseModel):
    model_config = ConfigDict(extra="forbid")

    candidate_index: int
    kind: Literal["context", "supports", "contradicts"]
    rationale: str

    @field_validator("rationale")
    @classmethod
    def _bounded(cls, value: str) -> str:
        # Not Field(min_length=...): the strict emitted schema carries no lengths.
        if not 1 <= len(value.strip()) <= 240:
            raise ValueError("rationale must be 1-240 characters")
        return value


class ConnectionDiscoverySynthesis(BaseModel):
    model_config = ConfigDict(extra="forbid")

    connections: list[ConnectionDiscoveryConnection]


class _Candidate(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    target: str
    label: str
    snippet: str


class _Input(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    kind: Literal["connection_discovery-input.v2"] = "connection_discovery-input.v2"
    source_ref: str
    source_text: str
    candidates: tuple[_Candidate, ...]


_PROMPT = synthesis.build_synthesis_prompt(
    persona=(
        "You are the connection discovery engine of a personal knowledge system: given one "
        "source object and candidate passages from the user's own corpus, you "
        "judge which candidates genuinely illuminate the source."
    ),
    preamble=None,
    domain_rules=[
        synthesis.INDEX_GROUNDING_RULE + " Do not invent candidates, indices, or quotations.",
        "The input is JSON. A candidate's index is its zero-based position in candidates.",
        "Propose only connections where remembering the candidate genuinely "
        "illuminates the source: a shared argument, a direct contradiction, the "
        "same idea in different words, a concrete example. Reject mere topical overlap.",
        f"Propose at most {_MAX_EDGES} connections, only the strongest; fewer is better.",
        'Use kind "supports" or "contradicts" only when the relation is genuinely '
        'argued; otherwise use "context".',
        "rationale: one sentence to the user naming the specific connection, under 200 characters.",
        "Write each rationale so it reads correctly from either object; never use "
        "the words 'source', 'candidate', or indices.",
        "An empty list is a good answer.",
    ],
    json_shape=(
        '{"connections": [{"candidate_index": int, '
        '"kind": "context" | "supports" | "contradicts", "rationale": string}]}'
    ),
)


def queue_connection_discovery_scan(
    db: Session, *, user_id: UUID, ref: ResourceRef, reason: str
) -> bool:
    """Soft-enqueue one scan; True only when a row was inserted. Flush-only and
    never raises: a failed insert rolls back only its savepoint."""
    if (
        not get_settings().connection_discovery_enabled
        or ref.scheme not in CONNECTION_DISCOVERY_SOURCE_SCHEMES
    ):
        return False
    key = _dedupe_key(user_id, ref)
    try:
        with db.begin_nested():
            # A finished row frees the key; a 'failed' row still owes its retry.
            db.execute(
                text(
                    "DELETE FROM background_jobs"
                    " WHERE dedupe_key = :k AND status IN ('succeeded', 'dead')"
                ),
                {"k": key},
            )
            _, inserted = enqueue_unique_job(
                db,
                kind="connection_discovery_scan",
                payload={"user_id": str(user_id), "ref": ref.uri, "reason": reason},
                dedupe_key=key,
            )
        return inserted
    except SQLAlchemyError as exc:
        logger.warning(
            "connection_discovery_scan_enqueue_failed", ref=ref.uri, reason=reason, error=str(exc)
        )
        return False


def scan_state(
    db: Session, *, user_id: UUID, ref: ResourceRef
) -> tuple[ScanStatus, ScanResult | None]:
    """The job row, projected. A ``failed`` row awaiting its retry still owes
    work; a dead row or a terminal model failure reads ``failed``."""
    row = db.execute(
        text("SELECT status, result->>'status' FROM background_jobs WHERE dedupe_key = :k"),
        {"k": _dedupe_key(user_id, ref)},
    ).first()
    if row is None:
        return "idle", None
    status, result = row
    if status in ("pending", "failed"):
        return "pending", None
    if status == "running":
        return "running", None
    outcome: ScanResult | None = result if result in ("ok", "skipped", "terminal_failed") else None
    return ("failed" if status == "dead" or outcome == "terminal_failed" else "idle"), outcome


def dismiss_connection_discovery_edge(db: Session, *, viewer_id: UUID, edge_id: UUID) -> None:
    """Remember the pair at work grain, then delete the edge. Commits."""

    def attempt() -> None:
        edge = get_owned_edge(db, viewer_id=viewer_id, edge_id=edge_id)
        if edge is None:
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Edge not found")
        if edge.origin != "discovery":
            raise ConflictError(
                ApiErrorCode.E_RETRY_INVALID_STATE, "Only discovery links can be dismissed"
            )
        work = _work(db, edge.target)
        key = {
            "user_id": viewer_id,
            "source_scheme": edge.source.scheme,
            "source_id": edge.source.id,
            "target_scheme": work.scheme,
            "target_id": work.id,
        }
        if db.get(ConnectionDiscoverySuppression, key) is None:
            db.add(ConnectionDiscoverySuppression(**key))
        delete_edge(db, viewer_id=viewer_id, edge_id=edge_id)
        db.commit()

    retry_serializable(db, "connection_discovery.dismiss", attempt)


def connection_discovery_scan_job(
    payload: Mapping[str, object], *, context: JobExecutionContext
) -> dict:
    user_id, ref = UUID(str(payload["user_id"])), assert_resource_ref(str(payload["ref"]))

    async def handle(db: Session, runtime: Runtime) -> dict:
        status, error_code = await _scan(
            db, user_id=user_id, ref=ref, context=context, runtime=runtime
        )
        return {"status": status, "error_code": error_code, "ref": ref.uri}

    return run_generation_job("connection_discovery_scan", context, handle)


async def _scan(
    db: Session,
    *,
    user_id: UUID,
    ref: ResourceRef,
    context: JobExecutionContext,
    runtime: Runtime,
) -> tuple[ScanResult, str | None]:
    """Build the input fresh, generate once; only ``ok`` touches the edges."""
    if not get_settings().connection_discovery_enabled:
        return "skipped", None
    dossier = _dossier(db, user_id=user_id, ref=ref)
    excluded = set() if dossier is None else _excluded(db, user_id=user_id, ref=ref)
    db.commit()  # search() embeds first: it needs a session without a transaction
    if dossier is None:
        return "skipped", None
    source_text, kin = dossier
    response = search(
        db,
        user_id,
        SearchQuery(
            text=source_text[:800],
            requested_kinds=frozenset({"documents", "notes"}),
            limit=_MAX_CANDIDATES * 4,
        ),
    )
    candidates = _candidates(response.results, excluded=excluded | kin)
    if not candidates:
        return _publish(db, user_id=user_id, ref=ref, context=context, picks=[])
    source = _Input(source_ref=ref.uri, source_text=source_text, candidates=candidates)

    def accept(
        value: ConnectionDiscoverySynthesis,
    ) -> list[tuple[str, ConnectionDiscoveryConnection]]:
        if len(value.connections) > _MAX_EDGES:
            raise InvalidOutput(f"connection_discovery output exceeds {_MAX_EDGES} connections")
        grounded = synthesis.ground_indices(
            value.connections, candidates, index_of=lambda c: c.candidate_index
        )
        if grounded is None:
            raise InvalidOutput("connection_discovery output names a candidate not offered")
        return [(candidate.target, connection) for connection, candidate in grounded]

    terminal = await generate(
        runtime,
        owner=Owner("connection_discovery_scan", ref.id, user_id, context),
        operation="connection_discovery",
        intent=synthesis.build_synthesis_intent(
            system_prompt=_PROMPT,
            user_content=canonical_json_bytes(source.model_dump(mode="json")).decode(),
            schema=ConnectionDiscoverySynthesis,
        ),
        decode=synthesis.strict(ConnectionDiscoverySynthesis, accept),
    )
    if isinstance(terminal, Failed):
        return "terminal_failed", terminal.code
    if not isinstance(terminal, Succeeded):
        return "skipped", None
    return _publish(db, user_id=user_id, ref=ref, context=context, picks=terminal.value)


def _publish(
    db: Session,
    *,
    user_id: UUID,
    ref: ResourceRef,
    context: JobExecutionContext,
    picks: list[tuple[str, ConnectionDiscoveryConnection]],
) -> tuple[ScanResult, None]:
    """Replace-set the source's discovery edges under the job's lease fence,
    re-reading exclusions (a dismissal may land while the model runs) and
    dropping targets that are gone."""

    def attempt() -> tuple[ScanResult, None]:
        if not lock_running_job_claim(db, context=context):
            db.rollback()
            return "skipped", None
        if resolve_ref(db, viewer_id=user_id, ref=ref).missing:
            db.commit()
            return "skipped", None
        targets = [assert_resource_ref(target) for target, _ in picks]
        excluded = _excluded(db, user_id=user_id, ref=ref)
        resolved = resolve_refs(db, viewer_id=user_id, refs=targets)
        replace_edges_for_origin(
            db,
            viewer_id=user_id,
            source=ref,
            origin="discovery",
            edges=[
                EdgeCreate(
                    source=ref,
                    target=target,
                    kind=pick.kind,
                    origin="discovery",
                    snapshot=CitationSnapshot(excerpt=pick.rationale),
                )
                for (_, pick), target, item in zip(picks, targets, resolved, strict=True)
                if not item.missing and _work(db, target) not in excluded
            ],
        )
        db.commit()
        return "ok", None

    return retry_serializable(db, "connection_discovery.publish", attempt)


def _dossier(
    db: Session, *, user_id: UUID, ref: ResourceRef
) -> tuple[str, frozenset[ResourceRef]] | None:
    """Source text, plus kin that may never be a candidate; None skips. Only
    the viewer's own highlight is a source (shared libraries show others')."""
    resolved = resolve_ref(db, viewer_id=user_id, ref=ref)
    if resolved.missing:
        return None
    kin: frozenset[ResourceRef] = frozenset()
    if ref.scheme == "media":
        unit = get_media_unit(db, media_id=ref.id)
        if isinstance(unit, NotReady):
            return None
        claims = "\n".join(f"- {claim.claim_text}" for claim in unit.claims)
        source_text = f"{resolved.label}\n\n{unit.summary_md}\n\n{claims}"
    elif ref.scheme == "highlight":
        owner = db.scalar(select(Highlight.user_id).where(Highlight.id == ref.id))
        if resolved.quote is None or owner != user_id:
            return None
        quote = resolved.quote
        source_text = f"Highlight from {quote.source_label}:\n"
        source_text += f"{quote.prefix}{quote.exact}{quote.suffix}"
        if quote.note:
            source_text += f"\n\nReader note:\n{quote.note}"
    elif ref.scheme == "page":
        kin = frozenset(expand_owned_child_refs(db, viewer_id=user_id, ref=ref))
        bodies = db.scalars(
            select(NoteBlock.body_text)
            .where(NoteBlock.id.in_([block.id for block in kin]))
            .order_by(NoteBlock.created_at, NoteBlock.id)
        )
        source_text = "\n\n".join([resolved.label, *bodies])
    else:
        source_text = resolved.body or ""
    return (source_text[:12_000], kin) if source_text.strip() else None


def _excluded(db: Session, *, user_id: UUID, ref: ResourceRef) -> set[ResourceRef]:
    """Works the judge must never see: the source's own, every one related to
    the source itself (except through its own discovery set), and every one a
    dismissal paired with the source's work, read at work grain on both sides."""
    rows = db.execute(
        text(f"""
            WITH pairs AS (
                SELECT source_scheme, source_id, target_scheme, target_id
                FROM resource_edges
                WHERE user_id = :user_id AND origin <> 'link_note'
                  AND ((source_scheme = :scheme AND source_id = :id)
                       OR (target_scheme = :scheme AND target_id = :id))
                  AND NOT (origin = 'discovery' AND source_scheme = :scheme AND source_id = :id)
                UNION ALL
                SELECT source_scheme, source_id, target_scheme, target_id
                FROM connection_discovery_suppressions WHERE user_id = :user_id
            ),
            ends AS (
                SELECT CAST(:scheme AS text) AS scheme, CAST(:id AS uuid) AS id
                UNION SELECT source_scheme, source_id FROM pairs
                UNION SELECT target_scheme, target_id FROM pairs
            ),
            owners AS ({owner_rows_sql("SELECT scheme, id FROM ends")}),
            work AS (SELECT owner_scheme, owner_id FROM owners WHERE scheme = :scheme AND id = :id)
            SELECT owner_scheme, owner_id FROM work
            UNION
            SELECT v.far_scheme, v.far_id
            FROM pairs p
            JOIN owners s ON s.scheme = p.source_scheme AND s.id = p.source_id
            JOIN owners t ON t.scheme = p.target_scheme AND t.id = p.target_id
            CROSS JOIN LATERAL (VALUES (s.owner_scheme, s.owner_id, t.owner_scheme, t.owner_id),
                                       (t.owner_scheme, t.owner_id, s.owner_scheme, s.owner_id))
                AS v(near_scheme, near_id, far_scheme, far_id)
            JOIN work w ON w.owner_scheme = v.near_scheme AND w.owner_id = v.near_id
        """),
        {"user_id": user_id, "scheme": ref.scheme, "id": ref.id},
    )
    return {ResourceRef(scheme=scheme, id=owner_id) for scheme, owner_id in rows}


def _work(db: Session, ref: ResourceRef) -> ResourceRef:
    """The work that owns ``ref``: a passage's or highlight's media, else itself."""
    endpoint = "SELECT CAST(:scheme AS text) AS scheme, CAST(:id AS uuid) AS id"
    scheme, work_id = db.execute(
        text(f"SELECT owner_scheme, owner_id FROM ({owner_rows_sql(endpoint)}) o"),
        {"scheme": ref.scheme, "id": ref.id},
    ).one()
    return ResourceRef(scheme=scheme, id=work_id)


def _candidates(
    results: Sequence[SearchResultOut], *, excluded: set[ResourceRef]
) -> tuple[_Candidate, ...]:
    """Score-ordered hits as distinct candidates: a chunk becomes its first
    evidence span (else its media), a note hit its block; at most two per work,
    twelve in all, none whose work is excluded."""
    candidates: list[_Candidate] = []
    per_work: dict[ResourceRef, int] = {}
    for result in results:
        if isinstance(result, SearchResultContentChunkOut):
            work = ResourceRef(scheme="media", id=result.source.media_id)
            spans = result.evidence_span_ids
            target = ResourceRef(scheme="evidence_span", id=spans[0]) if spans else work
            label = result.source.title
            snippet = result.snippet.replace("<b>", "").replace("</b>", "")
        elif isinstance(result, SearchResultNoteBlockOut):
            work = target = ResourceRef(scheme="note_block", id=result.id)
            body = result.body_text.strip()
            label = body.splitlines()[0][:80] if body else "Note"
            snippet = body[:600]
        else:
            continue
        seen = any(candidate.target == target.uri for candidate in candidates)
        if work in excluded or seen or per_work.get(work, 0) == _MAX_PER_WORK:
            continue
        per_work[work] = per_work.get(work, 0) + 1
        candidates.append(_Candidate(target=target.uri, label=label, snippet=snippet))
    return tuple(candidates[:_MAX_CANDIDATES])


def _dedupe_key(user_id: UUID, ref: ResourceRef) -> str:
    return f"connection_discovery_scan:{user_id}:{ref.uri}"
