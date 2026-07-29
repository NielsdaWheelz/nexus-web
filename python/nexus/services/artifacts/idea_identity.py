"""Canonical identity for user-owned Dossier Ideas."""

from __future__ import annotations

import unicodedata
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Literal, NewType, cast

import regex

from nexus.schemas.presence import Presence, Present, absent, present

CanonicalIdeaText = NewType("CanonicalIdeaText", str)

_DEFAULT_IGNORABLE = regex.compile(r"\p{Default_Ignorable_Code_Point}+")
_GRAPHEME = regex.compile(r"\X")
_MAX_GRAPHEMES = 160


class InvalidIdeaText(ValueError):
    """Untrusted Idea text is empty, non-text, or exceeds the exact bound."""


@dataclass(frozen=True, slots=True)
class IdeaKey:
    version: Literal["v1"]
    title_key: CanonicalIdeaText
    disambiguator_key: Presence[CanonicalIdeaText]


def canonicalize_idea_text(value: str) -> CanonicalIdeaText:
    if not isinstance(value, str):
        raise InvalidIdeaText("Idea text must be a string")
    normalized = _DEFAULT_IGNORABLE.sub("", value)
    normalized = unicodedata.normalize("NFKC", normalized)
    normalized = normalized.casefold()
    normalized = unicodedata.normalize("NFKC", normalized)
    normalized = " ".join(normalized.split())
    _validate_bounded_text(normalized)
    return CanonicalIdeaText(normalized)


def normalize_idea_display(value: str) -> str:
    if not isinstance(value, str):
        raise InvalidIdeaText("Idea display text must be a string")
    normalized = _DEFAULT_IGNORABLE.sub("", value)
    normalized = unicodedata.normalize("NFKC", normalized)
    normalized = " ".join(normalized.split())
    _validate_bounded_text(normalized)
    return normalized


def idea_key_from_selection(
    selection: str,
    *,
    disambiguator: Presence[str],
) -> IdeaKey:
    disambiguator_key: Presence[CanonicalIdeaText] = absent()
    if isinstance(disambiguator, Present):
        disambiguator_key = present(canonicalize_idea_text(disambiguator.value))
    return IdeaKey(
        version="v1",
        title_key=canonicalize_idea_text(selection),
        disambiguator_key=disambiguator_key,
    )


def encode_idea_key(key: IdeaKey) -> dict[str, str]:
    encoded = {
        "version": "v1",
        "title_key": str(key.title_key),
    }
    if isinstance(key.disambiguator_key, Present):
        encoded["disambiguator_key"] = str(key.disambiguator_key.value)
    return encoded


def decode_idea_key(raw: Mapping[str, object]) -> IdeaKey:
    try:
        return accept_idea_key(raw)
    except InvalidIdeaText as exc:
        # justify-defect: persisted Idea keys are written only by encode_idea_key.
        raise AssertionError("persisted Idea key is invalid") from exc


def accept_idea_key(raw: Mapping[str, object]) -> IdeaKey:
    keys = set(raw)
    if keys not in (
        {"version", "title_key"},
        {"version", "title_key", "disambiguator_key"},
    ):
        raise InvalidIdeaText("Idea key has unexpected or missing fields")
    if raw["version"] != "v1" or not isinstance(raw["title_key"], str):
        raise InvalidIdeaText("Idea key has an invalid version or title")
    title_key = _accept_canonical_idea_text(raw["title_key"])
    disambiguator_key: Presence[CanonicalIdeaText] = absent()
    if "disambiguator_key" in raw:
        raw_disambiguator = raw["disambiguator_key"]
        if not isinstance(raw_disambiguator, str):
            raise InvalidIdeaText("Idea key disambiguator must be canonical text")
        disambiguator_key = present(_accept_canonical_idea_text(raw_disambiguator))
    return IdeaKey(
        version="v1",
        title_key=title_key,
        disambiguator_key=disambiguator_key,
    )


def _accept_canonical_idea_text(value: str) -> CanonicalIdeaText:
    canonical = canonicalize_idea_text(value)
    if str(canonical) != value:
        raise InvalidIdeaText("Idea key text is not canonical")
    return cast("CanonicalIdeaText", value)


def _validate_bounded_text(value: str) -> None:
    if not value:
        raise InvalidIdeaText("Idea text cannot be empty")
    if len(_GRAPHEME.findall(value)) > _MAX_GRAPHEMES:
        raise InvalidIdeaText(f"Idea text cannot exceed {_MAX_GRAPHEMES} grapheme clusters")
