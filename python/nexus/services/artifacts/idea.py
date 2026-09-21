"""User-owned Idea subjects: canonical identity, persistence, and teardown.

An Idea is minted from the exact text a reader highlighted. Its identity is the
canonicalization of that text, so learning the same phrase twice reaches the
same Idea and the same dossier head.
"""

from __future__ import annotations

import unicodedata
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Literal, NewType, cast
from uuid import UUID

import regex
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from nexus.db.models import (
    ArtifactIdeaResolution,
    ArtifactIdeaSeed,
    ArtifactIdeaSubject,
    ArtifactLearnFailure,
    ArtifactLearnRequest,
    ArtifactLearnSuccess,
    Highlight,
    SynthesisArtifact,
)
from nexus.errors import ApiErrorCode, NotFoundError
from nexus.schemas.presence import Presence, Present, absent, present

CanonicalIdeaText = NewType("CanonicalIdeaText", str)

_DEFAULT_IGNORABLE = regex.compile(r"\p{Default_Ignorable_Code_Point}+")
_GRAPHEME = regex.compile(r"\X")
_MAX_GRAPHEMES = 160


class InvalidIdeaText(ValueError):
    """Selected Idea text is empty or exceeds the exact grapheme bound."""


@dataclass(frozen=True, slots=True)
class IdeaKey:
    version: Literal["v1"]
    title_key: CanonicalIdeaText
    disambiguator_key: Presence[CanonicalIdeaText]


@dataclass(frozen=True, slots=True)
class IdeaSubject:
    id: UUID
    user_id: UUID
    idea_key: IdeaKey
    display_title: str


def canonicalize_idea_text(value: str) -> CanonicalIdeaText:
    normalized = _DEFAULT_IGNORABLE.sub("", value)
    normalized = unicodedata.normalize("NFKC", normalized)
    normalized = unicodedata.normalize("NFKC", normalized.casefold())
    normalized = " ".join(normalized.split())
    _validate_bounded_text(normalized)
    return CanonicalIdeaText(normalized)


def normalize_idea_display(value: str) -> str:
    normalized = _DEFAULT_IGNORABLE.sub("", value)
    normalized = unicodedata.normalize("NFKC", normalized)
    normalized = " ".join(normalized.split())
    _validate_bounded_text(normalized)
    return normalized


def idea_key_for_selection(selection: str) -> IdeaKey:
    """The one identity a highlighted phrase resolves to."""
    return IdeaKey(
        version="v1",
        title_key=canonicalize_idea_text(selection),
        disambiguator_key=absent(),
    )


def encode_idea_key(key: IdeaKey) -> dict[str, str]:
    encoded = {"version": "v1", "title_key": str(key.title_key)}
    if isinstance(key.disambiguator_key, Present):
        encoded["disambiguator_key"] = str(key.disambiguator_key.value)
    return encoded


def accept_idea_key(raw: Mapping[str, object]) -> IdeaKey:
    """Decode one persisted key, including the optional disambiguator form."""
    if set(raw) not in (
        {"version", "title_key"},
        {"version", "title_key", "disambiguator_key"},
    ):
        raise InvalidIdeaText("Idea key has unexpected or missing fields")
    if raw["version"] != "v1" or not isinstance(raw["title_key"], str):
        raise InvalidIdeaText("Idea key has an invalid version or title")
    disambiguator: Presence[CanonicalIdeaText] = absent()
    raw_disambiguator = raw.get("disambiguator_key")
    if raw_disambiguator is not None:
        if not isinstance(raw_disambiguator, str):
            raise InvalidIdeaText("Idea key disambiguator must be canonical text")
        disambiguator = present(_accept_canonical(raw_disambiguator))
    return IdeaKey(
        version="v1",
        title_key=_accept_canonical(raw["title_key"]),
        disambiguator_key=disambiguator,
    )


def _accept_canonical(value: str) -> CanonicalIdeaText:
    if str(canonicalize_idea_text(value)) != value:
        raise InvalidIdeaText("Idea key text is not canonical")
    return cast("CanonicalIdeaText", value)


def _validate_bounded_text(value: str) -> None:
    if not value:
        raise InvalidIdeaText("Idea text cannot be empty")
    if len(_GRAPHEME.findall(value)) > _MAX_GRAPHEMES:
        raise InvalidIdeaText(f"Idea text cannot exceed {_MAX_GRAPHEMES} grapheme clusters")


def highlight_selection(db: Session, *, user_id: UUID, highlight_id: UUID) -> str:
    """The owner's exact selected text, 404-masked."""
    exact = db.scalar(
        select(Highlight.exact).where(Highlight.id == highlight_id, Highlight.user_id == user_id)
    )
    if exact is None:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Highlight not found")
    return exact


def get_idea_subject(db: Session, *, user_id: UUID, idea_subject_id: UUID) -> IdeaSubject | None:
    row = db.scalar(
        select(ArtifactIdeaSubject).where(
            ArtifactIdeaSubject.id == idea_subject_id,
            ArtifactIdeaSubject.user_id == user_id,
        )
    )
    return _subject(row) if row is not None else None


def find_or_create_idea_subject(
    db: Session,
    *,
    user_id: UUID,
    idea_key: IdeaKey,
    display_title: str,
) -> IdeaSubject:
    encoded = encode_idea_key(idea_key)
    existing = db.scalar(
        select(ArtifactIdeaSubject).where(
            ArtifactIdeaSubject.user_id == user_id,
            ArtifactIdeaSubject.idea_key == encoded,
        )
    )
    if existing is not None:
        return _subject(existing)
    row = ArtifactIdeaSubject(user_id=user_id, idea_key=encoded, display_title=display_title)
    db.add(row)
    db.flush()
    return _subject(row)


def record_idea_resolution(
    db: Session,
    *,
    user_id: UUID,
    highlight_id: UUID,
    idea_subject_id: UUID,
) -> None:
    """Bind one highlight to its Idea once; the mapping is immutable."""
    if db.get(ArtifactIdeaResolution, highlight_id) is not None:
        return
    db.add(
        ArtifactIdeaResolution(
            highlight_id=highlight_id,
            user_id=user_id,
            idea_subject_id=idea_subject_id,
        )
    )
    db.flush()


def register_idea_seed(db: Session, *, artifact_id: UUID, highlight_id: UUID) -> None:
    existing = db.scalar(
        select(ArtifactIdeaSeed.id).where(
            ArtifactIdeaSeed.artifact_id == artifact_id,
            ArtifactIdeaSeed.highlight_id == highlight_id,
        )
    )
    if existing is not None:
        return
    db.add(ArtifactIdeaSeed(artifact_id=artifact_id, highlight_id=highlight_id))
    db.flush()


def list_idea_seed_highlight_ids(db: Session, *, artifact_id: UUID) -> list[UUID]:
    return list(
        db.scalars(
            select(ArtifactIdeaSeed.highlight_id)
            .where(ArtifactIdeaSeed.artifact_id == artifact_id)
            .order_by(ArtifactIdeaSeed.added_at, ArtifactIdeaSeed.id)
        )
    )


def delete_highlight_idea_rows(db: Session, *, highlight_id: UUID) -> None:
    """Drop every Idea row that keys off a highlight being deleted."""
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


def delete_artifact_idea_rows_before_head(db: Session, *, artifact_id: UUID) -> UUID | None:
    """Drop a head's Idea seeds and leftover Learn rows; return its Idea subject."""
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


def delete_idea_subject_after_head(db: Session, *, idea_subject_id: UUID) -> None:
    """Delete an Idea subject once its last head is gone."""
    surviving = db.scalar(
        select(SynthesisArtifact.id)
        .where(
            SynthesisArtifact.subject_scheme == "idea",
            SynthesisArtifact.subject_id == idea_subject_id,
        )
        .limit(1)
    )
    if surviving is not None:
        raise AssertionError("Idea subject still has an Artifact head")
    db.execute(
        delete(ArtifactIdeaResolution).where(
            ArtifactIdeaResolution.idea_subject_id == idea_subject_id
        )
    )
    db.execute(delete(ArtifactIdeaSubject).where(ArtifactIdeaSubject.id == idea_subject_id))


def _subject(row: ArtifactIdeaSubject) -> IdeaSubject:
    return IdeaSubject(
        id=row.id,
        user_id=row.user_id,
        idea_key=accept_idea_key(row.idea_key),
        display_title=row.display_title,
    )
