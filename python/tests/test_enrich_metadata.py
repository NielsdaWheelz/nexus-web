"""Integration tests for metadata enrichment task behavior."""

import base64
import importlib
from datetime import UTC, datetime
from uuid import UUID, uuid4

import pytest
from provider_runtime.errors import ModelCallError, ModelCallErrorCode
from provider_runtime.types import ModelResponse, ProviderApiKey, TokenUsage
from sqlalchemy import text

from nexus.services.api_key_resolver import ResolvedKey
from nexus.services.contributor_credits import load_contributor_credits_for_media
from nexus.services.crypto import MASTER_KEY_SIZE, _get_master_key, encrypt_api_key
from tests.helpers import create_test_user_id
from tests.utils.db import DirectSessionManager

pytestmark = pytest.mark.integration


def _enrich_metadata_module():
    return importlib.import_module("nexus.tasks.enrich_metadata")


def _stub_resolved_keys(monkeypatch, enrich_module, api_key: str = "sk-test") -> None:
    """Stub the key-resolution seam; the real path is covered by the BYOK test."""
    monkeypatch.setattr(
        enrich_module,
        "resolve_api_key",
        lambda _db, _user_id, provider, _key_mode: ResolvedKey(
            api_key=api_key, mode="platform", provider=provider
        ),
    )


def _completed_response(
    structured_output: dict | None, text: str = "", usage: TokenUsage | None = None
) -> ModelResponse:
    return ModelResponse(
        text=text,
        usage=usage,
        provider_request_id=None,
        status="completed",
        structured_output=structured_output,
    )


class _RecordingRateLimiter:
    """Records the metadata worker budget-envelope calls."""

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
def metadata_rate_limiter(monkeypatch) -> _RecordingRateLimiter:
    limiter = _RecordingRateLimiter()
    monkeypatch.setattr("nexus.tasks.enrich_metadata.get_rate_limiter", lambda: limiter)
    return limiter


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
        direct_db.register_cleanup("llm_calls", "owner_id", media_id)
        monkeypatch.setattr(
            enrich_module,
            "select_enrichment_model",
            lambda _settings: ("openai", "gpt-5.4-mini"),
        )
        _stub_resolved_keys(monkeypatch, enrich_module)

        prompt_holder: dict[str, str] = {}
        structured_output_seen: dict[str, bool] = {}

        async def _fake_generate(self, req, *, key, timeout_s):
            _ = self, key, timeout_s
            prompt_holder["prompt"] = req.messages[0].content
            structured_output_seen["present"] = getattr(req, "structured_output", None) is not None
            return _completed_response(
                {
                    "title": None,
                    "authors": ["Episode Host"],
                    "publisher": "Systems Show",
                    "language": "en",
                    "description": "A short summary of the episode.",
                    "published_date": "2026-03-02",
                }
            )

        monkeypatch.setattr(enrich_module.ModelRuntime, "generate", _fake_generate)

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
        direct_db.register_cleanup("llm_calls", "owner_id", media_id)
        monkeypatch.setattr(
            enrich_module,
            "select_enrichment_model",
            lambda _settings: ("openai", "gpt-5.4-mini"),
        )
        _stub_resolved_keys(monkeypatch, enrich_module)

        async def _fake_generate(self, req, *, key, timeout_s):
            _ = self, req, key, timeout_s
            return _completed_response(
                {
                    "title": "Analytical Engine Notes",
                    "authors": ["Ada Lovelace"],
                    "publisher": "Nexus Archive",
                    "description": "Ada Lovelace's notes on the analytical engine.",
                    "published_date": "1843",
                    "language": "en",
                }
            )

        monkeypatch.setattr(enrich_module.ModelRuntime, "generate", _fake_generate)

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
        direct_db.register_cleanup("llm_calls", "owner_id", media_id)
        monkeypatch.setattr(
            enrich_module,
            "select_enrichment_model",
            lambda _s: ("openai", "gpt-5.4-mini"),
        )
        _stub_resolved_keys(monkeypatch, enrich_module)

        async def _fake_generate(self, req, *, key, timeout_s):
            _ = self, req, key, timeout_s
            return _completed_response(
                {
                    "title": "Better Article Title",
                    "authors": None,
                    "publisher": None,
                    "description": None,
                    "published_date": None,
                    "language": "en",
                }
            )

        monkeypatch.setattr(enrich_module.ModelRuntime, "generate", _fake_generate)

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
        direct_db.register_cleanup("llm_calls", "owner_id", media_id)
        monkeypatch.setattr(
            enrich_module,
            "select_enrichment_model",
            lambda _s: ("openai", "gpt-5.4-mini"),
        )
        _stub_resolved_keys(monkeypatch, enrich_module)

        async def _fake_generate(self, req, *, key, timeout_s):
            _ = self, req, key, timeout_s
            return _completed_response(
                {
                    "title": "New Title",
                    "authors": None,
                    "publisher": "New Publisher",
                    "description": "New description.",
                    "published_date": None,
                    "language": None,
                }
            )

        monkeypatch.setattr(enrich_module.ModelRuntime, "generate", _fake_generate)

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
        # Manual-pin-blocks-automatic-authors and per-source coexistence are
        # covered by the author facade's own suite (test_author_deduplication_
        # cutover.py); this test's remaining scope is enrich_metadata's own
        # observation build: repeated structured runs stay deduped and
        # idempotent (no duplicate rows across two identical LLM responses).
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
            session.commit()

        enrich_module = _enrich_metadata_module()
        direct_db.register_cleanup("llm_calls", "owner_id", media_id)
        monkeypatch.setattr(
            enrich_module,
            "select_enrichment_model",
            lambda _s: ("openai", "gpt-5.4-mini"),
        )
        _stub_resolved_keys(monkeypatch, enrich_module)

        async def _fake_generate(self, req, *, key, timeout_s):
            _ = self, req, key, timeout_s
            return _completed_response(
                {
                    "title": "Analytical Engine Notes",
                    "authors": ["Ada Lovelace", "Ada  Lovelace", "Charles Babbage"],
                    "publisher": None,
                    "description": None,
                    "published_date": None,
                    "language": None,
                }
            )

        monkeypatch.setattr(enrich_module.ModelRuntime, "generate", _fake_generate)

        first = enrich_module.enrich_metadata(str(media_id))
        second = enrich_module.enrich_metadata(str(media_id))

        assert first["status"] == "success", first
        assert second["status"] == "success", second

        with direct_db.session() as session:
            credits_by_media = load_contributor_credits_for_media(session, [media_id])

        author_names = [
            credit.credited_name for credit in credits_by_media[media_id] if credit.role == "author"
        ]
        assert author_names == ["Ada Lovelace", "Charles Babbage"], (
            "duplicate near-identical name is deduped and the replacement is "
            "idempotent across two identical enrichment runs"
        )

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
                        'ready_for_reading', :user_id
                    )
                    """
                ),
                {"id": media_id, "user_id": user_id},
            )
            session.commit()

        enrich_module = _enrich_metadata_module()
        direct_db.register_cleanup("llm_calls", "owner_id", media_id)
        monkeypatch.setattr(
            enrich_module,
            "select_enrichment_model",
            lambda _s: ("openai", "gpt-5.4-mini"),
        )
        _stub_resolved_keys(monkeypatch, enrich_module)

        async def _fake_generate(self, req, *, key, timeout_s):
            _ = self, req, key, timeout_s
            raise ModelCallError(
                ModelCallErrorCode.PROVIDER_DOWN,
                "x" * 1500,
                provider="openai",
            )

        monkeypatch.setattr(enrich_module.ModelRuntime, "generate", _fake_generate)

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
            f"Expected ModelCallError's error_code, got {last_error_code!r}"
        )
        assert last_error_message is not None
        assert len(last_error_message) <= 1000, (
            f"Expected message capped at 1000 chars, got len={len(last_error_message)}"
        )
        assert processing_status == "ready_for_reading", (
            f"Expected processing_status unchanged='ready_for_reading', got {processing_status!r}"
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
                        'ready_for_reading', :user_id
                    )
                    """
                ),
                {"id": media_id, "user_id": user_id},
            )
            session.commit()

        enrich_module = _enrich_metadata_module()
        direct_db.register_cleanup("llm_calls", "owner_id", media_id)
        monkeypatch.setattr(
            enrich_module,
            "select_enrichment_model",
            lambda _s: ("openai", "gpt-5.4-mini"),
        )
        _stub_resolved_keys(monkeypatch, enrich_module)

        async def _fake_generate(self, req, *, key, timeout_s):
            _ = self, req, key, timeout_s
            return _completed_response(
                None, text='{"title":"Unstructured text payload must be ignored"}'
            )

        monkeypatch.setattr(enrich_module.ModelRuntime, "generate", _fake_generate)

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

        assert row == ("metadata", "E_METADATA_PARSE_FAILED", "ready_for_reading"), (
            f"Expected metadata failure recorded with parse-failed code, got {row}"
        )

    def test_structured_validation_failure_is_terminal_for_configured_provider(
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
                        'ready_for_reading', :user_id, 'metadata', 'E_METADATA_PARSE_FAILED',
                        'previous failure'
                    )
                    """
                ),
                {"id": media_id, "user_id": user_id},
            )
            session.commit()

        enrich_module = _enrich_metadata_module()
        direct_db.register_cleanup("llm_calls", "owner_id", media_id)
        monkeypatch.setattr(
            enrich_module,
            "select_enrichment_model",
            lambda _s: ("gemini", "gemini-3-flash-preview"),
        )
        _stub_resolved_keys(monkeypatch, enrich_module)

        observed_providers: list[str] = []

        async def _fake_generate(self, req, *, key, timeout_s):
            _ = self, req, key, timeout_s
            observed_providers.append(req.model.provider)
            return _completed_response(
                {
                    "title": "Bad Date",
                    "authors": None,
                    "publisher": None,
                    "description": None,
                    "published_date": "March 1843",
                    "language": "en",
                }
            )

        monkeypatch.setattr(enrich_module.ModelRuntime, "generate", _fake_generate)

        result = enrich_module.enrich_metadata(str(media_id))

        assert result["status"] == "failed"
        assert result["reason"] == "parse_failed"
        assert result["provider"] == "gemini"
        assert observed_providers == ["gemini"]

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

        assert row == ("notes.pdf", None, None, "metadata", "E_METADATA_PARSE_FAILED")

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
                        'ready_for_reading', :user_id, 'metadata', 'E_FOO', 'prior'
                    )
                    """
                ),
                {"id": media_id, "user_id": user_id},
            )
            session.commit()

        enrich_module = _enrich_metadata_module()
        direct_db.register_cleanup("llm_calls", "owner_id", media_id)
        monkeypatch.setattr(
            enrich_module,
            "select_enrichment_model",
            lambda _s: ("openai", "gpt-5.4-mini"),
        )
        _stub_resolved_keys(monkeypatch, enrich_module)

        async def _fake_generate(self, req, *, key, timeout_s):
            _ = self, req, key, timeout_s
            return _completed_response(
                {
                    "title": None,
                    "authors": None,
                    "publisher": "Recovered Publisher",
                    "description": None,
                    "published_date": None,
                    "language": None,
                }
            )

        monkeypatch.setattr(enrich_module.ModelRuntime, "generate", _fake_generate)

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

        assert row == (None, None, None, "ready_for_reading"), (
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
                        'ready_for_reading', :user_id
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
        monkeypatch.setattr(enrich_module, "select_enrichment_model", lambda _s: None)

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
        monkeypatch.setattr(enrich_module, "select_enrichment_model", lambda _s: None)

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

    def test_provider_failure_ledgers_one_terminal_provider_attempt(
        self, direct_db: DirectSessionManager, monkeypatch
    ):
        """Provider failure is terminal; provider-runtime owns retry within the single call."""
        user_id = create_test_user_id()
        media_id = uuid4()

        direct_db.register_cleanup("media", "id", media_id)
        direct_db.register_cleanup("users", "id", user_id)
        direct_db.register_cleanup("llm_calls", "owner_id", media_id)

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
            session.commit()

        enrich_module = _enrich_metadata_module()
        monkeypatch.setattr(
            enrich_module,
            "select_enrichment_model",
            lambda _s: ("openai", "gpt-5.4-mini"),
        )
        _stub_resolved_keys(monkeypatch, enrich_module)

        async def _fake_generate(self, req, *, key, timeout_s):
            _ = self, req, key, timeout_s
            if req.model.provider == "openai":
                raise ModelCallError(
                    ModelCallErrorCode.PROVIDER_DOWN, "openai down", provider="openai"
                )
            return _completed_response(
                {
                    "title": "Recovered Title",
                    "authors": None,
                    "publisher": None,
                    "description": None,
                    "published_date": None,
                    "language": None,
                }
            )

        monkeypatch.setattr(enrich_module.ModelRuntime, "generate", _fake_generate)

        result = enrich_module.enrich_metadata(str(media_id))

        assert result["status"] == "failed"
        assert result["provider"] == "openai"
        assert result["error_code"] == "E_LLM_PROVIDER_DOWN"

        with direct_db.session() as session:
            rows = session.execute(
                text(
                    """
                    SELECT call_seq, provider, model_name, llm_operation,
                           key_mode_requested, key_mode_used, error_class, error_detail
                    FROM llm_calls
                    WHERE owner_kind = 'media_enrichment' AND owner_id = :id
                    ORDER BY call_seq
                    """
                ),
                {"id": media_id},
            ).fetchall()

        assert [(row.call_seq, row.provider) for row in rows] == [(1, "openai")], (
            f"Expected one ledger row for the configured provider attempt, got {rows}"
        )
        assert rows[0].error_class == "E_LLM_PROVIDER_DOWN"
        assert rows[0].error_detail == "ModelCallError: openai down"
        assert {row.llm_operation for row in rows} == {"metadata_enrichment"}
        assert {(row.key_mode_requested, row.key_mode_used) for row in rows} == {
            ("auto", "platform")
        }

    def test_platform_enrichment_runs_inside_budget_envelope(
        self,
        direct_db: DirectSessionManager,
        monkeypatch,
        metadata_rate_limiter: _RecordingRateLimiter,
    ):
        """Platform metadata enrichment uses the shared inflight and token-budget envelope."""
        user_id = create_test_user_id()
        media_id = uuid4()

        direct_db.register_cleanup("media", "id", media_id)
        direct_db.register_cleanup("users", "id", user_id)
        direct_db.register_cleanup("llm_calls", "owner_id", media_id)

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
            session.commit()

        enrich_module = _enrich_metadata_module()
        monkeypatch.setattr(
            enrich_module,
            "select_enrichment_model",
            lambda _s: ("openai", "gpt-5.4-mini"),
        )
        _stub_resolved_keys(monkeypatch, enrich_module)

        async def _fake_generate(self, req, *, key, timeout_s):
            _ = self, req, key, timeout_s
            return _completed_response(
                {
                    "title": "Budgeted Title",
                    "authors": None,
                    "publisher": None,
                    "description": None,
                    "published_date": None,
                    "language": None,
                },
                usage=TokenUsage(input_tokens=7, output_tokens=5, total_tokens=12),
            )

        monkeypatch.setattr(enrich_module.ModelRuntime, "generate", _fake_generate)

        result = enrich_module.enrich_metadata(str(media_id))

        assert result["status"] == "success"
        assert metadata_rate_limiter.event_names() == [
            "acquire_inflight_slot",
            "reserve_token_budget",
            "commit_token_budget",
            "release_inflight_slot",
        ], f"unexpected envelope: {metadata_rate_limiter.events}"
        reserve_event = metadata_rate_limiter.events[1]
        commit_event = metadata_rate_limiter.events[2]
        assert reserve_event[1] == user_id
        assert reserve_event[2] == media_id
        assert reserve_event[3] is not None and reserve_event[3] > 1200
        assert commit_event == ("commit_token_budget", user_id, media_id, 12)

    def test_byok_success_marks_key_valid(
        self, direct_db: DirectSessionManager, monkeypatch, request
    ):
        """Real resolve_api_key path: the owner's BYOK key is used and a
        successful enrichment marks it 'valid' (terminal key-status feedback)."""
        _get_master_key.cache_clear()
        request.addfinalizer(_get_master_key.cache_clear)
        test_key = b"test_master_key_for_encryption!!"
        assert len(test_key) == MASTER_KEY_SIZE
        monkeypatch.setenv("NEXUS_KEY_ENCRYPTION_KEY", base64.b64encode(test_key).decode("ascii"))

        user_id = create_test_user_id()
        media_id = uuid4()
        byok_plaintext = "sk-byok-openai-key-1234567890"
        ciphertext, nonce, version, fingerprint = encrypt_api_key(byok_plaintext)

        direct_db.register_cleanup("media", "id", media_id)
        direct_db.register_cleanup("users", "id", user_id)
        direct_db.register_cleanup("llm_calls", "owner_id", media_id)

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
            session.execute(
                text(
                    """
                    INSERT INTO user_api_keys (
                        user_id, provider, encrypted_key, key_nonce,
                        master_key_version, key_fingerprint, status
                    ) VALUES (
                        :user_id, 'openai', :encrypted_key, :key_nonce,
                        :version, :fingerprint, 'untested'
                    )
                    """
                ),
                {
                    "user_id": user_id,
                    "encrypted_key": ciphertext,
                    "key_nonce": nonce,
                    "version": version,
                    "fingerprint": fingerprint,
                },
            )
            session.commit()

        enrich_module = _enrich_metadata_module()
        monkeypatch.setattr(
            enrich_module,
            "select_enrichment_model",
            lambda _s: ("openai", "gpt-5.4-mini"),
        )

        seen: dict[str, ProviderApiKey] = {}

        async def _fake_generate(self, req, *, key, timeout_s):
            _ = self, req, key, timeout_s
            seen["api_key"] = key
            return _completed_response(
                {
                    "title": "BYOK Title",
                    "authors": None,
                    "publisher": None,
                    "description": None,
                    "published_date": None,
                    "language": None,
                }
            )

        monkeypatch.setattr(enrich_module.ModelRuntime, "generate", _fake_generate)

        result = enrich_module.enrich_metadata(str(media_id))

        assert result["status"] == "success", f"Expected BYOK-backed success, got {result}"
        assert seen["api_key"].source == "byok"
        assert seen["api_key"].reveal() == byok_plaintext, (
            "the decrypted BYOK key must reach the provider"
        )

        with direct_db.session() as session:
            key_row = session.execute(
                text(
                    """
                    SELECT status, last_tested_at, last_used_at
                    FROM user_api_keys WHERE user_id = :user_id AND provider = 'openai'
                    """
                ),
                {"user_id": user_id},
            ).fetchone()
            ledger_row = session.execute(
                text(
                    """
                    SELECT key_mode_requested, key_mode_used FROM llm_calls
                    WHERE owner_kind = 'media_enrichment' AND owner_id = :id
                    """
                ),
                {"id": media_id},
            ).fetchone()

        assert key_row is not None
        status, last_tested_at, last_used_at = key_row
        assert status == "valid", f"BYOK success must mark the key valid, got {status!r}"
        assert last_tested_at is not None and last_used_at is not None, (
            f"valid feedback must stamp last_tested_at/last_used_at, got {key_row}"
        )
        assert ledger_row == ("auto", "byok")

    def test_byok_invalid_key_marks_key_invalid(
        self, direct_db: DirectSessionManager, monkeypatch, request
    ):
        """A BYOK key that the provider rejects with E_LLM_INVALID_KEY is marked
        'invalid' so it stops being retried forever (terminal key-status feedback)."""
        _get_master_key.cache_clear()
        request.addfinalizer(_get_master_key.cache_clear)
        test_key = b"test_master_key_for_encryption!!"
        assert len(test_key) == MASTER_KEY_SIZE
        monkeypatch.setenv("NEXUS_KEY_ENCRYPTION_KEY", base64.b64encode(test_key).decode("ascii"))

        user_id = create_test_user_id()
        media_id = uuid4()
        byok_plaintext = "sk-byok-openai-key-1234567890"
        ciphertext, nonce, version, fingerprint = encrypt_api_key(byok_plaintext)

        direct_db.register_cleanup("media", "id", media_id)
        direct_db.register_cleanup("users", "id", user_id)
        direct_db.register_cleanup("llm_calls", "owner_id", media_id)

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
            session.execute(
                text(
                    """
                    INSERT INTO user_api_keys (
                        user_id, provider, encrypted_key, key_nonce,
                        master_key_version, key_fingerprint, status
                    ) VALUES (
                        :user_id, 'openai', :encrypted_key, :key_nonce,
                        :version, :fingerprint, 'untested'
                    )
                    """
                ),
                {
                    "user_id": user_id,
                    "encrypted_key": ciphertext,
                    "key_nonce": nonce,
                    "version": version,
                    "fingerprint": fingerprint,
                },
            )
            session.commit()

        enrich_module = _enrich_metadata_module()
        monkeypatch.setattr(
            enrich_module,
            "select_enrichment_model",
            lambda _s: ("openai", "gpt-5.4-mini"),
        )

        async def _fake_generate(self, req, *, key, timeout_s):
            _ = self, req, key, timeout_s
            raise ModelCallError(ModelCallErrorCode.INVALID_KEY, "rejected", provider="openai")

        monkeypatch.setattr(enrich_module.ModelRuntime, "generate", _fake_generate)

        result = enrich_module.enrich_metadata(str(media_id))

        assert result["status"] == "failed"
        assert result["error_code"] == "E_LLM_INVALID_KEY", f"got {result}"

        with direct_db.session() as session:
            status = session.execute(
                text(
                    "SELECT status FROM user_api_keys "
                    "WHERE user_id = :user_id AND provider = 'openai'"
                ),
                {"user_id": user_id},
            ).scalar_one()

        assert status == "invalid", (
            f"BYOK invalid-key failure must mark the key invalid, got {status!r}"
        )

    def test_ownerless_media_records_no_provider_failure(
        self, direct_db: DirectSessionManager, monkeypatch
    ):
        """Without an owning user there is no key spine to resolve against."""
        media_id = uuid4()
        direct_db.register_cleanup("media", "id", media_id)

        with direct_db.session() as session:
            session.execute(
                text(
                    """
                    INSERT INTO media (
                        id, kind, title, canonical_source_url, processing_status
                    ) VALUES (
                        :id, 'web_article', 'notes.pdf', 'https://example.com/a',
                        'ready_for_reading'
                    )
                    """
                ),
                {"id": media_id},
            )
            session.commit()

        enrich_module = _enrich_metadata_module()
        monkeypatch.setattr(
            enrich_module,
            "select_enrichment_model",
            lambda _s: ("openai", "gpt-5.4-mini"),
        )

        result = enrich_module.enrich_metadata(str(media_id))

        assert result["status"] == "failed"
        assert result["reason"] == "no_provider"
        assert result["error_code"] == "E_METADATA_NO_PROVIDER"

        with direct_db.session() as session:
            row = session.execute(
                text("SELECT failure_stage, last_error_code FROM media WHERE id = :id"),
                {"id": media_id},
            ).fetchone()

        assert row == ("metadata", "E_METADATA_NO_PROVIDER")
