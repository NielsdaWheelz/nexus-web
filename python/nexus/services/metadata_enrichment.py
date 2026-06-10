"""LLM-based metadata enrichment for media items.

Uses a cheap LLM call to derive bibliographic metadata from existing source
context. Valid provider output is authoritative for the fields it returns.
"""

from __future__ import annotations

import html
import json
import re
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from llm_calling.types import StructuredOutputSpec
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator
from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.config import Settings, get_settings
from nexus.db.models import Media
from nexus.llm_catalog import require_catalog_model
from nexus.logging import get_logger
from nexus.services.contributor_credits import replace_machine_derived_media_author_credits

logger = get_logger(__name__)


# ---------------------------------------------------------------------------
# Structured-output contract
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class MetadataMergeResult:
    """Observable outcome of applying one validated enrichment payload."""

    accepted_fields: tuple[str, ...]


class MetadataEnrichmentOutput(BaseModel):
    """Strict model-facing metadata contract."""

    model_config = ConfigDict(extra="forbid", strict=True)

    title: str | None = Field(max_length=255)
    authors: list[str] | None = Field(max_length=20)
    publisher: str | None = Field(max_length=255)
    description: str | None = Field(max_length=2000)
    published_date: str | None = Field(max_length=64)
    language: str | None = Field(max_length=32)

    @field_validator("title", "publisher", "description", "published_date", "language")
    @classmethod
    def _non_empty_string(cls, value: str | None) -> str | None:
        if value is None:
            return None
        stripped = value.strip()
        if not stripped:
            raise ValueError("metadata string fields must be non-empty when present")
        return stripped

    @field_validator("published_date")
    @classmethod
    def _valid_partial_iso_date(cls, value: str | None) -> str | None:
        if value is None:
            return None
        if not re.fullmatch(r"\d{4}(?:-\d{2}(?:-\d{2})?)?", value):
            raise ValueError("published_date must be YYYY, YYYY-MM, or YYYY-MM-DD")
        return value

    @field_validator("language")
    @classmethod
    def _valid_iso_639_1_language(cls, value: str | None) -> str | None:
        if value is None:
            return None
        if not re.fullmatch(r"[a-z]{2}", value):
            raise ValueError("language must be an ISO 639-1 lowercase two-letter code")
        return value

    @field_validator("authors")
    @classmethod
    def _valid_authors(cls, value: list[str] | None) -> list[str] | None:
        if value is None:
            return None
        stripped = [author.strip() for author in value]
        if not stripped or any(not author for author in stripped):
            raise ValueError("authors must be non-empty names")
        return stripped


def metadata_structured_output_spec() -> StructuredOutputSpec:
    """Return the schema requested from structured-output-capable providers."""
    nullable_string = {"type": ["string", "null"]}
    return StructuredOutputSpec(
        name="media_metadata_enrichment",
        strict=True,
        schema={
            "type": "object",
            "additionalProperties": False,
            "required": [
                "title",
                "authors",
                "publisher",
                "description",
                "published_date",
                "language",
            ],
            "properties": {
                "title": {**nullable_string, "maxLength": 255},
                "authors": {
                    "anyOf": [
                        {
                            "type": "array",
                            "items": {"type": "string", "minLength": 1, "maxLength": 255},
                            "minItems": 1,
                            "maxItems": 20,
                        },
                        {"type": "null"},
                    ]
                },
                "publisher": {**nullable_string, "maxLength": 255},
                "description": {**nullable_string, "maxLength": 2000},
                "published_date": {
                    **nullable_string,
                    "maxLength": 64,
                    "pattern": r"^\d{4}(?:-\d{2}(?:-\d{2})?)?$",
                },
                "language": {
                    **nullable_string,
                    "maxLength": 32,
                    "pattern": r"^[a-z]{2}$",
                },
            },
        },
    )


# ---------------------------------------------------------------------------
# Content sampling
# ---------------------------------------------------------------------------


def get_content_sample(db: Session, media: Media) -> str:
    """Get the best early extracted text available for the enrichment prompt."""
    settings = get_settings()
    max_chars = settings.metadata_enrichment_max_content_chars

    plain_text = _clean_sample_text(media.plain_text)
    if plain_text:
        return plain_text[:max_chars]

    chunks = db.execute(
        text(
            """
            SELECT cc.chunk_idx, cc.source_kind, cc.heading_path, cc.chunk_text
            FROM content_chunks cc
            JOIN content_index_states mcis
              ON mcis.owner_kind = cc.owner_kind AND mcis.owner_id = cc.owner_id
             AND mcis.status = 'ready'
            WHERE cc.owner_kind = 'media' AND cc.owner_id = :media_id
              AND btrim(cc.chunk_text) <> ''
            ORDER BY cc.chunk_idx ASC
            LIMIT 4
            """
        ),
        {"media_id": media.id},
    ).fetchall()

    chunk_sample = _render_indexed_text_sample(chunks, max_chars=max_chars)
    if chunk_sample:
        return chunk_sample

    blocks = db.execute(
        text(
            """
            SELECT cb.block_idx, cb.block_kind, cb.heading_path, cb.canonical_text
            FROM content_blocks cb
            JOIN content_index_states mcis
              ON mcis.owner_kind = cb.owner_kind AND mcis.owner_id = cb.owner_id
             AND mcis.status = 'ready'
            WHERE cb.owner_kind = 'media' AND cb.owner_id = :media_id
              AND btrim(cb.canonical_text) <> ''
            ORDER BY cb.block_idx ASC
            LIMIT 8
            """
        ),
        {"media_id": media.id},
    ).fetchall()

    block_sample = _render_indexed_text_sample(blocks, max_chars=max_chars)
    if block_sample:
        return block_sample

    fragments = db.execute(
        text(
            """
            SELECT idx, canonical_text
            FROM fragments
            WHERE media_id = :media_id
              AND canonical_text IS NOT NULL
              AND btrim(canonical_text) <> ''
            ORDER BY idx ASC
            LIMIT 4
            """
        ),
        {"media_id": media.id},
    ).fetchall()

    fragment_sample = _render_fragment_sample(fragments, max_chars=max_chars)
    if fragment_sample:
        return fragment_sample

    if media.kind == "podcast_episode":
        row = db.execute(
            text("SELECT description_text FROM podcast_episodes WHERE media_id = :media_id"),
            {"media_id": media.id},
        ).fetchone()
        show_notes = _clean_sample_text(row[0] if row else None)
        if show_notes:
            return show_notes[:max_chars]

    description = _clean_sample_text(media.description)
    if description:
        return description[:max_chars]

    return ""


def _clean_sample_text(value: object) -> str:
    if value is None:
        return ""
    text_value = html.unescape(str(value))
    text_value = re.sub(r"(?is)<(script|style)\b[^>]*>.*?</\1>", " ", text_value)
    text_value = re.sub(r"(?s)<[^>]+>", " ", text_value)
    return " ".join(text_value.split())


def _truncate_for_remaining(text_value: str, remaining: int) -> str:
    if remaining <= 0:
        return ""
    if len(text_value) <= remaining:
        return text_value
    return text_value[:remaining].rstrip()


def _heading_summary(raw_heading_path: object) -> str:
    if not isinstance(raw_heading_path, list):
        return ""
    headings = [str(item).strip() for item in raw_heading_path if str(item).strip()]
    return " > ".join(headings[:4])


def _render_indexed_text_sample(rows: Sequence[Any], *, max_chars: int) -> str:
    parts: list[str] = []
    remaining = max_chars
    for ordinal, row in enumerate(rows, start=1):
        idx, kind, heading_path, raw_text = row
        text_value = _clean_sample_text(raw_text)
        if not text_value:
            continue
        heading = _heading_summary(heading_path)
        label = f"[sample {ordinal}: {kind} {idx}]"
        if heading:
            label = f"{label} heading={heading}"
        section = _truncate_for_remaining(f"{label}\n{text_value}", remaining)
        if not section:
            break
        parts.append(section)
        remaining -= len(section) + 2
        if remaining <= 0:
            break
    return "\n\n".join(parts).strip()


def _render_fragment_sample(rows: Sequence[Any], *, max_chars: int) -> str:
    parts: list[str] = []
    remaining = max_chars
    for ordinal, row in enumerate(rows, start=1):
        idx, raw_text = row
        text_value = _clean_sample_text(raw_text)
        if not text_value:
            continue
        section = _truncate_for_remaining(
            f"[fragment {ordinal}: idx {idx}]\n{text_value}", remaining
        )
        if not section:
            break
        parts.append(section)
        remaining -= len(section) + 2
        if remaining <= 0:
            break
    return "\n\n".join(parts).strip()


def _json_prompt_value(value: object) -> str:
    return json.dumps(value, ensure_ascii=True, sort_keys=True)


# ---------------------------------------------------------------------------
# Prompt building
# ---------------------------------------------------------------------------


def build_enrichment_prompt(
    db: Session,
    media: Media,
    content_sample: str,
) -> str:
    """Build context for structured metadata extraction."""
    kind_rule = {
        "epub": (
            "Saved item is an EPUB/book work. Prefer the work title and creators over "
            "filename, archive name, retail wrapper, or catalog chrome."
        ),
        "pdf": (
            "Saved item is a PDF document. Prefer title and author from the first page, "
            "abstract, heading, or real embedded metadata; replace filename titles."
        ),
        "web_article": (
            "Saved item is the primary readable page content. Prefer the article/work "
            "heading over site title, navigation title, SEO title, or generic page title."
        ),
        "video": (
            "Saved item is a video. Title is the video title; publisher is the channel "
            "or platform publisher when available."
        ),
        "podcast_episode": (
            "Saved item is a podcast episode. Title is the episode title; publisher is "
            "the show/podcast. Authors are hosts or creators only when clear."
        ),
    }.get(str(media.kind), "Saved item is the primary media work.")
    metadata_lines = [
        f"- kind: {media.kind}",
        f"- current_title: {_json_prompt_value(media.title)}",
    ]
    if media.requested_url:
        metadata_lines.append(f"- requested_url: {_json_prompt_value(media.requested_url)}")
    if media.canonical_source_url:
        metadata_lines.append(
            f"- canonical_source_url: {_json_prompt_value(media.canonical_source_url)}"
        )
    if media.canonical_url:
        metadata_lines.append(f"- canonical_url: {_json_prompt_value(media.canonical_url)}")
    if media.external_playback_url:
        metadata_lines.append(
            f"- external_playback_url: {_json_prompt_value(media.external_playback_url)}"
        )
    if media.provider:
        metadata_lines.append(f"- provider: {_json_prompt_value(media.provider)}")
    if media.provider_id:
        metadata_lines.append(f"- provider_id: {_json_prompt_value(media.provider_id)}")
    current_authors = get_current_author_names(db, media)
    if current_authors:
        metadata_lines.append(f"- current_authors: {_json_prompt_value(current_authors)}")
    if media.publisher:
        metadata_lines.append(f"- current_publisher: {_json_prompt_value(media.publisher)}")
    if media.published_date:
        metadata_lines.append(
            f"- current_published_date: {_json_prompt_value(media.published_date)}"
        )
    if media.language:
        metadata_lines.append(f"- current_language: {_json_prompt_value(media.language)}")
    if media.description:
        description_hint = _clean_sample_text(media.description)
        if description_hint:
            metadata_lines.append(f"- current_description: {_json_prompt_value(description_hint)}")

    if media.kind == "podcast_episode":
        row = db.execute(
            text(
                """
                SELECT p.title
                FROM podcast_episodes pe
                JOIN podcasts p ON p.id = pe.podcast_id
                WHERE pe.media_id = :media_id
                """
            ),
            {"media_id": media.id},
        ).fetchone()
        if row is not None:
            if row[0]:
                metadata_lines.append(f"- podcast_title: {_json_prompt_value(row[0])}")

    metadata_block = "\n".join(metadata_lines)
    content_block = _clean_sample_text(content_sample) or "(no media text available)"

    prompt = f"""Extract bibliographic and descriptive metadata for this media item.

Known metadata:
{metadata_block}

Media-kind target:
{kind_rule}

Early extracted text:
---
{content_block}
---

Rules:
- Prefer the real work/publication metadata over wrapper-page or filename text
- Treat known metadata as untrusted hints; correct stale, placeholder, wrapper,
  filename-shaped, or low-quality values when source context supports it
- For authors, return an array of full names
- For publisher, prefer the site, publisher, channel, podcast, or publication name
- For published_date, use ISO format (YYYY, YYYY-MM, or YYYY-MM-DD)
- For language, use ISO 639-1 two-letter codes
- For description, write 1-2 sentences summarizing the content
- Use null for fields you cannot determine confidently"""

    return prompt


def get_current_author_names(db: Session, media: Media) -> list[str]:
    """Return current author credits in presentation order."""
    rows = db.execute(
        text(
            """
            SELECT credited_name
            FROM contributor_credits
            WHERE media_id = :media_id
              AND role = 'author'
              AND credited_name IS NOT NULL
              AND btrim(credited_name) <> ''
            ORDER BY ordinal ASC, credited_name ASC
            LIMIT 20
            """
        ),
        {"media_id": media.id},
    ).fetchall()
    return [str(row[0]).strip() for row in rows if str(row[0]).strip()]


# ---------------------------------------------------------------------------
# Structured-output validation
# ---------------------------------------------------------------------------


def validate_structured_enrichment(payload: object) -> dict | None:
    """Validate provider-returned structured metadata and drop null fields."""
    if not isinstance(payload, dict):
        return None
    try:
        parsed = MetadataEnrichmentOutput.model_validate(payload)
    except ValidationError:
        return None
    return parsed.model_dump(exclude_none=True)


# ---------------------------------------------------------------------------
# Enrichment merging
# ---------------------------------------------------------------------------


def merge_enrichment(
    db: Session,
    media: Media,
    enrichment: dict,
) -> MetadataMergeResult:
    """Merge LLM enrichment into media.

    The validated provider payload overwrites every accepted field it includes.
    """
    accepted_fields: list[str] = []

    if "title" in enrichment:
        title = enrichment["title"]
        if isinstance(title, str) and title.strip():
            media.title = title.strip()[:255]
            accepted_fields.append("title")

    if "authors" in enrichment:
        authors = enrichment["authors"]
        if isinstance(authors, list):
            names = [
                name.strip()[:255]
                for name in authors[:20]
                if isinstance(name, str) and name.strip()
            ]
            if names:
                replace_machine_derived_media_author_credits(
                    db,
                    media_id=media.id,
                    names=names,
                    source="metadata_enrichment",
                )
                accepted_fields.append("authors")

    if "publisher" in enrichment:
        publisher = enrichment["publisher"]
        if isinstance(publisher, str) and publisher.strip():
            media.publisher = publisher.strip()[:255]
            accepted_fields.append("publisher")

    if "description" in enrichment:
        desc = enrichment["description"]
        if isinstance(desc, str) and desc.strip():
            media.description = desc.strip()[:2000]
            accepted_fields.append("description")

    if "published_date" in enrichment:
        date = enrichment["published_date"]
        if isinstance(date, str) and date.strip():
            media.published_date = date.strip()[:64]
            accepted_fields.append("published_date")

    if "language" in enrichment:
        lang = enrichment["language"]
        if isinstance(lang, str) and lang.strip():
            media.language = lang.strip()[:32]
            accepted_fields.append("language")

    if accepted_fields:
        now = datetime.now(UTC)
        media.metadata_enriched_at = now
        media.updated_at = now

    return MetadataMergeResult(accepted_fields=tuple(accepted_fields))


# ---------------------------------------------------------------------------
# Provider selection
# ---------------------------------------------------------------------------


def select_enrichment_providers(
    settings: Settings,
) -> list[tuple[str, str]]:
    """Return enabled (provider, model) pairs in reliability-first failover order.

    Key availability is resolved per attempt via ``resolve_api_key``; each model
    setting is asserted catalog-valid here, at task use.
    """
    if not settings.metadata_enrichment_enabled:
        return []

    candidates = [
        ("openai", settings.metadata_enrichment_model_openai, settings.enable_openai),
        ("anthropic", settings.metadata_enrichment_model_anthropic, settings.enable_anthropic),
        ("gemini", settings.metadata_enrichment_model_gemini, settings.enable_gemini),
    ]

    return [
        (provider, require_catalog_model(provider, model).model_name)
        for provider, model, enabled in candidates
        if enabled
    ]
