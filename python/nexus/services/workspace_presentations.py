"""Read current workspace identities without loading or mounting their bodies.

The caller supplies one read-only snapshot. Every kind is read in a batch under
its existing visibility rule; missing and invisible identities have no fact.
"""

from collections import defaultdict
from datetime import date
from urllib.parse import urlsplit
from uuid import UUID

from sqlalchemy import select, text
from sqlalchemy.orm import Session

from nexus.auth.permissions import (
    requested_media_ids_cte_sql,
    visible_contributor_ids_cte_sql,
    visible_conversation_ids_cte_sql,
)
from nexus.db.models import DailyPageBinding, MediaKind
from nexus.schemas.workspace_presentations import (
    WorkspaceContributorLocator,
    WorkspacePresentationItemOut,
    WorkspacePresentationOut,
    WorkspacePresentationsOut,
    WorkspacePresentationsRequest,
    WorkspaceResourceLocator,
)
from nexus.services import notes
from nexus.services.contributor_credits import (
    load_contributor_credits_for_media,
    load_contributor_credits_for_podcasts,
)
from nexus.services.resource_graph.refs import assert_resource_ref
from nexus.text import ECMASCRIPT_WHITESPACE


def read_presentations(
    db: Session, *, viewer_id: UUID, request: WorkspacePresentationsRequest
) -> WorkspacePresentationsOut:
    ids: dict[str, set[UUID]] = defaultdict(set)
    handles: set[str] = set()
    dates: set[date] = set()
    for locator in request.locators:
        if isinstance(locator, WorkspaceResourceLocator):
            ref = assert_resource_ref(locator.ref)
            ids[ref.scheme].add(ref.id)
        elif isinstance(locator, WorkspaceContributorLocator):
            handles.add(locator.handle)
        else:
            dates.add(locator.local_date)

    daily_bindings: dict[date, UUID] = {}
    if dates:
        rows = db.execute(
            select(DailyPageBinding.local_date, DailyPageBinding.page_id).where(
                DailyPageBinding.user_id == viewer_id,
                DailyPageBinding.local_date.in_(dates),
            )
        )
        daily_bindings = {row.local_date: row.page_id for row in rows}
        ids["page"].update(daily_bindings.values())

    facts: dict[str, WorkspacePresentationOut] = {}
    if ids["media"]:
        rows = db.execute(
            text(f"""
                SELECT m.id, m.title, m.kind, m.canonical_source_url, p.title AS show_title
                FROM media m
                LEFT JOIN podcast_episodes pe ON pe.media_id = m.id
                LEFT JOIN podcasts p ON p.id = pe.podcast_id
                WHERE m.id = ANY(:ids) AND m.id IN ({requested_media_ids_cte_sql()})
            """),
            {"ids": list(ids["media"]), "viewer_id": viewer_id},
        ).all()
        credits = load_contributor_credits_for_media(db, [row.id for row in rows])
        for row in rows:
            ref = f"media:{row.id}"
            source = row.show_title
            if not source and row.canonical_source_url:
                source = urlsplit(row.canonical_source_url).hostname
            facts[ref] = WorkspacePresentationOut(
                resource_ref=ref,
                title=row.title,
                media_kind=MediaKind(row.kind),
                contributors=credits[row.id],
                source_label=source,
            )

    if ids["library"]:
        rows = db.execute(
            text("""
                SELECT l.id, l.name, l.is_default FROM libraries l
                WHERE l.id = ANY(:ids) AND EXISTS (
                    SELECT 1 FROM memberships m
                    WHERE m.library_id = l.id AND m.user_id = :viewer_id
                )
            """),
            {"ids": list(ids["library"]), "viewer_id": viewer_id},
        )
        for row in rows:
            ref = f"library:{row.id}"
            facts[ref] = WorkspacePresentationOut(
                resource_ref=ref, title="All" if row.is_default else row.name
            )

    if ids["conversation"]:
        rows = db.execute(
            text(f"""
                SELECT id, title FROM conversations
                WHERE id = ANY(:ids) AND id IN ({visible_conversation_ids_cte_sql()})
            """),
            {"ids": list(ids["conversation"]), "viewer_id": viewer_id},
        )
        for row in rows:
            ref = f"conversation:{row.id}"
            facts[ref] = WorkspacePresentationOut(resource_ref=ref, title=row.title)

    if ids["podcast"]:
        # Podcast detail admits any persisted catalog show, without a subscription.
        rows = db.execute(
            text("SELECT id, title FROM podcasts WHERE id = ANY(:ids)"),
            {"ids": list(ids["podcast"])},
        ).all()
        credits = load_contributor_credits_for_podcasts(db, [row.id for row in rows])
        for row in rows:
            ref = f"podcast:{row.id}"
            facts[ref] = WorkspacePresentationOut(
                resource_ref=ref, title=row.title, contributors=credits[row.id]
            )

    if ids["page"]:
        for page_id, page in notes.page_facts(db, viewer_id, list(ids["page"])).items():
            ref = f"page:{page_id}"
            facts[ref] = WorkspacePresentationOut(resource_ref=ref, title=page.title)

    if ids["note_block"]:
        rows = db.execute(
            text("""
                SELECT id, left(btrim(regexp_replace(
                    split_part(body_text, chr(10), 1), :whitespace, ' ', 'g'
                )), 513) AS title
                FROM note_blocks WHERE id = ANY(:ids) AND user_id = :viewer_id AND authored_visible
            """),
            {
                "ids": list(ids["note_block"]),
                "viewer_id": viewer_id,
                "whitespace": ECMASCRIPT_WHITESPACE,
            },
        )
        for row in rows:
            ref = f"note_block:{row.id}"
            title = row.title if len(row.title) <= 512 else row.title[:511] + "…"
            facts[ref] = WorkspacePresentationOut(resource_ref=ref, title=title)

    if ids["oracle_reading"]:
        rows = db.execute(
            text("""
                SELECT id, question_text FROM oracle_readings
                WHERE id = ANY(:ids) AND user_id = :viewer_id
            """),
            {"ids": list(ids["oracle_reading"]), "viewer_id": viewer_id},
        )
        for row in rows:
            ref = f"oracle_reading:{row.id}"
            facts[ref] = WorkspacePresentationOut(resource_ref=ref, title=row.question_text)

    author_refs: dict[str, str] = {}
    if handles or ids["contributor"]:
        rows = db.execute(
            text(f"""
                SELECT id, handle, display_name FROM contributors
                WHERE (handle = ANY(:handles) OR id = ANY(:ids))
                  AND id IN ({visible_contributor_ids_cte_sql()})
            """),
            {
                "handles": list(handles),
                "ids": list(ids["contributor"]),
                "viewer_id": viewer_id,
            },
        )
        for row in rows:
            ref = f"contributor:{row.id}"
            author_refs[row.handle] = ref
            facts[ref] = WorkspacePresentationOut(resource_ref=ref, title=row.display_name)

    items = []
    for locator in request.locators:
        if isinstance(locator, WorkspaceResourceLocator):
            presentation = facts.get(locator.ref)
        elif isinstance(locator, WorkspaceContributorLocator):
            ref = author_refs.get(locator.handle)
            presentation = facts.get(ref) if ref is not None else None
        else:
            # an unbound or deleted day presents latently; opening it writes nothing.
            page_id = daily_bindings.get(locator.local_date)
            presentation = facts.get(f"page:{page_id}") or WorkspacePresentationOut(
                resource_ref=None, title=notes.daily_page_title(locator.local_date)
            )
        items.append(WorkspacePresentationItemOut(locator=locator, presentation=presentation))
    return WorkspacePresentationsOut(items=items)
