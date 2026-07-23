"""Per-subject identity / authorization / audience policy (A3/A20).

The generic dossier engine carries ZERO subject-scheme branches: every
scheme-specific decision — how a route locator resolves to a private subject id,
whether the requester may read/generate (404-masked), which closed
:class:`AudienceScope` the head is keyed by, who owns the billing identity and
the citation graph edges, and how a canonical resource activates — lives behind
one :class:`SubjectPolicy` per eligible subject scheme.

The closed registry is installed by :mod:`nexus.services.artifacts.bindings`,
the composition owner imported by the generic engine. A scheme absent from
:data:`SUBJECT_POLICIES` is not an eligible dossier subject.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Protocol, cast
from uuid import UUID

from sqlalchemy.orm import Session

from nexus.auth.permissions import is_library_member
from nexus.errors import NotFoundError
from nexus.services.artifacts.dossier_types import (
    AudienceScope,
    DossierSubjectLocator,
    InvalidSubjectLocator,
    SubjectResource,
)
from nexus.services.resource_graph.refs import ResourceRef, ResourceScheme


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

    def decode_locator(self, subject_handle: str) -> DossierSubjectLocator:
        """Decode this policy's route handle without resolving private identity."""
        ...

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

    def citation_owner(
        self, db: Session, resolved: ResolvedSubject, audience: AudienceScope
    ) -> UUID:
        """The stable citation-edge owner (the user, or the library owner for a
        Library audience) — graph ownership, non-null."""
        ...

    def audience_visible_source_intersection(
        self, db: Session, resolved: ResolvedSubject, audience: AudienceScope
    ) -> Any:
        """The audience-visible slice of the subject's candidate sources."""
        ...

    def activate(self, db: Session, ref: ResourceRef) -> Any:
        """The canonical workspace activation command for the subject resource
        (keeps the resource-activation href non-None so citations stay anchored)."""
        ...


# Installed atomically with the binding registry by ``bindings.__init__``.
SUBJECT_POLICIES: dict[str, SubjectPolicy] = {}


def decode_resource_locator(
    *, subject_scheme: ResourceScheme, subject_handle: str
) -> SubjectResource:
    try:
        subject_id = UUID(subject_handle)
    except ValueError as exc:
        raise InvalidSubjectLocator() from exc
    return SubjectResource(ref=ResourceRef(scheme=subject_scheme, id=subject_id))


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

    policy = SUBJECT_POLICIES.get(subject_scheme)
    if policy is None:
        # The registry composition owner may not have been imported by a direct
        # resource-hydration caller. Importing it here is runtime-only; concrete
        # bindings themselves never call this read projection while installing.
        from nexus.services.artifacts import bindings as _bindings  # noqa: F401

        policy = SUBJECT_POLICIES.get(subject_scheme)
    if policy is None:
        raise AssertionError(f"no policy for persisted subject scheme {subject_scheme!r}")
    resolved = ResolvedSubject(
        scheme=subject_scheme,
        subject_id=subject_id,
        ref=ResourceRef(
            scheme=cast("ResourceScheme", subject_scheme),
            id=subject_id,
        ),
    )
    try:
        policy.authorize_read(db, resolved, viewer_id)
    except NotFoundError:
        return None
    return resolved
