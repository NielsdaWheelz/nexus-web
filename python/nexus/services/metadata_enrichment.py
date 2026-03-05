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

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.config import Settings, get_settings
from nexus.db.models import Media, MediaAuthor
from nexus.logging import get_logger

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
    description_missing: bool = False
    published_date_missing: bool = False
    language_missing: bool = False


def detect_metadata_gaps(media: Media) -> MetadataGaps:
    """Check which metadata fields are missing or malformed."""
    title_looks_like_filename = bool(
        media.title and _FILENAME_EXTENSIONS.search(media.title)
    )

    # Check if authors exist via the relationship
    authors_missing = not media.authors

    return MetadataGaps(
        title_looks_like_filename=title_looks_like_filename,
        authors_missing=authors_missing,
        description_missing=not media.description,
        published_date_missing=not media.published_date,
        language_missing=not media.language,
    )


def has_any_gaps(gaps: MetadataGaps) -> bool:
    """Return True if any metadata gap exists."""
    return (
        gaps.title_looks_like_filename
        or gaps.authors_missing
        or gaps.description_missing
        or gaps.published_date_missing
        or gaps.language_missing
    )


# ---------------------------------------------------------------------------
# Content sampling
# ---------------------------------------------------------------------------


def get_content_sample(db: Session, media: Media) -> str:
    """Get first ~N chars of content for LLM enrichment prompt."""
    settings = get_settings()
    max_chars = settings.metadata_enrichment_max_content_chars

    # PDF: use plain_text
    if media.plain_text:
        return media.plain_text[:max_chars]

    # EPUB/Web: use first fragment's canonical_text
    row = db.execute(
        text(
            "SELECT canonical_text FROM fragments "
            "WHERE media_id = :media_id ORDER BY idx LIMIT 1"
        ),
        {"media_id": media.id},
    ).fetchone()

    if row and row[0]:
        return row[0][:max_chars]

    return ""


# ---------------------------------------------------------------------------
# Prompt building
# ---------------------------------------------------------------------------


def build_enrichment_prompt(
    media: Media, content_sample: str, gaps: MetadataGaps
) -> str:
    """Build a structured prompt requesting JSON for only the missing fields."""
    requested_fields: list[str] = []
    if gaps.title_looks_like_filename:
        requested_fields.append('"title": "the actual document title"')
    if gaps.authors_missing:
        requested_fields.append('"authors": ["Author Name", ...]')
    if gaps.description_missing:
        requested_fields.append('"description": "1-2 sentence summary"')
    if gaps.published_date_missing:
        requested_fields.append('"published_date": "YYYY or YYYY-MM-DD"')
    if gaps.language_missing:
        requested_fields.append('"language": "ISO 639-1 code like en, fr, de"')

    fields_str = ",\n  ".join(requested_fields)

    prompt = f"""Extract metadata from this document. The current title is: "{media.title}"

Content sample:
---
{content_sample}
---

Return ONLY a JSON object with these fields (include only if you can determine them with confidence):
{{
  {fields_str}
}}

Rules:
- For authors, return an array of full names
- For published_date, use ISO format (YYYY, YYYY-MM, or YYYY-MM-DD)
- For language, use ISO 639-1 two-letter codes
- For description, write 1-2 sentences summarizing the content
- If you cannot determine a field, omit it from the response
- Return ONLY valid JSON, no markdown code blocks or explanations"""

    return prompt


# ---------------------------------------------------------------------------
# Response parsing
# ---------------------------------------------------------------------------


def parse_enrichment_response(raw_text: str) -> dict | None:
    """Parse LLM response as JSON, handling markdown code blocks."""
    text_stripped = raw_text.strip()

    # Strip markdown code block wrapper if present (```json ... ``` or ``` ... ```)
    code_block = re.match(r"^```(?:\w*)\n(.*?)```\s*$", text_stripped, re.DOTALL)
    if code_block:
        text_stripped = code_block.group(1).strip()

    try:
        result = json.loads(text_stripped)
        if isinstance(result, dict):
            return result
    except json.JSONDecodeError:
        pass

    return None


# ---------------------------------------------------------------------------
# Enrichment merging
# ---------------------------------------------------------------------------


def merge_enrichment(
    db: Session,
    media: Media,
    enrichment: dict,
    gaps: MetadataGaps,
) -> None:
    """Merge LLM enrichment into media, only filling null/malformed fields."""
    if gaps.title_looks_like_filename and "title" in enrichment:
        title = enrichment["title"]
        if isinstance(title, str) and title.strip():
            media.title = title.strip()[:255]

    if gaps.authors_missing and "authors" in enrichment:
        authors = enrichment["authors"]
        if isinstance(authors, list):
            for i, name in enumerate(authors[:20]):
                if isinstance(name, str) and name.strip():
                    db.add(
                        MediaAuthor(
                            media_id=media.id,
                            name=name.strip()[:255],
                            role="author",
                            sort_order=i,
                        )
                    )

    if gaps.description_missing and "description" in enrichment:
        desc = enrichment["description"]
        if isinstance(desc, str) and desc.strip():
            media.description = desc.strip()[:2000]

    if gaps.published_date_missing and "published_date" in enrichment:
        date = enrichment["published_date"]
        if isinstance(date, str) and date.strip():
            media.published_date = date.strip()[:64]

    if gaps.language_missing and "language" in enrichment:
        lang = enrichment["language"]
        if isinstance(lang, str) and lang.strip():
            media.language = lang.strip()[:32]

    media.metadata_enriched_at = datetime.now(UTC)


# ---------------------------------------------------------------------------
# Provider selection
# ---------------------------------------------------------------------------


def select_enrichment_provider(
    settings: Settings,
) -> tuple[str, str, str] | None:
    """Pick cheapest available provider with a configured platform key.

    Returns (provider_name, model_name, api_key) or None if no provider available.
    """
    if not settings.metadata_enrichment_enabled:
        return None

    # Prefer cheapest providers first
    candidates = [
        (
            "gemini",
            settings.metadata_enrichment_model_gemini,
            settings.gemini_api_key,
            settings.enable_gemini,
        ),
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
    ]

    for provider, model, api_key, enabled in candidates:
        if enabled and api_key:
            return (provider, model, api_key)

    return None
