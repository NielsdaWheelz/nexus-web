"""Lifetime authored identity bindings, including aliases and retired creations.

All writes compose in the caller's transaction. Recognize before source/placement
checks; canonical retirement survives physical deletion. No request history lives here.
"""

from dataclasses import dataclass
from typing import cast
from uuid import UUID, uuid4

from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from nexus.db.models import AuthoredIdentity
from nexus.errors import ApiErrorCode, ConflictError
from nexus.schemas.writing import IdentityKind, WritingIdentity


@dataclass(frozen=True)
class Binding:
    row: AuthoredIdentity
    canonical: AuthoredIdentity
    # Whether this register call inserted the identity, never a persisted receipt.
    newly_registered: bool = False

    @property
    def deleted(self) -> bool:
        return self.canonical.retired_at is not None

    def out(self) -> WritingIdentity:
        return WritingIdentity(
            kind=cast(IdentityKind, self.row.kind),
            requested_id=self.row.resource_id,
            canonical_id=self.canonical.resource_id,
            state="deleted" if self.deleted else "live",
        )


def recognize(db: Session, *, viewer_id: UUID, kind: IdentityKind, id: UUID) -> Binding | None:
    row = db.scalar(
        select(AuthoredIdentity).where(
            AuthoredIdentity.kind == kind, AuthoredIdentity.resource_id == id
        )
    )
    if row is None:
        return None
    if row.user_id != viewer_id:
        raise ConflictError(ApiErrorCode.E_RESOURCE_CONFLICT, "Authored id is taken")
    canonical = (
        row
        if row.canonical_identity_id is None
        else db.get(AuthoredIdentity, row.canonical_identity_id)
    )
    if (
        canonical is None
        or canonical.canonical_identity_id is not None
        or (canonical.user_id != viewer_id or canonical.kind != kind)
    ):
        raise RuntimeError("Invalid authored identity alias")
    return Binding(row, canonical)


def register(
    db: Session,
    *,
    viewer_id: UUID,
    kind: IdentityKind,
    id: UUID,
    canonical_id: UUID | None = None,
    source_ref: str | None = None,
) -> Binding:
    known = recognize(db, viewer_id=viewer_id, kind=kind, id=id)
    if known is not None:
        return known
    target = None
    if canonical_id is not None and canonical_id != id:
        canonical = recognize(db, viewer_id=viewer_id, kind=kind, id=canonical_id)
        if canonical is None or canonical.deleted:
            raise RuntimeError("Alias requires a live canonical identity")
        target = canonical.canonical.id
    created = db.scalar(
        insert(AuthoredIdentity)
        .values(
            id=uuid4(),
            user_id=viewer_id,
            kind=kind,
            resource_id=id,
            canonical_identity_id=target,
            source_ref=source_ref,
        )
        .on_conflict_do_nothing(index_elements=["kind", "resource_id"])
        .returning(AuthoredIdentity.id)
    )
    binding = recognize(db, viewer_id=viewer_id, kind=kind, id=id)
    if binding is None:
        raise RuntimeError("Authored identity insert disappeared")
    if binding.canonical.resource_id != (canonical_id or id):
        raise ConflictError(ApiErrorCode.E_RESOURCE_CONFLICT, "Authored id is already bound")
    return Binding(binding.row, binding.canonical, newly_registered=created is not None)


def retire(
    db: Session, *, viewer_id: UUID, kind: IdentityKind, id: UUID, source_ref: str | None = None
) -> Binding:
    binding = register(db, viewer_id=viewer_id, kind=kind, id=id, source_ref=source_ref)
    if not binding.deleted:
        binding.canonical.retired_at = func.now()
        db.flush()
    return binding


def require_live(binding: Binding) -> None:
    if binding.deleted:
        raise ConflictError(
            ApiErrorCode.E_WRITING_DEPENDENCY_GONE,
            "An authored dependency was deleted",
            details={"identities": [binding.out().model_dump(mode="json")]},
        )
