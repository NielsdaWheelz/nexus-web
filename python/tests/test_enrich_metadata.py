"""Integration tests for metadata enrichment task behavior."""

import importlib
import json
from datetime import UTC, datetime
from types import SimpleNamespace
from uuid import uuid4

import pytest
from sqlalchemy import text

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
                        author,
                        feed_url
                    )
                    VALUES (
                        :id,
                        'podcast_index',
                        :provider_podcast_id,
                        :title,
                        :author,
                        :feed_url
                    )
                    """
                ),
                {
                    "id": podcast_id,
                    "provider_podcast_id": f"enrich-podcast-{uuid4()}",
                    "title": "Systems Show",
                    "author": "Podcast Author",
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
            "select_enrichment_provider",
            lambda _settings: ("openai", "gpt-test", "sk-test"),
        )

        prompt_holder: dict[str, str] = {}

        async def _fake_generate(self, provider, req, api_key, timeout_s):
            _ = self, provider, api_key, timeout_s
            prompt_holder["prompt"] = req.messages[0].content
            return SimpleNamespace(
                status="completed",
                text=json.dumps(
                    {
                        "authors": ["Episode Host"],
                        "publisher": "Systems Show",
                        "language": "en",
                        "description": "A short summary of the episode.",
                        "published_date": "2026-03-02",
                    }
                ),
            )

        monkeypatch.setattr(enrich_module.LLMRouter, "generate", _fake_generate)

        result = enrich_module.enrich_metadata(str(media_id))

        assert result["status"] == "success"
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
                    SELECT name
                    FROM media_authors
                    WHERE media_id = :media_id
                    ORDER BY sort_order ASC
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

    def test_existing_metadata_enriched_timestamp_does_not_block_rerun_when_gaps_remain(
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
                        'notes.html',
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
            "select_enrichment_provider",
            lambda _settings: ("openai", "gpt-test", "sk-test"),
        )

        async def _fake_generate(self, provider, req, api_key, timeout_s):
            _ = self, provider, req, api_key, timeout_s
            return SimpleNamespace(
                status="completed",
                text=json.dumps(
                    {
                        "title": "Analytical Engine Notes",
                        "authors": ["Ada Lovelace"],
                        "publisher": "Nexus Archive",
                    }
                ),
            )

        monkeypatch.setattr(enrich_module.LLMRouter, "generate", _fake_generate)

        result = enrich_module.enrich_metadata(str(media_id))

        assert result["status"] == "success"

        with direct_db.session() as session:
            media_row = session.execute(
                text(
                    """
                    SELECT title, publisher
                    FROM media
                    WHERE id = :media_id
                    """
                ),
                {"media_id": media_id},
            ).fetchone()
            author_rows = session.execute(
                text(
                    """
                    SELECT name
                    FROM media_authors
                    WHERE media_id = :media_id
                    ORDER BY sort_order ASC
                    """
                ),
                {"media_id": media_id},
            ).fetchall()

        assert media_row == ("Analytical Engine Notes", "Nexus Archive")
        assert [row[0] for row in author_rows] == ["Ada Lovelace"]
