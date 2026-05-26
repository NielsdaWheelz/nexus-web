"""LLM-based metadata enrichment for media items.

Layer 2 of the two-layer metadata strategy: uses a cheap LLM call to fill
metadata gaps that deterministic extraction (Layer 1) could not resolve.
Only fills null/malformed fields — never overwrites good data.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator
from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.config import Settings, get_settings
from nexus.db.models import Media
from nexus.logging import get_logger
from nexus.services.contributor_credits import replace_media_contributor_credits

logger = get_logger(__name__)


# ---------------------------------------------------------------------------
# Gap detection
# ---------------------------------------------------------------------------

_FILENAME_EXTENSIONS = re.compile(r"\.(pdf|epub|doc|docx|txt|html|htm)$", re.IGNORECASE)


@dataclass(frozen=True)
class MetadataGaps:
    """Which metadata fields are missing or look like placeholders."""

    title_looks_like_filename: bool = False
    authors_missing: bool = False
    publisher_missing: bool = False
    description_missing: bool = False
    published_date_missing: bool = False
    language_missing: bool = False


@dataclass(frozen=True)
class MetadataMergeResult:
    """Observable outcome of applying one validated enrichment payload."""

    accepted_fields: tuple[str, ...]


class MetadataEnrichmentOutput(BaseModel):
    """Strict model-facing metadata contract."""

    model_config = ConfigDict(extra="forbid", strict=True)

    title: str | None = Field(default=None, max_length=255)
    authors: list[str] | None = Field(default=None, max_length=20)
    publisher: str | None = Field(default=None, max_length=255)
    description: str | None = Field(default=None, max_length=2000)
    published_date: str | None = Field(default=None, max_length=64)
    language: str | None = Field(default=None, max_length=32)

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


def detect_metadata_gaps(media: Media) -> MetadataGaps:
    """Check which metadata fields are missing or malformed."""
    title = str(media.title or "").strip()
    title_looks_like_filename = bool(title and _FILENAME_EXTENSIONS.search(title))
    if title.startswith("YouTube Video ") or title in {"Untitled", "Untitled Episode"}:
        title_looks_like_filename = True

    authors_missing = not media.contributor_credits

    return MetadataGaps(
        title_looks_like_filename=title_looks_like_filename,
        authors_missing=authors_missing,
        publisher_missing=not media.publisher,
        description_missing=not media.description,
        published_date_missing=not media.published_date,
        language_missing=not media.language,
    )


def has_any_gaps(gaps: MetadataGaps) -> bool:
    """Return True if any metadata gap exists."""
    return (
        gaps.title_looks_like_filename
        or gaps.authors_missing
        or gaps.publisher_missing
        or gaps.description_missing
        or gaps.published_date_missing
        or gaps.language_missing
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
            JOIN media_content_index_states mcis
              ON mcis.media_id = cc.media_id
             AND mcis.active_run_id = cc.index_run_id
            JOIN content_index_runs cir
              ON cir.id = cc.index_run_id
             AND cir.state = 'ready'
             AND cir.deactivated_at IS NULL
            WHERE cc.media_id = :media_id
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
            JOIN media_content_index_states mcis
              ON mcis.media_id = cb.media_id
             AND mcis.active_run_id = cb.index_run_id
            JOIN content_index_runs cir
              ON cir.id = cb.index_run_id
             AND cir.state = 'ready'
             AND cir.deactivated_at IS NULL
            WHERE cb.media_id = :media_id
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
    return str(value).strip()


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


def _render_indexed_text_sample(rows: list[Any], *, max_chars: int) -> str:
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


def _render_fragment_sample(rows: list[Any], *, max_chars: int) -> str:
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
    gaps: MetadataGaps,
) -> str:
    """Build a structured prompt requesting JSON for only the missing fields."""
    requested_fields: list[str] = []
    if gaps.title_looks_like_filename:
        requested_fields.append('"title": "the actual document title"')
    if gaps.authors_missing:
        requested_fields.append('"authors": ["Author Name", ...]')
    if gaps.publisher_missing:
        requested_fields.append('"publisher": "publisher, site, channel, or show name"')
    if gaps.description_missing:
        requested_fields.append('"description": "1-2 sentence summary"')
    if gaps.published_date_missing:
        requested_fields.append('"published_date": "YYYY or YYYY-MM-DD"')
    if gaps.language_missing:
        requested_fields.append('"language": "ISO 639-1 code like en, fr, de"')

    fields_str = ",\n  ".join(requested_fields)
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
        metadata_lines.append(f"- current_description: {_json_prompt_value(media.description)}")

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
    content_block = content_sample or "(no media text available)"

    prompt = f"""Extract bibliographic and descriptive metadata for this media item.

Known metadata:
{metadata_block}

Early extracted text:
---
{content_block}
---

Return exactly one compact JSON object with only these keys when you can determine them with confidence:
{{
  {fields_str}
}}

Rules:
- Use the known metadata first, then the content sample
- Prefer the real work/publication metadata over wrapper-page or filename text
- For authors, return an array of full names
- For publisher, prefer the site, publisher, channel, podcast, or publication name
- For published_date, use ISO format (YYYY, YYYY-MM, or YYYY-MM-DD)
- For language, use ISO 639-1 two-letter codes
- For description, write 1-2 sentences summarizing the content
- If you cannot determine a field, omit it from the response
- Do not include null values, comments, markdown, or explanatory prose
- The first character of your response must be {{ and the last character must be }}"""

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
# Response parsing
# ---------------------------------------------------------------------------


def parse_enrichment_response(raw_text: str) -> dict | None:
    """Parse and validate a model metadata payload."""
    text_stripped = raw_text.strip()

    # Strip markdown code block wrapper if present (```json ... ``` or ``` ... ```)
    code_block = re.match(r"^```(?:\w*)\n(.*?)```\s*$", text_stripped, re.DOTALL)
    if code_block:
        text_stripped = code_block.group(1).strip()

    payload = _load_json_object(text_stripped)
    if payload is None:
        extracted = _extract_first_json_object(text_stripped)
        payload = _load_json_object(extracted) if extracted else None
    if payload is None:
        return None

    try:
        parsed = MetadataEnrichmentOutput.model_validate(payload)
    except ValidationError:
        return None
    return parsed.model_dump(exclude_none=True)


def _load_json_object(text_value: str) -> dict[str, Any] | None:
    try:
        result = json.loads(text_value)
        if isinstance(result, dict):
            return result
    except json.JSONDecodeError:
        pass
    return None


def _extract_first_json_object(text_value: str) -> str | None:
    """Return the first balanced JSON object substring, if one exists."""
    start = text_value.find("{")
    if start < 0:
        return None

    depth = 0
    in_string = False
    escaped = False
    for index, char in enumerate(text_value[start:], start=start):
        if in_string:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
            continue

        if char == '"':
            in_string = True
        elif char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return text_value[start : index + 1]
    return None


# ---------------------------------------------------------------------------
# Enrichment merging
# ---------------------------------------------------------------------------


def merge_enrichment(
    db: Session,
    media: Media,
    enrichment: dict,
    gaps: MetadataGaps,
    *,
    force_overwrite: bool = False,
) -> MetadataMergeResult:
    """Merge LLM enrichment into media.

    By default only fills null/malformed fields (gap-driven). When
    `force_overwrite=True`, the LLM-provided value replaces existing data
    on each branch (length caps and type checks still enforced).
    """
    accepted_fields: list[str] = []

    if (force_overwrite or gaps.title_looks_like_filename) and "title" in enrichment:
        title = enrichment["title"]
        if isinstance(title, str) and title.strip():
            media.title = title.strip()[:255]
            accepted_fields.append("title")

    if (force_overwrite or gaps.authors_missing) and "authors" in enrichment:
        authors = enrichment["authors"]
        if isinstance(authors, list):
            credits = [
                {
                    "name": name.strip()[:255],
                    "role": "author",
                    "ordinal": i,
                    "source": "metadata_enrichment",
                }
                for i, name in enumerate(authors[:20])
                if isinstance(name, str) and name.strip()
            ]
            if credits:
                replace_media_contributor_credits(
                    db,
                    media_id=media.id,
                    source="metadata_enrichment",
                    credits=credits,
                )
                accepted_fields.append("authors")

    if (force_overwrite or gaps.publisher_missing) and "publisher" in enrichment:
        publisher = enrichment["publisher"]
        if isinstance(publisher, str) and publisher.strip():
            media.publisher = publisher.strip()[:255]
            accepted_fields.append("publisher")

    if (force_overwrite or gaps.description_missing) and "description" in enrichment:
        desc = enrichment["description"]
        if isinstance(desc, str) and desc.strip():
            media.description = desc.strip()[:2000]
            accepted_fields.append("description")

    if (force_overwrite or gaps.published_date_missing) and "published_date" in enrichment:
        date = enrichment["published_date"]
        if isinstance(date, str) and date.strip():
            media.published_date = date.strip()[:64]
            accepted_fields.append("published_date")

    if (force_overwrite or gaps.language_missing) and "language" in enrichment:
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
) -> list[tuple[str, str, str]]:
    """Return available providers in reliability-first fallback order."""
    if not settings.metadata_enrichment_enabled:
        return []

    candidates = [
        (
            "openai",
            settings.metadata_enrichment_model_openai,
            settings.openai_api_key,
            settings.enable_openai,
        ),
        (
            "anthropic",
            settings.metadata_enrichment_model_anthropic,
            settings.anthropic_api_key,
            settings.enable_anthropic,
        ),
        (
            "gemini",
            settings.metadata_enrichment_model_gemini,
            settings.gemini_api_key,
            settings.enable_gemini,
        ),
    ]

    return [
        (provider, model, api_key)
        for provider, model, api_key, enabled in candidates
        if enabled and api_key
    ]


def select_enrichment_provider(
    settings: Settings,
) -> tuple[str, str, str] | None:
    """Return the first configured provider for legacy callers/tests."""
    providers = select_enrichment_providers(settings)
    if providers:
        return providers[0]

    return None
