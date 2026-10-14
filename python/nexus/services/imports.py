"""The Imports query owner (spec `docs/modules/imports.md`).

One classification over independent source, search, and metadata obligations:
every upload session and visible media with source attempts or metadata jobs.
An upload keeps its
`upload:` identity after publication and carries its media's classification, so
the standalone media branch omits the media this viewer's sessions published.
Summary, page, and detail read the same CTE, so a badge count, a page count, and
a row can never disagree about a classification; every current-state fact a
filter or an order needs is computed set-wise here, and the recovery offer on
each row comes from the source and search owners' own policies. Detecting an
impossible row belongs to the reads that render one (`_item`, `_state`): the
summary counts classifications and materializes no row, so it cannot see a
per-row defect (OI-035).
"""

from __future__ import annotations

from collections.abc import Sequence
from datetime import datetime
from typing import Literal, cast
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.engine import RowMapping
from sqlalchemy.orm import Session

from nexus.auth.permissions import visible_media_ids_cte_sql
from nexus.db.models import MediaKind
from nexus.errors import ApiErrorCode, NotFoundError
from nexus.schemas.import_history import (
    SAFE_FAILURE_CODES,
    STAGE_RANK,
    HistoryEntry,
    HistoryOwner,
    MediaHistoryOwner,
    Stage,
    UploadHistoryOwner,
    assume_safe_failure_code,
)
from nexus.schemas.import_refs import (
    MediaImportRef,
    ParsedImportRef,
    UploadImportRef,
    format_import_ref,
)
from nexus.schemas.imports import (
    Capabilities,
    HistoryPage,
    ImportDetail,
    ImportItem,
    ImportListQuery,
    ImportObligations,
    ImportPage,
    ImportReadiness,
    ImportSourceIssues,
    ImportState,
    ImportStateActive,
    ImportStateComplete,
    ImportStateNeedsAttention,
    ImportSummary,
    RepairSearchOffer,
    RepairSourceOffer,
    RetrySourceOffer,
    RetryUploadOffer,
    SearchImportObligation,
    SourceImportObligation,
    WaitingReason,
)
from nexus.schemas.media import MediaOut
from nexus.schemas.source_issues import SOURCE_ISSUES
from nexus.services.collection_keyset import (
    KeysetValueKind,
    SortKey,
    decode_keyset_cursor,
    encode_keyset_cursor,
    keyset_page,
)
from nexus.services.content_indexing import SearchRecoveryFacts, search_recovery
from nexus.services.import_history import (
    events_of_import_sql,
    history_coverage,
    history_entries,
    read_history_page,
)
from nexus.services.media import list_media_for_viewer_by_ids
from nexus.services.media_upload_sessions import (
    UPLOAD_SESSION_ATTENTION_STATES,
    UPLOAD_SESSION_DERIVED_STATE_SQL,
)
from nexus.services.metadata_operations import metadata_operations_sql
from nexus.services.source_attempts import (
    SourceRecoveryFacts,
    source_recovery,
    source_repairable_sql,
)
from nexus.services.source_types import COUNTED_PROGRESS_SOURCE_TYPES

_ATTENTION_PLAN = [
    SortKey("stage_rank", "asc", KeysetValueKind.Int),
    SortKey("view_failed_at", "asc", KeysetValueKind.DateTime),
    SortKey("ref_key", "asc", KeysetValueKind.Text),
]
_PROGRESS_PLAN = [
    SortKey("accepted_at", "desc", KeysetValueKind.DateTime),
    SortKey("ref_key", "asc", KeysetValueKind.Text),
]
_HISTORY_PLAN = [
    SortKey("matched_at", "desc", KeysetValueKind.DateTime),
    SortKey("ref_key", "asc", KeysetValueKind.Text),
]
_EVENT_PAGE_PLAN = [
    SortKey("occurred_at", "desc", KeysetValueKind.DateTime),
    SortKey("id", "desc", KeysetValueKind.Text),
]

# The host of a requested URL (scheme, optional userinfo, host, optional
# port): the label a URL import carries and the field `q` searches for it.
_URL_HOST_SQL = (
    "lower(substring({url} from"
    " '^[A-Za-z][A-Za-z0-9+.-]*://(?:[^/?#@]*@)?(\\[[^\\]]*\\]|[^/?#:]+)'))"
)

_STAGE_RANK_SQL = (
    "CASE view_stage "
    + " ".join(f"WHEN '{stage}' THEN {rank}" for stage, rank in STAGE_RANK.items())
    + " END"
)


def _catalogued_queue_code(column: str) -> str:
    """Set-wise twin of `queue_failure_code`: a queue row's code outside the
    catalog reads as the generic handler failure, and a missing code stays NULL."""
    return f"""CASE
            WHEN {column} IS NULL THEN NULL
            WHEN {column} = ANY(CAST(:safe_failure_codes AS text[])) THEN {column}
            ELSE 'E_WORKER_HANDLER_FAILED'
        END"""


# Every current obligation is independent. Their composition owns membership,
# filtering and counts; metadata's SQL projection alone interprets metadata jobs.
_IMPORTS_CTE = f"""
WITH visible_media AS (
    {visible_media_ids_cte_sql()}
), metadata_jobs AS (
    SELECT operations.* FROM ({metadata_operations_sql()}) operations
    JOIN visible_media vm ON vm.media_id = operations.media_id
), media_work AS (
    SELECT
        m.id AS media_id, m.kind AS media_kind, m.title, m.requested_url,
        m.processing_status::text AS processing_status,
        m.created_by_user_id = :viewer_id AS is_creator,
        m.updated_at AS media_updated_at,
        rp.generation AS publication_generation, rp.source_issues,
        COALESCE(jsonb_array_length(rp.source_issues), 0) AS source_issue_count,
        msa.id AS attempt_id, msa.status AS attempt_status, msa.source_type,
        msa.error_code AS attempt_error_code, msa.job_id AS attempt_job_id,
        msa.created_at AS attempt_created_at, msa.finished_at AS attempt_finished_at,
        msa.updated_at AS attempt_updated_at,
        CASE WHEN msa.source_type = ANY(CAST(:counted_source_types AS text[]))
            THEN COALESCE(msa.processing_stage, 'Validate')
            ELSE 'SourceProcessing' END AS source_stage,
        {source_repairable_sql("m")} AS source_repairable,
        source_job.id AS source_job_id, source_job.kind AS source_job_kind,
        source_job.payload @> jsonb_build_object(
            'media_id', m.id::text, 'attempt_id', msa.id::text
        ) AS source_job_exact,
        source_job.status AS source_job_status,
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
        index_job.exact_count AS exact_index_job_count,
        metadata_latest.needs_attention AS metadata_needs_attention,
        metadata_latest.failure_code AS metadata_failure_code,
        metadata_latest.completed_at AS metadata_attention_at,
        metadata_summary.first_created_at AS metadata_accepted_at,
        metadata_summary.unfinished_count AS metadata_unfinished_count,
        metadata_summary.updated_at AS metadata_updated_at,
        live_jobs.unfinished_count AS unfinished_job_count,
        live_jobs.updated_at AS live_jobs_updated_at,
        CASE WHEN capacity.lease_expires_at > now()
            OR capacity_holder.lease_expires_at > now()
            THEN capacity.job_id END AS capacity_job_id
    FROM media m
    JOIN visible_media vm ON vm.media_id = m.id
    LEFT JOIN reader_publications rp ON rp.media_id = m.id
    LEFT JOIN LATERAL (
        SELECT latest.* FROM media_source_attempts latest WHERE latest.media_id = m.id
        ORDER BY latest.attempt_no DESC, latest.created_at DESC, latest.id DESC LIMIT 1
    ) msa ON TRUE
    LEFT JOIN background_jobs source_job ON source_job.id = msa.job_id
    LEFT JOIN content_index_states cis ON cis.owner_kind = 'media' AND cis.owner_id = m.id
    LEFT JOIN LATERAL (
        SELECT exact.*, count(*) OVER () AS exact_count FROM background_jobs exact
        WHERE exact.kind = 'media_content_reindex_job'
          AND exact.payload @> jsonb_build_object('media_id', m.id::text, 'revision', cis.revision)
        ORDER BY exact.created_at DESC, exact.id DESC LIMIT 1
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
          AND status IN ('pending', 'running', 'failed')
          AND payload @> jsonb_build_object('media_id', m.id::text)
    ) live_jobs ON TRUE
    LEFT JOIN background_job_capacity_leases capacity ON capacity.resource_class = 'Heavy'
    LEFT JOIN background_jobs capacity_holder ON capacity_holder.id = capacity.job_id
    WHERE msa.id IS NOT NULL OR metadata_latest.job_id IS NOT NULL
), media_classified AS (
    SELECT media_work.*,
        CASE
            WHEN attempt_id IS NULL THEN NULL
            WHEN attempt_status <> 'succeeded' AND source_job_status = 'dead'
                THEN 'NeedsAttention'
            WHEN attempt_status = 'failed' AND (
                source_job_status IS NULL OR source_job_status NOT IN ('pending', 'failed', 'running')
            ) THEN 'NeedsAttention'
            WHEN attempt_status <> 'succeeded' THEN 'Active'
            ELSE 'Complete' END AS source_classification,
        CASE
            WHEN index_revision IS NULL OR processing_status <> 'ready_for_reading' THEN NULL
            WHEN index_job_status = 'dead' THEN 'NeedsAttention'
            WHEN index_status IN ('pending', 'indexing')
              OR index_job_status IN ('pending', 'failed', 'running') THEN 'Active'
            ELSE 'Complete' END AS search_classification,
        CASE WHEN metadata_needs_attention THEN 'NeedsAttention'
            WHEN metadata_unfinished_count > 0 THEN 'Active'
            ELSE 'Complete' END AS metadata_classification
    FROM media_work
), upload_sessions AS (
    SELECT id AS session_id, kind AS upload_kind, filename,
        input_origin->>'kind' AS origin_kind,
        input_origin->>'source_url' AS capture_source_url,
        published_media_id, created_at AS session_created_at,
        updated_at AS session_updated_at, verification_error_code,
        verification_failed_at, upload_url_expires_at,
        {UPLOAD_SESSION_DERIVED_STATE_SQL} AS derived_state
    FROM media_upload_sessions WHERE created_by_user_id = :viewer_id
), import_refs AS (
    SELECT 'upload' AS ref_kind, session_id, published_media_id AS media_id,
        upload_kind, filename, origin_kind, capture_source_url, derived_state,
        session_created_at, session_updated_at, verification_error_code,
        verification_failed_at, upload_url_expires_at
    FROM upload_sessions
    UNION ALL
    SELECT 'media', NULL, media_id, NULL, NULL, NULL, NULL, NULL,
        NULL, NULL, NULL, NULL, NULL
    FROM media_work w WHERE NOT EXISTS (
        SELECT 1 FROM upload_sessions s WHERE s.published_media_id = w.media_id
    )
), import_work AS (
    SELECT r.ref_kind, r.session_id, r.media_id,
        CASE WHEN r.ref_kind = 'media' THEN 'media:' || r.media_id::text
            ELSE 'upload:' || md5(r.session_id::text) END AS ref_key,
        r.derived_state, r.origin_kind,
        CASE WHEN r.media_id IS NULL THEN r.filename ELSE w.title END AS title,
        r.filename AS original_filename,
        COALESCE(w.media_kind, r.upload_kind) AS media_kind,
        CASE WHEN r.ref_kind = 'media' THEN {_URL_HOST_SQL.format(url="w.requested_url")}
            WHEN r.origin_kind = 'BrowserCapture'
            THEN {_URL_HOST_SQL.format(url="r.capture_source_url")} END AS source_host,
        CASE WHEN r.derived_state IS NULL OR r.derived_state = 'Published'
            THEN w.source_classification
            WHEN r.derived_state = ANY(CAST(:attention_states AS text[])) THEN 'NeedsAttention'
            ELSE 'Active' END AS source_classification,
        CASE WHEN r.derived_state IS NULL OR r.derived_state = 'Published' THEN w.source_stage
            WHEN r.derived_state = 'VerificationFailed' THEN 'Validate'
            ELSE 'Upload' END AS source_stage,
        CASE WHEN r.derived_state IS NULL OR r.derived_state = 'Published' THEN
            CASE WHEN w.attempt_status = 'failed' THEN w.attempt_error_code
                ELSE {_catalogued_queue_code("w.source_job_error_code")} END
            WHEN r.derived_state = 'VerificationFailed' THEN r.verification_error_code
            WHEN r.derived_state = 'CapabilityExpired' THEN 'E_UPLOAD_CAPABILITY_EXPIRED'
            END AS source_failure_code,
        CASE WHEN r.derived_state IS NULL OR r.derived_state = 'Published' THEN
            CASE WHEN w.source_job_status = 'dead'
                THEN COALESCE(w.source_job_finished_at, w.source_job_updated_at)
                ELSE COALESCE(w.attempt_finished_at, w.attempt_updated_at) END
            WHEN r.derived_state = 'VerificationFailed' THEN r.verification_failed_at
            WHEN r.derived_state = 'CapabilityExpired' THEN r.upload_url_expires_at
            END AS source_failed_at,
        CASE WHEN r.derived_state IS NULL OR r.derived_state = 'Published'
            THEN COALESCE(w.attempt_created_at, w.metadata_accepted_at)
            ELSE r.session_created_at END AS accepted_at,
        w.search_classification,
        {_catalogued_queue_code("w.index_job_error_code")} AS search_failure_code,
        COALESCE(w.index_job_finished_at, w.index_job_updated_at) AS search_failed_at,
        w.metadata_classification, w.metadata_failure_code, w.metadata_attention_at,
        GREATEST(r.session_updated_at, w.media_updated_at, w.attempt_updated_at,
            w.source_job_updated_at, w.index_updated_at, w.index_job_updated_at,
            w.metadata_updated_at, w.live_jobs_updated_at) AS updated_at,
        w.is_creator, w.processing_status, COALESCE(w.source_issue_count, 0) AS source_issue_count,
        w.publication_generation, w.source_issues, w.attempt_id, w.attempt_status,
        w.source_type, w.attempt_error_code, w.attempt_job_id, w.source_repairable,
        w.source_job_id, w.source_job_kind, w.source_job_exact, w.source_job_status,
        w.source_job_available_at, w.index_status, w.index_revision, w.index_job_id,
        w.index_job_status, w.index_job_available_at, w.exact_index_job_count,
        w.capacity_job_id, now() AS database_now
    FROM import_refs r LEFT JOIN media_classified w ON w.media_id = r.media_id
    WHERE r.derived_state IS DISTINCT FROM 'Published' OR w.media_id IS NOT NULL
), current_obligations AS (
    SELECT ref_key, 'source' AS obligation_key, source_classification AS classification,
        source_stage AS stage, source_failure_code AS failure_code,
        source_failed_at AS failed_at, accepted_at,
        COALESCE(source_job_status IN ('pending', 'failed', 'running'), FALSE) AS has_live_job
    FROM import_work WHERE source_classification IN ('Active', 'NeedsAttention')
    UNION ALL
    SELECT ref_key, 'search', search_classification, 'Index', search_failure_code,
        search_failed_at, accepted_at,
        COALESCE(index_job_status IN ('pending', 'failed', 'running'), FALSE)
    FROM import_work WHERE search_classification IN ('Active', 'NeedsAttention')
    UNION ALL
    SELECT ref_key, 'metadata', metadata_classification, 'Metadata', metadata_failure_code,
        metadata_attention_at, accepted_at, TRUE
    FROM import_work WHERE metadata_classification IN ('Active', 'NeedsAttention')
), import_states AS (
    SELECT i.*, CASE WHEN 'NeedsAttention' IN (
            source_classification, search_classification, metadata_classification
        ) THEN 'NeedsAttention'
        WHEN 'Active' IN (source_classification, search_classification, metadata_classification)
            THEN 'Active' ELSE 'Complete' END AS classification
    FROM import_work i
), imports AS (
    SELECT i.*, primary_obligation.obligation_key AS primary_key,
        primary_obligation.stage AS current_stage, primary_obligation.failure_code,
        primary_obligation.failed_at
    FROM import_states i
    LEFT JOIN LATERAL (
        SELECT * FROM current_obligations candidate
        WHERE candidate.ref_key = i.ref_key AND candidate.classification = i.classification
        ORDER BY {"CASE candidate.stage " + " ".join(f"WHEN '{stage}' THEN {rank}" for stage, rank in STAGE_RANK.items()) + " END"},
            COALESCE(candidate.failed_at, candidate.accepted_at), candidate.obligation_key
        LIMIT 1
    ) primary_obligation ON TRUE
)"""

_EVENTS_OF_IMPORT_SQL = events_of_import_sql(
    session_id_expr="i.session_id", media_id_expr="i.media_id"
)


def _base_params(viewer_id: UUID) -> dict[str, object]:
    return {
        "viewer_id": viewer_id,
        "counted_source_types": sorted(COUNTED_PROGRESS_SOURCE_TYPES),
        "safe_failure_codes": sorted(SAFE_FAILURE_CODES),
        "attention_states": list(UPLOAD_SESSION_ATTENTION_STATES),
    }


def _like_pattern(q: str) -> str:
    escaped = q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{escaped}%"


def _filtered_cte(query: ImportListQuery, params: dict[str, object]) -> str:
    """Classify first; every current filter belongs to one eligible obligation."""
    conditions: list[str] = []
    if query.q is not None:
        params["q_pattern"] = _like_pattern(query.q)
        conditions.append(
            "(i.title ILIKE :q_pattern ESCAPE '\\' "
            "OR i.original_filename ILIKE :q_pattern ESCAPE '\\' "
            "OR i.source_host ILIKE :q_pattern ESCAPE '\\')"
        )
    if query.media_kind is not None:
        params["media_kind"] = query.media_kind
        conditions.append("i.media_kind = :media_kind")
    if query.view == "History":
        event_conditions: list[str] = []
        if query.stage is not None:
            params["stage"] = query.stage
            event_conditions.append("e.stage = :stage")
        if query.failure_code is not None:
            params["failure_code"] = query.failure_code
            event_conditions.append("e.is_failure AND e.failure_code = :failure_code")
        if query.had_failures:
            event_conditions.append("e.is_failure")
        if query.matched_from is not None:
            params["matched_from"] = query.matched_from
            event_conditions.append("e.occurred_at >= :matched_from")
        if query.before is not None:
            params["before"] = query.before
            event_conditions.append("e.occurred_at < :before")
        if query.had_failures is False:
            conditions.append(
                "NOT EXISTS (SELECT 1 FROM ("
                + _EVENTS_OF_IMPORT_SQL
                + ") failed WHERE failed.is_failure)"
            )
        if query.state is not None:
            params["state"] = query.state
            conditions.append("i.classification = :state")
        match_join = f"""
        JOIN LATERAL (
            SELECT e.event_table AS matched_table, e.id AS matched_id,
                e.storage_id AS matched_storage_id, e.occurred_at AS matched_at,
                e.event_type AS matched_type, e.stage AS matched_stage,
                e.failure_code AS matched_failure_code, e.payload AS matched_payload,
                EXISTS (SELECT 1 FROM ({_EVENTS_OF_IMPORT_SQL}) newer
                    WHERE (newer.occurred_at, newer.id) > (e.occurred_at, e.id)
                ) AS matched_precedes_newest
            FROM ({_EVENTS_OF_IMPORT_SQL}) e
            WHERE {" AND ".join(event_conditions) or "TRUE"}
            ORDER BY e.occurred_at DESC, e.id DESC LIMIT 1
        ) matched ON TRUE"""
        selection = (
            "i.primary_key AS view_key, i.current_stage AS view_stage, "
            "i.failure_code AS view_failure_code, i.failed_at AS view_failed_at, matched.*"
        )
    else:
        params["classification"] = "NeedsAttention" if query.view == "NeedsAttention" else "Active"
        conditions.append("i.classification = :classification")
        candidate_conditions = [
            "candidate.ref_key = i.ref_key",
            "candidate.classification = i.classification",
        ]
        if query.stage is not None:
            params["stage"] = query.stage
            candidate_conditions.append("candidate.stage = :stage")
        if query.failure_code is not None:
            params["failure_code"] = query.failure_code
            candidate_conditions.append("candidate.failure_code = :failure_code")
        stage_rank = (
            "CASE candidate.stage "
            + " ".join(f"WHEN '{stage}' THEN {rank}" for stage, rank in STAGE_RANK.items())
            + " END"
        )
        match_join = f"""
        JOIN LATERAL (
            SELECT * FROM current_obligations candidate
            WHERE {" AND ".join(candidate_conditions)}
            ORDER BY {stage_rank}, COALESCE(candidate.failed_at, candidate.accepted_at),
                candidate.obligation_key LIMIT 1
        ) selected ON TRUE"""
        selection = (
            "selected.obligation_key AS view_key, selected.stage AS view_stage, "
            "selected.failure_code AS view_failure_code, selected.failed_at AS view_failed_at"
        )
    return f"""view_rows AS (
        SELECT i.*, {selection} FROM imports i {match_join}
        WHERE {" AND ".join(conditions) or "TRUE"}
    ), filtered AS (
        SELECT view_rows.*, {_STAGE_RANK_SQL} AS stage_rank FROM view_rows
    )"""


def read_import_summary(db: Session, *, viewer_id: UUID) -> ImportSummary:
    """Global attention and active counts, independent of any list filter."""
    row = (
        db.execute(
            text(
                f"""{_IMPORTS_CTE}
                SELECT
                    now() AS observed_at,
                    count(*) FILTER (WHERE classification = 'NeedsAttention')::integer
                        AS needs_attention_count,
                    count(*) FILTER (WHERE classification = 'Active')::integer AS active_count,
                    ((SELECT COALESCE(sum(unfinished_job_count), 0) FROM media_work)
                     + (SELECT count(*) FROM current_obligations
                        WHERE classification = 'Active' AND NOT has_live_job))::integer
                        AS unfinished_work_count
                FROM imports
                """
            ),
            _base_params(viewer_id),
        )
        .mappings()
        .one()
    )
    return ImportSummary(
        observed_at=row["observed_at"],
        needs_attention_count=int(row["needs_attention_count"]),
        active_count=int(row["active_count"]),
        unfinished_work_count=int(row["unfinished_work_count"]),
    )


def read_import_page(db: Session, *, viewer_id: UUID, query: ImportListQuery) -> ImportPage:
    """One page of the view's imports; the count covers the whole
    filtered set, and the cursor is bound to this viewer, filter set, and order."""
    match query.view:
        case "NeedsAttention":
            plan = _ATTENTION_PLAN
        case "InProgress":
            plan = _PROGRESS_PLAN
        case "History":
            plan = _HISTORY_PLAN
    params = _base_params(viewer_id)
    filtered = _filtered_cte(query, params)
    totals = (
        db.execute(
            text(
                f"""{_IMPORTS_CTE}, {filtered}
                SELECT
                    now() AS observed_at,
                    count(*)::integer AS matched_count
                FROM filtered
                """
            ),
            params,
        )
        .mappings()
        .one()
    )

    page, next_cursor = keyset_page(
        db,
        binding={
            "list": f"imports:{query.view}:composed",
            "viewer": viewer_id,
            **query.normalized(),
        },
        plan=plan,
        cursor=query.cursor,
        limit=query.limit,
        params=params,
        sql=lambda keyset, order: f"""{_IMPORTS_CTE}, {filtered}
            SELECT * FROM filtered facts
            WHERE 1 = 1 {keyset}
            ORDER BY {order}
            LIMIT :limit
        """,
    )
    media = _hydrate_media(db, viewer_id=viewer_id, rows=page)
    matched_rows = [
        {
            "event_table": row["matched_table"],
            "id": row["matched_id"],
            "storage_id": row["matched_storage_id"],
            "occurred_at": row["matched_at"],
            "event_type": row["matched_type"],
            "stage": row["matched_stage"],
            "failure_code": row["matched_failure_code"],
            "payload": row["matched_payload"],
        }
        for row in page
        if query.view == "History" and row["matched_precedes_newest"]
    ]
    matched = {
        entry.id: entry for entry in history_entries(db, viewer_id=viewer_id, rows=matched_rows)
    }
    return ImportPage(
        observed_at=totals["observed_at"],
        matched_count=int(totals["matched_count"]),
        items=[
            _item(
                row,
                media=_linked_media(row, media),
                matched_event=(
                    matched[row["matched_id"]]
                    if query.view == "History" and row["matched_precedes_newest"]
                    else None
                ),
            )
            for row in page
        ],
        next_cursor=next_cursor,
    )


def _import_row(db: Session, *, viewer_id: UUID, ref: ParsedImportRef) -> RowMapping:
    params = _base_params(viewer_id)
    match ref:
        case UploadImportRef(session_id=session_id):
            params["session_id"] = session_id
            predicate = "session_id = :session_id"
        case MediaImportRef(media_id=media_id):
            params["media_id"] = media_id
            predicate = "ref_kind = 'media' AND media_id = :media_id"
    row = (
        db.execute(text(f"{_IMPORTS_CTE} SELECT * FROM imports WHERE {predicate}"), params)
        .mappings()
        .one_or_none()
    )
    if row is None:
        raise NotFoundError(ApiErrorCode.E_IMPORT_NOT_FOUND, "Import not found")
    return row


def _history_owner(row: RowMapping) -> HistoryOwner:
    if row["ref_kind"] == "upload":
        return UploadHistoryOwner(session_id=row["session_id"], media_id=_media_id(row))
    return MediaHistoryOwner(media_id=row["media_id"])


def read_import_detail(db: Session, *, viewer_id: UUID, ref: ParsedImportRef) -> ImportDetail:
    """One import's current row plus history coverage and source issues."""
    row = _import_row(db, viewer_id=viewer_id, ref=ref)
    media = _linked_media(row, _hydrate_media(db, viewer_id=viewer_id, rows=[row]))
    return ImportDetail(
        item=_item(row, media=media, matched_event=None),
        history_coverage=history_coverage(db, owner=_history_owner(row)),
        source_issues=(
            None
            if row["publication_generation"] is None
            else ImportSourceIssues(
                generation=int(row["publication_generation"]),
                issues=SOURCE_ISSUES.validate_python(row["source_issues"]),
            )
        ),
    )


def read_import_history(
    db: Session, *, viewer_id: UUID, ref: ParsedImportRef, cursor: str | None, limit: int
) -> HistoryPage:
    """This import's recorded events, newest first, under the detail's visibility."""
    row = _import_row(db, viewer_id=viewer_id, ref=ref)
    binding = {
        "list": "imports:history:composed",
        "viewer": viewer_id,
        "ref": format_import_ref(ref),
    }
    before: tuple[datetime, str] | None = None
    if cursor is not None:
        occurred_at, event_id = decode_keyset_cursor(cursor, binding, _EVENT_PAGE_PLAN)
        before = (cast(datetime, occurred_at), cast(str, event_id))
    entries = read_history_page(
        db, viewer_id=viewer_id, owner=_history_owner(row), before=before, limit=limit + 1
    )
    page = entries[:limit]
    next_cursor: str | None = None
    if len(entries) > limit and page:
        last = {"occurred_at": page[-1].occurred_at, "id": page[-1].id}
        next_cursor = encode_keyset_cursor(binding, _EVENT_PAGE_PLAN, last)
    return HistoryPage(entries=page, next_cursor=next_cursor)


def _media_id(row: RowMapping) -> UUID | None:
    return None if row["media_id"] is None else UUID(str(row["media_id"]))


def _linked_media(row: RowMapping, media: dict[UUID, MediaOut]) -> MediaOut | None:
    media_id = _media_id(row)
    return None if media_id is None else media[media_id]


def _hydrate_media(
    db: Session, *, viewer_id: UUID, rows: Sequence[RowMapping]
) -> dict[UUID, MediaOut]:
    media_ids = [media_id for row in rows if (media_id := _media_id(row)) is not None]
    media = {item.id: item for item in list_media_for_viewer_by_ids(db, viewer_id, media_ids)}
    if any(media_id not in media for media_id in media_ids):
        # justify-defect: every media id came from the visible-media CTE above.
        raise AssertionError("Imports media hydration lost viewer-visible rows")
    return media


def _stage(raw: str) -> Stage:
    if raw not in STAGE_RANK:
        raise AssertionError(f"import carries an unknown stage {raw!r}")
    return cast(Stage, raw)


def _waiting_reason(
    row: RowMapping, *, job_prefix: Literal["source_job", "index_job"]
) -> WaitingReason | None:
    job_id = row[f"{job_prefix}_id"]
    status = row[f"{job_prefix}_status"]
    if job_id is None or status not in {"pending", "failed"}:
        return None
    if row[f"{job_prefix}_available_at"] > row["database_now"]:
        return "RetryBackoff"
    if row["capacity_job_id"] is not None and row["capacity_job_id"] != job_id:
        return "Capacity"
    return "Queue"


def _work_state(
    row: RowMapping, media: MediaOut | None, *, obligation: Literal["source", "search"]
) -> ImportState:
    classification = row[f"{obligation}_classification"]
    stage = _stage(row["source_stage"]) if obligation == "source" else "Index"
    if classification == "Complete":
        return ImportStateComplete()
    if classification == "NeedsAttention":
        code = row[f"{obligation}_failure_code"]
        return ImportStateNeedsAttention(
            stage=stage,
            failure_code=None if code is None else assume_safe_failure_code(code),
        )
    if classification != "Active":
        raise AssertionError(f"unknown {obligation} classification {classification!r}")
    if media is None:
        return ImportStateActive(
            status="Queued",
            stage=stage,
            waiting_reason="AwaitingUploadConfirmation",
            progress=None,
            next_retry_at=None,
        )
    prefix = "source_job" if obligation == "source" else "index_job"
    waiting = _waiting_reason(row, job_prefix=prefix)
    return ImportStateActive(
        status="Processing" if row[f"{prefix}_status"] == "running" else "Queued",
        stage=stage,
        waiting_reason=waiting,
        progress=media.source_progress if obligation == "source" else None,
        next_retry_at=row[f"{prefix}_available_at"] if waiting == "RetryBackoff" else None,
    )


def _state(row: RowMapping, media: MediaOut | None) -> ImportState:
    if row["classification"] == "Complete":
        return ImportStateComplete()
    key = row.get("view_key", row["primary_key"])
    if key in {"source", "search"}:
        return _work_state(row, media, obligation=cast(Literal["source", "search"], key))
    if key != "metadata" or media is None:
        raise AssertionError("current import has no matching obligation")
    metadata = media.metadata_enrichment
    if row["classification"] == "NeedsAttention":
        operation = metadata.operation
        if operation is None:
            raise AssertionError("metadata attention requires a retained operation")
        match operation.status:
            case "failed":
                return ImportStateNeedsAttention(stage="Metadata", failure_code=operation.code)
            case "no_findings":
                return ImportStateNeedsAttention(stage="Metadata", failure_code=None)
            case _:
                raise AssertionError("metadata attention disagrees with its operation")
    operation = metadata.unfinished_operation
    if operation is None:
        raise AssertionError("active metadata requires an unfinished operation")
    running = operation.status == "running"
    waiting = operation.status == "waiting"
    return ImportStateActive(
        status="Processing" if running else "Queued",
        stage="Metadata",
        waiting_reason=None if running else ("RetryBackoff" if waiting else "Queue"),
        progress=None,
        next_retry_at=operation.until if operation.status == "waiting" else None,
    )


def _source_obligation(row: RowMapping, media: MediaOut | None) -> SourceImportObligation | None:
    if row["source_classification"] is None:
        return None
    state = _work_state(row, media, obligation="source")
    if media is None:
        rejected = row["derived_state"] == "VerificationFailed"
        return SourceImportObligation.model_validate(
            {
                "state": state.model_dump(),
                "recovery": None
                if rejected or row["origin_kind"] == "BrowserCapture"
                else RetryUploadOffer(),
                "unavailable_reason": "UploadRejected" if rejected else None,
            }
        )
    answer = source_recovery(
        SourceRecoveryFacts(
            attempt_id=row["attempt_id"],
            attempt_status=str(row["attempt_status"]),
            error_code=row["attempt_error_code"],
            source_type=str(row["source_type"]),
            processing_status=str(row["processing_status"]),
            job_id=row["attempt_job_id"],
            repairable=bool(row["source_repairable"]),
            is_creator=bool(row["is_creator"]),
        )
    )
    offered = isinstance(answer, RetrySourceOffer | RepairSourceOffer)
    return SourceImportObligation.model_validate(
        {
            "state": state.model_dump(),
            "recovery": answer if offered else None,
            "unavailable_reason": None if offered else answer,
        }
    )


def _search_obligation(row: RowMapping, media: MediaOut | None) -> SearchImportObligation | None:
    if row["search_classification"] is None:
        return None
    answer = search_recovery(
        SearchRecoveryFacts(
            revision=int(row["index_revision"]),
            dead_job_id=row["index_job_id"] if row["index_job_status"] == "dead" else None,
            is_creator=bool(row["is_creator"]),
            ready_for_reading=row["processing_status"] == "ready_for_reading",
        )
    )
    return SearchImportObligation.model_validate(
        {
            "state": _work_state(row, media, obligation="search").model_dump(),
            "recovery": answer if isinstance(answer, RepairSearchOffer) else None,
            "unavailable_reason": answer if answer == "NotOwner" else None,
        }
    )


def _item(
    row: RowMapping,
    *,
    media: MediaOut | None,
    matched_event: HistoryEntry | None,
) -> ImportItem:
    if row["source_job_id"] is not None and (
        row["source_job_kind"] != "ingest_media_source" or not row["source_job_exact"]
    ):
        # justify-defect: an attempt's job_id names its own ingest_media_source job.
        raise AssertionError("source attempt points at a foreign queue operation")
    if int(row["exact_index_job_count"] or 0) > 1:
        # justify-defect: one revision has at most one exact reindex job.
        raise AssertionError("multiple exact content-index jobs match one current revision")
    if row["index_status"] == "failed":
        # justify-defect: `failed` is a note-index status; no media owner writes it.
        raise AssertionError("media content index reports a status no owner writes")
    if row["ref_kind"] == "upload":
        ref = format_import_ref(UploadImportRef(session_id=row["session_id"]))
    else:
        ref = format_import_ref(MediaImportRef(media_id=row["media_id"]))
    host = row["source_host"]
    return ImportItem(
        ref=ref,
        title=row["title"],
        original_filename=row["original_filename"],
        media_kind=MediaKind(row["media_kind"]),
        source_label=None if host is None else str(host),
        media_ref=None if media is None else f"media:{media.id}",
        readiness=ImportReadiness(
            can_read=media.capabilities.can_read if media is not None else False,
            can_search=media.capabilities.can_search if media is not None else False,
            can_play=media.capabilities.can_play if media is not None else False,
        ),
        state=_state(row, media),
        accepted_at=row["accepted_at"],
        updated_at=row["updated_at"],
        matched_event=matched_event,
        capabilities=Capabilities(
            can_remove=media.capabilities.can_delete if media is not None else True,
        ),
        obligations=ImportObligations(
            source=_source_obligation(row, media),
            search=_search_obligation(row, media),
            metadata=media.metadata_enrichment if media is not None else None,
        ),
        source_issue_count=int(row["source_issue_count"]),
    )
