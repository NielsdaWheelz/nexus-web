"""Priority proof for durable Notes-domain search-result resolution."""

from __future__ import annotations

import base64
import json
import struct
from uuid import uuid4

import httpx
import pytest
from sqlalchemy import Engine, event, text
from sqlalchemy.orm import Session

from nexus.config import clear_settings_cache
from nexus.db.models import ContentChunk, ContentEmbedding, ContentIndexState, NoteBlock, Page
from nexus.errors import ApiErrorCode, NotFoundError
from nexus.schemas.search import SearchResultNoteBlockOut, SearchResultPageOut
from nexus.services import bootstrap
from nexus.services.search.query import SearchQuery
from nexus.services.search.resolver import get_search_result
from nexus.services.search.service import search


def test_note_search_unions_lexical_and_semantic_hits_into_owned_citable_results(
    db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Shared SQL must retain both candidate arms and project the winning note's body/locator."""
    # The embedding is the only external response stub. Search orchestration,
    # provider decoding, PostgreSQL/pgvector, ranking and projection stay real.
    vector = [1.0, *([0.0] * 255)]
    model = "openai_text_embedding_3_small_256_v1"
    limit = 3

    async def embedding_response(
        _transport: httpx.AsyncHTTPTransport, request: httpx.Request
    ) -> httpx.Response:
        assert request.method == "POST"
        assert str(request.url) == "https://api.openai.com/v1/embeddings"
        assert json.loads(request.content) == {
            "input": ["nebula"],
            "model": "text-embedding-3-small",
            "dimensions": 256,
            "encoding_format": "base64",
        }
        return httpx.Response(
            200,
            request=request,
            json={
                "object": "list",
                "model": "text-embedding-3-small",
                "data": [
                    {
                        "object": "embedding",
                        "index": 0,
                        "embedding": base64.b64encode(struct.pack("<256f", *vector)).decode(
                            "ascii"
                        ),
                    }
                ],
                "usage": {"prompt_tokens": 1, "total_tokens": 1},
            },
        )

    monkeypatch.setattr(httpx.AsyncHTTPTransport, "handle_async_request", embedding_response)
    monkeypatch.setenv("OPENAI_API_KEY", "note-search-fixture-key")
    monkeypatch.setenv("TRANSCRIPT_EMBEDDING_MODEL_OPENAI", "text-embedding-3-small")
    monkeypatch.setenv("TRANSCRIPT_EMBEDDING_DIMENSIONS", "256")
    clear_settings_cache()
    try:
        owner_id, foreign_id = uuid4(), uuid4()
        bootstrap.ensure_user_and_default_library(db_session, owner_id)
        bootstrap.ensure_user_and_default_library(db_session, foreign_id)
        notes: dict[str, NoteBlock] = {}
        # No embedding on the lexical-only row: dropping either candidate arm
        # must remove an expected result. The overlap must appear exactly once.
        cases = (
            ("overlap", owner_id, "ready", "nebula observations map stellar nurseries.", model),
            ("lexical", owner_id, "ready", "nebula navigation marks a distant region.", None),
            ("semantic", owner_id, "ready", "Stars gather within vast interstellar clouds.", model),
            ("foreign", foreign_id, "ready", "nebula foreign private observations.", model),
            ("unready", owner_id, "pending", "nebula unfinished observations.", model),
            (
                "wrong_model",
                owner_id,
                "ready",
                "Hidden coordinates describe distant stellar clouds.",
                "openai_text_embedding_3_large_256_v1",
            ),
        )
        for name, user_id, status, body, embedding_model in cases:
            note = NoteBlock(
                user_id=user_id,
                body_pm_json={
                    "type": "doc",
                    "content": [{"type": "paragraph", "content": [{"type": "text", "text": body}]}],
                },
                body_text=body,
            )
            db_session.add(note)
            db_session.flush()
            notes[name] = note
            chunk = ContentChunk(
                owner_kind="note_block",
                owner_id=note.id,
                chunk_idx=0,
                source_kind="note",
                chunk_text=body,
                token_count=len(body.split()),
                heading_path=[],
                summary_locator={
                    "note_block_id": str(note.id),
                    "start_offset": 0,
                    "end_offset": len(body),
                },
            )
            db_session.add_all(
                [
                    chunk,
                    ContentIndexState(
                        owner_kind="note_block",
                        owner_id=note.id,
                        revision=1,
                        status=status,
                        active_embedding_provider="openai",
                        active_embedding_model=model,
                    ),
                ]
            )
            db_session.flush()
            if embedding_model is not None:
                db_session.add(
                    ContentEmbedding(
                        chunk_id=chunk.id,
                        embedding_provider="openai",
                        embedding_model=embedding_model,
                        embedding_dimensions=256,
                        embedding_vector=vector,
                    )
                )
        db_session.flush()

        captured: list[tuple[str, dict]] = []

        def capture_query(
            _connection: object, clause: object, _multi: object, params: dict, _options: object
        ) -> None:
            sql = str(clause)
            if "semantic_candidates AS" in sql:
                captured.append((sql, dict(params)))

        connection = db_session.connection()
        event.listen(connection, "before_execute", capture_query)
        try:
            response = search(
                db_session,
                owner_id,
                SearchQuery(text="nebula", requested_kinds=frozenset({"notes"}), limit=limit),
            )
        finally:
            event.remove(connection, "before_execute", capture_query)
        assert len(captured) == 1, "note search must execute one hybrid candidate query"
        expected = [notes[name] for name in ("overlap", "lexical", "semantic")]
        actual_ids = [result.id for result in response.results]
        expected_ids = [note.id for note in expected]
        assert actual_ids == expected_ids, (
            "candidate union changed owned note recall: "
            f"expected={expected_ids!r}, actual={actual_ids!r}"
        )
        assert not response.page.has_more
        assert response.page.next_cursor is None
        for result, note in zip(response.results, expected, strict=True):
            assert isinstance(result, SearchResultNoteBlockOut)
            assert result.body_text == note.body_text
            assert result.note_origin == "note"
            assert result.highlight_excerpt is None
            assert result.resource_ref == f"note_block:{note.id}"
            assert result.locator.model_dump(mode="json", exclude_none=True) == {
                "type": "note_block_offsets",
                "block_id": str(note.id),
                "start_offset": 0,
                "end_offset": len(note.body_text),
            }
            plain_snippet = result.snippet.replace("<b>", "").replace("</b>", "")
            assert plain_snippet and plain_snippet in note.body_text, (
                "note search returned a snippet outside its canonical body: "
                f"note={note.id}, snippet={result.snippet!r}"
            )
            if "nebula" in note.body_text:
                assert "<b>nebula</b>" in result.snippet

        # Four owned ready chunks enter eligibility, but only three survive
        # ranking. Measure the real plan: snippets belong to those finalists.
        hybrid_sql, params = captured[0]
        plan = db_session.execute(
            text("EXPLAIN (ANALYZE, VERBOSE, FORMAT JSON) " + hybrid_sql), params
        ).scalar_one()[0]

        def nodes(node: dict):
            yield node
            for child in node.get("Plans", []):
                yield from nodes(child)

        headline_nodes = [
            node
            for node in nodes(plan["Plan"])
            if any("ts_headline(" in value for value in node.get("Output", []))
        ]
        assert headline_nodes, "note search plan did not expose its snippet evaluation"
        assert all(
            node["Actual Rows"] * node["Actual Loops"] <= limit for node in headline_nodes
        ), f"note search projected snippets beyond its final limit of {limit}: {headline_nodes!r}"
    finally:
        clear_settings_cache()


def test_page_and_note_block_results_reresolve_under_one_owner_contract(
    engine: Engine,
) -> None:
    owner_id = uuid4()
    foreign_id = uuid4()
    with Session(engine, expire_on_commit=False) as db:
        bootstrap.ensure_user_and_default_library(
            db,
            owner_id,
            f"notes-search-owner-{owner_id}@example.invalid",
        )
        bootstrap.ensure_user_and_default_library(
            db,
            foreign_id,
            f"notes-search-foreign-{foreign_id}@example.invalid",
        )
        page = Page(user_id=owner_id, title="Durable page result")
        foreign_page = Page(user_id=foreign_id, title="Foreign page result")
        note = NoteBlock(
            user_id=owner_id,
            body_pm_json={"type": "doc", "content": []},
            body_text="Durable note block result",
        )
        foreign_note = NoteBlock(
            user_id=foreign_id,
            body_pm_json={"type": "doc", "content": []},
            body_text="Foreign note block result",
        )
        unready_note = NoteBlock(
            user_id=owner_id,
            body_pm_json={"type": "doc", "content": []},
            body_text="Unready note block result",
        )
        db.add_all([page, foreign_page, note, foreign_note, unready_note])
        db.flush()
        db.add_all(
            [
                ContentIndexState(
                    owner_kind="note_block",
                    owner_id=note.id,
                    revision=1,
                    status="ready",
                ),
                ContentIndexState(
                    owner_kind="note_block",
                    owner_id=foreign_note.id,
                    revision=1,
                    status="ready",
                ),
            ]
        )
        db.commit()

        page_result = get_search_result(db, owner_id, "page", str(page.id))
        note_result = get_search_result(db, owner_id, "note_block", str(note.id))

        assert isinstance(page_result, SearchResultPageOut)
        assert page_result.id == page.id
        assert page_result.title == page.title
        assert page_result.snippet == page.title

        assert isinstance(note_result, SearchResultNoteBlockOut)
        assert note_result.id == note.id
        assert note_result.body_text == note.body_text
        assert note_result.snippet == note.body_text
        assert note_result.note_origin == "note"
        assert note_result.highlight_excerpt is None
        assert note_result.locator.model_dump(mode="json", exclude_none=True) == {
            "type": "note_block_offsets",
            "block_id": str(note.id),
            "start_offset": 0,
            "end_offset": len(note.body_text),
        }

        hidden_refs = (
            (owner_id, "page", foreign_page.id),
            (owner_id, "note_block", foreign_note.id),
            (owner_id, "note_block", unready_note.id),
        )
        for viewer_id, result_type, result_id in hidden_refs:
            with pytest.raises(NotFoundError) as denied:
                get_search_result(db, viewer_id, result_type, str(result_id))
            assert denied.value.code is ApiErrorCode.E_NOT_FOUND
