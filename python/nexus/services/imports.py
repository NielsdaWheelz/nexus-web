"""The Imports read model (`docs/modules/imports.md`).

One CTE classifies every import over three independent obligations (source, search,
metadata) and names the one that speaks for it; the summary, a page and a detail read it
alike, so a count and a row cannot disagree. Recovery answers, readiness and the metadata
view are their owners' (`media_facts`); in-flight progress is ingest's.
"""

from __future__ import annotations

from collections.abc import Sequence
from datetime import datetime
from typing import cast
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.engine import RowMapping
from sqlalchemy.orm import Session

from nexus.auth.permissions import visible_media_ids_cte_sql
from nexus.db.models import MediaKind
from nexus.errors import ApiErrorCode, NotFoundError
from nexus.schemas.import_history import (
    SAFE_FAILURE_CODES,
    STAGES,
    HistoryEntry,
    assume_safe_failure_code,
)
from nexus.schemas.import_refs import ParsedImportRef, format_import_ref
from nexus.schemas.imports import (
    HistoryPage,
    ImportDetail,
    ImportItem,
    ImportListQuery,
    ImportObligation,
    ImportObligations,
    ImportPage,
    ImportSummary,
    RelatedImport,
    RetryUploadOffer,
    WaitingReason,
)
from nexus.schemas.media_sources import SourceProgress
from nexus.schemas.source_issues import SOURCE_ISSUES
from nexus.services.collection_keyset import (
    KeysetValueKind,
    SortKey,
    decode_keyset_cursor,
    encode_keyset_cursor,
    keyset_page,
)
from nexus.services.import_history import events_of_import_sql, history_entries, read_history_page
from nexus.services.media import MediaFacts, media_facts
from nexus.services.media_upload_sessions import (
    UPLOAD_SESSION_ATTENTION_STATES,
    UPLOAD_SESSION_DERIVED_STATE_SQL,
)
from nexus.services.metadata_operations import metadata_operations_sql
from nexus.services.source_publication import load_source_progress
from nexus.services.source_types import COUNTED_PROGRESS_SOURCE_TYPES, LATEST_ORDER_SQL

_PLANS = {
    "NeedsAttention": [
        SortKey("stage_rank", "asc", KeysetValueKind.Int),
        SortKey("view_failed_at", "asc", KeysetValueKind.DateTime),
        SortKey("ref_key", "asc", KeysetValueKind.Text),
    ],
    "InProgress": [
        SortKey("accepted_at", "desc", KeysetValueKind.DateTime),
        SortKey("ref_key", "asc", KeysetValueKind.Text),
    ],
    "History": [
        SortKey("matched_at", "desc", KeysetValueKind.DateTime),
        SortKey("ref_key", "asc", KeysetValueKind.Text),
    ],
}
_EVENT_PLAN = [
    SortKey("occurred_at", "desc", KeysetValueKind.DateTime),
    SortKey("id", "desc", KeysetValueKind.Text),
]
_LIVE = "('pending', 'failed', 'running')"


def _rank(stage: str) -> str:
    """A stage's pipeline position: the one order an import's obligations speak in."""
    return f"array_position(ARRAY{list(STAGES)!r}::text[], {stage})"


def _url_host(url: str) -> str:
    """The host a url import is labelled and searched by."""
    return (
        f"lower(substring({url} from"
        " '^[A-Za-z][A-Za-z0-9+.-]*://(?:[^/?#@]*@)?(\\[[^\\]]*\\]|[^/?#:]+)'))"
    )


def _queue_code(column: str) -> str:
    """`queue_failure_code` set-wise: an uncatalogued queue code reads as a handler failure."""
    return f"""CASE WHEN {column} IS NULL THEN NULL
        WHEN {column} = ANY(CAST(:safe_failure_codes AS text[])) THEN {column}
        ELSE 'E_WORKER_HANDLER_FAILED' END"""


_CTE = f"""
WITH visible_media AS (
    {visible_media_ids_cte_sql()}
), metadata_jobs AS (
    SELECT operations.* FROM ({metadata_operations_sql()}) operations
    JOIN visible_media vm ON vm.media_id = operations.media_id
), media_work AS (
    SELECT m.id AS media_id, m.kind AS media_kind, m.title, m.requested_url,
        m.processing_status::text AS processing_status, m.updated_at AS media_updated_at,
        rp.source_issues, COALESCE(jsonb_array_length(rp.source_issues), 0) AS source_issue_count,
        msa.id AS attempt_id, msa.status AS attempt_status, msa.error_code AS attempt_error_code,
        msa.created_at AS attempt_created_at, msa.finished_at AS attempt_finished_at,
        msa.updated_at AS attempt_updated_at,
        CASE WHEN msa.source_type = ANY(CAST(:counted_source_types AS text[]))
            THEN COALESCE(msa.processing_stage, 'Validate') ELSE 'SourceProcessing' END
            AS source_stage,
        source_job.id AS source_job_id, source_job.status AS source_job_status,
        source_job.available_at AS source_job_available_at,
        source_job.finished_at AS source_job_finished_at,
        source_job.updated_at AS source_job_updated_at,
        source_job.error_code AS source_job_error_code,
        cis.status AS index_status, cis.revision AS index_revision,
        cis.updated_at AS index_updated_at,
        index_job.id AS index_job_id, index_job.status AS index_job_status,
        index_job.available_at AS index_job_available_at,
        index_job.finished_at AS index_job_finished_at,
        index_job.updated_at AS index_job_updated_at,
        index_job.error_code AS index_job_error_code,
        metadata_latest.needs_attention AS metadata_needs_attention,
        metadata_latest.failure_code AS metadata_failure_code,
        metadata_latest.completed_at AS metadata_attention_at,
        metadata_summary.first_created_at AS metadata_accepted_at,
        metadata_summary.unfinished_count AS metadata_unfinished_count,
        metadata_summary.updated_at AS metadata_updated_at,
        live_jobs.unfinished_count AS unfinished_job_count,
        live_jobs.updated_at AS live_jobs_updated_at,
        CASE WHEN capacity.lease_expires_at > now() OR holder.lease_expires_at > now()
            THEN capacity.job_id END AS capacity_job_id
    FROM media m
    JOIN visible_media vm ON vm.media_id = m.id
    LEFT JOIN reader_publications rp ON rp.media_id = m.id
    LEFT JOIN LATERAL (
        SELECT * FROM media_source_attempts WHERE media_id = m.id
        ORDER BY {LATEST_ORDER_SQL} LIMIT 1
    ) msa ON TRUE
    LEFT JOIN background_jobs source_job ON source_job.id = msa.job_id
    LEFT JOIN content_index_states cis ON cis.owner_kind = 'media' AND cis.owner_id = m.id
    LEFT JOIN LATERAL (
        SELECT * FROM background_jobs
        WHERE kind = 'media_content_reindex_job'
          AND payload @> jsonb_build_object('media_id', m.id::text, 'revision', cis.revision)
        ORDER BY created_at DESC, id DESC LIMIT 1
    ) index_job ON TRUE
    LEFT JOIN LATERAL (
        SELECT * FROM metadata_jobs WHERE media_id = m.id
        ORDER BY created_at DESC, job_id DESC LIMIT 1
    ) metadata_latest ON TRUE
    LEFT JOIN LATERAL (
        SELECT min(created_at) AS first_created_at,
            count(*) FILTER (WHERE is_unfinished) AS unfinished_count,
            max(lifecycle_updated_at) AS updated_at
        FROM metadata_jobs WHERE media_id = m.id
    ) metadata_summary ON TRUE
    LEFT JOIN LATERAL (
        SELECT count(*) AS unfinished_count, max(updated_at) AS updated_at
        FROM background_jobs
        WHERE kind IN ('ingest_media_source', 'media_content_reindex_job', 'enrich_metadata')
          AND status IN {_LIVE} AND payload @> jsonb_build_object('media_id', m.id::text)
    ) live_jobs ON TRUE
    LEFT JOIN background_job_capacity_leases capacity ON capacity.resource_class = 'Heavy'
    LEFT JOIN background_jobs holder ON holder.id = capacity.job_id
    WHERE msa.id IS NOT NULL OR metadata_latest.job_id IS NOT NULL
), media_classified AS (
    SELECT media_work.*,
        CASE WHEN attempt_id IS NULL THEN NULL
            WHEN attempt_status <> 'succeeded' AND source_job_status = 'dead'
                THEN 'NeedsAttention'
            WHEN attempt_status = 'failed'
                AND (source_job_status IS NULL OR source_job_status NOT IN {_LIVE})
                THEN 'NeedsAttention'
            WHEN attempt_status <> 'succeeded' THEN 'Active'
            ELSE 'Complete' END AS source_classification,
        CASE WHEN index_revision IS NULL OR processing_status <> 'ready_for_reading' THEN NULL
            WHEN index_job_status = 'dead' THEN 'NeedsAttention'
            WHEN index_status IN ('pending', 'indexing') OR index_job_status IN {_LIVE}
                THEN 'Active'
            ELSE 'Complete' END AS search_classification,
        CASE WHEN metadata_needs_attention THEN 'NeedsAttention'
            WHEN metadata_unfinished_count > 0 THEN 'Active'
            ELSE 'Complete' END AS metadata_classification
    FROM media_work
), upload_sessions AS (
    SELECT id AS session_id, kind AS upload_kind, filename,
        input_origin->>'kind' AS origin_kind, input_origin->>'source_url' AS capture_url,
        published_media_id, created_at AS session_created_at,
        updated_at AS session_updated_at, verification_error_code, verification_failed_at,
        upload_url_expires_at, {UPLOAD_SESSION_DERIVED_STATE_SQL} AS derived_state
    FROM media_upload_sessions WHERE created_by_user_id = :viewer_id
), import_refs AS (
    SELECT 'upload:' || session_id::text AS ref_key, session_id,
        published_media_id AS media_id, upload_kind, filename, origin_kind, capture_url,
        derived_state, session_created_at, session_updated_at, verification_error_code,
        verification_failed_at, upload_url_expires_at
    FROM upload_sessions
    UNION ALL
    SELECT 'media:' || media_id::text, NULL, media_id, NULL, NULL, NULL, NULL, NULL, NULL,
        NULL, NULL, NULL, NULL
    FROM media_work w
    WHERE NOT EXISTS (SELECT 1 FROM upload_sessions s WHERE s.published_media_id = w.media_id)
), import_work AS (
    SELECT r.ref_key, r.session_id, r.media_id, r.derived_state, r.origin_kind,
        COALESCE(w.title, r.filename) AS title, r.filename AS original_filename,
        COALESCE(w.media_kind, r.upload_kind) AS media_kind,
        CASE WHEN r.session_id IS NULL THEN {_url_host("w.requested_url")}
            WHEN r.origin_kind = 'BrowserCapture' THEN {_url_host("r.capture_url")}
            END AS source_host,
        CASE WHEN w.media_id IS NOT NULL THEN w.source_classification
            WHEN r.derived_state = ANY(CAST(:attention_states AS text[])) THEN 'NeedsAttention'
            ELSE 'Active' END AS source_classification,
        CASE WHEN w.media_id IS NOT NULL THEN w.source_stage
            WHEN r.derived_state = 'VerificationFailed' THEN 'Validate'
            ELSE 'Upload' END AS source_stage,
        CASE WHEN w.media_id IS NOT NULL THEN
                CASE WHEN w.attempt_status = 'failed' THEN w.attempt_error_code
                    ELSE {_queue_code("w.source_job_error_code")} END
            WHEN r.derived_state = 'VerificationFailed' THEN r.verification_error_code
            WHEN r.derived_state = 'CapabilityExpired' THEN 'E_UPLOAD_CAPABILITY_EXPIRED'
            END AS source_failure_code,
        CASE WHEN w.media_id IS NULL THEN
                CASE r.derived_state WHEN 'VerificationFailed' THEN r.verification_failed_at
                    WHEN 'CapabilityExpired' THEN r.upload_url_expires_at END
            WHEN w.source_job_status = 'dead'
                THEN COALESCE(w.source_job_finished_at, w.source_job_updated_at)
            ELSE COALESCE(w.attempt_finished_at, w.attempt_updated_at) END AS source_failed_at,
        CASE WHEN w.media_id IS NULL THEN r.session_created_at
            ELSE COALESCE(w.attempt_created_at, w.metadata_accepted_at) END AS accepted_at,
        w.search_classification, {_queue_code("w.index_job_error_code")} AS search_failure_code,
        COALESCE(w.index_job_finished_at, w.index_job_updated_at) AS search_failed_at,
        w.metadata_classification, w.metadata_failure_code, w.metadata_attention_at,
        GREATEST(r.session_updated_at, w.media_updated_at, w.attempt_updated_at,
            w.source_job_updated_at, w.index_updated_at, w.index_job_updated_at,
            w.metadata_updated_at, w.live_jobs_updated_at) AS updated_at,
        COALESCE(w.source_issue_count, 0) AS source_issue_count, w.source_issues,
        w.source_job_id, w.source_job_status, w.source_job_available_at, w.index_job_id,
        w.index_job_status, w.index_job_available_at, w.capacity_job_id, now() AS database_now
    FROM import_refs r LEFT JOIN media_classified w ON w.media_id = r.media_id
    WHERE r.derived_state IS DISTINCT FROM 'Published' OR w.media_id IS NOT NULL
), obligations AS (
    SELECT ref_key, 'source' AS key, source_classification AS classification,
        source_stage AS stage, source_failure_code AS failure_code, source_failed_at AS failed_at,
        accepted_at, COALESCE(source_job_status IN {_LIVE}, FALSE) AS has_live_job
    FROM import_work WHERE source_classification IN ('Active', 'NeedsAttention')
    UNION ALL
    SELECT ref_key, 'search', search_classification, 'Index', search_failure_code,
        search_failed_at, accepted_at, COALESCE(index_job_status IN {_LIVE}, FALSE)
    FROM import_work WHERE search_classification IN ('Active', 'NeedsAttention')
    UNION ALL
    SELECT ref_key, 'metadata', metadata_classification, 'Metadata', metadata_failure_code,
        metadata_attention_at, accepted_at, TRUE
    FROM import_work WHERE metadata_classification IN ('Active', 'NeedsAttention')
), imports AS (
    SELECT i.*, speaking.key AS primary_key, speaking.stage AS primary_stage,
        speaking.failed_at AS primary_failed_at
    FROM (
        SELECT import_work.*, CASE
            WHEN 'NeedsAttention' IN (source_classification, search_classification,
                metadata_classification) THEN 'NeedsAttention'
            WHEN 'Active' IN (source_classification, search_classification,
                metadata_classification) THEN 'Active'
            ELSE 'Complete' END AS classification
        FROM import_work
    ) i
    LEFT JOIN LATERAL (
        SELECT * FROM obligations o
        WHERE o.ref_key = i.ref_key AND o.classification = i.classification
        ORDER BY {_rank("o.stage")}, COALESCE(o.failed_at, o.accepted_at), o.key LIMIT 1
    ) speaking ON TRUE
)"""

_EVENTS = events_of_import_sql(session_id_expr="i.session_id", media_id_expr="i.media_id")


def _params(viewer_id: UUID) -> dict[str, object]:
    return {
        "viewer_id": viewer_id,
        "counted_source_types": sorted(COUNTED_PROGRESS_SOURCE_TYPES),
        "safe_failure_codes": sorted(SAFE_FAILURE_CODES),
        "attention_states": list(UPLOAD_SESSION_ATTENTION_STATES),
    }


def _view_sql(query: ImportListQuery, params: dict[str, object]) -> str:
    """The view's rows (`filtered`), each naming the obligation or the event it matched: a
    current view matches one obligation of the import's classification, History its newest
    matching event (and whether a newer event follows it)."""
    where: list[str] = []
    if query.q is not None:
        escaped = query.q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        params["q"] = f"%{escaped}%"
        where.append(
            "(i.title ILIKE :q ESCAPE '\\' OR i.original_filename ILIKE :q ESCAPE '\\'"
            " OR i.source_host ILIKE :q ESCAPE '\\')"
        )
    if query.media_kind is not None:
        params["media_kind"] = query.media_kind
        where.append("i.media_kind = :media_kind")
    params |= {
        "stage": query.stage,
        "failure_code": query.failure_code,
        "matched_from": query.matched_from,
        "before": query.before,
    }
    if query.view == "History":
        matched = [
            "(CAST(:stage AS text) IS NULL OR e.stage = :stage)",
            "(CAST(:failure_code AS text) IS NULL"
            " OR e.is_failure AND e.failure_code = :failure_code)",
            "(CAST(:matched_from AS timestamptz) IS NULL OR e.occurred_at >= :matched_from)",
            "(CAST(:before AS timestamptz) IS NULL OR e.occurred_at < :before)",
        ]
        if query.had_failures:
            matched.append("e.is_failure")
        if query.had_failures is False:
            where.append(f"NOT EXISTS (SELECT 1 FROM ({_EVENTS}) failed WHERE failed.is_failure)")
        if query.state is not None:
            params["state"] = query.state
            where.append("i.classification = :state")
        join = f"""JOIN LATERAL (
            SELECT e.event_table AS matched_table, e.id AS matched_id,
                e.storage_id AS matched_storage_id, e.occurred_at AS matched_at,
                e.stage AS matched_stage, e.failure_code AS matched_failure_code,
                e.payload AS matched_payload,
                EXISTS (SELECT 1 FROM ({_EVENTS}) newer
                    WHERE (newer.occurred_at, newer.id) > (e.occurred_at, e.id))
                    AS matched_precedes_newest
            FROM ({_EVENTS}) e WHERE {" AND ".join(matched)}
            ORDER BY e.occurred_at DESC, e.id DESC LIMIT 1
        ) m ON TRUE"""
        selection = (
            "i.primary_key AS view_key, i.primary_failed_at AS view_failed_at,"
            f" {_rank('i.primary_stage')} AS stage_rank, m.*"
        )
    else:
        params["classification"] = query.view if query.view == "NeedsAttention" else "Active"
        where.append("i.classification = :classification")
        join = f"""JOIN LATERAL (
            SELECT * FROM obligations o
            WHERE o.ref_key = i.ref_key AND o.classification = i.classification
              AND (CAST(:stage AS text) IS NULL OR o.stage = :stage)
              AND (CAST(:failure_code AS text) IS NULL OR o.failure_code = :failure_code)
            ORDER BY {_rank("o.stage")}, COALESCE(o.failed_at, o.accepted_at), o.key LIMIT 1
        ) o ON TRUE"""
        selection = (
            f"o.key AS view_key, o.failed_at AS view_failed_at, {_rank('o.stage')} AS stage_rank"
        )
    return f""", filtered AS (
        SELECT i.*, {selection} FROM imports i {join} WHERE {" AND ".join(where) or "TRUE"}
    )"""


def read_import_summary(db: Session, *, viewer_id: UUID) -> ImportSummary:
    """Global counts, independent of any filter; `observed_at` is the observation token."""
    row = (
        db.execute(
            text(f"""{_CTE}
            SELECT now() AS observed_at,
                count(*) FILTER (WHERE classification = 'NeedsAttention')::integer
                    AS needs_attention_count,
                count(*) FILTER (WHERE classification = 'Active')::integer AS active_count,
                ((SELECT COALESCE(sum(unfinished_job_count), 0) FROM media_work)
                    + (SELECT count(*) FROM obligations
                       WHERE classification = 'Active' AND NOT has_live_job))::integer
                    AS unfinished_work_count
            FROM imports"""),
            _params(viewer_id),
        )
        .mappings()
        .one()
    )
    return ImportSummary.model_validate(dict(row))


def read_import_page(db: Session, *, viewer_id: UUID, query: ImportListQuery) -> ImportPage:
    """One page of the view; the count covers the whole filtered set, and the cursor is
    bound to this viewer, view and filter set."""
    params = _params(viewer_id)
    filtered = _CTE + _view_sql(query, params)
    matched_count = db.execute(
        text(f"{filtered} SELECT count(*)::integer FROM filtered"), params
    ).scalar_one()
    rows, next_cursor = keyset_page(
        db,
        binding={"list": f"imports:{query.view}", "viewer": viewer_id, **query.normalized()},
        plan=_PLANS[query.view],
        cursor=query.cursor,
        limit=query.limit,
        params=params,
        sql=lambda keyset, order: (
            f"{filtered} SELECT * FROM filtered facts WHERE TRUE {keyset}"
            f" ORDER BY {order} LIMIT :limit"
        ),
    )
    # A History row carries its match only when a newer event follows it (I19).
    narrated = [row for row in rows if row.get("matched_precedes_newest")]
    entries = history_entries(
        db,
        viewer_id=viewer_id,
        rows=[
            {
                "event_table": row["matched_table"],
                "id": row["matched_id"],
                "storage_id": row["matched_storage_id"],
                "occurred_at": row["matched_at"],
                "stage": row["matched_stage"],
                "failure_code": row["matched_failure_code"],
                "payload": row["matched_payload"],
            }
            for row in narrated
        ],
    )
    matched = {row["ref_key"]: entry for row, entry in zip(narrated, entries, strict=True)}
    media = _hydrate(db, viewer_id, rows)
    return ImportPage(
        matched_count=matched_count,
        items=[_item(row, media, matched.get(row["ref_key"])) for row in rows],
        next_cursor=next_cursor,
    )


def _import_row(db: Session, viewer_id: UUID, ref: ParsedImportRef) -> RowMapping:
    row = (
        db.execute(
            text(f"{_CTE} SELECT *, primary_key AS view_key FROM imports WHERE ref_key = :ref"),
            {**_params(viewer_id), "ref": format_import_ref(ref)},
        )
        .mappings()
        .one_or_none()
    )
    if row is None:
        raise NotFoundError(ApiErrorCode.E_IMPORT_NOT_FOUND, "Import not found")
    return row


def read_import_detail(db: Session, *, viewer_id: UUID, ref: ParsedImportRef) -> ImportDetail:
    """Current source/search state with visible one-hop article/thread relations."""
    row = _import_row(db, viewer_id, ref)
    related = (
        db.execute(
            text(f"""{_CTE}
            SELECT imports.*, primary_key AS view_key, related.relation
            FROM imports JOIN (
                SELECT DISTINCT article_media_id AS media_id, 'article' AS relation
                FROM x_article_inspections WHERE thread_media_id = :media_id
                UNION
                SELECT DISTINCT thread_media_id AS media_id, 'thread' AS relation
                FROM x_article_inspections WHERE article_media_id = :media_id
            ) related ON related.media_id = imports.media_id
            WHERE imports.media_id <> :media_id ORDER BY imports.ref_key
        """),
            {**_params(viewer_id), "media_id": row["media_id"]},
        )
        .mappings()
        .all()
    )
    hydrated = _hydrate(db, viewer_id, [row, *related])
    return ImportDetail(
        item=_item(row, hydrated, None),
        source_issues=SOURCE_ISSUES.validate_python(row["source_issues"] or []),
        related_imports=[
            RelatedImport(relation=item["relation"], item=_item(item, hydrated, None))
            for item in related
        ],
    )


def read_media_search_obligation(
    db: Session, *, viewer_id: UUID, media_id: UUID
) -> ImportObligation | None:
    """One media's search obligation as Imports shows it, for an owner presenting index
    work in place (piece section preparation); None when the viewer has no such import."""
    row = (
        db.execute(
            text(
                f"{_CTE} SELECT *, primary_key AS view_key FROM imports WHERE media_id = :media_id"
            ),
            {**_params(viewer_id), "media_id": media_id},
        )
        .mappings()
        .one_or_none()
    )
    if row is None:
        return None
    facts, progress = _hydrate(db, viewer_id, [row]).get(media_id, (None, None))
    return _obligation(row, "search", facts, progress)


def read_import_history(
    db: Session, *, viewer_id: UUID, ref: ParsedImportRef, cursor: str | None, limit: int
) -> HistoryPage:
    """Newest first, under the detail's visibility; the cursor binds viewer and ref."""
    row = _import_row(db, viewer_id, ref)
    binding = {"list": "imports:history", "viewer": viewer_id, "ref": row["ref_key"]}
    before = None
    if cursor is not None:
        at, event_id = decode_keyset_cursor(cursor, binding, _EVENT_PLAN)
        before = (cast(datetime, at), cast(str, event_id))
    entries = read_history_page(
        db,
        viewer_id=viewer_id,
        session_id=row["session_id"],
        media_id=row["media_id"],
        before=before,
        limit=limit + 1,
    )
    last = entries[limit - 1] if len(entries) > limit else None
    return HistoryPage(
        entries=entries[:limit],
        next_cursor=None
        if last is None
        else encode_keyset_cursor(
            binding, _EVENT_PLAN, {"occurred_at": last.occurred_at, "id": last.id}
        ),
    )


def _hydrate(
    db: Session, viewer_id: UUID, rows: Sequence[RowMapping]
) -> dict[UUID, tuple[MediaFacts, SourceProgress | None]]:
    """Each linked media's owner facts and in-flight source progress."""
    facts = media_facts(
        db, viewer_id=viewer_id, media_ids=[row["media_id"] for row in rows if row["media_id"]]
    )
    progress = load_source_progress(db, tuple(facts))
    return {media_id: (fact, progress.get(media_id)) for media_id, fact in facts.items()}


def _waiting(row: RowMapping, job: str) -> WaitingReason | None:
    if row[f"{job}_id"] is None or row[f"{job}_status"] not in ("pending", "failed"):
        return None
    if row[f"{job}_available_at"] > row["database_now"]:
        return "RetryBackoff"
    if row["capacity_job_id"] not in (None, row[f"{job}_id"]):
        return "Capacity"
    return "Queue"


def _obligation(
    row: RowMapping, key: str, facts: MediaFacts | None, progress: SourceProgress | None
) -> ImportObligation | None:
    """The source or search obligation; an unpublished upload (no media) answers for itself."""
    classification = row[f"{key}_classification"]
    if classification is None:
        return None
    job = "source_job" if key == "source" else "index_job"
    active = classification == "Active"
    code = row[f"{key}_failure_code"] if classification == "NeedsAttention" else None
    if facts is None:
        rejected = row["derived_state"] == "VerificationFailed"
        offer = None if rejected or row["origin_kind"] == "BrowserCapture" else RetryUploadOffer()
        restriction = "UploadRejected" if rejected else None
        waiting = "AwaitingUploadConfirmation" if active else None
        status = "Queued" if active else None
    else:
        offer = facts.source_offer if key == "source" else facts.search_offer
        restriction = facts.source_restriction if key == "source" else facts.search_restriction
        waiting = _waiting(row, job) if active else None
        status = (
            None if not active else "Processing" if row[f"{job}_status"] == "running" else "Queued"
        )
    return ImportObligation(
        classification=classification,
        stage=row["source_stage"] if key == "source" else "Index",
        status=status,
        waiting_reason=waiting,
        progress=progress if active and key == "source" else None,
        next_retry_at=row[f"{job}_available_at"] if waiting == "RetryBackoff" else None,
        failure_code=None if code is None else assume_safe_failure_code(code),
        recovery=offer,
        unavailable_reason=restriction,
    )


def _item(
    row: RowMapping,
    media: dict[UUID, tuple[MediaFacts, SourceProgress | None]],
    matched: HistoryEntry | None,
) -> ImportItem:
    facts, progress = media.get(row["media_id"], (None, None))
    return ImportItem(
        ref=row["ref_key"],
        media_id=row["media_id"],
        title=row["title"],
        original_filename=row["original_filename"],
        media_kind=MediaKind(row["media_kind"]),
        source_label=row["source_host"],
        can_read=facts is not None and facts.can_read,
        can_play=facts is not None and facts.can_play,
        classification=row["classification"],
        primary=row["view_key"],
        accepted_at=row["accepted_at"],
        updated_at=row["updated_at"],
        matched_event=matched,
        obligations=ImportObligations(
            source=_obligation(row, "source", facts, progress),
            search=_obligation(row, "search", facts, progress),
            metadata=None if facts is None else facts.metadata,
        ),
        source_issue_count=row["source_issue_count"],
    )
