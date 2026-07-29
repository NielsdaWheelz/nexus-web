"""Persistence and explicit lifecycle for Idea subjects, resolutions, and seeds."""

from __future__ import annotations

from dataclasses import dataclass
from uuid import UUID

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from nexus.db.models import (
    ArtifactIdeaResolution,
    ArtifactIdeaSeed,
    ArtifactIdeaSubject,
    ArtifactLearnFailure,
    ArtifactLearnRequest,
    ArtifactLearnSuccess,
    SynthesisArtifact,
)
from nexus.services.artifacts.idea_identity import (
    CanonicalIdeaText,
    IdeaKey,
    canonicalize_idea_text,
    decode_idea_key,
    encode_idea_key,
    normalize_idea_display,
)


@dataclass(frozen=True, slots=True)
class IdeaSubject:
    id: UUID
    user_id: UUID
    idea_key: IdeaKey
    display_title: str


def find_idea_candidates(
    db: Session,
    *,
    user_id: UUID,
    title_key: CanonicalIdeaText,
) -> list[IdeaSubject]:
    rows = db.scalars(
        select(ArtifactIdeaSubject)
        .where(
            ArtifactIdeaSubject.user_id == user_id,
            ArtifactIdeaSubject.idea_key["title_key"].astext == str(title_key),
        )
        .order_by(ArtifactIdeaSubject.created_at, ArtifactIdeaSubject.id)
    ).all()
    return [_subject_from_row(row) for row in rows]


def get_idea_subject(
    db: Session,
    *,
    user_id: UUID,
    idea_subject_id: UUID,
) -> IdeaSubject | None:
    row = db.scalar(
        select(ArtifactIdeaSubject).where(
            ArtifactIdeaSubject.id == idea_subject_id,
            ArtifactIdeaSubject.user_id == user_id,
        )
    )
    return _subject_from_row(row) if row is not None else None


def find_or_create_idea_subject(
    db: Session,
    *,
    user_id: UUID,
    idea_key: IdeaKey,
    display_title: str,
) -> IdeaSubject:
    normalized_title = normalize_idea_display(display_title)
    if canonicalize_idea_text(normalized_title) != idea_key.title_key:
        # justify-service-invariant-check: equality spans two validated values whose
        # correlation cannot be represented by either value's type alone.
        raise AssertionError("Idea display title does not match its title key")
    encoded = encode_idea_key(idea_key)
    existing = db.scalar(
        select(ArtifactIdeaSubject).where(
            ArtifactIdeaSubject.user_id == user_id,
            ArtifactIdeaSubject.idea_key == encoded,
        )
    )
    if existing is not None:
        return _subject_from_row(existing)
    row = ArtifactIdeaSubject(
        user_id=user_id,
        idea_key=encoded,
        display_title=normalized_title,
    )
    db.add(row)
    db.flush()
    return _subject_from_row(row)


def resolved_idea_for_highlight(
    db: Session,
    *,
    user_id: UUID,
    highlight_id: UUID,
) -> IdeaSubject | None:
    row = db.scalar(
        select(ArtifactIdeaSubject)
        .join(
            ArtifactIdeaResolution,
            ArtifactIdeaResolution.idea_subject_id == ArtifactIdeaSubject.id,
        )
        .where(
            ArtifactIdeaResolution.highlight_id == highlight_id,
            ArtifactIdeaResolution.user_id == user_id,
            ArtifactIdeaSubject.user_id == user_id,
        )
    )
    return _subject_from_row(row) if row is not None else None


def record_idea_resolution(
    db: Session,
    *,
    user_id: UUID,
    highlight_id: UUID,
    idea_subject_id: UUID,
) -> None:
    existing = db.get(ArtifactIdeaResolution, highlight_id)
    if existing is not None:
        if existing.user_id != user_id or existing.idea_subject_id != idea_subject_id:
            # justify-service-invariant-check: a Highlight resolution is immutable and
            # correlated across three durable entity identities.
            raise AssertionError("Highlight already resolves to a different Idea")
        return
    if get_idea_subject(db, user_id=user_id, idea_subject_id=idea_subject_id) is None:
        # justify-service-invariant-check: a foreign key proves reachability, not owner
        # agreement between the Highlight resolution and Idea subject.
        raise AssertionError("Idea subject does not belong to the resolving user")
    db.add(
        ArtifactIdeaResolution(
            highlight_id=highlight_id,
            user_id=user_id,
            idea_subject_id=idea_subject_id,
        )
    )
    db.flush()


def register_idea_seed(
    db: Session,
    *,
    user_id: UUID,
    artifact_id: UUID,
    highlight_id: UUID,
    idea_subject_id: UUID,
) -> bool:
    artifact = db.scalar(
        select(SynthesisArtifact).where(
            SynthesisArtifact.id == artifact_id,
            SynthesisArtifact.subject_scheme == "idea",
            SynthesisArtifact.subject_id == idea_subject_id,
            SynthesisArtifact.audience_scheme == "user",
            SynthesisArtifact.audience_id == str(user_id),
        )
    )
    resolution = db.get(ArtifactIdeaResolution, highlight_id)
    if (
        artifact is None
        or resolution is None
        or resolution.user_id != user_id
        or resolution.idea_subject_id != idea_subject_id
    ):
        # justify-service-invariant-check: the seed's Artifact/Highlight/Idea owner
        # correlation spans three tables and cannot be encoded by foreign keys.
        raise AssertionError("Idea seed does not match its Artifact and Highlight resolution")
    existing = db.scalar(
        select(ArtifactIdeaSeed.id).where(
            ArtifactIdeaSeed.artifact_id == artifact_id,
            ArtifactIdeaSeed.highlight_id == highlight_id,
        )
    )
    if existing is not None:
        return False
    db.add(ArtifactIdeaSeed(artifact_id=artifact_id, highlight_id=highlight_id))
    db.flush()
    return True


def list_idea_seed_highlight_ids(db: Session, *, artifact_id: UUID) -> list[UUID]:
    return list(
        db.scalars(
            select(ArtifactIdeaSeed.highlight_id)
            .where(ArtifactIdeaSeed.artifact_id == artifact_id)
            .order_by(ArtifactIdeaSeed.added_at, ArtifactIdeaSeed.id)
        )
    )


def delete_highlight_idea_rows(db: Session, *, highlight_id: UUID) -> None:
    request_ids = select(ArtifactLearnRequest.id).where(
        ArtifactLearnRequest.highlight_id == highlight_id
    )
    db.execute(delete(ArtifactLearnSuccess).where(ArtifactLearnSuccess.request_id.in_(request_ids)))
    db.execute(delete(ArtifactLearnFailure).where(ArtifactLearnFailure.request_id.in_(request_ids)))
    db.execute(
        delete(ArtifactLearnRequest).where(ArtifactLearnRequest.highlight_id == highlight_id)
    )
    db.execute(delete(ArtifactIdeaSeed).where(ArtifactIdeaSeed.highlight_id == highlight_id))
    db.execute(
        delete(ArtifactIdeaResolution).where(ArtifactIdeaResolution.highlight_id == highlight_id)
    )


def delete_artifact_idea_rows_before_head(
    db: Session,
    *,
    artifact_id: UUID,
) -> UUID | None:
    idea_subject_id = db.scalar(
        select(SynthesisArtifact.subject_id).where(
            SynthesisArtifact.id == artifact_id,
            SynthesisArtifact.subject_scheme == "idea",
        )
    )
    request_ids = set(
        db.scalars(
            select(ArtifactLearnSuccess.request_id).where(
                ArtifactLearnSuccess.artifact_id == artifact_id
            )
        )
    )
    if idea_subject_id is not None:
        request_ids.update(
            db.scalars(
                select(ArtifactLearnRequest.id).where(
                    ArtifactLearnRequest.highlight_id.in_(
                        select(ArtifactIdeaResolution.highlight_id).where(
                            ArtifactIdeaResolution.idea_subject_id == idea_subject_id
                        )
                    )
                )
            )
        )
    if request_ids:
        db.execute(
            delete(ArtifactLearnFailure).where(ArtifactLearnFailure.request_id.in_(request_ids))
        )
        db.execute(
            delete(ArtifactLearnSuccess).where(ArtifactLearnSuccess.request_id.in_(request_ids))
        )
        db.execute(delete(ArtifactLearnRequest).where(ArtifactLearnRequest.id.in_(request_ids)))
    db.execute(delete(ArtifactIdeaSeed).where(ArtifactIdeaSeed.artifact_id == artifact_id))
    return idea_subject_id


def delete_idea_subject_after_head(
    db: Session,
    *,
    idea_subject_id: UUID,
) -> None:
    surviving_head = db.scalar(
        select(SynthesisArtifact.id)
        .where(
            SynthesisArtifact.subject_scheme == "idea",
            SynthesisArtifact.subject_id == idea_subject_id,
        )
        .limit(1)
    )
    if surviving_head is not None:
        # justify-service-invariant-check: callers must delete the owning Artifact
        # before its internal Idea subject.
        raise AssertionError("Idea subject still has an Artifact head")
    db.execute(
        delete(ArtifactIdeaResolution).where(
            ArtifactIdeaResolution.idea_subject_id == idea_subject_id
        )
    )
    deleted = db.execute(
        delete(ArtifactIdeaSubject)
        .where(ArtifactIdeaSubject.id == idea_subject_id)
        .returning(ArtifactIdeaSubject.id)
    ).scalar_one_or_none()
    if deleted is None:
        # justify-defect: the head's stored Idea subject was visible before teardown.
        raise AssertionError("Idea subject disappeared during Artifact teardown")


def delete_user_learn_rows_before_heads(db: Session, *, user_id: UUID) -> None:
    request_ids = select(ArtifactLearnRequest.id).where(ArtifactLearnRequest.user_id == user_id)
    db.execute(delete(ArtifactLearnSuccess).where(ArtifactLearnSuccess.request_id.in_(request_ids)))
    db.execute(delete(ArtifactLearnFailure).where(ArtifactLearnFailure.request_id.in_(request_ids)))
    db.execute(delete(ArtifactLearnRequest).where(ArtifactLearnRequest.user_id == user_id))


def delete_user_idea_rows_after_heads(db: Session, *, user_id: UUID) -> None:
    db.execute(
        delete(ArtifactIdeaSeed).where(
            ArtifactIdeaSeed.highlight_id.in_(
                select(ArtifactIdeaResolution.highlight_id).where(
                    ArtifactIdeaResolution.user_id == user_id
                )
            )
        )
    )
    db.execute(delete(ArtifactIdeaResolution).where(ArtifactIdeaResolution.user_id == user_id))
    remaining_head = db.scalar(
        select(SynthesisArtifact.id)
        .join(
            ArtifactIdeaSubject,
            ArtifactIdeaSubject.id == SynthesisArtifact.subject_id,
        )
        .where(
            SynthesisArtifact.subject_scheme == "idea",
            ArtifactIdeaSubject.user_id == user_id,
        )
        .limit(1)
    )
    if remaining_head is not None:
        # justify-service-invariant-check: user teardown must remove private Idea
        # Artifact heads before their owner subjects.
        raise AssertionError("user still has an Idea Artifact head")
    db.execute(delete(ArtifactIdeaSubject).where(ArtifactIdeaSubject.user_id == user_id))


def _subject_from_row(row: ArtifactIdeaSubject) -> IdeaSubject:
    return IdeaSubject(
        id=row.id,
        user_id=row.user_id,
        idea_key=decode_idea_key(row.idea_key),
        display_title=row.display_title,
    )
