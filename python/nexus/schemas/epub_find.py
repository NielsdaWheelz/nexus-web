"""Strict request and response contracts for EPUB Find."""

from __future__ import annotations

import unicodedata
from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


class _EpubFindModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)


class EpubFindEntireResourceScopeIn(_EpubFindModel):
    kind: Literal["EntireResource"]


class EpubFindSectionScopeIn(_EpubFindModel):
    kind: Literal["Section"]
    section_id: Annotated[str, Field(min_length=1, max_length=255)]


EpubFindScopeIn = Annotated[
    EpubFindEntireResourceScopeIn | EpubFindSectionScopeIn,
    Field(discriminator="kind"),
]


class EpubFindRequest(_EpubFindModel):
    source_witness_fragment_id: UUID
    query: Annotated[str, Field(min_length=1, max_length=256)]
    match_case: bool
    whole_word: bool
    scope: EpubFindScopeIn

    @field_validator("source_witness_fragment_id", mode="before")
    @classmethod
    def parse_source_witness_fragment_id(cls, value: object) -> object:
        if not isinstance(value, str):
            return value
        try:
            return UUID(value)
        except ValueError:
            return value

    @field_validator("query", mode="before")
    @classmethod
    def normalize_query(cls, value: object) -> object:
        if not isinstance(value, str):
            return value
        normalized = unicodedata.normalize("NFC", value)
        if "\r" in normalized or "\n" in normalized:
            raise ValueError("query must not contain line breaks")
        return normalized


class EpubFindSnippetSegmentOut(_EpubFindModel):
    text: Annotated[str, Field(min_length=1, max_length=256)]
    emphasized: bool


class EpubFindOccurrenceOut(_EpubFindModel):
    section_id: Annotated[str, Field(min_length=1, max_length=255)]
    section_label: Annotated[str, Field(min_length=1, max_length=512)]
    fragment_id: UUID
    fragment_idx: Annotated[int, Field(ge=0)]
    start_offset: Annotated[int, Field(ge=0)]
    end_offset: Annotated[int, Field(gt=0)]
    snippet: Annotated[list[EpubFindSnippetSegmentOut], Field(min_length=1, max_length=3)]

    @model_validator(mode="after")
    def validate_range(self) -> EpubFindOccurrenceOut:
        if self.end_offset <= self.start_offset:
            raise ValueError("end_offset must be greater than start_offset")
        return self


class EpubFindReadyOut(_EpubFindModel):
    kind: Literal["Ready"] = "Ready"
    source_witness_fragment_id: UUID
    occurrences: Annotated[list[EpubFindOccurrenceOut], Field(min_length=1, max_length=2000)]


class EpubFindNoMatchesOut(_EpubFindModel):
    kind: Literal["NoMatches"] = "NoMatches"
    source_witness_fragment_id: UUID


class EpubFindTooManyMatchesOut(_EpubFindModel):
    kind: Literal["TooManyMatches"] = "TooManyMatches"
    source_witness_fragment_id: UUID
    threshold: Literal[2000] = 2000


EpubFindResultOut = Annotated[
    EpubFindReadyOut | EpubFindNoMatchesOut | EpubFindTooManyMatchesOut,
    Field(discriminator="kind"),
]
