"""Backend tests for the Black Forest Oracle service contract.

Post Oracle-corpus-library cutover: the corpus is a real system library of real
indexed media (``oracle_corpus_sources`` -> ``media`` -> shared content index),
with stable ``oracle_passage_anchors`` resolving to current media evidence and
``oracle_plates`` owned image assets. There is no Oracle-owned text/vector corpus.
"""

from __future__ import annotations

import asyncio
import json
import re
from concurrent.futures import ThreadPoolExecutor
from typing import Any
from uuid import UUID, uuid4

import pytest
from provider_runtime.errors import ModelCallError, ModelCallErrorCode
from provider_runtime.types import ModelResponse, TokenUsage
from sqlalchemy import inspect, select, text
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session

from nexus.config import clear_settings_cache
from nexus.db.models import (
    Fragment,
    Media,
    MediaKind,
    OracleCorpusSource,
    OraclePassageAnchor,
    OraclePlate,
    OracleReading,
    ProcessingStatus,
)
from nexus.schemas.oracle import oracle_done_payload
from nexus.services import library_entries, library_governance, oracle_corpus, run_kit
from nexus.services.billing_entitlements import grant_entitlement_override
from nexus.services.bootstrap import ensure_user_and_default_library
from nexus.services.content_indexing import rebuild_fragment_content_index
from nexus.services.fragment_blocks import insert_fragment_blocks, parse_fragment_blocks
from nexus.services.note_indexing import rebuild_note_content_index
from nexus.services.oracle import (
    ORACLE_THEMES,
    _personal_candidates,
    _viewer_has_searchable_user_content,
    compute_concordance,
    create_reading,
    execute_reading,
    get_reading_detail,
)
from nexus.services.search import search as run_search
from nexus.services.search.query import SearchQuery, SearchScope
from nexus.services.semantic_chunks import (
    build_text_embedding,
    current_transcript_embedding_model,
    current_transcript_embedding_provider,
)
from nexus.tasks.oracle_reading import oracle_reading_generate
from tests.factories import create_searchable_media
from tests.helpers import auth_headers
from tests.utils.db import DirectSessionManager, task_session_factory

pytestmark = pytest.mark.integration

# >=3 corpus works so the LLM always sees >=3 distinct public-domain candidates
# (corpus retrieval dedupes to one candidate per source/work).
ORACLE_TEST_WORK_COUNT = 4


@pytest.fixture(autouse=True)
def anthropic_key(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test-anthropic")
    clear_settings_cache()
    yield
    clear_settings_cache()


def _require_oracle_schema(engine: Engine) -> None:
    tables = set(inspect(engine).get_table_names())
    missing = {
        "oracle_readings",
        "oracle_reading_events",
        "oracle_reading_folios",
        "resource_edges",
        "oracle_corpus_sources",
        "oracle_passage_anchors",
        "oracle_plates",
    } - tables
    if missing:
        pytest.fail(f"oracle schema not present: {', '.join(sorted(missing))}")


@pytest.fixture
def oracle_schema(engine: Engine) -> None:
    _require_oracle_schema(engine)


def _seed_corpus_work(
    db: Session,
    *,
    viewer_id: UUID,
    library_id: UUID,
    work_key: str,
    passage_text: str,
    display_order: int,
) -> UUID:
    """Seed one corpus work as real indexed media with a controllable quote.

    Built like ``create_searchable_media`` but with a custom ``canonical_text`` so
    the anchor's selector quote appears verbatim in a content chunk (the substring
    the resolver matches). Returns the media id.
    """
    media = Media(
        id=uuid4(),
        kind=MediaKind.web_article.value,
        title=f"Corpus {work_key}",
        processing_status=ProcessingStatus.ready_for_reading,
        created_by_user_id=viewer_id,
    )
    db.add(media)
    db.flush()
    fragment = Fragment(
        id=uuid4(),
        media_id=media.id,
        idx=0,
        html_sanitized=f"<p>{passage_text}</p>",
        canonical_text=passage_text,
    )
    db.add(fragment)
    db.flush()
    insert_fragment_blocks(db, fragment.id, parse_fragment_blocks(fragment.canonical_text))
    rebuild_fragment_content_index(
        db,
        media_id=media.id,
        source_kind="web_article",
        fragments=[fragment],
        reason="oracle_test",
    )
    library_entries.ensure_entry(db, library_id, library_entries.media_target(media.id))
    source = OracleCorpusSource(
        corpus_key="oracle",
        work_key=work_key,
        library_id=library_id,
        media_id=media.id,
        title=f"Work {work_key}",
        author_text="A. Scribe",
        source_repository="test",
        source_url=f"https://ex/{work_key}",
        source_download_url=f"https://ex/{work_key}.epub",
        source_media_kind="epub",
        display_order=display_order,
    )
    db.add(source)
    db.flush()
    db.add(
        OraclePassageAnchor(
            corpus_source_id=source.id,
            passage_key=f"{work_key}-a0",
            display_label=f"{work_key} I",
            selector={"kind": "text_quote", "exact": passage_text},
            tags=["forest", "lamp"],
            phase_hints=["descent"],
        )
    )
    db.flush()
    return media.id


def _seed_oracle_corpus(db: Session, *, viewer_id: UUID) -> UUID:
    """Seed the Oracle Corpus system library, owned by the reading's viewer.

    Single-line evocative passages so each anchor selector's quote resolves to a
    ready content chunk, and the deterministic test embedding (bag-of-words) ranks
    them for forest/lamp questions. Returns the corpus library id.
    """
    library_id = oracle_corpus.ensure_oracle_corpus_library(db, owner_user_id=viewer_id)
    for i in range(ORACLE_TEST_WORK_COUNT):
        _seed_corpus_work(
            db,
            viewer_id=viewer_id,
            library_id=library_id,
            work_key=f"w{i}",
            passage_text=(
                f"The forest lamp descends through shadow and ordeal toward dawn, passage {i}."
            ),
            display_order=(i + 1) * 10,
        )
    # At least one safe plate (no embeddings) under oracle/plates/. Unique source_url +
    # storage_key per seed so committed direct_db plates never collide on the UNIQUE
    # constraint with a later test's plate (savepoint tests roll their plate back).
    plate_token = uuid4().hex[:12]
    db.add(
        OraclePlate(
            source_repository="test",
            source_url=f"https://ex/p1-{plate_token}.jpg",
            artist="Engraver",
            work_title="Plate I",
            attribution_text="Engraver, Plate I.",
            width=800,
            height=1200,
            storage_key=f"oracle/plates/test-plate-{plate_token}.jpg",
            content_type="image/jpeg",
            byte_size=1000,
            tags=["forest", "lamp"],
        )
    )
    db.flush()
    resolution = oracle_corpus.resolve_oracle_passage_anchors(db)
    assert resolution.failed == 0, f"anchors failed to resolve: {resolution}"
    return library_id


def _register_oracle_corpus_cleanup(direct_db: DirectSessionManager, viewer_id: UUID) -> None:
    """Register FK-safe teardown for a viewer-owned corpus (LIFO).

    The corpus media (with its content index, anchors, source mappings) hang off the
    viewer's system library; the ``DirectSessionManager`` ``users``/``libraries``
    special-cases tear those down (incl. the corpus media) before the cascade.
    Plates are global owned assets, so the seed tags them ``source_repository='test'``
    and we delete those here. Double-registration is an idempotent no-op delete.
    """
    direct_db.register_cleanup("oracle_plates", "source_repository", "test")
    direct_db.register_cleanup("libraries", "owner_user_id", viewer_id)
    direct_db.register_cleanup("memberships", "user_id", viewer_id)


def _grant_platform_llm(db: Session, user_id: UUID) -> None:
    """execute_reading resolves keys via resolve_api_key(mode="auto"); platform-key
    use requires the ai_plus entitlement (chat parity). Upsert; commits."""
    grant_entitlement_override(
        db,
        user_id=user_id,
        plan_tier="ai_plus",
        platform_token_quota_mode="plan",
        platform_token_limit_monthly=None,
        transcription_quota_mode="plan",
        transcription_minutes_limit_monthly=None,
        expires_at=None,
        reason="oracle test access",
        actor_label="test",
    )


def _insert_pending_reading(
    db: Session,
    *,
    user_id: UUID,
    question: str,
    folio_number: int = 1,
) -> UUID:
    """One pending reading for a user entitled to run it (platform-LLM grant)."""
    _grant_platform_llm(db, user_id)
    reading = OracleReading(
        id=uuid4(),
        user_id=user_id,
        folio_number=folio_number,
        question_text=question,
        status="pending",
    )
    db.add(reading)
    db.commit()
    return reading.id


def _folio_edge_rows(db: Session, reading_id: UUID) -> list[dict[str, Any]]:
    """A reading's folio rows joined to their citation edges, in ordinal order.

    Schema-level exception (testing_standards §6): the folio<->edge pairing is
    the persistence contract under test and is not exposed verbatim by any API.
    """
    return [
        dict(row)
        for row in db.execute(
            text(
                """
                SELECT f.phase, f.source_kind, f.locator_label, f.attribution_text,
                       f.marginalia_text, e.kind, e.origin, e.ordinal, e.snapshot,
                       e.source_scheme, e.source_id, e.target_scheme, e.target_id
                FROM oracle_reading_folios f
                JOIN resource_edges e ON e.id = f.edge_id
                WHERE f.reading_id = :reading_id
                ORDER BY e.ordinal
                """
            ),
            {"reading_id": reading_id},
        ).mappings()
    ]


def _cited_targets(db: Session, reading_id: UUID, *, source_kind: str) -> set[tuple[str, UUID]]:
    """The reading's cited (target_scheme, target_id) identities for one source kind."""
    return {
        (str(row["target_scheme"]), row["target_id"])
        for row in _folio_edge_rows(db, reading_id)
        if row["source_kind"] == source_kind
    }


def _owner_chunk_target_ids(db: Session, owner_kind: str, owner_id: UUID) -> set[UUID]:
    """Expected §5.3 citation target ids for an owner's chunks (span, else chunk id)."""
    rows = (
        db.execute(
            text(
                """
                SELECT id, primary_evidence_span_id
                FROM content_chunks
                WHERE owner_kind = :owner_kind AND owner_id = :owner_id
                """
            ),
            {"owner_kind": owner_kind, "owner_id": owner_id},
        )
        .mappings()
        .all()
    )
    return {row["primary_evidence_span_id"] or row["id"] for row in rows}


def _candidate_indices(request) -> dict[int, str]:
    # The candidates turn is the first user turn (index 1) in both the original
    # request and the repair-round request (repair appends turns after it).
    user_message = request.messages[1].content
    return {
        int(match.group(1)): match.group(2)
        for match in re.finditer(r"^\[(\d+)] source_kind=([a-z_]+)", user_message, re.MULTILINE)
    }


def _candidate_text(request, index: int) -> str:
    user_message = request.messages[1].content
    pattern = rf"^\[{index}] source_kind=.*?^passage_text: (.*?)(?:\n\n\[|\n\nQUESTION:)"
    match = re.search(pattern, user_message, re.MULTILINE | re.DOTALL)
    assert match is not None, f"expected candidate {index} text in prompt: {user_message}"
    return match.group(1).strip()


def _reading_json(
    *,
    descent: int,
    ordeal: int,
    ascent: int,
    omens: list[object] | None = None,
    folio_motto: str = "Audentes Fortuna Iuvat",
    folio_motto_gloss: str | None = "Fortune favors the bold.",
    folio_theme: str = "Of Courage",
) -> str:
    return json.dumps(
        {
            "argument": (
                "Of the lamp kept burning through the closed forest, and the road "
                "that answers after dread."
            ),
            "folio_motto": folio_motto,
            "folio_motto_gloss": folio_motto_gloss,
            "folio_theme": folio_theme,
            "passages": [
                {
                    "phase": "descent",
                    "candidate_index": descent,
                    "marginalia": "The descent gathers the question into shadow.",
                },
                {
                    "phase": "ordeal",
                    "candidate_index": ordeal,
                    "marginalia": "The ordeal holds the image at its threshold.",
                },
                {
                    "phase": "ascent",
                    "candidate_index": ascent,
                    "marginalia": "The ascent opens the image toward morning.",
                },
            ],
            "interpretation": "I saw a road bending into shadow, and the lamp's small flame thrown forward.",
            "omens": omens
            if omens is not None
            else ["a lamp in rain", "a door unlatched", "dawn under branches"],
        }
    )


class _SelectLibraryRouter:
    def __init__(self) -> None:
        self.indices: dict[int, str] = {}

    async def generate(self, request, *, key, timeout_s):
        self.indices = _candidate_indices(request)
        user_indices = [
            idx for idx, source_kind in self.indices.items() if source_kind == "user_media"
        ]
        public_indices = [
            idx for idx, source_kind in self.indices.items() if source_kind == "public_domain"
        ]
        assert user_indices, "expected at least one indexed user-library candidate"
        assert len(public_indices) >= 2, f"expected two public candidates, got {self.indices}"
        return ModelResponse(
            text=_reading_json(
                descent=public_indices[0],
                ordeal=user_indices[0],
                ascent=public_indices[1],
            ),
            usage=None,
            provider_request_id=None,
            status=None,
            incomplete_details=None,
        )


class _UnexpectedRouter:
    def __init__(self) -> None:
        self.called = False

    async def generate(self, request, *, key, timeout_s):
        self.called = True
        return ModelResponse(
            text=_reading_json(descent=0, ordeal=1, ascent=2),
            usage=None,
            provider_request_id=None,
            status=None,
            incomplete_details=None,
        )


class _RecordingRateLimiter:
    def __init__(self) -> None:
        self.events: list[tuple[str, UUID | None, UUID | None, int | None]] = []

    def check_rpm_limit(self, user_id: UUID) -> None:
        self.events.append(("check_rpm", user_id, None, None))

    def check_concurrent_limit(self, user_id: UUID) -> None:
        self.events.append(("check_concurrent", user_id, None, None))

    def check_token_budget(self, user_id: UUID) -> None:
        self.events.append(("check_token_budget", user_id, None, None))

    def acquire_inflight_slot(self, user_id: UUID) -> None:
        self.events.append(("acquire_inflight", user_id, None, None))

    def release_inflight_slot(self, user_id: UUID) -> None:
        self.events.append(("release_inflight", user_id, None, None))

    def reserve_token_budget(
        self,
        user_id: UUID,
        reservation_id: UUID,
        est_tokens: int,
        ttl: int = 300,
    ) -> None:
        self.events.append(("reserve_token_budget", user_id, reservation_id, est_tokens))

    def commit_token_budget(
        self,
        user_id: UUID,
        reservation_id: UUID,
        actual_tokens: int,
    ) -> None:
        self.events.append(("commit_token_budget", user_id, reservation_id, actual_tokens))

    def release_token_budget(self, user_id: UUID, reservation_id: UUID) -> None:
        self.events.append(("release_token_budget", user_id, reservation_id, None))

    def event_names(self) -> list[str]:
        return [event[0] for event in self.events]


@pytest.fixture(autouse=True)
def oracle_rate_limiter(monkeypatch) -> _RecordingRateLimiter:
    limiter = _RecordingRateLimiter()
    monkeypatch.setattr("nexus.services.oracle.get_rate_limiter", lambda: limiter)
    return limiter


class _ObservingRouter:
    def __init__(self, direct_db: DirectSessionManager, reading_id: UUID) -> None:
        self.direct_db = direct_db
        self.reading_id = reading_id
        self.events_seen_during_generate: list[str] = []
        self.image_id_seen_during_generate: UUID | None = None

    async def generate(self, request, *, key, timeout_s):
        with self.direct_db.session() as observer:
            self.events_seen_during_generate = list(
                observer.execute(
                    text(
                        """
                        SELECT event_type
                        FROM oracle_reading_events
                        WHERE reading_id = :reading_id
                        ORDER BY seq
                        """
                    ),
                    {"reading_id": self.reading_id},
                ).scalars()
            )
            self.image_id_seen_during_generate = observer.execute(
                text(
                    """
                    SELECT image_id
                    FROM oracle_readings
                    WHERE id = :reading_id
                    """
                ),
                {"reading_id": self.reading_id},
            ).scalar_one()
        indices = _candidate_indices(request)
        public_indices = [
            idx for idx, source_kind in indices.items() if source_kind == "public_domain"
        ]
        assert len(public_indices) >= 3, f"expected three public candidates, got {indices}"
        return ModelResponse(
            text=_reading_json(
                descent=public_indices[0],
                ordeal=public_indices[1],
                ascent=public_indices[2],
            ),
            usage=None,
            provider_request_id=None,
            status=None,
            incomplete_details=None,
        )


class _PublicOnlyRouter:
    async def generate(self, request, *, key, timeout_s):
        indices = _candidate_indices(request)
        public_indices = [
            idx for idx, source_kind in indices.items() if source_kind == "public_domain"
        ]
        assert len(public_indices) >= 3, f"expected three public candidates, got {indices}"
        return ModelResponse(
            text=_reading_json(
                descent=public_indices[0],
                ordeal=public_indices[1],
                ascent=public_indices[2],
            ),
            usage=None,
            provider_request_id=None,
            status=None,
            incomplete_details=None,
        )


class _ProviderErrorRouter:
    def __init__(self, error_code: ModelCallErrorCode = ModelCallErrorCode.BAD_REQUEST) -> None:
        self.error_code = error_code

    async def generate(self, request, *, key, timeout_s):
        raise ModelCallError(
            self.error_code,
            "raw anthropic invalid_request_error provider detail",
            provider="anthropic",
        )


class _InvalidOmensRouter:
    def __init__(self, omens: list[object]) -> None:
        self.omens = omens

    async def generate(self, request, *, key, timeout_s):
        indices = _candidate_indices(request)
        public_indices = [
            idx for idx, source_kind in indices.items() if source_kind == "public_domain"
        ]
        assert len(public_indices) >= 3, f"expected three public candidates, got {indices}"
        return ModelResponse(
            text=_reading_json(
                descent=public_indices[0],
                ordeal=public_indices[1],
                ascent=public_indices[2],
                omens=self.omens,
            ),
            usage=None,
            provider_request_id=None,
            status=None,
            incomplete_details=None,
        )


class _InvalidCitationOutputRouter:
    def __init__(self, *, interpretation: str | None = None, marginalia: str | None = None) -> None:
        self.interpretation = interpretation
        self.marginalia = marginalia

    async def generate(self, request, *, key, timeout_s):
        indices = _candidate_indices(request)
        public_indices = [
            idx for idx, source_kind in indices.items() if source_kind == "public_domain"
        ]
        assert len(public_indices) >= 3, f"expected three public candidates, got {indices}"
        payload = json.loads(
            _reading_json(
                descent=public_indices[0],
                ordeal=public_indices[1],
                ascent=public_indices[2],
            )
        )
        if self.interpretation is not None:
            payload["interpretation"] = (
                _candidate_text(request, public_indices[0])
                if self.interpretation == "__FIRST_PASSAGE_TEXT__"
                else self.interpretation
            )
        if self.marginalia is not None:
            payload["passages"][0]["marginalia"] = self.marginalia
        return ModelResponse(
            text=json.dumps(payload),
            usage=None,
            provider_request_id=None,
            status=None,
            incomplete_details=None,
        )


class _InvalidJsonShapeRouter:
    def __init__(self, variant: str) -> None:
        self.variant = variant

    async def generate(self, request, *, key, timeout_s):
        indices = _candidate_indices(request)
        public_indices = [
            idx for idx, source_kind in indices.items() if source_kind == "public_domain"
        ]
        assert len(public_indices) >= 3, f"expected three public candidates, got {indices}"
        payload = json.loads(
            _reading_json(
                descent=public_indices[0],
                ordeal=public_indices[1],
                ascent=public_indices[2],
            )
        )
        if self.variant == "fenced":
            text_value = f"```json\n{json.dumps(payload)}\n```"
        elif self.variant == "extra_root_key":
            payload["citation"] = "Inferno I.1"
            text_value = json.dumps(payload)
        elif self.variant == "extra_passage_key":
            payload["passages"][0]["quote"] = _candidate_text(request, public_indices[0])
            text_value = json.dumps(payload)
        elif self.variant == "short_argument":
            payload["argument"] = "Of the lamp."
            text_value = json.dumps(payload)
        elif self.variant == "bad_theme":
            payload["folio_theme"] = "Of Mischief"
            text_value = json.dumps(payload)
        else:
            raise AssertionError(f"unknown invalid JSON shape variant: {self.variant}")
        return ModelResponse(
            text=text_value,
            usage=None,
            provider_request_id=None,
            status=None,
            incomplete_details=None,
        )


class _SemanticRepairRouter:
    """First response violates oracle semantics (four omens); the repaired
    second attempt is valid. Captures both requests; reports summable usage."""

    def __init__(self) -> None:
        self.requests: list = []

    async def generate(self, request, *, key, timeout_s):
        self.requests.append(request)
        indices = _candidate_indices(request)
        public_indices = [
            idx for idx, source_kind in indices.items() if source_kind == "public_domain"
        ]
        assert len(public_indices) >= 3, f"expected three public candidates, got {indices}"
        omens = (
            ["a lamp in rain", "a door unlatched", "dawn under branches", "a fourth sign"]
            if len(self.requests) == 1
            else None
        )
        return ModelResponse(
            text=_reading_json(
                descent=public_indices[0],
                ordeal=public_indices[1],
                ascent=public_indices[2],
                omens=omens,
            ),
            usage=TokenUsage(input_tokens=10, output_tokens=5, total_tokens=15),
            provider_request_id=None,
            status=None,
            incomplete_details=None,
        )


def test_create_reading_accepts_when_corpus_library_is_seeded(
    db_session: Session,
    oracle_schema,
    monkeypatch,
) -> None:
    """create_reading admits-and-enqueues against a real seeded corpus library
    (worker-time readiness is checked in execute_reading, not here)."""
    user_id = uuid4()
    db_session.execute(text("INSERT INTO users (id) VALUES (:user_id)"), {"user_id": user_id})
    _seed_oracle_corpus(db_session, viewer_id=user_id)
    monkeypatch.setattr("nexus.services.oracle.enqueue_job", lambda *args, **kwargs: None)

    reading = create_reading(
        db_session,
        viewer_id=user_id,
        question="Where does the path open?",
    )

    assert reading.status == "pending"
    assert not hasattr(reading, "corpus_set_version_id")


def test_oracle_corpus_readiness_derives_from_library_media_index_anchor_plate(
    db_session: Session,
    oracle_schema,
) -> None:
    """AC-B1: readiness is computed from the live library/media/index/anchor/plate
    state — ready when every required work has a ready index and resolved anchor and
    at least one plate exists; flips to not_ready when any leg fails."""
    user_id = uuid4()
    db_session.execute(text("INSERT INTO users (id) VALUES (:user_id)"), {"user_id": user_id})
    library_id = _seed_oracle_corpus(db_session, viewer_id=user_id)

    ready = oracle_corpus.get_oracle_corpus_readiness(db_session)
    assert ready.status == "ready"
    assert ready.library_id == library_id
    assert ready.work_count == ORACLE_TEST_WORK_COUNT
    assert ready.ready_media_count == ORACLE_TEST_WORK_COUNT
    assert ready.anchor_count == ORACLE_TEST_WORK_COUNT
    assert ready.resolved_anchor_count == ORACLE_TEST_WORK_COUNT
    assert ready.plate_count >= 1
    assert ready.ready_plate_count == ready.plate_count

    db_session.execute(
        text(
            """
            UPDATE content_index_states
            SET active_embedding_provider = 'stale-provider'
            WHERE owner_kind = 'media'
              AND owner_id = (
                SELECT media_id
                FROM oracle_corpus_sources
                WHERE corpus_key = 'oracle'
                ORDER BY display_order ASC
                LIMIT 1
              )
            """
        )
    )
    db_session.flush()
    provider_mismatch = oracle_corpus.get_oracle_corpus_readiness(db_session)
    assert provider_mismatch.status == "not_ready"
    assert provider_mismatch.ready_media_count == ORACLE_TEST_WORK_COUNT - 1
    assert provider_mismatch.resolved_anchor_count == ORACLE_TEST_WORK_COUNT - 1
    db_session.execute(
        text(
            """
            UPDATE content_index_states
            SET active_embedding_provider = :provider
            WHERE owner_kind = 'media'
              AND active_embedding_model = :model
            """
        ),
        {
            "provider": current_transcript_embedding_provider(),
            "model": current_transcript_embedding_model(),
        },
    )
    db_session.flush()

    # A stale evidence-span pointer must fail readiness even if the chunk pointer remains valid,
    # because activation prefers the evidence span when present.
    db_session.execute(
        text(
            """
            UPDATE oracle_passage_anchors
            SET current_evidence_span_id = :missing_span_id
            WHERE id = (
                SELECT id FROM oracle_passage_anchors ORDER BY created_at ASC, id ASC LIMIT 1
            )
            """
        ),
        {"missing_span_id": uuid4()},
    )
    db_session.flush()
    stale_anchor = oracle_corpus.get_oracle_corpus_readiness(db_session)
    assert stale_anchor.status == "not_ready"
    assert stale_anchor.resolved_anchor_count == ORACLE_TEST_WORK_COUNT - 1

    resolution = oracle_corpus.resolve_oracle_passage_anchors(db_session)
    assert resolution.failed == 0

    # Dropping every plate is enough to make the corpus not ready.
    db_session.execute(text("DELETE FROM oracle_plates"))
    db_session.flush()
    not_ready = oracle_corpus.get_oracle_corpus_readiness(db_session)
    assert not_ready.status == "not_ready"
    assert not_ready.plate_count == 0
    assert not_ready.ready_plate_count == 0


def test_search_scoped_to_oracle_corpus_library_returns_corpus_chunks(
    db_session: Session,
    oracle_schema,
) -> None:
    """AC-G7/AC-B7: the Oracle Corpus is searchable through normal library scope."""
    user_id = uuid4()
    db_session.execute(text("INSERT INTO users (id) VALUES (:user_id)"), {"user_id": user_id})
    library_id = _seed_oracle_corpus(db_session, viewer_id=user_id)

    response = run_search(
        db_session,
        user_id,
        SearchQuery(
            text="forest lamp",
            requested_kinds=frozenset({"documents"}),
            scope=SearchScope(kind="library", id=library_id),
            limit=20,
        ),
    )

    corpus_media_ids = set(db_session.execute(select(OracleCorpusSource.media_id)).scalars())
    chunk_results = [row for row in response.results if row.type == "content_chunk"]
    assert chunk_results, (
        "library-scoped search should return content_chunk rows from Oracle Corpus media"
    )
    assert any(row.source.media_id in corpus_media_ids for row in chunk_results)
    assert all(row.source.media_id in corpus_media_ids for row in chunk_results)


def test_resolve_oracle_passage_anchors_normalizes_quote_formatting(
    db_session: Session,
    oracle_schema,
) -> None:
    user_id = uuid4()
    work_key = f"normalized-anchor-{uuid4().hex[:8]}"
    db_session.execute(text("INSERT INTO users (id) VALUES (:user_id)"), {"user_id": user_id})
    library_id = oracle_corpus.ensure_oracle_corpus_library(db_session, owner_user_id=user_id)
    _seed_corpus_work(
        db_session,
        viewer_id=user_id,
        library_id=library_id,
        work_key=work_key,
        passage_text=(
            "Tyger Tyger burning bright In the forests of the night "
            "What immortal hand or eye Could frame thy fearful symmetry"
        ),
        display_order=10,
    )
    anchor = db_session.execute(
        select(OraclePassageAnchor)
        .join(OracleCorpusSource, OracleCorpusSource.id == OraclePassageAnchor.corpus_source_id)
        .where(OracleCorpusSource.work_key == work_key)
    ).scalar_one()
    anchor.selector = {
        "kind": "text_quote",
        "exact": (
            "Tyger Tyger, burning bright,\n"
            "In the forests of the night;\n"
            "What immortal hand or eye,\n"
            "Could frame thy fearful symmetry?"
        ),
    }
    db_session.flush()

    resolution = oracle_corpus.resolve_oracle_passage_anchors(db_session)

    assert resolution.failed == 0
    assert anchor.resolution_status == "resolved"
    assert anchor.current_content_chunk_id is not None


def test_resolve_oracle_passage_anchors_allows_small_source_token_variants(
    db_session: Session,
    oracle_schema,
) -> None:
    user_id = uuid4()
    work_key = f"token-variant-anchor-{uuid4().hex[:8]}"
    db_session.execute(text("INSERT INTO users (id) VALUES (:user_id)"), {"user_id": user_id})
    library_id = oracle_corpus.ensure_oracle_corpus_library(db_session, owner_user_id=user_id)
    _seed_corpus_work(
        db_session,
        viewer_id=user_id,
        library_id=library_id,
        work_key=work_key,
        passage_text=(
            "Tiger Tiger burning bright In the forests of the night "
            "What immortal hand or eye Could frame thy fearful symmetry"
        ),
        display_order=10,
    )
    anchor = db_session.execute(
        select(OraclePassageAnchor)
        .join(OracleCorpusSource, OracleCorpusSource.id == OraclePassageAnchor.corpus_source_id)
        .where(OracleCorpusSource.work_key == work_key)
    ).scalar_one()
    anchor.selector = {
        "kind": "text_quote",
        "exact": (
            "Tyger Tyger, burning bright,\n"
            "In the forests of the night;\n"
            "What immortal hand or eye,\n"
            "Could frame thy fearful symmetry?"
        ),
    }
    db_session.flush()

    resolution = oracle_corpus.resolve_oracle_passage_anchors(db_session)

    assert resolution.failed == 0
    assert anchor.resolution_status == "resolved"
    assert anchor.current_content_chunk_id is not None


def test_resolve_oracle_passage_anchors_allows_line_numbered_source_chunks(
    db_session: Session,
    oracle_schema,
) -> None:
    user_id = uuid4()
    work_key = f"line-numbered-anchor-{uuid4().hex[:8]}"
    db_session.execute(text("INSERT INTO users (id) VALUES (:user_id)"), {"user_id": user_id})
    library_id = oracle_corpus.ensure_oracle_corpus_library(db_session, owner_user_id=user_id)
    _seed_corpus_work(
        db_session,
        viewer_id=user_id,
        library_id=library_id,
        work_key=work_key,
        passage_text=(
            "And on the pedestal these words appear:[1] "
            "'My name is Ozymandias, king of kings: 10 "
            "Look on my works, ye Mighty, and despair!'"
        ),
        display_order=10,
    )
    anchor = db_session.execute(
        select(OraclePassageAnchor)
        .join(OracleCorpusSource, OracleCorpusSource.id == OraclePassageAnchor.corpus_source_id)
        .where(OracleCorpusSource.work_key == work_key)
    ).scalar_one()
    anchor.selector = {
        "kind": "text_quote",
        "exact": (
            "And on the pedestal, these words appear:\n"
            "My name is Ozymandias, King of Kings;\n"
            "Look on my Works, ye Mighty, and despair!"
        ),
    }
    db_session.flush()

    resolution = oracle_corpus.resolve_oracle_passage_anchors(db_session)

    assert resolution.failed == 0
    assert anchor.resolution_status == "resolved"
    assert anchor.current_content_chunk_id is not None


def test_resolve_oracle_passage_anchors_allows_edition_word_insertions(
    db_session: Session,
    oracle_schema,
) -> None:
    user_id = uuid4()
    work_key = f"edition-insertion-anchor-{uuid4().hex[:8]}"
    db_session.execute(text("INSERT INTO users (id) VALUES (:user_id)"), {"user_id": user_id})
    library_id = oracle_corpus.ensure_oracle_corpus_library(db_session, owner_user_id=user_id)
    _seed_corpus_work(
        db_session,
        viewer_id=user_id,
        library_id=library_id,
        work_key=work_key,
        passage_text=(
            "There's a certain slant of light, On winter afternoons, "
            "That oppresses, like the weight Of cathedral tunes."
        ),
        display_order=10,
    )
    anchor = db_session.execute(
        select(OraclePassageAnchor)
        .join(OracleCorpusSource, OracleCorpusSource.id == OraclePassageAnchor.corpus_source_id)
        .where(OracleCorpusSource.work_key == work_key)
    ).scalar_one()
    anchor.selector = {
        "kind": "text_quote",
        "exact": (
            "There's a certain Slant of light,\n"
            "Winter Afternoons-\n"
            "That oppresses, like the Heft\n"
            "Of Cathedral Tunes-"
        ),
    }
    db_session.flush()

    resolution = oracle_corpus.resolve_oracle_passage_anchors(db_session)

    assert resolution.failed == 0
    assert anchor.resolution_status == "resolved"
    assert anchor.current_content_chunk_id is not None


def test_resolve_oracle_passage_anchors_rejects_title_only_chunk(
    db_session: Session,
    oracle_schema,
) -> None:
    user_id = uuid4()
    work_key = f"title-only-anchor-{uuid4().hex[:8]}"
    db_session.execute(text("INSERT INTO users (id) VALUES (:user_id)"), {"user_id": user_id})
    library_id = oracle_corpus.ensure_oracle_corpus_library(db_session, owner_user_id=user_id)
    _seed_corpus_work(
        db_session,
        viewer_id=user_id,
        library_id=library_id,
        work_key=work_key,
        passage_text="Because I could not stop for Death",
        display_order=10,
    )
    anchor = db_session.execute(
        select(OraclePassageAnchor)
        .join(OracleCorpusSource, OracleCorpusSource.id == OraclePassageAnchor.corpus_source_id)
        .where(OracleCorpusSource.work_key == work_key)
    ).scalar_one()
    anchor.selector = {
        "kind": "text_quote",
        "exact": (
            "Because I could not stop for Death--\n"
            "He kindly stopped for me--\n"
            "The Carriage held but just Ourselves--\n"
            "And Immortality."
        ),
    }
    db_session.flush()

    resolution = oracle_corpus.resolve_oracle_passage_anchors(db_session)

    assert resolution.failed == 1
    assert anchor.resolution_status == "failed"
    assert anchor.current_content_chunk_id is None


def test_ensure_oracle_corpus_media_uses_system_ingest_without_default_membership(
    direct_db: DirectSessionManager,
    oracle_schema,
) -> None:
    user_id = uuid4()
    with direct_db.session() as db:
        ensure_user_and_default_library(db, user_id)
        library_id = oracle_corpus.ensure_oracle_corpus_library(db, owner_user_id=user_id)
        work = oracle_corpus.OracleCorpusManifestWork(
            work_key=f"system-ingest-{uuid4().hex[:8]}",
            title="System Ingest Work",
            author_text="A. Scribe",
            source_repository="test",
            source_url="https://example.org/system-ingest",
            source_download_url=f"https://example.org/system-ingest-{uuid4().hex[:8]}.epub",
            source_media_kind="epub",
            display_order=10,
            passage_anchors=[],
        )
        result = oracle_corpus.ensure_oracle_corpus_media(
            db,
            owner_user_id=user_id,
            library_id=library_id,
            work=work,
        )
        rerun = oracle_corpus.ensure_oracle_corpus_media(
            db,
            owner_user_id=user_id,
            library_id=library_id,
            work=work,
        )
        db.commit()
        assert rerun.media_id == result.media_id
        assert rerun.created_media is False

        default_library_id = library_governance.default_library_id_for_user(db, user_id)
        corpus_entry = db.execute(
            text(
                """
                SELECT 1
                FROM library_entries
                WHERE library_id = :library_id AND media_id = :media_id
                """
            ),
            {"library_id": library_id, "media_id": result.media_id},
        ).first()
        default_entry = db.execute(
            text(
                """
                SELECT 1
                FROM library_entries
                WHERE library_id = :library_id AND media_id = :media_id
                """
            ),
            {"library_id": default_library_id, "media_id": result.media_id},
        ).first()
        default_intrinsic = db.execute(
            text(
                """
                SELECT 1
                FROM default_library_intrinsics
                WHERE default_library_id = :library_id AND media_id = :media_id
                """
            ),
            {"library_id": default_library_id, "media_id": result.media_id},
        ).first()
        source_payload = db.execute(
            text(
                """
                SELECT source_payload
                FROM media_source_attempts
                WHERE media_id = :media_id
                ORDER BY attempt_no ASC
                LIMIT 1
                """
            ),
            {"media_id": result.media_id},
        ).scalar_one()
        job_ids = [
            row[0]
            for row in db.execute(
                text(
                    """
                    SELECT job_id
                    FROM media_source_attempts
                    WHERE media_id = :media_id AND job_id IS NOT NULL
                    """
                ),
                {"media_id": result.media_id},
            ).fetchall()
        ]

    for job_id in job_ids:
        direct_db.register_cleanup("background_jobs", "id", job_id)
    _register_oracle_corpus_cleanup(direct_db, user_id)
    direct_db.register_cleanup("users", "id", user_id)

    assert corpus_entry is not None
    assert default_entry is None
    assert default_intrinsic is None
    assert source_payload["system_source"] == oracle_corpus.ORACLE_CORPUS_SYSTEM_KEY
    assert "library_ids" not in source_payload


def test_ensure_oracle_corpus_media_repairs_failed_reused_system_media(
    direct_db: DirectSessionManager,
    oracle_schema,
) -> None:
    user_id = uuid4()
    media_id = uuid4()
    work_key = f"repair-reused-{uuid4().hex[:8]}"
    source_download_url = f"https://example.org/{work_key}"
    with direct_db.session() as db:
        ensure_user_and_default_library(db, user_id)
        library_id = oracle_corpus.ensure_oracle_corpus_library(db, owner_user_id=user_id)
        db.execute(
            text(
                """
                INSERT INTO media (
                    id, kind, title, processing_status, failure_stage, last_error_code,
                    last_error_message, requested_url, canonical_source_url, created_by_user_id
                )
                VALUES (
                    :media_id, 'web_article', 'Failed Oracle work', 'failed', 'extract',
                    'E_INGEST_FAILED', 'Node ingest script not found',
                    :url, :url, :user_id
                )
                """
            ),
            {"media_id": media_id, "url": source_download_url, "user_id": user_id},
        )
        db.execute(
            text(
                """
                INSERT INTO media_source_attempts (
                    media_id, created_by_user_id, source_type, attempt_no, status,
                    intent_key, requested_url, canonical_source_url, source_payload,
                    error_code, error_message, finished_at
                )
                VALUES (
                    :media_id, :user_id, 'generic_web_url', 1, 'failed',
                    :intent_key, :url, :url, '{}'::jsonb,
                    'E_INGEST_FAILED', 'Node ingest script not found', now()
                )
                """
            ),
            {
                "media_id": media_id,
                "user_id": user_id,
                "intent_key": f"test:oracle-repair:{media_id}",
                "url": source_download_url,
            },
        )
        db.add(
            OracleCorpusSource(
                corpus_key=oracle_corpus.ORACLE_CORPUS_KEY,
                work_key=work_key,
                library_id=library_id,
                media_id=media_id,
                title="Failed Oracle work",
                author_text="A. Scribe",
                source_repository="test",
                source_url=source_download_url,
                source_download_url=source_download_url,
                source_media_kind="web_article",
                display_order=20,
            )
        )
        db.commit()

        result = oracle_corpus.ensure_oracle_corpus_media(
            db,
            owner_user_id=user_id,
            library_id=library_id,
            work=oracle_corpus.OracleCorpusManifestWork(
                work_key=work_key,
                title="Failed Oracle work",
                author_text="A. Scribe",
                source_repository="test",
                source_url=source_download_url,
                source_download_url=source_download_url,
                source_media_kind="web_article",
                display_order=20,
                passage_anchors=[],
            ),
        )
        db.commit()

        attempt_rows = db.execute(
            text(
                """
                SELECT attempt_no, status, source_payload->>'system_repair_reason'
                FROM media_source_attempts
                WHERE media_id = :media_id
                ORDER BY attempt_no ASC
                """
            ),
            {"media_id": media_id},
        ).fetchall()
        queued_job_id = db.execute(
            text(
                """
                SELECT id
                FROM background_jobs
                WHERE kind = 'ingest_media_source'
                  AND payload->>'media_id' = :media_id
                """
            ),
            {"media_id": str(media_id)},
        ).scalar_one()
        media_status = db.execute(
            text("SELECT processing_status FROM media WHERE id = :media_id"),
            {"media_id": media_id},
        ).scalar_one()

    direct_db.register_cleanup("background_jobs", "id", queued_job_id)
    _register_oracle_corpus_cleanup(direct_db, user_id)
    direct_db.register_cleanup("users", "id", user_id)

    assert result.media_id == media_id
    assert result.created_media is False
    assert attempt_rows == [
        (1, "failed", None),
        (2, "queued", "oracle_corpus_seed"),
    ]
    assert media_status == "extracting"


def test_ensure_oracle_corpus_media_replaces_changed_source_media(
    direct_db: DirectSessionManager,
    oracle_schema,
) -> None:
    user_id = uuid4()
    old_media_id = uuid4()
    work_key = f"replace-source-{uuid4().hex[:8]}"
    old_url = f"https://example.org/{work_key}-old.epub"
    new_url = f"https://example.org/{work_key}-new.epub"
    with direct_db.session() as db:
        ensure_user_and_default_library(db, user_id)
        library_id = oracle_corpus.ensure_oracle_corpus_library(db, owner_user_id=user_id)
        db.execute(
            text(
                """
                INSERT INTO media (
                    id, kind, title, processing_status, requested_url,
                    canonical_source_url, created_by_user_id
                )
                VALUES (
                    :media_id, 'epub', 'Old Oracle work', 'failed',
                    :old_url, :old_url, :user_id
                )
                """
            ),
            {"media_id": old_media_id, "old_url": old_url, "user_id": user_id},
        )
        library_entries.ensure_entry(db, library_id, library_entries.media_target(old_media_id))
        db.add(
            OracleCorpusSource(
                corpus_key=oracle_corpus.ORACLE_CORPUS_KEY,
                work_key=work_key,
                library_id=library_id,
                media_id=old_media_id,
                title="Old Oracle work",
                author_text="A. Scribe",
                source_repository="test",
                source_url=old_url,
                source_download_url=old_url,
                source_media_kind="epub",
                display_order=30,
            )
        )
        db.commit()

        result = oracle_corpus.ensure_oracle_corpus_media(
            db,
            owner_user_id=user_id,
            library_id=library_id,
            work=oracle_corpus.OracleCorpusManifestWork(
                work_key=work_key,
                title="New Oracle work",
                author_text="A. Scribe",
                source_repository="test",
                source_url=new_url,
                source_download_url=new_url,
                source_media_kind="epub",
                display_order=30,
                passage_anchors=[],
            ),
        )
        db.commit()

        source = db.execute(
            select(OracleCorpusSource).where(OracleCorpusSource.work_key == work_key)
        ).scalar_one()
        source_media_id = source.media_id
        source_download_url = source.source_download_url
        entry_media_ids = [
            UUID(str(media_id))
            for media_id in db.execute(
                text(
                    """
                    SELECT media_id
                    FROM library_entries
                    WHERE library_id = :library_id
                    ORDER BY position ASC
                    """
                ),
                {"library_id": library_id},
            )
            .scalars()
            .all()
        ]
        attempt_row = db.execute(
            text(
                """
                SELECT idempotency_key, source_payload->>'system_source'
                FROM media_source_attempts
                WHERE media_id = :media_id
                ORDER BY attempt_no ASC
                LIMIT 1
                """
            ),
            {"media_id": result.media_id},
        ).one()
        queued_job_id = db.execute(
            text(
                """
                SELECT id
                FROM background_jobs
                WHERE kind = 'ingest_media_source'
                  AND payload->>'media_id' = :media_id
                LIMIT 1
                """
            ),
            {"media_id": str(result.media_id)},
        ).scalar_one()

    direct_db.register_cleanup("background_jobs", "id", queued_job_id)
    _register_oracle_corpus_cleanup(direct_db, user_id)
    direct_db.register_cleanup("users", "id", user_id)

    assert result.created_media is True
    assert result.media_id != old_media_id
    assert source_media_id == result.media_id
    assert source_download_url == new_url
    assert entry_media_ids == [result.media_id]
    assert old_media_id not in entry_media_ids
    assert attempt_row[0].startswith(f"oracle-corpus-{oracle_corpus.ORACLE_CORPUS_KEY}-{work_key}-")
    assert attempt_row[1] == oracle_corpus.ORACLE_CORPUS_SYSTEM_KEY


def test_create_reading_checks_llm_limits_before_enqueue(
    db_session: Session,
    oracle_schema,
    monkeypatch,
    oracle_rate_limiter: _RecordingRateLimiter,
) -> None:
    user_id = uuid4()
    db_session.execute(text("INSERT INTO users (id) VALUES (:user_id)"), {"user_id": user_id})
    _seed_oracle_corpus(db_session, viewer_id=user_id)

    def record_enqueue(*args, **kwargs):
        oracle_rate_limiter.events.append(("enqueue", None, None, None))

    monkeypatch.setattr("nexus.services.oracle.enqueue_job", record_enqueue)

    create_reading(
        db_session,
        viewer_id=user_id,
        question="Where does the path open?",
    )

    assert oracle_rate_limiter.event_names()[:4] == [
        "check_rpm",
        "check_concurrent",
        "check_token_budget",
        "enqueue",
    ]


def test_create_reading_allocates_unique_folios_under_concurrent_requests(
    direct_db: DirectSessionManager,
    oracle_schema,
    monkeypatch,
) -> None:
    user_id = uuid4()
    with direct_db.session() as db:
        db.execute(text("INSERT INTO users (id) VALUES (:user_id)"), {"user_id": user_id})
        _seed_oracle_corpus(db, viewer_id=user_id)
        db.commit()

    direct_db.register_cleanup("users", "id", user_id)
    _register_oracle_corpus_cleanup(direct_db, user_id)
    direct_db.register_cleanup("oracle_readings", "user_id", user_id)
    monkeypatch.setattr("nexus.services.oracle.enqueue_job", lambda *args, **kwargs: None)

    def create_one(index: int) -> int:
        with direct_db.session() as db:
            reading = create_reading(
                db,
                viewer_id=user_id,
                question=f"Where does the test lamp lead {index}?",
            )
            return reading.folio_number

    with ThreadPoolExecutor(max_workers=6) as pool:
        folios = list(pool.map(create_one, range(6)))

    assert sorted(folios) == [1, 2, 3, 4, 5, 6], (
        f"expected concurrent folios to be unique and sequential, got {folios}"
    )


def test_post_oracle_reading_returns_reading_ref_without_stream_block(
    auth_client,
    direct_db: DirectSessionManager,
    oracle_schema,
    monkeypatch,
) -> None:
    """The dead create-response ``stream`` block is gone; clients stream via
    the generic /stream-tokens flow."""
    user_id = uuid4()
    with direct_db.session() as db:
        db.execute(text("INSERT INTO users (id) VALUES (:user_id)"), {"user_id": user_id})
        _seed_oracle_corpus(db, viewer_id=user_id)
        db.commit()

    direct_db.register_cleanup("users", "id", user_id)
    _register_oracle_corpus_cleanup(direct_db, user_id)
    direct_db.register_cleanup("oracle_readings", "user_id", user_id)
    monkeypatch.setattr("nexus.services.oracle.enqueue_job", lambda *args, **kwargs: None)

    response = auth_client.post(
        "/oracle/readings",
        json={"question": "Where does the path open?"},
        headers=auth_headers(user_id),
    )

    assert response.status_code == 200, response.text
    data = response.json()["data"]
    assert set(data) == {"reading_id", "folio_number", "status"}
    assert data["status"] == "pending"
    assert data["folio_number"] == 1


def test_post_oracle_reading_replays_idempotency_key(
    auth_client,
    direct_db: DirectSessionManager,
    oracle_schema,
    monkeypatch,
) -> None:
    """Two POSTs with the same Idempotency-Key return the same reading and
    enqueue exactly one job (LI replay semantics); a different key mints a
    fresh folio."""
    user_id = uuid4()
    with direct_db.session() as db:
        db.execute(text("INSERT INTO users (id) VALUES (:user_id)"), {"user_id": user_id})
        _seed_oracle_corpus(db, viewer_id=user_id)
        db.commit()

    direct_db.register_cleanup("users", "id", user_id)
    _register_oracle_corpus_cleanup(direct_db, user_id)
    direct_db.register_cleanup("oracle_readings", "user_id", user_id)
    enqueued: list[dict] = []
    monkeypatch.setattr(
        "nexus.services.oracle.enqueue_job",
        lambda _db, **kwargs: enqueued.append(kwargs),
    )

    def post(key: str):
        return auth_client.post(
            "/oracle/readings",
            json={"question": "Where does the path open?"},
            headers={**auth_headers(user_id), "Idempotency-Key": key},
        )

    first = post("oracle-key-1")
    replay = post("oracle-key-1")
    fresh = post("oracle-key-2")

    assert first.status_code == 200, first.text
    assert replay.status_code == 200, replay.text
    assert replay.json()["data"] == first.json()["data"], (
        "a reused Idempotency-Key must replay the same reading"
    )
    assert fresh.json()["data"]["reading_id"] != first.json()["data"]["reading_id"]
    assert fresh.json()["data"]["folio_number"] == 2
    assert len(enqueued) == 2, "the replayed POST must not enqueue a second job"


def test_execute_reading_uses_indexed_user_library_content_chunks(
    db_session: Session,
    oracle_schema,
) -> None:
    user_id = uuid4()
    ensure_user_and_default_library(db_session, user_id)
    create_searchable_media(
        db_session,
        user_id,
        title="Lantern Monograph",
    )
    _seed_oracle_corpus(db_session, viewer_id=user_id)
    reading_id = _insert_pending_reading(
        db_session,
        user_id=user_id,
        question="Where does the lantern lead?",
    )

    router = _SelectLibraryRouter()
    result = asyncio.run(execute_reading(db_session, reading_id=reading_id, llm_router=router))

    assert result["status"] == "complete", f"expected reading to complete, got {result}"
    assert any(source_kind == "user_media" for source_kind in router.indices.values()), (
        f"LLM request should include user-library candidates, got {router.indices}"
    )
    user_media_targets = _cited_targets(db_session, reading_id, source_kind="user_media")
    assert user_media_targets, (
        "expected at least one persisted user-media folio with a citation edge, got "
        f"{_folio_edge_rows(db_session, reading_id)}"
    )
    assert all(
        scheme in ("evidence_span", "content_chunk") for scheme, _id in user_media_targets
    ), f"user-media citations must target content-index rows (§5.3), got {user_media_targets}"


def test_execute_reading_cites_content_chunk_when_user_chunk_has_no_span(
    db_session: Session,
    oracle_schema,
) -> None:
    """§5.3 no-span fallback (oracle.py ~1277-1282): when a ready user-media chunk
    carries a NULL ``primary_evidence_span_id``, its citation grounds to the chunk
    itself — ``content_chunk:<chunk_id>`` — rather than to a span. This covers the
    fallback branch the span-backed user-media tests never reach.
    """
    user_id = uuid4()
    ensure_user_and_default_library(db_session, user_id)
    media_id = create_searchable_media(
        db_session,
        user_id,
        title="Lantern Monograph",
    )
    # Strip the grounding span from every chunk so retrieval must fall back to the
    # chunk-id target; the chunk row itself stays ready and embedded.
    db_session.execute(
        text(
            """
            UPDATE content_chunks
            SET primary_evidence_span_id = NULL
            WHERE owner_kind = 'media' AND owner_id = :media_id
            """
        ),
        {"media_id": media_id},
    )
    chunk_ids = set(
        db_session.execute(
            text(
                """
                SELECT id
                FROM content_chunks
                WHERE owner_kind = 'media' AND owner_id = :media_id
                """
            ),
            {"media_id": media_id},
        ).scalars()
    )
    assert chunk_ids, "expected the searchable media to index at least one content chunk"
    _seed_oracle_corpus(db_session, viewer_id=user_id)
    reading_id = _insert_pending_reading(
        db_session,
        user_id=user_id,
        question="Where does the lantern lead?",
    )

    result = asyncio.run(
        execute_reading(db_session, reading_id=reading_id, llm_router=_SelectLibraryRouter())
    )

    assert result["status"] == "complete", f"expected reading to complete, got {result}"
    user_media_targets = _cited_targets(db_session, reading_id, source_kind="user_media")
    assert user_media_targets, (
        "expected a persisted user-media folio with a citation edge, got "
        f"{_folio_edge_rows(db_session, reading_id)}"
    )
    assert all(scheme == "content_chunk" for scheme, _id in user_media_targets), (
        "a user-media chunk with no primary evidence span must cite the chunk itself "
        f"(content_chunk:<id>, §5.3 fallback), got {user_media_targets}"
    )
    assert {target_id for _scheme, target_id in user_media_targets} <= chunk_ids, (
        "the content_chunk citation target must be one of the media's own chunk ids, got "
        f"{user_media_targets} vs media chunks {chunk_ids}"
    )


def test_execute_reading_user_media_passage_carries_citation_out(
    db_session: Session,
    oracle_schema,
) -> None:
    """S7/cutover: a user-library passage whose chunk owns an evidence span mints a
    CitationOut (chip + canonical deep link, ordinal = phase order). Public-domain
    passages now also carry a CitationOut, because a resolved ``oracle_passage_anchor``
    resolves to a current media reader jump (non-null locator)."""
    user_id = uuid4()
    ensure_user_and_default_library(db_session, user_id)
    create_searchable_media(db_session, user_id, title="Lantern Monograph")
    _seed_oracle_corpus(db_session, viewer_id=user_id)
    reading_id = _insert_pending_reading(
        db_session,
        user_id=user_id,
        question="Where does the lantern lead?",
    )

    # _SelectLibraryRouter puts the user-media candidate in the ORDEAL phase.
    result = asyncio.run(
        execute_reading(db_session, reading_id=reading_id, llm_router=_SelectLibraryRouter())
    )
    assert result["status"] == "complete", f"expected reading to complete, got {result}"

    detail = get_reading_detail(db_session, viewer_id=user_id, reading_id=reading_id)
    by_phase = {passage.phase: passage for passage in detail.passages}

    ordeal = by_phase["ordeal"]
    assert ordeal.source_kind == "user_media"
    assert ordeal.citation is not None, "a user-media passage with a span must mint a CitationOut"
    citation = ordeal.citation
    assert citation.ordinal == 2, "ordeal is the second phase -> ordinal 2"
    assert citation.role == "context"
    assert citation.target_ref.type == "evidence_span"
    assert citation.media_id is not None
    assert citation.deep_link == (
        f"/media/{citation.media_id}#evidence-{citation.target_ref.id}"
    ), f"deep link must jump to the exact span, got {citation.deep_link}"
    assert citation.snapshot is not None and citation.snapshot.result_type == "evidence_span"

    for phase in ("descent", "ascent"):
        passage = by_phase[phase]
        assert passage.source_kind == "public_domain"
        # A resolved anchor jumps into the corpus media's reader, so the chip is live.
        assert passage.citation is not None, (
            f"public-domain {phase} passage cites a resolved anchor, got {passage.citation}"
        )
        assert passage.citation.target_ref.type == "oracle_passage_anchor", (
            f"public-domain {phase} passage must cite an anchor, got {passage.citation.target_ref}"
        )
        assert passage.citation.locator is not None, (
            f"a resolved anchor must surface a reader locator, got {passage.citation}"
        )


def test_execute_reading_passage_event_carries_citation_for_user_media(
    db_session: Session,
    oracle_schema,
) -> None:
    """The streamed ``passage`` event payload mirrors the REST out: the user-media
    phase carries an evidence-span citation, and (post-cutover) public-domain phases
    carry an ``oracle_passage_anchor`` citation resolving to a media reader jump."""
    user_id = uuid4()
    ensure_user_and_default_library(db_session, user_id)
    create_searchable_media(db_session, user_id, title="Lantern Monograph")
    _seed_oracle_corpus(db_session, viewer_id=user_id)
    reading_id = _insert_pending_reading(
        db_session,
        user_id=user_id,
        question="Where does the lantern lead?",
    )

    asyncio.run(
        execute_reading(db_session, reading_id=reading_id, llm_router=_SelectLibraryRouter())
    )

    events = (
        db_session.execute(
            text(
                """
                SELECT payload
                FROM oracle_reading_events
                WHERE reading_id = :reading_id AND event_type = 'passage'
                ORDER BY seq
                """
            ),
            {"reading_id": reading_id},
        )
        .scalars()
        .all()
    )
    by_phase = {event["phase"]: event for event in events}
    assert by_phase["ordeal"]["source_kind"] == "user_media"
    assert by_phase["ordeal"]["citation"] is not None
    assert by_phase["ordeal"]["citation"]["ordinal"] == 2
    assert by_phase["ordeal"]["citation"]["target_ref"]["type"] == "evidence_span"
    for phase in ("descent", "ascent"):
        assert by_phase[phase]["source_kind"] == "public_domain"
        assert by_phase[phase]["citation"] is not None, (
            f"public-domain {phase} event must carry a resolved-anchor citation"
        )
        assert by_phase[phase]["citation"]["target_ref"]["type"] == "oracle_passage_anchor"


def test_execute_reading_note_owned_passage_carries_note_citation_out(
    db_session: Session,
    oracle_schema,
) -> None:
    user_id = uuid4()
    ensure_user_and_default_library(db_session, user_id)
    page_id = uuid4()
    note_block_id = uuid4()
    _seed_ready_note(
        db_session,
        user_id=user_id,
        page_id=page_id,
        note_block_id=note_block_id,
        page_title="Lantern Notebook",
        body_text=_NOTE_BODY_TEXT,
    )
    _seed_oracle_corpus(db_session, viewer_id=user_id)
    reading_id = _insert_pending_reading(
        db_session,
        user_id=user_id,
        question=_NOTE_ORACLE_QUESTION,
    )

    result = asyncio.run(
        execute_reading(db_session, reading_id=reading_id, llm_router=_SelectLibraryRouter())
    )
    assert result["status"] == "complete", f"expected reading to complete, got {result}"

    detail = get_reading_detail(db_session, viewer_id=user_id, reading_id=reading_id)
    by_phase = {passage.phase: passage for passage in detail.passages}
    ordeal = by_phase["ordeal"]
    assert ordeal.source_kind == "user_media"
    assert ordeal.citation is not None, "note-owned evidence must render a citation chip"
    citation = ordeal.citation
    assert citation.media_id is None
    assert citation.locator is not None
    assert citation.locator.type == "note_block_offsets"
    assert "page_id" not in citation.locator.model_dump(mode="json")
    assert str(citation.locator.block_id) == str(note_block_id)
    assert citation.target_ref.type == "evidence_span"

    events = (
        db_session.execute(
            text(
                """
                SELECT payload
                FROM oracle_reading_events
                WHERE reading_id = :reading_id AND event_type = 'passage'
                ORDER BY seq
                """
            ),
            {"reading_id": reading_id},
        )
        .scalars()
        .all()
    )
    event_by_phase = {event["phase"]: event for event in events}
    ordeal_event = event_by_phase["ordeal"]
    assert ordeal_event["citation"]["media_id"] is None
    assert ordeal_event["citation"]["locator"]["type"] == "note_block_offsets"
    assert ordeal_event["citation"]["locator"]["block_id"] == str(note_block_id)


def test_execute_reading_public_only_passages_cite_resolved_anchors(
    db_session: Session,
    oracle_schema,
) -> None:
    """A public-domain-only reading cites resolved ``oracle_passage_anchor`` identities
    (AC-G8). Each resolves to a current corpus-media reader jump, so every passage now
    surfaces a CitationOut chip (the old typographic-only behavior is gone)."""
    user_id = uuid4()
    db_session.execute(text("INSERT INTO users (id) VALUES (:user_id)"), {"user_id": user_id})
    _seed_oracle_corpus(db_session, viewer_id=user_id)
    reading_id = _insert_pending_reading(
        db_session,
        user_id=user_id,
        question="What does the lamp reveal?",
    )

    asyncio.run(execute_reading(db_session, reading_id=reading_id, llm_router=_PublicOnlyRouter()))

    detail = get_reading_detail(db_session, viewer_id=user_id, reading_id=reading_id)
    assert detail.passages, "expected three persisted passages"
    assert all(passage.source_kind == "public_domain" for passage in detail.passages)
    assert all(passage.citation is not None for passage in detail.passages), (
        "public-domain passages now cite resolved anchors with a live reader jump"
    )
    assert all(
        passage.citation.target_ref.type == "oracle_passage_anchor" for passage in detail.passages
    ), "public-domain passages must cite oracle_passage_anchor (AC-G8)"

    # The persisted citation edges target anchors, never the deleted corpus_passage scheme.
    target_schemes = {row["target_scheme"] for row in _folio_edge_rows(db_session, reading_id)}
    assert target_schemes == {"oracle_passage_anchor"}, (
        f"public-domain folio edges must target anchors, got {target_schemes}"
    )


def test_get_reading_detail_degrades_citation_to_none_when_backing_span_is_gone(
    db_session: Session,
    oracle_schema,
) -> None:
    """F04: a folio's citation edge snapshot has no FK to its evidence span, so a
    completed folio can outlive the span (deleted media / lost read access). The
    folio + edge still render the passage, but get_reading_detail must degrade its
    CitationOut to citation=None rather than raise the resolver's NotFoundError and
    404/500 the whole reading."""
    user_id = uuid4()
    ensure_user_and_default_library(db_session, user_id)
    create_searchable_media(db_session, user_id, title="Lantern Monograph")
    _seed_oracle_corpus(db_session, viewer_id=user_id)
    reading_id = _insert_pending_reading(
        db_session,
        user_id=user_id,
        question="Where does the lantern lead?",
    )

    # _SelectLibraryRouter puts the user-media (span-owning) candidate in ORDEAL.
    result = asyncio.run(
        execute_reading(db_session, reading_id=reading_id, llm_router=_SelectLibraryRouter())
    )
    assert result["status"] == "complete", f"expected reading to complete, got {result}"

    # The user-media folio's citation edge targets the chunk's evidence span (§5.3).
    user_media_targets = _cited_targets(db_session, reading_id, source_kind="user_media")
    assert len(user_media_targets) == 1, (
        f"expected exactly one user-media citation edge, got {user_media_targets}"
    )
    scheme, span_id = next(iter(user_media_targets))
    assert scheme == "evidence_span", (
        f"the user-media passage must cite an evidence span, got {scheme}:{span_id}"
    )
    assert span_id is not None
    # The folio + edge snapshot keep the passage, but the backing span can vanish (media
    # deletion cascades chunks/claims/spans; the citation edge has no FK to it, N4).
    # Clear the span's inbound references, then delete it, to model that vanished backing.
    db_session.execute(
        text("DELETE FROM message_retrievals WHERE evidence_span_id = :id"), {"id": span_id}
    )
    db_session.execute(
        text("DELETE FROM media_claims WHERE evidence_span_id = :id"), {"id": span_id}
    )
    db_session.execute(
        text(
            "UPDATE content_chunks SET primary_evidence_span_id = NULL "
            "WHERE primary_evidence_span_id = :id"
        ),
        {"id": span_id},
    )
    db_session.execute(text("DELETE FROM evidence_spans WHERE id = :id"), {"id": span_id})
    db_session.commit()

    detail = get_reading_detail(db_session, viewer_id=user_id, reading_id=reading_id)
    by_phase = {passage.phase: passage for passage in detail.passages}
    assert by_phase["ordeal"].source_kind == "user_media"
    assert by_phase["ordeal"].citation is None, (
        "a snapshot passage whose evidence span was deleted degrades to citation=None"
    )


def test_execute_reading_repairs_semantic_rejection_once_and_ledgers_both_attempts(
    db_session: Session,
    oracle_schema,
    oracle_rate_limiter: _RecordingRateLimiter,
) -> None:
    """AC-11: a semantic rejection triggers the ONE bounded repair round; the
    reading completes on application attempt 2, llm_calls carries one row per
    application generate call, and the budget commit uses usage summed across
    attempts."""
    user_id = uuid4()
    db_session.execute(text("INSERT INTO users (id) VALUES (:user_id)"), {"user_id": user_id})
    _seed_oracle_corpus(db_session, viewer_id=user_id)
    reading_id = _insert_pending_reading(
        db_session,
        user_id=user_id,
        question="What does the lamp reveal?",
    )

    router = _SemanticRepairRouter()
    result = asyncio.run(execute_reading(db_session, reading_id=reading_id, llm_router=router))

    assert result["status"] == "complete", f"expected repaired reading to complete, got {result}"
    assert len(router.requests) == 2, "semantic rejection must trigger exactly one repair round"
    repair_turns = list(router.requests[1].messages[-2:])
    assert [turn.role for turn in repair_turns] == ["assistant", "user"]
    assert "the JSON violates the reading rules" in repair_turns[1].content

    ledger = (
        db_session.execute(
            text(
                """
                SELECT call_seq, error_class, llm_operation
                FROM llm_calls
                WHERE owner_kind = 'oracle_reading' AND owner_id = :reading_id
                ORDER BY call_seq
                """
            ),
            {"reading_id": reading_id},
        )
        .mappings()
        .all()
    )
    assert [row["call_seq"] for row in ledger] == [1, 2], (
        f"one llm_calls row per attempt, got {[dict(r) for r in ledger]}"
    )
    assert all(row["error_class"] is None for row in ledger), (
        "a semantic rejection is not a provider error; both attempts succeed at the provider"
    )
    assert all(row["llm_operation"] == "oracle_reading" for row in ledger)

    done_payload = db_session.execute(
        text(
            """
            SELECT payload FROM oracle_reading_events
            WHERE reading_id = :reading_id AND event_type = 'done'
            """
        ),
        {"reading_id": reading_id},
    ).scalar_one()
    assert done_payload == {"status": "complete", "error_code": None}

    commit_event = next(
        event for event in oracle_rate_limiter.events if event[0] == "commit_token_budget"
    )
    assert commit_event[3] == 30, "budget commit uses usage summed across both attempts"

    interpretation_text = db_session.execute(
        text("SELECT interpretation_text FROM oracle_readings WHERE id = :reading_id"),
        {"reading_id": reading_id},
    ).scalar_one()
    assert (
        interpretation_text
        == "I saw a road bending into shadow, and the lamp's small flame thrown forward."
    ), "the interpretation is written to its canonical column at generation time"


def test_execute_reading_fails_without_platform_llm_entitlement(
    db_session: Session,
    oracle_schema,
) -> None:
    """resolve_api_key(mode="auto") gates platform-key use on entitlements; the
    failure routes through the normalized done grammar with the error floor set."""
    user_id = uuid4()
    db_session.execute(text("INSERT INTO users (id) VALUES (:user_id)"), {"user_id": user_id})
    _seed_oracle_corpus(db_session, viewer_id=user_id)
    reading = OracleReading(
        id=uuid4(),
        user_id=user_id,
        folio_number=1,
        question_text="Who may consult the oracle?",
        status="pending",
    )
    db_session.add(reading)
    db_session.commit()
    router = _UnexpectedRouter()

    result = asyncio.run(execute_reading(db_session, reading_id=reading.id, llm_router=router))

    row = (
        db_session.execute(
            text(
                """
                SELECT status, failed_at, error_code, error_detail
                FROM oracle_readings
                WHERE id = :reading_id
                """
            ),
            {"reading_id": reading.id},
        )
        .mappings()
        .one()
    )
    events = list(
        db_session.execute(
            text(
                """
                SELECT event_type, payload
                FROM oracle_reading_events
                WHERE reading_id = :reading_id
                ORDER BY seq
                """
            ),
            {"reading_id": reading.id},
        ).mappings()
    )

    assert result == {"status": "failed", "error_code": "E_BILLING_REQUIRED"}
    assert router.called is False, "key resolution must fail before any LLM call"
    assert row["status"] == "failed"
    assert row["failed_at"] is not None
    assert row["error_code"] == "E_BILLING_REQUIRED"
    assert row["error_detail"], "the error floor persists operator-facing detail"
    assert [event["event_type"] for event in events] == ["done"]
    assert events[0]["payload"] == {"status": "failed", "error_code": "E_BILLING_REQUIRED"}


def test_execute_reading_fails_when_required_user_embeddings_are_unavailable(
    db_session: Session,
    oracle_schema,
) -> None:
    user_id = uuid4()
    ensure_user_and_default_library(db_session, user_id)
    media_id = create_searchable_media(
        db_session,
        user_id,
        title="Lantern Monograph",
    )
    db_session.execute(
        text(
            """
            UPDATE content_index_states
            SET active_embedding_model = 'stale-model'
            WHERE owner_kind = 'media' AND owner_id = :media_id
            """
        ),
        {"media_id": media_id},
    )
    _seed_oracle_corpus(db_session, viewer_id=user_id)
    reading_id = _insert_pending_reading(
        db_session,
        user_id=user_id,
        question="Where does the lantern lead?",
    )
    router = _UnexpectedRouter()

    result = asyncio.run(execute_reading(db_session, reading_id=reading_id, llm_router=router))

    events = list(
        db_session.execute(
            text(
                """
                SELECT event_type
                FROM oracle_reading_events
                WHERE reading_id = :reading_id
                ORDER BY seq
                """
            ),
            {"reading_id": reading_id},
        ).scalars()
    )

    assert result == {"status": "failed", "error_code": "E_APP_SEARCH_FAILED"}
    assert router.called is False, "Oracle should fail before spending an LLM call"
    assert events == ["done"], f"embedding-backed user retrieval should fail closed: {events}"


def test_execute_reading_requires_user_passage_when_visible_media_is_searchable(
    db_session: Session,
    oracle_schema,
    monkeypatch,
) -> None:
    user_id = uuid4()
    ensure_user_and_default_library(db_session, user_id)
    create_searchable_media(
        db_session,
        user_id,
        title="Indexed Lantern Monograph",
    )
    _seed_oracle_corpus(db_session, viewer_id=user_id)
    reading_id = _insert_pending_reading(
        db_session,
        user_id=user_id,
        question="Where does the lantern lead?",
    )
    router = _UnexpectedRouter()

    monkeypatch.setattr("nexus.services.oracle._personal_candidates", lambda *a, **k: [])

    result = asyncio.run(execute_reading(db_session, reading_id=reading_id, llm_router=router))

    row = (
        db_session.execute(
            text(
                """
                SELECT status, error_code
                FROM oracle_readings
                WHERE id = :reading_id
                """
            ),
            {"reading_id": reading_id},
        )
        .mappings()
        .one()
    )
    events = list(
        db_session.execute(
            text(
                """
                SELECT event_type, payload
                FROM oracle_reading_events
                WHERE reading_id = :reading_id
                ORDER BY seq
                """
            ),
            {"reading_id": reading_id},
        ).mappings()
    )

    assert result == {"status": "failed", "error_code": "E_APP_SEARCH_FAILED"}
    assert row["status"] == "failed"
    assert row["error_code"] == "E_APP_SEARCH_FAILED"
    assert router.called is False, "Oracle should fail before spending an LLM call"
    assert [event["event_type"] for event in events] == ["done"], (
        f"required user-media retrieval should fail before meta, got {events}"
    )
    assert events[0]["payload"] == {"status": "failed", "error_code": "E_APP_SEARCH_FAILED"}


def test_execute_reading_has_no_provider_or_corpus_identity_columns(
    db_session: Session,
    oracle_schema,
) -> None:
    user_id = uuid4()
    db_session.execute(text("INSERT INTO users (id) VALUES (:user_id)"), {"user_id": user_id})
    _seed_oracle_corpus(db_session, viewer_id=user_id)
    first_reading_id = _insert_pending_reading(
        db_session,
        user_id=user_id,
        question="What does the lamp reveal?",
        folio_number=1,
    )
    second_reading_id = _insert_pending_reading(
        db_session,
        user_id=user_id,
        question="What does the lamp reveal?",
        folio_number=2,
    )

    router = _PublicOnlyRouter()
    first = asyncio.run(execute_reading(db_session, reading_id=first_reading_id, llm_router=router))
    second = asyncio.run(
        execute_reading(db_session, reading_id=second_reading_id, llm_router=router)
    )

    columns = {column["name"] for column in inspect(db_session.bind).get_columns("oracle_readings")}
    statuses = (
        db_session.execute(
            text(
                """
            SELECT status
            FROM oracle_readings
            WHERE id IN (:first_reading_id, :second_reading_id)
            ORDER BY folio_number
            """
            ),
            {
                "first_reading_id": first_reading_id,
                "second_reading_id": second_reading_id,
            },
        )
        .scalars()
        .all()
    )

    assert first["status"] == "complete", f"expected first reading to complete, got {first}"
    assert second["status"] == "complete", f"expected second reading to complete, got {second}"
    assert statuses == ["complete", "complete"]
    assert "corpus_set_version_id" not in columns
    assert "provider_request_hash" not in columns


def test_execute_reading_reserves_and_commits_oracle_token_budget(
    db_session: Session,
    oracle_schema,
    oracle_rate_limiter: _RecordingRateLimiter,
) -> None:
    user_id = uuid4()
    db_session.execute(text("INSERT INTO users (id) VALUES (:user_id)"), {"user_id": user_id})
    _seed_oracle_corpus(db_session, viewer_id=user_id)
    reading_id = _insert_pending_reading(
        db_session,
        user_id=user_id,
        question="What does the lamp reveal?",
    )

    result = asyncio.run(
        execute_reading(db_session, reading_id=reading_id, llm_router=_PublicOnlyRouter())
    )

    assert result["status"] == "complete", f"expected reading to complete, got {result}"
    event_names = oracle_rate_limiter.event_names()
    assert event_names[0] == "acquire_inflight"
    assert "reserve_token_budget" in event_names
    assert "commit_token_budget" in event_names
    assert event_names[-1] == "release_inflight"
    assert "release_token_budget" not in event_names
    reserve_event = next(
        event for event in oracle_rate_limiter.events if event[0] == "reserve_token_budget"
    )
    commit_event = next(
        event for event in oracle_rate_limiter.events if event[0] == "commit_token_budget"
    )
    assert reserve_event[2] == reading_id
    assert commit_event[2] == reading_id
    assert reserve_event[3] is not None and reserve_event[3] >= 2000


def test_execute_reading_persists_folio_and_citation_edge_per_phase(
    db_session: Session,
    oracle_schema,
) -> None:
    """Each phase writes one folio row paired with one citation edge (§5.3, AC8):
    source ``oracle_reading:<id>``, ``kind=context``/``origin=citation``, dense
    phase ordinals (descent 1, ordeal 2, ascent 3), and a display snapshot
    carrying snippet/locator. Public-domain citations target the stable
    ``oracle_passage_anchor`` identity rows (AC-G8).
    """
    user_id = uuid4()
    db_session.execute(text("INSERT INTO users (id) VALUES (:user_id)"), {"user_id": user_id})
    _seed_oracle_corpus(db_session, viewer_id=user_id)
    reading_id = _insert_pending_reading(
        db_session,
        user_id=user_id,
        question="What does the lamp reveal?",
    )

    result = asyncio.run(
        execute_reading(db_session, reading_id=reading_id, llm_router=_PublicOnlyRouter())
    )

    rows = _folio_edge_rows(db_session, reading_id)

    assert result["status"] == "complete", f"expected reading to complete, got {result}"
    assert [(row["phase"], row["ordinal"]) for row in rows] == [
        ("descent", 1),
        ("ordeal", 2),
        ("ascent", 3),
    ], f"phases must map to dense citation ordinals, got {rows}"
    assert len({row["target_id"] for row in rows}) == 3, (
        f"the three phases must cite three distinct passages, got {rows}"
    )
    for row in rows:
        assert (row["kind"], row["origin"]) == ("context", "citation"), (
            f"oracle citations are context edges with citation origin, got {row}"
        )
        assert (row["source_scheme"], row["source_id"]) == ("oracle_reading", reading_id), (
            f"edge source must be the reading, got {row}"
        )
        assert row["source_kind"] == "public_domain"
        assert row["target_scheme"] == "oracle_passage_anchor", (
            f"public-domain citations target the stable passage anchor (AC-G8), got {row}"
        )
        anchor = (
            db_session.execute(
                text(
                    """
                    SELECT a.display_label, s.title
                    FROM oracle_passage_anchors a
                    JOIN oracle_corpus_sources s ON s.id = a.corpus_source_id
                    WHERE a.id = :target_id
                    """
                ),
                {"target_id": row["target_id"]},
            )
            .mappings()
            .one()
        )
        snapshot = row["snapshot"]
        # The snapshot excerpt is the live chunk text the anchor resolved to.
        assert "forest lamp descends" in snapshot["excerpt"].lower(), (
            f"snapshot excerpt must be the resolved chunk text, got {snapshot}"
        )
        assert snapshot["section_label"] == row["locator_label"] == anchor["display_label"], (
            f"snapshot section label and folio locator label must match the anchor, got {row}"
        )
        assert snapshot["title"] == anchor["title"], (
            f"snapshot title is the corpus source title: {snapshot}"
        )
        # Public-domain candidates carry no Oracle-owned deep link; the reader jump is
        # rebuilt from the anchor's current evidence by the CitationOut (§12.1). A None
        # snapshot field is omitted from the stored JSONB, so the key is simply absent.
        assert "deep_link" not in snapshot, (
            f"public-domain snapshot must not carry an Oracle deep link, got {snapshot}"
        )
        assert snapshot["result_type"] == "oracle_passage_anchor", snapshot


def test_get_oracle_corpus_status_reports_ready_library_without_mutating_rows(
    auth_client,
    direct_db: DirectSessionManager,
    oracle_schema,
) -> None:
    user_id = uuid4()
    with direct_db.session() as session:
        session.execute(text("INSERT INTO users (id) VALUES (:user_id)"), {"user_id": user_id})
        library_id = _seed_oracle_corpus(session, viewer_id=user_id)
        before_counts = (
            session.execute(
                text(
                    """
                    SELECT
                        (SELECT count(*) FROM oracle_corpus_sources) AS sources,
                        (SELECT count(*) FROM oracle_passage_anchors) AS anchors,
                        (SELECT count(*) FROM oracle_plates) AS plates,
                        (SELECT count(*) FROM library_entries WHERE library_id = :library_id)
                            AS entries
                    """
                ),
                {"library_id": library_id},
            )
            .mappings()
            .one()
        )
        session.commit()

    direct_db.register_cleanup("users", "id", user_id)
    _register_oracle_corpus_cleanup(direct_db, user_id)

    response = auth_client.get("/oracle/corpus", headers=auth_headers(user_id))

    assert response.status_code == 200, response.text
    data = response.json()["data"]
    assert data["library_id"] == str(library_id)
    assert data["library_ref"] == f"library:{library_id}"
    assert data["status"] == "ready"
    assert data["work_count"] == ORACLE_TEST_WORK_COUNT
    assert data["ready_media_count"] == ORACLE_TEST_WORK_COUNT
    assert data["anchor_count"] == ORACLE_TEST_WORK_COUNT
    assert data["resolved_anchor_count"] == ORACLE_TEST_WORK_COUNT
    assert data["plate_count"] >= 1
    assert data["ready_plate_count"] == data["plate_count"]

    with direct_db.session() as session:
        after_counts = (
            session.execute(
                text(
                    """
                    SELECT
                        (SELECT count(*) FROM oracle_corpus_sources) AS sources,
                        (SELECT count(*) FROM oracle_passage_anchors) AS anchors,
                        (SELECT count(*) FROM oracle_plates) AS plates,
                        (SELECT count(*) FROM library_entries WHERE library_id = :library_id)
                            AS entries
                    """
                ),
                {"library_id": library_id},
            )
            .mappings()
            .one()
        )
    assert dict(after_counts) == dict(before_counts)


def test_get_oracle_reading_returns_proxied_plate_urls(
    auth_client,
    direct_db: DirectSessionManager,
    oracle_schema,
) -> None:
    user_id = uuid4()
    with direct_db.session() as session:
        session.execute(text("INSERT INTO users (id) VALUES (:user_id)"), {"user_id": user_id})
        _seed_oracle_corpus(session, viewer_id=user_id)
        reading_id = _insert_pending_reading(
            session,
            user_id=user_id,
            question="What does the lamp reveal?",
        )
        result = asyncio.run(
            execute_reading(session, reading_id=reading_id, llm_router=_PublicOnlyRouter())
        )
        reading = session.get(OracleReading, reading_id)
        assert reading is not None and reading.image_id is not None, (
            f"expected completed reading to persist an image, got {reading}"
        )
        image = session.get(OraclePlate, reading.image_id)
        assert image is not None, "expected completed reading image to resolve to a corpus plate"
        raw_source_url = image.source_url

    response = auth_client.get(
        f"/oracle/readings/{reading_id}",
        headers=auth_headers(user_id),
    )

    assert result["status"] == "complete", f"expected reading to complete, got {result}"
    assert response.status_code == 200, response.text
    data = response.json()["data"]
    plate_events = [event for event in data["events"] if event["event_type"] == "plate"]
    assert data["image"]["url"] == f"/api/oracle/plates/{reading.image_id}"
    assert plate_events, f"expected a plate event in reading detail, got {data['events']}"
    assert plate_events[0]["payload"]["url"] == data["image"]["url"]
    serialized = json.dumps(data)
    assert raw_source_url not in serialized, (
        "Oracle detail DTO/events should expose the owned same-origin plate URL, "
        "not the raw upstream image URL"
    )

    direct_db.register_cleanup("users", "id", user_id)
    _register_oracle_corpus_cleanup(direct_db, user_id)
    direct_db.register_cleanup("oracle_readings", "id", reading_id)
    direct_db.register_cleanup("resource_edges", "source_id", reading_id)
    direct_db.register_cleanup("oracle_reading_folios", "reading_id", reading_id)
    direct_db.register_cleanup("oracle_reading_events", "reading_id", reading_id)
    direct_db.register_cleanup("llm_calls", "owner_id", reading_id)


def test_reading_detail_renders_passages_from_folio_and_edge_field_for_field(
    auth_client,
    direct_db: DirectSessionManager,
    oracle_schema,
) -> None:
    """AC8: the reading wire shape is unchanged — GET detail rebuilds each
    passage from its folio row plus its citation-edge snapshot, field-for-field
    identical to the generation-time SSE ``passage`` payloads (which were built
    directly from the retrieved candidates).
    """
    user_id = uuid4()
    with direct_db.session() as session:
        session.execute(text("INSERT INTO users (id) VALUES (:user_id)"), {"user_id": user_id})
        _seed_oracle_corpus(session, viewer_id=user_id)
        reading_id = _insert_pending_reading(
            session,
            user_id=user_id,
            question="What does the lamp reveal?",
        )
        result = asyncio.run(
            execute_reading(session, reading_id=reading_id, llm_router=_PublicOnlyRouter())
        )

    direct_db.register_cleanup("users", "id", user_id)
    _register_oracle_corpus_cleanup(direct_db, user_id)
    direct_db.register_cleanup("oracle_readings", "id", reading_id)
    direct_db.register_cleanup("resource_edges", "source_id", reading_id)
    direct_db.register_cleanup("oracle_reading_folios", "reading_id", reading_id)
    direct_db.register_cleanup("oracle_reading_events", "reading_id", reading_id)

    response = auth_client.get(
        f"/oracle/readings/{reading_id}",
        headers=auth_headers(user_id),
    )

    assert result["status"] == "complete", f"expected reading to complete, got {result}"
    assert response.status_code == 200, response.text
    data = response.json()["data"]
    passage_payloads = {
        event["payload"]["phase"]: event["payload"]
        for event in data["events"]
        if event["event_type"] == "passage"
    }
    assert [passage["phase"] for passage in data["passages"]] == ["descent", "ordeal", "ascent"], (
        f"detail passages must come back in phase order, got {data['passages']}"
    )
    for passage in data["passages"]:
        assert set(passage) == {
            "phase",
            "source_kind",
            "exact_snippet",
            "locator_label",
            "attribution_text",
            "marginalia_text",
            "deep_link",
            "citation",
        }, f"reading passage wire shape changed: {sorted(passage)}"
        assert passage == passage_payloads[passage["phase"]], (
            "detail passage must be field-for-field identical to its generation-time payload; "
            f"got {passage} vs {passage_payloads[passage['phase']]}"
        )


@pytest.mark.parametrize(
    "omens",
    [
        ["a lamp in rain", " ", "dawn under branches"],
        ["a lamp in rain", "a door unlatched", "dawn under branches", "a fourth sign"],
    ],
)
def test_execute_reading_rejects_omens_unless_exactly_three_nonblank_lines(
    db_session: Session,
    oracle_schema,
    omens: list[object],
) -> None:
    user_id = uuid4()
    db_session.execute(text("INSERT INTO users (id) VALUES (:user_id)"), {"user_id": user_id})
    _seed_oracle_corpus(db_session, viewer_id=user_id)
    reading_id = _insert_pending_reading(
        db_session,
        user_id=user_id,
        question="What does the lamp reveal?",
    )

    result = asyncio.run(
        execute_reading(
            db_session,
            reading_id=reading_id,
            llm_router=_InvalidOmensRouter(omens),
        )
    )

    row = (
        db_session.execute(
            text(
                """
                SELECT status, error_code
                FROM oracle_readings
                WHERE id = :reading_id
                """
            ),
            {"reading_id": reading_id},
        )
        .mappings()
        .one()
    )
    events = list(
        db_session.execute(
            text(
                """
                SELECT event_type
                FROM oracle_reading_events
                WHERE reading_id = :reading_id
                ORDER BY seq
                """
            ),
            {"reading_id": reading_id},
        ).scalars()
    )

    assert result == {"status": "failed", "error_code": "E_LLM_BAD_REQUEST"}
    assert row["status"] == "failed"
    assert row["error_code"] == "E_LLM_BAD_REQUEST"
    assert "omens" not in events, f"invalid omen output should not be emitted, got {events}"
    assert events.count("done") == 1 and "error" not in events, (
        f"failed readings should emit one terminal done event, got {events}"
    )


@pytest.mark.parametrize(
    "variant",
    ["fenced", "extra_root_key", "extra_passage_key", "short_argument", "bad_theme"],
)
def test_execute_reading_rejects_non_strict_provider_json(
    db_session: Session,
    oracle_schema,
    variant: str,
) -> None:
    user_id = uuid4()
    db_session.execute(text("INSERT INTO users (id) VALUES (:user_id)"), {"user_id": user_id})
    _seed_oracle_corpus(db_session, viewer_id=user_id)
    reading_id = _insert_pending_reading(
        db_session,
        user_id=user_id,
        question="What does the lamp reveal?",
    )

    result = asyncio.run(
        execute_reading(
            db_session,
            reading_id=reading_id,
            llm_router=_InvalidJsonShapeRouter(variant),
        )
    )

    events = list(
        db_session.execute(
            text(
                """
                SELECT event_type
                FROM oracle_reading_events
                WHERE reading_id = :reading_id
                ORDER BY seq
                """
            ),
            {"reading_id": reading_id},
        ).scalars()
    )

    assert result == {"status": "failed", "error_code": "E_LLM_BAD_REQUEST"}
    assert events.count("done") == 1 and "error" not in events, (
        f"strict JSON rejection should emit one terminal done event, got {events}"
    )
    assert "passage" not in events, f"invalid JSON must not persist passages: {events}"


def test_execute_reading_provider_failure_uses_feedback_safe_error_message(
    auth_client,
    direct_db: DirectSessionManager,
    oracle_schema,
) -> None:
    user_id = uuid4()
    with direct_db.session() as db_session:
        db_session.execute(text("INSERT INTO users (id) VALUES (:user_id)"), {"user_id": user_id})
        _seed_oracle_corpus(db_session, viewer_id=user_id)
        reading_id = _insert_pending_reading(
            db_session,
            user_id=user_id,
            question="What does the lamp reveal?",
        )

        result = asyncio.run(
            execute_reading(db_session, reading_id=reading_id, llm_router=_ProviderErrorRouter())
        )

        row = (
            db_session.execute(
                text(
                    """
                    SELECT status, error_code, error_detail
                    FROM oracle_readings
                    WHERE id = :reading_id
                    """
                ),
                {"reading_id": reading_id},
            )
            .mappings()
            .one()
        )
        events = list(
            db_session.execute(
                text(
                    """
                    SELECT event_type, payload
                    FROM oracle_reading_events
                    WHERE reading_id = :reading_id
                    ORDER BY seq
                    """
                ),
                {"reading_id": reading_id},
            ).mappings()
        )
        serialized_events = json.dumps([dict(event) for event in events])
        ledger = (
            db_session.execute(
                text(
                    """
                    SELECT call_seq, provider, model_name, llm_operation, streaming, error_class
                    FROM llm_calls
                    WHERE owner_kind = 'oracle_reading' AND owner_id = :reading_id
                    ORDER BY call_seq
                    """
                ),
                {"reading_id": reading_id},
            )
            .mappings()
            .all()
        )
        db_session.execute(
            text(
                """
                UPDATE oracle_readings
                SET error_detail = 'raw persisted provider detail'
                WHERE id = :reading_id
                """
            ),
            {"reading_id": reading_id},
        )
        db_session.commit()

    direct_db.register_cleanup("users", "id", user_id)
    _register_oracle_corpus_cleanup(direct_db, user_id)
    direct_db.register_cleanup("oracle_readings", "id", reading_id)
    direct_db.register_cleanup("resource_edges", "source_id", reading_id)
    direct_db.register_cleanup("oracle_reading_folios", "reading_id", reading_id)
    direct_db.register_cleanup("oracle_reading_events", "reading_id", reading_id)
    direct_db.register_cleanup("llm_calls", "owner_id", reading_id)

    response = auth_client.get(
        f"/oracle/readings/{reading_id}",
        headers=auth_headers(user_id),
    )

    assert result == {"status": "failed", "error_code": "E_LLM_BAD_REQUEST"}
    assert response.status_code == 200, response.text
    detail = response.json()["data"]
    assert row["status"] == "failed"
    assert row["error_code"] == "E_LLM_BAD_REQUEST"
    assert "raw anthropic invalid_request_error" in str(row["error_detail"]), (
        "error_detail is the operator-facing exception detail"
    )
    assert "error_message" not in detail, "failure copy is FE-owned, keyed on error_code"
    assert "error_detail" not in detail, "operator detail never reaches the wire"
    assert detail["error_code"] == "E_LLM_BAD_REQUEST"
    assert "raw anthropic invalid_request_error" not in json.dumps(detail)
    assert "raw persisted provider detail" not in json.dumps(detail)
    assert "raw anthropic invalid_request_error" not in serialized_events
    assert events[-1]["event_type"] == "done"
    assert events[-1]["payload"] == {"status": "failed", "error_code": "E_LLM_BAD_REQUEST"}
    # Provider errors are never repaired: exactly one ledgered call, failed.
    assert len(ledger) == 1, f"expected one llm_calls row, got {[dict(r) for r in ledger]}"
    assert dict(ledger[0]) == {
        "call_seq": 1,
        "provider": "anthropic",
        "model_name": "claude-haiku-4-5-20251001",
        "llm_operation": "oracle_reading",
        "streaming": False,
        "error_class": "E_LLM_BAD_REQUEST",
    }


@pytest.mark.parametrize(
    ("llm_error_code", "api_error_code"),
    [
        (ModelCallErrorCode.INVALID_KEY, "E_LLM_INVALID_KEY"),
        (ModelCallErrorCode.RATE_LIMIT, "E_LLM_RATE_LIMIT"),
        (ModelCallErrorCode.CONTEXT_TOO_LARGE, "E_LLM_CONTEXT_TOO_LARGE"),
        (ModelCallErrorCode.TIMEOUT, "E_LLM_TIMEOUT"),
        (ModelCallErrorCode.PROVIDER_DOWN, "E_LLM_PROVIDER_DOWN"),
        (ModelCallErrorCode.BAD_REQUEST, "E_LLM_BAD_REQUEST"),
        (ModelCallErrorCode.MODEL_NOT_AVAILABLE, "E_MODEL_NOT_AVAILABLE"),
    ],
)
def test_execute_reading_maps_provider_error_codes_explicitly(
    db_session: Session,
    oracle_schema,
    llm_error_code: ModelCallErrorCode,
    api_error_code: str,
) -> None:
    user_id = uuid4()
    db_session.execute(text("INSERT INTO users (id) VALUES (:user_id)"), {"user_id": user_id})
    _seed_oracle_corpus(db_session, viewer_id=user_id)
    reading_id = _insert_pending_reading(
        db_session,
        user_id=user_id,
        question="What does the lamp reveal?",
    )

    result = asyncio.run(
        execute_reading(
            db_session,
            reading_id=reading_id,
            llm_router=_ProviderErrorRouter(llm_error_code),
        )
    )

    row = (
        db_session.execute(
            text(
                """
                SELECT status, error_code, error_detail
                FROM oracle_readings
                WHERE id = :reading_id
                """
            ),
            {"reading_id": reading_id},
        )
        .mappings()
        .one()
    )
    event_payloads = list(
        db_session.execute(
            text(
                """
                SELECT payload
                FROM oracle_reading_events
                WHERE reading_id = :reading_id
                ORDER BY seq
                """
            ),
            {"reading_id": reading_id},
        ).scalars()
    )

    assert result == {"status": "failed", "error_code": api_error_code}
    assert row["status"] == "failed"
    assert row["error_code"] == api_error_code
    assert row["error_detail"], f"expected operator-facing detail for {api_error_code}"
    assert event_payloads[-1] == {"status": "failed", "error_code": api_error_code}


def test_execute_reading_fails_closed_before_meta_when_corpus_not_ready(
    db_session: Session,
    oracle_schema,
) -> None:
    """AC-G4: an unresolved anchor makes the corpus not ready, so the worker fails
    with E_ORACLE_CORPUS_NOT_READY before emitting meta/plate (no LLM call)."""
    user_id = uuid4()
    db_session.execute(text("INSERT INTO users (id) VALUES (:user_id)"), {"user_id": user_id})
    _seed_oracle_corpus(db_session, viewer_id=user_id)
    # Repoint one anchor's selector at a quote no chunk contains, then re-resolve:
    # it goes 'failed', and a failed anchor makes the whole corpus not ready.
    anchor = db_session.execute(select(OraclePassageAnchor).limit(1)).scalar_one()
    anchor.selector = {"kind": "text_quote", "exact": "this quote appears in no corpus chunk"}
    db_session.flush()
    resolution = oracle_corpus.resolve_oracle_passage_anchors(db_session)
    assert resolution.failed == 1, f"expected exactly one failed anchor, got {resolution}"
    assert oracle_corpus.get_oracle_corpus_readiness(db_session).status == "not_ready"

    reading_id = _insert_pending_reading(
        db_session,
        user_id=user_id,
        question="What does the lamp reveal?",
    )

    router = _UnexpectedRouter()
    result = asyncio.run(
        execute_reading(
            db_session,
            reading_id=reading_id,
            llm_router=router,
        )
    )

    events = list(
        db_session.execute(
            text(
                """
                SELECT event_type
                FROM oracle_reading_events
                WHERE reading_id = :reading_id
                ORDER BY seq
                """
            ),
            {"reading_id": reading_id},
        ).scalars()
    )

    assert result == {"status": "failed", "error_code": "E_ORACLE_CORPUS_NOT_READY"}
    assert router.called is False, "a not-ready corpus must fail before any LLM call"
    assert events == ["done"], f"not-ready corpus should not emit meta or plate, got {events}"


@pytest.mark.parametrize(
    "router",
    [
        _InvalidCitationOutputRouter(
            interpretation="The answer is carried at Inferno I.1-3, if read closely."
        ),
        _InvalidCitationOutputRouter(
            marginalia="The source can be checked at https://example.com/citation."
        ),
        _InvalidCitationOutputRouter(
            interpretation="__FIRST_PASSAGE_TEXT__",
        ),
        _InvalidCitationOutputRouter(
            interpretation="The forest lamp descends through the matter as a hidden answer.",
        ),
    ],
)
def test_execute_reading_rejects_model_minted_citation_details(
    db_session: Session,
    oracle_schema,
    router: _InvalidCitationOutputRouter,
) -> None:
    user_id = uuid4()
    db_session.execute(text("INSERT INTO users (id) VALUES (:user_id)"), {"user_id": user_id})
    _seed_oracle_corpus(db_session, viewer_id=user_id)
    reading_id = _insert_pending_reading(
        db_session,
        user_id=user_id,
        question="What does the lamp reveal?",
    )

    result = asyncio.run(execute_reading(db_session, reading_id=reading_id, llm_router=router))

    events = list(
        db_session.execute(
            text(
                """
                SELECT event_type
                FROM oracle_reading_events
                WHERE reading_id = :reading_id
                ORDER BY seq
                """
            ),
            {"reading_id": reading_id},
        ).scalars()
    )
    folio_count = db_session.execute(
        text(
            """
            SELECT count(*)
            FROM oracle_reading_folios
            WHERE reading_id = :reading_id
            """
        ),
        {"reading_id": reading_id},
    ).scalar_one()
    edge_count = db_session.execute(
        text(
            """
            SELECT count(*)
            FROM resource_edges
            WHERE source_scheme = 'oracle_reading' AND source_id = :reading_id
            """
        ),
        {"reading_id": reading_id},
    ).scalar_one()

    assert result == {"status": "failed", "error_code": "E_LLM_BAD_REQUEST"}
    assert events.count("done") == 1 and "error" not in events, (
        f"citation rejection should emit a single terminal done, got {events}"
    )
    assert "passage" not in events, f"invalid citation output must not persist passages: {events}"
    assert folio_count == 0, "invalid citation output should not write folio rows"
    assert edge_count == 0, "invalid citation output should not write citation edges"


def test_execute_reading_emits_events_in_eternal_order(
    direct_db: DirectSessionManager,
    oracle_schema,
) -> None:
    user_id = uuid4()
    reading_id = uuid4()

    with direct_db.session() as db:
        db.execute(text("INSERT INTO users (id) VALUES (:user_id)"), {"user_id": user_id})
        _grant_platform_llm(db, user_id)
        _seed_oracle_corpus(db, viewer_id=user_id)
        db.add(
            OracleReading(
                id=reading_id,
                user_id=user_id,
                folio_number=1,
                question_text="What does the lamp reveal?",
                status="pending",
            )
        )
        db.commit()

    direct_db.register_cleanup("users", "id", user_id)
    _register_oracle_corpus_cleanup(direct_db, user_id)
    direct_db.register_cleanup("oracle_readings", "id", reading_id)
    direct_db.register_cleanup("resource_edges", "source_id", reading_id)
    direct_db.register_cleanup("oracle_reading_folios", "reading_id", reading_id)
    direct_db.register_cleanup("oracle_reading_events", "reading_id", reading_id)
    direct_db.register_cleanup("llm_calls", "owner_id", reading_id)

    router = _ObservingRouter(direct_db, reading_id)
    with direct_db.session() as db:
        result = asyncio.run(execute_reading(db, reading_id=reading_id, llm_router=router))

    assert result["status"] == "complete", f"expected reading to complete, got {result}"
    assert router.events_seen_during_generate == ["meta"], (
        "Only meta should be committed before the LLM response returns; "
        f"saw {router.events_seen_during_generate}"
    )
    assert router.image_id_seen_during_generate is None, (
        "Streaming detail hydration should not expose the plate before bind and argument"
    )

    with direct_db.session() as db:
        events = list(
            db.execute(
                text(
                    """
                    SELECT event_type
                    FROM oracle_reading_events
                    WHERE reading_id = :reading_id
                    ORDER BY seq
                    """
                ),
                {"reading_id": reading_id},
            ).scalars()
        )
    assert events == [
        "meta",
        "bind",
        "argument",
        "plate",
        "passage",
        "passage",
        "passage",
        "delta",
        "omens",
        "done",
    ]


def test_oracle_task_unexpected_failure_marks_reading_failed_and_emits_single_done(
    db_session: Session,
    oracle_schema,
    monkeypatch,
) -> None:
    user_id = uuid4()
    db_session.execute(text("INSERT INTO users (id) VALUES (:user_id)"), {"user_id": user_id})
    reading_id = _insert_pending_reading(
        db_session,
        user_id=user_id,
        question="What happens when the worker breaks?",
    )

    async def fail_unexpectedly(_db, *, reading_id, llm_router):
        raise RuntimeError("raw worker stack detail")

    monkeypatch.setattr(
        "nexus.tasks.llm_task.get_session_factory",
        lambda: task_session_factory(db_session),
    )
    monkeypatch.setattr("nexus.tasks.oracle_reading.execute_reading", fail_unexpectedly)

    result = oracle_reading_generate(str(reading_id))

    db_session.expire_all()
    row = (
        db_session.execute(
            text(
                """
                SELECT status, failed_at, error_code, error_detail
                FROM oracle_readings
                WHERE id = :reading_id
                """
            ),
            {"reading_id": reading_id},
        )
        .mappings()
        .one()
    )
    events = list(
        db_session.execute(
            text(
                """
                SELECT seq, event_type, payload
                FROM oracle_reading_events
                WHERE reading_id = :reading_id
                ORDER BY seq
                """
            ),
            {"reading_id": reading_id},
        ).mappings()
    )

    assert result == {"status": "failed", "error_code": "E_INTERNAL"}
    assert row["status"] == "failed"
    assert row["failed_at"] is not None
    assert row["error_code"] == "E_INTERNAL"
    assert row["error_detail"] == "RuntimeError: raw worker stack detail", (
        "the worker boundary persists the operator-facing exception detail"
    )
    assert [event["seq"] for event in events] == [1]
    assert [event["event_type"] for event in events] == ["done"]
    assert events[0]["payload"] == {"status": "failed", "error_code": "E_INTERNAL"}
    assert "raw worker stack detail" not in json.dumps([dict(event) for event in events])


def test_post_synthesis_fault_keeps_synthesis_llm_call_through_worker_rollback(
    db_session: Session,
    oracle_schema,
    monkeypatch,
) -> None:
    """F04/AC-3: LedgeredLLM only flushes the synthesis llm_calls row, and the
    worker boundary (fail_run_after_worker_exception) rolls back first. A fault in
    post-synthesis finalization must therefore find the row already committed, so
    the boundary's E_INTERNAL failure leaves >=1 oracle_reading llm_calls row."""
    user_id = uuid4()
    db_session.execute(text("INSERT INTO users (id) VALUES (:user_id)"), {"user_id": user_id})
    _seed_oracle_corpus(db_session, viewer_id=user_id)
    reading_id = _insert_pending_reading(
        db_session,
        user_id=user_id,
        question="What survives the worker rollback?",
    )

    real_append_event = run_kit.append_event

    def _append_event(db, *, stream, event_type, payload):
        if event_type == "bind":
            # The first finalization append, right after the F04 synthesis commit.
            raise RuntimeError("post-synthesis finalization fault")
        return real_append_event(db, stream=stream, event_type=event_type, payload=payload)

    monkeypatch.setattr(run_kit, "append_event", _append_event)

    with pytest.raises(RuntimeError, match="post-synthesis finalization fault"):
        asyncio.run(
            execute_reading(db_session, reading_id=reading_id, llm_router=_PublicOnlyRouter())
        )

    # Drive the real shared worker boundary exactly as nexus.tasks.oracle_reading does.
    reading, failed_now = run_kit.fail_run_after_worker_exception(
        db_session,
        load_parent=lambda session: session.get(OracleReading, reading_id, populate_existing=True),
        is_terminal=lambda r: r.status
        in run_kit.terminal_statuses(run_kit.RunStreamKind.OracleReading),
        write_failure=lambda session, r: run_kit.mark_terminal(
            session,
            stream=run_kit.oracle_reading_stream(r),
            status="failed",
            done_payload=oracle_done_payload(status="failed", error_code="E_INTERNAL"),
            error_code="E_INTERNAL",
            error_detail="RuntimeError: post-synthesis finalization fault",
        ),
    )
    assert failed_now and reading is not None

    db_session.expire_all()
    row = (
        db_session.execute(
            text("SELECT status, error_code FROM oracle_readings WHERE id = :reading_id"),
            {"reading_id": reading_id},
        )
        .mappings()
        .one()
    )
    assert row["status"] == "failed"
    assert row["error_code"] == "E_INTERNAL", "the boundary writes the E_INTERNAL floor"

    call_count = db_session.execute(
        text(
            """
            SELECT COUNT(*) FROM llm_calls
            WHERE owner_kind = 'oracle_reading' AND owner_id = :reading_id
            """
        ),
        {"reading_id": reading_id},
    ).scalar_one()
    assert call_count == 1, (
        "the committed synthesis llm_calls row must survive the boundary rollback"
    )


def test_execute_reading_rejects_out_of_list_theme(
    db_session: Session,
    oracle_schema,
) -> None:
    user_id = uuid4()
    db_session.execute(text("INSERT INTO users (id) VALUES (:user_id)"), {"user_id": user_id})
    _seed_oracle_corpus(db_session, viewer_id=user_id)
    reading_id = _insert_pending_reading(
        db_session,
        user_id=user_id,
        question="What does the lamp reveal?",
    )

    class _BadThemeRouter:
        async def generate(self, request, *, key, timeout_s):
            indices = _candidate_indices(request)
            public_indices = [
                idx for idx, source_kind in indices.items() if source_kind == "public_domain"
            ]
            payload = json.loads(
                _reading_json(
                    descent=public_indices[0],
                    ordeal=public_indices[1],
                    ascent=public_indices[2],
                    folio_theme="Of Mischief",
                )
            )
            from provider_runtime.types import ModelResponse

            return ModelResponse(
                text=json.dumps(payload),
                usage=None,
                provider_request_id=None,
                status=None,
                incomplete_details=None,
            )

    result = asyncio.run(
        execute_reading(db_session, reading_id=reading_id, llm_router=_BadThemeRouter())
    )

    assert result == {"status": "failed", "error_code": "E_LLM_BAD_REQUEST"}


def test_execute_reading_sortes_attribution_format(
    db_session: Session,
    oracle_schema,
) -> None:
    user_id = uuid4()
    db_session.execute(text("INSERT INTO users (id) VALUES (:user_id)"), {"user_id": user_id})
    _seed_oracle_corpus(db_session, viewer_id=user_id)
    reading_id = _insert_pending_reading(
        db_session,
        user_id=user_id,
        question="What does the lamp reveal?",
    )

    result = asyncio.run(
        execute_reading(db_session, reading_id=reading_id, llm_router=_PublicOnlyRouter())
    )

    assert result["status"] == "complete", f"expected reading to complete, got {result}"

    attribution_texts = list(
        db_session.execute(
            text(
                """
                SELECT attribution_text
                FROM oracle_reading_folios
                WHERE reading_id = :reading_id
                  AND source_kind = 'public_domain'
                """
            ),
            {"reading_id": reading_id},
        ).scalars()
    )

    assert attribution_texts, "expected at least one public-domain passage"
    for attribution_text in attribution_texts:
        assert "opened to" in attribution_text, (
            f"expected sortes attribution format, got: {attribution_text!r}"
        )
        assert not attribution_text.rstrip().endswith(". ."), (
            f"attribution should not duplicate period from edition_label: {attribution_text!r}"
        )


def test_concordance_ordering_by_score(
    db_session: Session,
    oracle_schema,
) -> None:
    """Folios sharing plate+theme+passages rank above plate+passages without theme.

    All folios run the same question over the same corpus, so each pair shares
    the three corpus-passage citation targets and the plate by construction
    (§5.3 identity equality); theme is the differentiator under test.
    """
    user_id = uuid4()
    db_session.execute(text("INSERT INTO users (id) VALUES (:user_id)"), {"user_id": user_id})
    _seed_oracle_corpus(db_session, viewer_id=user_id)
    question = "Reference question for concordance test."

    # Reference reading — folio 1
    ref_reading_id = _insert_pending_reading(
        db_session,
        user_id=user_id,
        question=question,
        folio_number=1,
    )
    asyncio.run(
        execute_reading(db_session, reading_id=ref_reading_id, llm_router=_PublicOnlyRouter())
    )

    # Fetch the image_id used by the reference reading
    ref_row = (
        db_session.execute(
            text("SELECT image_id FROM oracle_readings WHERE id = :id"),
            {"id": ref_reading_id},
        )
        .mappings()
        .one()
    )
    ref_image_id = ref_row["image_id"]

    # folio 2: shares plate + theme on top of the shared passages
    folio2_id = _insert_pending_reading(
        db_session,
        user_id=user_id,
        question=question,
        folio_number=2,
    )
    asyncio.run(execute_reading(db_session, reading_id=folio2_id, llm_router=_PublicOnlyRouter()))
    # Force same image and theme as reference
    db_session.execute(
        text(
            "UPDATE oracle_readings SET image_id = :image_id, folio_theme = :theme WHERE id = :id"
        ),
        {"image_id": ref_image_id, "theme": "Of Courage", "id": folio2_id},
    )
    db_session.execute(
        text("UPDATE oracle_readings SET folio_theme = :theme WHERE id = :ref_id"),
        {"theme": "Of Courage", "ref_id": ref_reading_id},
    )
    db_session.commit()

    # folio 3: shares passages (and the deterministic plate) but not the theme
    folio3_id = _insert_pending_reading(
        db_session,
        user_id=user_id,
        question=question,
        folio_number=3,
    )
    asyncio.run(execute_reading(db_session, reading_id=folio3_id, llm_router=_PublicOnlyRouter()))
    db_session.execute(
        text("UPDATE oracle_readings SET folio_theme = 'Of Solitude' WHERE id = :id"),
        {"id": folio3_id},
    )
    db_session.commit()

    entries = compute_concordance(db_session, viewer_id=user_id, reading_id=ref_reading_id)

    # folio2 (plate+theme+passages, score 7) ranks above folio3 (no theme, score 5)
    entry_ids = [str(entry.id) for entry in entries]
    assert entry_ids == [str(folio2_id), str(folio3_id)], (
        f"expected folio2 (plate+theme) above folio3 (theme differs), got order {entry_ids}"
    )
    folio2_entry, folio3_entry = entries
    assert folio2_entry.shared_plate is True
    assert folio2_entry.shared_theme is True
    assert folio2_entry.shared_passage_count == 3, (
        f"same-question folios share all three citation targets, got {folio2_entry}"
    )
    assert folio3_entry.shared_theme is False
    assert folio3_entry.shared_passage_count == 3, (
        f"theme divergence must not affect passage identity matches, got {folio3_entry}"
    )


def test_oracle_anchor_resolution_refreshes_after_corpus_media_reindex(
    db_session: Session,
    oracle_schema,
) -> None:
    """AC-G10: corpus media reindex regenerates chunks/spans, then the resolver refreshes
    current pointers while preserving the stable anchor identity."""
    user_id = uuid4()
    db_session.execute(text("INSERT INTO users (id) VALUES (:user_id)"), {"user_id": user_id})
    _seed_oracle_corpus(db_session, viewer_id=user_id)

    before = (
        db_session.execute(
            text(
                """
                SELECT a.id AS anchor_id, s.media_id, a.current_content_chunk_id,
                       a.current_evidence_span_id
                FROM oracle_passage_anchors a
                JOIN oracle_corpus_sources s ON s.id = a.corpus_source_id
                ORDER BY s.display_order ASC, a.passage_key ASC
                LIMIT 1
                """
            )
        )
        .mappings()
        .one()
    )
    fragments = (
        db_session.execute(select(Fragment).where(Fragment.media_id == before["media_id"]))
        .scalars()
        .all()
    )
    rebuild_fragment_content_index(
        db_session,
        media_id=before["media_id"],
        source_kind="web_article",
        fragments=fragments,
        reason="oracle_corpus_reindex_test",
    )
    db_session.flush()

    stale = oracle_corpus.get_oracle_corpus_readiness(db_session)
    assert stale.status == "not_ready"
    assert stale.resolved_anchor_count == ORACLE_TEST_WORK_COUNT - 1

    resolution = oracle_corpus.resolve_oracle_passage_anchors(db_session)
    assert resolution.failed == 0
    after = (
        db_session.execute(
            text(
                """
                SELECT current_content_chunk_id, current_evidence_span_id
                FROM oracle_passage_anchors
                WHERE id = :anchor_id
                """
            ),
            {"anchor_id": before["anchor_id"]},
        )
        .mappings()
        .one()
    )
    assert after["current_content_chunk_id"] != before["current_content_chunk_id"]
    assert after["current_evidence_span_id"] != before["current_evidence_span_id"]
    assert oracle_corpus.get_oracle_corpus_readiness(db_session).status == "ready"


def test_concordance_parity_shared_corpus_span_and_reindex_fixture(
    db_session: Session,
    oracle_schema,
) -> None:
    """AC21: the §5.3 identity contract over a seeded scenario.

    Readings A and B (same question, user media indexed) share two corpus
    passages AND the user-media evidence span — both match on
    ``(target_scheme, target_id)``. A content reindex then regenerates the
    media's spans/chunks, so reading C cites a NEW span id: the A/C pair keeps
    its corpus matches but loses the user-media match. That non-match is the
    pinned semantic delta from the old snapshot-JSONB equality, which could
    still match across a reindex.
    """
    user_id = uuid4()
    ensure_user_and_default_library(db_session, user_id)
    media_id = create_searchable_media(db_session, user_id, title="Lantern Monograph")
    _seed_oracle_corpus(db_session, viewer_id=user_id)
    question = "Where does the lantern lead?"

    reading_a = _insert_pending_reading(
        db_session, user_id=user_id, question=question, folio_number=1
    )
    result_a = asyncio.run(
        execute_reading(db_session, reading_id=reading_a, llm_router=_SelectLibraryRouter())
    )
    reading_b = _insert_pending_reading(
        db_session, user_id=user_id, question=question, folio_number=2
    )
    result_b = asyncio.run(
        execute_reading(db_session, reading_id=reading_b, llm_router=_SelectLibraryRouter())
    )

    # Reindex the media between B and C: spans/chunks are deleted and recreated
    # with fresh ids while the text stays identical.
    fragments = (
        db_session.execute(select(Fragment).where(Fragment.media_id == media_id)).scalars().all()
    )
    rebuild_fragment_content_index(
        db_session,
        media_id=media_id,
        source_kind="web_article",
        fragments=fragments,
        reason="test_reindex",
    )
    db_session.commit()

    reading_c = _insert_pending_reading(
        db_session, user_id=user_id, question=question, folio_number=3
    )
    result_c = asyncio.run(
        execute_reading(db_session, reading_id=reading_c, llm_router=_SelectLibraryRouter())
    )
    assert (result_a["status"], result_b["status"], result_c["status"]) == (
        "complete",
        "complete",
        "complete",
    ), f"all fixture readings must complete, got {(result_a, result_b, result_c)}"

    def one_user_media_target(reading_id: UUID) -> tuple[str, UUID]:
        targets = _cited_targets(db_session, reading_id, source_kind="user_media")
        assert len(targets) == 1, f"expected exactly one user-media citation, got {targets}"
        return next(iter(targets))

    span_a = one_user_media_target(reading_a)
    span_b = one_user_media_target(reading_b)
    span_c = one_user_media_target(reading_c)
    assert span_a[0] == "evidence_span", (
        f"user-media citations ground to the chunk's evidence span (§5.3), got {span_a}"
    )
    assert span_a == span_b, (
        f"the same-span pair must cite the same target identity, got {span_a} vs {span_b}"
    )
    assert span_a != span_c, (
        "the reindex pair must NOT share a user-media target — span ids regenerated "
        f"(pinned §5.3 delta); got {span_a} vs {span_c}"
    )
    corpus_a = _cited_targets(db_session, reading_a, source_kind="public_domain")
    corpus_c = _cited_targets(db_session, reading_c, source_kind="public_domain")
    assert corpus_a and corpus_a == corpus_c, (
        f"corpus passage targets are stable across the reindex, got {corpus_a} vs {corpus_c}"
    )

    entries = {
        entry.id: entry
        for entry in compute_concordance(db_session, viewer_id=user_id, reading_id=reading_a)
    }
    assert set(entries) == {reading_b, reading_c}, (
        f"expected both sibling folios in the concordance, got {sorted(entries)}"
    )
    assert entries[reading_b].shared_passage_count == 3, (
        "the pre-reindex pair shares two corpus passages plus the evidence span; "
        f"got {entries[reading_b]}"
    )
    assert entries[reading_c].shared_passage_count == 2, (
        "the reindex pair keeps its corpus matches but drops the span match; "
        f"got {entries[reading_c]}"
    )


def test_list_oracle_readings_returns_all_readings(
    auth_client,
    direct_db: DirectSessionManager,
    oracle_schema,
    monkeypatch,
) -> None:
    user_id = uuid4()
    with direct_db.session() as db:
        db.execute(text("INSERT INTO users (id) VALUES (:user_id)"), {"user_id": user_id})
        _seed_oracle_corpus(db, viewer_id=user_id)
        db.commit()

    direct_db.register_cleanup("users", "id", user_id)
    _register_oracle_corpus_cleanup(direct_db, user_id)
    direct_db.register_cleanup("oracle_readings", "user_id", user_id)
    monkeypatch.setattr("nexus.services.oracle.enqueue_job", lambda *args, **kwargs: None)

    # Create more than 5 readings to verify no limit is applied
    for i in range(7):
        auth_client.post(
            "/oracle/readings",
            json={"question": f"Question {i} to test the Aleph?"},
            headers=auth_headers(user_id),
        )

    response = auth_client.get("/oracle/readings", headers=auth_headers(user_id))

    assert response.status_code == 200, response.text
    data = response.json()["data"]
    assert len(data) == 7, f"expected all 7 readings returned, got {len(data)}"
    # Verify v2 field shape
    first = data[0]
    assert "folio_motto" in first
    assert "folio_motto_gloss" in first
    assert "folio_theme" in first
    assert "plate_thumbnail_url" in first
    if first["plate_thumbnail_url"] is not None:
        assert first["plate_thumbnail_url"].startswith("/api/oracle/plates/")
    assert "plate_alt_text" in first
    assert "folio_title" not in first


def test_concordance_endpoint_returns_empty_list_when_reading_not_complete(
    auth_client,
    direct_db: DirectSessionManager,
    oracle_schema,
    monkeypatch,
) -> None:
    user_id = uuid4()
    with direct_db.session() as db:
        db.execute(text("INSERT INTO users (id) VALUES (:user_id)"), {"user_id": user_id})
        _seed_oracle_corpus(db, viewer_id=user_id)
        db.commit()

    direct_db.register_cleanup("users", "id", user_id)
    _register_oracle_corpus_cleanup(direct_db, user_id)
    direct_db.register_cleanup("oracle_readings", "user_id", user_id)
    monkeypatch.setattr("nexus.services.oracle.enqueue_job", lambda *args, **kwargs: None)

    create_resp = auth_client.post(
        "/oracle/readings",
        json={"question": "Where does the path open?"},
        headers=auth_headers(user_id),
    )
    reading_id = create_resp.json()["data"]["reading_id"]

    response = auth_client.get(
        f"/oracle/readings/{reading_id}/concordance",
        headers=auth_headers(user_id),
    )

    assert response.status_code == 200, response.text
    assert response.json()["data"] == []


def test_concordance_endpoint_returns_404_for_another_users_reading(
    auth_client,
    direct_db: DirectSessionManager,
    oracle_schema,
    monkeypatch,
) -> None:
    owner_id = uuid4()
    other_id = uuid4()
    with direct_db.session() as db:
        db.execute(text("INSERT INTO users (id) VALUES (:user_id)"), {"user_id": owner_id})
        _seed_oracle_corpus(db, viewer_id=owner_id)
        db.commit()

    direct_db.register_cleanup("users", "id", owner_id)
    direct_db.register_cleanup("users", "id", other_id)
    _register_oracle_corpus_cleanup(direct_db, owner_id)
    direct_db.register_cleanup("oracle_readings", "user_id", owner_id)
    monkeypatch.setattr("nexus.services.oracle.enqueue_job", lambda *args, **kwargs: None)

    create_resp = auth_client.post(
        "/oracle/readings",
        json={"question": "Where does the path open?"},
        headers=auth_headers(owner_id),
    )
    reading_id = create_resp.json()["data"]["reading_id"]

    response = auth_client.get(
        f"/oracle/readings/{reading_id}/concordance",
        headers=auth_headers(other_id),
    )

    assert response.status_code == 404


def test_all_oracle_themes_are_valid(db_session: Session, oracle_schema) -> None:
    assert len(ORACLE_THEMES) == 24
    assert len(set(ORACLE_THEMES)) == 24  # no duplicates


def test_is_reading_terminal_treats_missing_reading_as_terminal(db_session: Session) -> None:
    """A reading deleted mid-stream is terminal, so the oracle SSE tail closes
    cleanly instead of streaming forever. Regression lock for the is_reading_terminal
    fix that the unified cursor stream relies on for its gone-terminal close path.
    """
    assert run_kit.is_run_terminal(db_session, run_kit.RunStreamKind.OracleReading, uuid4()) is True


def _seed_ready_note(
    db: Session,
    *,
    user_id: UUID,
    page_id: UUID,
    note_block_id: UUID,
    page_title: str,
    body_text: str,
) -> None:
    """Insert a page-linked note and index the note body."""
    db.execute(
        text("INSERT INTO pages (id, user_id, title) VALUES (:page_id, :user_id, :title)"),
        {"page_id": page_id, "user_id": user_id, "title": page_title},
    )
    db.execute(
        text(
            """
                INSERT INTO note_blocks (
                id, user_id, body_pm_json, body_text
                )
                VALUES (
                    :note_block_id, :user_id,
                    jsonb_build_object(
                        'type', 'paragraph',
                        'content', jsonb_build_array(
                            jsonb_build_object('type', 'text', 'text', CAST(:body_text AS text))
                        )
                    ),
                    :body_text
                )
                """
        ),
        {
            "note_block_id": note_block_id,
            "user_id": user_id,
            "body_text": body_text,
        },
    )
    db.execute(
        text(
            """
            INSERT INTO resource_edges (
                user_id, kind, origin, source_scheme, source_id, target_scheme,
                target_id, source_order_key
            )
            VALUES (
                :user_id, 'context', 'user', 'page', :page_id,
                'note_block', :note_block_id, '0000000001'
            )
            """
        ),
        {"user_id": user_id, "page_id": page_id, "note_block_id": note_block_id},
    )
    db.flush()
    result = rebuild_note_content_index(db, note_block_id=note_block_id, reason="test")
    assert result.status == "ready", (
        f"expected the seeded note index to be ready, got {result.status} for note {note_block_id}"
    )


# The oracle question whose tokens the seeded note body deliberately shares, so the
# deterministic test embedding gives the note a high cosine score against the oracle
# user-content retrieval query.
_NOTE_ORACLE_QUESTION = "Where does the lantern lead through shadow and dawn?"
_NOTE_BODY_TEXT = (
    "Where does the lantern lead through shadow and dawn, the forest lamp descending "
    "toward morning."
)


def test_personal_candidates_includes_note_owned_notes(
    db_session: Session,
    oracle_schema,
) -> None:
    """Oracle can cite your notes: a note-owned note body whose embedding matches the
    oracle personal-retrieval query surfaces as a ``user_media`` candidate targeting
    the note's content-index row (§5.3), titled generically and tagged with the 'note'
    content source kind. Pins the AC-9 headline at the shared-retrieval seam.
    """
    user_id = uuid4()
    ensure_user_and_default_library(db_session, user_id)
    page_id = uuid4()
    note_block_id = uuid4()
    _seed_ready_note(
        db_session,
        user_id=user_id,
        page_id=page_id,
        note_block_id=note_block_id,
        page_title="Lantern Notebook",
        body_text=_NOTE_BODY_TEXT,
    )
    db_session.commit()

    query_embedding = build_text_embedding(_NOTE_ORACLE_QUESTION)
    assert query_embedding[0] == current_transcript_embedding_model(), (
        "the note index and the oracle query must share the embedding model, got index "
        f"model {current_transcript_embedding_model()} vs query {query_embedding[0]}"
    )

    candidates = _personal_candidates(
        db_session,
        viewer_id=user_id,
        query_embedding=query_embedding,
        corpus_media_ids=set(),
    )

    note_target_ids = _owner_chunk_target_ids(db_session, "note_block", note_block_id)
    assert note_target_ids, "expected the seeded note to be indexed into content chunks"
    note_candidates = [
        candidate for candidate in candidates if candidate.target.id in note_target_ids
    ]
    assert note_candidates, (
        "expected a note-owned note among the oracle personal candidates "
        f"(oracle cites your notes); got targets {[c.target.uri for c in candidates]}"
    )
    note_candidate = note_candidates[0]
    assert note_candidate.target.scheme in ("evidence_span", "content_chunk"), (
        f"note candidate must target a content-index row (§5.3), got {note_candidate.target.uri}"
    )
    assert "note" in note_candidate.tags, (
        f"note candidate should carry the note content source kind tag, got {note_candidate.tags}"
    )
    assert note_candidate.title == "Note", (
        f"note candidate title should be generic, got {note_candidate.title!r}"
    )
    assert note_candidate.source_kind == "user_media", (
        f"note candidate should be offered as a user_media candidate, got "
        f"{note_candidate.source_kind}"
    )


def test_viewer_has_searchable_user_content_counts_note_only_corpus(
    db_session: Session,
    oracle_schema,
) -> None:
    user_id = uuid4()
    ensure_user_and_default_library(db_session, user_id)

    assert not _viewer_has_searchable_user_content(db_session, viewer_id=user_id), (
        "fresh users with no indexed media or notes should not require user-content retrieval"
    )

    _seed_ready_note(
        db_session,
        user_id=user_id,
        page_id=uuid4(),
        note_block_id=uuid4(),
        page_title="Only Notes",
        body_text=_NOTE_BODY_TEXT,
    )

    assert _viewer_has_searchable_user_content(db_session, viewer_id=user_id), (
        "indexed note-owned notes alone should activate Oracle user-content retrieval"
    )


def test_personal_candidates_keep_note_when_id_collides_with_media(
    db_session: Session,
    oracle_schema,
) -> None:
    """Owner-collision dedup (the load-bearing half of AC-9): a media-owned chunk and a
    note-owned chunk that share the SAME uuid value across the two owner keyspaces
    must BOTH survive ``_personal_candidates`` dedup, because the dedup key is
    (owner_kind, owner_id) and not the bare id. A bare-id dedup would drop the note as
    a duplicate of the media id.
    """
    user_id = uuid4()
    ensure_user_and_default_library(db_session, user_id)

    media_id = create_searchable_media(
        db_session,
        user_id,
        title=_NOTE_BODY_TEXT,
    )

    # Force the note id to equal the media id so the two owner keyspaces collide on the
    # bare uuid; only an (owner_kind, owner_id) dedup keeps both.
    note_block_id = media_id
    _seed_ready_note(
        db_session,
        user_id=user_id,
        page_id=uuid4(),
        note_block_id=note_block_id,
        page_title="Colliding Notebook",
        body_text=_NOTE_BODY_TEXT,
    )
    db_session.commit()

    query_embedding = build_text_embedding(_NOTE_ORACLE_QUESTION)

    candidates = _personal_candidates(
        db_session,
        viewer_id=user_id,
        query_embedding=query_embedding,
        corpus_media_ids=set(),
    )
    candidate_target_ids = {candidate.target.id for candidate in candidates}
    media_target_ids = _owner_chunk_target_ids(db_session, "media", media_id)
    note_target_ids = _owner_chunk_target_ids(db_session, "note_block", note_block_id)
    assert media_target_ids and note_target_ids, (
        "expected indexed chunks for both owner kinds sharing the colliding id, got "
        f"media={media_target_ids} note={note_target_ids}"
    )
    assert candidate_target_ids & media_target_ids, (
        "the media-owned chunk must survive the (owner_kind, owner_id) dedup; got targets "
        f"{[c.target.uri for c in candidates]}"
    )
    assert candidate_target_ids & note_target_ids, (
        "the note-owned chunk sharing the colliding id must survive the "
        "(owner_kind, owner_id) dedup (the note is not dropped); got targets "
        f"{[c.target.uri for c in candidates]}"
    )
