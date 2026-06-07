"""Library intelligence read, refresh, and build service."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any, cast
from uuid import UUID

from sqlalchemy import bindparam, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from nexus.auth.permissions import is_library_member
from nexus.db.session import transaction
from nexus.errors import ApiErrorCode, NotFoundError
from nexus.jobs.queue import enqueue_unique_job
from nexus.schemas.library_intelligence import (
    LibraryIntelligenceArtifactOut,
    LibraryIntelligenceBuildOut,
    LibraryIntelligenceClaimOut,
    LibraryIntelligenceCoverageOut,
    LibraryIntelligenceEvidenceOut,
    LibraryIntelligenceOut,
    LibraryIntelligenceRefreshOut,
    LibraryIntelligenceSectionOut,
)

ARTIFACT_KIND = "overview"
BUILD_JOB_KIND = "library_intelligence_build_job"


def get_library_intelligence(
    db: Session,
    viewer_id: UUID,
    library_id: UUID,
) -> LibraryIntelligenceOut:
    _require_member(db, viewer_id, library_id)
    source_set = _current_source_set(db, library_id)
    active = _load_active_artifact(db, library_id)

    if active is None:
        build = (
            _plan_build(db, library_id, source_set, queue_empty=False)[0]
            if int(source_set["source_count"]) > 0
            else _latest_build(db, library_id)
        )
        status = (
            "building"
            if build is not None and build["status"] in {"pending", "running"}
            else "unavailable"
        )
        return LibraryIntelligenceOut(
            library_id=library_id,
            status=cast(Any, status),
            source_count=int(source_set["source_count"]),
            chunk_count=int(source_set["chunk_count"]),
            updated_at=build["updated_at"] if build is not None else None,
            artifact=LibraryIntelligenceArtifactOut(
                kind=ARTIFACT_KIND,
                status=cast(Any, status),
            ),
            sections=[],
            coverage=_coverage_for_items(cast(Sequence[Mapping[str, Any]], source_set["items"])),
            build=_build_out(build),
        )

    status = "current"
    if active["status"] != "active" or _artifact_is_stale(active, source_set):
        status = "stale"
        _mark_current_artifact_stale(db, active["id"])

    build = _latest_build(db, library_id)
    if (
        status == "stale"
        and int(source_set["source_count"]) > 0
        and _inflight_build(db, library_id) is None
    ):
        build = _plan_build(db, library_id, source_set, queue_empty=False)[0]

    return LibraryIntelligenceOut(
        library_id=library_id,
        status=cast(Any, status),
        source_count=int(source_set["source_count"]),
        chunk_count=int(source_set["chunk_count"]),
        updated_at=active["published_at"],
        artifact=LibraryIntelligenceArtifactOut(
            kind=ARTIFACT_KIND,
            status=cast(Any, status),
            published_at=active["published_at"],
        ),
        sections=_sections_for_current_artifact_content(db, active["id"]),
        coverage=_coverage_for_items(cast(Sequence[Mapping[str, Any]], source_set["items"])),
        build=_build_out(build),
    )


def refresh_library_intelligence(
    db: Session,
    viewer_id: UUID,
    library_id: UUID,
) -> LibraryIntelligenceRefreshOut:
    _require_member(db, viewer_id, library_id)
    source_set = _current_source_set(db, library_id)
    build, idempotent = _plan_build(db, library_id, source_set, queue_empty=True)
    return LibraryIntelligenceRefreshOut(
        build_id=build["id"],
        status=cast(Any, build["status"]),
        idempotent=idempotent,
    )


def run_library_intelligence_build(db: Session, build_id: UUID) -> dict[str, object]:
    with transaction(db):
        build = _build_by_id_for_update(db, build_id)
        if build is None:
            return {"status": "skipped", "reason": "build_not_found"}
        if build["status"] == "succeeded":
            return {"status": "skipped", "reason": "already_succeeded"}

        _update_build(db, build_id, status="running", phase="source_set", started=True)
        source_set = _current_source_set(db, build["library_id"])
        items = cast(Sequence[Mapping[str, Any]], source_set["items"])
        if int(source_set["source_count"]) == 0:
            _update_build(db, build_id, status="succeeded", phase="complete", finished=True)
            return {"status": "succeeded", "empty_library": True}
        if not items:
            _fail_build_in_transaction(
                db,
                build_id,
                error_code="E_LIBRARY_INTELLIGENCE_COVERAGE_MISSING",
                message="Build cannot publish without source coverage rows.",
            )
            return {
                "status": "failed",
                "error_code": "E_LIBRARY_INTELLIGENCE_COVERAGE_MISSING",
            }

        _update_build(db, build_id, status="running", phase="synthesis")
        sections = _compile_sections(source_set, items)
        included_items = [item for item in items if bool(item["included"])]

        _update_build(db, build_id, status="running", phase="evidence")
        snippets = {_source_key(item): _first_snippet(db, item) for item in included_items[:20]}

        _update_build(db, build_id, status="running", phase="publish")
        artifact_id = _publish_current_artifact(
            db,
            build_id=build_id,
            library_id=build["library_id"],
            sections=sections,
            included_items=included_items,
            snippets=snippets,
        )
        _update_build(
            db,
            build_id,
            status="succeeded",
            phase="complete",
            finished=True,
            diagnostics={
                "artifact_id": str(artifact_id),
                "source_count": int(source_set["source_count"]),
                "chunk_count": int(source_set["chunk_count"]),
                "included_source_count": len(included_items),
            },
        )
        return {"status": "succeeded", "artifact_id": str(artifact_id)}


def mark_library_intelligence_build_failed(
    db: Session,
    build_id: UUID,
    *,
    error_code: str,
    message: str,
) -> None:
    with transaction(db):
        _fail_build_in_transaction(db, build_id, error_code=error_code, message=message)


def invalidate_library_intelligence(
    db: Session,
    library_id: UUID,
    *,
    reason: str = "source_changed",
) -> None:
    result = db.execute(
        text(
            """
            UPDATE library_intelligence_artifacts
            SET status = 'stale',
                invalidated_at = COALESCE(invalidated_at, now()),
                invalid_reason = COALESCE(invalid_reason, :reason),
                updated_at = now()
            WHERE library_id = :library_id
              AND artifact_kind = :artifact_kind
              AND status = 'active'
            """
        ),
        {
            "library_id": library_id,
            "artifact_kind": ARTIFACT_KIND,
            "reason": reason,
        },
    )
    assert result.rowcount in {
        0,
        1,
    }  # justify-service-invariant-check: one current artifact per library/kind.


def _require_member(db: Session, viewer_id: UUID, library_id: UUID) -> None:
    if not is_library_member(db, viewer_id, library_id):
        raise NotFoundError(ApiErrorCode.E_LIBRARY_NOT_FOUND, "Library not found")


def _current_source_set(db: Session, library_id: UUID) -> Mapping[str, Any]:
    inventory = _load_inventory(db, library_id)
    updated_values = [
        item["source_updated_at"] for item in inventory if item["source_updated_at"] is not None
    ]
    return {
        "source_count": len(inventory),
        "chunk_count": sum(int(item["chunk_count"]) for item in inventory),
        "updated_at": max(updated_values, default=None),
        "items": inventory,
    }


def _artifact_is_stale(
    artifact: Mapping[str, Any],
    source_set: Mapping[str, Any],
) -> bool:
    source_updated_at = source_set["updated_at"]
    published_at = artifact["published_at"]
    return source_updated_at is not None and (
        published_at is None or source_updated_at > published_at
    )


def _load_inventory(db: Session, library_id: UUID) -> list[dict[str, object]]:
    rows = (
        db.execute(
            text(
                """
            SELECT
                le.media_id,
                NULL::uuid AS podcast_id,
                'media' AS source_kind,
                m.title,
                m.kind AS media_kind,
                m.processing_status::text AS processing_status,
                GREATEST(
                    m.updated_at,
                    COALESCE(MAX(f.created_at), m.updated_at),
                    COALESCE(MAX(cc.created_at), m.updated_at)
                ) AS source_updated_at,
                COUNT(DISTINCT f.id) AS fragment_count,
                COUNT(DISTINCT cc.id) AS content_chunk_count
            FROM library_entries le
            JOIN media m ON m.id = le.media_id
            LEFT JOIN fragments f ON f.media_id = m.id
            LEFT JOIN content_chunks cc ON cc.owner_kind = 'media' AND cc.owner_id = m.id
            WHERE le.library_id = :library_id
              AND le.media_id IS NOT NULL
            GROUP BY le.position, le.media_id, m.title, m.kind, m.processing_status, m.updated_at
            ORDER BY le.position ASC, le.media_id ASC
            """
            ),
            {"library_id": library_id},
        )
        .mappings()
        .all()
    )
    items = [_media_inventory_item(row) for row in rows]

    podcast_rows = (
        db.execute(
            text(
                """
            SELECT
                NULL::uuid AS media_id,
                le.podcast_id,
                'podcast' AS source_kind,
                p.title,
                'podcast' AS media_kind,
                GREATEST(
                    p.updated_at,
                    COALESCE(MAX(m.updated_at), p.updated_at),
                    COALESCE(MAX(f.created_at), p.updated_at),
                    COALESCE(MAX(cc.created_at), p.updated_at)
                ) AS source_updated_at,
                COUNT(DISTINCT f.id) AS fragment_count,
                COUNT(DISTINCT cc.id) AS content_chunk_count
            FROM library_entries le
            JOIN podcasts p ON p.id = le.podcast_id
            LEFT JOIN podcast_episodes pe ON pe.podcast_id = p.id
            LEFT JOIN media m ON m.id = pe.media_id
            LEFT JOIN fragments f ON f.media_id = m.id
            LEFT JOIN content_chunks cc ON cc.owner_kind = 'media' AND cc.owner_id = m.id
            WHERE le.library_id = :library_id
              AND le.podcast_id IS NOT NULL
            GROUP BY le.position, le.podcast_id, p.title, p.updated_at
            ORDER BY le.position ASC, le.podcast_id ASC
            """
            ),
            {"library_id": library_id},
        )
        .mappings()
        .all()
    )
    items.extend(_podcast_inventory_item(row) for row in podcast_rows)
    return items


def _media_inventory_item(row: Mapping[str, Any]) -> dict[str, object]:
    text_count = int(row["content_chunk_count"])
    processing_status = str(row["processing_status"])
    included = processing_status == "ready_for_reading" and text_count > 0
    return {
        "media_id": row["media_id"],
        "podcast_id": None,
        "source_kind": "media",
        "title": row["title"],
        "media_kind": row["media_kind"],
        "readiness_state": "ready" if included else processing_status,
        "chunk_count": text_count,
        "included": included,
        "exclusion_reason": None if included else _exclusion_reason(processing_status, text_count),
        "source_updated_at": row["source_updated_at"],
    }


def _podcast_inventory_item(row: Mapping[str, Any]) -> dict[str, object]:
    text_count = int(row["content_chunk_count"])
    included = text_count > 0
    return {
        "media_id": None,
        "podcast_id": row["podcast_id"],
        "source_kind": "podcast",
        "title": row["title"],
        "media_kind": row["media_kind"],
        "readiness_state": "ready" if included else "not_ready",
        "chunk_count": text_count,
        "included": included,
        "exclusion_reason": None if included else "source_not_ready",
        "source_updated_at": row["source_updated_at"],
    }


def _exclusion_reason(processing_status: str, text_count: int) -> str:
    if processing_status == "failed":
        return "source_not_ready"
    if text_count == 0:
        return "missing_searchable_text"
    return "source_not_ready"


def _load_active_artifact(db: Session, library_id: UUID) -> Mapping[str, Any] | None:
    return (
        db.execute(
            text(
                """
            SELECT *
            FROM library_intelligence_artifacts
            WHERE library_id = :library_id
              AND artifact_kind = :artifact_kind
            """
            ),
            {"library_id": library_id, "artifact_kind": ARTIFACT_KIND},
        )
        .mappings()
        .first()
    )


def _latest_build(
    db: Session,
    library_id: UUID,
) -> Mapping[str, Any] | None:
    return (
        db.execute(
            text(
                """
            SELECT *
            FROM library_intelligence_builds
            WHERE library_id = :library_id
              AND artifact_kind = :artifact_kind
            ORDER BY created_at DESC, id DESC
            LIMIT 1
            """
            ),
            {
                "library_id": library_id,
                "artifact_kind": ARTIFACT_KIND,
            },
        )
        .mappings()
        .first()
    )


def _plan_build(
    db: Session,
    library_id: UUID,
    source_set: Mapping[str, Any],
    *,
    queue_empty: bool,
) -> tuple[Mapping[str, Any], bool]:
    existing = _inflight_build(db, library_id)
    if existing is not None:
        return existing, True
    if int(source_set["source_count"]) == 0 and not queue_empty:
        latest = _latest_build(db, library_id)
        if latest is not None:
            return latest, True

    try:
        with transaction(db):
            existing = _inflight_build(db, library_id, for_update=True)
            if existing is not None:
                return existing, True

            build = (
                db.execute(
                    text(
                        """
                    INSERT INTO library_intelligence_builds (
                        library_id,
                        artifact_kind,
                        status,
                        idempotency_key,
                        phase,
                        diagnostics
                    )
                    VALUES (
                        :library_id,
                        :artifact_kind,
                        'pending',
                        :idempotency_key,
                        'queued',
                        '{}'::jsonb
                    )
                    RETURNING *
                    """
                    ),
                    {
                        "library_id": library_id,
                        "artifact_kind": ARTIFACT_KIND,
                        "idempotency_key": _build_idempotency_key(library_id),
                    },
                )
                .mappings()
                .one()
            )
            enqueue_unique_job(
                db,
                kind=BUILD_JOB_KIND,
                payload={"build_id": str(build["id"])},
                dedupe_key=f"{BUILD_JOB_KIND}:{build['id']}",
                priority=60,
                max_attempts=3,
            )
            return build, False
    except IntegrityError:
        db.rollback()
        existing = _inflight_build(db, library_id)
        if existing is not None:
            return existing, True
        raise


def _build_idempotency_key(library_id: UUID) -> str:
    return f"{library_id}:{ARTIFACT_KIND}"


def _inflight_build(
    db: Session,
    library_id: UUID,
    *,
    for_update: bool = False,
) -> Mapping[str, Any] | None:
    suffix = " FOR UPDATE" if for_update else ""
    return (
        db.execute(
            text(
                f"""
            SELECT *
            FROM library_intelligence_builds
            WHERE library_id = :library_id
              AND artifact_kind = :artifact_kind
              AND status IN ('pending', 'running')
            ORDER BY created_at ASC, id ASC
            LIMIT 1
            {suffix}
            """
            ),
            {"library_id": library_id, "artifact_kind": ARTIFACT_KIND},
        )
        .mappings()
        .first()
    )


def _build_by_id_for_update(db: Session, build_id: UUID) -> Mapping[str, Any] | None:
    return (
        db.execute(
            text(
                """
            SELECT *
            FROM library_intelligence_builds
            WHERE id = :build_id
            FOR UPDATE
            """
            ),
            {"build_id": build_id},
        )
        .mappings()
        .first()
    )


def _coverage_for_items(items: Sequence[Mapping[str, Any]]) -> list[LibraryIntelligenceCoverageOut]:
    return [
        LibraryIntelligenceCoverageOut(
            media_id=row["media_id"],
            podcast_id=row["podcast_id"],
            source_kind=cast(Any, row["source_kind"]),
            title=row["title"],
            media_kind=row["media_kind"],
            readiness_state=row["readiness_state"],
            chunk_count=row["chunk_count"],
            included=row["included"],
            exclusion_reason=row["exclusion_reason"],
            source_updated_at=row["source_updated_at"],
        )
        for row in sorted(items, key=lambda item: (not bool(item["included"]), str(item["title"])))
    ]


def _sections_for_current_artifact_content(
    db: Session, artifact_id: UUID
) -> list[LibraryIntelligenceSectionOut]:
    rows = (
        db.execute(
            text(
                """
            SELECT id, section_kind, title, body, ordinal, metadata
            FROM library_intelligence_sections
            WHERE artifact_id = :artifact_id
            ORDER BY ordinal ASC
            """
            ),
            {"artifact_id": artifact_id},
        )
        .mappings()
        .all()
    )
    return [
        LibraryIntelligenceSectionOut(
            id=row["id"],
            section_kind=cast(Any, row["section_kind"]),
            title=row["title"],
            body=row["body"],
            ordinal=row["ordinal"],
            claims=_claims_for_section(db, row["id"]),
            metadata=row["metadata"],
        )
        for row in rows
    ]


def _claims_for_section(db: Session, section_id: UUID) -> list[LibraryIntelligenceClaimOut]:
    rows = (
        db.execute(
            text(
                """
            SELECT id, claim_text, support_state, confidence, ordinal
            FROM library_intelligence_claims
            WHERE section_id = :section_id
            ORDER BY ordinal ASC
            """
            ),
            {"section_id": section_id},
        )
        .mappings()
        .all()
    )
    return [
        LibraryIntelligenceClaimOut(
            id=row["id"],
            claim_text=row["claim_text"],
            support_state=cast(Any, row["support_state"]),
            confidence=row["confidence"],
            ordinal=row["ordinal"],
            evidence=_evidence_for_claim(db, row["id"]),
        )
        for row in rows
    ]


def _evidence_for_claim(db: Session, claim_id: UUID) -> list[LibraryIntelligenceEvidenceOut]:
    rows = (
        db.execute(
            text(
                """
            SELECT id, source_ref, snippet, locator, support_role, retrieval_status, score
            FROM library_intelligence_evidence
            WHERE claim_id = :claim_id
            ORDER BY created_at ASC, id ASC
            """
            ),
            {"claim_id": claim_id},
        )
        .mappings()
        .all()
    )
    return [
        LibraryIntelligenceEvidenceOut(
            id=row["id"],
            source_ref=row["source_ref"],
            snippet=row["snippet"],
            locator=row["locator"],
            support_role=cast(Any, row["support_role"]),
            retrieval_status=row["retrieval_status"],
            score=row["score"],
        )
        for row in rows
    ]


def _build_out(build: Mapping[str, Any] | None) -> LibraryIntelligenceBuildOut | None:
    if build is None:
        return None
    diagnostics = build["diagnostics"] or {}
    error = diagnostics.get("message") if isinstance(diagnostics, Mapping) else None
    return LibraryIntelligenceBuildOut(
        build_id=build["id"],
        status=cast(Any, build["status"]),
        phase=build["phase"],
        error_code=build["error_code"],
        error=error if isinstance(error, str) else None,
        started_at=build["started_at"],
        updated_at=build["updated_at"],
        completed_at=build["finished_at"],
    )


def _mark_current_artifact_stale(db: Session, artifact_id: UUID) -> None:
    with transaction(db):
        result = db.execute(
            text(
                """
                UPDATE library_intelligence_artifacts
                SET status = 'stale',
                    invalidated_at = COALESCE(invalidated_at, now()),
                    invalid_reason = COALESCE(invalid_reason, 'source_changed'),
                    updated_at = now()
                WHERE id = :artifact_id
                  AND status = 'active'
                """
            ),
            {"artifact_id": artifact_id},
        )
        assert result.rowcount in {
            0,
            1,
        }  # justify-service-invariant-check: active version id is unique.


def _compile_sections(
    source_set: Mapping[str, Any],
    items: Sequence[Mapping[str, Any]],
) -> list[dict[str, object]]:
    included = [item for item in items if bool(item["included"])]
    excluded = [item for item in items if not bool(item["included"])]
    source_count = int(source_set["source_count"])
    chunk_count = int(source_set["chunk_count"])

    media_kinds: dict[str, int] = {}
    for item in included:
        key = str(item["media_kind"] or item["source_kind"])
        media_kinds[key] = media_kinds.get(key, 0) + 1

    return [
        {
            "section_kind": "overview",
            "title": "Overview",
            "body": (
                f"{len(included)} of {source_count} sources are readable for library-wide "
                f"intelligence. The current source set contains {chunk_count} text chunk(s)."
            ),
            "metadata": {
                "source_count": source_count,
                "included_source_count": len(included),
                "excluded_source_count": len(excluded),
                "chunk_count": chunk_count,
            },
        },
        {
            "section_kind": "key_topics",
            "title": "Key Topics",
            "body": (
                "Readable source mix: "
                + ", ".join(
                    f"{kind.replace('_', ' ')} ({count})"
                    for kind, count in sorted(media_kinds.items())
                )
                if media_kinds
                else "No readable source mix is available yet."
            ),
            "metadata": {"media_kinds": media_kinds},
        },
        {
            "section_kind": "key_sources",
            "title": "Key Sources",
            "body": (
                "\n".join(f"- {item['title']}" for item in included[:12])
                if included
                else "No sources are readable yet."
            ),
            "metadata": {"listed_source_count": min(len(included), 12)},
        },
        {
            "section_kind": "tensions",
            "title": "Tensions",
            "body": "No contradictions have been verified in the current deterministic pass.",
            "metadata": {"verified_contradiction_count": 0},
        },
        {
            "section_kind": "open_questions",
            "title": "Open Questions",
            "body": (
                "\n".join(
                    f"- {item['title']}: {item['exclusion_reason']}" for item in excluded[:12]
                )
                if excluded
                else "No source-readiness gaps are visible for this source set."
            ),
            "metadata": {"excluded_source_count": len(excluded)},
        },
        {
            "section_kind": "reading_path",
            "title": "Reading Path",
            "body": (
                "\n".join(
                    f"{index + 1}. {item['title']}" for index, item in enumerate(included[:8])
                )
                if included
                else "Add readable sources before a reading path can be compiled."
            ),
            "metadata": {"path_source_count": min(len(included), 8)},
        },
        {
            "section_kind": "recent_changes",
            "title": "Recent Changes",
            "body": "This artifact reflects the current readable sources in the library.",
            "metadata": {
                "source_count": source_count,
                "included_source_count": len(included),
                "excluded_source_count": len(excluded),
            },
        },
    ]


def _first_snippet(db: Session, item: Mapping[str, Any]) -> Mapping[str, object] | None:
    if item["media_id"] is not None:
        return (
            db.execute(
                text(
                    """
                SELECT id AS fragment_id, media_id, canonical_text
                FROM fragments
                WHERE media_id = :media_id
                  AND btrim(canonical_text) != ''
                ORDER BY idx ASC, id ASC
                LIMIT 1
                """
                ),
                {"media_id": item["media_id"]},
            )
            .mappings()
            .first()
        )

    return (
        db.execute(
            text(
                """
            SELECT f.id AS fragment_id, f.media_id, f.canonical_text
            FROM podcast_episodes pe
            JOIN fragments f ON f.media_id = pe.media_id
            WHERE pe.podcast_id = :podcast_id
              AND btrim(f.canonical_text) != ''
            ORDER BY pe.published_at DESC NULLS LAST, f.idx ASC, f.id ASC
            LIMIT 1
            """
            ),
            {"podcast_id": item["podcast_id"]},
        )
        .mappings()
        .first()
    )


def _publish_current_artifact(
    db: Session,
    *,
    build_id: UUID,
    library_id: UUID,
    sections: Sequence[Mapping[str, object]],
    included_items: Sequence[Mapping[str, Any]],
    snippets: Mapping[str, Mapping[str, object] | None],
) -> UUID:
    artifact = (
        db.execute(
            text(
                """
            SELECT *
            FROM library_intelligence_artifacts
            WHERE library_id = :library_id
              AND artifact_kind = :artifact_kind
            FOR UPDATE
            """
            ),
            {"library_id": library_id, "artifact_kind": ARTIFACT_KIND},
        )
        .mappings()
        .first()
    )
    if artifact is None:
        artifact = (
            db.execute(
                text(
                    """
                INSERT INTO library_intelligence_artifacts (library_id, artifact_kind, status)
                VALUES (:library_id, :artifact_kind, 'building')
                RETURNING *
                """
                ),
                {"library_id": library_id, "artifact_kind": ARTIFACT_KIND},
            )
            .mappings()
            .one()
        )

    artifact_id = artifact["id"]
    _prepare_current_artifact(db, artifact_id)

    section_ids: dict[str, UUID] = {}
    for ordinal, section in enumerate(sections):
        row = (
            db.execute(
                text(
                    """
                INSERT INTO library_intelligence_sections (
                    artifact_id,
                    section_kind,
                    title,
                    body,
                    ordinal,
                    metadata
                )
                VALUES (
                    :artifact_id,
                    :section_kind,
                    :title,
                    :body,
                    :ordinal,
                    :metadata
                )
                RETURNING id
                """
                ).bindparams(bindparam("metadata", type_=JSONB)),
                {
                    "artifact_id": artifact_id,
                    "section_kind": section["section_kind"],
                    "title": section["title"],
                    "body": section["body"],
                    "ordinal": ordinal,
                    "metadata": section["metadata"],
                },
            )
            .mappings()
            .one()
        )
        section_ids[str(section["section_kind"])] = row["id"]

    for item in included_items[:20]:
        snippet = snippets.get(_source_key(item))
        if snippet is None:
            continue
        node_id = _insert_source_node(db, artifact_id, item, snippet)
        claim_id = _insert_supported_source_claim(
            db,
            artifact_id=artifact_id,
            node_id=node_id,
            section_id=section_ids["key_sources"],
            item=item,
        )
        _insert_evidence(db, claim_id, item, snippet)

    _activate_current_artifact(db, artifact_id)
    result = db.execute(
        text(
            """
            UPDATE library_intelligence_builds
            SET diagnostics = diagnostics || :diagnostics,
                updated_at = now()
            WHERE id = :build_id
            """
        ).bindparams(bindparam("diagnostics", type_=JSONB)),
        {"build_id": build_id, "diagnostics": {"published_artifact_id": str(artifact["id"])}},
    )
    assert result.rowcount == 1  # justify-service-invariant-check: build row is locked by caller.
    return artifact_id


def _prepare_current_artifact(db: Session, artifact_id: UUID) -> None:
    _clear_artifact_content_children(db, artifact_id)
    result = db.execute(
        text(
            """
            UPDATE library_intelligence_artifacts
            SET status = 'building',
                published_at = NULL,
                invalidated_at = NULL,
                invalid_reason = NULL,
                updated_at = now()
            WHERE id = :artifact_id
            """
        ),
        {"artifact_id": artifact_id},
    )
    assert (
        result.rowcount == 1
    )  # justify-service-invariant-check: artifact row is locked by caller.


def _clear_artifact_content_children(db: Session, artifact_id: UUID) -> None:
    db.execute(
        text(
            """
            DELETE FROM library_intelligence_evidence e
            USING library_intelligence_claims c
            WHERE e.claim_id = c.id
              AND c.artifact_id = :artifact_id
            """
        ),
        {"artifact_id": artifact_id},
    )
    db.execute(
        text("DELETE FROM library_intelligence_claims WHERE artifact_id = :artifact_id"),
        {"artifact_id": artifact_id},
    )
    db.execute(
        text("DELETE FROM library_intelligence_nodes WHERE artifact_id = :artifact_id"),
        {"artifact_id": artifact_id},
    )
    db.execute(
        text("DELETE FROM library_intelligence_sections WHERE artifact_id = :artifact_id"),
        {"artifact_id": artifact_id},
    )


def _insert_source_node(
    db: Session,
    artifact_id: UUID,
    item: Mapping[str, Any],
    snippet: Mapping[str, object],
) -> UUID:
    row = (
        db.execute(
            text(
                """
            INSERT INTO library_intelligence_nodes (
                artifact_id,
                node_type,
                slug,
                title,
                body,
                metadata
            )
            VALUES (
                :artifact_id,
                'source',
                :slug,
                :title,
                :body,
                :metadata
            )
            RETURNING id
            """
            ).bindparams(bindparam("metadata", type_=JSONB)),
            {
                "artifact_id": artifact_id,
                "slug": _source_key(item),
                "title": item["title"],
                "body": _short_snippet(str(snippet["canonical_text"])),
                "metadata": {
                    "source_ref": _source_ref(item, snippet),
                    "chunk_count": int(item["chunk_count"]),
                },
            },
        )
        .mappings()
        .one()
    )
    return row["id"]


def _insert_supported_source_claim(
    db: Session,
    *,
    artifact_id: UUID,
    node_id: UUID,
    section_id: UUID,
    item: Mapping[str, Any],
) -> UUID:
    ordinal = int(
        db.execute(
            text(
                """
                SELECT COUNT(*)
                FROM library_intelligence_claims
                WHERE artifact_id = :artifact_id
                """
            ),
            {"artifact_id": artifact_id},
        ).scalar_one()
    )
    return db.execute(
        text(
            """
            INSERT INTO library_intelligence_claims (
                artifact_id,
                node_id,
                section_id,
                claim_text,
                support_state,
                confidence,
                ordinal
            )
            VALUES (
                :artifact_id,
                :node_id,
                :section_id,
                :claim_text,
                'supported',
                1.0,
                :ordinal
            )
            RETURNING id
            """
        ),
        {
            "artifact_id": artifact_id,
            "node_id": node_id,
            "section_id": section_id,
            "claim_text": f'The library includes the source "{item["title"]}".',
            "ordinal": ordinal,
        },
    ).scalar_one()


def _insert_evidence(
    db: Session,
    claim_id: UUID,
    item: Mapping[str, Any],
    snippet: Mapping[str, object],
) -> None:
    result = db.execute(
        text(
            """
            INSERT INTO library_intelligence_evidence (
                claim_id,
                source_ref,
                snippet,
                locator,
                support_role,
                retrieval_status,
                score
            )
            VALUES (
                :claim_id,
                :source_ref,
                :snippet,
                :locator,
                'supports',
                'included_in_artifact',
                1.0
            )
            """
        ).bindparams(
            bindparam("source_ref", type_=JSONB),
            bindparam("locator", type_=JSONB),
        ),
        {
            "claim_id": claim_id,
            "source_ref": _source_ref(item, snippet),
            "snippet": _short_snippet(str(snippet["canonical_text"])),
            "locator": {
                "fragment_id": str(snippet["fragment_id"]),
                "media_id": str(snippet["media_id"]),
            },
        },
    )
    assert result.rowcount == 1  # justify-service-invariant-check: evidence insert is one row.


def _activate_current_artifact(db: Session, artifact_id: UUID) -> None:
    result = db.execute(
        text(
            """
            UPDATE library_intelligence_artifacts
            SET status = 'active',
                published_at = clock_timestamp(),
                invalidated_at = NULL,
                invalid_reason = NULL,
                updated_at = clock_timestamp()
            WHERE id = :artifact_id
            """
        ),
        {"artifact_id": artifact_id},
    )
    assert result.rowcount == 1  # justify-service-invariant-check: artifact row locked by caller.


def _update_build(
    db: Session,
    build_id: UUID,
    *,
    status: str,
    phase: str,
    started: bool = False,
    finished: bool = False,
    diagnostics: Mapping[str, object] | None = None,
) -> None:
    result = db.execute(
        text(
            """
            UPDATE library_intelligence_builds
            SET status = :status,
                phase = :phase,
                diagnostics = diagnostics || :diagnostics,
                started_at = CASE
                    WHEN :started THEN COALESCE(started_at, now())
                    ELSE started_at
                END,
                finished_at = CASE WHEN :finished THEN now() ELSE finished_at END,
                updated_at = now()
            WHERE id = :build_id
            """
        ).bindparams(bindparam("diagnostics", type_=JSONB)),
        {
            "build_id": build_id,
            "status": status,
            "phase": phase,
            "started": started,
            "finished": finished,
            "diagnostics": dict(diagnostics or {}),
        },
    )
    assert result.rowcount == 1  # justify-service-invariant-check: build row is locked by caller.


def _fail_build_in_transaction(
    db: Session,
    build_id: UUID,
    *,
    error_code: str,
    message: str,
) -> None:
    result = db.execute(
        text(
            """
            UPDATE library_intelligence_builds
            SET status = 'failed',
                phase = 'failed',
                error_code = :error_code,
                diagnostics = diagnostics || :diagnostics,
                finished_at = now(),
                updated_at = now()
            WHERE id = :build_id
            """
        ).bindparams(bindparam("diagnostics", type_=JSONB)),
        {
            "build_id": build_id,
            "error_code": error_code,
            "diagnostics": {"message": message},
        },
    )
    assert result.rowcount in {
        0,
        1,
    }  # justify-service-invariant-check: missing build is a no-op on late failure.


def _source_key(item: Mapping[str, Any]) -> str:
    if item["media_id"] is not None:
        return f"media-{str(item['media_id']).replace('-', '')}"
    return f"podcast-{str(item['podcast_id']).replace('-', '')}"


def _source_ref(
    item: Mapping[str, Any],
    snippet: Mapping[str, object],
) -> dict[str, object]:
    if item["media_id"] is not None:
        return {"type": "media", "id": str(item["media_id"])}
    return {
        "type": "podcast",
        "id": str(item["podcast_id"]),
        "media_id": str(snippet["media_id"]),
    }


def _short_snippet(text_value: str) -> str:
    return " ".join(text_value.split())[:600]
