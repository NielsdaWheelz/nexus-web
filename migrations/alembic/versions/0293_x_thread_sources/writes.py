"""The d6f04890c service calls 0293 makes, as SQL at the 0293 schema.

Each function names the service it reproduces. It keeps that service's data effects
for every argument 0293 passes and narrows only what 0293 cannot reach: an accepted
embed source, a bound contributor handle, a citation dying with an index. Row locks and
``pg_notify`` wakeups are not data: 0293 holds table locks over stopped writers, and no
listener runs during a migration, so neither is kept. Jobs are inserted as the d6f04890c
queue inserted them; no registry or settings load.
"""

import json
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any
from uuid import UUID

import sqlalchemy as sa
from sqlalchemy.orm import Session
from uuid6 import uuid7

from . import html_apparatus as apparatus
from .contributor_taxonomy import (
    CONTRIBUTOR_ROLES_ORDERED,
    ContributorObservation,
    NotObserved,
    ObservedRoleSlices,
    contributor_match_key,
    new_contributor_handle,
)
from .reader_apparatus import replace_media_apparatus
from .resource_graph import (
    ResourceRef,
    bump_version,
    can_read_media,
    delete_edges_for_deleted_resources,
)
from .schemas import NotesGroup, XSourcePost
from .web_article_structure import (
    WebArticlePreparedFragment,
    prepare_web_article_fragment,
)

E_X_POST_UNAVAILABLE = "E_X_POST_UNAVAILABLE"


def _rows(db: Session, sql: str, **params: Any) -> list[sa.RowMapping]:
    return list(db.execute(sa.text(sql), params).mappings())


def _jsonb(value: object) -> str:
    return json.dumps(value)


# python/nexus/services/document_embeds.py and resource_graph/edges.py
def _edge_viewer_ids(db: Session, *, media_id: UUID) -> list[UUID]:
    return list(
        db.scalars(
            sa.text("""SELECT DISTINCT user_id FROM resource_edges
                WHERE source_scheme = 'media' AND source_id = :id AND origin = 'document_embed'
                ORDER BY user_id"""),
            {"id": media_id},
        )
    )


def _embed_rows(db: Session, *, media_id: UUID) -> list[sa.RowMapping]:
    return _rows(
        db, "SELECT * FROM document_embeds WHERE media_id = :id ORDER BY ordinal, id", id=media_id
    )


def _replace_graph_edges(
    db: Session, *, viewer_id: UUID, media_id: UUID, rows: Sequence[sa.RowMapping]
) -> None:
    """document_embeds._replace_graph_edges through edges.replace_edges_for_origin.

    Both endpoints pass the readable relation first, which is the visibility gate
    ``replace_edges_for_origin`` validates; a document-embed fact has no snapshot,
    ordinal or order key, so an unchanged target keeps its row.
    """
    targets: list[UUID] = []
    if can_read_media(db, viewer_id, media_id):
        targets = sorted(
            {
                row["target_media_id"]
                for row in rows
                if row["target_media_id"] is not None
                and can_read_media(db, viewer_id, row["target_media_id"])
            }
        )
    targets = [target for target in targets if target != media_id]
    old = _rows(
        db,
        """SELECT id, target_scheme, target_id, kind, ordinal, source_order_key, snapshot
           FROM resource_edges WHERE user_id = :viewer AND source_scheme = 'media'
             AND source_id = :media AND origin = 'document_embed'""",
        viewer=viewer_id,
        media=media_id,
    )
    removed = list(old)
    added = []
    for target in targets:
        same = next(
            (
                row
                for row in removed
                if (row["target_scheme"], row["target_id"]) == ("media", target)
                and row["kind"] == "context"
                and row["ordinal"] is None
                and row["source_order_key"] is None
                and row["snapshot"] is None
            ),
            None,
        )
        if same is not None:
            removed.remove(same)
        else:
            added.append(target)
    if removed:
        ids = [row["id"] for row in removed]
        db.execute(
            sa.text("DELETE FROM resource_view_states WHERE edge_id = ANY(:ids)"), {"ids": ids}
        )
        for row in removed:
            bump_version(db, viewer_id=viewer_id, scheme="media", resource_id=media_id)
            bump_version(
                db, viewer_id=viewer_id, scheme=row["target_scheme"], resource_id=row["target_id"]
            )
        db.execute(sa.text("DELETE FROM resource_edges WHERE id = ANY(:ids)"), {"ids": ids})
    for target in added:
        db.execute(
            sa.text("""INSERT INTO resource_edges
                (user_id, kind, origin, source_scheme, source_id, target_scheme, target_id)
                VALUES (:viewer, 'context', 'document_embed', 'media', :media, 'media', :target)"""),
            {"viewer": viewer_id, "media": media_id, "target": target},
        )
    for target in added:
        bump_version(db, viewer_id=viewer_id, scheme="media", resource_id=media_id)
        bump_version(db, viewer_id=viewer_id, scheme="media", resource_id=target)


def _set_state_counts(db: Session, *, media_id: UUID, rows: Sequence[sa.RowMapping]) -> None:
    """document_embeds._set_state_counts on the media's existing aggregate row."""
    total = len(rows)
    resolved = sum(1 for row in rows if row["resolution_status"] == "resolved")
    unsupported = sum(1 for row in rows if row["resolution_status"] == "unsupported")
    failed = sum(1 for row in rows if row["resolution_status"] == "failed")
    terminal = resolved + unsupported + failed
    if total == 0:
        status = "empty"
    elif unsupported == total:
        status = "unsupported"
    elif resolved + unsupported == total:
        status = "ready"
    elif failed == total:
        status = "failed"
    elif terminal == 0:
        status = "resolving"
    else:
        status = "partial"
    db.execute(
        sa.text("""UPDATE document_embed_artifact_states SET total_count = :total,
            resolved_count = :resolved, unsupported_count = :unsupported,
            failed_count = :failed, status = :status WHERE media_id = :media"""),
        {
            "media": media_id,
            "total": total,
            "resolved": resolved,
            "unsupported": unsupported,
            "failed": failed,
            "status": status,
        },
    )


def _target_resolution(db: Session, target_media_id: UUID) -> tuple[str, str | None, str | None]:
    """document_embeds._target_resolution."""
    target = db.execute(
        sa.text("""SELECT processing_status::text AS status, last_error_code, last_error_message
            FROM media WHERE id = :id"""),
        {"id": target_media_id},
    ).first()
    if target is None:
        return "failed", "E_MEDIA_NOT_FOUND", "Embedded media target was removed."
    if target.status == "ready_for_reading":
        return "resolved", None, None
    if target.status == "failed":
        return "failed", target.last_error_code, target.last_error_message
    return "resolving", None, None


def delete_document_embed_artifacts(db: Session, *, owner_user_id: UUID, media_id: UUID) -> None:
    """document_embeds.delete_document_embed_artifacts."""
    for viewer_id in sorted({*_edge_viewer_ids(db, media_id=media_id), owner_user_id}):
        _replace_graph_edges(db, viewer_id=viewer_id, media_id=media_id, rows=[])
    db.execute(sa.text("DELETE FROM document_embeds WHERE media_id = :id"), {"id": media_id})
    db.execute(
        sa.text("DELETE FROM document_embed_artifact_states WHERE media_id = :id"), {"id": media_id}
    )


@dataclass(frozen=True)
class EmbedOccurrence:
    """document_embeds.DocumentEmbedArtifactOccurrence for an X reference slot.

    ``target_media_id`` is a materialized target; otherwise the slot is terminal
    ``failed`` with ``error_code`` and ``error_message``.
    """

    fragment_id: UUID
    ordinal: int
    occurrence_key: str
    url: str
    provider_target_ref: str
    offset: int
    target_media_id: UUID | None
    error_code: str | None
    error_message: str | None


def replace_document_embed_artifact(
    db: Session,
    *,
    owner_user_id: UUID,
    media_id: UUID,
    source_attempt_id: UUID,
    occurrences: Sequence[EmbedOccurrence],
) -> None:
    """document_embeds.replace_document_embed_artifact for X post references
    (``provider_json`` post slots; extraction never failed; no source to accept)."""
    edge_viewer_ids = {*_edge_viewer_ids(db, media_id=media_id), owner_user_id}
    delete_document_embed_artifacts(db, owner_user_id=owner_user_id, media_id=media_id)
    for occurrence in occurrences:
        if occurrence.target_media_id is not None:
            status, error_code, error_message = _target_resolution(db, occurrence.target_media_id)
        else:
            status, error_code, error_message = (
                "failed",
                occurrence.error_code,
                occurrence.error_message,
            )
        db.execute(
            sa.text("""INSERT INTO document_embeds (media_id, fragment_id, source_attempt_id,
                ordinal, occurrence_key, provider, embed_kind, source_shape, resolution_status,
                source_url, canonical_source_url, provider_target_ref, target_media_id,
                placeholder_text, canonical_start_offset, canonical_end_offset,
                document_order_key, error_code, error_message, diagnostics)
                VALUES (:media, :fragment, :attempt, :ordinal, :key, 'x', 'post', 'provider_json',
                :status, :url, :url, :ref, :target, '', :offset, :offset, :order_key,
                :error_code, :error_message, '{}'::jsonb)"""),
            {
                "media": media_id,
                "fragment": occurrence.fragment_id,
                "attempt": source_attempt_id,
                "ordinal": occurrence.ordinal,
                "key": occurrence.occurrence_key,
                "status": status,
                "url": occurrence.url,
                "ref": occurrence.provider_target_ref.removeprefix("post:"),
                "target": occurrence.target_media_id,
                "offset": occurrence.offset,
                "order_key": f"{occurrence.ordinal:06d}",
                "error_code": error_code,
                "error_message": error_message,
            },
        )
    db.execute(
        sa.text("""INSERT INTO document_embed_artifact_states
            (media_id, source_attempt_id, status, diagnostics)
            VALUES (:media, :attempt, 'empty', '{}'::jsonb)"""),
        {"media": media_id, "attempt": source_attempt_id},
    )
    rows = _embed_rows(db, media_id=media_id)
    _set_state_counts(db, media_id=media_id, rows=rows)
    for viewer_id in sorted(edge_viewer_ids):
        _replace_graph_edges(db, viewer_id=viewer_id, media_id=media_id, rows=rows)


def resolve_x_document_embed_aliases(db: Session, *, aliases: dict[str, UUID]) -> None:
    """document_embeds.resolve_x_document_embed_aliases(unavailable_revision_ids=set())."""
    if not aliases:
        return
    sources = set(
        db.scalars(
            sa.text("SELECT media_id FROM x_post_sources WHERE media_id = ANY(:ids)"),
            {"ids": list(set(aliases.values()))},
        )
    )
    changed: set[UUID] = set()
    for row in _rows(
        db,
        """SELECT id, media_id, provider_target_ref, target_media_id, resolution_status,
                  error_code, error_message FROM document_embeds
           WHERE provider = 'x' AND provider_target_ref = ANY(:refs)
             AND canonical_end_offset IS NOT NULL""",
        refs=list(aliases),
    ):
        target = aliases.get(row["provider_target_ref"] or "")
        if target not in sources:
            continue
        current = (
            row["target_media_id"],
            row["resolution_status"],
            row["error_code"],
            row["error_message"],
        )
        if current == (target, "resolved", None, None):
            continue
        db.execute(
            sa.text("""UPDATE document_embeds SET target_media_id = :target,
                resolution_status = 'resolved', error_code = NULL, error_message = NULL
                WHERE id = :id"""),
            {"id": row["id"], "target": target},
        )
        changed.add(row["media_id"])
    for media_id in sorted(changed):
        rows = _embed_rows(db, media_id=media_id)
        _set_state_counts(db, media_id=media_id, rows=rows)
        for viewer_id in _edge_viewer_ids(db, media_id=media_id):
            _replace_graph_edges(db, viewer_id=viewer_id, media_id=media_id, rows=rows)


def sync_document_embed_targets_for_media(db: Session, *, target_media_id: UUID) -> None:
    """document_embeds.sync_document_embed_targets_for_media."""
    parents = sorted(
        set(
            db.scalars(
                sa.text("SELECT media_id FROM document_embeds WHERE target_media_id = :id"),
                {"id": target_media_id},
            )
        )
    )
    if not parents:
        return
    status, error_code, error_message = _target_resolution(db, target_media_id)
    db.execute(
        sa.text("""UPDATE document_embeds SET resolution_status = :status,
            error_code = :error_code, error_message = :error_message
            WHERE target_media_id = :id"""),
        {
            "id": target_media_id,
            "status": status,
            "error_code": error_code,
            "error_message": error_message,
        },
    )
    for media_id in parents:
        _set_state_counts(db, media_id=media_id, rows=_embed_rows(db, media_id=media_id))


def reconcile_document_embed_edges_for_viewer(
    db: Session, *, viewer_id: UUID, media_id: UUID
) -> None:
    """document_embeds.reconcile_document_embed_edges_for_viewer."""
    _replace_graph_edges(
        db, viewer_id=viewer_id, media_id=media_id, rows=_embed_rows(db, media_id=media_id)
    )


# python/nexus/services/x_ingest.py
def replace_x_post_references(
    db: Session,
    *,
    media_id: UUID,
    source_attempt_id: UUID,
    post: XSourcePost,
    aliases: dict[str, UUID],
    unavailable: set[str],
    viewer_id: UUID,
) -> None:
    """x_ingest.replace_x_post_references(article=None): one slot per direct reference."""
    fragment = db.execute(
        sa.text("SELECT id, canonical_text FROM fragments WHERE media_id = :id"), {"id": media_id}
    ).first()
    assert fragment is not None
    prior_unavailable = set(
        db.scalars(
            sa.text("""SELECT provider_target_ref FROM document_embeds
                WHERE media_id = :id AND error_code = :code"""),
            {"id": media_id, "code": E_X_POST_UNAVAILABLE},
        )
    )
    occurrences = []
    for ordinal, reference in enumerate(post.content.references):
        target_id = aliases.get(reference.target_revision_id)
        has_source = target_id is not None and db.scalar(
            sa.text("SELECT 1 FROM x_post_sources WHERE media_id = :id"), {"id": target_id}
        )
        missing = reference.target_revision_id in unavailable | prior_unavailable
        occurrences.append(
            EmbedOccurrence(
                fragment_id=fragment.id,
                ordinal=ordinal,
                occurrence_key=(
                    f"x:{media_id}:{reference.kind}:{target_id or reference.target_revision_id}"
                ),
                url=f"https://x.com/i/status/{reference.target_revision_id}",
                provider_target_ref=reference.target_revision_id,
                offset=len(fragment.canonical_text),
                target_media_id=target_id if has_source else None,
                error_code=E_X_POST_UNAVAILABLE if missing else None,
                error_message="post unavailable on x" if missing else "post not captured",
            )
        )
    replace_document_embed_artifact(
        db,
        owner_user_id=viewer_id,
        media_id=media_id,
        source_attempt_id=source_attempt_id,
        occurrences=occurrences,
    )


# python/nexus/services/web_article.py
def prepare_article(
    html: str, *, base_url: str, document_url: str, extract_embeds: bool, fragment_idx: int = 0
) -> WebArticlePreparedFragment:
    """web_article.prepare_article: a preparation failure or an unreadable page refuses."""
    try:
        prepared = prepare_web_article_fragment(
            html=html,
            base_url=base_url,
            document_url=document_url,
            fragment_idx=fragment_idx,
            extract_embeds=extract_embeds,
        )
    except Exception as exc:
        raise RuntimeError("0293 X repair required: E_SANITIZATION_FAILED") from exc
    if not prepared.canonical_text.strip() and not prepared.structure.x_embed_slots:
        raise RuntimeError("0293 X repair required: E_SOURCE_NOT_READABLE")
    return prepared


def replace_article_fragments(
    db: Session, *, media_id: UUID, fragments: Sequence[tuple[WebArticlePreparedFragment, str]]
) -> list[UUID]:
    """web_article.replace_article_fragments: fragments, blocks and apparatus."""
    db.execute(
        sa.text("UPDATE document_embeds SET fragment_id = NULL WHERE media_id = :id"),
        {"id": media_id},
    )
    db.execute(
        sa.text("""DELETE FROM fragment_blocks
            WHERE fragment_id IN (SELECT id FROM fragments WHERE media_id = :id)"""),
        {"id": media_id},
    )
    db.execute(sa.text("DELETE FROM fragments WHERE media_id = :id"), {"id": media_id})
    ids = [
        db.scalar(
            sa.text("""INSERT INTO fragments (media_id, idx, html_sanitized, canonical_text)
                VALUES (:media, :idx, :html, :text) RETURNING id"""),
            {
                "media": media_id,
                "idx": idx,
                "html": prepared.html_sanitized,
                "text": prepared.canonical_text,
            },
        )
        for idx, (prepared, _html) in enumerate(fragments)
    ]
    items: list[dict[str, object]] = []
    edges: list[dict[str, object]] = []
    note_groups: list[NotesGroup] = []
    for fragment_id, (prepared, html) in zip(ids, fragments, strict=True):
        for block in prepared.fragment_blocks:
            db.execute(
                sa.text("""INSERT INTO fragment_blocks
                    (fragment_id, block_idx, start_offset, end_offset)
                    VALUES (:fragment, :idx, :start, :end)"""),
                {
                    "fragment": fragment_id,
                    "idx": block.block_idx,
                    "start": block.start_offset,
                    "end": block.end_offset,
                },
            )
        spans = apparatus.accepted_apparatus_spans(prepared.structure, prepared.canonical_text)
        items += apparatus.attach_fragment_locators(
            media_id=media_id,
            fragment_id=fragment_id,
            media_kind="web_article",
            canonical_text=prepared.canonical_text,
            items=prepared.apparatus_items,
            accepted_spans=spans,
            html_sanitized=prepared.html_sanitized,
        )
        edges += prepared.apparatus_edges
        note_groups += apparatus.derive_fragment_note_groups(
            prepared.html_sanitized,
            prepared.canonical_text,
            fragment_id,
            structure=prepared.structure,
            accepted_spans=spans,
            source_html=html,
        )
    replace_media_apparatus(
        db, media_id=media_id, items=items, edges=edges, note_groups=note_groups
    )
    return ids


# python/nexus/services/source_attempts.py, import_history.py
def _processing_event(
    db: Session, *, media_id: UUID, stage: str, payload: dict[str, object]
) -> None:
    db.execute(
        sa.text("""INSERT INTO media_processing_events (id, media_id, stage, failure_code, payload)
            VALUES (:id, :media, :stage, NULL, CAST(:payload AS jsonb))"""),
        {"id": uuid7(), "media": media_id, "stage": stage, "payload": _jsonb(payload)},
    )


def create_succeeded_x_post_attempt(
    db: Session,
    *,
    attempt_id: UUID,
    media_id: UUID,
    actor_id: UUID,
    url: str,
    revision_id: str,
    parent_attempt_id: UUID,
) -> None:
    """source_attempts.create_attempt(source_type="x_post", status="succeeded")."""
    attempt_no = db.scalar(
        sa.text("""SELECT coalesce(max(attempt_no), 0) + 1 FROM media_source_attempts
            WHERE media_id = :media"""),
        {"media": media_id},
    )
    db.execute(
        sa.text("""INSERT INTO media_source_attempts (id, media_id, created_by_user_id,
            source_type, attempt_no, status, requested_url, canonical_source_url, provider,
            provider_target_ref, source_payload, finished_at)
            VALUES (:id, :media, :actor, 'x_post', :attempt_no, 'succeeded', :url, :url, 'x',
            :revision, CAST(:payload AS jsonb), now())"""),
        {
            "id": attempt_id,
            "media": media_id,
            "actor": actor_id,
            "attempt_no": attempt_no,
            "url": url,
            "revision": revision_id,
            "payload": _jsonb({"parent_source_attempt_id": str(parent_attempt_id)}),
        },
    )
    # source_types.source_history_stage: x_post counts no progress.
    for payload in (
        {"kind": "SourceAccepted", "source_attempt_id": str(attempt_id), "attempt_no": attempt_no},
        {"kind": "SourceSucceeded", "source_attempt_id": str(attempt_id)},
    ):
        _processing_event(db, media_id=media_id, stage="SourceProcessing", payload=payload)


# python/nexus/services/content_indexing.py, media_intelligence_lifecycle.py, jobs/queue.py
_REINDEX_JOB = "media_content_reindex_job"
# jobs/registry.py at b5e10fc93 (0293) and d6f04890c: JobDefinition.max_attempts = 3 for this
# kind; jobs/queue.py enqueue_job priority = 100, available_at = created_at = now().
_REINDEX_MAX_ATTEMPTS = 3


def _set_index_state(db: Session, *, media_id: UUID, reason: str) -> int:
    """content_indexing._set_state(status="pending", bump=1)."""
    return db.execute(
        sa.text("""
            INSERT INTO content_index_states (owner_kind, owner_id, status, status_reason,
                active_embedding_provider, active_embedding_model, revision, updated_at,
                created_at)
            VALUES ('media', :id, 'pending', :reason, NULL, NULL, 1, now(), now())
            ON CONFLICT ON CONSTRAINT uq_content_index_states_owner DO UPDATE
            SET status = EXCLUDED.status, status_reason = EXCLUDED.status_reason,
                active_embedding_provider = EXCLUDED.active_embedding_provider,
                active_embedding_model = EXCLUDED.active_embedding_model,
                revision = content_index_states.revision + 1, updated_at = now()
            RETURNING revision
        """),
        {"id": media_id, "reason": reason},
    ).scalar_one()


def retract_media_content_index(db: Session, *, media_id: UUID) -> None:
    """content_indexing.retract_media_content_index."""
    params = {"m": media_id}
    db.execute(
        sa.text("""
            DELETE FROM media_claims
            WHERE summary_id IN (SELECT id FROM media_summaries WHERE media_id = :m)
               OR evidence_span_id IN (
                   SELECT id FROM evidence_spans WHERE owner_kind = 'media' AND owner_id = :m)
        """),
        params,
    )
    db.execute(
        sa.text("""UPDATE message_retrievals mr SET evidence_span_id = NULL FROM evidence_spans es
            WHERE mr.evidence_span_id = es.id AND es.owner_kind = 'media' AND es.owner_id = :m"""),
        params,
    )
    refs = [
        ResourceRef(scheme, row_id)
        for scheme in ("evidence_span", "content_chunk")
        for row_id in db.scalars(
            sa.text(f"SELECT id FROM {scheme}s WHERE owner_kind = 'media' AND owner_id = :m"),
            params,
        )
    ]
    delete_edges_for_deleted_resources(db, refs=refs)
    db.execute(
        sa.text("""DELETE FROM content_embeddings ce USING content_chunks cc
            WHERE ce.chunk_id = cc.id AND cc.owner_kind = 'media' AND cc.owner_id = :m"""),
        params,
    )
    for table in ("content_chunks", "evidence_spans"):
        db.execute(
            sa.text(f"DELETE FROM {table} WHERE owner_kind = 'media' AND owner_id = :m"), params
        )
    _set_index_state(db, media_id=media_id, reason="transcript_replacement")


def delete_media_unit(db: Session, *, media_id: UUID) -> None:
    """media_intelligence_lifecycle.delete_media_unit."""
    db.execute(sa.text("DELETE FROM media_claims WHERE media_id = :m"), {"m": media_id})
    db.execute(sa.text("DELETE FROM media_summaries WHERE media_id = :m"), {"m": media_id})


def request_media_content_reindex(db: Session, *, media_id: UUID) -> None:
    """content_indexing.request_media_content_reindex(reason="source_success")."""
    revision = _set_index_state(db, media_id=media_id, reason="source_success")
    payload = _jsonb({"media_id": str(media_id), "revision": revision, "reason": "source_success"})
    waiting = list(
        db.scalars(
            sa.text("""SELECT id FROM background_jobs
                WHERE kind = :kind AND status IN ('pending', 'failed')
                  AND payload @> CAST(:match AS jsonb) ORDER BY created_at, id"""),
            {"kind": _REINDEX_JOB, "match": _jsonb({"media_id": str(media_id)})},
        )
    )
    for obsolete in waiting[1:]:
        db.execute(
            sa.text("""UPDATE background_jobs
                SET status = 'succeeded', result = '{"status": "superseded"}',
                    finished_at = now(), updated_at = now()
                WHERE id = :id"""),
            {"id": obsolete},
        )
    if waiting:
        db.execute(
            sa.text("""UPDATE background_jobs
                SET payload = CAST(:payload AS jsonb), status = 'pending', attempts = 0,
                    max_attempts = :max_attempts, available_at = now(), error_code = NULL,
                    last_error = NULL, result = NULL, started_at = NULL, finished_at = NULL,
                    updated_at = now()
                WHERE id = :id"""),
            {"id": waiting[0], "payload": payload, "max_attempts": _REINDEX_MAX_ATTEMPTS},
        )
    else:
        db.execute(
            sa.text("""INSERT INTO background_jobs
                (kind, payload, priority, max_attempts, available_at, dedupe_key, created_at)
                VALUES (:kind, CAST(:payload AS jsonb), 100, :max_attempts, now(), NULL, now())"""),
            {"kind": _REINDEX_JOB, "payload": payload, "max_attempts": _REINDEX_MAX_ATTEMPTS},
        )
    _processing_event(
        db,
        media_id=media_id,
        stage="Index",
        payload={"kind": "IndexAccepted", "revision": revision},
    )


# python/nexus/services/reader_publication.py
def advance_reader_publications(db: Session, *, media_ids: Sequence[UUID]) -> None:
    """reader_publication.advance_reader_publications."""
    for media_id in sorted(set(media_ids)):
        updated = db.execute(
            sa.text("""UPDATE reader_publications SET generation = generation + 1,
                changed_at = now() WHERE media_id = :id"""),
            {"id": media_id},
        ).rowcount
        if not updated:
            db.execute(
                sa.text("""INSERT INTO reader_publications (id, media_id, generation, source_issues)
                    VALUES (:id, :media, 1, '[]'::jsonb)"""),
                {"id": uuid7(), "media": media_id},
            )


# python/nexus/services/contributors.py, contributor_writes.py
@dataclass(frozen=True, eq=False)
class _Person:
    contributor_id: UUID | None  # None: a new person, created once at materialization
    display_name: str


def _plan(
    db: Session, credits: Sequence[ContributorObservation]
) -> tuple[list[_Person], list[tuple[_Person, str, str]]]:
    """contributor_writes.plan_observation_credits for credits without bound handles."""
    if not credits:
        return [], []
    pairs = [(k.authority, k.key) if (k := c.identity_key) else None for c in credits]
    claimed = [pair for pair in pairs if pair is not None]
    keys_of: dict[object, dict[str, set[str]]] = {}
    key_owner: dict[tuple[str, str], _Person] = {}
    for authority, key, cid, name in db.execute(
        sa.text("""
            SELECT x.authority, x.external_key, c.id, c.display_name
            FROM contributor_external_ids x
            JOIN contributors c ON c.id = x.contributor_id
            WHERE (x.authority, x.external_key) IN (
                SELECT a, k FROM unnest(CAST(:authorities AS text[]), CAST(:keys AS text[])) t(a, k)
            )
        """),
        {"authorities": [a for a, _ in claimed], "keys": [k for _, k in claimed]},
    ):
        key_owner[(authority, key)] = _Person(cid, name)
        keys_of.setdefault(cid, {}).setdefault(authority, set()).add(key)
    match_keys = [contributor_match_key(c.credited_name) for c in credits]
    unresolved = sorted(
        {m for m, pair in zip(match_keys, pairs, strict=True) if pair not in key_owner}
    )
    alias_winner: dict[str, _Person] = {}
    for normalized, cid, name, authority, key in db.execute(
        sa.text("""
            SELECT ca.normalized_alias, c.id, c.display_name, x.authority, x.external_key
            FROM contributor_aliases ca
            JOIN contributors c ON c.id = ca.contributor_id
            LEFT JOIN contributor_external_ids x
                   ON x.contributor_id = c.id AND x.authority = ANY(CAST(:authorities AS text[]))
            WHERE ca.normalized_alias = ANY(CAST(:match_keys AS text[])) AND ca.resolves_identity
            ORDER BY ca.normalized_alias, c.created_at, c.id
        """),
        {"authorities": sorted({a for a, _ in claimed}), "match_keys": unresolved},
    ):
        alias_winner.setdefault(normalized, _Person(cid, name))
        if authority is not None:
            keys_of.setdefault(cid, {}).setdefault(authority, set()).add(key)

    def identity(person: _Person) -> object:
        return person.contributor_id if person.contributor_id is not None else id(person)

    name_winner: dict[str, _Person] = {}
    identities: list[_Person] = []
    new_keys: list[tuple[_Person, str, str]] = []
    for match_key, pair, credit in zip(match_keys, pairs, credits, strict=True):
        winner = name_winner.get(match_key) or alias_winner.get(match_key)
        winner_keys = keys_of.get(identity(winner), {}) if winner else {}
        if pair in key_owner:
            chosen = key_owner[pair]
        elif pair is not None and winner_keys.get(pair[0], set()) - {pair[1]}:
            chosen = _Person(None, credit.credited_name)
        else:
            chosen = winner or _Person(None, credit.credited_name)
            name_winner[match_key] = chosen
        if pair is not None and pair not in key_owner:
            new_keys.append((chosen, *pair))
            key_owner[pair] = chosen
            keys_of.setdefault(identity(chosen), {}).setdefault(pair[0], set()).add(pair[1])
        identities.append(chosen)
    return identities, new_keys


def _ensure_alias(
    db: Session, *, contributor_id: UUID, alias: str, resolves_identity: bool
) -> None:
    """contributor_writes.ensure_alias."""
    normalized = contributor_match_key(alias)
    existing = db.scalar(
        sa.text("""SELECT id FROM contributor_aliases
            WHERE contributor_id = :c AND normalized_alias = :n"""),
        {"c": contributor_id, "n": normalized},
    )
    if existing is None:
        db.execute(
            sa.text("""INSERT INTO contributor_aliases
                (contributor_id, alias, normalized_alias, resolves_identity)
                VALUES (:c, :alias, :n, :resolves)"""),
            {"c": contributor_id, "alias": alias, "n": normalized, "resolves": resolves_identity},
        )
    elif resolves_identity:
        db.execute(
            sa.text(
                "UPDATE contributor_aliases SET resolves_identity = true, alias = :alias"
                " WHERE id = :id"
            ),
            {"id": existing, "alias": alias},
        )


def _create_contributor(db: Session, *, display_name: str) -> UUID:
    """contributor_writes.create_contributor."""
    handle = new_contributor_handle(display_name, distinct=False)
    if db.scalar(sa.text("SELECT id FROM contributors WHERE handle = :h"), {"h": handle}):
        handle = new_contributor_handle(display_name, distinct=True)
    contributor_id = db.scalar(
        sa.text("INSERT INTO contributors (handle, display_name) VALUES (:h, :name) RETURNING id"),
        {"h": handle, "name": display_name},
    )
    _ensure_alias(db, contributor_id=contributor_id, alias=display_name, resolves_identity=True)
    return contributor_id


def apply_observed_media_credits(
    db: Session, *, media_id: UUID, observation: ObservedRoleSlices | NotObserved, source: str
) -> None:
    """contributors.apply_observed_role_slices_in_current_transaction(MediaTarget(media_id)).

    Narrowed to observations without bound handles, which 0293's X author is.
    """
    if isinstance(observation, NotObserved):
        return
    pinned = db.scalar(
        sa.text("SELECT authors_manually_managed FROM media WHERE id = :id"), {"id": media_id}
    )
    if pinned is None:
        return
    managed_roles = observation.managed_roles - ({"author"} if pinned else set())
    credits = [c for c in observation.credits if c.role in managed_roles]
    if not managed_roles:
        return
    identities, new_keys = _plan(db, credits)
    created: dict[int, UUID] = {}

    def resolve(person: _Person) -> UUID:
        if person.contributor_id is not None:
            return person.contributor_id
        if id(person) not in created:
            created[id(person)] = _create_contributor(db, display_name=person.display_name)
        return created[id(person)]

    resolved = [resolve(person) for person in identities]
    for person, authority, key in new_keys:
        db.execute(
            sa.text("""INSERT INTO contributor_external_ids (contributor_id, authority, external_key)
                VALUES (:c, :a, :k)"""),
            {"c": resolve(person), "a": authority, "k": key},
        )
    if not _replace_role_slices(
        db,
        media_id=media_id,
        managed_roles=managed_roles,
        resolved=list(zip(resolved, credits, strict=True)),
        source=source,
    ):
        return
    for person, contributor_id, credit in zip(identities, resolved, credits, strict=True):
        _ensure_alias(
            db, contributor_id=contributor_id, alias=person.display_name, resolves_identity=True
        )
        _ensure_alias(
            db, contributor_id=contributor_id, alias=credit.credited_name, resolves_identity=False
        )


def _replace_role_slices(
    db: Session,
    *,
    media_id: UUID,
    managed_roles: frozenset[str],
    resolved: Sequence[tuple[UUID, ContributorObservation]],
    source: str,
) -> bool:
    """contributor_writes.replace_role_slices for one media's credits."""
    new_by_role: dict[str, list[tuple[UUID, ContributorObservation]]] = {}
    seen: set[tuple[str, UUID]] = set()
    for contributor_id, observation in resolved:
        if observation.role in managed_roles and (observation.role, contributor_id) not in seen:
            seen.add((observation.role, contributor_id))
            new_by_role.setdefault(observation.role, []).append((contributor_id, observation))
    current_by_role: dict[str, list[sa.RowMapping]] = {}
    for row in _rows(
        db,
        """SELECT id, contributor_id, credited_name, role, raw_role FROM contributor_credits
           WHERE media_id = :media ORDER BY ordinal""",
        media=media_id,
    ):
        current_by_role.setdefault(row["role"], []).append(row)
    changed_roles = {
        role
        for role in managed_roles
        if [
            (r["contributor_id"], r["credited_name"], r["raw_role"])
            for r in current_by_role.get(role, [])
        ]
        != [(cid, o.credited_name, o.raw_role) for cid, o in new_by_role.get(role, [])]
    }
    if not changed_roles:
        return False
    kept = [role for role in current_by_role if role not in managed_roles or role in new_by_role]
    fresh = sorted(set(new_by_role) - set(current_by_role), key=CONTRIBUTOR_ROLES_ORDERED.index)
    planned: list[sa.RowMapping | tuple[str, UUID, ContributorObservation]] = []
    for role in kept + fresh:
        if role not in changed_roles:
            planned.extend(current_by_role[role])
        else:
            planned.extend((role, cid, o) for cid, o in new_by_role[role])
    # Through a negative scratch range, as the service renumbers: (media, ordinal) is unique.
    db.execute(
        sa.text("UPDATE contributor_credits SET ordinal = -ordinal - 1 WHERE media_id = :media"),
        {"media": media_id},
    )
    db.execute(
        sa.text("DELETE FROM contributor_credits WHERE media_id = :media AND role = ANY(:roles)"),
        {"media": media_id, "roles": sorted(changed_roles)},
    )
    for ordinal, item in enumerate(planned):
        if isinstance(item, tuple):
            role, contributor_id, observation = item
            db.execute(
                sa.text("""INSERT INTO contributor_credits
                    (contributor_id, media_id, credited_name, role, raw_role, ordinal, source)
                    VALUES (:c, :media, :name, :role, :raw_role, :ordinal, :source)"""),
                {
                    "c": contributor_id,
                    "media": media_id,
                    "name": observation.credited_name,
                    "role": role,
                    "raw_role": observation.raw_role,
                    "ordinal": ordinal,
                    "source": source,
                },
            )
        else:
            db.execute(
                sa.text("UPDATE contributor_credits SET ordinal = :ordinal WHERE id = :id"),
                {"id": item["id"], "ordinal": ordinal},
            )
    return True
