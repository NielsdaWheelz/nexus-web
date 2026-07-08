"""Contributor-credit normalization, writes, and batch reads."""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any, cast
from uuid import UUID

from sqlalchemy import bindparam, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Session

from nexus.jobs.queue import enqueue_job
from nexus.schemas.contributors import (
    ContributorCreditOut,
    ContributorResolutionStatus,
    ContributorRole,
)
from nexus.services.contributor_taxonomy import (
    CONFIRMED_ALIAS_SOURCES,
    STRONG_CONTRIBUTOR_EXTERNAL_ID_AUTHORITIES,
    display_contributor_name,
    normalize_contributor_name,
    normalize_contributor_role,
    normalize_resolution_status,
)
from nexus.services.contributors import (
    ContributorExternalIdEvidence,
    ContributorResolutionInput,
    contributor_handle_for_name,
    resolve_or_create_contributor,
)

PRESERVED_MEDIA_AUTHOR_CREDIT_SOURCES = frozenset({"manual", "curated", "user"})
MACHINE_DERIVED_MEDIA_AUTHOR_CREDIT_SOURCES = frozenset(
    {
        "epub_opf",
        "metadata_enrichment",
        "podcast_index",
        "pdf_metadata",
        "rss",
        "web_article_byline",
        "web_article_capture",
        "x_api_author_thread",
        "x_api_quoted_post",
        "youtube_metadata",
    }
)
CONTRIBUTOR_RECONCILIATION_JOB_KIND = "contributor_reconciliation"


def replace_media_contributor_credits(
    db: Session,
    *,
    media_id: UUID,
    credits: list[dict[str, Any]],
    source: str | None = None,
) -> None:
    if _replace_credits(db, "media_id", media_id, credits, source=source):
        _enqueue_contributor_reconciliation_for_media(
            db,
            media_id=media_id,
            reason=_reconciliation_reason(source),
        )


def replace_machine_derived_media_author_credits(
    db: Session,
    *,
    media_id: UUID,
    names: list[str],
    source: str,
    source_ref: dict[str, Any] | None = None,
) -> None:
    """Replace machine-derived media author credits while preserving curated edits.

    This is for extractor/provider/LLM author lanes. It deletes existing
    machine-derived author credits for the media item, never manual/user/curated
    author credits, then inserts the normalized unique input names under
    ``source``.
    """
    normalized_source = _normalize_credit_source(source)
    if normalized_source in PRESERVED_MEDIA_AUTHOR_CREDIT_SOURCES:
        raise ValueError("machine-derived media author credit source cannot be manual/user/curated")

    credits: list[dict[str, Any]] = []
    seen_names: set[str] = set()
    for raw_name in names:
        credited_name = display_contributor_name(raw_name)[:255]
        if not credited_name:
            continue
        normalized_name = normalize_contributor_name(credited_name)
        if normalized_name in seen_names:
            continue
        seen_names.add(normalized_name)
        credit: dict[str, Any] = {
            "name": credited_name,
            "role": "author",
            "ordinal": len(credits),
            "source": normalized_source,
        }
        if source_ref is not None:
            credit["source_ref"] = source_ref
        credits.append(credit)

    existing_rows = db.execute(
        text(
            """
            SELECT
                cc.id,
                cc.source,
                cc.normalized_credited_name,
                cc.contributor_id,
                cc.resolution_status,
                c.status
            FROM contributor_credits cc
            LEFT JOIN contributors c ON c.id = cc.contributor_id
            WHERE cc.media_id = :media_id
              AND cc.role = 'author'
              AND cc.source = ANY(:machine_sources)
              AND cc.source != ALL(:preserved_sources)
            """
        ),
        {
            "media_id": media_id,
            "machine_sources": sorted(MACHINE_DERIVED_MEDIA_AUTHOR_CREDIT_SOURCES),
            "preserved_sources": sorted(PRESERVED_MEDIA_AUTHOR_CREDIT_SOURCES),
        },
    ).fetchall()
    previous_contributors = _previous_contributors_by_source_name(existing_rows)
    db.execute(
        text(
            """
            DELETE FROM contributor_credits
            WHERE media_id = :media_id
              AND role = 'author'
              AND source = ANY(:machine_sources)
              AND source != ALL(:preserved_sources)
            """
        ),
        {
            "media_id": media_id,
            "machine_sources": sorted(MACHINE_DERIVED_MEDIA_AUTHOR_CREDIT_SOURCES),
            "preserved_sources": sorted(PRESERVED_MEDIA_AUTHOR_CREDIT_SOURCES),
        },
    )
    touched = bool(existing_rows or credits)
    if credits:
        _insert_credits(
            db,
            "media_id",
            media_id,
            credits,
            source_filter=normalized_source,
            previous_contributors=previous_contributors,
        )
    if touched:
        _enqueue_contributor_reconciliation_for_media(
            db,
            media_id=media_id,
            reason=_reconciliation_reason(normalized_source),
        )


def replace_podcast_contributor_credits(
    db: Session,
    *,
    podcast_id: UUID,
    credits: list[dict[str, Any]],
    source: str | None = None,
) -> None:
    if _replace_credits(db, "podcast_id", podcast_id, credits, source=source):
        _enqueue_contributor_reconciliation_for_podcast(
            db,
            podcast_id=podcast_id,
            reason=_reconciliation_reason(source),
        )


def replace_gutenberg_contributor_credits(
    db: Session,
    *,
    ebook_id: int,
    credits: list[dict[str, Any]],
    source: str | None = None,
) -> None:
    _replace_credits(db, "project_gutenberg_catalog_ebook_id", ebook_id, credits, source=source)


def load_contributor_credits_for_media(
    db: Session,
    media_ids: list[UUID],
) -> dict[UUID, list[ContributorCreditOut]]:
    credits_by_media: dict[UUID, list[ContributorCreditOut]] = {
        media_id: [] for media_id in media_ids
    }
    if not media_ids:
        return credits_by_media

    rows = db.execute(
        text(
            """
            SELECT
                cc.media_id,
                cc.id,
                c.handle,
                c.display_name,
                cc.credited_name,
                cc.role,
                cc.raw_role,
                cc.ordinal,
                cc.source,
                cc.resolution_status,
                cc.confidence
            FROM contributor_credits cc
            JOIN contributors c ON c.id = cc.contributor_id
            WHERE cc.media_id = ANY(:media_ids)
              AND c.status IN ('unverified', 'verified')
            ORDER BY cc.media_id ASC, cc.ordinal ASC, cc.created_at ASC, cc.id ASC
            """
        ),
        {"media_ids": media_ids},
    ).fetchall()
    for row in rows:
        credits_by_media.setdefault(UUID(str(row[0])), []).append(_credit_out(row))
    return credits_by_media


def load_contributor_credits_for_podcasts(
    db: Session,
    podcast_ids: list[UUID],
) -> dict[UUID, list[ContributorCreditOut]]:
    credits_by_podcast: dict[UUID, list[ContributorCreditOut]] = {
        podcast_id: [] for podcast_id in podcast_ids
    }
    if not podcast_ids:
        return credits_by_podcast

    rows = db.execute(
        text(
            """
            SELECT
                cc.podcast_id,
                cc.id,
                c.handle,
                c.display_name,
                cc.credited_name,
                cc.role,
                cc.raw_role,
                cc.ordinal,
                cc.source,
                cc.resolution_status,
                cc.confidence
            FROM contributor_credits cc
            JOIN contributors c ON c.id = cc.contributor_id
            WHERE cc.podcast_id = ANY(:podcast_ids)
              AND c.status IN ('unverified', 'verified')
            ORDER BY cc.podcast_id ASC, cc.ordinal ASC, cc.created_at ASC, cc.id ASC
            """
        ),
        {"podcast_ids": podcast_ids},
    ).fetchall()
    for row in rows:
        credits_by_podcast.setdefault(UUID(str(row[0])), []).append(_credit_out(row))
    return credits_by_podcast


def upstream_contributor_credit_previews_for_names(
    db: Session,
    names: list[str],
    *,
    role: str = "author",
    source: str = "local",
) -> list[ContributorCreditOut]:
    credits: list[ContributorCreditOut] = []
    seen: set[str] = set()
    for raw_name in names:
        credited_name = display_contributor_name(raw_name)
        if not credited_name:
            continue
        normalized_name = normalize_contributor_name(credited_name)
        if normalized_name in seen:
            continue
        seen.add(normalized_name)
        row = _resolve_preview_contributor(db, normalized_name)
        if row is None:
            contributor_handle = contributor_handle_for_name(normalized_name)
            contributor_display_name = credited_name
            resolution_status = "unverified"
        else:
            contributor_handle, contributor_display_name, resolution_status = row
        credits.append(
            ContributorCreditOut(
                contributor_handle=contributor_handle,
                contributor_display_name=contributor_display_name,
                href=f"/authors/{contributor_handle}",
                credited_name=credited_name,
                role=cast(ContributorRole, normalize_contributor_role(role)),
                raw_role=None,
                ordinal=len(credits),
                source=source,
                resolution_status=cast(ContributorResolutionStatus, resolution_status),
            )
        )
    return credits


def _resolve_preview_contributor(db: Session, normalized_name: str) -> tuple[str, str, str] | None:
    rows = db.execute(
        text(
            """
            SELECT
                c.id,
                c.handle,
                c.display_name,
                'confirmed_alias' AS resolution_status,
                bool_or(ca.is_primary) AS has_primary,
                min(c.created_at) AS created_at
            FROM contributor_aliases ca
            JOIN contributors c ON c.id = ca.contributor_id
            WHERE ca.normalized_alias = :normalized_name
              AND ca.source = ANY(:confirmed_alias_sources)
              AND c.status IN ('unverified', 'verified')
            GROUP BY c.id, c.handle, c.display_name
            ORDER BY has_primary DESC, created_at ASC, c.id ASC
            LIMIT 2
            """
        ),
        {
            "normalized_name": normalized_name,
            "confirmed_alias_sources": sorted(CONFIRMED_ALIAS_SOURCES),
        },
    ).fetchall()
    if len(rows) == 1:
        row = rows[0]
        return row[1], row[2], row[3]
    return None


def _replace_credits(
    db: Session,
    target_column: str,
    target_id: UUID | int,
    credits: list[dict[str, Any]],
    *,
    source: str | None,
) -> bool:
    source_filter = _normalize_credit_source(source) if source is not None else None
    replacement_sources = (
        [source_filter] if source_filter is not None else _replacement_sources(credits)
    )
    if not replacement_sources:
        return False
    existing_rows = db.execute(
        text(
            f"""
            SELECT
                cc.id,
                cc.source,
                cc.normalized_credited_name,
                cc.contributor_id,
                cc.resolution_status,
                c.status
            FROM contributor_credits cc
            LEFT JOIN contributors c ON c.id = cc.contributor_id
            WHERE cc.{target_column} = :target_id
              AND cc.source = ANY(:replacement_sources)
            """
        ),
        {"target_id": target_id, "replacement_sources": replacement_sources},
    ).fetchall()
    existing_ids = [row[0] for row in existing_rows]
    previous_contributors = _previous_contributors_by_source_name(existing_rows)
    if existing_ids:
        db.execute(
            text(
                """
                DELETE FROM contributor_credits
                WHERE id = ANY(:existing_ids)
                """
            ),
            {"existing_ids": existing_ids},
        )
        remaining = db.execute(
            text(
                """
                SELECT count(*)
                FROM contributor_credits
                WHERE id = ANY(:existing_ids)
                """
            ),
            {"existing_ids": existing_ids},
        ).scalar_one()
        if remaining != 0:
            raise RuntimeError("Unexpected contributor credit delete count")

    touched = bool(existing_ids or credits)
    _insert_credits(
        db,
        target_column,
        target_id,
        credits,
        source_filter=source_filter,
        previous_contributors=previous_contributors,
    )
    return touched


def _previous_contributors_by_source_name(
    existing_rows: Sequence[Any],
) -> dict[tuple[str, str], tuple[UUID, str] | None]:
    previous_contributors: dict[tuple[str, str], tuple[UUID, str] | None] = {}
    for row in existing_rows:
        if row[5] not in ("unverified", "verified"):
            continue
        key = (row[1], row[2])
        value = (
            row[3],
            normalize_resolution_status(row[4], default="unverified"),
        )
        if key in previous_contributors:
            existing_value = previous_contributors[key]
            if existing_value is not None and existing_value[0] != row[3]:
                previous_contributors[key] = None
            continue
        previous_contributors[key] = value
    return previous_contributors


def _insert_credits(
    db: Session,
    target_column: str,
    target_id: UUID | int,
    credits: list[dict[str, Any]],
    *,
    source_filter: str | None,
    previous_contributors: dict[tuple[str, str], tuple[UUID, str] | None],
) -> None:
    for fallback_ordinal, credit in enumerate(credits):
        credited_name = display_contributor_name(
            str(credit.get("credited_name") or credit.get("name") or "")
        )
        if not credited_name:
            continue
        credit_source = (
            source_filter
            if source_filter is not None
            else _normalize_credit_source(credit.get("source"))
        )
        normalized_credited_name = normalize_contributor_name(credited_name)
        resolution_input = _resolution_input_from_credit(
            credit, credited_name=credited_name, source=credit_source
        )
        has_identity_hint = (
            resolution_input.explicit_id is not None
            or resolution_input.explicit_handle is not None
            or bool(resolution_input.external_ids)
        )
        previous_contributor = (
            None
            if has_identity_hint
            else previous_contributors.get((credit_source, normalized_credited_name))
        )
        if previous_contributor is not None:
            contributor_id, resolution_status = previous_contributor
        else:
            resolution = resolve_or_create_contributor(db, resolution_input)
            contributor_id = resolution.contributor_id
            resolution_status = resolution.resolution_status
        ordinal_value = credit.get("ordinal")
        db.execute(
            text(
                f"""
                INSERT INTO contributor_credits (
                    contributor_id,
                    {target_column},
                    credited_name,
                    normalized_credited_name,
                    role,
                    raw_role,
                    ordinal,
                    source,
                    source_ref,
                    resolution_status,
                    confidence
                )
                VALUES (
                    :contributor_id,
                    :target_id,
                    :credited_name,
                    :normalized_credited_name,
                    :role,
                    :raw_role,
                    :ordinal,
                    :source,
                    :source_ref,
                    :resolution_status,
                    :confidence
                )
                """
            ).bindparams(bindparam("source_ref", type_=JSONB)),
            {
                "contributor_id": contributor_id,
                "target_id": target_id,
                "credited_name": credited_name,
                "normalized_credited_name": normalized_credited_name,
                "role": normalize_contributor_role(
                    str(credit["role"]) if credit.get("role") is not None else None
                ),
                "raw_role": str(credit["raw_role"]) if credit.get("raw_role") is not None else None,
                "ordinal": int(ordinal_value) if ordinal_value is not None else fallback_ordinal,
                "source": credit_source,
                "source_ref": _source_ref(credit),
                "resolution_status": resolution_status,
                "confidence": credit.get("confidence"),
            },
        )


def _replacement_sources(credits: list[dict[str, Any]]) -> list[str]:
    sources: list[str] = []
    seen: set[str] = set()
    for credit in credits:
        source = _normalize_credit_source(credit.get("source"))
        if source in seen:
            continue
        sources.append(source)
        seen.add(source)
    return sources


def _normalize_credit_source(value: Any) -> str:
    return str(value or "local").strip() or "local"


def _reconciliation_reason(source: str | None) -> str:
    return f"contributor_credit_replace:{_normalize_credit_source(source)}"


def _enqueue_contributor_reconciliation_for_media(
    db: Session,
    *,
    media_id: UUID,
    reason: str,
) -> None:
    enqueue_job(
        db,
        kind=CONTRIBUTOR_RECONCILIATION_JOB_KIND,
        payload={
            "scope": "media",
            "media_id": str(media_id),
            "reason": reason,
            "request_id": None,
        },
        max_attempts=3,
    )


def _enqueue_contributor_reconciliation_for_podcast(
    db: Session,
    *,
    podcast_id: UUID,
    reason: str,
) -> None:
    enqueue_job(
        db,
        kind=CONTRIBUTOR_RECONCILIATION_JOB_KIND,
        payload={
            "scope": "podcast",
            "podcast_id": str(podcast_id),
            "reason": reason,
            "request_id": None,
        },
        max_attempts=3,
    )


def _source_ref(credit: dict[str, Any]) -> dict[str, Any]:
    source_ref = credit.get("source_ref") or credit.get("sourceRef")
    return source_ref if isinstance(source_ref, dict) else {}


def _resolution_input_from_credit(
    credit: dict[str, Any], *, credited_name: str, source: str
) -> ContributorResolutionInput:
    explicit_handle = str(
        credit.get("contributor_handle") or credit.get("contributorHandle") or ""
    ).strip()
    return ContributorResolutionInput(
        credited_name=credited_name,
        source=source,
        explicit_id=_parse_optional_uuid(
            credit.get("contributor_id") or credit.get("contributorId")
        ),
        explicit_handle=explicit_handle or None,
        external_ids=_strong_external_id_evidence(credit),
    )


def _parse_optional_uuid(value: Any) -> UUID | None:
    if value is None:
        return None
    try:
        return UUID(str(value))
    except ValueError:
        return None


def _strong_external_id_evidence(
    credit: dict[str, Any],
) -> tuple[ContributorExternalIdEvidence, ...]:
    # Identity evidence comes only from explicit external_id/external_ids fields with a strong
    # authority. source_ref is provenance and is never scanned for identity (Finding 9 / D-EXT).
    candidates: list[Any] = [credit.get("external_id") or credit.get("externalId")]
    listed = credit.get("external_ids") or credit.get("externalIds")
    if isinstance(listed, list):
        candidates.extend(listed)
    evidence: list[ContributorExternalIdEvidence] = []
    for candidate in candidates:
        if not isinstance(candidate, dict):
            continue
        authority = str(candidate.get("authority") or "").strip().lower()
        external_key = str(
            candidate.get("external_key")
            or candidate.get("externalKey")
            or candidate.get("key")
            or candidate.get("id")
            or ""
        ).strip()
        if authority not in STRONG_CONTRIBUTOR_EXTERNAL_ID_AUTHORITIES or not external_key:
            continue
        external_url_value = candidate.get("external_url") or candidate.get("externalUrl")
        evidence.append(
            ContributorExternalIdEvidence(
                authority=authority,
                external_key=external_key,
                external_url=str(external_url_value).strip() if external_url_value else None,
            )
        )
    return tuple(evidence)


def _credit_out(row: Any) -> ContributorCreditOut:
    return ContributorCreditOut(
        id=row[1],
        contributor_handle=row[2],
        contributor_display_name=row[3],
        href=f"/authors/{row[2]}",
        credited_name=row[4],
        role=row[5],
        raw_role=row[6],
        ordinal=int(row[7]),
        source=row[8],
        resolution_status=row[9],
        confidence=row[10],
    )
