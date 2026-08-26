"""Closed Universal Dossier registration and persisted-subject resolution."""

from __future__ import annotations

from dataclasses import dataclass
from functools import cache
from types import MappingProxyType
from typing import TYPE_CHECKING, Mapping, cast
from uuid import UUID

from sqlalchemy.orm import Session

from nexus.auth.permissions import is_library_member
from nexus.errors import NotFoundError
from nexus.services.artifacts.idea_seeds import get_idea_subject
from nexus.services.artifacts.subject_policy import (
    ResolvedIdeaSubject,
    ResolvedResourceSubject,
    ResolvedSubject,
    SubjectPolicy,
)
from nexus.services.resource_graph.refs import ResourceRef, ResourceScheme

if TYPE_CHECKING:
    from nexus.services.artifacts.bindings.base import DossierBinding


@dataclass(frozen=True, slots=True)
class DossierRegistration:
    policy: SubjectPolicy
    binding: DossierBinding


@cache
def _registrations() -> Mapping[str, DossierRegistration]:
    """Compose the immutable closed registry after the import graph is initialized."""
    from nexus.services.artifacts.bindings.contributor import (
        BINDING as contributor_binding,
    )
    from nexus.services.artifacts.bindings.contributor import POLICY as contributor_policy
    from nexus.services.artifacts.bindings.conversation import (
        BINDING as conversation_binding,
    )
    from nexus.services.artifacts.bindings.conversation import POLICY as conversation_policy
    from nexus.services.artifacts.bindings.idea import BINDING as idea_binding
    from nexus.services.artifacts.bindings.idea import POLICY as idea_policy
    from nexus.services.artifacts.bindings.library import BINDING as library_binding
    from nexus.services.artifacts.bindings.library import POLICY as library_policy
    from nexus.services.artifacts.bindings.media import BINDING as media_binding
    from nexus.services.artifacts.bindings.media import POLICY as media_policy
    from nexus.services.artifacts.bindings.note_block import BINDING as note_binding
    from nexus.services.artifacts.bindings.note_block import POLICY as note_policy
    from nexus.services.artifacts.bindings.page import BINDING as page_binding
    from nexus.services.artifacts.bindings.page import POLICY as page_policy
    from nexus.services.artifacts.bindings.podcast import BINDING as podcast_binding
    from nexus.services.artifacts.bindings.podcast import POLICY as podcast_policy

    registrations = MappingProxyType(
        {
            "media": DossierRegistration(media_policy, media_binding),
            "conversation": DossierRegistration(conversation_policy, conversation_binding),
            "library": DossierRegistration(library_policy, library_binding),
            "podcast": DossierRegistration(podcast_policy, podcast_binding),
            "contributor": DossierRegistration(contributor_policy, contributor_binding),
            "page": DossierRegistration(page_policy, page_binding),
            "note_block": DossierRegistration(note_policy, note_binding),
            "idea": DossierRegistration(idea_policy, idea_binding),
        }
    )
    if len(registrations) != 8 or any(
        registration.policy.subject_scheme != scheme
        or registration.binding.subject_scheme != scheme
        for scheme, registration in registrations.items()
    ):
        raise AssertionError("Dossier registrations must contain exactly eight aligned schemes")
    return registrations


def dossier_registration(subject_scheme: str) -> DossierRegistration | None:
    return _registrations().get(subject_scheme)


def visible_persisted_subject(
    db: Session,
    *,
    subject_scheme: str,
    subject_id: UUID,
    audience_scheme: str,
    audience_id: str,
    viewer_id: UUID,
) -> ResolvedSubject | None:
    """Resolve a stored Dossier subject only while head and subject stay visible."""
    if audience_scheme == "user":
        if audience_id != str(viewer_id):
            return None
    elif audience_scheme == "library":
        try:
            library_id = UUID(audience_id)
        except ValueError:
            return None
        if not is_library_member(db, viewer_id, library_id):
            return None
    else:
        return None

    if subject_scheme == "idea":
        if audience_scheme != "user":
            return None
        idea = get_idea_subject(
            db,
            user_id=viewer_id,
            idea_subject_id=subject_id,
        )
        if idea is None:
            return None
        return ResolvedIdeaSubject(
            scheme="idea",
            subject_id=idea.id,
            idea_key=idea.idea_key,
            display_title=idea.display_title,
            user_id=idea.user_id,
        )

    registration = dossier_registration(subject_scheme)
    if registration is None:
        raise AssertionError(f"no Dossier registration for subject scheme {subject_scheme!r}")
    resolved = ResolvedResourceSubject(
        scheme=cast("ResourceScheme", subject_scheme),
        subject_id=subject_id,
        ref=ResourceRef(
            scheme=cast("ResourceScheme", subject_scheme),
            id=subject_id,
        ),
    )
    try:
        registration.policy.authorize_read(db, resolved, viewer_id)
    except NotFoundError:
        return None
    return resolved
