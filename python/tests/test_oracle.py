"""Backend tests for the Black Forest Oracle service contract."""

from __future__ import annotations

import asyncio
import importlib
import importlib.util
import json
import re
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import quote
from uuid import UUID, uuid4

import pytest
from llm_calling.errors import LLMError, LLMErrorCode
from llm_calling.types import LLMResponse
from sqlalchemy import inspect, text
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session

from nexus.config import clear_settings_cache
from nexus.db.models import (
    OracleCorpusImage,
    OracleCorpusPassage,
    OracleCorpusSetVersion,
    OracleCorpusWork,
    OracleReading,
)
from nexus.services.bootstrap import ensure_user_and_default_library
from nexus.services.oracle import (
    ORACLE_CANONICAL_PUBLIC_DOMAIN_WORK_SLUGS,
    ORACLE_REQUIRED_PUBLIC_DOMAIN_IMAGES,
    ORACLE_REQUIRED_PUBLIC_DOMAIN_PASSAGES,
    ORACLE_REQUIRED_PUBLIC_DOMAIN_WORKS,
    create_reading,
    execute_reading,
)
from nexus.services.semantic_chunks import (
    build_text_embedding,
    current_transcript_embedding_model,
    to_pgvector_literal,
)
from nexus.tasks.oracle_reading import oracle_reading_generate
from tests.factories import create_searchable_media
from tests.helpers import auth_headers
from tests.utils.db import DirectSessionManager, task_session_factory

pytestmark = pytest.mark.integration


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
        "oracle_reading_passages",
        "oracle_corpus_works",
        "oracle_corpus_passages",
        "oracle_corpus_images",
        "oracle_corpus_set_versions",
    } - tables
    if missing:
        pytest.fail(f"oracle schema not present: {', '.join(sorted(missing))}")


@pytest.fixture
def oracle_schema(engine: Engine) -> None:
    _require_oracle_schema(engine)


def _seed_oracle_corpus_version(db: Session) -> UUID:
    version = OracleCorpusSetVersion(
        id=uuid4(),
        version=f"oracle-test-{uuid4()}",
        label="Oracle test corpus",
        embedding_model=current_transcript_embedding_model(),
    )
    db.add(version)
    db.flush()
    return version.id


def _oracle_test_embedding_literal(text_value: str) -> str:
    _model, embedding = build_text_embedding(text_value)
    return to_pgvector_literal(embedding)


def _set_oracle_passage_embedding(
    db: Session,
    *,
    passage_id: UUID,
    text_value: str,
) -> None:
    db.execute(
        text(
            """
            UPDATE oracle_corpus_passages
            SET embedding_model = :embedding_model,
                embedding = CAST(:embedding AS vector(256))
            WHERE id = :passage_id
            """
        ),
        {
            "passage_id": passage_id,
            "embedding_model": current_transcript_embedding_model(),
            "embedding": _oracle_test_embedding_literal(text_value),
        },
    )


def _set_oracle_image_embedding(
    db: Session,
    *,
    image_id: UUID,
    text_value: str,
) -> None:
    db.execute(
        text(
            """
            UPDATE oracle_corpus_images
            SET embedding_model = :embedding_model,
                embedding = CAST(:embedding AS vector(256))
            WHERE id = :image_id
            """
        ),
        {
            "image_id": image_id,
            "embedding_model": current_transcript_embedding_model(),
            "embedding": _oracle_test_embedding_literal(text_value),
        },
    )


def _seed_oracle_corpus(db: Session) -> tuple[UUID, list[UUID], UUID]:
    run_token = uuid4().hex[:12]
    corpus_set_version_id = _seed_oracle_corpus_version(db)
    work_ids: list[UUID] = []
    passage_index = 0
    for index, slug in enumerate(ORACLE_CANONICAL_PUBLIC_DOMAIN_WORK_SLUGS):
        work = OracleCorpusWork(
            id=uuid4(),
            corpus_set_version_id=corpus_set_version_id,
            slug=slug,
            title=f"Oracle Test Work {index}",
            author="A. Scribe",
            year="1850",
            edition_label="Test edition",
            source_repository="test",
            source_url=f"https://example.com/oracle-work-{run_token}-{index}",
        )
        db.add(work)
        db.flush()
        work_ids.append(work.id)
        work_passage_count = ORACLE_REQUIRED_PUBLIC_DOMAIN_PASSAGES // (
            ORACLE_REQUIRED_PUBLIC_DOMAIN_WORKS
        )
        if index < ORACLE_REQUIRED_PUBLIC_DOMAIN_PASSAGES % ORACLE_REQUIRED_PUBLIC_DOMAIN_WORKS:
            work_passage_count += 1
        for local_index in range(work_passage_count):
            passage_id = uuid4()
            canonical_text = (
                f"The forest lamp descends through test passage {passage_index}, "
                "bearing shadow, ordeal, and dawn."
            )
            tags = ["forest", "lamp", "dawn"]
            db.add(
                OracleCorpusPassage(
                    id=passage_id,
                    corpus_set_version_id=corpus_set_version_id,
                    work_id=work.id,
                    passage_index=local_index,
                    canonical_text=canonical_text,
                    locator_label=f"Test Work {index}, passage {local_index + 1}",
                    tags=tags,
                )
            )
            db.flush()
            _set_oracle_passage_embedding(
                db,
                passage_id=passage_id,
                text_value=" ".join([canonical_text, *tags]),
            )
            passage_index += 1

    image_ids: list[UUID] = []
    for index in range(ORACLE_REQUIRED_PUBLIC_DOMAIN_IMAGES):
        image = OracleCorpusImage(
            id=uuid4(),
            corpus_set_version_id=corpus_set_version_id,
            source_repository="test",
            source_url=f"https://example.com/oracle-plate-{run_token}-{index}.jpg",
            artist="Test Engraver",
            work_title=f"The Test Plate {index}",
            year="1860",
            attribution_text=f"Test Engraver, The Test Plate {index}, test collection.",
            width=800,
            height=1200,
            tags=["forest", "lamp"],
        )
        db.add(image)
        db.flush()
        _set_oracle_image_embedding(
            db,
            image_id=image.id,
            text_value=f"{image.work_title} {' '.join(image.tags)}",
        )
        image_ids.append(image.id)
    return corpus_set_version_id, work_ids, image_ids[0]


def _register_oracle_corpus_cleanup(
    direct_db: DirectSessionManager,
    corpus_set_version_id: UUID,
) -> None:
    direct_db.register_cleanup("oracle_corpus_set_versions", "id", corpus_set_version_id)
    direct_db.register_cleanup(
        "oracle_corpus_works", "corpus_set_version_id", corpus_set_version_id
    )
    direct_db.register_cleanup(
        "oracle_corpus_passages",
        "corpus_set_version_id",
        corpus_set_version_id,
    )
    direct_db.register_cleanup(
        "oracle_corpus_images",
        "corpus_set_version_id",
        corpus_set_version_id,
    )


def _insert_pending_reading(
    db: Session,
    *,
    user_id: UUID,
    corpus_set_version_id: UUID,
    question: str,
    folio_number: int = 1,
) -> UUID:
    reading = OracleReading(
        id=uuid4(),
        user_id=user_id,
        corpus_set_version_id=corpus_set_version_id,
        folio_number=folio_number,
        question_text=question,
        status="pending",
        prompt_version="oracle-v2",
    )
    db.add(reading)
    db.commit()
    return reading.id


def _candidate_indices(request) -> dict[int, str]:
    user_message = request.messages[-1].content
    return {
        int(match.group(1)): match.group(2)
        for match in re.finditer(r"^\[(\d+)] source_kind=([a-z_]+)", user_message, re.MULTILINE)
    }


def _candidate_text(request, index: int) -> str:
    user_message = request.messages[-1].content
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
) -> str:
    return json.dumps(
        {
            "argument": (
                "Of the lamp kept burning through the closed forest, and the road "
                "that answers after dread."
            ),
            "folio_title": "The Test Lamp",
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
            "interpretation": "The reading turns on a held light and a narrowing wood.",
            "omens": omens
            if omens is not None
            else ["a lamp in rain", "a door unlatched", "dawn under branches"],
        }
    )


class _SelectLibraryRouter:
    def __init__(self) -> None:
        self.indices: dict[int, str] = {}

    async def generate(self, _provider, request, _api_key, *, timeout_s):
        self.indices = _candidate_indices(request)
        user_indices = [
            idx for idx, source_kind in self.indices.items() if source_kind == "user_media"
        ]
        public_indices = [
            idx for idx, source_kind in self.indices.items() if source_kind == "public_domain"
        ]
        assert user_indices, "expected at least one indexed user-library candidate"
        assert len(public_indices) >= 2, f"expected two public candidates, got {self.indices}"
        return LLMResponse(
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

    async def generate(self, _provider, request, _api_key, *, timeout_s):
        self.called = True
        return LLMResponse(
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

    async def generate(self, _provider, request, _api_key, *, timeout_s):
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
        return LLMResponse(
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
    async def generate(self, _provider, request, _api_key, *, timeout_s):
        indices = _candidate_indices(request)
        public_indices = [
            idx for idx, source_kind in indices.items() if source_kind == "public_domain"
        ]
        assert len(public_indices) >= 3, f"expected three public candidates, got {indices}"
        return LLMResponse(
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
    def __init__(self, error_code: LLMErrorCode = LLMErrorCode.BAD_REQUEST) -> None:
        self.error_code = error_code

    async def generate(self, _provider, request, _api_key, *, timeout_s):
        raise LLMError(
            self.error_code,
            "raw anthropic invalid_request_error provider detail",
            provider="anthropic",
        )


class _InvalidOmensRouter:
    def __init__(self, omens: list[object]) -> None:
        self.omens = omens

    async def generate(self, _provider, request, _api_key, *, timeout_s):
        indices = _candidate_indices(request)
        public_indices = [
            idx for idx, source_kind in indices.items() if source_kind == "public_domain"
        ]
        assert len(public_indices) >= 3, f"expected three public candidates, got {indices}"
        return LLMResponse(
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

    async def generate(self, _provider, request, _api_key, *, timeout_s):
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
        return LLMResponse(
            text=json.dumps(payload),
            usage=None,
            provider_request_id=None,
            status=None,
            incomplete_details=None,
        )


class _InvalidJsonShapeRouter:
    def __init__(self, variant: str) -> None:
        self.variant = variant

    async def generate(self, _provider, request, _api_key, *, timeout_s):
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
        elif self.variant == "bad_title":
            payload["folio_title"] = "the lamp"
            text_value = json.dumps(payload)
        else:
            raise AssertionError(f"unknown invalid JSON shape variant: {self.variant}")
        return LLMResponse(
            text=text_value,
            usage=None,
            provider_request_id=None,
            status=None,
            incomplete_details=None,
        )


def test_create_reading_accepts_fresh_migrated_manifest_seed(
    db_session: Session,
    oracle_schema,
    monkeypatch,
) -> None:
    user_id = uuid4()
    db_session.execute(text("INSERT INTO users (id) VALUES (:user_id)"), {"user_id": user_id})
    monkeypatch.setattr("nexus.services.oracle.enqueue_job", lambda *args, **kwargs: None)

    corpus = (
        db_session.execute(
            text(
                """
                SELECT
                    csv.id,
                    csv.embedding_model,
                    count(DISTINCT ocw.id) AS work_count,
                    count(DISTINCT ocp.id) AS passage_count,
                    count(DISTINCT oci.id) AS image_count
                FROM oracle_corpus_set_versions csv
                LEFT JOIN oracle_corpus_works ocw ON ocw.corpus_set_version_id = csv.id
                LEFT JOIN oracle_corpus_passages ocp ON ocp.corpus_set_version_id = csv.id
                LEFT JOIN oracle_corpus_images oci ON oci.corpus_set_version_id = csv.id
                WHERE csv.version = 'black-forest-oracle-v1'
                GROUP BY csv.id
                """
            )
        )
        .mappings()
        .one_or_none()
    )

    assert corpus is not None, "migration should seed black-forest-oracle-v1"
    assert corpus["work_count"] >= ORACLE_REQUIRED_PUBLIC_DOMAIN_WORKS
    assert corpus["passage_count"] >= ORACLE_REQUIRED_PUBLIC_DOMAIN_PASSAGES
    assert corpus["image_count"] >= ORACLE_REQUIRED_PUBLIC_DOMAIN_IMAGES
    seeded_slugs = set(
        db_session.execute(
            text(
                """
                SELECT slug
                FROM oracle_corpus_works
                WHERE corpus_set_version_id = :corpus_set_version_id
                """
            ),
            {"corpus_set_version_id": corpus["id"]},
        ).scalars()
    )
    unsafe_plate_count = db_session.execute(
        text(
            """
            SELECT count(*)
            FROM oracle_corpus_images
            WHERE corpus_set_version_id = :corpus_set_version_id
              AND (width > 4096 OR height > 4096)
            """
        ),
        {"corpus_set_version_id": corpus["id"]},
    ).scalar_one()
    plate_audit_row = (
        db_session.execute(
            text(
                """
                SELECT source_page_url, source_url, license_text, attribution_text
                FROM oracle_corpus_images
                WHERE corpus_set_version_id = :corpus_set_version_id
                  AND source_page_url IS NOT NULL
                ORDER BY source_page_url
                LIMIT 1
                """
            ),
            {"corpus_set_version_id": corpus["id"]},
        )
        .mappings()
        .one_or_none()
    )
    missing_embedding_count = db_session.execute(
        text(
            """
            SELECT
                (SELECT count(*)
                 FROM oracle_corpus_passages
                 WHERE corpus_set_version_id = :corpus_set_version_id
                   AND (embedding_model IS NULL OR embedding IS NULL))
              + (SELECT count(*)
                 FROM oracle_corpus_images
                 WHERE corpus_set_version_id = :corpus_set_version_id
                   AND (embedding_model IS NULL OR embedding IS NULL))
            """
        ),
        {"corpus_set_version_id": corpus["id"]},
    ).scalar_one()
    mismatched_embedding_count = db_session.execute(
        text(
            """
            SELECT
                (SELECT count(*)
                 FROM oracle_corpus_passages
                 WHERE corpus_set_version_id = :corpus_set_version_id
                   AND embedding_model != :embedding_model)
              + (SELECT count(*)
                 FROM oracle_corpus_images
                 WHERE corpus_set_version_id = :corpus_set_version_id
                   AND embedding_model != :embedding_model)
            """
        ),
        {
            "corpus_set_version_id": corpus["id"],
            "embedding_model": corpus["embedding_model"],
        },
    ).scalar_one()

    assert seeded_slugs.issuperset(ORACLE_CANONICAL_PUBLIC_DOMAIN_WORK_SLUGS), (
        "migration seed should include every documented first-release work slug; "
        f"missing={sorted(set(ORACLE_CANONICAL_PUBLIC_DOMAIN_WORK_SLUGS) - seeded_slugs)}"
    )
    assert corpus["embedding_model"] == "test_hash_v2_256"
    assert unsafe_plate_count == 0, "all Oracle plates should fit the 4096px image proxy limit"
    assert missing_embedding_count == 0, "migration seed should include passage and plate vectors"
    assert mismatched_embedding_count == 0, (
        "migration seed vectors should be tagged with the corpus embedding model"
    )
    assert plate_audit_row is not None, "migration seed should retain plate audit/source page URLs"
    assert str(plate_audit_row["source_page_url"]).startswith(
        "https://commons.wikimedia.org/wiki/File:"
    )
    assert plate_audit_row["source_url"] != plate_audit_row["source_page_url"]
    assert plate_audit_row["license_text"] == "public domain"
    assert "public domain" in str(plate_audit_row["attribution_text"]).lower()

    reading = create_reading(
        db_session,
        viewer_id=user_id,
        question="Where does the path open?",
    )

    assert reading.status == "pending"
    assert reading.corpus_set_version_id == corpus["id"]


def test_create_reading_checks_llm_limits_before_enqueue(
    db_session: Session,
    oracle_schema,
    monkeypatch,
    oracle_rate_limiter: _RecordingRateLimiter,
) -> None:
    user_id = uuid4()
    db_session.execute(text("INSERT INTO users (id) VALUES (:user_id)"), {"user_id": user_id})
    _seed_oracle_corpus(db_session)

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


def test_build_corpus_validation_exits_nonzero_when_counts_are_short(
    db_session: Session,
    oracle_schema,
) -> None:
    oracle_build_corpus = importlib.import_module("scripts.oracle.build_corpus")
    corpus_set_version_id = _seed_oracle_corpus_version(db_session)

    with pytest.raises(SystemExit) as exc_info:
        oracle_build_corpus._validate_corpus_counts(
            db_session,
            corpus_set_version_id,
            expected_works=ORACLE_REQUIRED_PUBLIC_DOMAIN_WORKS,
            expected_passages=ORACLE_REQUIRED_PUBLIC_DOMAIN_PASSAGES,
            expected_images=ORACLE_REQUIRED_PUBLIC_DOMAIN_IMAGES,
        )

    message = str(exc_info.value)
    assert "Oracle corpus seed incomplete" in message
    assert f"works=0/{ORACLE_REQUIRED_PUBLIC_DOMAIN_WORKS}" in message
    assert f"passages=0/{ORACLE_REQUIRED_PUBLIC_DOMAIN_PASSAGES}" in message
    assert f"images=0/{ORACLE_REQUIRED_PUBLIC_DOMAIN_IMAGES}" in message


def test_build_corpus_validation_requires_embeddings(
    db_session: Session,
    oracle_schema,
) -> None:
    oracle_build_corpus = importlib.import_module("scripts.oracle.build_corpus")
    corpus_set_version_id, _work_ids, _image_id = _seed_oracle_corpus(db_session)
    db_session.execute(
        text("""
            UPDATE oracle_corpus_passages
            SET embedding_model = NULL,
                embedding = NULL
            WHERE id = (
                SELECT id
                FROM oracle_corpus_passages
                WHERE corpus_set_version_id = :corpus_set_version_id
                ORDER BY passage_index ASC, id ASC
                LIMIT 1
            )
        """),
        {"corpus_set_version_id": corpus_set_version_id},
    )

    with pytest.raises(SystemExit) as exc_info:
        oracle_build_corpus._validate_corpus_counts(
            db_session,
            corpus_set_version_id,
            expected_works=ORACLE_REQUIRED_PUBLIC_DOMAIN_WORKS,
            expected_passages=ORACLE_REQUIRED_PUBLIC_DOMAIN_PASSAGES,
            expected_images=ORACLE_REQUIRED_PUBLIC_DOMAIN_IMAGES,
        )

    assert f"passage_embeddings={ORACLE_REQUIRED_PUBLIC_DOMAIN_PASSAGES - 1}/" in str(
        exc_info.value
    )


def test_build_corpus_refuses_to_mutate_existing_version(
    db_session: Session,
    oracle_schema,
    monkeypatch,
) -> None:
    oracle_build_corpus = importlib.import_module("scripts.oracle.build_corpus")
    existing_version = f"oracle-test-{uuid4()}"
    monkeypatch.setattr(oracle_build_corpus, "CORPUS_VERSION", existing_version)
    db_session.add(
        OracleCorpusSetVersion(
            id=uuid4(),
            version=existing_version,
            label="Existing Oracle corpus",
            embedding_model="test-embedding",
        )
    )
    db_session.flush()

    with pytest.raises(SystemExit) as exc_info:
        oracle_build_corpus._ensure_corpus_set_version(db_session)

    message = str(exc_info.value)
    assert "already exists" in message
    assert "immutable" in message
    assert "ORACLE_CORPUS_VERSION" in message


def test_build_corpus_preserves_plate_audit_url_license_and_asset_url(
    db_session: Session,
    oracle_schema,
) -> None:
    oracle_build_corpus = importlib.import_module("scripts.oracle.build_corpus")
    corpus_set_version_id = _seed_oracle_corpus_version(db_session)

    oracle_build_corpus._seed_plates(
        db_session,
        client=None,
        corpus_set_version_id=corpus_set_version_id,
        manifest=[
            {
                "source_repository": "wikimedia_commons",
                "source_url": "https://commons.wikimedia.org/wiki/File:Oracle_Audit.jpg",
                "resolved_source_url": "https://upload.wikimedia.org/oracle-asset.jpg",
                "license_text": "public domain",
                "artist": "Test Artist",
                "work_title": "Audit Plate",
                "year": "1888",
                "attribution_text": "Test Artist, Audit Plate. Public domain.",
                "width": 640,
                "height": 960,
                "tags": ["audit"],
            }
        ],
    )

    row = (
        db_session.execute(
            text(
                """
                SELECT source_page_url, source_url, license_text, attribution_text
                FROM oracle_corpus_images
                WHERE corpus_set_version_id = :corpus_set_version_id
                """
            ),
            {"corpus_set_version_id": corpus_set_version_id},
        )
        .mappings()
        .one()
    )

    assert row["source_page_url"] == "https://commons.wikimedia.org/wiki/File:Oracle_Audit.jpg"
    assert row["source_url"] == "https://upload.wikimedia.org/oracle-asset.jpg"
    assert row["license_text"] == "public domain"
    assert row["attribution_text"] == "Test Artist, Audit Plate. Public domain."


def test_oracle_migration_does_not_load_seed_manifests_at_import(monkeypatch) -> None:
    original_read_text = Path.read_text

    def fail_read_text(self, *args, **kwargs):
        if self.name.startswith("manifest_") and "scripts/oracle" in str(self):
            raise AssertionError(f"migration import should not read seed manifest: {self}")
        return original_read_text(self, *args, **kwargs)

    repo_root = Path(__file__).resolve().parents[2]
    migration_path = repo_root / "migrations" / "alembic" / "versions" / "0072_oracle.py"
    spec = importlib.util.spec_from_file_location(
        f"oracle_0072_import_test_{uuid4().hex}",
        migration_path,
    )
    assert spec is not None and spec.loader is not None, "expected importable 0072 migration spec"
    module = importlib.util.module_from_spec(spec)

    monkeypatch.setattr(Path, "read_text", fail_read_text)

    spec.loader.exec_module(module)
    assert not hasattr(module, "ORACLE_WORKS")
    assert not hasattr(module, "ORACLE_IMAGES")


def test_create_reading_allocates_unique_folios_under_concurrent_requests(
    direct_db: DirectSessionManager,
    oracle_schema,
    monkeypatch,
) -> None:
    user_id = uuid4()
    with direct_db.session() as db:
        db.execute(text("INSERT INTO users (id) VALUES (:user_id)"), {"user_id": user_id})
        corpus_set_version_id, _work_ids, _image_id = _seed_oracle_corpus(db)
        db.commit()

    direct_db.register_cleanup("users", "id", user_id)
    _register_oracle_corpus_cleanup(direct_db, corpus_set_version_id)
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


def test_post_oracle_reading_returns_stream_connection_shape(
    auth_client,
    direct_db: DirectSessionManager,
    oracle_schema,
    monkeypatch,
) -> None:
    user_id = uuid4()
    with direct_db.session() as db:
        corpus_set_version_id, _work_ids, _image_id = _seed_oracle_corpus(db)
        db.commit()

    direct_db.register_cleanup("users", "id", user_id)
    direct_db.register_cleanup("libraries", "owner_user_id", user_id)
    direct_db.register_cleanup("memberships", "user_id", user_id)
    _register_oracle_corpus_cleanup(direct_db, corpus_set_version_id)
    direct_db.register_cleanup("oracle_readings", "user_id", user_id)
    monkeypatch.setattr("nexus.services.oracle.enqueue_job", lambda *args, **kwargs: None)

    response = auth_client.post(
        "/oracle/readings",
        json={"question": "Where does the path open?"},
        headers=auth_headers(user_id),
    )

    assert response.status_code == 200, response.text
    data = response.json()["data"]
    assert set(data) == {"reading_id", "folio_number", "status", "stream"}
    assert data["status"] == "pending"
    assert data["folio_number"] == 1
    assert data["stream"]["token"], f"expected stream token in create response, got {data}"
    assert data["stream"]["stream_base_url"] == "http://localhost:8000"
    assert data["stream"]["event_url"].endswith(
        f"/stream/oracle-readings/{data['reading_id']}/events"
    )
    assert data["stream"]["expires_at"], f"expected stream expiry in create response, got {data}"


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
    corpus_set_version_id, _work_ids, _image_id = _seed_oracle_corpus(db_session)
    reading_id = _insert_pending_reading(
        db_session,
        user_id=user_id,
        corpus_set_version_id=corpus_set_version_id,
        question="Where does the lantern lead?",
    )

    router = _SelectLibraryRouter()
    result = asyncio.run(execute_reading(db_session, reading_id=reading_id, llm_router=router))

    assert result["status"] == "complete", f"expected reading to complete, got {result}"
    assert any(source_kind == "user_media" for source_kind in router.indices.values()), (
        f"LLM request should include user-library candidates, got {router.indices}"
    )
    source_refs = list(
        db_session.execute(
            text(
                """
                SELECT source_ref
                FROM oracle_reading_passages
                WHERE reading_id = :reading_id
                """
            ),
            {"reading_id": reading_id},
        ).scalars()
    )
    assert any("content_chunk_id" in source_ref for source_ref in source_refs), (
        f"expected at least one persisted passage from a content chunk, got {source_refs}"
    )


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
            UPDATE media_content_index_states
            SET active_embedding_model = 'stale-model'
            WHERE media_id = :media_id
            """
        ),
        {"media_id": media_id},
    )
    corpus_set_version_id, _work_ids, _image_id = _seed_oracle_corpus(db_session)
    reading_id = _insert_pending_reading(
        db_session,
        user_id=user_id,
        corpus_set_version_id=corpus_set_version_id,
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
    assert events == ["error"], f"embedding-backed user retrieval should fail closed: {events}"


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
    corpus_set_version_id, _work_ids, _image_id = _seed_oracle_corpus(db_session)
    reading_id = _insert_pending_reading(
        db_session,
        user_id=user_id,
        corpus_set_version_id=corpus_set_version_id,
        question="Where does the lantern lead?",
    )
    router = _UnexpectedRouter()

    monkeypatch.setattr("nexus.services.oracle._retrieve_user_library_passages", lambda *a, **k: [])

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
    assert row["status"] == "failed"
    assert row["error_code"] == "E_APP_SEARCH_FAILED"
    assert router.called is False, "Oracle should fail before spending an LLM call"
    assert events == ["error"], (
        f"required user-media retrieval should fail before meta, got {events}"
    )


def test_execute_reading_records_corpus_version_and_stable_provider_hash(
    db_session: Session,
    oracle_schema,
) -> None:
    user_id = uuid4()
    db_session.execute(text("INSERT INTO users (id) VALUES (:user_id)"), {"user_id": user_id})
    corpus_set_version_id, _work_ids, _image_id = _seed_oracle_corpus(db_session)
    first_reading_id = _insert_pending_reading(
        db_session,
        user_id=user_id,
        corpus_set_version_id=corpus_set_version_id,
        question="What does the lamp reveal?",
        folio_number=1,
    )
    second_reading_id = _insert_pending_reading(
        db_session,
        user_id=user_id,
        corpus_set_version_id=corpus_set_version_id,
        question="What does the lamp reveal?",
        folio_number=2,
    )

    router = _PublicOnlyRouter()
    first = asyncio.run(execute_reading(db_session, reading_id=first_reading_id, llm_router=router))
    second = asyncio.run(
        execute_reading(db_session, reading_id=second_reading_id, llm_router=router)
    )

    rows = db_session.execute(
        text(
            """
            SELECT corpus_set_version_id, provider_request_hash
            FROM oracle_readings
            WHERE id IN (:first_reading_id, :second_reading_id)
            ORDER BY folio_number
            """
        ),
        {
            "first_reading_id": first_reading_id,
            "second_reading_id": second_reading_id,
        },
    ).all()

    assert first["status"] == "complete", f"expected first reading to complete, got {first}"
    assert second["status"] == "complete", f"expected second reading to complete, got {second}"
    assert [row[0] for row in rows] == [corpus_set_version_id, corpus_set_version_id]
    assert rows[0][1] and len(rows[0][1]) == 64
    assert rows[0][1] == rows[1][1]


def test_execute_reading_reserves_and_commits_oracle_token_budget(
    db_session: Session,
    oracle_schema,
    oracle_rate_limiter: _RecordingRateLimiter,
) -> None:
    user_id = uuid4()
    db_session.execute(text("INSERT INTO users (id) VALUES (:user_id)"), {"user_id": user_id})
    corpus_set_version_id, _work_ids, _image_id = _seed_oracle_corpus(db_session)
    reading_id = _insert_pending_reading(
        db_session,
        user_id=user_id,
        corpus_set_version_id=corpus_set_version_id,
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


def test_execute_reading_persists_structured_durable_citation_source_refs(
    db_session: Session,
    oracle_schema,
) -> None:
    user_id = uuid4()
    db_session.execute(text("INSERT INTO users (id) VALUES (:user_id)"), {"user_id": user_id})
    corpus_set_version_id, _work_ids, _image_id = _seed_oracle_corpus(db_session)
    reading_id = _insert_pending_reading(
        db_session,
        user_id=user_id,
        corpus_set_version_id=corpus_set_version_id,
        question="What does the lamp reveal?",
    )

    result = asyncio.run(
        execute_reading(db_session, reading_id=reading_id, llm_router=_PublicOnlyRouter())
    )

    row = (
        db_session.execute(
            text(
                """
                SELECT source_ref, locator_label
                FROM oracle_reading_passages
                WHERE reading_id = :reading_id
                  AND source_kind = 'public_domain'
                ORDER BY phase
                LIMIT 1
                """
            ),
            {"reading_id": reading_id},
        )
        .mappings()
        .one()
    )
    source_ref = row["source_ref"]

    assert result["status"] == "complete", f"expected reading to complete, got {result}"
    assert source_ref["type"] == "oracle_corpus_passage"
    assert source_ref["citation_key"] and len(source_ref["citation_key"]) == 64
    assert source_ref["locator"]["label"] == row["locator_label"]
    assert isinstance(source_ref["locator"]["passage_index"], int)
    assert source_ref["source"]["type"] == "public_domain_work"
    assert source_ref["source"]["url"].startswith("https://example.com/oracle-work-")
    assert source_ref["citation"]["citation_key"] == source_ref["citation_key"]


def test_get_oracle_reading_returns_proxied_plate_urls(
    auth_client,
    direct_db: DirectSessionManager,
    oracle_schema,
) -> None:
    user_id = uuid4()
    with direct_db.session() as session:
        session.execute(text("INSERT INTO users (id) VALUES (:user_id)"), {"user_id": user_id})
        corpus_set_version_id, _work_ids, _image_id = _seed_oracle_corpus(session)
        reading_id = _insert_pending_reading(
            session,
            user_id=user_id,
            corpus_set_version_id=corpus_set_version_id,
            question="What does the lamp reveal?",
        )
        result = asyncio.run(
            execute_reading(session, reading_id=reading_id, llm_router=_PublicOnlyRouter())
        )
        reading = session.get(OracleReading, reading_id)
        assert reading is not None and reading.image_id is not None, (
            f"expected completed reading to persist an image, got {reading}"
        )
        image = session.get(OracleCorpusImage, reading.image_id)
        assert image is not None, "expected completed reading image to resolve to corpus image"
        raw_source_url = image.source_url

    response = auth_client.get(
        f"/oracle/readings/{reading_id}",
        headers=auth_headers(user_id),
    )

    assert result["status"] == "complete", f"expected reading to complete, got {result}"
    assert response.status_code == 200, response.text
    data = response.json()["data"]
    plate_events = [event for event in data["events"] if event["event_type"] == "plate"]
    assert data["image"]["source_url"] == (f"/api/media/image?url={quote(raw_source_url, safe='')}")
    assert plate_events, f"expected a plate event in reading detail, got {data['events']}"
    assert plate_events[0]["payload"]["source_url"] == data["image"]["source_url"]
    serialized = json.dumps(data)
    assert raw_source_url not in serialized, (
        "Oracle detail DTO/events should expose the image proxy URL, not the raw image URL"
    )

    direct_db.register_cleanup("users", "id", user_id)
    direct_db.register_cleanup("oracle_corpus_set_versions", "id", corpus_set_version_id)
    direct_db.register_cleanup(
        "oracle_corpus_works", "corpus_set_version_id", corpus_set_version_id
    )
    direct_db.register_cleanup(
        "oracle_corpus_images", "corpus_set_version_id", corpus_set_version_id
    )
    direct_db.register_cleanup(
        "oracle_corpus_passages", "corpus_set_version_id", corpus_set_version_id
    )
    direct_db.register_cleanup("oracle_readings", "id", reading_id)
    direct_db.register_cleanup("oracle_reading_passages", "reading_id", reading_id)
    direct_db.register_cleanup("oracle_reading_events", "reading_id", reading_id)


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
    corpus_set_version_id, _work_ids, _image_id = _seed_oracle_corpus(db_session)
    reading_id = _insert_pending_reading(
        db_session,
        user_id=user_id,
        corpus_set_version_id=corpus_set_version_id,
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
    assert events.count("error") == 1 and "done" not in events, (
        f"failed readings should emit one terminal error event, got {events}"
    )


@pytest.mark.parametrize(
    "variant",
    ["fenced", "extra_root_key", "extra_passage_key", "short_argument", "bad_title"],
)
def test_execute_reading_rejects_non_strict_provider_json(
    db_session: Session,
    oracle_schema,
    variant: str,
) -> None:
    user_id = uuid4()
    db_session.execute(text("INSERT INTO users (id) VALUES (:user_id)"), {"user_id": user_id})
    corpus_set_version_id, _work_ids, _image_id = _seed_oracle_corpus(db_session)
    reading_id = _insert_pending_reading(
        db_session,
        user_id=user_id,
        corpus_set_version_id=corpus_set_version_id,
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
    assert events.count("error") == 1 and "done" not in events, (
        f"strict JSON rejection should emit one terminal error event, got {events}"
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
        corpus_set_version_id, _work_ids, _image_id = _seed_oracle_corpus(db_session)
        reading_id = _insert_pending_reading(
            db_session,
            user_id=user_id,
            corpus_set_version_id=corpus_set_version_id,
            question="What does the lamp reveal?",
        )

        result = asyncio.run(
            execute_reading(db_session, reading_id=reading_id, llm_router=_ProviderErrorRouter())
        )

        row = (
            db_session.execute(
                text(
                    """
                    SELECT status, error_code, error_message
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
        db_session.execute(
            text(
                """
                UPDATE oracle_readings
                SET error_message = 'raw persisted provider detail'
                WHERE id = :reading_id
                """
            ),
            {"reading_id": reading_id},
        )
        db_session.commit()

    direct_db.register_cleanup("users", "id", user_id)
    _register_oracle_corpus_cleanup(direct_db, corpus_set_version_id)
    direct_db.register_cleanup("oracle_readings", "id", reading_id)
    direct_db.register_cleanup("oracle_reading_passages", "reading_id", reading_id)
    direct_db.register_cleanup("oracle_reading_events", "reading_id", reading_id)

    response = auth_client.get(
        f"/oracle/readings/{reading_id}",
        headers=auth_headers(user_id),
    )

    assert result == {"status": "failed", "error_code": "E_LLM_BAD_REQUEST"}
    assert response.status_code == 200, response.text
    detail = response.json()["data"]
    assert row["status"] == "failed"
    assert row["error_code"] == "E_LLM_BAD_REQUEST"
    assert row["error_message"] == (
        "The reading could not be completed. Start a new reading with a simpler question."
    )
    assert detail["error_message"] == row["error_message"]
    assert "raw anthropic invalid_request_error" not in str(row["error_message"])
    assert "raw anthropic invalid_request_error" not in json.dumps(detail)
    assert "raw persisted provider detail" not in json.dumps(detail)
    assert "raw anthropic invalid_request_error" not in serialized_events
    assert events[-1]["event_type"] == "error"
    assert events[-1]["payload"] == {
        "code": "E_LLM_BAD_REQUEST",
        "message": (
            "The reading could not be completed. Start a new reading with a simpler question."
        ),
    }


@pytest.mark.parametrize(
    ("llm_error_code", "api_error_code"),
    [
        (LLMErrorCode.INVALID_KEY, "E_LLM_INVALID_KEY"),
        (LLMErrorCode.RATE_LIMIT, "E_LLM_RATE_LIMIT"),
        (LLMErrorCode.CONTEXT_TOO_LARGE, "E_LLM_CONTEXT_TOO_LARGE"),
        (LLMErrorCode.TIMEOUT, "E_LLM_TIMEOUT"),
        (LLMErrorCode.PROVIDER_DOWN, "E_LLM_PROVIDER_DOWN"),
        (LLMErrorCode.BAD_REQUEST, "E_LLM_BAD_REQUEST"),
        (LLMErrorCode.MODEL_NOT_AVAILABLE, "E_MODEL_NOT_AVAILABLE"),
    ],
)
def test_execute_reading_maps_provider_error_codes_explicitly(
    db_session: Session,
    oracle_schema,
    llm_error_code: LLMErrorCode,
    api_error_code: str,
) -> None:
    user_id = uuid4()
    db_session.execute(text("INSERT INTO users (id) VALUES (:user_id)"), {"user_id": user_id})
    corpus_set_version_id, _work_ids, _image_id = _seed_oracle_corpus(db_session)
    reading_id = _insert_pending_reading(
        db_session,
        user_id=user_id,
        corpus_set_version_id=corpus_set_version_id,
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
                SELECT status, error_code, error_message
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
    assert row["error_message"], f"expected feedback-safe message for {api_error_code}"
    assert event_payloads[-1]["code"] == api_error_code


def test_execute_reading_fails_closed_before_meta_when_corpus_seed_is_incomplete(
    db_session: Session,
    oracle_schema,
) -> None:
    user_id = uuid4()
    db_session.execute(text("INSERT INTO users (id) VALUES (:user_id)"), {"user_id": user_id})
    corpus_set_version_id = _seed_oracle_corpus_version(db_session)
    reading_id = _insert_pending_reading(
        db_session,
        user_id=user_id,
        corpus_set_version_id=corpus_set_version_id,
        question="What does the lamp reveal?",
    )

    result = asyncio.run(
        execute_reading(
            db_session,
            reading_id=reading_id,
            llm_router=_PublicOnlyRouter(),
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

    assert result == {"status": "failed", "error_code": "E_ORACLE_CORPUS_INCOMPLETE"}
    assert events == ["error"], f"incomplete setup should not emit meta or plate, got {events}"


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
    corpus_set_version_id, _work_ids, _image_id = _seed_oracle_corpus(db_session)
    reading_id = _insert_pending_reading(
        db_session,
        user_id=user_id,
        corpus_set_version_id=corpus_set_version_id,
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
    passage_count = db_session.execute(
        text(
            """
            SELECT count(*)
            FROM oracle_reading_passages
            WHERE reading_id = :reading_id
            """
        ),
        {"reading_id": reading_id},
    ).scalar_one()

    assert result == {"status": "failed", "error_code": "E_LLM_BAD_REQUEST"}
    assert events.count("error") == 1 and "done" not in events, (
        f"citation rejection should emit a single terminal error, got {events}"
    )
    assert "passage" not in events, f"invalid citation output must not persist passages: {events}"
    assert passage_count == 0, "invalid citation output should not write passage rows"


def test_execute_reading_emits_events_in_eternal_order(
    direct_db: DirectSessionManager,
    oracle_schema,
) -> None:
    user_id = uuid4()
    reading_id = uuid4()

    with direct_db.session() as db:
        db.execute(text("INSERT INTO users (id) VALUES (:user_id)"), {"user_id": user_id})
        corpus_set_version_id, _work_ids, _image_id = _seed_oracle_corpus(db)
        db.add(
            OracleReading(
                id=reading_id,
                user_id=user_id,
                corpus_set_version_id=corpus_set_version_id,
                folio_number=1,
                question_text="What does the lamp reveal?",
                status="pending",
                prompt_version="oracle-v2",
            )
        )
        db.commit()

    direct_db.register_cleanup("users", "id", user_id)
    _register_oracle_corpus_cleanup(direct_db, corpus_set_version_id)
    direct_db.register_cleanup("oracle_readings", "id", reading_id)
    direct_db.register_cleanup("oracle_reading_passages", "reading_id", reading_id)
    direct_db.register_cleanup("oracle_reading_events", "reading_id", reading_id)

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


def test_oracle_task_unexpected_failure_marks_reading_failed_and_emits_single_error(
    db_session: Session,
    oracle_schema,
    monkeypatch,
) -> None:
    user_id = uuid4()
    db_session.execute(text("INSERT INTO users (id) VALUES (:user_id)"), {"user_id": user_id})
    corpus_set_version_id = _seed_oracle_corpus_version(db_session)
    reading_id = _insert_pending_reading(
        db_session,
        user_id=user_id,
        corpus_set_version_id=corpus_set_version_id,
        question="What happens when the worker breaks?",
    )

    async def fail_unexpectedly(_db, *, reading_id, llm_router):
        raise RuntimeError("raw worker stack detail")

    monkeypatch.setattr(
        "nexus.tasks.oracle_reading.get_session_factory",
        lambda: task_session_factory(db_session),
    )
    monkeypatch.setattr("nexus.tasks.oracle_reading.execute_reading", fail_unexpectedly)

    result = oracle_reading_generate(str(reading_id))

    db_session.expire_all()
    row = (
        db_session.execute(
            text(
                """
                SELECT status, failed_at, error_code, error_message
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
    assert "raw worker stack detail" not in str(row["error_message"])
    assert [event["seq"] for event in events] == [1]
    assert [event["event_type"] for event in events] == ["error"]
    assert events[0]["payload"] == {
        "code": "E_INTERNAL",
        "message": "The reading could not be completed. Please try again.",
    }
    assert "raw worker stack detail" not in json.dumps([dict(event) for event in events])
