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
    visible_contributor_ids_cte_sql,
    visible_conversation_ids_cte_sql,
    visible_media_ids_cte_sql,
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
from nexus.services.dossier.subjects import head_visible_sql
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

    # A head names its subject. Add visible subjects to the same narrow reads,
    # rather than hydrating the head or issuing one resolver request per artifact.
    artifact_subjects: dict[UUID, tuple[str, UUID]] = {}
    if ids["artifact"]:
        rows = db.execute(
            text(f"""
                SELECT a.id, a.subject_scheme, a.subject_id
                FROM artifacts a
                WHERE a.id = ANY(:ids) AND {head_visible_sql("a")}
            """),
            {"ids": list(ids["artifact"]), "viewer_id": viewer_id},
        )
        for row in rows:
            artifact_subjects[row.id] = (row.subject_scheme, row.subject_id)
            ids[row.subject_scheme].add(row.subject_id)

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

    # Version reads must never create the lane. The text owners start absent
    # lanes at 1; read title/body and its version in this same snapshot.
    versions: dict[str, int] = {}
    if ids["page"] or ids["note_block"]:
        rows = db.execute(
            text("""
                SELECT resource_scheme, resource_id, version FROM resource_versions
                WHERE user_id = :viewer_id AND (
                    (resource_scheme = 'page' AND lane = 'title'
                        AND resource_id = ANY(:page_ids))
                    OR (resource_scheme = 'note_block' AND lane = 'body'
                        AND resource_id = ANY(:note_ids))
                )
            """),
            {
                "viewer_id": viewer_id,
                "page_ids": list(ids["page"]),
                "note_ids": list(ids["note_block"]),
            },
        )
        versions = {f"{row.resource_scheme}:{row.resource_id}": row.version for row in rows}

    facts: dict[str, WorkspacePresentationOut] = {}
    if ids["media"]:
        rows = db.execute(
            text(f"""
                SELECT m.id, m.title, m.kind, m.canonical_source_url, p.title AS show_title
                FROM media m
                LEFT JOIN podcast_episodes pe ON pe.media_id = m.id
                LEFT JOIN podcasts p ON p.id = pe.podcast_id
                WHERE m.id = ANY(:ids) AND m.id IN ({visible_media_ids_cte_sql()})
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
            facts[ref] = WorkspacePresentationOut(
                resource_ref=ref, title=page.title, text_version=versions.get(ref, 1)
            )

    if ids["note_block"]:
        rows = db.execute(
            text("""
                SELECT id, left(btrim(regexp_replace(
                    split_part(body_text, chr(10), 1), :whitespace, ' ', 'g'
                )), 513) AS title
                FROM note_blocks WHERE id = ANY(:ids) AND user_id = :viewer_id
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
            facts[ref] = WorkspacePresentationOut(
                resource_ref=ref, title=title, text_version=versions.get(ref, 1)
            )

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

    idea_titles: dict[UUID, str] = {}
    if ids["idea"]:
        rows = db.execute(
            text("""
                SELECT id, display_title FROM artifact_idea_subjects
                WHERE id = ANY(:ids) AND user_id = :viewer_id
            """),
            {"ids": list(ids["idea"]), "viewer_id": viewer_id},
        )
        idea_titles = {row.id: row.display_title for row in rows}

    for artifact_id, (scheme, subject_id) in artifact_subjects.items():
        # justify-defect: the head's subject gate proves it exists and is visible
        # in this snapshot; a missing fact here is a defect, not unavailability.
        title = (
            idea_titles[subject_id] if scheme == "idea" else facts[f"{scheme}:{subject_id}"].title
        )
        ref = f"artifact:{artifact_id}"
        facts[ref] = WorkspacePresentationOut(resource_ref=ref, title=title)

    items = []
    for locator in request.locators:
        if isinstance(locator, WorkspaceResourceLocator):
            presentation = facts.get(locator.ref)
        elif isinstance(locator, WorkspaceContributorLocator):
            ref = author_refs.get(locator.handle)
            presentation = facts.get(ref) if ref is not None else None
        else:
            page_id = daily_bindings.get(locator.local_date)
            if page_id is not None:
                presentation = facts.get(f"page:{page_id}")
            else:
                presentation = WorkspacePresentationOut(
                    resource_ref=f"page:{notes.daily_page_id(viewer_id, locator.local_date)}",
                    title=notes.daily_page_title(locator.local_date),
                    text_version=1,
                )
        items.append(WorkspacePresentationItemOut(locator=locator, presentation=presentation))
    return WorkspacePresentationsOut(items=items)
