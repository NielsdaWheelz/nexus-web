"""Portable subscriptions and durable, individually admitted OPML rows.

Preview is bounded local parsing. Confirmed immutable rows survive navigation and
restart. A worker resolves one URL without locks, then commits admission, its result
and the next existing-queue job together under the batch attempt and queue claim.
Cancellation fences pending rows; accepted subscriptions remain ordinary resources.
"""

from collections.abc import Mapping
from typing import Any
from uuid import UUID

import lxml.etree as etree
from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.db.retries import retry_serializable
from nexus.db.session import get_session_factory, transaction
from nexus.errors import ApiError, ApiErrorCode, ConflictError, InvalidRequestError, NotFoundError
from nexus.jobs.queue import (
    JobExecutionContext,
    JobResult,
    enqueue_unique_job,
    lock_running_job_claim,
)
from nexus.schemas import feed as wire
from nexus.services import libraries, users

from . import catalog, subscriptions
from .parsing import FeedPageRejected
from .queries import exportable_feed_sql

JOB_KIND = "feed_opml_step"
_RETRYABLE = {
    ApiErrorCode.E_FEED_UNAVAILABLE,
    ApiErrorCode.E_SOURCE_FETCH_FAILED,
    ApiErrorCode.E_INGEST_TIMEOUT,
}


def preview(xml: str) -> wire.OpmlPreviewOut:
    content = xml.encode("utf-8")
    if len(content) > 1024 * 1024:
        raise InvalidRequestError(message="OPML files must be at most 1 MiB")
    try:
        root = etree.fromstring(
            content, parser=etree.XMLParser(resolve_entities=False, no_network=True)
        )
    except etree.XMLSyntaxError as exc:
        raise InvalidRequestError(message="This file is not valid OPML") from exc
    if root.tag != "opml" or root.getroottree().docinfo.doctype:
        raise InvalidRequestError(message="This file is not supported OPML")
    rows: list[wire.OpmlPreviewRow] = []
    seen: dict[str, int] = {}
    stack = [(node, []) for node in reversed(root.xpath("./body/outline"))]
    while stack:
        node, parents = stack.pop()
        title = (node.get("title") or node.get("text") or "untitled feed").strip()
        raw = node.get("xmlUrl") or node.get("xmlurl")
        children = node.findall("outline")
        if raw is not None or not children:
            if len(rows) >= 1000:
                raise InvalidRequestError(message="OPML files may contain at most 1000 feeds")
            error = None
            url = None
            if raw is None:
                error = "missing feed address"
            else:
                try:
                    url = catalog.validate_and_normalize_feed_url(raw.strip())
                except ApiError:
                    error = "invalid feed address"
            ordinal = len(rows)
            duplicate = seen.get(url) if url else None
            if url:
                seen.setdefault(url, ordinal)
            rows.append(
                wire.OpmlPreviewRow(
                    ordinal=ordinal,
                    title=title,
                    url=url,
                    folder_path=parents,
                    duplicate_of=duplicate,
                    error=error,
                )
            )
        stack.extend((child, [*parents, title]) for child in reversed(children))
    return wire.OpmlPreviewOut(rows=rows)


def _normalized(body: wire.OpmlImportCreateRequest) -> list[wire.OpmlImportItemRequest]:
    rows = []
    seen: dict[tuple[str, UUID], wire.FeedKind | None] = {}
    for item in body.items:
        url = catalog.validate_and_normalize_feed_url(item.url)
        key = (url, item.library_id)
        if key in seen:
            if seen[key] != item.selected_kind:
                raise InvalidRequestError(message="The same feed has conflicting type choices")
            continue
        seen[key] = item.selected_kind
        rows.append(item.model_copy(update={"url": url}))
    return rows


def _lock(db: Session, viewer_id: UUID, batch_id: UUID):
    users.lock_viewer(db, viewer_id)
    row = (
        db.execute(
            text("SELECT * FROM feed_opml_imports WHERE id=:id AND user_id=:viewer FOR UPDATE"),
            {"id": batch_id, "viewer": viewer_id},
        )
        .mappings()
        .first()
    )
    if row is None:
        raise NotFoundError(message="OPML import not found")
    return row


def _enqueue_next(db: Session, *, batch_id: UUID) -> None:
    parent = db.execute(
        text("SELECT attempt_version,state FROM feed_opml_imports WHERE id=:id"), {"id": batch_id}
    ).one()
    if parent.state == "cancelled":
        return
    ordinal = db.scalar(
        text(
            "SELECT min(ordinal) FROM feed_opml_import_items WHERE batch_id=:id AND state='pending'"
        ),
        {"id": batch_id},
    )
    if ordinal is None:
        db.execute(
            text("""UPDATE feed_opml_imports SET current_job_id=NULL,updated_at=now(),
            state=CASE WHEN EXISTS(SELECT 1 FROM feed_opml_import_items WHERE batch_id=:id AND state='failed')
                THEN 'needs_attention' ELSE 'complete' END WHERE id=:id"""),
            {"id": batch_id},
        )
        return
    job, _ = enqueue_unique_job(
        db,
        kind=JOB_KIND,
        payload={
            "batch_id": str(batch_id),
            "expected_attempt_version": parent.attempt_version,
            "ordinal": ordinal,
        },
        dedupe_key=f"feed-opml:{batch_id}:{parent.attempt_version}:{ordinal}",
    )
    db.execute(
        text(
            "UPDATE feed_opml_imports SET current_job_id=:job,state='running',updated_at=now() WHERE id=:id"
        ),
        {"id": batch_id, "job": job.id},
    )


def create(db: Session, viewer_id: UUID, body: wire.OpmlImportCreateRequest) -> wire.OpmlImportOut:
    items = _normalized(body)

    def attempt() -> wire.OpmlImportOut:
        users.lock_viewer(db, viewer_id)
        existing = db.execute(
            text(
                "SELECT user_id,expected_removal_revision FROM feed_opml_imports WHERE id=:id FOR UPDATE"
            ),
            {"id": body.id},
        ).first()
        if existing is not None:
            retained = (
                db.execute(
                    text("""SELECT id,url,selected_kind,library_id,subscription_id,initial_import_id
                FROM feed_opml_import_items WHERE batch_id=:id ORDER BY ordinal"""),
                    {"id": body.id},
                )
                .mappings()
                .all()
            )
            if (
                existing.user_id != viewer_id
                or existing.expected_removal_revision != int(body.expected_removal_revision)
                or [dict(row) for row in retained] != [item.model_dump() for item in items]
            ):
                raise ConflictError(ApiErrorCode.E_RESOURCE_CONFLICT, "OPML import id is taken")
            return get_import(db, viewer_id, body.id)
        users.require_removal_revision(db, viewer_id, int(body.expected_removal_revision))
        libraries.lock_library_rows_in_order(db, sorted({item.library_id for item in items}))
        for library_id in {item.library_id for item in items}:
            libraries.access(db, viewer_id, library_id, lock=False).require_add_content(viewer_id)
        db.execute(
            text("""INSERT INTO feed_opml_imports(id,user_id,expected_removal_revision,state)
            VALUES (:id,:viewer,:revision,'pending')"""),
            {"id": body.id, "viewer": viewer_id, "revision": int(body.expected_removal_revision)},
        )
        db.execute(
            text("""INSERT INTO feed_opml_import_items(batch_id,ordinal,id,url,selected_kind,library_id,subscription_id,initial_import_id,state,retryable)
            VALUES (:batch,:ordinal,:id,:url,:selected_kind,:library_id,:subscription_id,:initial_import_id,'pending',false)"""),
            [
                {**item.model_dump(), "batch": body.id, "ordinal": ordinal}
                for ordinal, item in enumerate(items)
            ],
        )
        _enqueue_next(db, batch_id=body.id)
        return get_import(db, viewer_id, body.id)

    return retry_serializable(db, "create_feed_opml", attempt)


def get_import(db: Session, viewer_id: UUID, batch_id: UUID) -> wire.OpmlImportOut:
    parent = (
        db.execute(
            text("SELECT * FROM feed_opml_imports WHERE id=:id AND user_id=:viewer"),
            {"id": batch_id, "viewer": viewer_id},
        )
        .mappings()
        .first()
    )
    if parent is None:
        raise NotFoundError(message="OPML import not found")
    rows = (
        db.execute(
            text("SELECT * FROM feed_opml_import_items WHERE batch_id=:id ORDER BY ordinal"),
            {"id": batch_id},
        )
        .mappings()
        .all()
    )
    items = [
        wire.OpmlImportItemOut(
            id=row["id"],
            ordinal=row["ordinal"],
            url=row["url"],
            selected_kind=row["selected_kind"],
            library_id=row["library_id"],
            feed_id=row["feed_id"],
            subscription_id=row["admitted_subscription_id"],
            import_id=row["admitted_import_id"],
            state=row["state"],
            error_code=row["error_code"],
            error_detail=row["error_detail"],
            can_retry=row["state"] == "failed" and row["retryable"],
        )
        for row in rows
    ]
    return wire.OpmlImportOut(
        id=parent["id"],
        attempt_version=parent["attempt_version"],
        state=parent["state"],
        items=items,
        created_at=parent["created_at"],
        updated_at=parent["updated_at"],
        can_cancel=parent["state"] == "needs_attention"
        or (parent["state"] in ("pending", "running") and any(i.state == "pending" for i in items)),
        can_retry=parent["state"] == "needs_attention"
        and any(i.state == "pending" or i.can_retry for i in items),
    )


def list_imports(db: Session, viewer_id: UUID) -> list[wire.OpmlImportSummaryOut]:
    rows = (
        db.execute(
            text("""WITH selected AS (
        SELECT * FROM feed_opml_imports WHERE user_id=:viewer AND state IN ('pending','running','needs_attention')
        UNION ALL (SELECT * FROM feed_opml_imports WHERE user_id=:viewer AND state IN ('complete','cancelled')
            ORDER BY updated_at DESC,id DESC LIMIT 20))
        SELECT p.id,p.attempt_version,p.state,p.created_at,p.updated_at,
            count(*) FILTER(WHERE i.state IN ('subscribed','already_subscribed'))::int AS admitted_count,
            count(*) FILTER(WHERE i.state='pending')::int AS remaining_count,
            count(*) FILTER(WHERE i.state='failed')::int AS failed_count,
            (p.state='needs_attention' OR (p.state IN ('pending','running') AND bool_or(i.state='pending'))) AS can_cancel,
            p.state='needs_attention' AND bool_or(i.state='pending' OR (i.state='failed' AND i.retryable)) AS can_retry
        FROM selected p JOIN feed_opml_import_items i ON i.batch_id=p.id
        GROUP BY p.id,p.attempt_version,p.state,p.created_at,p.updated_at ORDER BY p.updated_at DESC,p.id DESC"""),
            {"viewer": viewer_id},
        )
        .mappings()
        .all()
    )
    return [wire.OpmlImportSummaryOut(**row) for row in rows]


def cancel(
    db: Session, viewer_id: UUID, batch_id: UUID, body: wire.OpmlImportMutationRequest
) -> wire.OpmlImportOut:
    def attempt() -> wire.OpmlImportOut:
        parent = _lock(db, viewer_id, batch_id)
        if parent["attempt_version"] != body.expected_attempt_version:
            raise ConflictError(ApiErrorCode.E_RESOURCE_CONFLICT, "OPML import changed")
        if parent["state"] not in ("complete", "cancelled"):
            db.execute(
                text(
                    "UPDATE feed_opml_imports SET state='cancelled',current_job_id=NULL,updated_at=now() WHERE id=:id"
                ),
                {"id": batch_id},
            )
            db.execute(
                text(
                    "UPDATE feed_opml_import_items SET state='cancelled' WHERE batch_id=:id AND state='pending'"
                ),
                {"id": batch_id},
            )
        return get_import(db, viewer_id, batch_id)

    return retry_serializable(db, "cancel_feed_opml", attempt)


def retry(
    db: Session, viewer_id: UUID, batch_id: UUID, body: wire.OpmlImportMutationRequest
) -> wire.OpmlImportOut:
    def attempt() -> wire.OpmlImportOut:
        parent = _lock(db, viewer_id, batch_id)
        current = get_import(db, viewer_id, batch_id)
        if parent["attempt_version"] != body.expected_attempt_version or not current.can_retry:
            raise ConflictError(ApiErrorCode.E_RESOURCE_CONFLICT, "OPML import cannot be retried")
        users.require_removal_revision(db, viewer_id, parent["expected_removal_revision"])
        db.execute(
            text("""UPDATE feed_opml_import_items SET state='pending',retryable=false,error_code=NULL,error_detail=NULL
            WHERE batch_id=:id AND state='failed' AND retryable"""),
            {"id": batch_id},
        )
        db.execute(
            text(
                "UPDATE feed_opml_imports SET attempt_version=attempt_version+1,state='pending',updated_at=now() WHERE id=:id"
            ),
            {"id": batch_id},
        )
        _enqueue_next(db, batch_id=batch_id)
        return get_import(db, viewer_id, batch_id)

    return retry_serializable(db, "retry_feed_opml", attempt)


def run_job(*, payload: Mapping[str, Any], context: JobExecutionContext) -> JobResult:
    batch_id = UUID(str(payload["batch_id"]))
    attempt_version = int(payload["expected_attempt_version"])
    ordinal = int(payload["ordinal"])
    with get_session_factory()() as db:
        with transaction(db):
            row = db.execute(
                text("""SELECT p.user_id,p.attempt_version,p.current_job_id,p.state,i.url,i.selected_kind
                FROM feed_opml_imports p JOIN feed_opml_import_items i ON i.batch_id=p.id
                WHERE p.id=:id AND i.ordinal=:ordinal AND i.state='pending'"""),
                {"id": batch_id, "ordinal": ordinal},
            ).first()
            if (
                row is None
                or row.attempt_version != attempt_version
                or row.current_job_id != context.job_id
                or row.state != "running"
            ):
                return {"status": "Stale"}
            if lock_running_job_claim(db, context=context) is None:
                return {"status": "Stale"}
            viewer_id = row.user_id
        resolved: catalog.ResolvedFeed | None = None
        failure: ApiError | None = None
        try:
            choice = catalog.resolve_url(row.url, row.selected_kind)
            if isinstance(choice, catalog.ResolvedFeed):
                resolved = choice
            else:
                failure = InvalidRequestError(
                    ApiErrorCode.E_FEED_CHOICE_REQUIRED,
                    "Review this feed address and type before subscribing",
                )
        except ApiError as exc:
            failure = exc

        def publish() -> JobResult:
            parent = _lock(db, viewer_id, batch_id)
            if (
                parent["attempt_version"] != attempt_version
                or parent["current_job_id"] != context.job_id
                or parent["state"] != "running"
            ):
                return {"status": "Stale"}
            if lock_running_job_claim(db, context=context) is None:
                return {"status": "Stale"}
            item = (
                db.execute(
                    text(
                        "SELECT * FROM feed_opml_import_items WHERE batch_id=:id AND ordinal=:ordinal AND state='pending' FOR UPDATE"
                    ),
                    {"id": batch_id, "ordinal": ordinal},
                )
                .mappings()
                .first()
            )
            if item is None:
                return {"status": "Stale"}
            error = failure
            if error is None:
                assert resolved is not None
                try:
                    with db.begin_nested():
                        users.require_removal_revision(
                            db, viewer_id, parent["expected_removal_revision"]
                        )
                        libraries.access(
                            db, viewer_id, item["library_id"], lock=False
                        ).require_add_content(viewer_id)
                        feed_id = catalog.adopt_resolved(db, viewer_id, resolved)
                        existing = db.execute(
                            text("""SELECT id,initial_import_id FROM library_feed_subscriptions
                            WHERE library_id=:library AND feed_id=:feed"""),
                            {"library": item["library_id"], "feed": feed_id},
                        ).first()
                        if existing is None:
                            admitted = subscriptions.admit_in_current_transaction(
                                db,
                                viewer_id=viewer_id,
                                library_id=item["library_id"],
                                feed_id=feed_id,
                                id=item["subscription_id"],
                                import_id=item["initial_import_id"],
                                expected_removal_revision=parent["expected_removal_revision"],
                            )
                            assert admitted.subscription is not None
                            subscription_id = admitted.subscription.id
                            import_id = admitted.subscription.initial_import_id
                            state = "subscribed"
                        else:
                            subscription_id = existing.id
                            import_id = existing.initial_import_id
                            state = "already_subscribed"
                        db.execute(
                            text("""UPDATE feed_opml_import_items SET feed_id=:feed,admitted_subscription_id=:subscription,
                            admitted_import_id=:import,state=:state,error_code=NULL,error_detail=NULL,retryable=false
                            WHERE batch_id=:id AND ordinal=:ordinal"""),
                            {
                                "feed": feed_id,
                                "subscription": subscription_id,
                                "import": import_id,
                                "state": state,
                                "id": batch_id,
                                "ordinal": ordinal,
                            },
                        )
                except ApiError as exc:
                    error = exc
            if error is not None:
                db.execute(
                    text("""UPDATE feed_opml_import_items SET state='failed',error_code=:code,error_detail=:detail,retryable=:retryable
                    WHERE batch_id=:id AND ordinal=:ordinal"""),
                    {
                        "id": batch_id,
                        "ordinal": ordinal,
                        "code": error.code.value,
                        "detail": error.message,
                        "retryable": error.code in _RETRYABLE
                        and not isinstance(error, FeedPageRejected),
                    },
                )
            _enqueue_next(db, batch_id=batch_id)
            return {"status": "Applied"}

        return retry_serializable(db, "feed.opml_step", publish)


def export(db: Session, viewer_id: UUID, library_id: UUID | None = None) -> str:
    if library_id is not None:
        library = libraries.access(db, viewer_id, library_id, lock=False)
        library.require_not_system()
        if library.is_default:
            library_id = None
    rows = db.execute(
        text(f"""SELECT p.id,p.title,p.kind,p.feed_url,p.website_url,l.id AS library_id,l.name,l.is_default
        FROM library_feed_subscriptions s JOIN feeds p ON p.id=s.feed_id
        JOIN libraries l ON l.id=s.library_id AND l.system_key IS NULL
        JOIN memberships m ON m.library_id=l.id AND m.user_id=:viewer_id
        WHERE (NOT l.is_default OR l.owner_user_id=:viewer_id)
          AND (CAST(:library_id AS uuid) IS NULL OR l.id=:library_id) AND {exportable_feed_sql("p.id")}
        ORDER BY l.is_default DESC,l.name,l.id,p.title,p.id"""),
        {"viewer_id": viewer_id, "library_id": library_id},
    ).all()
    root = etree.Element("opml", version="2.0")
    etree.SubElement(etree.SubElement(root, "head"), "title").text = "nexus subscriptions"
    body = etree.SubElement(root, "body")
    folders = {}
    for row in rows:
        parent = body
        if not row.is_default:
            if row.library_id not in folders:
                folders[row.library_id] = etree.SubElement(
                    body, "outline", text=row.name, title=row.name
                )
            parent = folders[row.library_id]
        attrs = {"text": row.title, "title": row.title, "type": "rss", "xmlUrl": row.feed_url}
        if row.website_url:
            attrs["htmlUrl"] = row.website_url
        etree.SubElement(parent, "outline", **attrs)
    return etree.tostring(root, encoding="utf-8", xml_declaration=True, pretty_print=True).decode(
        "utf-8"
    )
