"""A populated db0215 survives the restoration's complete forward migration chain."""

from __future__ import annotations

import hashlib
import io
import json
from pathlib import Path
from uuid import uuid4
from zipfile import ZipFile

from alembic import command
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import create_engine, inspect, text

from nexus.storage.client import get_storage_client


def test_populated_0215_reaches_head_preserving_content_and_declaring_history_loss(
    empty_migration_database_url: str,
) -> None:
    """Retained content crosses every cut; old chat, audit, and date losses are explicit.

    The supported starting state has stopped writers, terminal generation work,
    and intact source objects. Individual migration proofs own refusal cases.
    All rows originate at 0215. One upgrade to head preserves production's
    transaction boundaries, including 0221's autocommit digest backfill.
    """
    migration_root = Path(__file__).parents[3] / "migrations"
    config = Config(migration_root / "alembic.ini")
    config.set_main_option("script_location", str(migration_root / "alembic"))
    scripts = ScriptDirectory.from_config(config)
    assert scripts.get_current_head() == "0229", (
        "review this production-snapshot proof for a new head"
    )
    assert [revision.revision for revision in scripts.iterate_revisions("head", "0215")] == [
        f"{revision:04d}" for revision in range(229, 215, -1)
    ]
    command.upgrade(config, "0215")

    ids = {
        name: uuid4()
        for name in (
            "user",
            "library",
            "entry",
            "note",
            "epub",
            "podcast",
            "fragment",
            "cursor",
            "source_attempt",
            "conversation",
            "user_message",
            "assistant_message",
            "chat_run",
            "tool_call",
            "metadata_call",
            "chat_call",
            "generation_job",
        )
    }
    canonical = "first\none\nsecond\ntwo"
    html = '<h1 id="first-start">first</h1><p>one</p><h1>second</h1><p>two</p>'
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
    # A small real EPUB source agrees with the stored fragment and source href.
    archive = io.BytesIO()
    with ZipFile(archive, "w") as epub:
        epub.writestr("mimetype", "application/epub+zip")
        epub.writestr(
            "META-INF/container.xml",
            '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">'
            '<rootfiles><rootfile full-path="package.opf" '
            'media-type="application/oebps-package+xml"/></rootfiles></container>',
        )
        epub.writestr(
            "package.opf",
            '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">'
            '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">'
            '<dc:identifier id="id">restoration-source</dc:identifier>'
            "<dc:title>retained book</dc:title><dc:language>en</dc:language>"
            '<meta property="dcterms:modified">2026-08-13T00:00:00Z</meta></metadata>'
            '<manifest><item id="book" href="book.xhtml" media-type="application/xhtml+xml"/>'
            '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>'
            '</manifest><spine><itemref idref="book"/></spine></package>',
        )
        epub.writestr(
            "book.xhtml",
            '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>retained book</title></head>'
            f"<body>{html}</body></html>",
        )
        epub.writestr(
            "nav.xhtml",
            '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">'
            '<head><title>contents</title></head><body><nav epub:type="toc"><ol>'
            '<li><a href="book.xhtml#first-start">first</a></li></ol></nav></body></html>',
        )
    source = archive.getvalue()
    source_path = f"migration/restoration/{ids['epub']}.epub"
    parameters = {
        **ids,
        "canonical": canonical,
        "html": html,
        "length": len(canonical),
        "locator": json.dumps(locator),
        "source_path": source_path,
        "source_size": len(source),
    }
    preserved_tables = (
        "users",
        "libraries",
        "memberships",
        "library_entries",
        "note_blocks",
        "fragments",
    )
    storage = get_storage_client()
    engine = create_engine(empty_migration_database_url)
    try:
        storage.put_object(source_path, source, "application/epub+zip")
        with engine.begin() as connection:
            # These are frozen db0215 records, deliberately independent of the head ORM.
            for statement in (
                "INSERT INTO users (id, email) VALUES (:user, 'restoration@example.invalid')",
                "INSERT INTO libraries (id, owner_user_id, name) "
                "VALUES (:library, :user, 'retained library')",
                "INSERT INTO memberships (library_id, user_id, role) VALUES (:library, :user, 'admin')",
                "INSERT INTO media (id, kind, title, processing_status, created_by_user_id, published_date) "
                "VALUES (:epub, 'epub', 'retained book', 'ready_for_reading', :user, '2007'), "
                "(:podcast, 'podcast_episode', 'retained podcast', 'ready_for_reading', :user, NULL)",
                "INSERT INTO library_entries (id, library_id, media_id, position) "
                "VALUES (:entry, :library, :epub, 1)",
                "INSERT INTO note_blocks (id, user_id, body_pm_json, body_text) "
                "VALUES (:note, :user, "
                '\'{"type":"doc","content":[{"type":"paragraph","content":['
                '{"type":"text","text":"retained note"}]}]}\'::jsonb, \'retained note\')',
                "INSERT INTO media_file (media_id, storage_path, content_type, size_bytes) "
                "VALUES (:epub, :source_path, 'application/epub+zip', :source_size)",
                "INSERT INTO fragments (id, media_id, idx, canonical_text, html_sanitized) "
                "VALUES (:fragment, :epub, 0, :canonical, :html)",
                "INSERT INTO epub_fragment_sources "
                "(media_id, fragment_id, package_href, manifest_item_id, media_type, linear, reading_order) "
                "VALUES (:epub, :fragment, 'book.xhtml', 'book', 'application/xhtml+xml', true, 0)",
                "INSERT INTO epub_toc_nodes "
                "(media_id, node_id, nav_type, label, href, fragment_idx, depth, order_key) "
                "VALUES (:epub, 'first', 'toc', 'first', 'book.xhtml#first-start', 0, 0, '0000')",
                "INSERT INTO epub_nav_locations "
                "(media_id, location_id, ordinal, source_node_id, label, fragment_idx, href_path, "
                "href_fragment, start_offset, end_offset, source) VALUES "
                "(:epub, 'kept:first', 0, 'first', 'first', 0, 'book.xhtml', 'first-start', 0, :length, 'toc'), "
                "(:epub, 'spine:0', 1, NULL, 'book', 0, 'book.xhtml', NULL, 0, :length, 'spine')",
                "INSERT INTO reader_media_state (id, user_id, media_id, locator, revision) "
                "VALUES (:cursor, :user, :epub, CAST(:locator AS jsonb), 7)",
                "INSERT INTO media_source_attempts "
                "(id, media_id, created_by_user_id, source_type, attempt_no, status, intent_key, source_payload) "
                "VALUES (:source_attempt, :epub, :user, 'uploaded_epub_file', 1, 'succeeded', "
                "'restoration-source', '{}'::jsonb)",
                "INSERT INTO podcast_transcript_request_audits (media_id, request_reason, outcome) "
                "VALUES (:podcast, 'quote', 'queued'), (:podcast, 'quote', 'enqueue_failed')",
                "INSERT INTO conversations (id, owner_user_id, next_seq) VALUES (:conversation, :user, 3)",
                "INSERT INTO messages (id, conversation_id, seq, role, content, status, parent_message_id) "
                "VALUES (:user_message, :conversation, 1, 'user', 'old question', 'complete', NULL), "
                "(:assistant_message, :conversation, 2, 'assistant', 'old answer', 'complete', :user_message)",
                "INSERT INTO chat_runs (id, owner_user_id, conversation_id, user_message_id, "
                "assistant_message_id, idempotency_key, payload_hash, status) "
                "VALUES (:chat_run, :user, :conversation, :user_message, :assistant_message, "
                "'old-command', 'old-fingerprint', 'complete')",
                "INSERT INTO message_tool_calls (id, conversation_id, user_message_id, assistant_message_id, "
                "tool_name, tool_call_index, scope, status) "
                "VALUES (:tool_call, :conversation, :user_message, :assistant_message, 'app_search', 1, 'all', 'complete')",
                "INSERT INTO llm_calls (id, owner_kind, owner_id, call_seq, provider, model_name, "
                "llm_operation, streaming, cost_status, outcome) VALUES "
                "(:metadata_call, 'media_enrichment', :epub, 1, 'openai', 'legacy', 'metadata', false, 'missing_usage', 'succeeded'), "
                "(:chat_call, 'chat_run', :chat_run, 1, 'openai', 'legacy', 'chat', false, 'missing_usage', 'succeeded')",
                "INSERT INTO background_jobs (id, kind, payload, status, attempts, max_attempts) "
                "VALUES (:generation_job, 'enrich_metadata', '{}'::jsonb, 'succeeded', 1, 5)",
            ):
                connection.execute(text(statement), parameters)

            preserved = {
                table: connection.execute(
                    text(
                        f"SELECT to_jsonb(record) FROM {table} record ORDER BY to_jsonb(record)::text"
                    )
                ).all()
                for table in preserved_tables
            }
            assert all(preserved.values()), (
                "every preservation oracle must have a populated witness"
            )
            old_media = connection.execute(
                text("SELECT to_jsonb(record) - 'published_date' FROM media record ORDER BY id")
            ).all()

        command.upgrade(config, "head")
        with engine.connect() as connection:
            assert connection.scalar(text("SELECT version_num FROM alembic_version")) == "0229"
            assert (
                connection.scalar(
                    text("SELECT source_sha256 FROM media_file WHERE media_id = :epub"), ids
                )
                == hashlib.sha256(source).hexdigest()
            ), "0221 must hash the original stored source bytes"
            assert connection.scalars(
                text("SELECT outcome FROM podcast_transcript_request_audits")
            ).all() == ["queued"], "0223 intentionally discards only enqueue_failed audit history"
            for table in preserved_tables:
                actual = connection.execute(
                    text(
                        f"SELECT to_jsonb(record) FROM {table} record ORDER BY to_jsonb(record)::text"
                    )
                ).all()
                assert actual == preserved[table], (
                    f"full-chain migration changed retained {table}: {actual!r}"
                )
            assert (
                connection.execute(
                    text(
                        "SELECT to_jsonb(record) - 'original_published_date' - 'edition_published_date' "
                        "- 'edition_isbn' FROM media record ORDER BY id"
                    )
                ).all()
                == old_media
            ), "only the declared publication-date fields may change on retained media"
            assert connection.execute(
                text(
                    "SELECT original_published_date, edition_published_date, edition_isbn "
                    "FROM media WHERE id = :epub"
                ),
                ids,
            ).one() == (None, None, None), (
                "0229 must not invent original/edition dates from ambiguous history"
            )
            for table in (
                "conversations",
                "messages",
                "chat_runs",
                "message_tool_calls",
                "llm_calls",
            ):
                assert connection.scalar(text(f"SELECT count(*) FROM {table}")) == 0, (
                    f"0224 deliberately resets {table}; this proof does not promise to retain old chat"
                )
            assert (
                connection.scalar(
                    text("SELECT count(*) FROM background_jobs WHERE id = :generation_job"), ids
                )
                == 0
            )
            assert connection.execute(
                text("SELECT locator, revision FROM reader_media_state WHERE id = :cursor"), ids
            ).one() == (
                {
                    **locator,
                    "target": {
                        "fragment_id": str(ids["fragment"]),
                        "href_path": "book.xhtml",
                        "anchor_id": {"kind": "Absent"},
                    },
                },
                8,
            ), (
                "0228 must preserve the accepted reading locus while replacing its retired section address"
            )
            assert (
                connection.scalar(
                    text("SELECT generation FROM reader_publications WHERE media_id = :epub"), ids
                )
                == 2
            )
            sections = connection.scalars(
                text("SELECT location_id FROM epub_nav_locations WHERE media_id = :epub"), ids
            ).all()
            assert "kept:first" in sections and "spine:0" not in sections
            assert connection.execute(
                text(
                    "SELECT event_type, payload FROM media_processing_events WHERE media_id = :epub"
                ),
                ids,
            ).all() == [
                (
                    "HistoryBaseline",
                    {
                        "source_attempt_id": str(ids["source_attempt"]),
                        "attempt_no": 1,
                        "outcome": {"kind": "Succeeded"},
                    },
                )
            ]
            assert connection.execute(
                text(
                    "SELECT media_id, status FROM media_source_attempts WHERE id = :source_attempt"
                ),
                ids,
            ).one() == (ids["epub"], "succeeded")
            assert dict(
                connection.execute(
                    text(
                        "SELECT family, revision FROM viewer_collection_revisions "
                        "WHERE viewer_id = :user"
                    ),
                    ids,
                ).all()
            ) == {
                "AuthorWorks": 1,
                "LibraryEntries": 1,
                "PodcastEpisodes": 1,
                "PodcastSubscriptions": 1,
            }
        inspector = inspect(engine)
        assert "rate_limit_inflight" not in inspector.get_table_names()
        assert "published_date" not in {column["name"] for column in inspector.get_columns("media")}
        assert {"idempotency_key", "payload_hash"}.isdisjoint(
            column["name"] for column in inspector.get_columns("chat_runs")
        )
        assert b"".join(storage.stream_object(source_path)) == source
    finally:
        try:
            storage.delete_object(source_path)
        finally:
            engine.dispose()
