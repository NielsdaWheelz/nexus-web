"""Bound the incident's corpus-wide snippet work without changing retrieval.

Frozen fixture/environment contract: controller-owned PostgreSQL with pgvector,
256 dimensions, work_mem=4MB, jit=off, 4,096 visible ~8KiB chunks, twelve final
results, six lexical-only and six semantic-only winners, and hidden/unready/
wrong-model controls. Both queries run in one transaction (identical recency),
with one warm-up and three EXPLAIN ANALYZE samples, a 30s measurement cap, a
2,000ms final-query budget and at least a 50% median improvement. This is a
targeted regression proof, not a production latency claim or benchmark harness.

testdata/search/chat_search_before.sql freezes the pre-edit query. Full plans,
server settings, fixture sizes and timing samples are emitted into pytest's
artifact directory. No measurement is inferred from successful collection on a
host without a DB.
"""

from __future__ import annotations

import json
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path
from statistics import median
from uuid import UUID, uuid4

import pytest
from sqlalchemy import Engine, event, insert, text
from sqlalchemy.orm import Session

from nexus.db.models import (
    ContentBlock,
    ContentChunk,
    ContentEmbedding,
    ContentIndexState,
    EvidenceSpan,
    Fragment,
    Media,
    MediaKind,
    ProcessingStatus,
)
from nexus.services import bootstrap, library_entries
from nexus.services.search.retrievers.content_chunks import _search_content_chunks
from nexus.services.semantic_chunks import transcript_embedding_dimensions

_VISIBLE_CHUNKS = 4096
_FINAL_LIMIT = 12
_QUERY_BUDGET_MS = 2000
_EMBEDDING_MODEL = "text-embedding-3-large"
_BODY = "A durable document explains reliable execution and bounded retrieval. " * 120
_CREATED_AT = datetime(2020, 1, 1, tzinfo=UTC)


def _media_evidence(db: Session, user_id: UUID, *, ready: bool) -> tuple[UUID, UUID]:
    # Both lexical chunks and body-only semantic chunks excerpt this source;
    # retrieval never depends on fabricated evidence text.
    body = "needle " * 20 + _BODY
    media = Media(
        kind=MediaKind.web_article,
        title="Bounded retrieval fixture",
        processing_status=ProcessingStatus.ready_for_reading,
        created_by_user_id=user_id,
    )
    fragment = Fragment(media=media, idx=0, canonical_text=body, html_sanitized=f"<p>{body}</p>")
    db.add_all([media, fragment])
    db.flush()
    library_entries.ensure_media_in_default_library(db, user_id, media.id)
    selector = {
        "kind": "web_text",
        "fragment_id": str(fragment.id),
        "start_offset": 0,
        "end_offset": len(body),
        "text_quote": {"exact": body, "prefix": "", "suffix": ""},
    }
    block = ContentBlock(
        owner_kind="media",
        owner_id=media.id,
        block_idx=0,
        block_kind="paragraph",
        canonical_text=body,
        extraction_confidence=1.0,
        source_start_offset=0,
        source_end_offset=len(body),
        heading_path=[],
        locator=selector,
        selector=selector,
        metadata_json={},
    )
    db.add(block)
    db.flush()
    span = EvidenceSpan(
        owner_kind="media",
        owner_id=media.id,
        start_block_id=block.id,
        end_block_id=block.id,
        start_block_offset=0,
        end_block_offset=len(body),
        span_text=body,
        selector=selector,
        citation_label="paragraph 1",
        resolver_kind="web",
    )
    db.add_all(
        [
            span,
            ContentIndexState(
                owner_kind="media",
                owner_id=media.id,
                revision=1,
                status="ready" if ready else "pending",
                active_embedding_provider="openai",
                active_embedding_model=_EMBEDDING_MODEL,
            ),
        ]
    )
    db.flush()
    return media.id, span.id


def test_hybrid_search_projects_only_finalists_with_identical_visible_ranking(
    engine: Engine, tmp_path: Path, record_property: Callable[[str, str], None]
) -> None:
    assert transcript_embedding_dimensions() == 256, "this proof owns a fixed 256-dimension corpus"
    viewer_id, stranger_id = uuid4(), uuid4()
    # Fresh namespace permits repeat runs in the same controller database;
    # relative UUID ordering remains the fixed tie-break fixture.
    id_base = (viewer_id.int >> 32) << 32
    query_vector = [1.0, *([0.0] * 255)]
    orthogonal_vector = [0.0, 1.0, *([0.0] * 254)]
    with Session(engine) as db:
        bootstrap.ensure_user_and_default_library(db, viewer_id)
        bootstrap.ensure_user_and_default_library(db, stranger_id)
        visible_media, visible_span = _media_evidence(db, viewer_id, ready=True)
        hidden_media, hidden_span = _media_evidence(db, stranger_id, ready=True)
        unready_media, unready_span = _media_evidence(db, viewer_id, ready=False)
        chunks = []
        embeddings = []
        for index in range(_VISIBLE_CHUNKS + 2):
            chunk_id = UUID(int=id_base + index)
            media_id, span_id = (
                (hidden_media, hidden_span)
                if index == _VISIBLE_CHUNKS
                else (unready_media, unready_span)
                if index == _VISIBLE_CHUNKS + 1
                else (visible_media, visible_span)
            )
            chunks.append(
                {
                    "id": chunk_id,
                    "owner_kind": "media",
                    "owner_id": media_id,
                    "primary_evidence_span_id": span_id,
                    "chunk_idx": index,
                    "source_kind": "web_article",
                    "chunk_text": ("needle " * 20 if index < 6 else "") + _BODY,
                    "token_count": 1500,
                    "heading_path": [],
                    "summary_locator": {},
                    "created_at": _CREATED_AT,
                }
            )
            embeddings.append(
                {
                    "chunk_id": chunk_id,
                    "embedding_provider": "openai",
                    "embedding_model": "text-embedding-3-small"
                    if index == 12
                    else _EMBEDDING_MODEL,
                    "embedding_dimensions": 256,
                    "embedding_vector": query_vector
                    if 6 <= index <= 12 or index >= _VISIBLE_CHUNKS
                    else orthogonal_vector,
                }
            )
        db.execute(insert(ContentChunk), chunks)
        db.execute(insert(ContentEmbedding), embeddings)
        # No other connection needs these rows; closing the session rolls the
        # large corpus back even when a plan/budget assertion fails.
        db.execute(text("SET LOCAL work_mem = '4MB'"))
        db.execute(text("SET LOCAL jit = off"))
        db.execute(text("SET LOCAL statement_timeout = '30s'"))
        for table in ("content_chunks", "content_embeddings", "content_index_states"):
            db.execute(text(f"ANALYZE {table}"))

        captured: list[tuple[str, dict]] = []

        def capture_query(
            _connection: object, clause: object, _multi: object, params: dict, _options: object
        ) -> None:
            sql = str(clause)
            if "semantic_candidates AS" in sql:
                captured.append((sql, dict(params)))

        connection = db.connection()
        event.listen(connection, "before_execute", capture_query)
        try:
            results = _search_content_chunks(
                db,
                viewer_id,
                "needle",
                (_EMBEDDING_MODEL, query_vector),
                True,
                "all",
                None,
                None,
                [],
                [],
                _FINAL_LIMIT,
            )
        finally:
            event.remove(connection, "before_execute", capture_query)
        assert len(captured) == 1
        optimized_sql, params = captured[0]
        baseline_sql = (
            Path(__file__).parents[3] / "testdata/search/chat_search_before.sql"
        ).read_text()
        old_rows = db.execute(text(baseline_sql), params).all()
        new_rows = db.execute(text(optimized_sql), params).all()
        assert new_rows == old_rows, "candidate union changed visible ranking"
        expected_ids = [UUID(int=id_base + index) for index in range(_FINAL_LIMIT)]
        assert [row.id for row in results] == expected_ids
        assert [row[0] for row in new_rows] == expected_ids
        assert [row.score.raw for row in results] == pytest.approx([row[-1] for row in old_rows])

        # Warm both paths before recording paired samples; retain every actual
        # plan rather than guessing evaluation count from SQL spelling alone.
        plans: dict[str, list[dict]] = {"before": [], "after": []}
        for sample in range(4):
            for name, sql in (("before", baseline_sql), ("after", optimized_sql)):
                plan = db.execute(
                    text("EXPLAIN (ANALYZE, BUFFERS, VERBOSE, FORMAT JSON) " + sql), params
                ).scalar_one()[0]
                if sample:
                    plans[name].append(plan)
        settings = db.execute(
            text(
                "SELECT version(), current_setting('work_mem'), current_setting('jit'), (SELECT extversion FROM pg_extension WHERE extname = 'vector')"
            )
        ).one()
        timings = {name: [p["Execution Time"] for p in samples] for name, samples in plans.items()}
        artifact = tmp_path / "hybrid-search-plan-proof.json"
        artifact.write_text(
            json.dumps(
                {
                    "environment": tuple(settings),
                    "visible_chunks": _VISIBLE_CHUNKS,
                    "body_bytes": len(_BODY.encode()),
                    "final_limit": _FINAL_LIMIT,
                    "budget_ms": _QUERY_BUDGET_MS,
                    "timings_ms": timings,
                    "plans": plans,
                },
                indent=2,
            )
        )
        record_property("hybrid_search_plan_evidence", str(artifact))
        assert median(timings["after"]) < _QUERY_BUDGET_MS, str(artifact)
        assert median(timings["after"]) < median(timings["before"]) * 0.5, str(artifact)

        def nodes(plan: dict):
            yield plan
            for child in plan.get("Plans", []):
                yield from nodes(child)

        final_nodes = list(nodes(plans["after"][-1]["Plan"]))
        headline_nodes = [
            node
            for node in final_nodes
            if any("ts_headline(" in value for value in node.get("Output", []))
        ]
        assert headline_nodes
        assert all(
            node["Actual Rows"] * node["Actual Loops"] <= _FINAL_LIMIT for node in headline_nodes
        ), str(artifact)
