"""Library Dossier policy and aggregate binding."""

from __future__ import annotations

from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.auth.permissions import is_library_member, visible_media_ids_cte_sql
from nexus.errors import NotFoundError
from nexus.schemas.resource_items import ResourceActivationOut
from nexus.services.artifacts.bindings._shared import (
    AggregateMediaBinding,
    synthesis_prompt,
)
from nexus.services.artifacts.dossier_types import (
    AudienceLibrary,
    AudienceScope,
    DossierSubjectLocator,
    InvalidSubjectLocator,
    SubjectResource,
)
from nexus.services.artifacts.manifests import (
    InputManifestV1,
    LibraryInputManifestV1,
    MediaManifestEntry,
)
from nexus.services.artifacts.subject_policy import ResolvedSubject, decode_resource_locator
from nexus.services.llm_profiles import BackgroundLlmOperation
from nexus.services.resource_graph.refs import ResourceRef


class LibraryBinding(AggregateMediaBinding):
    subject_scheme = "library"
    llm_operation: BackgroundLlmOperation = "dossier_library"
    system_prompt = synthesis_prompt("a shared research library")
    candidates_heading = "GROUNDED CLAIMS FROM LIBRARY MEDIA"

    def _viewer(self, db: Session, resolved: ResolvedSubject, audience: AudienceScope) -> UUID:
        return _library_owner(db, resolved.subject_id)

    def _media_ids(self, db: Session, resolved: ResolvedSubject, viewer_id: UUID) -> list[UUID]:
        """Direct media plus every visible episode of direct Podcast entries."""
        rows = db.execute(
            text(
                f"""
                WITH visible_media AS ({visible_media_ids_cte_sql()}),
                expanded AS (
                    SELECT le.media_id, le.position, 0 AS lane,
                           NULL::timestamptz AS published_at
                    FROM library_entries le
                    WHERE le.library_id = :library_id AND le.media_id IS NOT NULL

                    UNION ALL

                    SELECT pe.media_id, le.position, 1 AS lane, pe.published_at
                    FROM library_entries le
                    JOIN podcast_episodes pe ON pe.podcast_id = le.podcast_id
                    WHERE le.library_id = :library_id AND le.podcast_id IS NOT NULL
                )
                SELECT expanded.media_id
                FROM expanded
                JOIN visible_media vm ON vm.media_id = expanded.media_id
                ORDER BY expanded.position, expanded.lane,
                         expanded.published_at DESC NULLS LAST, expanded.media_id
                """
            ),
            {"viewer_id": viewer_id, "library_id": resolved.subject_id},
        )
        return [UUID(str(row[0])) for row in rows]

    def _manifest(
        self, resolved: ResolvedSubject, entries: list[MediaManifestEntry]
    ) -> InputManifestV1:
        return LibraryInputManifestV1(
            library_ref=resolved.ref.uri,
            media=entries,
        )

    def _context(self, db: Session, resolved: ResolvedSubject) -> str:
        name = db.execute(
            text("SELECT name FROM libraries WHERE id = :id"),
            {"id": resolved.subject_id},
        ).scalar_one()
        return f"LIBRARY: {name}"


class LibrarySubjectPolicy:
    subject_scheme = "library"

    def decode_locator(self, subject_handle: str) -> DossierSubjectLocator:
        return decode_resource_locator(
            subject_scheme="library",
            subject_handle=subject_handle,
        )

    def resolve_locator(
        self, db: Session, locator: DossierSubjectLocator, requester_user_id: UUID
    ) -> ResolvedSubject:
        if not isinstance(locator, SubjectResource) or locator.ref.scheme != "library":
            raise InvalidSubjectLocator()
        if not is_library_member(db, requester_user_id, locator.ref.id):
            raise NotFoundError(message="Library not found")
        owner_id = _library_owner(db, locator.ref.id)
        return ResolvedSubject(
            scheme="library",
            subject_id=locator.ref.id,
            ref=locator.ref,
            detail=owner_id,
        )

    def authorize_read(
        self, db: Session, resolved: ResolvedSubject, requester_user_id: UUID
    ) -> None:
        if not is_library_member(db, requester_user_id, resolved.subject_id):
            raise NotFoundError(message="Library not found")

    authorize_generate = authorize_read

    def derive_audience(self, resolved: ResolvedSubject, requester_user_id: UUID) -> AudienceScope:
        return AudienceLibrary(library_id=resolved.subject_id)

    def collection_viewer(self, resolved: ResolvedSubject, audience: AudienceScope) -> UUID | None:
        if not isinstance(resolved.detail, UUID):
            raise AssertionError("resolved library must carry its owner")
        return resolved.detail

    def requester_billing(self, resolved: ResolvedSubject, requester_user_id: UUID) -> UUID:
        return requester_user_id

    def citation_owner(
        self, db: Session, resolved: ResolvedSubject, audience: AudienceScope
    ) -> UUID:
        return _library_owner(db, resolved.subject_id)

    def audience_visible_source_intersection(
        self, db: Session, resolved: ResolvedSubject, audience: AudienceScope
    ) -> list[ResourceRef]:
        owner_id = _library_owner(db, resolved.subject_id)
        return [
            ResourceRef(scheme="media", id=media_id)
            for media_id in BINDING._media_ids(db, resolved, owner_id)
        ]

    def activate(self, db: Session, ref: ResourceRef) -> ResourceActivationOut:
        return ResourceActivationOut(
            resource_ref=ref.uri,
            kind="route",
            href=f"/libraries/{ref.id}",
            unresolved_reason=None,
        )


def _library_owner(db: Session, library_id: UUID) -> UUID:
    owner = db.execute(
        text("SELECT owner_user_id FROM libraries WHERE id = :id"),
        {"id": library_id},
    ).scalar_one_or_none()
    if owner is None:
        raise NotFoundError(message="Library not found")
    return UUID(str(owner))


BINDING = LibraryBinding()
POLICY = LibrarySubjectPolicy()
