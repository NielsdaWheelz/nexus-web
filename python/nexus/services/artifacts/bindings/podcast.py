"""Podcast Dossier policy and episode aggregate binding."""

from __future__ import annotations

from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.auth.permissions import visible_media_ids_cte_sql, visible_podcast_ids_cte_sql
from nexus.errors import NotFoundError
from nexus.services.artifacts.bindings._shared import (
    AggregateMediaBinding,
    audience_user,
    synthesis_prompt,
)
from nexus.services.artifacts.bindings.base import DossierOperation, require_resource_subject
from nexus.services.artifacts.dossier_types import (
    AudienceScope,
    AudienceUser,
    DossierSubjectLocator,
    InvalidSubjectLocator,
    SubjectResource,
)
from nexus.services.artifacts.manifests import (
    InputManifestV1,
    MediaManifestEntry,
    PodcastInputManifestV1,
)
from nexus.services.artifacts.subject_policy import (
    ResolvedResourceSubject,
    ResolvedSubject,
    decode_resource_locator,
)


class PodcastBinding(AggregateMediaBinding):
    subject_scheme = "podcast"
    llm_operation: DossierOperation = "dossier_podcast"
    system_prompt = synthesis_prompt("a podcast across all of its available episodes")
    candidates_heading = "GROUNDED CLAIMS FROM PODCAST EPISODES"

    def _viewer(self, db: Session, resolved: ResolvedSubject, audience: AudienceScope) -> UUID:
        return audience_user(audience)

    def _media_ids(self, db: Session, resolved: ResolvedSubject, viewer_id: UUID) -> list[UUID]:
        rows = db.execute(
            text(
                f"""
                WITH visible_media AS ({visible_media_ids_cte_sql()})
                SELECT pe.media_id
                FROM podcast_episodes pe
                JOIN visible_media vm ON vm.media_id = pe.media_id
                WHERE pe.podcast_id = :podcast_id
                ORDER BY pe.published_at DESC NULLS LAST, pe.media_id
                """
            ),
            {"viewer_id": viewer_id, "podcast_id": resolved.subject_id},
        )
        return [UUID(str(row[0])) for row in rows]

    def _manifest(
        self, resolved: ResolvedSubject, entries: list[MediaManifestEntry]
    ) -> InputManifestV1:
        resolved = require_resource_subject(resolved)
        return PodcastInputManifestV1(
            podcast_ref=resolved.ref.uri,
            episodes=entries,
        )

    def _context(self, db: Session, resolved: ResolvedSubject) -> str:
        title = db.execute(
            text("SELECT title FROM podcasts WHERE id = :id"),
            {"id": resolved.subject_id},
        ).scalar_one()
        return f"PODCAST: {title}"


class PodcastSubjectPolicy:
    subject_scheme = "podcast"

    def decode_locator(self, subject_handle: str) -> DossierSubjectLocator:
        return decode_resource_locator(
            subject_scheme="podcast",
            subject_handle=subject_handle,
        )

    def resolve_locator(
        self, db: Session, locator: DossierSubjectLocator, requester_user_id: UUID
    ) -> ResolvedSubject:
        if not isinstance(locator, SubjectResource) or locator.ref.scheme != "podcast":
            raise InvalidSubjectLocator()
        if not _podcast_visible(db, requester_user_id, locator.ref.id):
            raise NotFoundError(message="Podcast not found")
        return ResolvedResourceSubject(
            scheme="podcast",
            subject_id=locator.ref.id,
            ref=locator.ref,
        )

    def authorize_read(
        self, db: Session, resolved: ResolvedSubject, requester_user_id: UUID
    ) -> None:
        if not _podcast_visible(db, requester_user_id, resolved.subject_id):
            raise NotFoundError(message="Podcast not found")

    authorize_generate = authorize_read

    def derive_audience(self, resolved: ResolvedSubject, requester_user_id: UUID) -> AudienceScope:
        return AudienceUser(user_id=requester_user_id)

    def citation_owner(
        self, db: Session, resolved: ResolvedSubject, audience: AudienceScope
    ) -> UUID:
        return audience_user(audience)


def _podcast_visible(db: Session, viewer_id: UUID, podcast_id: UUID) -> bool:
    return (
        db.execute(
            text(
                f"""
                SELECT 1 FROM ({visible_podcast_ids_cte_sql()}) visible
                WHERE visible.podcast_id = :podcast_id LIMIT 1
                """
            ),
            {"viewer_id": viewer_id, "podcast_id": podcast_id},
        ).first()
        is not None
    )


BINDING = PodcastBinding()
POLICY = PodcastSubjectPolicy()
