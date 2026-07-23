"""Per-subject identity / authorization / audience policy (CP2-ENGINE, A3/A20).

The generic dossier engine carries ZERO subject-scheme branches: every
scheme-specific decision — how a route locator resolves to a private subject id,
whether the requester may read/generate (404-masked), which closed
:class:`AudienceScope` the head is keyed by, who owns the billing identity and
the citation graph edges, and how a canonical resource activates — lives behind
one :class:`SubjectPolicy` per eligible subject scheme.

The registry is filled in CP3 (exactly seven policies). It is intentionally
empty here so the engine, routes, and stream contain no subject literal; a scheme
absent from :data:`SUBJECT_POLICIES` is not an eligible dossier subject.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Protocol
from uuid import UUID

from sqlalchemy.orm import Session

from nexus.services.artifacts.dossier_types import AudienceScope, DossierSubjectLocator
from nexus.services.resource_graph.refs import ResourceRef


@dataclass(frozen=True, slots=True)
class ResolvedSubject:
    """A locator resolved to its private subject identity (never exposed raw).

    ``scheme``/``subject_id`` are the two head-key columns the engine writes; the
    engine treats the subject opaquely beyond them. ``ref`` is the head's subject
    resource ref (``contributor`` uses the resolved private id). ``detail`` is a
    policy/binding-owned bag (the resolved domain row) so ``collect`` need not
    re-query — opaque to the engine.
    """

    scheme: str
    subject_id: UUID
    ref: ResourceRef
    detail: Any = None


class SubjectPolicy(Protocol):
    """The per-scheme identity/authz/audience/activation owner (A3/A20).

    A concrete policy is registered under its ``subject_scheme``. Every method is
    404-masked where it can leak existence: an unauthorized or missing subject is
    indistinguishable from a not-found one to the caller.
    """

    subject_scheme: str

    def resolve_locator(
        self, db: Session, locator: DossierSubjectLocator, requester_user_id: UUID
    ) -> ResolvedSubject:
        """Resolve the decoded route locator to a private :class:`ResolvedSubject`
        (Contributor resolves its handle server-side); raise the masked not-found
        error when the subject is absent or unreadable."""
        ...

    def authorize_read(
        self, db: Session, resolved: ResolvedSubject, requester_user_id: UUID
    ) -> None:
        """Raise the masked not-found error when the requester may not read the
        subject's dossier head."""
        ...

    def authorize_generate(
        self, db: Session, resolved: ResolvedSubject, requester_user_id: UUID
    ) -> None:
        """Raise the masked not-found error when the requester may not trigger a
        build for the subject."""
        ...

    def derive_audience(self, resolved: ResolvedSubject, requester_user_id: UUID) -> AudienceScope:
        """The server-derived audience the head is keyed by (A2 table); never
        client-supplied."""
        ...

    def collection_viewer(self, resolved: ResolvedSubject, audience: AudienceScope) -> UUID | None:
        """The user identity whose visibility gates input collection (a shared
        library anchors on its owner, not the triggering member)."""
        ...

    def requester_billing(self, resolved: ResolvedSubject, requester_user_id: UUID) -> UUID:
        """The billing/entitlement identity a provider call is attributed to."""
        ...

    def citation_owner(self, resolved: ResolvedSubject, audience: AudienceScope) -> UUID:
        """The stable citation-edge owner (the user, or the library owner for a
        Library audience) — graph ownership, non-null."""
        ...

    def audience_visible_source_intersection(
        self, db: Session, resolved: ResolvedSubject, audience: AudienceScope
    ) -> Any:
        """The audience-visible slice of the subject's candidate sources."""
        ...

    def activate(self, ref: ResourceRef) -> Any:
        """The canonical workspace activation command for the subject resource
        (keeps the resource-activation href non-None so citations stay anchored)."""
        ...


# Filled in CP3 (exactly the seven eligible subject schemes: media, conversation,
# library, podcast, contributor, page, note_block). Empty here — a scheme absent
# from this map is not an eligible dossier subject.
SUBJECT_POLICIES: dict[str, SubjectPolicy] = {}
