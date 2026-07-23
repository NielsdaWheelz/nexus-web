"""Contributor Dossier policy and canonical Works aggregate binding."""

from __future__ import annotations

from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.auth.permissions import visible_media_ids_cte_sql
from nexus.errors import NotFoundError
from nexus.schemas.resource_items import ResourceActivationOut
from nexus.services import contributors
from nexus.services.artifacts.bindings._shared import (
    AggregateCollected,
    AggregateMediaBinding,
    synthesis_prompt,
)
from nexus.services.artifacts.dossier_types import (
    AudienceScope,
    AudienceUser,
    DossierSubjectLocator,
    InvalidSubjectLocator,
    SubjectContributor,
)
from nexus.services.artifacts.manifests import (
    ContributorInputManifestV1,
    InputManifestV1,
    MediaManifestEntry,
)
from nexus.services.artifacts.subject_policy import ResolvedSubject
from nexus.services.contributor_taxonomy import (
    ContributorHandle,
    assume_contributor_handle,
    parse_contributor_handle,
)
from nexus.services.llm_execution import ExecutionRuntime
from nexus.services.llm_profiles import BackgroundLlmOperation
from nexus.services.resource_graph.refs import ResourceRef


class ContributorBinding(AggregateMediaBinding):
    subject_scheme = "contributor"
    llm_operation: BackgroundLlmOperation = "dossier_contributor"
    system_prompt = synthesis_prompt("a contributor across all visible credited works")
    candidates_heading = "GROUNDED CLAIMS FROM CONTRIBUTOR WORKS"

    async def collect(
        self,
        db: Session,
        resolved: ResolvedSubject,
        audience: AudienceScope,
        runtime: ExecutionRuntime,
    ) -> AggregateCollected:
        return await super().collect(
            db,
            _with_handle(db, resolved),
            audience,
            runtime,
        )

    def live_manifest(
        self, db: Session, resolved: ResolvedSubject, audience: AudienceScope
    ) -> InputManifestV1:
        return super().live_manifest(db, _with_handle(db, resolved), audience)

    def _viewer(self, db: Session, resolved: ResolvedSubject, audience: AudienceScope) -> UUID:
        return _audience_user(audience)

    def _media_ids(self, db: Session, resolved: ResolvedSubject, viewer_id: UUID) -> list[UUID]:
        return resolve_contributor_media_ids(
            db,
            contributor_id=resolved.subject_id,
            viewer_id=viewer_id,
        )

    def _manifest(
        self, resolved: ResolvedSubject, entries: list[MediaManifestEntry]
    ) -> InputManifestV1:
        if not isinstance(resolved.detail, str):
            raise AssertionError("contributor binding requires its outward handle")
        return ContributorInputManifestV1(
            contributor_handle=resolved.detail,
            works=entries,
        )

    def _context(self, db: Session, resolved: ResolvedSubject) -> str:
        display_name = db.execute(
            text("SELECT display_name FROM contributors WHERE id = :id"),
            {"id": resolved.subject_id},
        ).scalar_one()
        return f"CONTRIBUTOR: {display_name}"


class ContributorSubjectPolicy:
    subject_scheme = "contributor"

    def decode_locator(self, subject_handle: str) -> DossierSubjectLocator:
        try:
            return SubjectContributor(handle=parse_contributor_handle(subject_handle))
        except ValueError as exc:
            raise InvalidSubjectLocator() from exc

    def resolve_locator(
        self, db: Session, locator: DossierSubjectLocator, requester_user_id: UUID
    ) -> ResolvedSubject:
        if not isinstance(locator, SubjectContributor):
            raise InvalidSubjectLocator()
        ref = contributors.resolve_contributor_ref_by_handle(
            db,
            viewer_id=requester_user_id,
            contributor_handle=str(locator.handle),
        )
        return ResolvedSubject(
            scheme="contributor",
            subject_id=ref.id,
            ref=ref,
            detail=locator.handle,
        )

    def authorize_read(
        self, db: Session, resolved: ResolvedSubject, requester_user_id: UUID
    ) -> None:
        handle = _contributor_handle(db, resolved.subject_id)
        contributors.resolve_contributor_ref_by_handle(
            db,
            viewer_id=requester_user_id,
            contributor_handle=str(handle),
        )

    authorize_generate = authorize_read

    def derive_audience(self, resolved: ResolvedSubject, requester_user_id: UUID) -> AudienceScope:
        return AudienceUser(user_id=requester_user_id)

    def collection_viewer(self, resolved: ResolvedSubject, audience: AudienceScope) -> UUID | None:
        return _audience_user(audience)

    def requester_billing(self, resolved: ResolvedSubject, requester_user_id: UUID) -> UUID:
        return requester_user_id

    def citation_owner(
        self, db: Session, resolved: ResolvedSubject, audience: AudienceScope
    ) -> UUID:
        return _audience_user(audience)

    def audience_visible_source_intersection(
        self, db: Session, resolved: ResolvedSubject, audience: AudienceScope
    ) -> list[ResourceRef]:
        return [
            ResourceRef(scheme="media", id=media_id)
            for media_id in resolve_contributor_media_ids(
                db,
                contributor_id=resolved.subject_id,
                viewer_id=_audience_user(audience),
            )
        ]

    def activate(self, db: Session, ref: ResourceRef) -> ResourceActivationOut:
        handle = _contributor_handle(db, ref.id)
        return ResourceActivationOut(
            resource_ref=ref.uri,
            kind="route",
            href=f"/authors/{handle}",
            unresolved_reason=None,
        )


def resolve_contributor_media_ids(
    db: Session,
    *,
    contributor_id: UUID,
    viewer_id: UUID,
) -> list[UUID]:
    """All-role, audience-visible canonical Works, deduplicated by Media.

    Direct Media credits and every episode of a credited Podcast are the two
    Media-backed work lanes. Project Gutenberg catalog-only credits remain Works
    in the author UI but have no MediaUnit and therefore are not Dossier inputs.
    """
    rows = db.execute(
        text(
            f"""
            WITH visible_media AS ({visible_media_ids_cte_sql()}),
            credited_media AS (
                SELECT cc.media_id
                FROM contributor_credits cc
                WHERE cc.contributor_id = :contributor_id
                  AND cc.media_id IS NOT NULL

                UNION

                SELECT pe.media_id
                FROM contributor_credits cc
                JOIN podcast_episodes pe ON pe.podcast_id = cc.podcast_id
                WHERE cc.contributor_id = :contributor_id
                  AND cc.podcast_id IS NOT NULL
            )
            SELECT DISTINCT cm.media_id, m.published_date, m.title
            FROM credited_media cm
            JOIN visible_media vm ON vm.media_id = cm.media_id
            JOIN media m ON m.id = cm.media_id
            ORDER BY m.published_date DESC NULLS LAST, m.title, cm.media_id
            """
        ),
        {"viewer_id": viewer_id, "contributor_id": contributor_id},
    )
    return [UUID(str(row[0])) for row in rows]


def _with_handle(db: Session, resolved: ResolvedSubject) -> ResolvedSubject:
    if isinstance(resolved.detail, str):
        return resolved
    return ResolvedSubject(
        scheme=resolved.scheme,
        subject_id=resolved.subject_id,
        ref=resolved.ref,
        detail=_contributor_handle(db, resolved.subject_id),
    )


def _contributor_handle(db: Session, contributor_id: UUID) -> ContributorHandle:
    value = db.execute(
        text("SELECT handle FROM contributors WHERE id = :id"),
        {"id": contributor_id},
    ).scalar_one_or_none()
    if value is None:
        raise NotFoundError(message="Contributor not found")
    return assume_contributor_handle(str(value))


def _audience_user(audience: AudienceScope) -> UUID:
    if not isinstance(audience, AudienceUser):
        raise AssertionError("contributor dossier audience must be a user")
    return audience.user_id


BINDING = ContributorBinding()
POLICY = ContributorSubjectPolicy()
