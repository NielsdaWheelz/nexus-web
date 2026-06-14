"""Integration tests for the synapse resonance engine (synapse spec §11).

Real DB, fake LLM at the external boundary (the test_media_intelligence
pattern): router fakes drive ``run_synapse_scan`` directly via ``asyncio.run``.
Tests run without an OPENAI key, so retrieval is lexical-only with websearch
AND-semantics — every non-stopword lexeme of the scan query (the dossier head)
must appear in a candidate chunk. The seeded corpora therefore share one
distinctive token stem per scenario, including the quoted anchor-title phrase
a highlight dossier embeds.
"""

from __future__ import annotations

import asyncio
import json
import re
from unittest.mock import patch
from uuid import UUID, uuid4

import pytest
from provider_runtime.types import ModelResponse
from sqlalchemy import select, text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from nexus.config import clear_settings_cache
from nexus.db.models import (
    Fragment,
    Highlight,
    LLMCall,
    NoteBlock,
    Page,
    ResourceEdge,
    SynapseSuppression,
)
from nexus.schemas.highlights import CreateHighlightRequest, CreatePdfHighlightRequest, PdfQuadIn
from nexus.services.billing_entitlements import grant_entitlement_override
from nexus.services.bootstrap import ensure_user_and_default_library
from nexus.services.highlights import create_highlight_for_fragment
from nexus.services.media_intelligence import run_media_unit_build
from nexus.services.note_indexing import rebuild_note_content_index
from nexus.services.pdf_highlights import create_pdf_highlight
from nexus.services.resource_graph.connections import query_connections
from nexus.services.resource_graph.edges import (
    create_edge,
    get_owned_edge,
    replace_edges_for_origin,
)
from nexus.services.resource_graph.refs import ResourceRef
from nexus.services.resource_graph.schemas import (
    CitationSnapshot,
    ConnectionFilters,
    ConnectionQuery,
    EdgeCreate,
    EdgeOut,
)
from nexus.services.search import search
from nexus.services.search.query import SearchQuery
from nexus.services.synapse import (
    dismiss_synapse_edge,
    queue_synapse_scan,
    run_synapse_scan,
    scan_status,
)
from nexus.tasks.note_reindex import note_reindex_job
from tests.factories import (
    create_pdf_media_with_text,
    create_searchable_media,
    create_test_highlight,
    create_test_media_in_library,
    get_user_default_library,
)
from tests.helpers import auth_headers, create_test_user_id
from tests.utils.db import DirectSessionManager, task_session_factory

pytestmark = pytest.mark.integration


# =============================================================================
# Fixtures: platform key, rate-limit boundary fake
# =============================================================================


@pytest.fixture(autouse=True)
def synapse_platform_key(monkeypatch):
    """Platform key for the pinned provider; no OPENAI key keeps retrieval
    deterministically lexical-only (the embedding builder degrades typed)."""
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test-platform-anthropic")
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
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
def synapse_rate_limiter(monkeypatch) -> _RecordingRateLimiter:
    limiter = _RecordingRateLimiter()
    monkeypatch.setattr("nexus.services.synapse.get_rate_limiter", lambda: limiter)
    return limiter


def _grant_platform_llm(db: Session, user_id: UUID) -> None:
    """Entitle the user to the platform key (resolve_api_key auto -> platform)."""
    grant_entitlement_override(
        db,
        user_id=user_id,
        plan_tier="ai_plus",
        platform_token_quota_mode="plan",
        platform_token_limit_monthly=None,
        transcription_quota_mode="plan",
        transcription_minutes_limit_monthly=None,
        expires_at=None,
        reason="synapse test platform access",
        actor_label="test",
    )


# =============================================================================
# Router fakes (the external LLM boundary)
# =============================================================================


_CANDIDATE_LINE = re.compile(r"^\[\d+\] .*$", flags=re.MULTILINE)


class _SynapseRouter:
    """Fake router proposing every candidate line it is shown.

    ``marker`` restricts proposals to candidates whose rendered
    ``[i] label: snippet`` line contains it (drives the replace-set test).
    """

    def __init__(
        self,
        *,
        kind: str = "context",
        rationale: str = "It names the same resonance.",
        marker: str | None = None,
    ) -> None:
        self._kind = kind
        self._rationale = rationale
        self._marker = marker
        self.calls = 0
        self.seen_lines: list[list[str]] = []

    async def generate(self, request, *, key, timeout_s):
        self.calls += 1
        lines = _CANDIDATE_LINE.findall(request.messages[-1].content)
        self.seen_lines.append(lines)
        connections = [
            {"candidate_index": index, "kind": self._kind, "rationale": self._rationale}
            for index, line in enumerate(lines)
            if self._marker is None or self._marker in line
        ]
        return ModelResponse(
            text=json.dumps({"connections": connections}),
            usage=None,
            provider_request_id=None,
            status=None,
            incomplete_details=None,
        )


class _RawTextRouter:
    """Fake router returning non-JSON text (drives StructuredSynthesisError)."""

    async def generate(self, _request, *, key, timeout_s):
        return ModelResponse(
            text="not json at all",
            usage=None,
            provider_request_id=None,
            status=None,
            incomplete_details=None,
        )


class _MediaUnitRouter:
    """Fake router for run_media_unit_build (the promote-path trigger and the
    media-dossier seed)."""

    def __init__(self, summary_md: str = "An abstract.") -> None:
        self._summary_md = summary_md

    async def generate(self, _request, *, key, timeout_s):
        return ModelResponse(
            text=json.dumps({"summary_md": self._summary_md, "claims": []}),
            usage=None,
            provider_request_id=None,
            status=None,
            incomplete_details=None,
        )


class _DismissingRouter:
    """Fake judge that proposes every candidate while a dismissal lands mid-call.

    Inserting the suppression row from inside ``generate`` simulates a user
    dismiss committed during the provider call — after the pre-LLM exclusion
    read, before the write (the fix-2 race seam)."""

    def __init__(self, db: Session, suppression: SynapseSuppression) -> None:
        self._db = db
        self._suppression = suppression
        self.calls = 0

    async def generate(self, request, *, key, timeout_s):
        self.calls += 1
        self._db.add(self._suppression)
        lines = _CANDIDATE_LINE.findall(request.messages[-1].content)
        connections = [
            {"candidate_index": index, "kind": "context", "rationale": "It restates the claim."}
            for index in range(len(lines))
        ]
        return ModelResponse(
            text=json.dumps({"connections": connections}),
            usage=None,
            provider_request_id=None,
            status=None,
            incomplete_details=None,
        )


# =============================================================================
# Corpus seeds + assertion helpers
# =============================================================================

# A highlight dossier reads 'Highlight from "<anchor title>":\n<exact>', and the
# quoted title becomes a websearch PHRASE — so every resonant body must contain
# the anchor-title words adjacently, plus the bare lexemes 'highlight'/'spooky'.
# The factory derives the body from the title, so a shared title stem does it.
_HL_STEM = "Spooky Entanglement Highlight Crucible"

# Note dossiers are the note body, so candidates just need every lexeme of the
# stem sentence.
_NOTE_BODY = "Resonance: spooky entanglement collapses distance."
_NOTE_MEDIA_STEM = "Resonance Spooky Entanglement Collapses Distance"

# A media dossier is '<title>\n\n<summary_md>\n\n<claims>'; the fake unit summary
# repeats the title stem so the scan query stays within the candidates' lexemes.
_MEDIA_UNIT_STEM = "Cascade Refraction Resonance Prism"


def _seed_user(db: Session) -> UUID:
    user_id = uuid4()
    ensure_user_and_default_library(db, user_id)
    _grant_platform_llm(db, user_id)
    return user_id


def _seed_highlight_corpus(db: Session) -> tuple[UUID, ResourceRef, UUID, UUID, UUID]:
    """Anchor media + two resonant media, all lexically retrievable from the
    highlight's dossier (the anchor included — proving kin exclusion, AC7)."""
    user_id = _seed_user(db)
    anchor_id = create_searchable_media(db, user_id, title=_HL_STEM)
    alpha_id = create_searchable_media(db, user_id, title=f"{_HL_STEM} Alpha")
    beta_id = create_searchable_media(db, user_id, title=f"{_HL_STEM} Beta")
    fragment_id = db.execute(select(Fragment.id).where(Fragment.media_id == anchor_id)).scalar_one()
    highlight_id = create_test_highlight(db, user_id, fragment_id, exact="spooky")
    return user_id, ResourceRef(scheme="highlight", id=highlight_id), anchor_id, alpha_id, beta_id


def _add_note_page(
    db: Session, user_id: UUID, *, title: str, bodies: list[str]
) -> tuple[UUID, list[UUID]]:
    """A page with one block per body, indexed synchronously (no worker runs).

    A block's page membership and order are a user ordered-adjacency edge
    (page -> note_block) in ``resource_edges``.
    """
    page = Page(id=uuid4(), user_id=user_id, title=title)
    db.add(page)
    db.flush()
    block_ids: list[UUID] = []
    for index, body in enumerate(bodies):
        block = NoteBlock(
            id=uuid4(),
            user_id=user_id,
            body_pm_json={"type": "paragraph", "content": [{"type": "text", "text": body}]},
            body_text=body,
        )
        db.add(block)
        db.add(
            ResourceEdge(
                id=uuid4(),
                user_id=user_id,
                kind="context",
                origin="user",
                source_scheme="page",
                source_id=page.id,
                target_scheme="note_block",
                target_id=block.id,
                source_order_key=f"{index + 1:010d}",
            )
        )
        block_ids.append(block.id)
    db.flush()
    for block_id in block_ids:
        rebuild_note_content_index(db, note_block_id=block_id, reason="test")
    db.commit()
    return page.id, block_ids


def _scan(db: Session, *, user_id: UUID, ref: ResourceRef, router) -> str:
    return asyncio.run(run_synapse_scan(db, user_id=user_id, ref=ref, llm=router))


def _synapse_edges(db: Session, *, user_id: UUID, ref: ResourceRef) -> list[EdgeOut]:
    return [
        edge
        for edge in _connection_edges(db, viewer_id=user_id, ref=ref)
        if edge.source == ref and edge.origin == "synapse"
    ]


def _connection_edges(
    db: Session,
    *,
    viewer_id: UUID,
    ref: ResourceRef,
) -> list[EdgeOut]:
    out: list[EdgeOut] = []
    cursor = None
    while True:
        page = query_connections(
            db,
            viewer_id=viewer_id,
            query=ConnectionQuery(
                refs=(ref,),
                direction="both",
                rollup="exact",
                filters=ConnectionFilters(origins=("synapse",)),
                limit=100,
                cursor=cursor,
            ),
        )
        out.extend(
            EdgeOut(
                id=edge.edge_id,
                source=edge.source_ref,
                target=edge.target_ref,
                kind=edge.kind,
                origin=edge.origin,
                source_order_key=edge.source_order_key,
                target_order_key=edge.target_order_key,
                ordinal=edge.ordinal,
                snapshot=edge.snapshot,
                created_at=edge.created_at,
            )
            for edge in page.items
        )
        if page.next_cursor is None:
            return out
        cursor = page.next_cursor


def _targets(edges: list[EdgeOut]) -> set[str]:
    return {edge.target.uri for edge in edges}


def _scan_job_rows(db: Session, user_id: UUID, ref: ResourceRef) -> list[dict]:
    return [
        dict(row)
        for row in db.execute(
            text(
                "SELECT status, payload FROM background_jobs"
                " WHERE kind = 'synapse_scan' AND dedupe_key = :k ORDER BY created_at"
            ),
            {"k": f"synapse_scan:{user_id}:{ref.uri}"},
        ).mappings()
    ]


def _llm_call_rows(db: Session, *, owner_id: UUID) -> list[LLMCall]:
    return list(
        db.scalars(
            select(LLMCall)
            .where(LLMCall.owner_kind == "synapse_scan", LLMCall.owner_id == owner_id)
            .order_by(LLMCall.call_seq)
        )
    )


def _suppression_rows(db: Session, user_id: UUID) -> list[SynapseSuppression]:
    return list(db.scalars(select(SynapseSuppression).where(SynapseSuppression.user_id == user_id)))


# =============================================================================
# run_synapse_scan — AC1/AC8/AC7a (happy path over a real lexical corpus)
# =============================================================================


class TestRunSynapseScan:
    def test_highlight_scan_writes_edges_with_rationale_and_excludes_own_media(
        self, db_session: Session, synapse_rate_limiter: _RecordingRateLimiter
    ) -> None:
        user_id, ref, anchor_id, alpha_id, beta_id = _seed_highlight_corpus(db_session)
        # Non-vacuity guard: the anchor's own chunk matches the dossier query,
        # so its absence below is the kin filter, not a retrieval miss (AC7).
        retrieved = search(
            db_session,
            user_id,
            SearchQuery(
                text=f'Highlight from "{_HL_STEM}":\nspooky',
                result_types=("content_chunk",),
                limit=12,
            ),
        )
        retrieved_media = {result.source.media_id for result in retrieved.results}
        assert {anchor_id, alpha_id, beta_id} <= retrieved_media, (
            f"corpus must be lexically retrievable; got {retrieved_media}"
        )
        router = _SynapseRouter(kind="supports", rationale="Shares the spooky-action claim.")

        status = _scan(db_session, user_id=user_id, ref=ref, router=router)

        assert status == "ok"
        edges = _synapse_edges(db_session, user_id=user_id, ref=ref)
        assert _targets(edges) == {f"media:{alpha_id}", f"media:{beta_id}"}, (
            f"expected both resonant media and never the kin anchor; got {_targets(edges)}"
        )
        for edge in edges:
            assert edge.origin == "synapse"
            assert edge.kind == "supports"
            assert edge.ordinal is None
            assert edge.snapshot is not None
            assert edge.snapshot.excerpt == "Shares the spooky-action claim."
            assert edge.snapshot.title is not None and edge.snapshot.title.startswith(_HL_STEM)
        # AC8: the one provider call is ledgered against the source object.
        rows = _llm_call_rows(db_session, owner_id=ref.id)
        assert [(row.call_seq, row.llm_operation, row.error_class) for row in rows] == [
            (1, "synapse_scan", None)
        ], f"got {[(r.call_seq, r.llm_operation, r.error_class) for r in rows]}"
        # Platform-mode budget envelope: reserve -> commit -> release.
        assert synapse_rate_limiter.event_names() == [
            "acquire_inflight_slot",
            "reserve_token_budget",
            "commit_token_budget",
            "release_inflight_slot",
        ], f"unexpected envelope: {synapse_rate_limiter.events}"

    def test_media_scan_writes_edges_and_never_proposes_itself(
        self, db_session: Session, monkeypatch
    ) -> None:
        monkeypatch.setattr(
            "nexus.services.media_intelligence.get_rate_limiter",
            lambda: _RecordingRateLimiter(),
        )
        user_id = _seed_user(db_session)
        source_id = create_searchable_media(db_session, user_id, title=_MEDIA_UNIT_STEM)
        other_id = create_searchable_media(db_session, user_id, title=f"{_MEDIA_UNIT_STEM} Other")
        assert (
            asyncio.run(
                run_media_unit_build(
                    db_session,
                    media_id=source_id,
                    llm=_MediaUnitRouter(summary_md=f"{_MEDIA_UNIT_STEM.lower()}."),
                )
            )
            == "ok"
        )
        ref = ResourceRef(scheme="media", id=source_id)
        # Non-vacuity guard: the source's own chunk matches the unit-dossier
        # query, so its absence below is the self exclusion, not a miss.
        retrieved = search(
            db_session,
            user_id,
            SearchQuery(
                text=f"{_MEDIA_UNIT_STEM}\n\n{_MEDIA_UNIT_STEM.lower()}.",
                result_types=("content_chunk",),
                limit=12,
            ),
        )
        retrieved_media = {result.source.media_id for result in retrieved.results}
        assert {source_id, other_id} <= retrieved_media, (
            f"corpus must be lexically retrievable; got {retrieved_media}"
        )
        router = _SynapseRouter(rationale="Same refraction claim.")

        status = _scan(db_session, user_id=user_id, ref=ref, router=router)

        assert status == "ok"
        edges = _synapse_edges(db_session, user_id=user_id, ref=ref)
        assert _targets(edges) == {f"media:{other_id}"}, (
            f"a media never resonates with its own chunks' media; got {_targets(edges)}"
        )
        [edge] = edges
        assert edge.snapshot is not None
        assert edge.snapshot.excerpt == "Same refraction claim."

    def test_page_scan_writes_edges_and_excludes_own_blocks(self, db_session: Session) -> None:
        user_id = _seed_user(db_session)
        page_id, (block_a, block_b) = _add_note_page(
            db_session, user_id, title="Resonance", bodies=[_NOTE_BODY, _NOTE_BODY]
        )
        _page2, (other_block,) = _add_note_page(
            db_session, user_id, title="Resonance", bodies=[_NOTE_BODY]
        )
        ref = ResourceRef(scheme="page", id=page_id)
        router = _SynapseRouter()

        status = _scan(db_session, user_id=user_id, ref=ref, router=router)

        assert status == "ok"
        targets = _targets(_synapse_edges(db_session, user_id=user_id, ref=ref))
        assert targets == {f"note_block:{other_block}"}, (
            f"only the other page's block may resonate; got {targets}"
        )
        assert not targets & {f"note_block:{block_a}", f"note_block:{block_b}"}, (
            "a page never resonates with directly linked blocks"
        )

    def test_note_block_scan_excludes_self_not_page_siblings(self, db_session: Session) -> None:
        user_id = _seed_user(db_session)
        _page1, (source_block, sibling_block) = _add_note_page(
            db_session, user_id, title="Resonance", bodies=[_NOTE_BODY, _NOTE_BODY]
        )
        _page2, (other_block,) = _add_note_page(
            db_session, user_id, title="Resonance", bodies=[_NOTE_BODY]
        )
        # Non-vacuity guard: same-page membership is a graph edge, not implicit
        # note kinship. The sibling should be retrievable and proposable.
        retrieved = search(
            db_session,
            user_id,
            SearchQuery(text=f"Resonance\n\n{_NOTE_BODY}", result_types=("note_block",), limit=12),
        )
        retrieved_blocks = {result.id for result in retrieved.results}
        assert {source_block, sibling_block, other_block} <= retrieved_blocks, (
            f"corpus must be lexically retrievable; got {retrieved_blocks}"
        )
        ref = ResourceRef(scheme="note_block", id=source_block)
        router = _SynapseRouter()

        status = _scan(db_session, user_id=user_id, ref=ref, router=router)

        assert status == "ok"
        targets = _targets(_synapse_edges(db_session, user_id=user_id, ref=ref))
        assert targets == {f"note_block:{sibling_block}", f"note_block:{other_block}"}, (
            f"self must be excluded, but page siblings are ordinary graph items; got {targets}"
        )
        assert [len(lines) for lines in router.seen_lines] == [2]

    def test_rescan_replace_sets_and_leaves_other_origins_untouched(
        self, db_session: Session
    ) -> None:
        user_id = _seed_user(db_session)
        _page1, (source_block,) = _add_note_page(
            db_session, user_id, title="Resonance", bodies=[_NOTE_BODY]
        )
        _page2, (other_block,) = _add_note_page(
            db_session, user_id, title="Resonance", bodies=[_NOTE_BODY]
        )
        alpha_id = create_searchable_media(db_session, user_id, title=f"{_NOTE_MEDIA_STEM} Alpha")
        beta_id = create_searchable_media(db_session, user_id, title=f"{_NOTE_MEDIA_STEM} Beta")
        gamma_id = create_searchable_media(db_session, user_id, title=f"{_NOTE_MEDIA_STEM} Gamma")
        ref = ResourceRef(scheme="note_block", id=source_block)
        user_edge = create_edge(
            db_session,
            viewer_id=user_id,
            input=EdgeCreate(
                source=ref,
                target=ResourceRef(scheme="media", id=gamma_id),
                kind="context",
                origin="user",
            ),
        )

        first = _scan(db_session, user_id=user_id, ref=ref, router=_SynapseRouter())
        assert first == "ok"
        assert _targets(_synapse_edges(db_session, user_id=user_id, ref=ref)) == {
            f"note_block:{other_block}",
            f"media:{alpha_id}",
            f"media:{beta_id}",
        }

        second = _scan(db_session, user_id=user_id, ref=ref, router=_SynapseRouter(marker="Alpha"))

        assert second == "ok"
        targets = _targets(_synapse_edges(db_session, user_id=user_id, ref=ref))
        assert targets == {f"media:{alpha_id}"}, (
            f"replace-set must drop stale targets and keep picked ones (AC2); got {targets}"
        )
        assert get_owned_edge(db_session, viewer_id=user_id, edge_id=user_edge.id) == user_edge, (
            "a re-scan must leave other-origin edges on the source byte-identical (AC2)"
        )

    def test_empty_pick_clears_previous_edges_and_leaves_other_origins(
        self, db_session: Session
    ) -> None:
        user_id = _seed_user(db_session)
        _page1, (source_block,) = _add_note_page(
            db_session, user_id, title="Resonance", bodies=[_NOTE_BODY]
        )
        _add_note_page(db_session, user_id, title="Resonance", bodies=[_NOTE_BODY])
        gamma_id = create_searchable_media(db_session, user_id, title=f"{_NOTE_MEDIA_STEM} Gamma")
        ref = ResourceRef(scheme="note_block", id=source_block)
        user_edge = create_edge(
            db_session,
            viewer_id=user_id,
            input=EdgeCreate(
                source=ref,
                target=ResourceRef(scheme="media", id=gamma_id),
                kind="context",
                origin="user",
            ),
        )
        assert _scan(db_session, user_id=user_id, ref=ref, router=_SynapseRouter()) == "ok"
        assert _synapse_edges(db_session, user_id=user_id, ref=ref), (
            "happy-path seed must write at least one edge"
        )
        judge = _SynapseRouter(marker="No Such Candidate Line")

        status = _scan(db_session, user_id=user_id, ref=ref, router=judge)

        assert status == "ok"
        assert judge.calls == 1, "candidates must reach the judge (post-LLM empty path)"
        assert _synapse_edges(db_session, user_id=user_id, ref=ref) == [], (
            "an empty pick replace-sets the synapse edges to empty (current-only, AC2)"
        )
        assert get_owned_edge(db_session, viewer_id=user_id, edge_id=user_edge.id) == user_edge, (
            "an empty pick must leave other-origin edges untouched"
        )

    def test_existing_user_edge_pair_is_never_proposed(self, db_session: Session) -> None:
        user_id = _seed_user(db_session)
        _page, (source_block,) = _add_note_page(
            db_session, user_id, title="Resonance", bodies=[_NOTE_BODY]
        )
        alpha_id = create_searchable_media(db_session, user_id, title=f"{_NOTE_MEDIA_STEM} Alpha")
        beta_id = create_searchable_media(db_session, user_id, title=f"{_NOTE_MEDIA_STEM} Beta")
        ref = ResourceRef(scheme="note_block", id=source_block)
        create_edge(
            db_session,
            viewer_id=user_id,
            input=EdgeCreate(
                source=ref,
                target=ResourceRef(scheme="media", id=alpha_id),
                kind="context",
                origin="user",
            ),
        )

        status = _scan(db_session, user_id=user_id, ref=ref, router=_SynapseRouter())

        assert status == "ok"
        targets = _targets(_synapse_edges(db_session, user_id=user_id, ref=ref))
        assert targets == {f"media:{beta_id}"}, (
            f"a pair already user-connected must not be re-proposed (AC4); got {targets}"
        )

    def test_dismiss_suppresses_pair_in_both_directions(self, db_session: Session) -> None:
        user_id = _seed_user(db_session)
        _page1, (source_block, sibling_block) = _add_note_page(
            db_session, user_id, title="Resonance", bodies=[_NOTE_BODY, _NOTE_BODY]
        )
        _page2, (other_block,) = _add_note_page(
            db_session, user_id, title="Resonance", bodies=[_NOTE_BODY]
        )
        source_ref = ResourceRef(scheme="note_block", id=source_block)
        other_ref = ResourceRef(scheme="note_block", id=other_block)
        router = _SynapseRouter()
        assert _scan(db_session, user_id=user_id, ref=source_ref, router=router) == "ok"
        edge = next(
            edge
            for edge in _synapse_edges(db_session, user_id=user_id, ref=source_ref)
            if edge.target == other_ref
        )
        assert edge.target == other_ref

        dismiss_synapse_edge(db_session, viewer_id=user_id, edge_id=edge.id)

        assert _targets(_synapse_edges(db_session, user_id=user_id, ref=source_ref)) == {
            f"note_block:{sibling_block}"
        }
        [suppression] = _suppression_rows(db_session, user_id)
        assert (suppression.source_id, suppression.target_id) == (source_block, other_block)

        # Forward re-scan: the suppressed pair stays excluded, but the page
        # sibling remains an ordinary note candidate.
        assert _scan(db_session, user_id=user_id, ref=source_ref, router=router) == "ok"
        assert _targets(_synapse_edges(db_session, user_id=user_id, ref=source_ref)) == {
            f"note_block:{sibling_block}"
        }
        assert router.calls == 2

        # Reverse scan: the dismissed source is excluded too; the un-suppressed
        # page-sibling of the original source still resonates.
        assert _scan(db_session, user_id=user_id, ref=other_ref, router=router) == "ok"
        reverse_targets = _targets(_synapse_edges(db_session, user_id=user_id, ref=other_ref))
        assert reverse_targets == {f"note_block:{sibling_block}"}, (
            f"suppression must hold in both directions (AC3); got {reverse_targets}"
        )

    def test_mid_scan_dismiss_wins_over_the_scan(self, db_session: Session) -> None:
        user_id = _seed_user(db_session)
        _page1, (source_block,) = _add_note_page(
            db_session, user_id, title="Resonance", bodies=[_NOTE_BODY]
        )
        _page2, (other_block,) = _add_note_page(
            db_session, user_id, title="Resonance", bodies=[_NOTE_BODY]
        )
        ref = ResourceRef(scheme="note_block", id=source_block)
        assert _scan(db_session, user_id=user_id, ref=ref, router=_SynapseRouter()) == "ok"
        assert _targets(_synapse_edges(db_session, user_id=user_id, ref=ref)) == {
            f"note_block:{other_block}"
        }
        # Stored reverse (other -> source) to pin the both-directions re-check.
        router = _DismissingRouter(
            db_session,
            SynapseSuppression(
                user_id=user_id,
                source_scheme="note_block",
                source_id=other_block,
                target_scheme="note_block",
                target_id=source_block,
            ),
        )

        status = _scan(db_session, user_id=user_id, ref=ref, router=router)

        assert status == "ok"
        assert router.calls == 1, "the pair must reach the judge (pre-LLM exclusion ran before)"
        assert _synapse_edges(db_session, user_id=user_id, ref=ref) == [], (
            "a dismissal landing mid-scan must win over the scan's own pick"
        )
        assert len(_suppression_rows(db_session, user_id)) == 1

    def test_llm_failure_preserves_prior_edges(
        self, db_session: Session, synapse_rate_limiter: _RecordingRateLimiter
    ) -> None:
        user_id = _seed_user(db_session)
        _page1, (source_block,) = _add_note_page(
            db_session, user_id, title="Resonance", bodies=[_NOTE_BODY]
        )
        _add_note_page(db_session, user_id, title="Resonance", bodies=[_NOTE_BODY])
        ref = ResourceRef(scheme="note_block", id=source_block)
        assert _scan(db_session, user_id=user_id, ref=ref, router=_SynapseRouter()) == "ok"
        before = _synapse_edges(db_session, user_id=user_id, ref=ref)
        assert before, "happy-path seed must write at least one edge"

        status = _scan(db_session, user_id=user_id, ref=ref, router=_RawTextRouter())

        assert status == "failed"
        after = _synapse_edges(db_session, user_id=user_id, ref=ref)
        assert {edge.id for edge in after} == {edge.id for edge in before}, (
            "a failed scan must leave the previous synapse edge set intact (AC5)"
        )
        # The failed synthesis still ledgers both attempts (one repair round).
        rows = _llm_call_rows(db_session, owner_id=ref.id)
        assert [row.call_seq for row in rows] == [1, 2, 3], (
            f"expected success + attempt + repair rows, got "
            f"{[(r.call_seq, r.error_class) for r in rows]}"
        )
        # The failed attempt releases its envelope: reserved budget given back,
        # in-flight slot freed.
        assert synapse_rate_limiter.event_names()[-4:] == [
            "acquire_inflight_slot",
            "reserve_token_budget",
            "release_token_budget",
            "release_inflight_slot",
        ], f"unexpected envelope: {synapse_rate_limiter.events}"
        # Per-attempt reservation ids: a stable id (the ref) would dedupe the
        # budget charge across rescans, making them free.
        first_reserved, second_reserved = [
            event[2] for event in synapse_rate_limiter.events if event[0] == "reserve_token_budget"
        ]
        assert first_reserved != second_reserved
        assert ref.id not in (first_reserved, second_reserved)
        committed = [
            event[2] for event in synapse_rate_limiter.events if event[0] == "commit_token_budget"
        ]
        released = [
            event[2] for event in synapse_rate_limiter.events if event[0] == "release_token_budget"
        ]
        assert committed == [first_reserved] and released == [second_reserved]

    def test_zero_candidates_replace_sets_to_empty_without_judging(
        self, db_session: Session
    ) -> None:
        user_id = _seed_user(db_session)
        anchor_id = create_searchable_media(db_session, user_id, title="Lone Anchor")
        stale_target_id = create_searchable_media(db_session, user_id, title="Stale Target")
        fragment_id = db_session.execute(
            select(Fragment.id).where(Fragment.media_id == anchor_id)
        ).scalar_one()
        highlight_id = create_test_highlight(
            db_session, user_id, fragment_id, exact="zzyzx unobtainium nonesuch"
        )
        ref = ResourceRef(scheme="highlight", id=highlight_id)
        # A prior synapse assertion the engine no longer sees anything for.
        replace_edges_for_origin(
            db_session,
            viewer_id=user_id,
            source=ref,
            origin="synapse",
            edges=[
                EdgeCreate(
                    source=ref,
                    target=ResourceRef(scheme="media", id=stale_target_id),
                    kind="context",
                    origin="synapse",
                    snapshot=CitationSnapshot(title="Stale Target", excerpt="Prior rationale."),
                )
            ],
        )
        router = _SynapseRouter()

        status = _scan(db_session, user_id=user_id, ref=ref, router=router)

        assert status == "ok"
        assert router.calls == 0, "zero candidates must not reach the judge"
        assert _synapse_edges(db_session, user_id=user_id, ref=ref) == [], (
            "current-only doctrine: a successful empty scan clears the set"
        )


# =============================================================================
# queue_synapse_scan / scan_status — AC6/AC10
# =============================================================================


class TestQueueSynapseScan:
    def test_dedupes_to_one_nonterminal_row(self, db_session: Session) -> None:
        ref = ResourceRef(scheme="highlight", id=uuid4())
        user_id = uuid4()

        assert queue_synapse_scan(db_session, user_id=user_id, ref=ref, reason="manual") is True
        assert queue_synapse_scan(db_session, user_id=user_id, ref=ref, reason="manual") is False

        rows = _scan_job_rows(db_session, user_id, ref)
        assert [row["status"] for row in rows] == ["pending"], f"got {rows}"
        assert rows[0]["payload"] == {
            "user_id": str(user_id),
            "ref": ref.uri,
            "reason": "manual",
        }
        assert scan_status(db_session, user_id=user_id, ref=ref) == "pending"

    def test_dedupe_key_is_user_scoped(self, db_session: Session) -> None:
        ref = ResourceRef(scheme="highlight", id=uuid4())
        first_user, second_user = uuid4(), uuid4()

        assert queue_synapse_scan(db_session, user_id=first_user, ref=ref, reason="manual") is True
        assert queue_synapse_scan(db_session, user_id=second_user, ref=ref, reason="manual") is True

        for user_id in (first_user, second_user):
            rows = _scan_job_rows(db_session, user_id, ref)
            assert [row["status"] for row in rows] == ["pending"], (
                f"one user's scan must not dedupe another's; got {rows} for {user_id}"
            )

    def test_unscannable_scheme_is_a_noop(self, db_session: Session) -> None:
        ref = ResourceRef(scheme="conversation", id=uuid4())
        user_id = uuid4()
        assert queue_synapse_scan(db_session, user_id=user_id, ref=ref, reason="manual") is False
        assert _scan_job_rows(db_session, user_id, ref) == []

    def test_terminal_row_is_cleared_for_a_fresh_scan(self, db_session: Session) -> None:
        ref = ResourceRef(scheme="page", id=uuid4())
        user_id = uuid4()
        assert queue_synapse_scan(db_session, user_id=user_id, ref=ref, reason="manual") is True
        db_session.execute(
            text("UPDATE background_jobs SET status = 'succeeded' WHERE dedupe_key = :k"),
            {"k": f"synapse_scan:{user_id}:{ref.uri}"},
        )
        assert scan_status(db_session, user_id=user_id, ref=ref) == "idle"

        assert queue_synapse_scan(db_session, user_id=user_id, ref=ref, reason="manual") is True

        rows = _scan_job_rows(db_session, user_id, ref)
        assert [row["status"] for row in rows] == ["pending"], (
            f"the terminal row must be deleted before the re-enqueue; got {rows}"
        )

    def test_running_row_reads_as_running(self, db_session: Session) -> None:
        ref = ResourceRef(scheme="media", id=uuid4())
        user_id = uuid4()
        queue_synapse_scan(db_session, user_id=user_id, ref=ref, reason="manual")
        db_session.execute(
            text("UPDATE background_jobs SET status = 'running' WHERE dedupe_key = :k"),
            {"k": f"synapse_scan:{user_id}:{ref.uri}"},
        )
        assert scan_status(db_session, user_id=user_id, ref=ref) == "running"

    def test_disabled_engine_noops_queue_and_scan(self, db_session: Session, monkeypatch) -> None:
        monkeypatch.setenv("SYNAPSE_ENABLED", "false")
        clear_settings_cache()
        ref = ResourceRef(scheme="highlight", id=uuid4())
        user_id = uuid4()

        assert queue_synapse_scan(db_session, user_id=user_id, ref=ref, reason="manual") is False
        assert _scan_job_rows(db_session, user_id, ref) == []
        assert (
            asyncio.run(
                run_synapse_scan(db_session, user_id=user_id, ref=ref, llm=_SynapseRouter())
            )
            == "skipped"
        )


# =============================================================================
# Triggers — each host write leaves exactly one synapse_scan job row
# =============================================================================


class TestSynapseTriggers:
    def test_highlight_create_enqueues_one_scan(
        self, db_session: Session, bootstrapped_user: UUID
    ) -> None:
        media_id = create_searchable_media(db_session, bootstrapped_user, title="Trigger Doc")
        fragment_id = db_session.execute(
            select(Fragment.id).where(Fragment.media_id == media_id)
        ).scalar_one()

        out = create_highlight_for_fragment(
            db_session,
            bootstrapped_user,
            fragment_id,
            CreateHighlightRequest(start_offset=0, end_offset=4, color="yellow"),
        )

        rows = _scan_job_rows(
            db_session, bootstrapped_user, ResourceRef(scheme="highlight", id=out.id)
        )
        assert [row["status"] for row in rows] == ["pending"], f"got {rows}"
        assert rows[0]["payload"]["reason"] == "highlight_create"

    def test_enqueue_failure_is_savepoint_isolated_from_the_host_write(
        self, db_session: Session, bootstrapped_user: UUID, monkeypatch
    ) -> None:
        media_id = create_searchable_media(db_session, bootstrapped_user, title="Savepoint Doc")
        fragment_id = db_session.execute(
            select(Fragment.id).where(Fragment.media_id == media_id)
        ).scalar_one()

        def _boom(*_args, **_kwargs):
            raise SQLAlchemyError("forced enqueue failure")

        monkeypatch.setattr("nexus.services.synapse.enqueue_unique_job", _boom)

        out = create_highlight_for_fragment(
            db_session,
            bootstrapped_user,
            fragment_id,
            CreateHighlightRequest(start_offset=0, end_offset=4, color="yellow"),
        )

        # The host write survives the queue defect and committed; only the
        # SAVEPOINT-isolated job insert rolled back.
        committed = db_session.execute(
            select(Highlight.id).where(Highlight.id == out.id)
        ).scalar_one_or_none()
        assert committed == out.id, "the highlight create must survive a queue defect"
        assert (
            _scan_job_rows(
                db_session, bootstrapped_user, ResourceRef(scheme="highlight", id=out.id)
            )
            == []
        )

    def test_pdf_highlight_create_enqueues_one_scan(
        self, db_session: Session, bootstrapped_user: UUID
    ) -> None:
        library_id = get_user_default_library(db_session, bootstrapped_user)
        assert library_id is not None
        media_id = create_pdf_media_with_text(
            db_session,
            bootstrapped_user,
            library_id,
            plain_text="This is page one content. And this is page two content here.",
            page_count=2,
            page_spans=[(0, 26), (26, 60)],
        )

        out = create_pdf_highlight(
            db_session,
            bootstrapped_user,
            media_id,
            CreatePdfHighlightRequest(
                page_number=1,
                quads=[
                    PdfQuadIn(
                        x1=72.0, y1=700.0, x2=200.0, y2=700.0, x3=200.0, y3=712.0, x4=72.0, y4=712.0
                    )
                ],
                exact="page one",
                color="yellow",
            ),
        )

        rows = _scan_job_rows(
            db_session, bootstrapped_user, ResourceRef(scheme="highlight", id=out.id)
        )
        assert [row["status"] for row in rows] == ["pending"], f"got {rows}"
        assert rows[0]["payload"]["reason"] == "highlight_create"
        assert rows[0]["payload"]["ref"] == f"highlight:{out.id}"

    def test_highlight_create_with_engine_disabled_leaves_no_job(
        self, db_session: Session, bootstrapped_user: UUID, monkeypatch
    ) -> None:
        monkeypatch.setenv("SYNAPSE_ENABLED", "false")
        clear_settings_cache()
        media_id = create_searchable_media(db_session, bootstrapped_user, title="Disabled Doc")
        fragment_id = db_session.execute(
            select(Fragment.id).where(Fragment.media_id == media_id)
        ).scalar_one()

        out = create_highlight_for_fragment(
            db_session,
            bootstrapped_user,
            fragment_id,
            CreateHighlightRequest(start_offset=0, end_offset=4, color="yellow"),
        )

        assert (
            _scan_job_rows(
                db_session, bootstrapped_user, ResourceRef(scheme="highlight", id=out.id)
            )
            == []
        ), "SYNAPSE_ENABLED=false must turn the trigger into a no-op (AC10)"

    def test_note_reindex_task_enqueues_one_scan(
        self, db_session: Session, bootstrapped_user: UUID
    ) -> None:
        _page_id, blocks = _add_note_page(
            db_session, bootstrapped_user, title="Task Page", bodies=["A reindexed body."]
        )
        block_id = blocks[0]

        with patch(
            "nexus.tasks.note_reindex.get_session_factory",
            return_value=task_session_factory(db_session),
        ):
            result = note_reindex_job(str(block_id))

        assert result["status"] == "ready", f"got {result}"
        db_session.expire_all()
        rows = _scan_job_rows(
            db_session, bootstrapped_user, ResourceRef(scheme="note_block", id=block_id)
        )
        assert [row["status"] for row in rows] == ["pending"], f"got {rows}"
        assert rows[0]["payload"]["reason"] == "note_reindex"

    def test_media_unit_promote_enqueues_one_scan(
        self, db_session: Session, bootstrapped_user: UUID, monkeypatch
    ) -> None:
        monkeypatch.setattr(
            "nexus.services.media_intelligence.get_rate_limiter",
            lambda: _RecordingRateLimiter(),
        )
        _grant_platform_llm(db_session, bootstrapped_user)
        media_id = create_searchable_media(db_session, bootstrapped_user, title="Promote Doc")

        asyncio.run(run_media_unit_build(db_session, media_id=media_id, llm=_MediaUnitRouter()))

        rows = _scan_job_rows(
            db_session, bootstrapped_user, ResourceRef(scheme="media", id=media_id)
        )
        assert [row["status"] for row in rows] == ["pending"], (
            f"the ready-promote must enqueue exactly one scan; got {rows}"
        )
        assert rows[0]["payload"]["reason"] == "media_unit_ready"


# =============================================================================
# Routes — POST/GET /synapse/scans, POST /synapse/edges/{id}/dismiss
# =============================================================================


class TestSynapseRoutes:
    def _bootstrap_user(self, auth_client, direct_db: DirectSessionManager) -> UUID:
        user_id = create_test_user_id()
        me_response = auth_client.get("/me", headers=auth_headers(user_id))
        assert me_response.status_code == 200, me_response.text
        direct_db.register_cleanup("users", "id", user_id)
        direct_db.register_cleanup("libraries", "owner_user_id", user_id)
        direct_db.register_cleanup("memberships", "user_id", user_id)
        direct_db.register_cleanup("resource_edges", "user_id", user_id)
        direct_db.register_cleanup("synapse_suppressions", "user_id", user_id)
        return user_id

    def _create_media(self, direct_db: DirectSessionManager, user_id: UUID, title: str) -> UUID:
        with direct_db.session() as session:
            library_id = get_user_default_library(session, user_id)
            assert library_id is not None
            media_id = create_test_media_in_library(session, user_id, library_id, title=title)
        direct_db.register_cleanup("media", "id", media_id)
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("default_library_intrinsics", "media_id", media_id)
        direct_db.register_cleanup("default_library_closure_edges", "media_id", media_id)
        return media_id

    def test_manual_scan_is_idempotent_while_in_flight(
        self, auth_client, direct_db: DirectSessionManager
    ) -> None:
        user_id = self._bootstrap_user(auth_client, direct_db)
        headers = auth_headers(user_id)
        media_id = self._create_media(direct_db, user_id, title="Scan Route Doc")
        ref = f"media:{media_id}"
        direct_db.register_cleanup("background_jobs", "dedupe_key", f"synapse_scan:{user_id}:{ref}")

        idle = auth_client.get("/synapse/scans", headers=headers, params={"ref": ref})
        assert idle.status_code == 200, idle.text
        assert idle.json()["data"] == {"status": "idle"}

        first = auth_client.post("/synapse/scans", headers=headers, json={"ref": ref})
        assert first.status_code == 202, first.text
        assert first.json()["data"] == {"queued": True, "status": "pending"}

        second = auth_client.post("/synapse/scans", headers=headers, json={"ref": ref})
        assert second.status_code == 202, second.text
        assert second.json()["data"] == {"queued": False, "status": "pending"}, (
            "one non-terminal job per ref (AC6)"
        )

        status = auth_client.get("/synapse/scans", headers=headers, params={"ref": ref})
        assert status.status_code == 200, status.text
        assert status.json()["data"] == {"status": "pending"}

    def test_scan_rejects_malformed_unscannable_and_invisible_refs(
        self, auth_client, direct_db: DirectSessionManager
    ) -> None:
        user_id = self._bootstrap_user(auth_client, direct_db)
        headers = auth_headers(user_id)

        malformed = auth_client.post("/synapse/scans", headers=headers, json={"ref": "nope"})
        assert malformed.status_code == 400, malformed.text
        assert malformed.json()["error"]["code"] == "E_INVALID_REQUEST"

        unscannable = auth_client.post(
            "/synapse/scans", headers=headers, json={"ref": f"conversation:{uuid4()}"}
        )
        assert unscannable.status_code == 400, unscannable.text
        assert unscannable.json()["error"]["code"] == "E_INVALID_REQUEST"

        status_unscannable = auth_client.get(
            "/synapse/scans", headers=headers, params={"ref": f"conversation:{uuid4()}"}
        )
        assert status_unscannable.status_code == 400, status_unscannable.text

        invisible = auth_client.post(
            "/synapse/scans", headers=headers, json={"ref": f"highlight:{uuid4()}"}
        )
        assert invisible.status_code == 404, invisible.text

    def test_dismiss_deletes_edge_and_writes_suppression(
        self, auth_client, direct_db: DirectSessionManager
    ) -> None:
        user_id = self._bootstrap_user(auth_client, direct_db)
        headers = auth_headers(user_id)
        source_id = self._create_media(direct_db, user_id, title="Dismiss Source")
        target_id = self._create_media(direct_db, user_id, title="Dismiss Target")
        edge_id = uuid4()
        with direct_db.session() as session:
            session.add(
                ResourceEdge(
                    id=edge_id,
                    user_id=user_id,
                    kind="context",
                    origin="synapse",
                    source_scheme="media",
                    source_id=source_id,
                    target_scheme="media",
                    target_id=target_id,
                    snapshot={"title": "Dismiss Target", "excerpt": "It restates the claim."},
                )
            )
            session.commit()

        response = auth_client.post(f"/synapse/edges/{edge_id}/dismiss", headers=headers)

        assert response.status_code == 204, response.text
        with direct_db.session() as session:
            remaining = session.execute(
                select(ResourceEdge.id).where(ResourceEdge.id == edge_id)
            ).scalar_one_or_none()
            assert remaining is None, "dismiss must delete the edge"
            suppressed = session.execute(
                select(SynapseSuppression).where(
                    SynapseSuppression.user_id == user_id,
                    SynapseSuppression.source_id == source_id,
                    SynapseSuppression.target_id == target_id,
                )
            ).scalar_one_or_none()
            assert suppressed is not None, "dismiss must write the suppression memory"

        gone = auth_client.post(f"/synapse/edges/{edge_id}/dismiss", headers=headers)
        assert gone.status_code == 404, gone.text

    def test_dismiss_rejects_non_synapse_origin(
        self, auth_client, direct_db: DirectSessionManager
    ) -> None:
        user_id = self._bootstrap_user(auth_client, direct_db)
        headers = auth_headers(user_id)
        source_id = self._create_media(direct_db, user_id, title="User Link Source")
        target_id = self._create_media(direct_db, user_id, title="User Link Target")
        edge_id = uuid4()
        with direct_db.session() as session:
            session.add(
                ResourceEdge(
                    id=edge_id,
                    user_id=user_id,
                    kind="context",
                    origin="user",
                    source_scheme="media",
                    source_id=source_id,
                    target_scheme="media",
                    target_id=target_id,
                )
            )
            session.commit()

        response = auth_client.post(f"/synapse/edges/{edge_id}/dismiss", headers=headers)

        assert response.status_code == 409, response.text
        with direct_db.session() as session:
            survivor = session.execute(
                select(ResourceEdge.id).where(ResourceEdge.id == edge_id)
            ).scalar_one_or_none()
            assert survivor is not None, "a rejected dismissal must not delete the user edge"
