"""Integration tests for metadata enrichment task behavior."""

import importlib
from datetime import UTC, datetime
from types import SimpleNamespace
from uuid import uuid4

import pytest
from llm_calling.errors import LLMError, LLMErrorCode
from sqlalchemy import text

from nexus.services.contributor_credits import replace_media_contributor_credits
from tests.helpers import create_test_user_id
from tests.utils.db import DirectSessionManager

pytestmark = pytest.mark.integration


def _enrich_metadata_module():
    return importlib.import_module("nexus.tasks.enrich_metadata")


class TestEnrichMetadata:
    def test_pending_podcast_episode_uses_show_notes_and_structured_metadata(
        self, direct_db: DirectSessionManager, monkeypatch
    ):
        user_id = create_test_user_id()
        podcast_id = uuid4()
        media_id = uuid4()

        direct_db.register_cleanup("media", "id", media_id)
        direct_db.register_cleanup("podcasts", "id", podcast_id)
        direct_db.register_cleanup("users", "id", user_id)

        with direct_db.session() as session:
            session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
            session.execute(
                text(
                    """
                    INSERT INTO podcasts (
                        id,
                        provider,
                        provider_podcast_id,
                        title,
                        feed_url
                    )
                    VALUES (
                        :id,
                        'podcast_index',
                        :provider_podcast_id,
                        :title,
                        :feed_url
                    )
                    """
                ),
                {
                    "id": podcast_id,
                    "provider_podcast_id": f"enrich-podcast-{uuid4()}",
                    "title": "Systems Show",
                    "feed_url": f"https://feeds.example.com/{podcast_id}.xml",
                },
            )
            session.execute(
                text(
                    """
                    INSERT INTO media (
                        id,
                        kind,
                        title,
                        canonical_source_url,
                        processing_status,
                        created_by_user_id
                    )
                    VALUES (
                        :id,
                        'podcast_episode',
                        'Episode 7',
                        :canonical_source_url,
                        'pending',
                        :created_by_user_id
                    )
                    """
                ),
                {
                    "id": media_id,
                    "canonical_source_url": f"https://feeds.example.com/{podcast_id}.xml",
                    "created_by_user_id": user_id,
                },
            )
            session.execute(
                text(
                    """
                    INSERT INTO podcast_episodes (
                        media_id,
                        podcast_id,
                        provider_episode_id,
                        fallback_identity,
                        description_text
                    )
                    VALUES (
                        :media_id,
                        :podcast_id,
                        :provider_episode_id,
                        :fallback_identity,
                        :description_text
                    )
                    """
                ),
                {
                    "media_id": media_id,
                    "podcast_id": podcast_id,
                    "provider_episode_id": "ep-enrich-1",
                    "fallback_identity": f"fallback-{uuid4()}",
                    "description_text": "Show notes about resilient systems and feedback loops.",
                },
            )
            session.commit()

        enrich_module = _enrich_metadata_module()
        monkeypatch.setattr(
            enrich_module,
            "select_enrichment_providers",
            lambda _settings: [("openai", "gpt-test", "sk-test")],
        )

        prompt_holder: dict[str, str] = {}
        structured_output_seen: dict[str, bool] = {}

        async def _fake_generate(self, provider, req, api_key, timeout_s):
            _ = self, provider, api_key, timeout_s
            prompt_holder["prompt"] = req.messages[0].content
            structured_output_seen["present"] = getattr(req, "structured_output", None) is not None
            return SimpleNamespace(
                status="completed",
                structured_output={
                    "title": None,
                    "authors": ["Episode Host"],
                    "publisher": "Systems Show",
                    "language": "en",
                    "description": "A short summary of the episode.",
                    "published_date": "2026-03-02",
                },
            )

        monkeypatch.setattr(enrich_module.LLMRouter, "generate", _fake_generate)

        result = enrich_module.enrich_metadata(str(media_id))

        assert result["status"] == "success"
        assert structured_output_seen == {"present": True}
        assert "Systems Show" in prompt_holder["prompt"]
        assert "feedback loops" in prompt_holder["prompt"]

        with direct_db.session() as session:
            media_row = session.execute(
                text(
                    """
                    SELECT publisher, language, description, published_date
                    FROM media
                    WHERE id = :media_id
                    """
                ),
                {"media_id": media_id},
            ).fetchone()
            author_rows = session.execute(
                text(
                    """
                    SELECT credited_name
                    FROM contributor_credits
                    WHERE media_id = :media_id
                    ORDER BY ordinal ASC
                    """
                ),
                {"media_id": media_id},
            ).fetchall()

        assert media_row == (
            "Systems Show",
            "en",
            "A short summary of the episode.",
            "2026-03-02",
        )
        assert [row[0] for row in author_rows] == ["Episode Host"]

    def test_automatic_enrichment_overwrites_populated_metadata_by_default(
        self, direct_db: DirectSessionManager, monkeypatch
    ):
        user_id = create_test_user_id()
        media_id = uuid4()
        fragment_id = uuid4()

        direct_db.register_cleanup("media", "id", media_id)
        direct_db.register_cleanup("users", "id", user_id)

        with direct_db.session() as session:
            session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
            session.execute(
                text(
                    """
                    INSERT INTO media (
                        id,
                        kind,
                        title,
                        canonical_source_url,
                        processing_status,
                        created_by_user_id,
                        metadata_enriched_at
                    )
                    VALUES (
                        :id,
                        'web_article',
                        'John-Keats.com - Poems',
                        'https://example.com/notes',
                        'ready_for_reading',
                        :created_by_user_id,
                        :metadata_enriched_at
                    )
                    """
                ),
                {
                    "id": media_id,
                    "created_by_user_id": user_id,
                    "metadata_enriched_at": datetime.now(UTC),
                },
            )
            session.execute(
                text(
                    """
                    INSERT INTO fragments (
                        id,
                        media_id,
                        idx,
                        html_sanitized,
                        canonical_text
                    )
                    VALUES (
                        :id,
                        :media_id,
                        0,
                        '<p>Ada Lovelace wrote these analytical engine notes.</p>',
                        'Ada Lovelace wrote these analytical engine notes.'
                    )
                    """
                ),
                {"id": fragment_id, "media_id": media_id},
            )
            session.commit()

        enrich_module = _enrich_metadata_module()
        monkeypatch.setattr(
            enrich_module,
            "select_enrichment_providers",
            lambda _settings: [("openai", "gpt-test", "sk-test")],
        )

        async def _fake_generate(self, provider, req, api_key, timeout_s):
            _ = self, provider, req, api_key, timeout_s
            return SimpleNamespace(
                status="completed",
                structured_output={
                    "title": "Analytical Engine Notes",
                    "authors": ["Ada Lovelace"],
                    "publisher": "Nexus Archive",
                    "description": "Ada Lovelace's notes on the analytical engine.",
                    "published_date": "1843",
                    "language": "en",
                },
            )

        monkeypatch.setattr(enrich_module.LLMRouter, "generate", _fake_generate)

        result = enrich_module.enrich_metadata(str(media_id))

        assert result["status"] == "success"

        with direct_db.session() as session:
            media_row = session.execute(
                text(
                    """
                    SELECT title, publisher, description, published_date, language
                    FROM media
                    WHERE id = :media_id
                    """
                ),
                {"media_id": media_id},
            ).fetchone()
            author_rows = session.execute(
                text(
                    """
                    SELECT credited_name
                    FROM contributor_credits
                    WHERE media_id = :media_id
                    ORDER BY ordinal ASC
                    """
                ),
                {"media_id": media_id},
            ).fetchall()

        assert media_row == (
            "Analytical Engine Notes",
            "Nexus Archive",
            "Ada Lovelace's notes on the analytical engine.",
            "1843",
            "en",
        )
        assert [row[0] for row in author_rows] == ["Ada Lovelace"]

    def test_automatic_enrichment_never_skips_no_gaps(
        self, direct_db: DirectSessionManager, monkeypatch
    ):
        user_id = create_test_user_id()
        media_id = uuid4()

        direct_db.register_cleanup("media", "id", media_id)
        direct_db.register_cleanup("users", "id", user_id)

        with direct_db.session() as session:
            session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
            session.execute(
                text(
                    """
                    INSERT INTO media (
                        id, kind, title, canonical_source_url, processing_status,
                        created_by_user_id, publisher, description, language,
                        published_date
                    ) VALUES (
                        :id, 'web_article', 'Real Article Title',
                        'https://example.com/a', 'ready_for_reading',
                        :user_id, 'Example Co', 'A summary.', 'en', '2026-01-01'
                    )
                    """
                ),
                {"id": media_id, "user_id": user_id},
            )
            session.commit()

        enrich_module = _enrich_metadata_module()
        monkeypatch.setattr(
            enrich_module,
            "select_enrichment_providers",
            lambda _s: [("openai", "gpt-test", "sk-test")],
        )

        async def _fake_generate(self, provider, req, api_key, timeout_s):
            _ = self, provider, req, api_key, timeout_s
            return SimpleNamespace(
                status="completed",
                structured_output={
                    "title": "Better Article Title",
                    "authors": None,
                    "publisher": None,
                    "description": None,
                    "published_date": None,
                    "language": "en",
                },
            )

        monkeypatch.setattr(enrich_module.LLMRouter, "generate", _fake_generate)

        result = enrich_module.enrich_metadata(str(media_id))
        assert result["status"] == "success", (
            f"Expected automatic enrichment to run even when all fields are populated, got {result}"
        )
        assert "no_gaps" not in str(result)

    def test_overwrites_populated_fields_by_default(
        self, direct_db: DirectSessionManager, monkeypatch
    ):
        user_id = create_test_user_id()
        media_id = uuid4()

        direct_db.register_cleanup("media", "id", media_id)
        direct_db.register_cleanup("users", "id", user_id)

        with direct_db.session() as session:
            session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
            session.execute(
                text(
                    """
                    INSERT INTO media (
                        id, kind, title, canonical_source_url, processing_status,
                        created_by_user_id, publisher, description
                    ) VALUES (
                        :id, 'web_article', 'Old Title', 'https://example.com/a',
                        'ready_for_reading', :user_id, 'Old Publisher', 'Old description.'
                    )
                    """
                ),
                {"id": media_id, "user_id": user_id},
            )
            session.commit()

        enrich_module = _enrich_metadata_module()
        monkeypatch.setattr(
            enrich_module,
            "select_enrichment_providers",
            lambda _s: [("openai", "gpt-test", "sk-test")],
        )

        async def _fake_generate(self, provider, req, api_key, timeout_s):
            _ = self, provider, req, api_key, timeout_s
            return SimpleNamespace(
                status="completed",
                structured_output={
                    "title": "New Title",
                    "authors": None,
                    "publisher": "New Publisher",
                    "description": "New description.",
                    "published_date": None,
                    "language": None,
                },
            )

        monkeypatch.setattr(enrich_module.LLMRouter, "generate", _fake_generate)

        result = enrich_module.enrich_metadata(str(media_id))
        assert result["status"] == "success", f"Expected success, got {result}"

        with direct_db.session() as session:
            row = session.execute(
                text("SELECT title, publisher, description FROM media WHERE id = :id"),
                {"id": media_id},
            ).fetchone()

        assert row == ("New Title", "New Publisher", "New description."), (
            f"Expected default enrichment to overwrite populated fields, got {row}"
        )

    def test_repeated_structured_enrichment_replaces_machine_authors_without_duplicates(
        self, direct_db: DirectSessionManager, monkeypatch
    ):
        user_id = create_test_user_id()
        media_id = uuid4()

        direct_db.register_cleanup("media", "id", media_id)
        direct_db.register_cleanup("users", "id", user_id)

        with direct_db.session() as session:
            session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
            session.execute(
                text(
                    """
                    INSERT INTO media (
                        id, kind, title, canonical_source_url, processing_status,
                        created_by_user_id
                    ) VALUES (
                        :id, 'web_article', 'notes.pdf', 'https://example.com/a',
                        'ready_for_reading', :user_id
                    )
                    """
                ),
                {"id": media_id, "user_id": user_id},
            )
            replace_media_contributor_credits(
                session,
                media_id=media_id,
                source="web_article_byline",
                credits=[
                    {
                        "name": "Ada Lovelace",
                        "role": "author",
                        "ordinal": 0,
                        "source": "web_article_byline",
                    }
                ],
            )
            replace_media_contributor_credits(
                session,
                media_id=media_id,
                source="epub_opf",
                credits=[
                    {
                        "name": "Ada Lovelace",
                        "role": "author",
                        "ordinal": 0,
                        "source": "epub_opf",
                    }
                ],
            )
            replace_media_contributor_credits(
                session,
                media_id=media_id,
                source="manual",
                credits=[
                    {
                        "name": "Curated Author",
                        "role": "author",
                        "ordinal": 0,
                        "source": "manual",
                    }
                ],
            )
            session.commit()

        enrich_module = _enrich_metadata_module()
        monkeypatch.setattr(
            enrich_module,
            "select_enrichment_providers",
            lambda _s: [("openai", "gpt-test", "sk-test")],
        )

        async def _fake_generate(self, provider, req, api_key, timeout_s):
            _ = self, provider, req, api_key, timeout_s
            return SimpleNamespace(
                status="completed",
                structured_output={
                    "title": "Analytical Engine Notes",
                    "authors": ["Ada Lovelace", "Ada  Lovelace", "Charles Babbage"],
                    "publisher": None,
                    "description": None,
                    "published_date": None,
                    "language": None,
                },
            )

        monkeypatch.setattr(enrich_module.LLMRouter, "generate", _fake_generate)

        first = enrich_module.enrich_metadata(str(media_id))
        second = enrich_module.enrich_metadata(str(media_id))

        assert first["status"] == "success", first
        assert second["status"] == "success", second

        with direct_db.session() as session:
            rows = session.execute(
                text(
                    """
                    SELECT credited_name, source
                    FROM contributor_credits
                    WHERE media_id = :media_id
                      AND role = 'author'
                    ORDER BY source ASC, ordinal ASC, credited_name ASC
                    """
                ),
                {"media_id": media_id},
            ).fetchall()

        assert [(row[0], row[1]) for row in rows] == [
            ("Curated Author", "manual"),
            ("Ada Lovelace", "metadata_enrichment"),
            ("Charles Babbage", "metadata_enrichment"),
        ]

    def test_llm_failure_records_metadata_failure(
        self, direct_db: DirectSessionManager, monkeypatch
    ):
        user_id = create_test_user_id()
        media_id = uuid4()

        direct_db.register_cleanup("media", "id", media_id)
        direct_db.register_cleanup("users", "id", user_id)

        with direct_db.session() as session:
            session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
            session.execute(
                text(
                    """
                    INSERT INTO media (
                        id, kind, title, canonical_source_url, processing_status,
                        created_by_user_id
                    ) VALUES (
                        :id, 'web_article', 'notes.pdf', 'https://example.com/a',
                        'ready', :user_id
                    )
                    """
                ),
                {"id": media_id, "user_id": user_id},
            )
            session.commit()

        enrich_module = _enrich_metadata_module()
        monkeypatch.setattr(
            enrich_module,
            "select_enrichment_providers",
            lambda _s: [("openai", "gpt-test", "sk-test")],
        )

        async def _fake_generate(self, provider, req, api_key, timeout_s):
            _ = self, provider, req, api_key, timeout_s
            raise LLMError(
                LLMErrorCode.PROVIDER_DOWN,
                "x" * 1500,
                provider="openai",
            )

        monkeypatch.setattr(enrich_module.LLMRouter, "generate", _fake_generate)

        result = enrich_module.enrich_metadata(str(media_id))

        assert result["status"] == "failed"
        assert result["reason"] == "llm_failed"
        assert result["error_code"] == "E_LLM_PROVIDER_DOWN", (
            f"Expected llm_failed result, got {result}"
        )

        with direct_db.session() as session:
            row = session.execute(
                text(
                    """
                    SELECT failure_stage, last_error_code, last_error_message,
                           processing_status
                    FROM media WHERE id = :id
                    """
                ),
                {"id": media_id},
            ).fetchone()

        assert row is not None
        failure_stage, last_error_code, last_error_message, processing_status = row
        assert failure_stage == "metadata", (
            f"Expected failure_stage='metadata', got {failure_stage!r}"
        )
        assert last_error_code == "E_LLM_PROVIDER_DOWN", (
            f"Expected LLMError's error_code, got {last_error_code!r}"
        )
        assert last_error_message is not None
        assert len(last_error_message) <= 1000, (
            f"Expected message capped at 1000 chars, got len={len(last_error_message)}"
        )
        assert processing_status == "ready", (
            f"Expected processing_status unchanged='ready', got {processing_status!r}"
        )

    def test_parse_failure_records_metadata_failure(
        self, direct_db: DirectSessionManager, monkeypatch
    ):
        user_id = create_test_user_id()
        media_id = uuid4()

        direct_db.register_cleanup("media", "id", media_id)
        direct_db.register_cleanup("users", "id", user_id)

        with direct_db.session() as session:
            session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
            session.execute(
                text(
                    """
                    INSERT INTO media (
                        id, kind, title, canonical_source_url, processing_status,
                        created_by_user_id
                    ) VALUES (
                        :id, 'web_article', 'notes.pdf', 'https://example.com/a',
                        'ready', :user_id
                    )
                    """
                ),
                {"id": media_id, "user_id": user_id},
            )
            session.commit()

        enrich_module = _enrich_metadata_module()
        monkeypatch.setattr(
            enrich_module,
            "select_enrichment_providers",
            lambda _s: [("openai", "gpt-test", "sk-test")],
        )

        async def _fake_generate(self, provider, req, api_key, timeout_s):
            _ = self, provider, req, api_key, timeout_s
            return SimpleNamespace(
                status="completed",
                text='{"title":"Unstructured text payload must be ignored"}',
                structured_output=None,
            )

        monkeypatch.setattr(enrich_module.LLMRouter, "generate", _fake_generate)

        result = enrich_module.enrich_metadata(str(media_id))

        assert result["status"] == "failed"
        assert result["reason"] == "parse_failed"
        assert result["error_code"] == "E_METADATA_PARSE_FAILED", (
            f"Expected missing structured_output to fail closed, got {result}"
        )

        with direct_db.session() as session:
            row = session.execute(
                text(
                    """
                    SELECT failure_stage, last_error_code, processing_status
                    FROM media WHERE id = :id
                    """
                ),
                {"id": media_id},
            ).fetchone()

        assert row == ("metadata", "E_METADATA_PARSE_FAILED", "ready"), (
            f"Expected metadata failure recorded with parse-failed code, got {row}"
        )

    def test_structured_validation_failure_falls_back_to_next_provider(
        self, direct_db: DirectSessionManager, monkeypatch
    ):
        user_id = create_test_user_id()
        media_id = uuid4()

        direct_db.register_cleanup("media", "id", media_id)
        direct_db.register_cleanup("users", "id", user_id)

        with direct_db.session() as session:
            session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
            session.execute(
                text(
                    """
                    INSERT INTO media (
                        id, kind, title, canonical_source_url, processing_status,
                        created_by_user_id, failure_stage, last_error_code,
                        last_error_message
                    ) VALUES (
                        :id, 'web_article', 'notes.pdf', 'https://example.com/a',
                        'ready', :user_id, 'metadata', 'E_METADATA_PARSE_FAILED',
                        'previous failure'
                    )
                    """
                ),
                {"id": media_id, "user_id": user_id},
            )
            session.commit()

        enrich_module = _enrich_metadata_module()
        monkeypatch.setattr(
            enrich_module,
            "select_enrichment_providers",
            lambda _s: [
                ("gemini", "gemini-test", "gemini-key"),
                ("openai", "gpt-test", "openai-key"),
            ],
        )

        observed_providers: list[str] = []

        async def _fake_generate(self, provider, req, api_key, timeout_s):
            _ = self, req, api_key, timeout_s
            observed_providers.append(provider)
            if provider == "gemini":
                return SimpleNamespace(
                    status="completed",
                    structured_output={
                        "title": "Bad Date",
                        "authors": None,
                        "publisher": None,
                        "description": None,
                        "published_date": "March 1843",
                        "language": "en",
                    },
                )
            return SimpleNamespace(
                status="completed",
                structured_output={
                    "title": "Recovered Title",
                    "authors": None,
                    "publisher": "Recovered Publisher",
                    "description": None,
                    "published_date": None,
                    "language": "en",
                },
            )

        monkeypatch.setattr(enrich_module.LLMRouter, "generate", _fake_generate)

        result = enrich_module.enrich_metadata(str(media_id))

        assert result["status"] == "success"
        assert result["provider"] == "openai"
        assert observed_providers == ["gemini", "openai"]
        assert result["attempted_providers"] == [
            {"provider": "gemini", "model": "gemini-test"},
            {"provider": "openai", "model": "gpt-test"},
        ]

        with direct_db.session() as session:
            row = session.execute(
                text(
                    """
                    SELECT title, publisher, language, failure_stage, last_error_code
                    FROM media WHERE id = :id
                    """
                ),
                {"id": media_id},
            ).fetchone()

        assert row == ("Recovered Title", "Recovered Publisher", "en", None, None)

    def test_successful_run_clears_prior_metadata_failure(
        self, direct_db: DirectSessionManager, monkeypatch
    ):
        user_id = create_test_user_id()
        media_id = uuid4()

        direct_db.register_cleanup("media", "id", media_id)
        direct_db.register_cleanup("users", "id", user_id)

        with direct_db.session() as session:
            session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
            session.execute(
                text(
                    """
                    INSERT INTO media (
                        id, kind, title, canonical_source_url, processing_status,
                        created_by_user_id, failure_stage, last_error_code,
                        last_error_message
                    ) VALUES (
                        :id, 'web_article', 'Real Title', 'https://example.com/a',
                        'ready', :user_id, 'metadata', 'E_FOO', 'prior'
                    )
                    """
                ),
                {"id": media_id, "user_id": user_id},
            )
            session.commit()

        enrich_module = _enrich_metadata_module()
        monkeypatch.setattr(
            enrich_module,
            "select_enrichment_providers",
            lambda _s: [("openai", "gpt-test", "sk-test")],
        )

        async def _fake_generate(self, provider, req, api_key, timeout_s):
            _ = self, provider, req, api_key, timeout_s
            return SimpleNamespace(
                status="completed",
                structured_output={
                    "title": None,
                    "authors": None,
                    "publisher": "Recovered Publisher",
                    "description": None,
                    "published_date": None,
                    "language": None,
                },
            )

        monkeypatch.setattr(enrich_module.LLMRouter, "generate", _fake_generate)

        result = enrich_module.enrich_metadata(str(media_id))
        assert result["status"] == "success", f"Expected success, got {result}"

        with direct_db.session() as session:
            row = session.execute(
                text(
                    """
                    SELECT failure_stage, last_error_code, last_error_message,
                           processing_status
                    FROM media WHERE id = :id
                    """
                ),
                {"id": media_id},
            ).fetchone()

        assert row == (None, None, None, "ready"), (
            f"Expected prior metadata failure cleared (status unchanged), got {row}"
        )

    def test_no_provider_records_failure_while_operational_skips_do_not(
        self, direct_db: DirectSessionManager, monkeypatch
    ):
        user_id = create_test_user_id()
        media_no_provider = uuid4()
        media_extracting = uuid4()
        media_missing = uuid4()

        direct_db.register_cleanup("media", "id", media_no_provider)
        direct_db.register_cleanup("media", "id", media_extracting)
        direct_db.register_cleanup("users", "id", user_id)

        with direct_db.session() as session:
            session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
            # has gaps but no provider configured
            session.execute(
                text(
                    """
                    INSERT INTO media (
                        id, kind, title, canonical_source_url, processing_status,
                        created_by_user_id
                    ) VALUES (
                        :id, 'web_article', 'notes.pdf', 'https://example.com/a',
                        'ready', :user_id
                    )
                    """
                ),
                {"id": media_no_provider, "user_id": user_id},
            )
            # not_ready: still extracting
            session.execute(
                text(
                    """
                    INSERT INTO media (
                        id, kind, title, canonical_source_url, processing_status,
                        created_by_user_id
                    ) VALUES (
                        :id, 'web_article', 'notes.pdf', 'https://example.com/a',
                        'extracting', :user_id
                    )
                    """
                ),
                {"id": media_extracting, "user_id": user_id},
            )
            session.commit()

        enrich_module = _enrich_metadata_module()
        monkeypatch.setattr(enrich_module, "select_enrichment_providers", lambda _s: [])

        no_provider_result = enrich_module.enrich_metadata(str(media_no_provider))
        assert no_provider_result["status"] == "failed"
        assert no_provider_result["reason"] == "no_provider"
        assert no_provider_result["error_code"] == "E_METADATA_NO_PROVIDER"

        not_ready_result = enrich_module.enrich_metadata(str(media_extracting))
        assert not_ready_result == {"status": "skipped", "reason": "not_ready"}

        not_found_result = enrich_module.enrich_metadata(str(media_missing))
        assert not_found_result == {"status": "skipped", "reason": "media_not_found"}

        with direct_db.session() as session:
            rows = {
                row.id: row
                for row in session.execute(
                    text(
                        """
                        SELECT id, failure_stage, last_error_code, last_error_message
                        FROM media WHERE id = ANY(:ids)
                        """
                    ),
                    {"ids": [media_no_provider, media_extracting]},
                ).fetchall()
            }

        no_provider_row = rows[media_no_provider]
        assert no_provider_row.failure_stage == "metadata"
        assert no_provider_row.last_error_code == "E_METADATA_NO_PROVIDER"
        assert no_provider_row.last_error_message

        extracting_row = rows[media_extracting]
        assert (
            extracting_row.failure_stage is None
            and extracting_row.last_error_code is None
            and extracting_row.last_error_message is None
        ), f"Operational skips should not write failure_stage; got {tuple(extracting_row)}"

    def test_failed_processing_status_is_not_marked_metadata_failed(
        self, direct_db: DirectSessionManager, monkeypatch
    ):
        user_id = create_test_user_id()
        media_id = uuid4()

        direct_db.register_cleanup("media", "id", media_id)
        direct_db.register_cleanup("users", "id", user_id)

        with direct_db.session() as session:
            session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
            session.execute(
                text(
                    """
                    INSERT INTO media (
                        id, kind, title, canonical_source_url, processing_status,
                        failure_stage, last_error_code, created_by_user_id
                    ) VALUES (
                        :id, 'web_article', 'notes.pdf', 'https://example.com/a',
                        'failed', 'embed', 'E_INGEST_FAILED', :user_id
                    )
                    """
                ),
                {"id": media_id, "user_id": user_id},
            )
            session.commit()

        enrich_module = _enrich_metadata_module()
        monkeypatch.setattr(enrich_module, "select_enrichment_providers", lambda _s: [])

        result = enrich_module.enrich_metadata(str(media_id))
        assert result == {"status": "skipped", "reason": "not_ready"}

        with direct_db.session() as session:
            row = session.execute(
                text(
                    "SELECT processing_status, failure_stage, last_error_code FROM media WHERE id = :id"
                ),
                {"id": media_id},
            ).fetchone()

        assert row == ("failed", "embed", "E_INGEST_FAILED")
