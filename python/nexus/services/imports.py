"""The Imports query owner (spec `imports-workspace-hard-cutover.md`).

One classification over two owners: every upload session the viewer created and
every viewer-visible media row that has a source attempt. An upload keeps its
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
from nexus.schemas.imports import (
    Capabilities,
    HistoryPage,
    ImportDetail,
    ImportItem,
    ImportListQuery,
    ImportPage,
    ImportReadiness,
    ImportStageGroup,
    ImportState,
    ImportStateActive,
    ImportStateComplete,
    ImportStateNeedsAttention,
    ImportSummary,
    MediaImportRef,
    MediaKind,
    ParsedImportRef,
    RepairSearchOffer,
    RepairSourceOffer,
    RetrySourceOffer,
    RetryUploadOffer,
    UploadImportRef,
    WaitingReason,
    format_import_ref,
)
from nexus.schemas.media import MediaOut
from nexus.schemas.presence import Absent, Present, absent, presence_from_nullable, present
from nexus.services.collection_keyset import (
    SortKey,
    after_values,
    expected_kinds,
    keyset_clause,
    keyset_params,
    order_by_sql,
    plan_json,
)
from nexus.services.content_indexing import SearchRecoveryFacts, search_recovery
from nexus.services.import_history import (
    events_of_import_sql,
    history_coverage,
    history_entry,
    read_history_page,
)
from nexus.services.media import list_media_for_viewer_by_ids
from nexus.services.media_source_ingest import (
    SourceRecoveryFacts,
    source_recovery,
    source_repairable_sql,
)
from nexus.services.media_upload_sessions import (
    UPLOAD_SESSION_ATTENTION_STATES,
    UPLOAD_SESSION_DERIVED_STATE_SQL,
)
from nexus.services.sealed_handles import seal_upload_session, unseal_upload_session
from nexus.services.signed_keyset_cursor import (
    KeysetValue,
    KeysetValueKind,
    decode_signed_keyset_cursor,
    encode_signed_keyset_cursor,
)
from nexus.services.source_history import COUNTED_PROGRESS_SOURCE_TYPES

_HISTORY_CURSOR_FAMILY = "imports:history"

_ATTENTION_PLAN = [
    SortKey("stage_rank", "asc", KeysetValueKind.Int),
    SortKey("failed_at", "asc", KeysetValueKind.DateTime),
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
    SortKey("id", "desc", KeysetValueKind.Uuid),
]

# The host of a requested URL (scheme, optional userinfo, host, optional
# port): the label a URL import carries and the field `q` searches for it.
_URL_HOST_SQL = (
    "lower(substring({url} from"
    " '^[A-Za-z][A-Za-z0-9+.-]*://(?:[^/?#@]*@)?(\\[[^\\]]*\\]|[^/?#:]+)'))"
)

_STAGE_RANK_SQL = (
    "CASE i.current_stage "
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


# One classified row per import. `media_state` is the former Activity CTE:
# source state owns the projection until publication, then the content index does.
_IMPORTS_CTE = f"""
WITH visible_media AS (
    {visible_media_ids_cte_sql()}
), media_work AS (
    SELECT
        m.id AS media_id,
        m.kind AS media_kind,
        m.title,
        m.requested_url,
        m.processing_status::text AS processing_status,
        m.created_by_user_id = :viewer_id AS is_creator,
        m.updated_at AS media_updated_at,
        msa.id AS attempt_id,
        msa.status AS attempt_status,
        msa.source_type,
        msa.error_code AS attempt_error_code,
        msa.job_id AS attempt_job_id,
        msa.created_at AS attempt_created_at,
        msa.finished_at AS attempt_finished_at,
        msa.updated_at AS attempt_updated_at,
        CASE
            WHEN msa.source_type = ANY(CAST(:counted_source_types AS text[]))
                THEN COALESCE(msa.processing_stage, 'Validate')
            ELSE 'SourceProcessing'
        END AS source_stage,
        {source_repairable_sql("m")} AS source_repairable,
        source_job.id AS source_job_id,
        source_job.kind AS source_job_kind,
        source_job.payload @> jsonb_build_object(
            'media_id', m.id::text,
            'attempt_id', msa.id::text
        ) AS source_job_exact,
        source_job.status AS source_job_status,
        source_job.available_at AS source_job_available_at,
        source_job.finished_at AS source_job_finished_at,
        source_job.updated_at AS source_job_updated_at,
        source_job.error_code AS source_job_error_code,
        cis.status AS index_status,
        cis.revision AS index_revision,
        cis.updated_at AS index_updated_at,
        index_job.id AS index_job_id,
        index_job.status AS index_job_status,
        index_job.available_at AS index_job_available_at,
        index_job.finished_at AS index_job_finished_at,
        index_job.updated_at AS index_job_updated_at,
        index_job.error_code AS index_job_error_code,
        index_job.exact_count AS exact_index_job_count,
        CASE
            WHEN capacity.lease_expires_at > now()
              OR capacity_holder.lease_expires_at > now()
            THEN capacity.job_id
        END AS capacity_job_id
    FROM media m
    JOIN visible_media vm ON vm.media_id = m.id
    JOIN LATERAL (
        SELECT latest.*
        FROM media_source_attempts latest
        WHERE latest.media_id = m.id
        ORDER BY latest.attempt_no DESC, latest.created_at DESC, latest.id DESC
        LIMIT 1
    ) msa ON TRUE
    LEFT JOIN background_jobs source_job ON source_job.id = msa.job_id
    LEFT JOIN content_index_states cis
      ON cis.owner_kind = 'media'
     AND cis.owner_id = m.id
    LEFT JOIN LATERAL (
        SELECT exact.*, count(*) OVER () AS exact_count
        FROM background_jobs exact
        WHERE exact.kind = 'media_content_reindex_job'
          AND exact.payload @> jsonb_build_object(
              'media_id', m.id::text,
              'revision', cis.revision
          )
        ORDER BY exact.created_at DESC, exact.id DESC
        LIMIT 1
    ) index_job ON TRUE
    LEFT JOIN background_job_capacity_leases capacity
      ON capacity.resource_class = 'Heavy'
    LEFT JOIN background_jobs capacity_holder
      ON capacity_holder.id = capacity.job_id
), media_classified AS (
    SELECT
        media_work.*,
        attempt_status IN ('succeeded', 'superseded') AS source_published,
        CASE
            WHEN attempt_status NOT IN ('succeeded', 'superseded')
             AND source_job_status = 'dead'
                THEN 'NeedsAttention'
            WHEN attempt_status = 'failed'
             AND (
                source_job_status IS NULL
                OR source_job_status NOT IN ('pending', 'failed', 'running')
             )
                THEN 'NeedsAttention'
            WHEN attempt_status NOT IN ('succeeded', 'superseded')
                THEN 'Active'
            WHEN index_job_status = 'dead'
                THEN 'NeedsAttention'
            WHEN index_status IN ('pending', 'indexing')
              OR index_job_status IN ('pending', 'failed', 'running')
                THEN 'Active'
            ELSE 'Complete'
        END AS classification
    FROM media_work
), media_state AS (
    SELECT
        media_classified.*,
        CASE
            WHEN classification NOT IN ('NeedsAttention', 'Active') THEN NULL
            WHEN source_published THEN 'Index'
            ELSE source_stage
        END AS current_stage,
        -- A failed attempt's reason is the domain code its owner recorded (the
        -- code History and the recovery policy read); only a nonterminal attempt
        -- whose execution died has the queue's code as its reason.
        CASE
            WHEN classification <> 'NeedsAttention' THEN NULL
            WHEN source_published THEN {_catalogued_queue_code("index_job_error_code")}
            WHEN attempt_status = 'failed' THEN attempt_error_code
            ELSE {_catalogued_queue_code("source_job_error_code")}
        END AS failure_code,
        CASE
            WHEN classification <> 'NeedsAttention' THEN NULL
            WHEN source_published THEN COALESCE(index_job_finished_at, index_job_updated_at)
            WHEN source_job_status = 'dead'
                THEN COALESCE(source_job_finished_at, source_job_updated_at)
            ELSE COALESCE(attempt_finished_at, attempt_updated_at)
        END AS failed_at,
        GREATEST(
            media_updated_at,
            attempt_updated_at,
            source_job_updated_at,
            index_updated_at,
            index_job_updated_at
        ) AS lifecycle_updated_at
    FROM media_classified
), upload_sessions AS (
    SELECT
        id AS session_id,
        kind AS upload_kind,
        filename,
        upload_generation,
        published_media_id,
        created_at AS session_created_at,
        updated_at AS session_updated_at,
        verification_error_code,
        verification_failed_at,
        transport_failed_at,
        upload_url_expires_at,
        {UPLOAD_SESSION_DERIVED_STATE_SQL} AS derived_state
    FROM media_upload_sessions
    WHERE created_by_user_id = :viewer_id
), import_refs AS (
    SELECT
        'upload' AS ref_kind,
        session_id,
        published_media_id AS media_id,
        upload_kind,
        filename,
        upload_generation,
        derived_state,
        session_created_at,
        session_updated_at,
        verification_error_code,
        verification_failed_at,
        transport_failed_at,
        upload_url_expires_at
    FROM upload_sessions
    UNION ALL
    SELECT
        'media',
        NULL,
        media_id,
        NULL,
        NULL,
        NULL,
        NULL,
        NULL,
        NULL,
        NULL,
        NULL,
        NULL,
        NULL
    FROM media_state w
    WHERE NOT EXISTS (
        SELECT 1 FROM upload_sessions s WHERE s.published_media_id = w.media_id
    )
), imports AS (
    SELECT
        r.ref_kind,
        r.session_id,
        r.media_id,
        -- The tie-break key of every order. It is carried in cursors, so an
        -- upload session's private id appears only as a digest.
        CASE
            WHEN r.ref_kind = 'media' THEN 'media:' || r.media_id::text
            ELSE 'upload:' || md5(r.session_id::text)
        END AS ref_key,
        r.derived_state,
        r.upload_generation,
        COALESCE(r.filename, w.title) AS title,
        COALESCE(w.media_kind, r.upload_kind) AS media_kind,
        CASE
            WHEN r.ref_kind = 'media' THEN {_URL_HOST_SQL.format(url="w.requested_url")}
        END AS source_host,
        CASE
            WHEN r.derived_state IS NULL OR r.derived_state = 'Published' THEN w.classification
            WHEN r.derived_state = ANY(CAST(:attention_states AS text[])) THEN 'NeedsAttention'
            ELSE 'Active'
        END AS classification,
        CASE
            WHEN r.derived_state IS NULL OR r.derived_state = 'Published' THEN w.current_stage
            WHEN r.derived_state IN ('VerificationFailed', 'Verifying') THEN 'Validate'
            ELSE 'Upload'
        END AS current_stage,
        CASE
            WHEN r.derived_state IS NULL OR r.derived_state = 'Published' THEN w.failure_code
            WHEN r.derived_state = 'VerificationFailed' THEN r.verification_error_code
            WHEN r.derived_state = 'TransportFailed' THEN 'E_UPLOAD_TRANSPORT_FAILED'
            WHEN r.derived_state = 'CapabilityExpired' THEN 'E_UPLOAD_CAPABILITY_EXPIRED'
        END AS failure_code,
        CASE
            WHEN r.derived_state IS NULL OR r.derived_state = 'Published' THEN w.failed_at
            WHEN r.derived_state = 'VerificationFailed' THEN r.verification_failed_at
            WHEN r.derived_state = 'TransportFailed' THEN r.transport_failed_at
            WHEN r.derived_state = 'CapabilityExpired' THEN r.upload_url_expires_at
        END AS failed_at,
        CASE
            WHEN r.derived_state IS NULL OR r.derived_state = 'Published'
                THEN w.attempt_created_at
            ELSE r.session_created_at
        END AS accepted_at,
        GREATEST(r.session_updated_at, w.lifecycle_updated_at) AS updated_at,
        w.is_creator,
        w.processing_status,
        w.attempt_id,
        w.attempt_status,
        w.source_type,
        w.attempt_error_code,
        w.attempt_job_id,
        w.source_repairable,
        w.source_published,
        w.source_job_id,
        w.source_job_kind,
        w.source_job_exact,
        w.source_job_status,
        w.source_job_available_at,
        w.index_status,
        w.index_revision,
        w.index_job_id,
        w.index_job_status,
        w.index_job_available_at,
        w.exact_index_job_count,
        w.capacity_job_id,
        now() AS database_now
    FROM import_refs r
    LEFT JOIN media_state w ON w.media_id = r.media_id
    WHERE r.derived_state IS DISTINCT FROM 'Published' OR w.media_id IS NOT NULL
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
    """The view's membership over `imports`, with History's correlated match."""
    conditions: list[str] = []
    if query.q is not None:
        params["q_pattern"] = _like_pattern(query.q)
        conditions.append(
            "(i.title ILIKE :q_pattern ESCAPE '\\' OR i.source_host ILIKE :q_pattern ESCAPE '\\')"
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
            event_conditions.append("e.event_type = 'Failed' AND e.failure_code = :failure_code")
        if query.had_failures:
            event_conditions.append("e.event_type = 'Failed'")
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
                + ") failed WHERE failed.event_type = 'Failed')"
            )
        if query.state is not None:
            params["state"] = query.state
            conditions.append("i.classification = :state")
        match_join = f"""
    JOIN LATERAL (
        SELECT e.event_table AS matched_table, e.id AS matched_id,
               e.occurred_at AS matched_at, e.event_type AS matched_type,
               e.stage AS matched_stage, e.failure_code AS matched_failure_code,
               e.payload AS matched_payload,
               -- The row's own outcome already states its newest event, so only
               -- a match older than that one explains why the row was listed.
               EXISTS (
                   SELECT 1 FROM ({_EVENTS_OF_IMPORT_SQL}) newer
                   WHERE (newer.occurred_at, newer.id) > (e.occurred_at, e.id)
               ) AS matched_precedes_newest
        FROM ({_EVENTS_OF_IMPORT_SQL}) e
        WHERE {" AND ".join(event_conditions) or "TRUE"}
        ORDER BY e.occurred_at DESC, e.id DESC
        LIMIT 1
    ) matched ON TRUE"""
    else:
        conditions.append(
            "i.classification = "
            + ("'NeedsAttention'" if query.view == "NeedsAttention" else "'Active'")
        )
        if query.stage is not None:
            params["stage"] = query.stage
            conditions.append("i.current_stage = :stage")
        if query.failure_code is not None:
            params["failure_code"] = query.failure_code
            conditions.append("i.failure_code = :failure_code")
        match_join = ""
    return f"""filtered AS (
    SELECT i.*, {_STAGE_RANK_SQL} AS stage_rank{", matched.*" if match_join else ""}
    FROM imports i{match_join}
    WHERE {" AND ".join(conditions) or "TRUE"}
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
                    count(*) FILTER (WHERE classification = 'Active')::integer AS active_count
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
    )


def read_import_page(
    db: Session, *, viewer_id: UUID, query: ImportListQuery, is_admin: bool
) -> ImportPage:
    """One page of the view's imports; counts and groups cover the whole
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
    cursor_query = {
        "viewerId": str(viewer_id),
        **query.normalized(),
        "plan": plan_json(plan),
    }
    family = f"imports:{query.view}"
    totals = (
        db.execute(
            text(
                f"""{_IMPORTS_CTE}, {filtered}
                SELECT
                    now() AS observed_at,
                    (SELECT count(*) FROM filtered)::integer AS matched_count,
                    (
                        SELECT COALESCE(jsonb_object_agg(current_stage, n), '{{}}'::jsonb)
                        FROM (
                            SELECT current_stage, count(*) AS n
                            FROM filtered
                            WHERE current_stage IS NOT NULL
                            GROUP BY current_stage
                        ) stage_counts
                    ) AS stage_counts
                """
            ),
            params,
        )
        .mappings()
        .one()
    )

    keyset_sql = ""
    if query.cursor is not None:
        keyset_sql = keyset_clause(plan, alias="facts")
        params.update(
            keyset_params(
                plan,
                decode_signed_keyset_cursor(
                    query.cursor,
                    family=family,
                    query=cursor_query,
                    expected_kinds=expected_kinds(plan),
                ),
            )
        )
    params["limit_plus_one"] = query.limit + 1
    rows = (
        db.execute(
            text(
                f"""{_IMPORTS_CTE}, {filtered}
                SELECT *
                FROM filtered facts
                WHERE 1 = 1
                  {keyset_sql}
                ORDER BY {order_by_sql(plan, alias="facts")}
                LIMIT :limit_plus_one
                """
            ),
            params,
        )
        .mappings()
        .all()
    )
    page = rows[: query.limit]
    next_cursor: Absent | Present[str] = absent()
    if len(rows) > query.limit and page:
        next_cursor = present(
            encode_signed_keyset_cursor(
                family=family, query=cursor_query, after=after_values(plan, page[-1])
            )
        )
    media = _hydrate_media(db, viewer_id=viewer_id, rows=page, is_admin=is_admin)
    stage_counts = cast(dict[str, int], totals["stage_counts"])
    return ImportPage(
        observed_at=totals["observed_at"],
        matched_count=int(totals["matched_count"]),
        groups=[
            ImportStageGroup(stage=stage, count=int(stage_counts[stage]))
            for stage in STAGE_RANK
            if stage in stage_counts
        ],
        items=[
            _item(
                row,
                media=_linked_media(row, media),
                is_admin=is_admin,
                matched_event=(
                    present(
                        history_entry(
                            table=row["matched_table"],
                            event_id=row["matched_id"],
                            occurred_at=row["matched_at"],
                            event_type=row["matched_type"],
                            stage=row["matched_stage"],
                            failure_code=row["matched_failure_code"],
                            payload=row["matched_payload"],
                        )
                    )
                    if query.view == "History" and row["matched_precedes_newest"]
                    else absent()
                ),
            )
            for row in page
        ],
        next_cursor=next_cursor,
    )


def _import_row(db: Session, *, viewer_id: UUID, ref: ParsedImportRef) -> RowMapping:
    params = _base_params(viewer_id)
    match ref:
        case UploadImportRef(session_handle=session_handle):
            params["session_id"] = unseal_upload_session(session_handle)
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
        return UploadHistoryOwner(
            session_id=row["session_id"], media_id=presence_from_nullable(_media_id(row))
        )
    return MediaHistoryOwner(media_id=row["media_id"])


def read_import_detail(
    db: Session, *, viewer_id: UUID, ref: ParsedImportRef, is_admin: bool
) -> ImportDetail:
    """One import's current row plus its readiness and history coverage."""
    row = _import_row(db, viewer_id=viewer_id, ref=ref)
    media = _linked_media(
        row, _hydrate_media(db, viewer_id=viewer_id, rows=[row], is_admin=is_admin)
    )
    readiness = (
        ImportReadiness(can_read=False, can_search=False, can_play=False)
        if media is None
        else ImportReadiness(
            can_read=media.capabilities.can_read,
            can_search=media.capabilities.can_search,
            can_play=media.capabilities.can_play,
        )
    )
    return ImportDetail(
        item=_item(row, media=media, is_admin=is_admin, matched_event=absent()),
        readiness=readiness,
        history_coverage=history_coverage(db, owner=_history_owner(row)),
    )


def read_import_history(
    db: Session, *, viewer_id: UUID, ref: ParsedImportRef, cursor: str | None, limit: int
) -> HistoryPage:
    """This import's recorded events, newest first, under the detail's visibility."""
    row = _import_row(db, viewer_id=viewer_id, ref=ref)
    cursor_query = {
        "viewerId": str(viewer_id),
        "ref": str(format_import_ref(ref)),
        "plan": plan_json(_EVENT_PAGE_PLAN),
    }
    before: Absent | Present[tuple[datetime, UUID]] = absent()
    if cursor is not None:
        occurred_at, event_id = decode_signed_keyset_cursor(
            cursor,
            family=_HISTORY_CURSOR_FAMILY,
            query=cursor_query,
            expected_kinds=expected_kinds(_EVENT_PAGE_PLAN),
        )
        before = present((cast(datetime, occurred_at), cast(UUID, event_id)))
    entries = read_history_page(db, owner=_history_owner(row), before=before, limit=limit + 1)
    page = entries[:limit]
    next_cursor: Absent | Present[str] = absent()
    if len(entries) > limit and page:
        last = page[-1]
        next_cursor = present(
            encode_signed_keyset_cursor(
                family=_HISTORY_CURSOR_FAMILY,
                query=cursor_query,
                after=(
                    KeysetValue(KeysetValueKind.DateTime, last.occurred_at),
                    KeysetValue(KeysetValueKind.Uuid, last.id),
                ),
            )
        )
    return HistoryPage(entries=page, next_cursor=next_cursor)


def _media_id(row: RowMapping) -> UUID | None:
    return None if row["media_id"] is None else UUID(str(row["media_id"]))


def _linked_media(row: RowMapping, media: dict[UUID, MediaOut]) -> MediaOut | None:
    media_id = _media_id(row)
    return None if media_id is None else media[media_id]


def _hydrate_media(
    db: Session, *, viewer_id: UUID, rows: Sequence[RowMapping], is_admin: bool
) -> dict[UUID, MediaOut]:
    media_ids = [media_id for row in rows if (media_id := _media_id(row)) is not None]
    media = {
        item.id: item
        for item in list_media_for_viewer_by_ids(db, viewer_id, media_ids, is_admin=is_admin)
    }
    if any(media_id not in media for media_id in media_ids):
        # justify-defect: every media id came from the visible-media CTE above.
        raise AssertionError("Imports media hydration lost viewer-visible rows")
    return media


def _stage(row: RowMapping) -> Stage:
    stage = row["current_stage"]
    if stage not in STAGE_RANK:
        # justify-defect: the CTE derives the stage from the closed
        # processing_stage vocabulary and the closed derived upload states.
        raise AssertionError(f"import row carries an unknown stage {stage!r}")
    return cast(Stage, stage)


def _waiting_reason(
    row: RowMapping, *, job_prefix: Literal["source_job", "index_job"]
) -> Absent | Present[WaitingReason]:
    job_id = row[f"{job_prefix}_id"]
    status = row[f"{job_prefix}_status"]
    if job_id is None or status not in {"pending", "failed"}:
        return absent()
    if row[f"{job_prefix}_available_at"] > row["database_now"]:
        return present("RetryBackoff")
    if row["capacity_job_id"] is not None and row["capacity_job_id"] != job_id:
        return present("Capacity")
    return present("Queue")


def _media_active_state(row: RowMapping, media: MediaOut) -> ImportStateActive:
    job_prefix: Literal["source_job", "index_job"] = (
        "index_job" if row["source_published"] else "source_job"
    )
    waiting_reason = _waiting_reason(row, job_prefix=job_prefix)
    return ImportStateActive(
        status="Processing" if row[f"{job_prefix}_status"] == "running" else "Queued",
        stage=_stage(row),
        waiting_reason=waiting_reason,
        progress=absent() if row["source_published"] else media.source_progress,
        next_retry_at=(
            present(row[f"{job_prefix}_available_at"])
            if isinstance(waiting_reason, Present) and waiting_reason.value == "RetryBackoff"
            else absent()
        ),
    )


def _state(row: RowMapping, media: MediaOut | None) -> ImportState:
    match row["classification"]:
        case "NeedsAttention":
            if row["failed_at"] is None:
                # justify-defect: every attention state is derived from a recorded
                # failure fact whose timestamp the owner writes with it.
                raise AssertionError("attention import has no failure time")
            code = row["failure_code"]
            return ImportStateNeedsAttention(
                stage=_stage(row),
                failure_code=absent() if code is None else present(assume_safe_failure_code(code)),
            )
        case "Active":
            if media is None:
                return ImportStateActive(
                    status="Processing",
                    stage=_stage(row),
                    waiting_reason=absent(),
                    progress=absent(),
                    next_retry_at=absent(),
                )
            return _media_active_state(row, media)
        case "Complete":
            return ImportStateComplete()
        case other:
            # justify-defect: the CTE's classification CASE is closed, so an
            # unknown classification is not a state this owner can produce.
            raise AssertionError(f"import row carries an unknown classification {other!r}")


def _media_capabilities(row: RowMapping, media: MediaOut, *, is_admin: bool) -> Capabilities:
    is_creator = bool(row["is_creator"])
    source = source_recovery(
        SourceRecoveryFacts(
            attempt_id=row["attempt_id"],
            attempt_status=str(row["attempt_status"]),
            error_code=row["attempt_error_code"],
            source_type=str(row["source_type"]),
            processing_status=str(row["processing_status"]),
            job_id=row["attempt_job_id"],
            repairable=bool(row["source_repairable"]),
            is_creator=is_creator,
            is_admin=is_admin,
        )
    )
    search = (
        None
        if row["index_revision"] is None
        else search_recovery(
            SearchRecoveryFacts(
                revision=int(row["index_revision"]),
                dead_job_id=row["index_job_id"] if row["index_job_status"] == "dead" else None,
                is_creator=is_creator,
                is_admin=is_admin,
            )
        )
    )
    # The source obligation answers first; the search obligation only when the
    # source has neither an offer nor a restriction.
    answer = source if source is not None else search
    return Capabilities(
        can_open=media.capabilities.can_read,
        can_remove=media.capabilities.can_delete,
        recovery=(
            present(answer)
            if isinstance(answer, RetrySourceOffer | RepairSourceOffer | RepairSearchOffer)
            else absent()
        ),
        unavailable_reason=(
            absent()
            if answer is None
            or isinstance(answer, RetrySourceOffer | RepairSourceOffer | RepairSearchOffer)
            else present(answer)
        ),
    )


def _upload_capabilities(row: RowMapping) -> Capabilities:
    if row["derived_state"] == "VerificationFailed":
        return Capabilities(
            can_open=False,
            can_remove=True,
            recovery=absent(),
            unavailable_reason=present("UploadRejected"),
        )
    return Capabilities(
        can_open=False,
        can_remove=True,
        recovery=present(RetryUploadOffer(expected_generation=int(row["upload_generation"]))),
        unavailable_reason=absent(),
    )


def _item(
    row: RowMapping,
    *,
    media: MediaOut | None,
    is_admin: bool,
    matched_event: Absent | Present[HistoryEntry],
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
        ref = format_import_ref(
            UploadImportRef(session_handle=seal_upload_session(row["session_id"]))
        )
    else:
        ref = format_import_ref(MediaImportRef(media_id=row["media_id"]))
    host = row["source_host"]
    return ImportItem(
        ref=ref,
        title=str(row["title"]),
        media_kind=cast(MediaKind, str(row["media_kind"])),
        source_label=absent() if host is None else present(str(host)),
        media_ref=absent() if media is None else present(f"media:{media.id}"),
        state=_state(row, media),
        accepted_at=row["accepted_at"],
        updated_at=row["updated_at"],
        matched_event=matched_event,
        capabilities=(
            _upload_capabilities(row)
            if media is None
            else _media_capabilities(row, media, is_admin=is_admin)
        ),
    )
