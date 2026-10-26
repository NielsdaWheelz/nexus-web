"""Bounded, resumable derived inputs for local authored search.

Each request owns one read-only snapshot, never the authored head lock. The
revision hashes authorization, composition and publication facts, not source
bytes. A device stages pages durably and publishes only after a final revision
fence. Status requests check every device-held scope/reading in bounded batches;
an explicit denial withdraws that reading, never its independently admitted parts.

Text follows exact reader body and required-note slices. Only ordinary text and
parts need it: PDF/timed saved quotes remain eligible in their admitted whole
source even when quote resolution has no current locator (locations.py).
No blob, source download, reader GET mutation or authored change is involved.
"""

import base64
import hashlib
import json
from collections.abc import Iterator
from typing import Any
from uuid import UUID

from pydantic import TypeAdapter
from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.auth.permissions import (
    can_read_conversation,
    can_read_media,
    highlight_visibility_sql,
    is_library_member,
    requested_media_ids_cte_sql,
    visible_conversation_ids_cte_sql,
    visible_media_ids_cte_sql,
)
from nexus.errors import ApiErrorCode, InvalidRequestError
from nexus.schemas.authored import (
    ScopeInput,
    ScopeInputsPage,
    ScopeInputsRequest,
    ScopeTextChunk,
    ScopeTextPage,
    ScopeTextRequest,
)
from nexus.services.library_entries import library_media_ids_cte_sql
from nexus.services.media_text_scope import (
    apparatus_scope_rows_sql,
    highlight_in_reading_scope_sql,
    text_scope_rows_sql,
)
from nexus.services.reader_publication import ready_publication_rows_sql
from nexus.services.resource_graph.refs import require_ref
from nexus.services.search.scope import reading_media_ids_sql

# Leave room for the closed response envelope and continuation token.
PAGE_BYTES = 480 * 1024
PAGE_RECORDS = 100
TEXT_CODEPOINTS = 32 * 1024
_INPUT = TypeAdapter(ScopeInput)


def _json(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def _cursor(value: object) -> str:
    return base64.urlsafe_b64encode(_json(value).encode()).decode().rstrip("=")


def _decode(cursor: str) -> Any:
    try:
        if len(cursor) > 2048:
            raise ValueError("cursor exceeds bound")
        return json.loads(base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4)))
    except (ValueError, UnicodeDecodeError) as exc:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Invalid scope cursor") from exc


def _ctes() -> str:
    retained = """
        SELECT source_ref AS ref FROM authored_source_stubs WHERE account_id=:viewer_id
        UNION SELECT state->>'source_ref' FROM authored_passages WHERE account_id=:viewer_id
        UNION SELECT state->>'source_ref' FROM authored_resources
            WHERE account_id=:viewer_id AND state->>'kind'='highlight'
        UNION SELECT state->>'endpoint_a' FROM authored_links WHERE account_id=:viewer_id
        UNION SELECT state->>'endpoint_b' FROM authored_links WHERE account_id=:viewer_id
        UNION SELECT e.target_scheme||':'||e.target_id::text FROM resource_edges e
            WHERE e.user_id=:viewer_id AND e.origin='note_body'
                AND e.source_scheme='note_block'
        UNION SELECT 'media:'||e.target_id::text FROM resource_edges e
            JOIN conversations c ON c.id=e.source_id AND c.owner_user_id=:viewer_id
            WHERE e.user_id=:viewer_id AND e.source_scheme='conversation'
                AND e.target_scheme='media' AND e.origin IN ('citation','system')
                AND e.ordinal IS NULL AND e.authored_visible
    """
    expanded = reading_media_ids_sql("SELECT root.media_id")
    library = reading_media_ids_sql(library_media_ids_cte_sql(library_param="library.id"))
    intervals = text_scope_rows_sql("SELECT media_id FROM readings")
    apparatus = apparatus_scope_rows_sql("SELECT media_id FROM readings WHERE is_part")
    return f"""WITH
        authorized AS MATERIALIZED ({requested_media_ids_cte_sql()}),
        retained_refs AS MATERIALIZED ({retained}),
        roots AS MATERIALIZED (
            SELECT media_id FROM ({visible_media_ids_cte_sql()}) visible
            UNION SELECT m.id FROM retained_refs retained
                JOIN media m ON retained.ref='media:'||m.id::text
                JOIN authorized a ON a.media_id=m.id
        ),
        members AS MATERIALIZED (
            SELECT DISTINCT root.media_id AS root_id,expanded.media_id
            FROM roots root CROSS JOIN LATERAL ({expanded}) expanded
            JOIN authorized a ON a.media_id=expanded.media_id
        ),
        readings AS MATERIALIZED (
            SELECT DISTINCT m.id AS media_id,COALESCE(p.source_media_id,m.id) AS source_id,
                source.kind AS source_kind,own.generation AS body_generation,
                CASE WHEN p.media_id IS NULL THEN own.generation ELSE p.source_generation END AS source_generation,
                p.media_id IS NOT NULL AS is_part,
                (own.generation IS NOT NULL AND (p.media_id IS NULL OR current.generation=p.source_generation)) AS text_ready
            FROM members member JOIN media m ON m.id=member.media_id
            LEFT JOIN media_parts p ON p.media_id=m.id
            JOIN media source ON source.id=COALESCE(p.source_media_id,m.id)
            LEFT JOIN ({ready_publication_rows_sql()}) own ON own.media_id=m.id
            LEFT JOIN ({ready_publication_rows_sql()}) current ON current.media_id=source.id
        ),
        scope_libraries AS MATERIALIZED (
            SELECT l.id FROM libraries l JOIN memberships membership ON membership.library_id=l.id
            WHERE membership.user_id=:viewer_id
        ),
        library_members AS MATERIALIZED (
            SELECT DISTINCT library.id AS library_id,expanded.media_id
            FROM scope_libraries library CROSS JOIN LATERAL ({library}) expanded
            JOIN readings reading ON reading.media_id=expanded.media_id
        ),
        conversations AS MATERIALIZED ({visible_conversation_ids_cte_sql()}),
        body_intervals AS MATERIALIZED (
            SELECT bounded.reading_media_id,bounded.fragment_id,bounded.fragment_idx,
                bounded.start_offset,bounded.end_offset,'body'::text AS purpose
            FROM ({intervals}) bounded JOIN readings r ON r.media_id=bounded.reading_media_id
            WHERE r.text_ready AND r.source_kind IN ('epub','web_article')
                AND bounded.start_offset<bounded.end_offset
        ),
        note_intervals AS MATERIALIZED (
            SELECT DISTINCT admitted.reading_media_id,f.id AS fragment_id,f.idx AS fragment_idx,
                (item.locator->>'start_offset')::integer AS start_offset,
                (item.locator->>'end_offset')::integer AS end_offset,'required_note'::text AS purpose
            FROM ({apparatus}) admitted
            JOIN readings r ON r.media_id=admitted.reading_media_id AND r.text_ready AND r.is_part
            JOIN reader_apparatus_items item ON item.id=admitted.apparatus_item_id
                AND item.locator_status='exact'
                AND item.locator->>'type' IN ('web_text_offsets','epub_fragment_offsets')
                AND item.locator->>'media_id'=r.source_id::text
            JOIN fragments f ON f.id=(item.locator->>'fragment_id')::uuid AND f.media_id=r.source_id
            WHERE (item.locator->>'start_offset')::integer<(item.locator->>'end_offset')::integer
              AND NOT EXISTS (SELECT 1 FROM body_intervals body
                WHERE body.reading_media_id=admitted.reading_media_id AND body.fragment_id=f.id
                  AND body.start_offset<=(item.locator->>'start_offset')::integer
                  AND body.end_offset>=(item.locator->>'end_offset')::integer)
        ),
        intervals AS MATERIALIZED (
            SELECT owned.*,owned.reading_media_id::text||':'||owned.fragment_id::text||':'||owned.purpose||':'||owned.start_offset::text||':'||owned.end_offset::text AS interval_key,
                owned.start_offset>0 AS start_cut,owned.end_offset<char_length(f.canonical_text) AS end_cut
            FROM (SELECT * FROM body_intervals UNION ALL SELECT * FROM note_intervals) owned
            JOIN fragments f ON f.id=owned.fragment_id
        )"""


def _records(db: Session, viewer_id: UUID) -> Iterator[tuple[str, dict[str, Any]]]:
    """Stream canonical metadata; no source text enters the digest or page buffer."""
    relation = f"""
        SELECT 'scope:media:'||media_id::text AS key,
            jsonb_build_object('kind','scope','scope_ref','media:'||media_id::text) AS state FROM roots
        UNION ALL SELECT 'scope:library:'||id::text,
            jsonb_build_object('kind','scope','scope_ref','library:'||id::text) FROM scope_libraries
        UNION ALL SELECT 'scope:conversation:'||conversation_id::text,
            jsonb_build_object('kind','scope','scope_ref','conversation:'||conversation_id::text) FROM conversations
        UNION ALL SELECT 'media:'||root_id::text||':'||media_id::text,
            jsonb_build_object('kind','media_member','root_ref','media:'||root_id::text,'reading_ref','media:'||media_id::text) FROM members
        UNION ALL SELECT 'library:'||library_id::text||':'||media_id::text,
            jsonb_build_object('kind','library_member','library_ref','library:'||library_id::text,'reading_ref','media:'||media_id::text) FROM library_members
        UNION ALL SELECT DISTINCT 'context:'||e.source_id::text||':'||e.target_scheme||':'||e.target_id::text,
            jsonb_build_object('kind','conversation_fact','conversation_ref','conversation:'||e.source_id::text,'target_ref',e.target_scheme||':'||e.target_id::text)
            FROM resource_edges e JOIN conversations c ON c.conversation_id=e.source_id
            WHERE e.user_id=:viewer_id AND e.source_scheme='conversation'
                AND e.origin IN ('citation','system') AND e.ordinal IS NULL AND e.authored_visible
        UNION ALL SELECT 'reading:'||media_id::text,
            jsonb_build_object('kind','reading','reading_ref','media:'||media_id::text,'source_ref','media:'||source_id::text,'source_kind',source_kind,'body_generation',body_generation,'source_generation',source_generation) FROM readings
        UNION ALL SELECT DISTINCT 'alias:'||part.media_id::text,
            jsonb_build_object('kind','source_alias','reading_ref','media:'||part.media_id::text,'source_ref','media:'||part.source_media_id::text)
            FROM retained_refs retained JOIN media_parts part ON retained.ref='media:'||part.media_id::text
            WHERE EXISTS (SELECT 1 FROM readings r WHERE r.source_id=part.source_media_id)
        UNION ALL SELECT 'highlight_member:'||h.id::text||':'||r.media_id::text,
            jsonb_build_object('kind','highlight_member','highlight_ref','highlight:'||h.id::text,'reading_ref','media:'||r.media_id::text)
            FROM highlights h JOIN readings r ON r.source_id=h.anchor_media_id
            WHERE h.user_id<>:viewer_id AND h.authored_visible
                AND ({highlight_visibility_sql("h")} OR EXISTS (
                    SELECT 1 FROM retained_refs retained
                    WHERE retained.ref='highlight:'||h.id::text))
                AND (r.media_id=h.anchor_media_id OR (h.anchor_kind='fragment_offsets'
                    AND {highlight_in_reading_scope_sql("h.id", "r.media_id")}))
        UNION ALL SELECT 'interval:'||interval_key,
            jsonb_build_object('kind','interval','interval_key',interval_key,'reading_ref','media:'||reading_media_id::text,'fragment_id',fragment_id,'fragment_idx',fragment_idx,'start_offset',start_offset,'end_offset',end_offset,'purpose',purpose,'start_cut',start_cut,'end_cut',end_cut) FROM intervals
    """
    rows = db.execute(
        text(_ctes() + f' SELECT key,state FROM ({relation}) facts ORDER BY key COLLATE "C"'),
        {"viewer_id": viewer_id},
        execution_options={"yield_per": 256},
    )
    try:
        for row in rows:
            yield row.key, row.state
    finally:
        rows.close()


def _revision(db: Session, viewer_id: UUID) -> str:
    digest = hashlib.sha256(b"nexus-authored-scope:1\n")
    for key, record in _records(db, viewer_id):
        digest.update(_json([key, record]).encode())
        digest.update(b"\n")
    return digest.hexdigest()


def _authorized(db: Session, viewer_id: UUID, ref: str) -> bool:
    value = require_ref(ref)
    if value.scheme == "media":
        return can_read_media(db, viewer_id, value.id)
    if value.scheme == "library":
        return is_library_member(db, viewer_id, value.id)
    if value.scheme == "conversation":
        return can_read_conversation(db, viewer_id, value.id)
    raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Invalid search scope reference")


def inputs(db: Session, viewer_id: UUID, request: ScopeInputsRequest) -> ScopeInputsPage:
    revision = _revision(db, viewer_id)
    revoked = (
        [ref for ref in request.active_refs if not _authorized(db, viewer_id, ref)]
        if request.kind == "status"
        else []
    )
    restart = request.revision is not None and request.revision != revision
    if request.kind != "metadata" or restart:
        return ScopeInputsPage(
            revision=revision, restart=restart, revoked_refs=revoked, records=[], next_cursor=None
        )
    after = None if request.cursor is None else _decode(request.cursor)
    if after is not None and (not isinstance(after, str) or request.revision is None):
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Invalid metadata cursor")
    records: list[ScopeInput] = []
    size = 0
    last = None
    more = False
    for key, state in _records(db, viewer_id):
        if after is not None and key <= after:
            continue
        record_size = len(_json(state).encode())
        if record_size > PAGE_BYTES:
            raise InvalidRequestError(
                ApiErrorCode.E_CAPTURE_TOO_LARGE, "Search scope metadata record exceeds page limit"
            )
        if records and (len(records) == PAGE_RECORDS or size + record_size > PAGE_BYTES):
            more = True
            break
        records.append(_INPUT.validate_python(state))
        size += record_size
        last = key
    return ScopeInputsPage(
        revision=revision,
        restart=False,
        revoked_refs=[],
        records=records,
        next_cursor=_cursor(last) if more else None,
    )


def source_text(db: Session, viewer_id: UUID, request: ScopeTextRequest) -> ScopeTextPage:
    authorized = _authorized(db, viewer_id, request.reading_ref)
    revision = _revision(db, viewer_id)
    if not authorized or revision != request.revision:
        return ScopeTextPage(
            revision=revision,
            restart=True,
            revoked_refs=[] if authorized else [request.reading_ref],
            reading_ref=request.reading_ref,
            chunks=[],
            next_cursor=None,
        )
    reading = require_ref(request.reading_ref)
    if reading.scheme != "media":
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Text requires a media reading")
    after = None if request.cursor is None else _decode(request.cursor)
    if after is not None and (
        not isinstance(after, list)
        or len(after) != 2
        or not isinstance(after[0], str)
        or not isinstance(after[1], int)
        or isinstance(after[1], bool)
        or after[1] < 0
    ):
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Invalid text cursor")
    # The SQL asks PostgreSQL for bounded substrings, never a complete large fragment.
    chunks: list[ScopeTextChunk] = []
    size = 0
    next_cursor = None
    rows = db.execute(
        text(
            _ctes()
            + """
            SELECT owned.interval_key,owned.fragment_id,owned.fragment_idx,owned.start_offset,owned.end_offset
            FROM intervals owned WHERE owned.reading_media_id=:reading
            ORDER BY owned.interval_key COLLATE "C"
        """
        ),
        {"viewer_id": viewer_id, "reading": reading.id},
    )
    for interval_key, fragment_id, fragment_idx, lo, hi in rows:
        if after is not None and interval_key < after[0]:
            continue
        start = max(lo, after[1]) if after is not None and interval_key == after[0] else lo
        if start > hi:
            raise InvalidRequestError(
                ApiErrorCode.E_INVALID_REQUEST, "Text cursor exceeds interval"
            )
        while start < hi:
            count = min(TEXT_CODEPOINTS, hi - start)
            words = db.scalar(
                text(
                    "SELECT substring(canonical_text FROM :start FOR :count) FROM fragments WHERE id=:fragment"
                ),
                {"start": start + 1, "count": count, "fragment": fragment_id},
            )
            if not isinstance(words, str) or len(words) != count:
                raise RuntimeError("scope text interval exceeds its canonical fragment")
            chunk = ScopeTextChunk(
                interval_key=interval_key,
                fragment_id=fragment_id,
                fragment_idx=fragment_idx,
                start_offset=start,
                text=words,
            )
            encoded = len(chunk.model_dump_json().encode())
            if encoded > PAGE_BYTES:
                raise RuntimeError("bounded scope text chunk exceeds page limit")
            if chunks and (len(chunks) == PAGE_RECORDS or size + encoded > PAGE_BYTES):
                next_cursor = _cursor([interval_key, start])
                break
            chunks.append(chunk)
            size += encoded
            start += count
        if next_cursor is not None:
            break
    return ScopeTextPage(
        revision=revision,
        restart=False,
        revoked_refs=[],
        reading_ref=request.reading_ref,
        chunks=chunks,
        next_cursor=next_cursor,
    )
