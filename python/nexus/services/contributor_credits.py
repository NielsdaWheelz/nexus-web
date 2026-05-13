"""Contributor-credit normalization, writes, and batch reads."""

from __future__ import annotations

import hashlib
import re
from typing import Any, cast
from uuid import UUID, uuid4

from sqlalchemy import bindparam, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from nexus.schemas.contributors import (
    ContributorCreditOut,
    ContributorResolutionStatus,
    ContributorRole,
)

CONTRIBUTOR_ROLES = {
    "author",
    "editor",
    "translator",
    "host",
    "guest",
    "narrator",
    "creator",
    "producer",
    "publisher",
    "channel",
    "organization",
    "unknown",
}
CONTRIBUTOR_RESOLUTION_STATUSES = {
    "external_id",
    "manual",
    "confirmed_alias",
    "unverified",
}
CONTRIBUTOR_EXTERNAL_ID_AUTHORITIES = {
    "orcid",
    "isni",
    "viaf",
    "wikidata",
    "openalex",
    "lcnaf",
    "podcast_index",
    "rss",
    "youtube",
    "gutenberg",
}
CONFIRMED_ALIAS_SOURCES = {"manual", "curated", "user"}


def normalize_contributor_role(value: str | None) -> str:
    role = " ".join(str(value or "author").strip().lower().replace("_", " ").split())
    return role if role in CONTRIBUTOR_ROLES else "unknown"


def normalize_contributor_name(value: str) -> str:
    return " ".join(value.strip().split()).lower()


def display_contributor_name(value: str) -> str:
    return " ".join(value.strip().split())


def replace_media_contributor_credits(
    db: Session,
    *,
    media_id: UUID,
    credits: list[dict[str, Any]],
    source: str | None = None,
) -> None:
    _replace_credits(db, "media_id", media_id, credits, source=source)


def replace_podcast_contributor_credits(
    db: Session,
    *,
    podcast_id: UUID,
    credits: list[dict[str, Any]],
    source: str | None = None,
) -> None:
    _replace_credits(db, "podcast_id", podcast_id, credits, source=source)


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


def load_contributor_credits_for_gutenberg(
    db: Session,
    ebook_ids: list[int],
) -> dict[int, list[ContributorCreditOut]]:
    credits_by_ebook: dict[int, list[ContributorCreditOut]] = {
        ebook_id: [] for ebook_id in ebook_ids
    }
    if not ebook_ids:
        return credits_by_ebook

    rows = db.execute(
        text(
            """
            SELECT
                cc.project_gutenberg_catalog_ebook_id,
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
            WHERE cc.project_gutenberg_catalog_ebook_id = ANY(:ebook_ids)
              AND c.status IN ('unverified', 'verified')
            ORDER BY cc.project_gutenberg_catalog_ebook_id ASC, cc.ordinal ASC, cc.id ASC
            """
        ),
        {"ebook_ids": ebook_ids},
    ).fetchall()
    for row in rows:
        credits_by_ebook.setdefault(int(row[0]), []).append(_credit_out(row))
    return credits_by_ebook


def contributor_credit_previews_for_names(
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
            continue
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
            contributor_handle = _handle_for_name(normalized_name)
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
) -> None:
    source_filter = _normalize_credit_source(source) if source is not None else None
    replacement_sources = (
        [source_filter] if source_filter is not None else _replacement_sources(credits)
    )
    if not replacement_sources:
        return
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
    previous_contributors: dict[tuple[str, str], tuple[UUID, str] | None] = {}
    for row in existing_rows:
        if row[5] not in ("unverified", "verified"):
            continue
        key = (row[1], row[2])
        value = (
            row[3],
            _normalize_resolution_status(row[4], default="unverified"),
        )
        if key in previous_contributors:
            existing_value = previous_contributors[key]
            if existing_value is not None and existing_value[0] != row[3]:
                previous_contributors[key] = None
            continue
        previous_contributors[key] = value
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
        credit_for_resolution = dict(credit)
        credit_for_resolution["source"] = credit_source
        normalized_credited_name = normalize_contributor_name(credited_name)
        previous_contributor = None
        has_identity_hint = (
            credit_for_resolution.get("contributor_id") is not None
            or credit_for_resolution.get("contributorId") is not None
            or bool(
                str(
                    credit_for_resolution.get("contributor_handle")
                    or credit_for_resolution.get("contributorHandle")
                    or ""
                ).strip()
            )
            or _extract_external_id(credit_for_resolution) is not None
        )
        if not has_identity_hint:
            previous_contributor = previous_contributors.get(
                (credit_source, normalized_credited_name)
            )
        if previous_contributor is not None:
            contributor_id, resolution_status = previous_contributor
        else:
            contributor_id, resolution_status = _resolve_or_create_contributor(
                db,
                credited_name,
                credit_for_resolution,
            )
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
                "source_ref": _source_ref(credit_for_resolution),
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


def _source_ref(credit: dict[str, Any]) -> dict[str, Any]:
    source_ref = credit.get("source_ref") or credit.get("sourceRef")
    return source_ref if isinstance(source_ref, dict) else {}


def _normalize_resolution_status(value: Any, *, default: str) -> str:
    status = str(value or default).strip()
    return status if status in CONTRIBUTOR_RESOLUTION_STATUSES else default


def _resolve_or_create_contributor(
    db: Session,
    credited_name: str,
    credit: dict[str, Any],
) -> tuple[UUID, str]:
    explicit = _resolve_explicit_contributor(db, credit)
    if explicit is not None:
        return explicit, _normalize_resolution_status(
            credit.get("resolution_status"),
            default="manual",
        )

    external_id = _extract_external_id(credit)
    if external_id is not None:
        authority, external_key, external_url = external_id
        row = db.execute(
            text(
                """
                SELECT c.id
                FROM contributor_external_ids cei
                JOIN contributors c ON c.id = cei.contributor_id
                WHERE cei.authority = :authority
                  AND cei.external_key = :external_key
                  AND c.status IN ('unverified', 'verified')
                LIMIT 1
                """
            ),
            {"authority": authority, "external_key": external_key},
        ).fetchone()
        if row is not None:
            return row[0], "external_id"

        try:
            with db.begin_nested():
                contributor_id = _create_unverified_contributor(db, credited_name, credit)
                db.execute(
                    text(
                        """
                        INSERT INTO contributor_external_ids (
                            contributor_id,
                            authority,
                            external_key,
                            external_url,
                            source
                        )
                        VALUES (
                            :contributor_id,
                            :authority,
                            :external_key,
                            :external_url,
                            :source
                        )
                        """
                    ),
                    {
                        "contributor_id": contributor_id,
                        "authority": authority,
                        "external_key": external_key,
                        "external_url": external_url,
                        "source": str(credit.get("source") or "local"),
                    },
                )
                return contributor_id, "external_id"
        except IntegrityError as exc:
            if not _is_contributor_identity_race(exc):
                raise
            row = _select_contributor_by_external_id(db, authority, external_key)
            if row is not None:
                return row, "external_id"
            row = _select_contributor_by_handle(
                db,
                _handle_for_name(normalize_contributor_name(credited_name)),
            )
            if row is None:
                raise
            try:
                with db.begin_nested():
                    db.execute(
                        text(
                            """
                            INSERT INTO contributor_external_ids (
                                contributor_id,
                                authority,
                                external_key,
                                external_url,
                                source
                            )
                            VALUES (
                                :contributor_id,
                                :authority,
                                :external_key,
                                :external_url,
                                :source
                            )
                            """
                        ),
                        {
                            "contributor_id": row,
                            "authority": authority,
                            "external_key": external_key,
                            "external_url": external_url,
                            "source": str(credit.get("source") or "local"),
                        },
                    )
            except IntegrityError as attach_exc:
                if not _is_contributor_external_id_conflict(attach_exc):
                    raise
                external_owner = _select_contributor_by_external_id(db, authority, external_key)
                if external_owner is None:
                    raise
                row = external_owner
            return row, "external_id"

    confirmed_alias = _resolve_confirmed_alias(db, credited_name)
    if confirmed_alias is not None:
        return confirmed_alias, "confirmed_alias"

    return _create_unverified_contributor(db, credited_name, credit), "unverified"


def _resolve_explicit_contributor(db: Session, credit: dict[str, Any]) -> UUID | None:
    contributor_id = credit.get("contributor_id") or credit.get("contributorId")
    if contributor_id is not None:
        try:
            parsed_id = UUID(str(contributor_id))
        except ValueError:
            return None
        row = db.execute(
            text(
                """
                SELECT id
                FROM contributors
                WHERE id = :contributor_id
                  AND status IN ('unverified', 'verified')
                """
            ),
            {"contributor_id": parsed_id},
        ).fetchone()
        return row[0] if row is not None else None

    contributor_handle = str(
        credit.get("contributor_handle") or credit.get("contributorHandle") or ""
    ).strip()
    if not contributor_handle:
        return None
    row = db.execute(
        text(
            """
            SELECT id
            FROM contributors
            WHERE handle = :contributor_handle
              AND status IN ('unverified', 'verified')
            """
        ),
        {"contributor_handle": contributor_handle},
    ).fetchone()
    return row[0] if row is not None else None


def _extract_external_id(credit: dict[str, Any]) -> tuple[str, str, str | None] | None:
    candidates: list[Any] = []
    candidates.append(credit.get("external_id") or credit.get("externalId"))
    external_ids = credit.get("external_ids") or credit.get("externalIds")
    if isinstance(external_ids, list):
        candidates.extend(external_ids)

    source_ref = credit.get("source_ref") or credit.get("sourceRef")
    if isinstance(source_ref, dict):
        candidates.append(source_ref.get("external_id") or source_ref.get("externalId"))
        candidates.append(source_ref)

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
        if authority not in CONTRIBUTOR_EXTERNAL_ID_AUTHORITIES or not external_key:
            continue
        external_url_value = candidate.get("external_url") or candidate.get("externalUrl")
        external_url = str(external_url_value).strip() if external_url_value else None
        return authority, external_key, external_url or None

    return None


def _resolve_confirmed_alias(db: Session, credited_name: str) -> UUID | None:
    normalized_name = normalize_contributor_name(credited_name)
    rows = db.execute(
        text(
            """
            SELECT
                c.id,
                bool_or(ca.is_primary) AS has_primary,
                min(c.created_at) AS created_at
            FROM contributor_aliases ca
            JOIN contributors c ON c.id = ca.contributor_id
            WHERE ca.normalized_alias = :normalized_name
              AND ca.source = ANY(:confirmed_alias_sources)
              AND c.status IN ('unverified', 'verified')
            GROUP BY c.id
            ORDER BY has_primary DESC, created_at ASC, c.id ASC
            LIMIT 2
            """
        ),
        {
            "normalized_name": normalized_name,
            "confirmed_alias_sources": sorted(CONFIRMED_ALIAS_SOURCES),
        },
    ).fetchall()
    return rows[0][0] if len(rows) == 1 else None


def _create_unverified_contributor(
    db: Session,
    credited_name: str,
    credit: dict[str, Any],
) -> UUID:
    normalized_name = normalize_contributor_name(credited_name)
    handle = unique_contributor_handle_for_name(db, normalized_name)
    contributor_id = uuid4()
    try:
        with db.begin_nested():
            db.execute(
                text(
                    """
                    INSERT INTO contributors (id, handle, display_name, sort_name, kind, status)
                    VALUES (:id, :handle, :display_name, :sort_name, 'unknown', 'unverified')
                    """
                ),
                {
                    "id": contributor_id,
                    "handle": handle,
                    "display_name": credited_name,
                    "sort_name": credited_name,
                },
            )
            db.execute(
                text(
                    """
                    INSERT INTO contributor_aliases (
                        contributor_id,
                        alias,
                        normalized_alias,
                        alias_kind,
                        source,
                        is_primary
                    )
                    VALUES (
                        :contributor_id,
                        :alias,
                        :normalized_alias,
                        'display',
                        :source,
                        true
                    )
                    """
                ),
                {
                    "contributor_id": contributor_id,
                    "alias": credited_name,
                    "normalized_alias": normalized_name,
                    "source": str(credit.get("source") or "local"),
                },
            )
            return contributor_id
    except IntegrityError as exc:
        if not _is_contributor_handle_conflict(exc):
            raise
        row = _select_contributor_by_handle(db, handle)
        if row is None:
            raise
        return row


def unique_contributor_handle_for_name(db: Session, normalized_name: str) -> str:
    base_handle = _handle_for_name(normalized_name)
    handle = base_handle
    while True:
        row = db.execute(
            text("SELECT 1 FROM contributors WHERE handle = :handle"),
            {"handle": handle},
        ).fetchone()
        if row is None:
            return handle
        handle = f"{base_handle}-{uuid4().hex[:8]}"


def _handle_for_name(normalized_name: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", normalized_name).strip("-") or "contributor"
    suffix = hashlib.md5(normalized_name.encode("utf-8")).hexdigest()[:8]
    return f"{slug[:48]}-{suffix}"


def _select_contributor_by_external_id(
    db: Session,
    authority: str,
    external_key: str,
) -> UUID | None:
    row = db.execute(
        text(
            """
            SELECT c.id
            FROM contributor_external_ids cei
            JOIN contributors c ON c.id = cei.contributor_id
            WHERE cei.authority = :authority
              AND cei.external_key = :external_key
              AND c.status IN ('unverified', 'verified')
            LIMIT 1
            """
        ),
        {"authority": authority, "external_key": external_key},
    ).fetchone()
    return row[0] if row is not None else None


def _select_contributor_by_handle(db: Session, handle: str) -> UUID | None:
    row = db.execute(
        text(
            """
            SELECT id
            FROM contributors
            WHERE handle = :handle
              AND status IN ('unverified', 'verified')
            """
        ),
        {"handle": handle},
    ).fetchone()
    return row[0] if row is not None else None


def _is_contributor_identity_race(exc: IntegrityError) -> bool:
    return _is_contributor_handle_conflict(exc) or _is_contributor_external_id_conflict(exc)


def _is_contributor_handle_conflict(exc: IntegrityError) -> bool:
    return _integrity_constraint_name(exc) == "uq_contributors_handle"


def _is_contributor_external_id_conflict(exc: IntegrityError) -> bool:
    return _integrity_constraint_name(exc) == "uq_contributor_external_ids_authority_key"


def _integrity_constraint_name(exc: IntegrityError) -> str | None:
    orig = getattr(exc, "orig", None)
    constraint_name = getattr(getattr(orig, "diag", None), "constraint_name", None)
    if constraint_name:
        return str(constraint_name)
    message = str(orig or exc)
    if "uq_contributors_handle" in message:
        return "uq_contributors_handle"
    if "uq_contributor_external_ids_authority_key" in message:
        return "uq_contributor_external_ids_authority_key"
    return None


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
