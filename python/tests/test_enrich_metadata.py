"""Integration tests for metadata enrichment task behavior.

`enrich_metadata` has no separate "owner function" injected with a runtime the
way e.g. `generate_dawn_write` is (see `tests/test_dawn_write.py`) — the
`GenerationRequest`/`execute_generation` call lives directly inside the task's
`_run` closure, itself invoked through `run_llm_task`. The only test seam is
`ExecutionRuntime` construction (`nexus.tasks.llm_task.ProductionExecutionRuntime`),
which this file swaps for a fake that scripts one `provider_runtime` outcome
per call — the same `_ScriptedRuntime` shape `tests/test_llm_execution.py` uses.

Unlike `tests/test_llm_execution.py`, this file does NOT route the task
through a savepoint-shared `db_session`: `enrich_metadata` fans out across
*three independent, separately-committing sessions* on its own (the worker's
`db`, `execute_generation`'s ledger `session_factory`, and the author facade's
"fresh session" per spec 2.4/D-14 in `nexus.services.contributors`) — nesting
three `join_transaction_mode="create_savepoint"` sessions that deeply breaks
SQLAlchemy's savepoint bookkeeping. So this file uses `direct_db`
(`DirectSessionManager`, real independent connections, real commits) exactly
like the pre-cutover file did, and leaves every `get_session_factory` seam
pointed at its real default (already resolving to the test database via the
`DATABASE_URL` env var) — only the rate limiter singleton and the
`ExecutionRuntime` construction are test-installed.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import UTC, datetime
from uuid import UUID, uuid4

import pytest
from provider_runtime import (
    Absent,
    CallMeta,
    Failed,
    GenerateIntent,
    PossiblyBillable,
    Present,
    ProviderHttpUnavailable,
    ResponsePayload,
    StructuredContent,
    Succeeded,
    TokenUsage,
    TransientExhausted,
    UserMessage,
)
from sqlalchemy import text

from nexus.config import clear_settings_cache
from nexus.db.session import get_session_factory
from nexus.services.billing_entitlements import grant_entitlement_override
from nexus.services.contributor_credits import load_contributor_credits_for_media
from nexus.services.llm_profiles import operation_profile
from nexus.services.rate_limit import RateLimiter, get_rate_limiter, set_rate_limiter
from tests.helpers import create_test_user_id
from tests.utils.db import DirectSessionManager

pytestmark = pytest.mark.integration

_PROFILE = operation_profile("metadata_enrichment")


# ---------------------------------------------------------------------------
# ExecutionRuntime fixture seam — same shape as tests/test_llm_execution.py's
# `_ScriptedRuntime`, plus `intents` capture (this file asserts prompt content,
# which the reference fixture doesn't need to track).
# ---------------------------------------------------------------------------


@dataclass
class _ScriptedRuntime:
    outcome: object
    calls: list[str] = field(default_factory=list)
    intents: list[GenerateIntent] = field(default_factory=list)

    async def generate(self, intent, plan, credential):
        self.calls.append("generate")
        self.intents.append(intent)
        return self.outcome

    def stream(self, intent, plan, credential, *, cancel):
        raise NotImplementedError("enrich_metadata never streams")


def _meta(**overrides: object) -> CallMeta:
    fields: dict[str, object] = {
        "provider": _PROFILE.target.provider,
        "model": _PROFILE.target.model,
        "provider_request_id": Present("req-abc"),
        "upstream_provider": Absent(),
        "usage": Present(
            TokenUsage(
                input_tokens=50,
                output_tokens=20,
                total_tokens=70,
                reasoning_tokens=Absent(),
                cache_read_input_tokens=Absent(),
                cache_write_input_tokens=Absent(),
            )
        ),
        "attempt_trace": (),
        "billability": PossiblyBillable(),
    }
    fields.update(overrides)
    return CallMeta(**fields)  # type: ignore[arg-type]


def _succeeded(payload: dict, *, usage: TokenUsage | None = None) -> Succeeded:
    meta = _meta(usage=Present(usage)) if usage is not None else _meta()
    return Succeeded(
        meta=meta,
        response=ResponsePayload(
            content=StructuredContent(payload=payload, text=json.dumps(payload)),
            continuation=Absent(),
        ),
    )


def _provider_unavailable_failure() -> Failed:
    return Failed(
        meta=_meta(usage=Absent()),
        failure=TransientExhausted(attempts=1, cause=ProviderHttpUnavailable()),
    )


def _prompt_text(intent: GenerateIntent) -> str:
    return "\n".join(
        block.text
        for message in intent.messages
        if isinstance(message, UserMessage)
        for block in message.blocks
    )


# ---------------------------------------------------------------------------
# Wiring
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _platform_key(monkeypatch):
    """generation_credential needs a configured platform key for the pinned
    ("fast" -> openai) profile — there is no BYOK path any more."""
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test-platform-openai")
    clear_settings_cache()
    yield
    clear_settings_cache()


@pytest.fixture(autouse=True)
def _rate_limiter():
    previous = get_rate_limiter()
    set_rate_limiter(RateLimiter(session_factory=get_session_factory()))
    yield
    set_rate_limiter(previous)


def _install_runtime(monkeypatch, runtime: _ScriptedRuntime) -> None:
    monkeypatch.setattr(
        "nexus.tasks.llm_task.ProductionExecutionRuntime", lambda provider_runtime: runtime
    )


def _grant_ai_entitlement(direct_db: DirectSessionManager, user_id: UUID) -> None:
    direct_db.register_cleanup("billing_entitlement_overrides", "user_id", user_id)
    # Registered after the parent so it runs first (LIFO): the audit-event child
    # rows FK-reference the override and must be deleted before it.
    direct_db.register_cleanup("billing_entitlement_override_events", "user_id", user_id)
    with direct_db.session() as session:
        grant_entitlement_override(
            session,
            user_id=user_id,
            plan_tier="ai_pro",
            platform_token_quota_mode="unlimited",
            platform_token_limit_monthly=None,
            transcription_quota_mode="unlimited",
            transcription_minutes_limit_monthly=None,
            expires_at=None,
            reason="enrich_metadata integration test",
            actor_label="test",
        )
        session.commit()


class _RecordingRateLimiter(RateLimiter):
    """Records the metadata worker budget-envelope calls while still
    delegating to the real Postgres-backed implementation."""

    def __init__(self, *, session_factory) -> None:
        super().__init__(session_factory=session_factory)
        self.events: list[tuple[str, UUID, UUID | None, int | None]] = []

    def acquire_inflight_slot(self, user_id: UUID) -> None:
        self.events.append(("acquire_inflight_slot", user_id, None, None))
        super().acquire_inflight_slot(user_id)

    def release_inflight_slot(self, user_id: UUID) -> None:
        self.events.append(("release_inflight_slot", user_id, None, None))
        super().release_inflight_slot(user_id)

    def reserve_token_budget(
        self, user_id: UUID, reservation_id: UUID, est_tokens: int, ttl: int = 300
    ) -> None:
        self.events.append(("reserve_token_budget", user_id, reservation_id, est_tokens))
        super().reserve_token_budget(user_id, reservation_id, est_tokens, ttl)

    def commit_token_budget(self, user_id: UUID, reservation_id: UUID, actual_tokens: int) -> None:
        self.events.append(("commit_token_budget", user_id, reservation_id, actual_tokens))
        super().commit_token_budget(user_id, reservation_id, actual_tokens)

    def release_token_budget(self, user_id: UUID, reservation_id: UUID) -> None:
        self.events.append(("release_token_budget", user_id, reservation_id, None))
        super().release_token_budget(user_id, reservation_id)

    def event_names(self) -> list[str]:
        return [event[0] for event in self.events]


def _insert_user(session, user_id: UUID) -> None:
    session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})


def _insert_media(
    session,
    media_id: UUID,
    *,
    kind: str = "web_article",
    title: str = "notes.pdf",
    processing_status: str = "ready_for_reading",
    created_by_user_id: UUID | None,
    publisher: str | None = None,
    description: str | None = None,
    language: str | None = None,
    published_date: str | None = None,
    failure_stage: str | None = None,
    last_error_code: str | None = None,
    last_error_message: str | None = None,
    metadata_enriched_at: datetime | None = None,
) -> None:
    session.execute(
        text(
            """
            INSERT INTO media (
                id, kind, title, canonical_source_url, processing_status,
                created_by_user_id, publisher, description, language,
                published_date, failure_stage, last_error_code, last_error_message,
                metadata_enriched_at
            ) VALUES (
                :id, :kind, :title, 'https://example.com/a', :processing_status,
                :created_by_user_id, :publisher, :description, :language,
                :published_date, :failure_stage, :last_error_code, :last_error_message,
                :metadata_enriched_at
            )
            """
        ),
        {
            "id": media_id,
            "kind": kind,
            "title": title,
            "processing_status": processing_status,
            "created_by_user_id": created_by_user_id,
            "publisher": publisher,
            "description": description,
            "language": language,
            "published_date": published_date,
            "failure_stage": failure_stage,
            "last_error_code": last_error_code,
            "last_error_message": last_error_message,
            "metadata_enriched_at": metadata_enriched_at,
        },
    )


def _register_user_and_media_cleanup(
    direct_db: DirectSessionManager, *, media_id: UUID, user_id: UUID | None
) -> None:
    # Registration order is parent-first; DirectSessionManager.cleanup() deletes
    # in reverse (LIFO), so this yields child-first, FK-safe deletion:
    # llm_calls, contributor_credits, media, users.
    if user_id is not None:
        direct_db.register_cleanup("users", "id", user_id)
    direct_db.register_cleanup("media", "id", media_id)
    direct_db.register_cleanup("contributor_credits", "media_id", media_id)
    direct_db.register_cleanup("llm_calls", "owner_id", media_id)


def _media_row(direct_db: DirectSessionManager, media_id: UUID, columns: str):
    with direct_db.session() as session:
        return session.execute(
            text(f"SELECT {columns} FROM media WHERE id = :id"), {"id": media_id}
        ).fetchone()


def _author_rows(direct_db: DirectSessionManager, media_id: UUID):
    with direct_db.session() as session:
        return session.execute(
            text(
                "SELECT credited_name FROM contributor_credits"
                " WHERE media_id = :media_id ORDER BY ordinal ASC"
            ),
            {"media_id": media_id},
        ).fetchall()


def _llm_call_rows(direct_db: DirectSessionManager, media_id: UUID):
    with direct_db.session() as session:
        return session.execute(
            text(
                """
                SELECT call_seq, provider, model_name, llm_operation, outcome,
                       error_origin, error_code, error_detail
                FROM llm_calls
                WHERE owner_kind = 'media_enrichment' AND owner_id = :id
                ORDER BY call_seq
                """
            ),
            {"id": media_id},
        ).fetchall()


class TestEnrichMetadata:
    def test_pending_podcast_episode_uses_show_notes_and_structured_metadata(
        self, direct_db: DirectSessionManager, monkeypatch
    ):
        from nexus.tasks.enrich_metadata import enrich_metadata

        user_id = create_test_user_id()
        podcast_id = uuid4()
        media_id = uuid4()

        direct_db.register_cleanup("users", "id", user_id)
        direct_db.register_cleanup("media", "id", media_id)
        direct_db.register_cleanup("podcasts", "id", podcast_id)
        direct_db.register_cleanup("podcast_episodes", "media_id", media_id)
        direct_db.register_cleanup("contributor_credits", "media_id", media_id)
        direct_db.register_cleanup("llm_calls", "owner_id", media_id)

        with direct_db.session() as session:
            _insert_user(session, user_id)
            session.execute(
                text(
                    """
                    INSERT INTO podcasts (id, provider, provider_podcast_id, title, feed_url)
                    VALUES (:id, 'podcast_index', :provider_podcast_id, :title, :feed_url)
                    """
                ),
                {
                    "id": podcast_id,
                    "provider_podcast_id": f"enrich-podcast-{uuid4()}",
                    "title": "Systems Show",
                    "feed_url": f"https://feeds.example.com/{podcast_id}.xml",
                },
            )
            _insert_media(
                session,
                media_id,
                kind="podcast_episode",
                title="Episode 7",
                created_by_user_id=user_id,
            )
            session.execute(
                text(
                    """
                    INSERT INTO podcast_episodes (
                        media_id, podcast_id, provider_episode_id, fallback_identity,
                        description_text
                    ) VALUES (
                        :media_id, :podcast_id, :provider_episode_id, :fallback_identity,
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
        _grant_ai_entitlement(direct_db, user_id)

        runtime = _ScriptedRuntime(
            outcome=_succeeded(
                {
                    "title": None,
                    "authors": ["Episode Host"],
                    "publisher": "Systems Show",
                    "language": "en",
                    "description": "A short summary of the episode.",
                    "published_date": "2026-03-02",
                }
            )
        )
        _install_runtime(monkeypatch, runtime)

        result = enrich_metadata(str(media_id))

        assert result["status"] == "success"
        assert runtime.calls == ["generate"]
        prompt = _prompt_text(runtime.intents[0])
        assert "Systems Show" in prompt
        assert "feedback loops" in prompt

        media_row = _media_row(
            direct_db, media_id, "publisher, language, description, published_date"
        )
        author_rows = _author_rows(direct_db, media_id)

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
        from nexus.tasks.enrich_metadata import enrich_metadata

        user_id = create_test_user_id()
        media_id = uuid4()
        fragment_id = uuid4()

        _register_user_and_media_cleanup(direct_db, media_id=media_id, user_id=user_id)

        with direct_db.session() as session:
            _insert_user(session, user_id)
            _insert_media(
                session,
                media_id,
                title="John-Keats.com - Poems",
                created_by_user_id=user_id,
                metadata_enriched_at=datetime.now(UTC),
            )
            session.execute(
                text(
                    """
                    INSERT INTO fragments (id, media_id, idx, html_sanitized, canonical_text)
                    VALUES (
                        :id, :media_id, 0,
                        '<p>Ada Lovelace wrote these analytical engine notes.</p>',
                        'Ada Lovelace wrote these analytical engine notes.'
                    )
                    """
                ),
                {"id": fragment_id, "media_id": media_id},
            )
            session.commit()
        _grant_ai_entitlement(direct_db, user_id)

        runtime = _ScriptedRuntime(
            outcome=_succeeded(
                {
                    "title": "Analytical Engine Notes",
                    "authors": ["Ada Lovelace"],
                    "publisher": "Nexus Archive",
                    "description": "Ada Lovelace's notes on the analytical engine.",
                    "published_date": "1843",
                    "language": "en",
                }
            )
        )
        _install_runtime(monkeypatch, runtime)

        result = enrich_metadata(str(media_id))
        assert result["status"] == "success"

        media_row = _media_row(
            direct_db, media_id, "title, publisher, description, published_date, language"
        )
        author_rows = _author_rows(direct_db, media_id)

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
        from nexus.tasks.enrich_metadata import enrich_metadata

        user_id = create_test_user_id()
        media_id = uuid4()

        _register_user_and_media_cleanup(direct_db, media_id=media_id, user_id=user_id)

        with direct_db.session() as session:
            _insert_user(session, user_id)
            _insert_media(
                session,
                media_id,
                title="Real Article Title",
                created_by_user_id=user_id,
                publisher="Example Co",
                description="A summary.",
                language="en",
                published_date="2026-01-01",
            )
            session.commit()
        _grant_ai_entitlement(direct_db, user_id)

        runtime = _ScriptedRuntime(
            outcome=_succeeded(
                {
                    "title": "Better Article Title",
                    "authors": None,
                    "publisher": None,
                    "description": None,
                    "published_date": None,
                    "language": "en",
                }
            )
        )
        _install_runtime(monkeypatch, runtime)

        result = enrich_metadata(str(media_id))
        assert result["status"] == "success", (
            f"Expected automatic enrichment to run even when all fields are populated, got {result}"
        )
        assert "no_gaps" not in str(result)

    def test_overwrites_populated_fields_by_default(
        self, direct_db: DirectSessionManager, monkeypatch
    ):
        from nexus.tasks.enrich_metadata import enrich_metadata

        user_id = create_test_user_id()
        media_id = uuid4()

        _register_user_and_media_cleanup(direct_db, media_id=media_id, user_id=user_id)

        with direct_db.session() as session:
            _insert_user(session, user_id)
            _insert_media(
                session,
                media_id,
                title="Old Title",
                created_by_user_id=user_id,
                publisher="Old Publisher",
                description="Old description.",
            )
            session.commit()
        _grant_ai_entitlement(direct_db, user_id)

        runtime = _ScriptedRuntime(
            outcome=_succeeded(
                {
                    "title": "New Title",
                    "authors": None,
                    "publisher": "New Publisher",
                    "description": "New description.",
                    "published_date": None,
                    "language": None,
                }
            )
        )
        _install_runtime(monkeypatch, runtime)

        result = enrich_metadata(str(media_id))
        assert result["status"] == "success", f"Expected success, got {result}"

        row = _media_row(direct_db, media_id, "title, publisher, description")
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
        from nexus.tasks.enrich_metadata import enrich_metadata

        user_id = create_test_user_id()
        media_id = uuid4()

        _register_user_and_media_cleanup(direct_db, media_id=media_id, user_id=user_id)

        with direct_db.session() as session:
            _insert_user(session, user_id)
            _insert_media(session, media_id, title="notes.pdf", created_by_user_id=user_id)
            session.commit()
        _grant_ai_entitlement(direct_db, user_id)

        runtime = _ScriptedRuntime(
            outcome=_succeeded(
                {
                    "title": "Analytical Engine Notes",
                    "authors": ["Ada Lovelace", "Ada  Lovelace", "Charles Babbage"],
                    "publisher": None,
                    "description": None,
                    "published_date": None,
                    "language": None,
                }
            )
        )
        _install_runtime(monkeypatch, runtime)

        first = enrich_metadata(str(media_id))
        second = enrich_metadata(str(media_id))

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
        # Old surface: the runtime raised ModelCallError(PROVIDER_DOWN) and the
        # task recorded error_code="E_LLM_PROVIDER_DOWN". New surface: a
        # provider failure is a *returned* Failed(TransientExhausted(...))
        # outcome (the runtime already exhausted its own retries), mapped by
        # outcome_failure_facts to the runtime's fixed failure code.
        from nexus.tasks.enrich_metadata import enrich_metadata

        user_id = create_test_user_id()
        media_id = uuid4()

        _register_user_and_media_cleanup(direct_db, media_id=media_id, user_id=user_id)

        with direct_db.session() as session:
            _insert_user(session, user_id)
            _insert_media(session, media_id, title="notes.pdf", created_by_user_id=user_id)
            session.commit()
        _grant_ai_entitlement(direct_db, user_id)

        runtime = _ScriptedRuntime(outcome=_provider_unavailable_failure())
        _install_runtime(monkeypatch, runtime)

        result = enrich_metadata(str(media_id))

        assert result["status"] == "failed"
        assert result["reason"] == "llm_failed"
        assert result["error_code"] == "provider_unavailable", (
            f"Expected llm_failed result, got {result}"
        )

        row = _media_row(
            direct_db,
            media_id,
            "failure_stage, last_error_code, last_error_message, processing_status",
        )
        assert row is not None
        failure_stage, last_error_code, last_error_message, processing_status = row
        assert failure_stage == "metadata", (
            f"Expected failure_stage='metadata', got {failure_stage!r}"
        )
        assert last_error_code == "provider_unavailable", (
            f"Expected the runtime failure code, got {last_error_code!r}"
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
        from nexus.tasks.enrich_metadata import enrich_metadata

        user_id = create_test_user_id()
        media_id = uuid4()

        _register_user_and_media_cleanup(direct_db, media_id=media_id, user_id=user_id)

        with direct_db.session() as session:
            _insert_user(session, user_id)
            _insert_media(session, media_id, title="notes.pdf", created_by_user_id=user_id)
            session.commit()
        _grant_ai_entitlement(direct_db, user_id)

        # A Succeeded outcome whose StructuredContent.payload does not satisfy
        # MetadataEnrichmentOutput (missing the other five required-nullable
        # keys) — the strict-JSON contract still leaves room for a payload
        # that fails the pydantic schema, and that must fail closed.
        runtime = _ScriptedRuntime(
            outcome=_succeeded({"title": "Unstructured text payload must be ignored"})
        )
        _install_runtime(monkeypatch, runtime)

        result = enrich_metadata(str(media_id))

        assert result["status"] == "failed"
        assert result["reason"] == "parse_failed"
        assert result["error_code"] == "E_METADATA_PARSE_FAILED", (
            f"Expected malformed structured output to fail closed, got {result}"
        )

        row = _media_row(direct_db, media_id, "failure_stage, last_error_code, processing_status")
        assert row == ("metadata", "E_METADATA_PARSE_FAILED", "ready_for_reading"), (
            f"Expected metadata failure recorded with parse-failed code, got {row}"
        )

    def test_structured_validation_failure_is_terminal(
        self, direct_db: DirectSessionManager, monkeypatch
    ):
        # Old surface: this exercised provider-fallback (openai -> gemini) and
        # asserted the eventual failure's `result["provider"]`. There is no
        # per-call provider fallback any more (one profile, one dispatch), and
        # a failed result no longer carries provider/model at all (only a
        # success result does) — this test's remaining scope is that a
        # semantically-invalid field (bad partial-ISO date) in an otherwise
        # complete structured payload is a terminal parse failure, not
        # silently coerced or retried.
        from nexus.tasks.enrich_metadata import enrich_metadata

        user_id = create_test_user_id()
        media_id = uuid4()

        _register_user_and_media_cleanup(direct_db, media_id=media_id, user_id=user_id)

        with direct_db.session() as session:
            _insert_user(session, user_id)
            _insert_media(
                session,
                media_id,
                title="notes.pdf",
                created_by_user_id=user_id,
                failure_stage="metadata",
                last_error_code="E_METADATA_PARSE_FAILED",
                last_error_message="previous failure",
            )
            session.commit()
        _grant_ai_entitlement(direct_db, user_id)

        runtime = _ScriptedRuntime(
            outcome=_succeeded(
                {
                    "title": "Bad Date",
                    "authors": None,
                    "publisher": None,
                    "description": None,
                    "published_date": "March 1843",
                    "language": "en",
                }
            )
        )
        _install_runtime(monkeypatch, runtime)

        result = enrich_metadata(str(media_id))

        assert result["status"] == "failed"
        assert result["reason"] == "parse_failed"
        assert "provider" not in result, "a failed result no longer carries provider/model"

        row = _media_row(
            direct_db, media_id, "title, publisher, language, failure_stage, last_error_code"
        )
        assert row == ("notes.pdf", None, None, "metadata", "E_METADATA_PARSE_FAILED")

    def test_successful_run_clears_prior_metadata_failure(
        self, direct_db: DirectSessionManager, monkeypatch
    ):
        from nexus.tasks.enrich_metadata import enrich_metadata

        user_id = create_test_user_id()
        media_id = uuid4()

        _register_user_and_media_cleanup(direct_db, media_id=media_id, user_id=user_id)

        with direct_db.session() as session:
            _insert_user(session, user_id)
            _insert_media(
                session,
                media_id,
                title="Real Title",
                created_by_user_id=user_id,
                failure_stage="metadata",
                last_error_code="E_FOO",
                last_error_message="prior",
            )
            session.commit()
        _grant_ai_entitlement(direct_db, user_id)

        runtime = _ScriptedRuntime(
            outcome=_succeeded(
                {
                    "title": None,
                    "authors": None,
                    "publisher": "Recovered Publisher",
                    "description": None,
                    "published_date": None,
                    "language": None,
                }
            )
        )
        _install_runtime(monkeypatch, runtime)

        result = enrich_metadata(str(media_id))
        assert result["status"] == "success", f"Expected success, got {result}"

        row = _media_row(
            direct_db,
            media_id,
            "failure_stage, last_error_code, last_error_message, processing_status",
        )
        assert row == (None, None, None, "ready_for_reading"), (
            f"Expected prior metadata failure cleared (status unchanged), got {row}"
        )

    def test_no_provider_records_failure_while_operational_skips_do_not(
        self, direct_db: DirectSessionManager, monkeypatch
    ):
        from nexus.tasks.enrich_metadata import enrich_metadata

        user_id = create_test_user_id()
        media_disabled = uuid4()
        media_extracting = uuid4()
        media_missing = uuid4()

        direct_db.register_cleanup("users", "id", user_id)
        direct_db.register_cleanup("media", "id", media_disabled)
        direct_db.register_cleanup("media", "id", media_extracting)

        with direct_db.session() as session:
            _insert_user(session, user_id)
            # has gaps and an owning user, but enrichment is disabled globally
            _insert_media(session, media_disabled, created_by_user_id=user_id)
            # not_ready: still extracting
            _insert_media(
                session,
                media_extracting,
                processing_status="extracting",
                created_by_user_id=user_id,
            )
            session.commit()

        monkeypatch.setenv("METADATA_ENRICHMENT_ENABLED", "false")
        clear_settings_cache()

        no_provider_result = enrich_metadata(str(media_disabled))
        assert no_provider_result["status"] == "failed"
        assert no_provider_result["reason"] == "no_provider"
        assert no_provider_result["error_code"] == "E_METADATA_NO_PROVIDER"

        not_ready_result = enrich_metadata(str(media_extracting))
        assert not_ready_result == {"status": "skipped", "reason": "not_ready"}

        not_found_result = enrich_metadata(str(media_missing))
        assert not_found_result == {"status": "skipped", "reason": "media_not_found"}

        clear_settings_cache()

        with direct_db.session() as session:
            rows = {
                row.id: row
                for row in session.execute(
                    text(
                        "SELECT id, failure_stage, last_error_code, last_error_message"
                        " FROM media WHERE id = ANY(:ids)"
                    ),
                    {"ids": [media_disabled, media_extracting]},
                ).fetchall()
            }

        disabled_row = rows[media_disabled]
        assert disabled_row.failure_stage == "metadata"
        assert disabled_row.last_error_code == "E_METADATA_NO_PROVIDER"
        assert disabled_row.last_error_message

        extracting_row = rows[media_extracting]
        assert (
            extracting_row.failure_stage is None
            and extracting_row.last_error_code is None
            and extracting_row.last_error_message is None
        ), f"Operational skips should not write failure_stage; got {tuple(extracting_row)}"

    def test_failed_processing_status_is_not_marked_metadata_failed(
        self, direct_db: DirectSessionManager
    ):
        from nexus.tasks.enrich_metadata import enrich_metadata

        user_id = create_test_user_id()
        media_id = uuid4()

        direct_db.register_cleanup("users", "id", user_id)
        direct_db.register_cleanup("media", "id", media_id)

        with direct_db.session() as session:
            _insert_user(session, user_id)
            _insert_media(
                session,
                media_id,
                processing_status="failed",
                failure_stage="embed",
                last_error_code="E_INGEST_FAILED",
                created_by_user_id=user_id,
            )
            session.commit()

        result = enrich_metadata(str(media_id))
        assert result == {"status": "skipped", "reason": "not_ready"}

        row = _media_row(direct_db, media_id, "processing_status, failure_stage, last_error_code")
        assert row == ("failed", "embed", "E_INGEST_FAILED")

    def test_provider_failure_ledgers_one_terminal_provider_attempt(
        self, direct_db: DirectSessionManager, monkeypatch
    ):
        """Provider failure is terminal in one dispatch; there is no
        per-call provider-fallback chain any more (one profile, one call)."""
        from nexus.tasks.enrich_metadata import enrich_metadata

        user_id = create_test_user_id()
        media_id = uuid4()

        _register_user_and_media_cleanup(direct_db, media_id=media_id, user_id=user_id)

        with direct_db.session() as session:
            _insert_user(session, user_id)
            _insert_media(session, media_id, title="notes.pdf", created_by_user_id=user_id)
            session.commit()
        _grant_ai_entitlement(direct_db, user_id)

        runtime = _ScriptedRuntime(outcome=_provider_unavailable_failure())
        _install_runtime(monkeypatch, runtime)

        result = enrich_metadata(str(media_id))

        assert result["status"] == "failed"
        assert result["error_code"] == "provider_unavailable"

        rows = _llm_call_rows(direct_db, media_id)

        assert [(row.call_seq, row.provider) for row in rows] == [(1, _PROFILE.target.provider)], (
            f"Expected one ledger row for the single dispatch attempt, got {rows}"
        )
        assert rows[0].outcome == "failed"
        assert rows[0].error_origin == "provider_http"
        assert rows[0].error_code == "provider_unavailable"
        assert rows[0].model_name == _PROFILE.target.model
        assert {row.llm_operation for row in rows} == {"metadata_enrichment"}

    def test_platform_enrichment_runs_inside_budget_envelope(
        self, direct_db: DirectSessionManager, monkeypatch
    ):
        """Platform metadata enrichment uses the shared inflight and token-budget envelope."""
        from nexus.tasks.enrich_metadata import enrich_metadata

        user_id = create_test_user_id()
        media_id = uuid4()

        _register_user_and_media_cleanup(direct_db, media_id=media_id, user_id=user_id)

        with direct_db.session() as session:
            _insert_user(session, user_id)
            _insert_media(session, media_id, title="notes.pdf", created_by_user_id=user_id)
            session.commit()
        _grant_ai_entitlement(direct_db, user_id)

        recording_limiter = _RecordingRateLimiter(session_factory=get_session_factory())
        set_rate_limiter(recording_limiter)

        runtime = _ScriptedRuntime(
            outcome=_succeeded(
                {
                    "title": "Budgeted Title",
                    "authors": None,
                    "publisher": None,
                    "description": None,
                    "published_date": None,
                    "language": None,
                },
                usage=TokenUsage(
                    input_tokens=7,
                    output_tokens=5,
                    total_tokens=12,
                    reasoning_tokens=Absent(),
                    cache_read_input_tokens=Absent(),
                    cache_write_input_tokens=Absent(),
                ),
            )
        )
        _install_runtime(monkeypatch, runtime)

        result = enrich_metadata(str(media_id))

        assert result["status"] == "success"
        assert recording_limiter.event_names() == [
            "acquire_inflight_slot",
            "reserve_token_budget",
            "commit_token_budget",
            "release_inflight_slot",
        ], f"unexpected envelope: {recording_limiter.events}"

        with direct_db.session() as session:
            generation_id = session.execute(
                text(
                    "SELECT id FROM llm_calls WHERE owner_kind = 'media_enrichment' AND owner_id = :id"
                ),
                {"id": media_id},
            ).scalar_one()

        reserve_event = recording_limiter.events[1]
        commit_event = recording_limiter.events[2]
        assert reserve_event[1] == user_id
        # The reservation id is the per-call generation id allocated inside
        # execute_generation, not the owner (media) id — unlike the
        # pre-cutover ledger, owner and reservation identity are decoupled.
        assert reserve_event[2] == generation_id
        assert reserve_event[3] is not None and reserve_event[3] > 0
        assert commit_event == ("commit_token_budget", user_id, generation_id, 12)

    def test_ownerless_media_records_no_provider_failure(self, direct_db: DirectSessionManager):
        """Without an owning user there is no platform-key spine to resolve against."""
        from nexus.tasks.enrich_metadata import enrich_metadata

        media_id = uuid4()
        direct_db.register_cleanup("media", "id", media_id)

        with direct_db.session() as session:
            session.execute(
                text(
                    """
                    INSERT INTO media (id, kind, title, canonical_source_url, processing_status)
                    VALUES (:id, 'web_article', 'notes.pdf', 'https://example.com/a', 'ready_for_reading')
                    """
                ),
                {"id": media_id},
            )
            session.commit()

        result = enrich_metadata(str(media_id))

        assert result["status"] == "failed"
        assert result["reason"] == "no_provider"
        assert result["error_code"] == "E_METADATA_NO_PROVIDER"

        row = _media_row(direct_db, media_id, "failure_stage, last_error_code")
        assert row == ("metadata", "E_METADATA_NO_PROVIDER")
