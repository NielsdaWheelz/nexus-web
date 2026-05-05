"""Add Black Forest Oracle corpus and reading tables.

Revision ID: 0072
Revises: 0071
Create Date: 2026-05-03
"""

import hashlib
import json
import math
import re
from collections.abc import Sequence
from pathlib import Path
from uuid import NAMESPACE_URL, uuid5

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0072"
down_revision: str | None = "0071"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


ORACLE_CORPUS_SET_VERSION_ID = "f9386e59-692e-5e4e-b93b-a87dc67c5bee"
ORACLE_CORPUS_VERSION = "black-forest-oracle-v1"
ORACLE_CORPUS_LABEL = "Black Forest Oracle v1"
ORACLE_EMBEDDING_MODEL = "test_hash_v2_256"
ORACLE_EMBEDDING_DIMENSIONS = 256
ORACLE_TOKEN_RE = re.compile(r"[a-z0-9]+")

ORACLE_MANIFEST_DIR = Path(__file__).resolve().parents[3] / "scripts" / "oracle"


def _load_oracle_manifest(filename: str) -> list[dict]:
    path = ORACLE_MANIFEST_DIR / filename
    if not path.exists():
        raise RuntimeError(f"Oracle seed manifest missing: {path}")
    return json.loads(path.read_text(encoding="utf-8"))


def _oracle_works() -> list[dict]:
    works: list[dict] = []
    for work in _load_oracle_manifest("manifest_works.json"):
        work_id = str(uuid5(NAMESPACE_URL, f"{ORACLE_CORPUS_VERSION}:work:{work['slug']}"))
        passages: list[dict] = []
        for passage in work["passages"]:
            passage_key = (
                f"{ORACLE_CORPUS_VERSION}:passage:{work['slug']}:{passage['passage_index']}"
            )
            passages.append({**passage, "id": str(uuid5(NAMESPACE_URL, passage_key))})
        works.append({**work, "id": work_id, "passages": passages})
    return works


def _oracle_images() -> list[dict]:
    images: list[dict] = []
    for index, image in enumerate(_load_oracle_manifest("manifest_plates.json")):
        resolved_source_url = image.get("resolved_source_url")
        width = image.get("width")
        height = image.get("height")
        if not isinstance(resolved_source_url, str) or not resolved_source_url:
            raise RuntimeError(f"Oracle plate manifest row {index + 1} lacks resolved_source_url")
        if not isinstance(width, int) or width <= 0 or not isinstance(height, int) or height <= 0:
            raise RuntimeError(f"Oracle plate manifest row {index + 1} lacks dimensions")
        source_page_url = image.get("source_url")
        if not isinstance(source_page_url, str) or not source_page_url:
            raise RuntimeError(f"Oracle plate manifest row {index + 1} lacks source_url")
        image_key = f"{ORACLE_CORPUS_VERSION}:image:{resolved_source_url}"
        images.append(
            {
                **image,
                "id": str(uuid5(NAMESPACE_URL, image_key)),
                "source_page_url": source_page_url,
                "source_url": resolved_source_url,
                "license_text": str(image.get("license_text") or "public domain"),
                "width": width,
                "height": height,
            }
        )
    return images


def _passage_locator(passage: dict) -> dict:
    locator = passage.get("locator")
    if isinstance(locator, dict) and locator:
        return dict(locator)
    return {
        "type": "manifest_locator",
        "label": passage["locator_label"],
        "passage_index": int(passage["passage_index"]),
    }


def _passage_source(work: dict, passage: dict) -> dict:
    citation_key = _citation_key(work, passage)
    return {
        "type": "public_domain_work",
        "citation_key": citation_key,
        "repository": work["source_repository"],
        "url": work["source_url"],
        "work_slug": work["slug"],
        "title": work["title"],
        "author": work["author"],
        "edition_label": work["edition_label"],
        "year": work.get("year"),
    }


def _citation_key(work: dict, passage: dict) -> str:
    payload = {
        "type": "oracle_corpus_passage",
        "corpus_version": ORACLE_CORPUS_VERSION,
        "work_slug": work["slug"],
        "passage_index": int(passage["passage_index"]),
        "text_sha256": hashlib.sha256(passage["canonical_text"].encode("utf-8")).hexdigest(),
    }
    return hashlib.sha256(
        json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()


def _oracle_embedding_literal(text_value: str) -> str:
    tokens = ORACLE_TOKEN_RE.findall(str(text_value or "").lower())
    vector = [0.0] * ORACLE_EMBEDDING_DIMENSIONS
    for token in tokens:
        digest = hashlib.sha256(token.encode("utf-8")).digest()
        bucket = int.from_bytes(digest[:4], "big") % ORACLE_EMBEDDING_DIMENSIONS
        sign = -1.0 if digest[4] % 2 else 1.0
        weight = ((int.from_bytes(digest[5:7], "big") % 1000) + 1) / 1000.0
        vector[bucket] += sign * weight

    norm = math.sqrt(sum(component * component for component in vector))
    if norm > 0.0:
        vector = [component / norm for component in vector]
    return "[" + ",".join(f"{component:.8f}" for component in vector) + "]"


def upgrade() -> None:
    op.create_table(
        "oracle_corpus_set_versions",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
            nullable=False,
        ),
        sa.Column("version", sa.Text(), nullable=False),
        sa.Column("label", sa.Text(), nullable=False),
        sa.Column("embedding_model", sa.Text(), nullable=False),
        sa.Column(
            "created_at",
            postgresql.TIMESTAMP(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "char_length(version) BETWEEN 1 AND 128",
            name="ck_oracle_corpus_versions_version_length",
        ),
        sa.CheckConstraint(
            "char_length(label) BETWEEN 1 AND 200",
            name="ck_oracle_corpus_versions_label_length",
        ),
        sa.CheckConstraint(
            "char_length(embedding_model) BETWEEN 1 AND 128",
            name="ck_oracle_corpus_versions_embedding_model_length",
        ),
        sa.UniqueConstraint("version", name="uix_oracle_corpus_versions_version"),
    )

    op.create_table(
        "oracle_corpus_works",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
            nullable=False,
        ),
        sa.Column("corpus_set_version_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("slug", sa.Text(), nullable=False),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("author", sa.Text(), nullable=False),
        sa.Column("year", sa.Text(), nullable=True),
        sa.Column("edition_label", sa.Text(), nullable=False),
        sa.Column("source_repository", sa.Text(), nullable=False),
        sa.Column("source_url", sa.Text(), nullable=False),
        sa.Column(
            "created_at",
            postgresql.TIMESTAMP(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "char_length(slug) BETWEEN 1 AND 160", name="ck_oracle_works_slug_length"
        ),
        sa.ForeignKeyConstraint(["corpus_set_version_id"], ["oracle_corpus_set_versions.id"]),
        sa.UniqueConstraint(
            "corpus_set_version_id",
            "slug",
            name="uix_oracle_works_version_slug",
        ),
    )

    op.create_table(
        "oracle_corpus_passages",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
            nullable=False,
        ),
        sa.Column("corpus_set_version_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("work_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("passage_index", sa.Integer(), nullable=False),
        sa.Column("canonical_text", sa.Text(), nullable=False),
        sa.Column("locator_label", sa.Text(), nullable=False),
        sa.Column(
            "locator",
            postgresql.JSONB(),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
        sa.Column(
            "source",
            postgresql.JSONB(),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
        sa.Column(
            "tags",
            postgresql.JSONB(),
            nullable=False,
            server_default=sa.text("'[]'::jsonb"),
        ),
        sa.Column("embedding_model", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            postgresql.TIMESTAMP(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "char_length(canonical_text) BETWEEN 1 AND 4000",
            name="ck_oracle_passages_text_length",
        ),
        sa.CheckConstraint("passage_index >= 0", name="ck_oracle_passages_index"),
        sa.CheckConstraint(
            "jsonb_typeof(locator) = 'object'", name="ck_oracle_passages_locator_object"
        ),
        sa.CheckConstraint(
            "jsonb_typeof(source) = 'object'", name="ck_oracle_passages_source_object"
        ),
        sa.CheckConstraint("jsonb_typeof(tags) = 'array'", name="ck_oracle_passages_tags_array"),
        sa.CheckConstraint(
            "embedding_model IS NULL OR char_length(embedding_model) BETWEEN 1 AND 128",
            name="ck_oracle_passages_embedding_model_length",
        ),
        sa.ForeignKeyConstraint(["corpus_set_version_id"], ["oracle_corpus_set_versions.id"]),
        sa.ForeignKeyConstraint(["work_id"], ["oracle_corpus_works.id"]),
        sa.UniqueConstraint("work_id", "passage_index", name="uix_oracle_passages_work_index"),
    )
    op.execute("ALTER TABLE oracle_corpus_passages ADD COLUMN embedding vector(256)")
    op.create_index(
        "idx_oracle_passages_version_embedding",
        "oracle_corpus_passages",
        ["corpus_set_version_id", "embedding_model"],
    )
    op.execute(
        """
        CREATE INDEX idx_oracle_passages_embedding_ann
        ON oracle_corpus_passages
        USING ivfflat (embedding vector_cosine_ops)
        WITH (lists = 10)
        """
    )

    op.create_table(
        "oracle_corpus_images",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
            nullable=False,
        ),
        sa.Column("corpus_set_version_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("source_repository", sa.Text(), nullable=False),
        sa.Column("source_page_url", sa.Text(), nullable=True),
        sa.Column("source_url", sa.Text(), nullable=False),
        sa.Column("license_text", sa.Text(), nullable=True),
        sa.Column("artist", sa.Text(), nullable=False),
        sa.Column("work_title", sa.Text(), nullable=False),
        sa.Column("year", sa.Text(), nullable=True),
        sa.Column("attribution_text", sa.Text(), nullable=False),
        sa.Column("width", sa.Integer(), nullable=False),
        sa.Column("height", sa.Integer(), nullable=False),
        sa.Column(
            "tags",
            postgresql.JSONB(),
            nullable=False,
            server_default=sa.text("'[]'::jsonb"),
        ),
        sa.Column("embedding_model", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            postgresql.TIMESTAMP(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint("width > 0", name="ck_oracle_images_width_positive"),
        sa.CheckConstraint("height > 0", name="ck_oracle_images_height_positive"),
        sa.CheckConstraint("jsonb_typeof(tags) = 'array'", name="ck_oracle_images_tags_array"),
        sa.CheckConstraint(
            "embedding_model IS NULL OR char_length(embedding_model) BETWEEN 1 AND 128",
            name="ck_oracle_images_embedding_model_length",
        ),
        sa.ForeignKeyConstraint(["corpus_set_version_id"], ["oracle_corpus_set_versions.id"]),
        sa.UniqueConstraint(
            "corpus_set_version_id",
            "source_url",
            name="uix_oracle_images_version_source_url",
        ),
    )
    op.execute("ALTER TABLE oracle_corpus_images ADD COLUMN embedding vector(256)")
    op.create_index(
        "idx_oracle_images_version_embedding",
        "oracle_corpus_images",
        ["corpus_set_version_id", "embedding_model"],
    )

    _seed_oracle_corpus()

    op.create_table(
        "oracle_readings",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
            nullable=False,
        ),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("corpus_set_version_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("folio_number", sa.Integer(), nullable=False),
        sa.Column("folio_title", sa.Text(), nullable=True),
        sa.Column("argument_text", sa.Text(), nullable=True),
        sa.Column("question_text", sa.Text(), nullable=False),
        sa.Column("status", sa.Text(), nullable=False, server_default=sa.text("'pending'")),
        sa.Column("prompt_version", sa.Text(), nullable=False),
        sa.Column("provider_request_hash", sa.Text(), nullable=True),
        sa.Column("generator_model_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("image_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("error_code", sa.Text(), nullable=True),
        sa.Column("error_message", sa.Text(), nullable=True),
        sa.Column("started_at", postgresql.TIMESTAMP(timezone=True), nullable=True),
        sa.Column("completed_at", postgresql.TIMESTAMP(timezone=True), nullable=True),
        sa.Column("failed_at", postgresql.TIMESTAMP(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            postgresql.TIMESTAMP(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint("folio_number > 0", name="ck_oracle_readings_folio_positive"),
        sa.CheckConstraint(
            "status IN ('pending', 'streaming', 'complete', 'failed')",
            name="ck_oracle_readings_status",
        ),
        sa.CheckConstraint(
            "char_length(btrim(question_text)) BETWEEN 1 AND 280",
            name="ck_oracle_readings_question_length",
        ),
        sa.CheckConstraint(
            "char_length(prompt_version) BETWEEN 1 AND 64",
            name="ck_oracle_readings_prompt_version_length",
        ),
        sa.CheckConstraint(
            "provider_request_hash IS NULL OR char_length(provider_request_hash) BETWEEN 1 AND 128",
            name="ck_oracle_readings_provider_request_hash_length",
        ),
        sa.CheckConstraint(
            "(status = 'complete' AND completed_at IS NOT NULL) OR status != 'complete'",
            name="ck_oracle_readings_complete_has_timestamp",
        ),
        sa.CheckConstraint(
            "(status = 'failed' AND failed_at IS NOT NULL AND error_code IS NOT NULL) "
            "OR status != 'failed'",
            name="ck_oracle_readings_failed_has_error",
        ),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"]),
        sa.ForeignKeyConstraint(["corpus_set_version_id"], ["oracle_corpus_set_versions.id"]),
        sa.ForeignKeyConstraint(["generator_model_id"], ["models.id"]),
        sa.ForeignKeyConstraint(["image_id"], ["oracle_corpus_images.id"]),
        sa.UniqueConstraint("user_id", "folio_number", name="uix_oracle_readings_user_folio"),
    )
    op.create_index(
        "idx_oracle_readings_user_created",
        "oracle_readings",
        ["user_id", "created_at"],
    )

    op.create_table(
        "oracle_reading_passages",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
            nullable=False,
        ),
        sa.Column("reading_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("phase", sa.Text(), nullable=False),
        sa.Column("source_kind", sa.Text(), nullable=False),
        sa.Column("source_ref", postgresql.JSONB(), nullable=False),
        sa.Column("exact_snippet", sa.Text(), nullable=False),
        sa.Column("locator_label", sa.Text(), nullable=False),
        sa.Column(
            "locator",
            postgresql.JSONB(),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
        sa.Column(
            "source",
            postgresql.JSONB(),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
        sa.Column("attribution_text", sa.Text(), nullable=False),
        sa.Column("marginalia_text", sa.Text(), nullable=False),
        sa.Column("deep_link", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            postgresql.TIMESTAMP(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "source_kind IN ('user_media', 'public_domain')",
            name="ck_oracle_reading_passages_source_kind",
        ),
        sa.CheckConstraint(
            "phase IN ('descent', 'ordeal', 'ascent')",
            name="ck_oracle_reading_passages_phase",
        ),
        sa.CheckConstraint(
            "jsonb_typeof(source_ref) = 'object'",
            name="ck_oracle_reading_passages_source_ref_object",
        ),
        sa.CheckConstraint(
            "jsonb_typeof(locator) = 'object'",
            name="ck_oracle_reading_passages_locator_object",
        ),
        sa.CheckConstraint(
            "jsonb_typeof(source) = 'object'",
            name="ck_oracle_reading_passages_source_object",
        ),
        sa.ForeignKeyConstraint(["reading_id"], ["oracle_readings.id"]),
        sa.UniqueConstraint("reading_id", "phase", name="uix_oracle_reading_passages_phase"),
    )

    op.create_table(
        "oracle_reading_events",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
            nullable=False,
        ),
        sa.Column("reading_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("seq", sa.Integer(), nullable=False),
        sa.Column("event_type", sa.Text(), nullable=False),
        sa.Column("payload", postgresql.JSONB(), nullable=False),
        sa.Column(
            "created_at",
            postgresql.TIMESTAMP(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint("seq >= 1", name="ck_oracle_reading_events_seq_positive"),
        sa.CheckConstraint(
            "event_type IN ("
            "'meta', 'bind', 'argument', 'plate', 'passage', 'delta', 'omens', 'error', 'done'"
            ")",
            name="ck_oracle_reading_events_type",
        ),
        sa.ForeignKeyConstraint(["reading_id"], ["oracle_readings.id"]),
        sa.UniqueConstraint("reading_id", "seq", name="uix_oracle_reading_events_seq"),
    )
    op.create_index(
        "idx_oracle_reading_events_reading_seq",
        "oracle_reading_events",
        ["reading_id", "seq"],
    )


def _seed_oracle_corpus() -> None:
    bind = op.get_bind()
    oracle_works = _oracle_works()
    oracle_images = _oracle_images()
    bind.execute(
        sa.text(
            """
            INSERT INTO oracle_corpus_set_versions (
                id,
                version,
                label,
                embedding_model
            )
            VALUES (
                CAST(:id AS uuid),
                :version,
                :label,
                :embedding_model
            )
            """
        ),
        {
            "id": ORACLE_CORPUS_SET_VERSION_ID,
            "version": ORACLE_CORPUS_VERSION,
            "label": ORACLE_CORPUS_LABEL,
            "embedding_model": ORACLE_EMBEDDING_MODEL,
        },
    )

    bind.execute(
        sa.text(
            """
            INSERT INTO oracle_corpus_works (
                id,
                corpus_set_version_id,
                slug,
                title,
                author,
                year,
                edition_label,
                source_repository,
                source_url
            )
            VALUES (
                CAST(:id AS uuid),
                CAST(:corpus_set_version_id AS uuid),
                :slug,
                :title,
                :author,
                :year,
                :edition_label,
                :source_repository,
                :source_url
            )
            """
        ),
        [
            {
                "id": work["id"],
                "corpus_set_version_id": ORACLE_CORPUS_SET_VERSION_ID,
                "slug": work["slug"],
                "title": work["title"],
                "author": work["author"],
                "year": work["year"],
                "edition_label": work["edition_label"],
                "source_repository": work["source_repository"],
                "source_url": work["source_url"],
            }
            for work in oracle_works
        ],
    )

    bind.execute(
        sa.text(
            """
            INSERT INTO oracle_corpus_passages (
                id,
                corpus_set_version_id,
                work_id,
                passage_index,
                canonical_text,
                locator_label,
                locator,
                source,
                tags,
                embedding_model,
                embedding
            )
            VALUES (
                CAST(:id AS uuid),
                CAST(:corpus_set_version_id AS uuid),
                CAST(:work_id AS uuid),
                :passage_index,
                :canonical_text,
                :locator_label,
                CAST(:locator AS jsonb),
                CAST(:source AS jsonb),
                CAST(:tags AS jsonb),
                :embedding_model,
                CAST(:embedding AS vector(256))
            )
            """
        ),
        [
            {
                "id": passage["id"],
                "corpus_set_version_id": ORACLE_CORPUS_SET_VERSION_ID,
                "work_id": work["id"],
                "passage_index": passage["passage_index"],
                "canonical_text": passage["canonical_text"],
                "locator_label": passage["locator_label"],
                "locator": json.dumps(_passage_locator(passage), sort_keys=True),
                "source": json.dumps(_passage_source(work, passage), sort_keys=True),
                "tags": json.dumps(passage["tags"]),
                "embedding_model": ORACLE_EMBEDDING_MODEL,
                "embedding": _oracle_embedding_literal(
                    " ".join(
                        [
                            passage["canonical_text"],
                            *[str(tag) for tag in passage["tags"]],
                        ]
                    )
                ),
            }
            for work in oracle_works
            for passage in work["passages"]
        ],
    )

    bind.execute(
        sa.text(
            """
            INSERT INTO oracle_corpus_images (
                id,
                corpus_set_version_id,
                source_repository,
                source_page_url,
                source_url,
                license_text,
                artist,
                work_title,
                year,
                attribution_text,
                width,
                height,
                tags,
                embedding_model,
                embedding
            )
            VALUES (
                CAST(:id AS uuid),
                CAST(:corpus_set_version_id AS uuid),
                :source_repository,
                :source_page_url,
                :source_url,
                :license_text,
                :artist,
                :work_title,
                :year,
                :attribution_text,
                :width,
                :height,
                CAST(:tags AS jsonb),
                :embedding_model,
                CAST(:embedding AS vector(256))
            )
            """
        ),
        [
            {
                "id": image["id"],
                "corpus_set_version_id": ORACLE_CORPUS_SET_VERSION_ID,
                "source_repository": image["source_repository"],
                "source_page_url": image["source_page_url"],
                "source_url": image["source_url"],
                "license_text": image["license_text"],
                "artist": image["artist"],
                "work_title": image["work_title"],
                "year": image["year"],
                "attribution_text": image["attribution_text"],
                "width": image["width"],
                "height": image["height"],
                "tags": json.dumps(image["tags"]),
                "embedding_model": ORACLE_EMBEDDING_MODEL,
                "embedding": _oracle_embedding_literal(
                    " ".join(
                        [
                            image["work_title"],
                            *[str(tag) for tag in image["tags"]],
                        ]
                    )
                ),
            }
            for image in oracle_images
        ],
    )


def downgrade() -> None:
    op.drop_index("idx_oracle_reading_events_reading_seq", table_name="oracle_reading_events")
    op.drop_table("oracle_reading_events")
    op.drop_table("oracle_reading_passages")
    op.drop_index("idx_oracle_readings_user_created", table_name="oracle_readings")
    op.drop_table("oracle_readings")
    op.drop_table("oracle_corpus_images")
    op.drop_table("oracle_corpus_passages")
    op.drop_table("oracle_corpus_works")
    op.drop_table("oracle_corpus_set_versions")
