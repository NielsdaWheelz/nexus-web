"""The reader cut preserves immutable text and accepted progress while repairing structure."""

from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path
from uuid import UUID

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import create_engine, text

from nexus.services.generation_spec import GenerationSpec, GenerationSpecFacts
from tests.testkit.generation_ledger import generation_spec_fixture


def test_reader_structure_repair_preserves_fragment_identity_and_cursor(
    empty_migration_database_url: str,
) -> None:
    migration_root = Path(__file__).parents[3] / "migrations"
    config = Config(migration_root / "alembic.ini")
    config.set_main_option("script_location", str(migration_root / "alembic"))
    command.upgrade(config, "0227")
    media_id = UUID("00000000-0000-0000-0000-000000002280")
    fragment_id = UUID("00000000-0000-0000-0000-000000002281")
    user_id = UUID("00000000-0000-0000-0000-000000002282")
    cursor_id = UUID("00000000-0000-0000-0000-000000002283")
    anchor_id = UUID("00000000-0000-0000-0000-000000002284")
    web_media_id = UUID("00000000-0000-0000-0000-000000002285")
    web_fragment_id = UUID("00000000-0000-0000-0000-000000002286")
    web_block_id = UUID("00000000-0000-0000-0000-000000002287")
    conversation_id = UUID("00000000-0000-0000-0000-000000002288")
    user_message_id = UUID("00000000-0000-0000-0000-000000002289")
    assistant_message_id = UUID("00000000-0000-0000-0000-000000002290")
    tool_call_id = UUID("00000000-0000-0000-0000-000000002291")
    retrieval_id = UUID("00000000-0000-0000-0000-000000002292")
    run_id = UUID("00000000-0000-0000-0000-000000002293")
    event_id = UUID("00000000-0000-0000-0000-000000002294")
    anchor_user_id = UUID("00000000-0000-0000-0000-000000002295")
    anchor_cursor_id = UUID("00000000-0000-0000-0000-000000002296")
    manual_user_id = UUID("00000000-0000-0000-0000-000000002297")
    manual_cursor_id = UUID("00000000-0000-0000-0000-000000002298")
    citation_edge_id = UUID("00000000-0000-0000-0000-000000002299")
    chunk_citation_edge_id = UUID("00000000-0000-0000-0000-000000002300")
    citation_event_id = UUID("00000000-0000-0000-0000-000000002301")
    chunk_id = UUID("00000000-0000-0000-0000-000000002302")
    created_at = datetime(2026, 9, 11, 12, tzinfo=UTC)
    canonical = "first\none\nsecond\ntwo"
    html = '<h1 id="first-start">first</h1><p>one</p><h1>second</h1><p>two</p>'
    selector = {
        "quote": {"exact": "second", "prefix": "one ", "suffix": " two"},
        "locator_hint": {
            "kind": "text",
            "section_id": "spine:0",
            "fragment_id": str(fragment_id),
            "start_offset": 10,
            "end_offset": 16,
        },
    }
    web_locator = {
        "kind": "web_text",
        "fragment_id": str(web_fragment_id),
        "fragment_idx": 0,
        "start_offset": 0,
        "end_offset": 6,
        "section_id": "web-heading:0:0:first",
        "anchor_id": "first-start",
        "heading_level": 1,
    }
    locator = {
        "kind": "epub",
        "target": {"section_id": "spine:0", "href_path": "book.xhtml", "anchor_id": None},
        "locations": {
            "text_offset": 10,
            "progression": 0.5,
            "total_progression": 0.5,
            "position": 1,
        },
        "text": {"quote": "second", "quote_prefix": "one\n", "quote_suffix": "\ntwo"},
    }
    anchor_locator = {
        **locator,
        "target": {
            "section_id": "kept:first",
            "href_path": "book.xhtml",
            "anchor_id": "first-start",
        },
        "locations": {
            "text_offset": None,
            "progression": None,
            "total_progression": None,
            "position": None,
        },
        "text": {"quote": None, "quote_prefix": None, "quote_suffix": None},
    }
    manual_locator = {
        **anchor_locator,
        "target": {"section_id": "spine:0", "href_path": "book.xhtml", "anchor_id": None},
    }
    passage_locator = {
        "type": "epub_fragment_offsets",
        "media_id": str(media_id),
        "fragment_id": str(fragment_id),
        "section_id": "spine:0",
        "start_offset": 10,
        "end_offset": 16,
    }
    chunk_locator = {
        "kind": "epub_text",
        "fragment_id": str(fragment_id),
        "fragment_idx": 0,
        "section_id": "spine:0",
        "start_offset": 10,
        "end_offset": 16,
    }
    context_ref = {"type": "fragment", "id": str(fragment_id)}
    old_link = f"/media/{media_id}?loc=spine%3A0"
    citation_snapshot = {
        "title": "source sections",
        "excerpt": "second",
        "section_label": "book",
        "result_type": "fragment",
        "deep_link": old_link,
    }
    chunk_snapshot = {**citation_snapshot, "result_type": "content_chunk"}
    # Fragment CitationOut has no intrinsic finer locator; its replay envelope
    # identifies the citation edge whose retained retrieval owns that passage.
    citation = {
        "ordinal": 1,
        "role": "context",
        "target_ref": {"type": "fragment", "id": str(fragment_id)},
        "activation": {
            "resource_ref": f"fragment:{fragment_id}",
            "kind": "route",
            "href": f"/media/{media_id}#fragment-{fragment_id}",
            "unresolved_reason": None,
        },
        "media_id": str(media_id),
        "locator": None,
        "deep_link": old_link,
        "snapshot": {
            "title": "source sections",
            "excerpt": "second",
            "section_label": "book",
            "result_type": "fragment",
            "summary_md": None,
        },
    }
    citation_event_payload = {
        "assistant_message_id": str(assistant_message_id),
        "citations": [{"citation_edge_id": str(citation_edge_id), "citation": citation}],
    }
    result_ref = {
        "type": "fragment",
        "result_type": "fragment",
        "id": str(fragment_id),
        "source_id": str(fragment_id),
        "title": "source sections",
        "snippet": "second",
        "deep_link": old_link,
        "context_ref": context_ref,
        "media_id": str(media_id),
        "media_kind": "epub",
        "locator": passage_locator,
    }
    event_payload = {
        "record_kind": "attached_context",
        "canonical_tool_id": None,
        "provider_wire_name": None,
        "canonical_input_sha256": None,
        "tool_contract_revision": None,
        "binding_policy_revision": None,
        "effect": None,
        "error_type": None,
        "result_kind": "attached_context",
        "activity_label": "Attached conversation context",
        "tool_call_id": str(tool_call_id),
        "assistant_message_id": str(assistant_message_id),
        "tool_call_index": 0,
        "status": "complete",
        "scope": "attached_context",
        "types": ["fragment"],
        "filters": {},
        "results": [result_ref],
    }
    generation_facts = generation_spec_fixture()
    del generation_facts["fingerprint"]
    generation_facts.update(operation="chat", selection_source="ChatRun")
    generation = GenerationSpec.freeze(
        GenerationSpecFacts.model_validate_json(json.dumps(generation_facts))
    ).model_dump(mode="json", by_alias=True)
    engine = create_engine(empty_migration_database_url)
    try:
        with engine.begin() as connection:
            connection.execute(
                text("INSERT INTO users (id) VALUES (:id), (:anchor_user), (:manual_user)"),
                {"id": user_id, "anchor_user": anchor_user_id, "manual_user": manual_user_id},
            )
            connection.execute(
                text("INSERT INTO conversations (id, owner_user_id) VALUES (:id, :user)"),
                {"id": conversation_id, "user": user_id},
            )
            connection.execute(
                text(
                    "INSERT INTO messages (id, conversation_id, seq, role, content, parent_message_id) "
                    "VALUES (:user, :conversation, 1, 'user', 'question', NULL), "
                    "(:assistant, :conversation, 2, 'assistant', 'second', :user)"
                ),
                {
                    "user": user_message_id,
                    "assistant": assistant_message_id,
                    "conversation": conversation_id,
                },
            )
            connection.execute(
                text(
                    "INSERT INTO message_tool_calls (id, conversation_id, user_message_id, assistant_message_id, "
                    "record_kind, tool_call_index, scope, status, result_refs, selected_context_refs) "
                    "VALUES (:id, :conversation, :user, :assistant, 'attached_context', 0, 'attached_context', 'complete', "
                    "CAST(:results AS jsonb), CAST(:contexts AS jsonb))"
                ),
                {
                    "id": tool_call_id,
                    "conversation": conversation_id,
                    "user": user_message_id,
                    "assistant": assistant_message_id,
                    "results": json.dumps([result_ref]),
                    "contexts": json.dumps([context_ref]),
                },
            )
            connection.execute(
                text(
                    "INSERT INTO chat_runs (id, owner_user_id, conversation_id, user_message_id, assistant_message_id, generation_spec, status) "
                    "VALUES (:id, :owner, :conversation, :user, :assistant, CAST(:generation AS jsonb), 'complete')"
                ),
                {
                    "id": run_id,
                    "owner": user_id,
                    "conversation": conversation_id,
                    "user": user_message_id,
                    "assistant": assistant_message_id,
                    "generation": json.dumps(generation),
                },
            )
            connection.execute(
                text(
                    "INSERT INTO chat_run_events (id, run_id, seq, event_type, payload, created_at) "
                    "VALUES (:id, :run, 1, 'tool_result', CAST(:payload AS jsonb), :created)"
                ),
                {
                    "id": event_id,
                    "run": run_id,
                    "payload": json.dumps(event_payload),
                    "created": created_at,
                },
            )
            connection.execute(
                text(
                    "INSERT INTO chat_run_events (id, run_id, seq, event_type, payload, created_at) "
                    "VALUES (:id, :run, 2, 'citation_index', CAST(:payload AS jsonb), :created)"
                ),
                {
                    "id": citation_event_id,
                    "run": run_id,
                    "payload": json.dumps(citation_event_payload),
                    "created": created_at,
                },
            )
            connection.execute(
                text(
                    "INSERT INTO media (id, kind, title, processing_status) "
                    "VALUES (:id, 'epub', 'source sections', 'ready_for_reading')"
                ),
                {"id": media_id},
            )
            connection.execute(
                text(
                    "INSERT INTO fragments (id, media_id, idx, canonical_text, html_sanitized) "
                    "VALUES (:id, :media, 0, :canonical, :html)"
                ),
                {"id": fragment_id, "media": media_id, "canonical": canonical, "html": html},
            )
            connection.execute(
                text(
                    "INSERT INTO message_retrievals (id, tool_call_id, ordinal, result_type, source_id, media_id, "
                    "context_ref, result_ref, locator, deep_link, exact_snippet) "
                    "VALUES (:id, :tool, 0, 'fragment', :source, :media, CAST(:context AS jsonb), "
                    "CAST(:result AS jsonb), CAST(:locator AS jsonb), :link, 'second')"
                ),
                {
                    "id": retrieval_id,
                    "tool": tool_call_id,
                    "source": str(fragment_id),
                    "media": media_id,
                    "context": json.dumps(context_ref),
                    "result": json.dumps(result_ref),
                    "locator": json.dumps(passage_locator),
                    "link": old_link,
                },
            )
            connection.execute(
                text(
                    "INSERT INTO content_chunks (id, owner_kind, owner_id, chunk_idx, source_kind, "
                    "chunk_text, token_count, heading_path, summary_locator) "
                    "VALUES (:id, 'media', :media, 0, 'epub', 'second', 1, '[]'::jsonb, "
                    "CAST(:locator AS jsonb))"
                ),
                {"id": chunk_id, "media": media_id, "locator": json.dumps(chunk_locator)},
            )
            connection.execute(
                text(
                    "INSERT INTO resource_edges (id, user_id, kind, origin, source_scheme, source_id, "
                    "target_scheme, target_id, ordinal, snapshot, created_at) "
                    "VALUES (:id, :user, 'context', 'citation', 'message', :message, "
                    "'fragment', :fragment, 1, CAST(:snapshot AS jsonb), :created), "
                    "(:chunk_edge, :user, 'context', 'citation', 'message', :message, "
                    "'content_chunk', :chunk, 2, CAST(:chunk_snapshot AS jsonb), :created)"
                ),
                {
                    "id": citation_edge_id,
                    "user": user_id,
                    "message": assistant_message_id,
                    "fragment": fragment_id,
                    "chunk_edge": chunk_citation_edge_id,
                    "chunk": chunk_id,
                    "snapshot": json.dumps(citation_snapshot),
                    "chunk_snapshot": json.dumps(chunk_snapshot),
                    "created": created_at,
                },
            )
            connection.execute(
                text(
                    "INSERT INTO epub_fragment_sources "
                    "(media_id, fragment_id, package_href, manifest_item_id, media_type, linear, reading_order) "
                    "VALUES (:media, :fragment, 'book.xhtml', 'book', 'application/xhtml+xml', true, 0)"
                ),
                {"media": media_id, "fragment": fragment_id},
            )
            connection.execute(
                text(
                    "INSERT INTO epub_nav_locations "
                    "(media_id, location_id, ordinal, label, fragment_idx, href_path, start_offset, end_offset, source) "
                    "VALUES (:media, 'spine:0', 0, 'book', 0, 'book.xhtml', 0, :length, 'spine')"
                ),
                {"media": media_id, "length": len(canonical)},
            )
            connection.execute(
                text(
                    "INSERT INTO reader_publications (id, media_id, generation) "
                    "VALUES (gen_random_uuid(), :media, 4)"
                ),
                {"media": media_id},
            )
            connection.execute(
                text(
                    "INSERT INTO reader_media_state (id, user_id, media_id, locator, revision) "
                    "VALUES (:id, :user, :media, CAST(:locator AS jsonb), 7)"
                ),
                {
                    "id": cursor_id,
                    "user": user_id,
                    "media": media_id,
                    "locator": json.dumps(locator),
                },
            )
            connection.execute(
                text(
                    "INSERT INTO reader_media_state (id, user_id, media_id, locator, revision) "
                    "VALUES (:id, :user, :media, CAST(:locator AS jsonb), 2)"
                ),
                {
                    "id": anchor_cursor_id,
                    "user": anchor_user_id,
                    "media": media_id,
                    "locator": json.dumps(anchor_locator),
                },
            )
            connection.execute(
                text(
                    "INSERT INTO reader_media_state (id, user_id, media_id, locator, revision) "
                    "VALUES (:id, :user, :media, CAST(:locator AS jsonb), 4)"
                ),
                {
                    "id": manual_cursor_id,
                    "user": manual_user_id,
                    "media": media_id,
                    "locator": json.dumps(manual_locator),
                },
            )
            connection.execute(
                text(
                    "INSERT INTO epub_toc_nodes "
                    "(media_id, node_id, nav_type, label, href, fragment_idx, depth, order_key) "
                    "VALUES (:media, 'source-first', 'toc', 'first', 'book.xhtml#first%2Dstart', 0, 0, '0000')"
                ),
                {"media": media_id},
            )
            connection.execute(
                text(
                    "INSERT INTO epub_nav_locations "
                    "(media_id, location_id, ordinal, label, fragment_idx, href_path, href_fragment, start_offset, end_offset, source) "
                    "VALUES (:media, 'kept:first', 1, 'first', 0, 'book.xhtml', 'first-start', 0, 20, 'toc')"
                ),
                {"media": media_id},
            )
            broken = {
                **selector,
                "locator_hint": {**selector["locator_hint"], "fragment_id": "missing"},
            }
            connection.execute(
                text(
                    "INSERT INTO passage_anchors (id, user_id, owner_scheme, owner_id, selector_version, anchor_key, selector) "
                    "VALUES (:id, :user, 'media', :media, 1, 'immutable-quote-identity', CAST(:selector AS jsonb))"
                ),
                {
                    "id": anchor_id,
                    "user": user_id,
                    "media": media_id,
                    "selector": json.dumps(broken),
                },
            )
            connection.execute(
                text(
                    "INSERT INTO media (id, kind, title, processing_status) "
                    "VALUES (:id, 'web_article', 'different title', 'ready_for_reading')"
                ),
                {"id": web_media_id},
            )
            connection.execute(
                text(
                    "INSERT INTO fragments (id, media_id, idx, canonical_text, html_sanitized) "
                    "VALUES (:id, :media, 0, :canonical, :html)"
                ),
                {
                    "id": web_fragment_id,
                    "media": web_media_id,
                    "canonical": canonical,
                    "html": html,
                },
            )
            connection.execute(
                text(
                    "INSERT INTO reader_publications (id, media_id, generation) VALUES (gen_random_uuid(), :media, 2)"
                ),
                {"media": web_media_id},
            )
            connection.execute(
                text(
                    "INSERT INTO content_blocks (id, owner_kind, owner_id, block_idx, block_kind, canonical_text, "
                    "source_start_offset, source_end_offset, heading_path, locator, selector, metadata) "
                    "VALUES (:id, 'media', :media, 0, 'heading', E'first\\n', 0, 6, '[\"first\"]'::jsonb, "
                    'CAST(:locator AS jsonb), CAST(:locator AS jsonb), \'{"section_id":"web-heading:0:0:first"}\'::jsonb)'
                ),
                {"id": web_block_id, "media": web_media_id, "locator": json.dumps(web_locator)},
            )

        with pytest.raises(RuntimeError, match="lacks an exact passage address"):
            command.upgrade(config, "head")
        with engine.begin() as connection:
            assert connection.scalar(text("SELECT version_num FROM alembic_version")) == "0227"
            assert (
                connection.scalar(
                    text("SELECT revision FROM reader_media_state WHERE id = :id"),
                    {"id": cursor_id},
                )
                == 7
            )
            assert (
                connection.scalar(
                    text("SELECT generation FROM reader_publications WHERE media_id = :media"),
                    {"media": media_id},
                )
                == 4
            )
            assert (
                connection.scalar(
                    text(
                        "SELECT count(*) FROM information_schema.columns WHERE table_name = 'epub_nav_locations' AND column_name = 'parent_section_id'"
                    )
                )
                == 0
            )
            connection.execute(
                text(
                    "UPDATE passage_anchors SET selector = CAST(:selector AS jsonb) WHERE id = :id"
                ),
                {"id": anchor_id, "selector": json.dumps(selector)},
            )
            connection.execute(
                text(
                    "UPDATE reader_media_state SET locator = CAST(:locator AS jsonb) WHERE id = :id"
                ),
                {
                    "id": anchor_cursor_id,
                    "locator": json.dumps(
                        {
                            **anchor_locator,
                            "target": {**anchor_locator["target"], "anchor_id": None},
                            "locations": {**anchor_locator["locations"], "progression": 0.5},
                        }
                    ),
                },
            )

        with pytest.raises(RuntimeError, match="cannot resolve accepted cursor locus"):
            command.upgrade(config, "head")
        with engine.begin() as connection:
            assert connection.scalar(text("SELECT version_num FROM alembic_version")) == "0227"
            assert connection.execute(
                text("SELECT id, revision FROM reader_media_state ORDER BY id")
            ).all() == [(cursor_id, 7), (anchor_cursor_id, 2), (manual_cursor_id, 4)]
            connection.execute(
                text(
                    "UPDATE reader_media_state SET locator = CAST(:locator AS jsonb) WHERE id = :id"
                ),
                {"id": anchor_cursor_id, "locator": json.dumps(anchor_locator)},
            )

        # The citation's fragment target alone cannot recover the finer passage
        # recorded by its old link. A missing retained address must abort the cut.
        with pytest.raises(RuntimeError, match="cannot resolve stored link"):
            command.upgrade(config, "head")
        with engine.begin() as connection:
            assert connection.scalar(text("SELECT version_num FROM alembic_version")) == "0227"
            assert (
                connection.scalar(
                    text("SELECT revision FROM reader_media_state WHERE id = :id"),
                    {"id": cursor_id},
                )
                == 7
            )
            assert (
                connection.scalar(
                    text("SELECT deep_link FROM message_retrievals WHERE id = :id"),
                    {"id": retrieval_id},
                )
                == old_link
            )
            assert (
                connection.scalar(
                    text("SELECT snapshot FROM resource_edges WHERE id = :id"),
                    {"id": citation_edge_id},
                )
                == citation_snapshot
            )
            # Chat records this pointer when it copies the retrieval snapshot;
            # the retained locator supplies literal offsets 10..16, not the file.
            connection.execute(
                text("UPDATE message_retrievals SET cited_edge_id = :edge WHERE id = :id"),
                {"id": retrieval_id, "edge": citation_edge_id},
            )

        command.upgrade(config, "head")

        with engine.connect() as connection:
            cursor = connection.execute(
                text("SELECT id, locator, revision FROM reader_media_state WHERE id = :id"),
                {"id": cursor_id},
            ).one()
            expected = {
                **locator,
                "target": {
                    "fragment_id": str(fragment_id),
                    "href_path": "book.xhtml",
                    "anchor_id": {"kind": "Absent"},
                },
            }
            assert cursor == (cursor_id, expected, 8), (
                f"reader structure migration changed accepted progress or failed exact fragment conversion: {cursor!r}"
            )
            assert connection.execute(
                text("SELECT id, locator, revision FROM reader_media_state WHERE id = :id"),
                {"id": anchor_cursor_id},
            ).one() == (
                anchor_cursor_id,
                {
                    **anchor_locator,
                    "target": {
                        "fragment_id": str(fragment_id),
                        "href_path": "book.xhtml",
                        "anchor_id": {"kind": "Present", "value": "first-start"},
                    },
                },
                3,
            )
            assert connection.execute(
                text("SELECT id, locator, revision FROM reader_media_state WHERE id = :id"),
                {"id": manual_cursor_id},
            ).one() == (
                manual_cursor_id,
                {
                    **manual_locator,
                    "target": {
                        "fragment_id": str(fragment_id),
                        "href_path": "book.xhtml",
                        "anchor_id": {"kind": "Absent"},
                    },
                    "locations": {**manual_locator["locations"], "text_offset": 0},
                },
                5,
            )
            repaired_locator = {
                key: value for key, value in passage_locator.items() if key != "section_id"
            }
            exact_link = f"/media/{media_id}?fragment={fragment_id}#text-{fragment_id}:10:16"
            for edge_id, target_scheme, target_id, ordinal, edge_snapshot in (
                (citation_edge_id, "fragment", fragment_id, 1, citation_snapshot),
                (chunk_citation_edge_id, "content_chunk", chunk_id, 2, chunk_snapshot),
            ):
                assert connection.execute(
                    text(
                        "SELECT id, user_id, kind, origin, source_scheme, source_id, target_scheme, "
                        "target_id, ordinal, snapshot, created_at FROM resource_edges WHERE id = :id"
                    ),
                    {"id": edge_id},
                ).one() == (
                    edge_id,
                    user_id,
                    "context",
                    "citation",
                    "message",
                    assistant_message_id,
                    target_scheme,
                    target_id,
                    ordinal,
                    {**edge_snapshot, "deep_link": exact_link},
                    created_at,
                ), (
                    "reader structure migration must preserve citation identity and its exact passage link"
                )
            assert connection.execute(
                text("SELECT id, chunk_text, summary_locator FROM content_chunks WHERE id = :id"),
                {"id": chunk_id},
            ).one() == (
                chunk_id,
                "second",
                {key: value for key, value in chunk_locator.items() if key != "section_id"},
            )
            repaired_result = {
                **result_ref,
                "locator": repaired_locator,
                "deep_link": exact_link,
            }
            assert connection.execute(
                text(
                    "SELECT id, locator, context_ref, result_ref, deep_link, exact_snippet FROM message_retrievals WHERE id = :id"
                ),
                {"id": retrieval_id},
            ).one() == (
                retrieval_id,
                repaired_locator,
                context_ref,
                repaired_result,
                exact_link,
                "second",
            )
            assert connection.execute(
                text(
                    "SELECT result_refs, selected_context_refs FROM message_tool_calls WHERE id = :id"
                ),
                {"id": tool_call_id},
            ).one() == ([repaired_result], [context_ref])
            assert connection.execute(
                text("SELECT id, seq, created_at, payload FROM chat_run_events WHERE id = :id"),
                {"id": event_id},
            ).one() == (event_id, 1, created_at, {**event_payload, "results": [repaired_result]})
            assert connection.execute(
                text("SELECT id, seq, created_at, payload FROM chat_run_events WHERE id = :id"),
                {"id": citation_event_id},
            ).one() == (
                citation_event_id,
                2,
                created_at,
                {
                    **citation_event_payload,
                    "citations": [
                        {
                            "citation_edge_id": str(citation_edge_id),
                            "citation": {**citation, "deep_link": exact_link},
                        }
                    ],
                },
            ), (
                "citation replay must preserve its null locator and recover the exact edge passage link"
            )
            assert (
                connection.scalar(
                    text("SELECT generation_spec FROM chat_runs WHERE id = :id"), {"id": run_id}
                )
                == generation
            )
            assert (
                connection.scalar(
                    text("SELECT content FROM messages WHERE id = :id"),
                    {"id": assistant_message_id},
                )
                == "second"
            )
            assert connection.execute(
                text(
                    "SELECT id, canonical_text, html_sanitized FROM fragments WHERE media_id = :media"
                ),
                {"media": media_id},
            ).one() == (fragment_id, canonical, html)
            assert connection.execute(
                text(
                    "SELECT label, start_offset, end_fragment_idx, end_offset FROM epub_nav_locations "
                    "WHERE media_id = :media ORDER BY ordinal"
                ),
                {"media": media_id},
            ).all() == [("first", 0, 0, 10), ("second", 10, 0, 20)]
            assert (
                connection.scalar(
                    text(
                        "SELECT location_id FROM epub_nav_locations WHERE media_id = :media AND label = 'first'"
                    ),
                    {"media": media_id},
                )
                == "kept:first"
            )
            assert connection.execute(
                text("SELECT id, anchor_key, selector FROM passage_anchors WHERE id = :id"),
                {"id": anchor_id},
            ).one() == (
                anchor_id,
                "immutable-quote-identity",
                {
                    **selector,
                    "locator_hint": {
                        key: value
                        for key, value in selector["locator_hint"].items()
                        if key != "section_id"
                    },
                },
            )
            repaired_web_locator = {
                **web_locator,
                "parent_section_id": {"kind": "Absent"},
                "owns_container": False,
            }
            assert connection.execute(
                text(
                    "SELECT id, canonical_text, source_start_offset, source_end_offset, locator, selector FROM content_blocks WHERE id = :id"
                ),
                {"id": web_block_id},
            ).one() == (
                web_block_id,
                "first\n",
                0,
                6,
                repaired_web_locator,
                repaired_web_locator,
            )
            assert connection.execute(
                text(
                    "SELECT id, canonical_text, html_sanitized FROM fragments WHERE media_id = :media"
                ),
                {"media": web_media_id},
            ).one() == (web_fragment_id, canonical, html)
            assert (
                connection.scalar(
                    text("SELECT generation FROM reader_publications WHERE media_id = :media"),
                    {"media": web_media_id},
                )
                == 3
            )
            assert (
                connection.scalar(
                    text("SELECT generation FROM reader_publications WHERE media_id = :media"),
                    {"media": media_id},
                )
                == 5
            )
        command.upgrade(config, "head")
        with engine.connect() as connection:
            assert (
                connection.scalar(
                    text("SELECT revision FROM reader_media_state WHERE id = :id"),
                    {"id": cursor_id},
                )
                == 8
            )
            assert (
                connection.scalar(
                    text("SELECT generation FROM reader_publications WHERE media_id = :media"),
                    {"media": media_id},
                )
                == 5
            )
            assert (
                connection.scalar(
                    text("SELECT generation FROM reader_publications WHERE media_id = :media"),
                    {"media": web_media_id},
                )
                == 3
            )
    finally:
        engine.dispose()
